/**
 * Rewind 快照专项测试
 *
 * 覆盖三项改造：
 * 1. snapshotBeforeSend 首次对话也创建 checkpoint（不再跳过）
 * 2. rewindTo 删除逻辑改为 >（保留目标 checkpoint，可重复回退）
 * 3. rewindTo 对缺失 room-history.jsonl 的 checkpoint 能从 context.json 重建
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  snapshotBeforeSend,
  rewindTo,
  listCheckpoints,
  latestCheckpointId,
} from '../gateway/snapshot.js';
import { profilesRoot, _resetProfilesRoot, agentMemory } from '../shared/profiles_paths.js';

// ── 测试隔离 ──

const __profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-snapshot-test-'));
process.env.ELF_PROFILES_ROOT = __profilesRoot;

function agentId(name) {
  return `test-${name}`;
}

function dataDirFor(id) {
  return agentMemory(id);
}

/** 确保 agent memory 目录存在（模拟 agent 启动时创建的目录），返回 dataDir */
function ensureAgentDir(id) {
  const dir = dataDirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 获取 checkpoint 目录路径 */
function checkpointsDirFor(id) {
  return path.join(dataDirFor(id), 'checkpoints');
}

before(() => {
  // 确保 profiles 根目录存在
  try { fs.mkdirSync(profilesRoot(), { recursive: true }); } catch (e) { /* ignore */ }
});

after(() => {
  // 清理临时目录
  try { fs.rmSync(__profilesRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  delete process.env.ELF_PROFILES_ROOT;
});

beforeEach(() => {
  // 每个 test 前清空 agents 目录，防止之前运行残留的 checkpoint 干扰
  const agentsDir = path.join(profilesRoot(), 'agents');
  if (fs.existsSync(agentsDir)) {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  }
  // 同时清空 rooms 目录（存放私聊房 history）
  const roomsDir = path.join(profilesRoot(), 'rooms');
  if (fs.existsSync(roomsDir)) {
    fs.rmSync(roomsDir, { recursive: true, force: true });
  }
});

// ── 辅助函数 ──

/** 读取文件内容，文件不存在返回 null */
function readFileOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/** 读取 JSON 文件 */
function readJson(filePath) {
  return JSON.parse(readFileOrNull(filePath));
}

// ========================================================================

describe('snapshotBeforeSend — 首次对话 checkpoint', () => {

  it('首次调用时应自动创建空 context.json 和 history.jsonl 并成功打快照', () => {
    const aid = agentId('first');
    const dataDir = ensureAgentDir(aid);

    const cpId = snapshotBeforeSend(aid, '第一条消息');
    assert.ok(cpId, '首次 snapshotBeforeSend 应返回 checkpointId');

    // checkpoint 目录应已创建
    const checkpointsDir = path.join(dataDir, 'checkpoints');
    assert.ok(fs.existsSync(checkpointsDir), 'checkpoints 目录应存在');

    // checkpoint 内文件应存在
    const cpDir = path.join(checkpointsDir, cpId);
    assert.ok(fs.existsSync(path.join(cpDir, 'context.json')), '应有 context.json');
    assert.ok(fs.existsSync(path.join(cpDir, 'history.jsonl')), '应有 history.jsonl');
    assert.ok(fs.existsSync(path.join(cpDir, 'meta.json')), '应有 meta.json');

    // context.json 和 history.jsonl 应为空（首次对话，无消息）
    const ctx = readJson(path.join(cpDir, 'context.json'));
    assert.ok(Array.isArray(ctx), 'context.json 应为数组');
    assert.equal(ctx.length, 0, '首次 checkpoint 的 context.json 应为空数组');

    const history = readFileOrNull(path.join(cpDir, 'history.jsonl'));
    assert.equal(history, '', '首次 checkpoint 的 history.jsonl 应为空');

    // meta.json 应包含 prompt 信息
    const meta = readJson(path.join(cpDir, 'meta.json'));
    assert.equal(meta.prompt, '第一条消息', 'meta.prompt 应为触发消息');
    assert.equal(meta.restoredPrompt, '第一条消息', 'meta.restoredPrompt 应为触发消息');
  });

  it('首次调用后 agent memory 文件不应被覆盖', () => {
    const aid = agentId('first-nonempty');
    const dataDir = ensureAgentDir(aid);

    // 先创建 checkpoint（模拟首次对话）
    snapshotBeforeSend(aid, '第一条');

    // 此时 context.json 应为空数组
    const ctxPath = path.join(dataDir, 'context.json');
    assert.ok(fs.existsSync(ctxPath), 'context.json 应已创建');
    const ctxBefore = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
    assert.deepEqual(ctxBefore, [], '首次 checkpoint 后 context.json 应为空');

    // 模拟 agent 写入第一条用户消息和助手回复
    const msgs = [
      { id: 'msg_1', role: 'user', content: '你好' },
      { id: 'msg_2', role: 'assistant', content: '你好！' }
    ];
    fs.writeFileSync(ctxPath, JSON.stringify(msgs, null, 2), 'utf-8');

    // 再打一个 checkpoint（第二次用户消息前）
    const cpId2 = snapshotBeforeSend(aid, '第二条');
    assert.ok(cpId2, '第二次 snapshotBeforeSend 应成功');

    // 确认 context.json 未被覆盖
    const ctxAfter = JSON.parse(fs.readFileSync(ctxPath, 'utf-8'));
    assert.equal(ctxAfter.length, 2, 'context.json 应仍有 2 条消息');

    // 第二个 checkpoint 应包含第一条交换
    const cpDir2 = path.join(dataDir, 'checkpoints', cpId2);
    const ctxCp2 = readJson(path.join(cpDir2, 'context.json'));
    assert.equal(ctxCp2.length, 2, '第二个 checkpoint 应包含之前的 2 条消息');
  });

  it('非首次调用不应创建空文件', () => {
    const aid = agentId('non-first');
    const dataDir = ensureAgentDir(aid);

    // 预先创建 context.json 和 history.jsonl
    fs.writeFileSync(path.join(dataDir, 'context.json'), JSON.stringify([{ id: 'm1', role: 'user', content: 'pre' }]), 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'history.jsonl'), JSON.stringify({ id: 'm1', role: 'user', content: 'pre', seq: 1 }) + '\n', 'utf-8');

    const cpId = snapshotBeforeSend(aid, '第一条');
    assert.ok(cpId, '应返回 checkpointId');

    // 确认原文件内容未被篡改
    const ctx = JSON.parse(fs.readFileSync(path.join(dataDir, 'context.json'), 'utf-8'));
    assert.equal(ctx.length, 1, 'context.json 应保持不变');

    // checkpoint 应包含原始内容
    const checkpointsDir = path.join(dataDir, 'checkpoints');
    const cpDir = path.join(checkpointsDir, cpId);
    const ctxCp = readJson(path.join(cpDir, 'context.json'));
    assert.equal(ctxCp.length, 1, 'checkpoint 的 context.json 应含预存消息');
  });
});

// ========================================================================

describe('rewindTo — 删除逻辑（保留目标 checkpoint）', () => {

  it('回退后目标 checkpoint 本身应被保留', () => {
    const aid = agentId('retain-target');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    // 模拟已有若干 checkpoint
    // 先写入 context.json 使后续 snapshotBeforeSend 不会创建空文件
    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'history.jsonl'), '', 'utf-8');

    const cp1 = snapshotBeforeSend(aid, '第一条');

    // 模拟 agent 写入消息
    const msgs1 = [{ id: 'm1', role: 'user', content: '第一条' }];
    fs.writeFileSync(path.join(dataDir, 'context.json'), JSON.stringify(msgs1), 'utf-8');

    const cp2 = snapshotBeforeSend(aid, '第二条');

    const msgs2 = [
      { id: 'm1', role: 'user', content: '第一条' },
      { id: 'm2', role: 'assistant', content: '回复1' },
      { id: 'm3', role: 'user', content: '第二条' }
    ];
    fs.writeFileSync(path.join(dataDir, 'context.json'), JSON.stringify(msgs2), 'utf-8');

    // 回退到 cp1（最早的一个）
    const result = rewindTo(aid, cp1);
    assert.equal(result.ok, true, 'rewind 应成功');
    assert.equal(result.restoredPrompt, '第一条', '应返回正确的 restoredPrompt');

    // cp1 本身不应被删除
    const list = listCheckpoints(aid);
    const ids = list.map(c => c.id);
    assert.ok(ids.includes(cp1), 'cp1 应保留在 checkpoint 列表中');

    // cp2 应被删除（因为在 cp1 之后）
    assert.ok(!ids.includes(cp2), 'cp2 应被删除');

    // 应能再次回退到 cp1
    const result2 = rewindTo(aid, cp1);
    assert.equal(result2.ok, true, '应能重复回退到同一 checkpoint');
  });

  it('回退到最新 checkpoint 时仅删除之后的快照', () => {
    const aid = agentId('retain-target-latest');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'history.jsonl'), '', 'utf-8');

    const cp1 = snapshotBeforeSend(aid, '第一条');

    fs.writeFileSync(path.join(dataDir, 'context.json'),
      JSON.stringify([{ id: 'm1', role: 'user', content: '第一条' }]), 'utf-8');

    const cp2 = snapshotBeforeSend(aid, '第二条');

    fs.writeFileSync(path.join(dataDir, 'context.json'),
      JSON.stringify([
        { id: 'm1', role: 'user', content: '第一条' },
        { id: 'm2', role: 'assistant', content: '回复' },
        { id: 'm3', role: 'user', content: '第二条' }
      ]), 'utf-8');

    const cp3 = snapshotBeforeSend(aid, '第三条');

    // 回退到最新（cp3）
    const result = rewindTo(aid, cp3);
    assert.equal(result.ok, true, 'rewind 应成功');

    // cp3 应被保留，之前的也保留（回退到最新：没有后续快照可删）
    const list = listCheckpoints(aid);
    assert.equal(list.length, 3, '回退到最新 checkpoint 应保留全部（含 cp1/cp2/cp3）');
    assert.equal(list[2].id, cp3, '最新 checkpoint 应在列表末尾');
  });

  it('省略 checkpointId 时回退到最近一个', () => {
    const aid = agentId('latest-default');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'history.jsonl'), '', 'utf-8');

    snapshotBeforeSend(aid, '第一条');

    fs.writeFileSync(path.join(dataDir, 'context.json'),
      JSON.stringify([{ id: 'm1', role: 'user', content: '第一条' }]), 'utf-8');

    const cp2 = snapshotBeforeSend(aid, '第二条');

    // 不传 checkpointId → 回退到最近一个（cp2）
    const result = rewindTo(aid);
    assert.equal(result.ok, true, 'rewind 应成功');
    assert.equal(result.restoredPrompt, '第二条', '应回退到最近的 checkpoint');

    // 使用 > 语义：回退到最新，保留全部（cp1 和 cp2 都在）
    const list = listCheckpoints(aid);
    assert.equal(list.length, 2, '应保留两个 checkpoint');
    assert.ok(list.find(c => c.id === cp2), 'cp2 应保留');
  });
});

