/**
 * elf-018 abort → abortRewind 信号 → gateway _onAgentEvent 复用 rewindTo(latest) 集成测试。
 * 验证 abort 与 ⟲ rewind 一致:删本轮 user(context.json + history.jsonl)+ 整份还原 runtime/tool-results/sync_cursor
 *   + 弹 checkpoint + 转发 restoredPrompt 供前端回填输入框。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ProcessManager } from '../gateway/process_manager.js';
import { ChatHistory } from '../gateway/chat_history.js';
import { subscribePrivateRoom, _testReset } from '../gateway/private_room_stream.js';
import { _resetProfilesRoot } from '../shared/profiles_paths.js';

function fakeRes() {
  const chunks = [];
  const res = {
    writable: true, write(c) { chunks.push(c); return true; }, end() {}, on() {},
    flushHeaders() {}, socket: { setNoDelay() {} }, writeHead() {},
  };
  res._chunks = chunks;
  return res;
}
function mk(p) { fs.mkdirSync(p, { recursive: true }); }
function wf(p, c) { mk(path.dirname(p)); fs.writeFileSync(p, c); }
function readRecs(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('abort → abortRewind → gateway rewindTo(latest) 复用 ⟲ rewind', () => {
  let tmp, profilesRoot, roomsDir, pm, history, aid, rid, memDir, cpDir, roomHistoryPath;

  before(() => {
    _testReset();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-abort-rewind-'));
    profilesRoot = path.join(tmp, 'profiles');
    process.env.ELF_PROFILES_ROOT = profilesRoot;
    _resetProfilesRoot();
    roomsDir = path.join(tmp, 'rooms');

    aid = 'elf-018';
    rid = `chat-u_test-${aid}`;
    memDir = path.join(profilesRoot, 'agents', aid, 'rooms', rid);   // 多用户：私聊房数据目录 = profiles/agents/<id>/rooms/chat-<uid>-<id>/
    roomHistoryPath = path.join(roomsDir, rid, 'history.jsonl');

    // pre-round checkpoint(本轮 user 之前的状态)
    cpDir = path.join(memDir, 'checkpoints', 'cp_pre');
    mk(cpDir);
    wf(path.join(cpDir, 'meta.json'), JSON.stringify({ id: 'cp_pre', createdAt: '2020-01-01T00:00:00.000Z', prompt: '玩家本轮指令', restoredPrompt: '玩家本轮指令', seq: 0 }));
    wf(path.join(cpDir, 'context.json'), '[]');                                  // pre-round: 无本轮 user
    wf(path.join(cpDir, 'runtime/lore/state.md'), 'old');                        // pre-round lore
    wf(path.join(cpDir, 'tool-results/old.json'), 'old-tr');
    wf(path.join(cpDir, 'sync_cursor.json'), JSON.stringify({ cursor: 'pre' }));
    wf(path.join(cpDir, 'room-history.jsonl'), JSON.stringify({ role: 'assistant', content: '上一轮正文', seq: 1 }) + '\n');

    // live 脏写:本轮 user 已入 context + history,outline 写脏了 lore + 留了 tool-results 孤儿
    wf(path.join(memDir, 'context.json'), JSON.stringify([{ role: 'user', content: '玩家本轮指令', id: 'u1' }, { role: 'assistant', content: 'partial', id: 'a1' }]));
    wf(path.join(memDir, 'runtime/lore/state.md'), 'dirty');
    wf(path.join(memDir, 'tool-results/old.json'), 'dirty-old');
    wf(path.join(memDir, 'tool-results/new.json'), 'orphan');
    wf(path.join(memDir, 'sync_cursor.json'), JSON.stringify({ cursor: 'live' }));
    wf(roomHistoryPath, JSON.stringify({ role: 'assistant', content: '上一轮正文', seq: 1 }) + '\n' + JSON.stringify({ role: 'user', content: '玩家本轮指令', seq: 2 }) + '\n');

    history = new ChatHistory(roomsDir, roomsDir, { roomMode: true, roomsDir });
    pm = new ProcessManager();
    pm.privateRoomHistory = history;
  });

  after(() => {
    _testReset();
    delete process.env.ELF_PROFILES_ROOT;
    _resetProfilesRoot();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('abortRewind 触发 rewindTo(latest):删本轮 user + 还原 runtime/tool-results/sync_cursor/history + 弹 checkpoint + 转发 restoredPrompt', () => {
    // 订阅 SSE 捕获广播(鉴 abortRewind 事件携 restoredPrompt)
    const res = fakeRes();
    subscribePrivateRoom(rid, res, history);

    pm._onAgentEvent('abortRewind', { _agentId: aid, _roomId: rid });

    // context.json:本轮 user(+ partial)消失,回到 pre-round([])
    const ctx = JSON.parse(fs.readFileSync(path.join(memDir, 'context.json'), 'utf-8'));
    assert.equal(ctx.length, 0, 'context.json 回到 pre-round,本轮 user 已删');
    assert.ok(!ctx.some((m) => m.content === '玩家本轮指令'), '本轮 user 文本不再留在 context');

    // runtime 整份还原(lore 回 "old",非残留 "dirty")
    assert.equal(fs.readFileSync(path.join(memDir, 'runtime/lore/state.md'), 'utf-8'), 'old', 'runtime/lore 从 checkpoint 还原');
    // tool-results:孤儿清除,只留 checkpoint 的 old.json
    const tr = fs.readdirSync(path.join(memDir, 'tool-results')).sort();
    assert.deepStrictEqual(tr, ['old.json'], '本轮 tool-results 孤儿清除,留 checkpoint 的旧文件');
    // sync_cursor 回 pre
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(memDir, 'sync_cursor.json'), 'utf-8')), { cursor: 'pre' });

    // history.jsonl:本轮 user 消失,回到上一轮
    const recs = readRecs(roomHistoryPath);
    assert.ok(!recs.some((r) => r.role === 'user' && r.content === '玩家本轮指令'), 'history.jsonl 本轮 user 已删');
    assert.ok(recs.some((r) => r.role === 'assistant' && r.content === '上一轮正文'), '上一轮 assistant 保留');

    // checkpoint 被弹(完全复用 ⟲ rewind 的出栈语义)
    assert.ok(!fs.existsSync(cpDir), 'pre-round checkpoint 已弹出(连续 ⟲ 可继续往更旧回退)');

    // 广播的 abortRewind 事件携 restoredPrompt(供前端回填输入框)
    const abortChunk = res._chunks.find((c) => c.startsWith('event: abortRewind'));
    assert.ok(abortChunk, '广播了 abortRewind 事件');
    const payload = JSON.parse(abortChunk.split('data: ')[1]);
    assert.equal(payload.restoredPrompt, '玩家本轮指令', 'restoredPrompt 回填文本 == 本轮 user');
  });

  it('无 checkpoint(快照失败)→ rewindTo 失败,不抛、不回填,磁盘保持 abort 后状态', () => {
    const aid2 = 'elf-018b';
    const rid2 = `chat-u_test-${aid2}`;
    const mem2 = path.join(profilesRoot, 'agents', aid2, 'rooms', rid2);
    wf(path.join(mem2, 'context.json'), JSON.stringify([{ role: 'user', content: 'u', id: 'u' }]));
    wf(path.join(mem2, 'runtime/lore/state.md'), 'dirty');   // 不 seed checkpoint
    const rh2 = path.join(roomsDir, rid2, 'history.jsonl');
    wf(rh2, JSON.stringify({ role: 'user', content: 'u', seq: 1 }) + '\n');

    const res = fakeRes();
    subscribePrivateRoom(rid2, res, history);

    assert.doesNotThrow(() => pm._onAgentEvent('abortRewind', { _agentId: aid2, _roomId: rid2 }));
    // 无 checkpoint → rewindTo no-op,磁盘保持原样(user 仍在)
    const ctx = JSON.parse(fs.readFileSync(path.join(mem2, 'context.json'), 'utf-8'));
    assert.equal(ctx.length, 1, '无 checkpoint → context 不动');
    assert.equal(fs.readFileSync(path.join(mem2, 'runtime/lore/state.md'), 'utf-8'), 'dirty', 'runtime 不动');
    const abortChunk = res._chunks.find((c) => c.startsWith('event: abortRewind'));
    assert.ok(abortChunk, '仍广播 abortRewind(前端只看到停止)');
    const payload = JSON.parse(abortChunk.split('data: ')[1]);
    assert.equal(payload.restoredPrompt, undefined, '无 restoredPrompt(不回填)');
  });
});