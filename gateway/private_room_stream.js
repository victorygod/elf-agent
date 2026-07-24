/**
 * PrivateRoomStream —— v3 私聊流式经 gateway 转发到常驻 /rooms/chat-<id>/subscribe SSE。
 *
 * 设计见 docs/agent-v3-design.md §七。agent 进程经 /observe 推理，事件经 agent → /events（带 _roomId）
 *   → gateway _onAgentEvent → 本模块按 roomId 路由到该 room 的 SSE 订阅者。
 *   done 时把累积 assistant 内容落 rooms/<rid>/history.jsonl（与 chat_history room 模式）。
 *
 * 与旧 chat_proxy.StreamContext 的关系：旧者按 agentId 把 /chat 请求内 SSE 直写 res；本模块按 roomId
 *   把 /events 转发的事件广播给常驻订阅 SSE。事件协议（token/tool_call/tool_result/status/compact_start/
 *   compact/compact_error/done/aborted/error）与前端 handleSSEEvent 完全一致，前端零改动。
 */
import { createLogger } from '../shared/logger.js';

const logger = createLogger('private-room-stream', 'gateway.log');

/** user/assistant 消息序列按轮次聚合（user 开起新 turn，后续 assistant 进当前 turn 的气泡）。 */
function messagesToTurns(messages) {
  const turns = [];
  let current = null;
  for (const msg of messages || []) {
    if (msg.role === 'user') {
      current = { id: `turn_${msg.id}`, userMessage: msg, assistantBubbles: [] };
      turns.push(current);
    } else if (msg.role === 'assistant') {
      if (!current) {
        current = { id: `turn_${msg.id}`, userMessage: null, assistantBubbles: [] };
        turns.push(current);
      }
      current.assistantBubbles.push({ ...msg, sealed: true });
    }
  }
  return turns;
}

/** roomId → 房间流状态：{ sseSubs: Set<res>, activeUser, assistantContent, toolCalls, eventLog, streaming } */
const _rooms = new Map();

function _ensure(roomId) {
  if (!_rooms.has(roomId)) {
    _rooms.set(roomId, {
      sseSubs: new Set(),
      activeUser: null,        // {id, content, ts}
      assistantContent: '',
      toolCalls: [],
      eventLog: [],
      streaming: false,
    });
  }
  return _rooms.get(roomId);
}

function _broadcast(roomId, chunk) {
  const st = _rooms.get(roomId);
  if (!st) return;
  for (const res of [...st.sseSubs]) {
    try { if (res.writable) res.write(chunk); else st.sseSubs.delete(res); }
    catch (e) { st.sseSubs.delete(res); }
  }
}

function _sseChunk(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * /rooms/:rid/subscribe：建常驻 SSE，发 snapshot（从 history 建 turns），注册订阅者。
 * @param {string} roomId
 * @param {object} res - express res
 * @param {object} history - ChatHistory(room 模式) 实例
 */
export function subscribePrivateRoom(roomId, res, history) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  if (res.socket) res.socket.setNoDelay(true);
  const st = _ensure(roomId);
  // snapshot：从 history 取最近一页建 turns；有活跃流时把 eventLog 重建为 activeTurn 的 bubbles。
  const recent = history ? history.getRecent(roomId, 30) : { messages: [], hasMore: false };
  const turns = messagesToTurns(recent.messages || []);
  let activeTurn = null;
  if (st.streaming) {
    // 用 eventLog 重建 activeTurn bubbles（简单版：token 累积 / tool_call / compact）。
    const bubbles = _buildBubbles(st.eventLog);
    activeTurn = { id: 'turn_active', userMessage: st.activeUser, assistantBubbles: bubbles };
  }
  res.write(_sseChunk('snapshot', { streaming: st.streaming, turns, activeTurn, hasMore: !!recent.hasMore }));
  st.sseSubs.add(res);
  res.on('close', () => { st.sseSubs.delete(res); });
}

