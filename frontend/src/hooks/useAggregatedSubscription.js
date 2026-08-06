/**
 * useAggregatedSubscription — app 级聚合 SSE(前端全程 1 条)
 *
 * 替代 useAgentSubscriptions(每个 running agent 一条)+ useRoomChat 的 EventSource,解除浏览器
 * HTTP/1.1 单 origin 6 连接上限(7+ 条常驻 SSE 占满池子 → 刷新转圈 / 上翻 Failed to fetch)。
 *
 * 连 POST /subscribe,事件 data 带 {roomId, roomType}(gateway 聚合层注入),按此分发:
 *   - roomType:'chat' / roomId 以 chat- 开头 → sseDispatcher.handleSSEEvent(agentId, event, data)
 *   - roomType:'room'                          → roomStore.roomDispatch(roomId, event, data)
 *
 * 模块级单例:1 条连接,断开 2s 重连,重连后 gateway 逐房补发 snapshot 对齐。
 * 见 docs/sse-aggregation-design.md。
 */
import { useEffect, useRef } from 'react';
import * as api from '../api/index.js';
import { handleSSEEvent } from '../stores/sseDispatcher.js';
import { roomDispatch } from '../stores/roomStore.js';
import { useAuthStore } from '../stores/authStore.js';

const RECONNECT_DELAY = 2000;

let _controller = null;
let _retryTimer = null;

/** 私聊 roomId → agentId：chat-<uid>-<agentId>，uid 不含 '-'，按首个 '-' 分割 */
function _agentIdFromRoomId(roomId) {
  const rest = roomId.replace(/^chat-/, '');
  const idx = rest.indexOf('-');
  return idx > 0 ? rest.slice(idx + 1) : rest;
}

function _dispatch(event, data) {
  const roomId = data?.roomId;
  if (!roomId) return;
  if (data.roomType === 'chat' || roomId.startsWith('chat-')) {
    handleSSEEvent(_agentIdFromRoomId(roomId), event, data);
  } else if (data.roomType === 'room') {
    roomDispatch(roomId, event, data);
  }
}

function _start() {
  _stop();
  _controller = new AbortController();
  const doSubscribe = () => {
    api.log('INFO', '[aggregate] 建立/重连聚合 SSE');
    api.subscribeAggregate({ onEvent: _dispatch, signal: _controller.signal })
      .then(() => {
        // 连接正常关闭(非 abort):安排重连
        if (_controller && !_controller.signal.aborted) {
          api.log('INFO', `[aggregate] 连接关闭,${RECONNECT_DELAY}ms 后重连`);
          _retryTimer = setTimeout(doSubscribe, RECONNECT_DELAY);
        }
      })
      .catch((e) => {
        if (e.name === 'AbortError') return; // 主动断开,不重连
        api.log('WARN', `[aggregate] SSE 失败: ${e.message}, ${RECONNECT_DELAY}ms 后重试`);
        if (_controller && !_controller.signal.aborted) {
          _retryTimer = setTimeout(doSubscribe, RECONNECT_DELAY);
        }
      });
  };
  doSubscribe();
}

function _stop() {
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  if (_controller) { _controller.abort(); _controller = null; }
}

export function useAggregatedSubscription() {
  // 多用户：登录后才建连（未登录 /subscribe 401）；登出/换号时断开，重连由 token 变化触发
  const token = useAuthStore(s => s.token);
  useEffect(() => {
    if (!token) { _stop(); return; }
    _start();
    return () => _stop();
  }, [token]);
}