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

  // 8. _loop 落盘：tool_call 携带 loop 时，磁盘 assistant 记录带 _loop，刷新后前端可凭之折叠非 render 气泡
  it('_loop 落盘：带 loop 的 tool_call 落盘 assistant 记录带 _loop', () => {
    beginTurn('调查', null);
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, loop: 'main', tool_calls: [{ id: 'tc1', name: 'Read', args: {} }] }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tc1', status: 'success', message: 'ok' }, history);
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);
    const recs = fs.readFileSync(path.join(root, roomId, 'history.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const a = recs.find(r => r.role === 'assistant');
    assert.equal(a._loop, 'main', `tool_call 带 loop=main 应落盘 _loop=main，实际 ${a._loop}`);
  });

  // 9. _loop 不污染：事件不带 loop 时（如普通 tool_result），不写 _loop（向后兼容旧数据）
  it('_loop 缺省：事件不带 loop 时落盘记录无 _loop 字段', () => {
    beginTurn('不带 loop', null);
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, tool_calls: [{ id: 'tc1', name: 'Read', args: {} }] }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tc1', status: 'success', message: 'ok' }, history);
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);
    const recs = fs.readFileSync(path.join(root, roomId, 'history.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const a = recs.find(r => r.role === 'assistant');
    assert.equal(a._loop, undefined, '无 loop 时不写 _loop（旧断言不被破坏）');
  });

  // 10. 多 loop 切换：main bubble 落盘带 main，reviewer bubble 落盘带 reviewer
  //     验证「新轮 flush 用旧 _currentLoop，capture 在 flush 之后」的时序正确
  it('多 loop 切换：main/reviewer 各自 bubble 落盘带对应 _loop', () => {
    beginTurn('多 loop', null);
    // main：调工具
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, loop: 'main', tool_calls: [{ id: 'tc1', name: 'Edit', args: {} }] }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tc1', status: 'success', message: 'ok' }, history);
    // reviewer 首个 token 触发 main bubble flush（此时 _currentLoop 仍为 main）→ 落盘 _loop=main，随后才切 reviewer
    handlePrivateAgentEvent('token', { _roomId: roomId, loop: 'reviewer', content: '审校中' }, history);
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, loop: 'reviewer', tool_calls: [{ id: 'tc2', name: 'Edit', args: {} }] }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tc2', status: 'success', message: 'ok' }, history);
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);
    const recs = fs.readFileSync(path.join(root, roomId, 'history.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const assistants = recs.filter(r => r.role === 'assistant');
    assert.equal(assistants.length, 2, `应落两条 assistant（main + reviewer），实际 ${assistants.length}`);
    assert.equal(assistants[0]._loop, 'main', '第1条（main 工具轮）_loop=main');
    assert.equal(assistants[1]._loop, 'reviewer', '第2条（reviewer 轮）_loop=reviewer');
  });

  // 11. snapshot 重建带 _loop：done 后重连，snap.turns 的 bubble 保留磁盘的 _loop
  it('snapshot 重建带 _loop：turns bubble 保留磁盘 _loop 供前端折叠', () => {
    beginTurn('刷新折叠', null);
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, loop: 'main', tool_calls: [{ id: 'tc1', name: 'Read', args: {} }] }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tc1', status: 'success', message: 'ok' }, history);
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);
    const res = fakeRes({ writable: true });
    subscribePrivateRoom(roomId, res, history);
    const snap = parseSnapshot(res);
    const bubble = snap.turns.flatMap(t => t.assistantBubbles).find(b => b.toolCalls?.length);
    assert.ok(bubble, '应存在 toolCalls bubble');
    assert.equal(bubble._loop, 'main', `snapshot 重建后 bubble._loop 应为 main，实际 ${bubble._loop}`);
  });

  // 12. streaming 中 snapshot 的 activeTurn 尾 bubble 带 _loop（刷新中断也能折叠）
  it('streaming snapshot：activeTurn 尾 bubble 带 _loop', () => {
    beginTurn('流式中刷新', null);
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, loop: 'main', tool_calls: [{ id: 'tc1', name: 'Read', args: {} }] }, history);
    const res = fakeRes({ writable: true });
    subscribePrivateRoom(roomId, res, history);
    const snap = parseSnapshot(res);
    assert.ok(snap.activeTurn, 'streaming 中有 activeTurn');
    const tail = snap.activeTurn.assistantBubbles[snap.activeTurn.assistantBubbles.length - 1];
    assert.ok(tail, '有尾 bubble');
    assert.equal(tail._loop, 'main', `尾 bubble 应带 _loop=main，实际 ${tail._loop}`);
  });

  // 13. status 不提前拧 _currentLoop：loop 边界的 status（下一轮首个 token 前先到）不应把
  //     还悬在内存的上一 bubble 错盖成新 loop。复盘 elf-018：reviewer 末尾 Skip 气泡跨到 render 时
  //     被 status{render} 提前拧成 render。此处模拟 reviewer→render 边界。
  it('status 不提前拧 loop：边界 status 不把上一工具气泡错盖成新 loop', () => {
    beginTurn('边界 status', null);
    // reviewer 末尾：调 Skip（reviewer 的 extraTool）→ success，气泡悬在内存（下一 flush 要等新轮 token）
    handlePrivateAgentEvent('tool_call', { _roomId: roomId, loop: 'reviewer', tool_calls: [{ id: 'tc1', name: 'Skip', args: {} }] }, history);
    handlePrivateAgentEvent('tool_result', { _roomId: roomId, id: 'tc1', status: 'success', message: 'skipped' }, history);
    // render 开始：engine/agent.js _runLLMStream 在首个 token 前先发 status{render}
    handlePrivateAgentEvent('status', { _roomId: roomId, state: 'thinking', loop: 'render' }, history);
    // render 首个 token 触发新轮 flush，落盘上一 Skip 气泡
    handlePrivateAgentEvent('token', { _roomId: roomId, loop: 'render', content: '正文' }, history);
    handlePrivateAgentEvent('done', { _roomId: roomId }, history);
    const recs = fs.readFileSync(path.join(root, roomId, 'history.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const assistants = recs.filter(r => r.role === 'assistant');
    assert.equal(assistants.length, 2, `应落两条 assistant（reviewer Skip + render 正文），实际 ${assistants.length}`);
    assert.equal(assistants[0]._loop, 'reviewer', `reviewer 末尾 Skip 气泡应 _loop=reviewer（不被 status{render} 提前拧），实际 ${assistants[0]._loop}`);
    assert.equal(assistants[1]._loop, 'render', 'render 正文气泡应 _loop=render');
  });
});