// ========================================================================

describe('rewindTo — room-history.jsonl 重建', () => {

  it('checkpoint 无 room-history.jsonl 时应从 context.json 重建', () => {
    const aid = agentId('rebuild-room-history');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    // 创建私聊房 history 目录
    const roomsDir = path.join(profilesRoot(), 'rooms');
    const roomHistoryPath = path.join(roomsDir, `chat-${aid}`, 'history.jsonl');
    fs.mkdirSync(path.dirname(roomHistoryPath), { recursive: true });

    // 写入一个 room history
    fs.writeFileSync(roomHistoryPath,
      JSON.stringify({ id: 'm1', seq: 1, role: 'user', content: '旧消息', ts: new Date().toISOString() }) + '\n',
      'utf-8');

    // 设置 agent context
    fs.writeFileSync(path.join(dataDir, 'context.json'),
      JSON.stringify([{ id: 'm1', role: 'user', content: '旧消息' }]), 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'history.jsonl'),
      JSON.stringify({ id: 'm1', seq: 1, role: 'user', content: '旧消息', ts: new Date().toISOString() }) + '\n',
      'utf-8');

    const cpId = snapshotBeforeSend(aid, '新消息');

    // 模拟：用户又发了一条（room history 加了"新消息"）
    fs.appendFileSync(roomHistoryPath,
      JSON.stringify({ id: 'm2', seq: 2, role: 'user', content: '新消息', ts: new Date().toISOString() }) + '\n',
      'utf-8');

    // 回退到 cpId（checkpoint 里没有 room-history.jsonl，因为 snapshotBeforeSend 之前的逻辑）
    // 验证 deleteRoomHistory=false 路径（本测试直接测 rewindTo 内部逻辑）
    const result = rewindTo(aid, cpId, roomHistoryPath);
    assert.equal(result.ok, true, 'rewind 应成功');

    // room history 应从 context.json 重建
    const rebuilt = readFileOrNull(roomHistoryPath);
    assert.ok(rebuilt !== null, 'room history 文件应存在');
    // 重建的内容不应含"新消息"
    const lines = rebuilt.trim().split('\n').filter(Boolean);
    const records = lines.map(l => JSON.parse(l));
    assert.equal(records.length, 1, '重建后应只有一条消息');
    assert.equal(records[0].content, '旧消息', '应只含旧消息');
  });
});

