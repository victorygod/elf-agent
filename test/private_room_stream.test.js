/**
 * private_room_stream 重连兜底测试（v3）：
 *   compact 气泡经 handlePrivateAgentEvent 落 rooms/<rid>/history.jsonl（按 compactId 就地更新），
 *   订阅者断开重连后 idle snapshot 从磁盘重建 → 压缩气泡不丢。
 *   同理 done 后的 assistant 内容、aborted 终态由 history 兜底。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChatHistory } from '../gateway/chat_history.js';
import {
  subscribePrivateRoom, startPrivateTurn, handlePrivateAgentEvent,
  _testReset,
} from '../gateway/private_room_stream.js';

/**
 * 模拟一条 subscribe SSE 的 res：collect 写入的 chunk。
 * writable 可控（模拟断开）。res.on('close') 注册不调（测试不发 close）。
 */
function fakeRes({ writable = true } = {}) {
  const chunks = [];
  const res = {
    writable,
    _closed: !writable,
    write(c) { if (this.writable) { chunks.push(c); return true; } return false; },
    end() {},
    on() {},
    flushHeaders() {},
    socket: { setNoDelay() {} },
    writeHead() {},
  };
  res._chunks = chunks;
  return res;
}

describe('private_room_stream compact 气泡落盘 + 重连兜底', () => {
  let root, roomId, history;
  beforeEach(() => {
    _testReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-prs-'));
    roomId = 'chat-test';
    history = new ChatHistory(root, root, { roomMode: true, roomsDir: root });
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} });

  it('compact_start → compact 在重连后从磁盘重建（订阅者断开时事件落盘不丢）', () => {
    // 模拟一轮：先 subscribe 建 server 私聊房状态 + 落一条 user
    startPrivateTurn(roomId, { content: '你好', id: 'u1' });
    // 订阅者在场，但本轮我们不读它——直接模拟"订阅者此刻断开"
    const offlineRes = fakeRes({ writable: false });
    subscribePrivateRoom(roomId, offlineRes, history); // 建 sseSubs（pastable），但 offlineRes 写不进
    // 把它从 sseSubs 移除（模拟断开）
    // 触发 compact 事件（订阅者断开 → 实时推送落空，但落盘了）：
    handlePrivateAgentEvent('compact_start', { _roomId: roomId, compactId: 'cp1', attempt: 1 }, history);
    handlePrivateAgentEvent('compact', { _roomId: roomId, compactId: 'cp1', tokenEstimate: 1234 }, history);
    // done 终止本轮
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);

    // 磁盘 history.jsonl 应含一条 compactId=cp1 的记录，已 update 成 compactSummary=1234（无 compactLoading）
    const raw = fs.readFileSync(path.join(root, roomId, 'history.jsonl'), 'utf-8').trim().split('\n');
    const recs = raw.map(l => JSON.parse(l));
    const cp = recs.find(r => r.compactId === 'cp1');
    assert.ok(cp, 'compact 落盘了一条记录');
    assert.equal(cp.compactLoading, undefined, 'compactLoading 应被清掉');
    assert.equal(cp.compactSummary, 1234, 'compactSummary 就地写入');

    // 模拟重连：新订阅者建 subscribe，snapshot（streaming=false 走 idle 分支读磁盘）
    _testReset(); // 清内存 eventLog/streaming
    const newRes = fakeRes({ writable: true });
    subscribePrivateRoom(roomId, newRes, history);
    const snap = JSON.parse(newRes._chunks[0].split('data: ')[1]);
    // idle snapshot turns 应含 compact 气泡（role=assistant 带 compactId/compactSummary）
    const allBubbles = snap.turns.flatMap(t => t.assistantBubbles);
    assert.ok(allBubbles.some(b => b.compactId === 'cp1' && b.compactSummary === 1234),
      `重连 idle snapshot 应从磁盘重建 compact 气泡，实际 bubbles=${JSON.stringify(allBubbles.map(b=>({id:b.id,compactId:b.compactId,sum:b.compactSummary})))}`);
  });

  it('compact_error 终态也落盘,重连可见', () => {
    startPrivateTurn(roomId, { content: 'x', id: 'u1' });
    handlePrivateAgentEvent('compact_start', { _roomId: roomId, compactId: 'cp2', attempt: 1 }, history);
    handlePrivateAgentEvent('compact_error', { _roomId: roomId, compactId: 'cp2', error: '炸了' }, history);
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);
    const raw = fs.readFileSync(path.join(root, roomId, 'history.jsonl'), 'utf-8').trim().split('\n');
    const cp = raw.map(l => JSON.parse(l)).find(r => r.compactId === 'cp2');
    assert.equal(cp.compactLoading, undefined);
    assert.equal(cp.compactError, '炸了');
  });
});