function _buildBubbles(eventLog) {
  const bubbles = [];
  let cur = null;
  for (const { event, data } of eventLog) {
    if (event === 'token') {
      if (!cur || cur.sealed) { cur = { content: '', toolCalls: [], sealed: false }; bubbles.push(cur); }
      if (data?.content) cur.content += data.content;
    } else if (event === 'tool_call') {
      if (!cur || cur.sealed) { cur = { content: '', toolCalls: [], sealed: false }; bubbles.push(cur); }
      for (const tc of (data?.tool_calls || [])) cur.toolCalls.push({ ...tc, status: 'executing' });
    } else if (event === 'tool_result') {
      if (cur) {
        const i = cur.toolCalls.findIndex(t => t.status === 'executing');
        if (i !== -1) { cur.toolCalls[i].status = data?.status; if (data?.message) cur.toolCalls[i].message = data.message; }
        if (!cur.toolCalls.some(t => t.status === 'executing')) cur.sealed = true;
      }
    } else if (event === 'compact_start') {
      if (cur && !cur.sealed) cur.sealed = true;
      cur = { content: '', toolCalls: [], sealed: false, compactLoading: true, id: data?.compactId, compactAttempt: data?.attempt || 1 };
      bubbles.push(cur);
    } else if (event === 'compact') {
      if (cur) { delete cur.compactLoading; cur.compactSummary = data?.tokenEstimate || true; cur.sealed = true; }
    } else if (event === 'compact_error') {
      if (cur) { delete cur.compactLoading; cur.compactError = data?.error || '记忆压缩失败'; cur.sealed = true; }
    }
  }
  return bubbles;
}

/** /rooms/:rid/say 写 user 消息时调用：落 history + 标活跃.user（供 snapshot activeTurn）。 */
export function startPrivateTurn(roomId, userMessageRecord) {
  const st = _ensure(roomId);
  st.activeUser = { id: userMessageRecord?.id || null, content: userMessageRecord?.content || '', ts: userMessageRecord?.ts || new Date().toISOString() };
  st.assistantContent = '';
  st.toolCalls = [];
  st.eventLog = [];
  st.streaming = true;
}

/**
 * agent /events 事件路由入口：按 data._roomId 把事件转发到对应私聊房 SSE。
 * @param {string} eventName
 * @param {object} data - 含 _roomId
 * @param {object} history - ChatHistory(room 模式)，done 时落 assistant
 */
export function handlePrivateAgentEvent(eventName, data, history) {
  const roomId = data?._roomId;
  if (!roomId || !roomId.startsWith('chat-')) return false; // 非私聊房：交群聊 broadcaster
  const st = _rooms.get(roomId);
  if (!st) return true; // 房存在标记但无订阅者：仍吃掉（防误转发群聊）
  // 记录 + 转发
  st.eventLog.push({ event: eventName, data });
  _broadcast(roomId, _sseChunk(eventName, _stripRoomId(data)));
  if (eventName === 'token' && data?.content) st.assistantContent += data.content;
  if (eventName === 'tool_call' && data?.tool_calls) for (const tc of data.tool_calls) st.toolCalls.push(tc);

  // compact 气泡落 history（按 compactId 锚定那条记录就地更新，不新增）：
  //   - compact_start：写一条 {compactId, compactLoading} 空记录；
  //   - compact/compact_error/compact_abort：就地改那条记录的终态字段。
  //   这让 subscribe 断开重连后 idle snapshot 读磁盘能重建压缩气泡（与旧 chat_proxy updateCompactRecord 同语义）。
  if (history) {
    const cid = data?.compactId;
    try {
      if (eventName === 'compact_start' && cid) {
        history.addMessage(roomId, 'assistant', '', undefined, {
          id: cid, compactId: cid, compactLoading: true, compactAttempt: data.attempt || 1,
        });
      } else if (eventName === 'compact' && cid) {
        history.updateCompactRecord(roomId, cid, { compactSummary: data.tokenEstimate || true });
      } else if (eventName === 'compact_error' && cid) {
        history.updateCompactRecord(roomId, cid, { compactError: data.error || '记忆压缩失败', final: data.final });
      } else if (eventName === 'compact_abort' && cid) {
        history.updateCompactRecord(roomId, cid, { compactError: '记忆压缩已终止' });
      }
    } catch (e) { logger.error(`落私聊 compact history 失败 (${roomId}/${eventName}): ${e.message}`); }
  }

  if (eventName === 'done' || eventName === 'aborted' || eventName === 'error') {
    st.streaming = false;
    if (history && st.assistantContent) {
      try { history.addMessage(roomId, 'assistant', st.assistantContent, st.toolCalls.length ? st.toolCalls : undefined); }
      catch (e) { logger.error(`落私聊 assistant history 失败 (${roomId}): ${e.message}`); }
    }
  }
  return true;
}

function _stripRoomId(data) {
  if (!data || typeof data !== 'object') return data;
  const { _roomId, ...rest } = data;
  return rest;
}

/** 供 _onAgentEvent 判定 + 路由用：返回是否为私聊房事件。 */
export function isPrivateRoom(data) {
  return !!data?._roomId?.startsWith?.('chat-');
}

export function _testReset() { _rooms.clear(); }