// ========================================================================

describe('listCheckpoints & latestCheckpointId', () => {

  it('应按时间升序列出所有 checkpoint', () => {
    const aid = agentId('list-order');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'history.jsonl'), '', 'utf-8');

    const cp1 = snapshotBeforeSend(aid, '第一条');
    // 等一小会儿确保时间戳不同
    const now = Date.now();
    while (Date.now() - now < 5) {}

    const cp2 = snapshotBeforeSend(aid, '第二条');

    const list = listCheckpoints(aid);
    assert.equal(list.length, 2, '应有两个 checkpoint');
    // 升序：cp1 在前
    assert.equal(list[0].prompt, '第一条', '第一条应在前面');
    assert.equal(list[1].prompt, '第二条', '第二条应在后面');
  });

  it('latestCheckpointId 应返回最近一个 checkpoint', () => {
    const aid = agentId('latest');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'history.jsonl'), '', 'utf-8');

    snapshotBeforeSend(aid, '第一条');

    const now = Date.now();
    while (Date.now() - now < 5) {}

    const cp2 = snapshotBeforeSend(aid, '第二条');

    const latest = latestCheckpointId(aid);
    assert.equal(latest, cp2, 'latestCheckpointId 应返回最近一个');
  });

  it('无 checkpoint 时应返回空列表', () => {
    const aid = agentId('no-cp');
    // 确保没有 checkpoint
    const list = listCheckpoints(aid);
    assert.deepEqual(list, [], '应返回空列表');
    assert.equal(latestCheckpointId(aid), null, 'latestCheckpointId 应返回 null');
  });

  it('rewind 后 checkpoint 列表应更新', () => {
    const aid = agentId('list-after-rewind');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'history.jsonl'), '', 'utf-8');

    const cp1 = snapshotBeforeSend(aid, '第一条');

    fs.writeFileSync(path.join(dataDir, 'context.json'),
      JSON.stringify([{ id: 'm1', role: 'user', content: '第一条' }]), 'utf-8');

    const cp2 = snapshotBeforeSend(aid, '第二条');

    // 回退到 cp1
    rewindTo(aid, cp1);

    const list = listCheckpoints(aid);
    assert.equal(list.length, 1, '应只保留一个 checkpoint');
    assert.equal(list[0].id, cp1, '应保留 cp1');

    // 再次回退到 cp1（测试保留语义）
    const result = rewindTo(aid, cp1);
    assert.equal(result.ok, true, '重复回退 cp1 应成功');

    const list2 = listCheckpoints(aid);
    assert.equal(list2.length, 1, '重复回退后仍应有一个 checkpoint');
  });
});

// ========================================================================

describe('snapshotBeforeSend — 滑窗淘汰', () => {

  it('checkpoint 数超过 MAX_CHECKPOINTS(10) 时应淘汰最旧的', () => {
    const aid = agentId('evict');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'history.jsonl'), '', 'utf-8');

    const cpIds = [];
    for (let i = 0; i < 12; i++) {
      const now = Date.now();
      while (Date.now() - now < 2) {}
      const cp = snapshotBeforeSend(aid, `消息${i}`);
      cpIds.push(cp);
    }

    const list = listCheckpoints(aid);
    assert.equal(list.length, 10, '应只保留 10 个 checkpoint');

    // cpIds[0] 和 cpIds[1] 应被淘汰
    assert.ok(!list.find(c => c.id === cpIds[0]), '最旧的 cp0 应被淘汰');
    assert.ok(!list.find(c => c.id === cpIds[1]), 'cp1 应被淘汰');

    // cpIds[2..11] 应保留
    for (let i = 2; i < 12; i++) {
      assert.ok(list.find(c => c.id === cpIds[i]), `cp${i} 应保留`);
    }
  });
});