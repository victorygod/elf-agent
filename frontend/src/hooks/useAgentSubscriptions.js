/**
 * useAgentSubscriptions — app 级常驻 SSE 订阅（订阅 1b 终端落地）
 *
 * 为每个 running agent 维护一条到 gateway /rooms/chat-<id>/subscribe 的 SSE 连接，
 * 连接生命周期绑定"agent running 状态"，**不随 agent tab 切换 / ChatPanel 卸载断裂**。
 * 事件经 sseDispatcher.handleSSEEvent 写 agentStore。
 *
 * 设计要点（见 docs/subscribe-app-resident-design.md）：
 * - fetch-SSE 无自动重连：连接正常关闭/异常时 2s 后自动重连（catch → setTimeout）。
 * - buffer/ack 后置：重连窗口内丢失的异步事件，由后续 snapshot 全量对齐兜底（不在本期）。
 * - 同一 agent 的 subscribe 唯一：维护模块级 Map<agentId, AbortController>，status 变化时先断旧再建新。
 *
 * 在 App.jsx 顶层调用一次。
 */

import { useEffect, useRef } from 'react';
import * as api from '../api/index.js';
import useAgentStore from '../stores/agentStore.js';
import { handleSSEEvent } from '../stores/sseDispatcher.js';

// 模块级：agentId → { controller, retryTimer }。跨 hook 重渲染常驻。
const _subs = new Map();
const RECONNECT_DELAY = 2000;

function _startSubscribe(agentId) {
  // 断旧（若有）
  _stopSubscribe(agentId);

  const controller = new AbortController();
  _subs.set(agentId, { controller, retryTimer: null });

  const doSubscribe = () => {
    api.log('INFO', `[subscribe] Agent ${agentId} 建立/重连常驻 SSE`);
    api.subscribe(agentId, {
      onEvent: (event, data) => handleSSEEvent(agentId, event, data),
      signal: controller.signal,
    })
      .then(() => {
        // 连接正常关闭（非 abort）：标记非 streaming，安排重连
        useAgentStore.getState()._patchChat(agentId, { streaming: false });
        const cur = _subs.get(agentId);
        if (cur && cur.controller === controller && !controller.signal.aborted) {
          api.log('INFO', `[subscribe] Agent ${agentId} 连接关闭，${RECONNECT_DELAY}ms 后重连`);
          cur.retryTimer = setTimeout(doSubscribe, RECONNECT_DELAY);
        }
      })
      .catch((e) => {
        if (e.name === 'AbortError') return; // 主动断开，不重连
        api.log('WARN', `[subscribe] Agent ${agentId} SSE 失败: ${e.message}, ${RECONNECT_DELAY}ms 后重试`);
        const cur = _subs.get(agentId);
        if (cur && cur.controller === controller) {
          cur.retryTimer = setTimeout(doSubscribe, RECONNECT_DELAY);
        }
      });
  };

  doSubscribe();
}

function _stopSubscribe(agentId) {
  const cur = _subs.get(agentId);
  if (!cur) return;
  if (cur.retryTimer) { clearTimeout(cur.retryTimer); cur.retryTimer = null; }
  cur.controller.abort();
  _subs.delete(agentId);
}

export function useAgentSubscriptions() {
  const agents = useAgentStore(s => s.agents);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  useEffect(() => {
    const runningIds = new Set(agents.filter(a => a.status === 'running').map(a => a.agentId));

    // 新 running 的建立订阅
    for (const id of runningIds) {
      if (!_subs.has(id)) _startSubscribe(id);
    }
    // 不再 running（停止/消失）的断开
    for (const id of _subs.keys()) {
      if (!runningIds.has(id)) _stopSubscribe(id);
    }
  }, [agents]);

  // 卸载（app 整体退出）时清理所有
  useEffect(() => {
    return () => {
      for (const id of Array.from(_subs.keys())) _stopSubscribe(id);
    };
  }, []);
}