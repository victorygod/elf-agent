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

// =====================================================================
// 锚定 #8 修复过的 bug：封装前用现状代码写、跑绿=锚定当前行为；封装后跑绿=一致。
// 每个 case 只调导出函数 + 读磁盘/snapshot 断言，不碰内部私有字段。
// =====================================================================
describe('private_room_stream 行为锚定（#8 修复点）', () => {
  let root, roomId, history;
  beforeEach(() => {
    _testReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-prs-'));
    roomId = 'chat-anchor';
    history = new ChatHistory(root, root, { roomMode: true, roomsDir: root });
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} });

  /** 解析 res 写出的首条 snapshot。 */
  function parseSnapshot(res) {
    return JSON.parse(res._chunks[0].split('data: ')[1]);
  }

  /** 模拟生产 /say 路由：先写 user 落盘 + startPrivateTurn（生产里两者分开，user 由 addMessage 写、stream 由 startPrivateTurn 标）。 */
  function beginTurn(userContent, userId) {
    const rec = history.addMessage(roomId, 'user', userContent);
    startPrivateTurn(roomId, { content: userContent, id: rec.id, ts: rec.ts });
    return rec;
  }

  // 1. 多轮分块落盘：一次 turn 内 tool_call→tool_result→纯文本两轮，磁盘应落两条 assistant 记录
  it('多轮 reasoning：tool_call 轮 + 纯文本轮各落一条独立 assistant 记录', () => {
    beginTurn('读文件总结', null);
    // 第1轮：LLM 调工具
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, tool_calls: [{ id: 'tc1', name: 'Read', args: { file: 'a' } }] }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tc1', status: 'success', message: 'file content' }, history);
    // 第2轮：LLM 纯文本总结（tool 已全完成 → 触发新轮 flush）
    handlePrivateAgentEvent('token', { _roomId: roomId, content: '总结' }, history);
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);
    const recs = fs.readFileSync(path.join(root, roomId, 'history.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const assistants = recs.filter(r => r.role === 'assistant');
    assert.equal(assistants.length, 2, `应落两条 assistant，实际 ${assistants.length} 条：${JSON.stringify(assistants.map(a => ({ content: a.content?.length, tc: a.toolCalls?.length })))}`);
    assert.equal(assistants[0].content, '', '第1轮（工具）content 为空');
    assert.ok(assistants[0].toolCalls?.length === 1, '第1轮含 toolCalls');
    assert.ok(assistants[1].content?.includes('总结'), '第2轮含纯文本');
    assert.ok(!assistants[1].toolCalls?.length, '第2轮无 toolCalls');
  });

  // 2. 空 content 保时序：assistant 只调 tool（content 空）也落一条
  it('空 content 的 assistant 也落盘（保时序，防 historyToTurns 缺位）', () => {
    beginTurn('只调工具', null);
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, tool_calls: [{ id: 'tc1', name: 'Bash', args: {} }] }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tc1', status: 'success', message: 'ok' }, history);
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);
    const recs = fs.readFileSync(path.join(root, roomId, 'history.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const assistants = recs.filter(r => r.role === 'assistant');
    assert.equal(assistants.length, 1, '即使 content 空也落一条 assistant');
    assert.ok(assistants[0].toolCalls?.length === 1, '含 toolCalls');
  });

  // 3. tool 状态 executing→success/error：tool_call 落盘 status=executing，tool_result 后磁盘同条记录更新
  it('tool_call 落盘 status=executing，tool_result 更新为 success/error + message', () => {
    beginTurn('调两个工具', null);
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, tool_calls: [
      { id: 'tcs', name: 'Read', args: {} },
      { id: 'tce', name: 'Bash', args: {} },
    ] }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tcs', status: 'success', message: 'ok' }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tce', status: 'error', message: 'Exit code 1' }, history);
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);
    const recs = fs.readFileSync(path.join(root, roomId, 'history.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const a = recs.find(r => r.role === 'assistant');
    const byId = Object.fromEntries(a.toolCalls.map(tc => [tc.id, tc]));
    assert.equal(byId.tcs.status, 'success', 'tcs 应 success');
    assert.equal(byId.tcs.message, 'ok');
    assert.equal(byId.tce.status, 'error', 'tce 应 error');
    assert.equal(byId.tce.message, 'Exit code 1');
  });

  // 4. snapshot 去重当前 turn user：streaming 中 snapshot 的 turns 不含当前 user，由 activeTurn 独占
  it('streaming 中 snapshot 去重：turns 不含当前 turn user，activeTurn 含', () => {
    const u = beginTurn('正在回复我', null);
    handlePrivateAgentEvent('token', { _roomId: roomId, content: '部分' }, history);
    const res = fakeRes({ writable: true });
    subscribePrivateRoom(roomId, res, history);
    const snap = parseSnapshot(res);
    const userTurns = snap.turns.filter(t => t.userMessage?.id === u.id);
    assert.equal(userTurns.length, 0, 'turns 不应含当前 user 的 turn（被 pop）');
    assert.ok(snap.activeTurn, 'streaming 中必有 activeTurn');
    assert.equal(snap.activeTurn.userMessage?.id, u.id, 'activeTurn 含当前 user');
  });

  // 5. snapshot 补全整轮：多轮中（第1轮已落盘 A1 + 第2轮未落盘尾），activeTurn.bubbles 含 A1(sealed) + 尾
  it('snapshot 补全整轮：activeTurn 含已落盘 A1(sealed) + 未落盘尾 bubble', () => {
    beginTurn('多轮', null);
    // 第1轮：tool 调用→结果（落盘 A1）
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, tool_calls: [{ id: 'tc1', name: 'Read', args: {} }] }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tc1', status: 'success', message: 'c' }, history);
    // 第2轮：纯文本（触发新轮 flush A1，累积未落盘尾）
    handlePrivateAgentEvent('token', { _roomId: roomId, content: '第2轮部分' }, history);
    // 此时 subscribe：A1 已落盘，第2轮是未落盘尾
    const res = fakeRes({ writable: true });
    subscribePrivateRoom(roomId, res, history);
    const snap = parseSnapshot(res);
    const bubbles = snap.activeTurn.assistantBubbles;
    assert.ok(bubbles.length >= 2, `activeTurn 应含 A1 + 尾至少 2 个 bubble，实际 ${bubbles.length}`);
    assert.equal(bubbles[0].sealed, true, '已落盘 A1 标 sealed');
    assert.ok(bubbles[0].toolCalls?.length === 1, 'A1 含第1轮 toolCalls');
    const tail = bubbles[bubbles.length - 1];
    assert.ok(tail.content?.includes('第2轮部分'), '尾 bubble 含未落盘文本');
    assert.notEqual(tail.sealed, true, '尾 bubble 不标 sealed（可续接）');
  });

  // 6. snapshot streaming 必带 activeTurn：startPrivateTurn 后、首 token 前也带（空 bubbles）
  it('snapshot streaming 必带 activeTurn（首 token 前窗口也带，空 bubbles）', () => {
    const u = beginTurn('刚发完', null);
    // 不发任何 token，立即 subscribe（首 token 前窗口）
    const res = fakeRes({ writable: true });
    subscribePrivateRoom(roomId, res, history);
    const snap = parseSnapshot(res);
    assert.equal(snap.streaming, true, 'streaming=true');
    assert.ok(snap.activeTurn, '首 token 前也必有 activeTurn（锁输入框 + 接后续 token）');
    assert.equal(snap.activeTurn.userMessage?.id, u.id);
    assert.equal(snap.activeTurn.assistantBubbles.length, 0, '无内容时 bubbles 为空（token 来时前端新建）');
  });

  // 7. done 后 streaming=false，snapshot activeTurn=null，turns 含完整历史
  it('done 后 snapshot：streaming=false，activeTurn=null，turns 含完整 turn', () => {
    const u = beginTurn('问', null);
    handlePrivateAgentEvent('token', { _roomId: roomId, content: '答' }, history);
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);
    const res = fakeRes({ writable: true });
    subscribePrivateRoom(roomId, res, history);
    const snap = parseSnapshot(res);
    assert.equal(snap.streaming, false, 'done 后 streaming=false');
    assert.equal(snap.activeTurn, null, 'done 后 activeTurn=null');
    assert.ok(snap.turns.length >= 1, 'turns 含历史');
    const uTurn = snap.turns.find(t => t.userMessage?.id === u.id);
    assert.ok(uTurn, 'turns 含该 user 整轮');
    assert.ok(uTurn.assistantBubbles.some(b => b.content?.includes('答')), 'turn 含 assistant 答');
  });
});