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

const RECONNECT_DELAY = 2000;

let _controller = null;
let _retryTimer = null;

function _dispatch(event, data) {
  const roomId = data?.roomId;
  if (!roomId) return;
  if (data.roomType === 'chat' || roomId.startsWith('chat-')) {
    handleSSEEvent(roomId.replace(/^chat-/, ''), event, data);
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
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    _start();
    return () => {
      _stop();
      startedRef.current = false;
    };
  }, []);
}