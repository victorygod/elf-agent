/**
 * Rewind 快照专项测试
 *
 * 覆盖三项改造：
 * 1. snapshotBeforeSend 首次对话也创建 checkpoint（不再跳过）
 * 2. rewindTo 删除逻辑改为 >（保留目标 checkpoint，可重复回退）
 * 3. rewindTo 对缺失 room-history.jsonl 的 checkpoint 能从 context.json 重建
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  snapshotBeforeSend,
  rewindTo,
  listCheckpoints,
  latestCheckpointId,
  clearCheckpoints,
} from '../gateway/snapshot.js';
import { profilesRoot, _resetProfilesRoot, agentMemory } from '../shared/profiles_paths.js';

// ── 测试隔离 ──

const __profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-snapshot-test-'));
process.env.ELF_PROFILES_ROOT = __profilesRoot;

/** 本轮测试足迹：agentId() 记录用过的 id，afterEach 仅清这些（不再无差别抹掉所有 agents/rooms） */
const _footprint = new Set();

function agentId(name) {
  const id = `test-${name}`;
  _footprint.add(id);   // 记足迹：afterEach 仅清本轮测试影响的 agent 目录（+ 其私聊房 history）
  return id;
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

afterEach(() => {
  // 仅清本轮测试影响的：本 it 用过的 agent 记忆目录 + 对应私聊房 history（只有 room-history
  //   那条会建 rooms/chat-<id>）。不再无差别抹掉全部 agents/rooms——agentId 天然唯一，无需清场。
  for (const id of _footprint) {
    fs.rmSync(path.join(profilesRoot(), 'agents', id), { recursive: true, force: true });
    fs.rmSync(path.join(profilesRoot(), 'rooms', `chat-${id}`), { recursive: true, force: true });
  }
  _footprint.clear();
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

  it('首次调用时应自动创建空 context.json 并成功打快照', () => {
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
    assert.ok(fs.existsSync(path.join(cpDir, 'meta.json')), '应有 meta.json');
    // agent 记忆的 history.jsonl 已废用：checkpoint 不再包含它（聊天内容落 rooms/<id>/history.jsonl）
    assert.ok(!fs.existsSync(path.join(cpDir, 'history.jsonl')), '不应再有 history.jsonl（已废）');

    // context.json 应为空（首次对话，无消息）
    const ctx = readJson(path.join(cpDir, 'context.json'));
    assert.ok(Array.isArray(ctx), 'context.json 应为数组');
    assert.equal(ctx.length, 0, '首次 checkpoint 的 context.json 应为空数组');

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

    // 预先创建 context.json
    fs.writeFileSync(path.join(dataDir, 'context.json'), JSON.stringify([{ id: 'm1', role: 'user', content: 'pre' }]), 'utf-8');

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

describe('rewindTo — 删除逻辑（弹出目标 checkpoint）', () => {

  it('回退后目标 checkpoint 本身应被弹出', () => {
    const aid = agentId('retain-target');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    // 模拟已有若干 checkpoint
    // 先写入 context.json 使后续 snapshotBeforeSend 不会创建空文件
    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');

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
    assert.equal(result.restoredPrompt, '第一条', '应返回正确的 restoredPrompt（删 target 前已读出）');

    // cp1 和 cp2 都应被删除（target 及其之后全弹）
    const list = listCheckpoints(aid);
    const ids = list.map(c => c.id);
    assert.ok(!ids.includes(cp1), 'cp1 应被弹出');
    assert.ok(!ids.includes(cp2), 'cp2 应被删除');

    // cp1 已不在栈中，重复回退会失败（避免卡在原栈顶空转）
    const result2 = rewindTo(aid, cp1);
    assert.equal(result2.ok, false, 'target 已弹出，重复回退应失败');
  });

  it('回退到最新 checkpoint 时仅删除之后的快照', () => {
    const aid = agentId('retain-target-latest');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');

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

    // cp3 连同其本身一并弹出，只剩 cp1/cp2（连按 rewind 才能往更旧走）
    const list = listCheckpoints(aid);
    assert.equal(list.length, 2, '回退到最新 checkpoint 应弹出 cp3');
    assert.equal(list[0].id, cp1);
    assert.equal(list[1].id, cp2);
  });

  it('省略 checkpointId 时回退到最近一个', () => {
    const aid = agentId('latest-default');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');

    snapshotBeforeSend(aid, '第一条');

    fs.writeFileSync(path.join(dataDir, 'context.json'),
      JSON.stringify([{ id: 'm1', role: 'user', content: '第一条' }]), 'utf-8');

    const cp2 = snapshotBeforeSend(aid, '第二条');

    // 不传 checkpointId → 回退到最近一个（cp2）
    const result = rewindTo(aid);
    assert.equal(result.ok, true, 'rewind 应成功');
    assert.equal(result.restoredPrompt, '第二条', '应回退到最近的 checkpoint');

    // >= 语义：最近 checkpoint 连本身弹掉，只剩 cp1
    const list = listCheckpoints(aid);
    assert.equal(list.length, 1, '应只保留 cp1');
    assert.ok(!list.find(c => c.id === cp2), 'cp2 应被弹出');
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

    const cp1 = snapshotBeforeSend(aid, '第一条');

    fs.writeFileSync(path.join(dataDir, 'context.json'),
      JSON.stringify([{ id: 'm1', role: 'user', content: '第一条' }]), 'utf-8');

    const cp2 = snapshotBeforeSend(aid, '第二条');

    // 回退到 cp1：cp1 连同 cp2 全弹，栈空
    rewindTo(aid, cp1);

    const list = listCheckpoints(aid);
    assert.equal(list.length, 0, 'cp1 及 cp2 都应被弹出');

    // 再次回退到 cp1：target 已不在栈，应失败（不再卡栈顶空转）
    const result = rewindTo(aid, cp1);
    assert.equal(result.ok, false, 'cp1 已弹出，重复回退应失败');
  });
});

// ========================================================================

describe('snapshotBeforeSend — 滑窗淘汰', () => {

  it('checkpoint 数超过 MAX_CHECKPOINTS(10) 时应淘汰最旧的', () => {
    const aid = agentId('evict');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);

    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');

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

// ========================================================================

describe('rewind 栈语义（seq 入栈定序 / rewindTo 出栈 / clearCheckpoints 清栈）', () => {

  it('seq 单调递增：连打快照，list 按 seq 升序 0,1,2...', () => {
    const aid = agentId('seq-monotonic');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);
    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');

    const cp1 = snapshotBeforeSend(aid, '一');   // seq 0
    const cp2 = snapshotBeforeSend(aid, '二');   // seq 1
    const cp3 = snapshotBeforeSend(aid, '三');   // seq 2

    const list = listCheckpoints(aid);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map(c => c.seq), [0, 1, 2], 'seq 应为 0,1,2 升序');
    assert.deepEqual(list.map(c => c.id), [cp1, cp2, cp3], '顺序应与创建一致');
  });

  it('同毫秒两个快照也能正确出栈（修旧 flaky：不再靠忙等隔毫秒）', () => {
    const aid = agentId('same-ms');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);
    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');

    const cp1 = snapshotBeforeSend(aid, '第一条');
    fs.writeFileSync(path.join(dataDir, 'context.json'),
      JSON.stringify([{ id: 'm1', role: 'user', content: '第一条' }]), 'utf-8');
    const cp2 = snapshotBeforeSend(aid, '第二条');   // 故意紧挨着打，可能与 cp1 同毫秒

    const list0 = listCheckpoints(aid);
    assert.equal(list0[0].id, cp1);
    assert.equal(list0[1].id, cp2);
    assert.ok(list0[1].seq > list0[0].seq, 'seq 仍严格递增（不依赖墙钟毫秒）');

    rewindTo(aid, cp1);   // 出栈：弹出 cp1 及其之上全部（含 cp2）
    const list = listCheckpoints(aid);
    assert.equal(list.length, 0, '同毫秒下 rewind 也应弹出 cp1+cp2，栈空');
  });

  it('rewind 后续推：栈位置在现存中连续（弹出后新推取下一位置）', () => {
    const aid = agentId('rewind-then-push');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);
    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');

    const cp1 = snapshotBeforeSend(aid, '一');   // seq 0
    snapshotBeforeSend(aid, '二');               // seq 1
    rewindTo(aid, cp1);                          // 弹到 cp1：cp1 及 seq=1 全弹，栈空
    assert.equal(listCheckpoints(aid).length, 0);

    const cp3 = snapshotBeforeSend(aid, '三');   // 续推：栈空，seq 从 0 重新起
    const list = listCheckpoints(aid);
    assert.equal(list.length, 1);
    assert.deepEqual(list.map(c => c.id), [cp3], '栈=[cp3]');
    assert.deepEqual(list.map(c => c.seq), [0], '栈位置从 0 重新连续');
  });

  it('clearCheckpoints 清空整个 rewind 栈，重打 seq 从 0 起', () => {
    const aid = agentId('clear-stack');
    ensureAgentDir(aid);
    const dataDir = dataDirFor(aid);
    fs.writeFileSync(path.join(dataDir, 'context.json'), '[]', 'utf-8');

    snapshotBeforeSend(aid, '一');
    snapshotBeforeSend(aid, '二');
    assert.equal(listCheckpoints(aid).length, 2, '清空前应有 2 个');

    clearCheckpoints(aid);

    assert.equal(listCheckpoints(aid).length, 0, '清栈后应为空');
    assert.equal(latestCheckpointId(aid), null, 'latestCheckpointId 应为 null');
    assert.ok(!fs.existsSync(checkpointsDirFor(aid)), 'checkpoints 目录应被删');

    // 清栈后再打快照，seq 从 0 重新开始（栈已空）
    const cp = snapshotBeforeSend(aid, '三');
    const list = listCheckpoints(aid);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, cp);
    assert.equal(list[0].seq, 0, '清空后重打 seq 从 0 起');
  });
});