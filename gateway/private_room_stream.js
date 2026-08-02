/**
 * PrivateRoomStream —— 适配层（v3 私聊流式经 gateway 转发到常驻 /rooms/chat-<id>/subscribe SSE）
 *
 * 逻辑已抽到 gateway/turn-stream-server.js（TurnStreamServer）。本文件保留生产导出签名
 *   (subscribePrivateRoom / startPrivateTurn / handlePrivateAgentEvent / isPrivateRoom / _testReset)，
 *   内部转调模块单例 + 持有 SSE 订阅者集合（res 管理，模块不碰 res）。
 *
 * 多轮分块判定（isNewRound）原样注入模块，行为与重构前逐行等价。
 */

import { createLogger } from '../shared/logger.js';
import { TurnStreamServer } from './turn-stream-server.js';

const logger = createLogger('private-room-stream', 'gateway.log');

// ── SSE 订阅者集合 + 广播器（res 管理留适配层，模块不碰 res）──
const _sseSubs = new Map(); // roomId → Set<res>

function _broadcast(roomId, chunk) {
  const subs = _sseSubs.get(roomId);
  if (!subs) return;
  for (const res of [...subs]) {
    try { if (res.writable) res.write(chunk); else subs.delete(res); }
    catch (e) { subs.delete(res); }
  }
}

function _sseChunk(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 注入 roomId/roomType 供聚合 dispatcher 路由。_roomId 保留(_onAgentEvent 路由靠它,前端多收无害)。 */
function _injectRoomMeta(data, roomId) {
  if (!data || typeof data !== 'object') return { roomId, roomType: 'chat' };
  return { ...data, roomId, roomType: 'chat' };
}

/** 多轮分块判定（原 isNewRound 逻辑原样注入模块）。 */
function _isNewRound(streamState, eventName) {
  // streamState = { toolCalls }（模块传入）
  const tcs = streamState.toolCalls || [];
  return tcs.length > 0 && !tcs.some(tc => tc.status === 'executing')
    && (eventName === 'token' || eventName === 'tool_call');
}

/** 把 ChatHistory(roomMode) 适配成模块要的 historyStore 接口。 */
function _makeHistoryStore(history) {
  return {
    append: (roomId, role, content, toolCalls, extraFields) =>
      history.addMessage(roomId, role, content, toolCalls, extraFields),
    updateCompact: (roomId, id, patch) => history.updateCompactRecord(roomId, id, patch),
    recent: (roomId, limit) => history.getRecent(roomId, limit),
  };
}

// 模块单例（进程级；多私聊房共用，按 roomId 隔离内部状态）
const _server = new TurnStreamServer({
  historyStore: null, // 在调用时注入（history 由 gateway/index.js 实例化，见 subscribePrivateTurn / handlePrivateAgentEvent）
  shouldStartNewBubble: _isNewRound,
});
_server.setBroadcaster(_broadcast);

/**
 * /rooms/:rid/subscribe：建常驻 SSE，发 snapshot，注册订阅者。
 * @param {string} roomId
 * @param {object} res - express res
 * @param {object} history - ChatHistory(room 模式) 实例
 */
export function subscribePrivateRoom(roomId, res, history) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  if (res.socket) res.socket.setNoDelay(true);
  // 给单例临时装上本次 historyStore（每房可能不同 history 实例，按调用注入）
  _server._historyStore = _makeHistoryStore(history);
  const snap = _server.buildSnapshot(roomId);
  res.write(_sseChunk('snapshot', snap));
  if (!_sseSubs.has(roomId)) _sseSubs.set(roomId, new Set());
  _sseSubs.get(roomId).add(res);
  res.on('close', () => { _sseSubs.get(roomId)?.delete(res); });
}

/** /rooms/:rid/say 写 user 消息时调用：标活跃 user（user 落盘由 /say 路由 history.addMessage('user') 单独写）。 */
export function startPrivateTurn(roomId, userMessageRecord) {
  _server.startTurn(roomId, userMessageRecord);
}

/**
 * agent /events 事件路由入口：转发事件到模块 + 广播给 SSE 订阅者。
 * @param {string} eventName
 * @param {object} data - 含 _roomId
 * @param {object} history - ChatHistory(room 模式)，done 时落 assistant
 */
export function handlePrivateAgentEvent(eventName, data, history) {
  const roomId = data?._roomId;
  if (!roomId || !roomId.startsWith('chat-')) return false; // 非私聊房：交群聊 broadcaster
  const hasSubs = _sseSubs.has(roomId) && _sseSubs.get(roomId).size > 0;
  // 记录 eventLog（模块无此概念；广播转发即等价于"订阅者收到事件"）
  _broadcast(roomId, _sseChunk(eventName, _injectRoomMeta(data, roomId)));
  // 给单例装上本次 historyStore，落盘走它
  if (history) _server._historyStore = _makeHistoryStore(history);
  _server.handleEvent(roomId, eventName, data);
  if (!hasSubs) return true; // 房存在标记但无订阅者：仍吃掉（防误转发群聊）
  return true;
}

/** 供 _onAgentEvent 判定 + 路由用：返回是否为私聊房事件。 */
export function isPrivateRoom(data) {
  return !!data?._roomId?.startsWith?.('chat-');
}

// ===== 聚合订阅用：注册/注销订阅者 + 逐房构造快照(聚合端点统一 writeHead,这里不写头) =====

/** 注册一个聚合订阅者 res 到某私聊房(只加 _sseSubs,不 writeHead 不发 snapshot)。 */
export function registerPrivateSubscriber(roomId, res) {
  if (!_sseSubs.has(roomId)) _sseSubs.set(roomId, new Set());
  _sseSubs.get(roomId).add(res);
}

/** 注销某私聊房的一个订阅者。 */
export function removePrivateSubscriber(roomId, res) {
  _sseSubs.get(roomId)?.delete(res);
}

/** 构造某私聊房的 snapshot 数据(已注入 roomId/roomType:'chat'),供聚合端点逐房发。 */
export function buildPrivateSnapshot(roomId, history) {
  if (history) _server._historyStore = _makeHistoryStore(history);
  const snap = _server.buildSnapshot(roomId);
  return { ...snap, roomId, roomType: 'chat' };
}

/**
 * 强制结束本私聊房回合(abort 兜底):复位 streaming + 空 turn 兜底落盘 + 广播 aborted。
 * 用于 agent 侧不回 aborted(孤儿 streaming:agent 重启 / 回合异常终止未发终结事件)时,
 * gateway 侧强制清状态,避免 streaming 卡 true、前端一直"生成中"且 abort 无效。
 * 已结束(streaming=false)时 no-op,不重复广播。
 */
export function forceFinishPrivateTurn(roomId) {
  const st = _server._rooms.get(roomId);
  if (!st || !st.streaming) return false;
  _server.handleEvent(roomId, 'aborted', {});   // 复位 streaming + flush 空 turn 兜底
  _broadcast(roomId, _sseChunk('aborted', _injectRoomMeta({}, roomId)));  // 通知前端收尾
  return true;
}

export function _testReset() {
  _server._testReset();
  _sseSubs.clear();
}
