/**
 * Bridge — SPA 与 Agent 自定义 UI 之间的通信桥
 *
 * Agent UI 组件只能通过 Bridge 与主 SPA 交互，
 * 不直接访问 React store 或全局变量。
 */

import { useMemo, useCallback, useRef, useEffect } from 'react';
import useAgentStore from '../stores/agentStore';
import * as api from '../api/index.js';

/**
 * 为指定 agent 创建 Bridge 实例
 * @param {string} agentId
 * @returns {object} bridge
 */
export default function useBridge(agentId) {
  const chats = useAgentStore(s => s.chats);
  const loadHistory = useAgentStore(s => s.loadHistory);
  const loadMoreHistory = useAgentStore(s => s.loadMoreHistory);
  const clearHistory = useAgentStore(s => s.clearHistory);
  const showToast = useAgentStore(s => s.showToast);

  // 用 ref 持有 SSE 订阅回调，避免反复重建订阅
  const eventHandlersRef = useRef(new Set());

  const bridge = useMemo(() => {
    const chat = chats.get(agentId);

    return {
      /** 当前 agentId */
      agentId,

      // ===== 聊天数据 =====
      get turns() { return chat?.turns ?? []; },
      get activeTurn() { return chat?.activeTurn ?? null; },
      // streaming 字段从未被置 true；按 ChatPanel 的口径：activeTurn 存在即流式中
      get streaming() { return chat?.activeTurn != null; },
      get currentLoop() { return chat?._currentLoop ?? null; },
      get historyLoaded() { return chat?.historyLoaded ?? false; },

      // ===== 操作 =====
      send: (text) => {
        const store = useAgentStore.getState();
        const s = store.chats.get(agentId);
        if (s?.streaming || s?.activeTurn) return;

        // 创建本地 message + turn（与 useChat send 一致）
        const msg = {
          id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          content: text,
          ts: new Date().toISOString(),
        };
        const newTurn = {
          id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          userMessage: msg,
          assistantBubbles: [],
        };
        store._patchChat(agentId, { activeTurn: newTurn });

        // fire-and-forget POST /say；SSE 由全局 subscribe 接收
        api.chat(agentId, text, {
          onEvent: () => {},
        }).catch(() => {});
      },

      abort: () => {
        useAgentStore.getState().abortMessage(agentId);
      },

      loadHistory: (opts) => loadHistory(agentId, opts),
      loadMore: () => loadMoreHistory(agentId),
      clearHistory: () => clearHistory(agentId),

      // ===== SSE 事件 =====
      onEvent: (handler) => {
        eventHandlersRef.current.add(handler);
        return () => eventHandlersRef.current.delete(handler);
      },

      // ===== 专属 API =====
      call: async (method, path, body) => {
        const url = `/agents/${agentId}${path.startsWith('/') ? '' : '/'}${path}`;
        const opts = {
          method: method.toUpperCase(),
          headers: { 'Content-Type': 'application/json' },
        };
        if (body && method.toUpperCase() !== 'GET') opts.body = JSON.stringify(body);
        const res = await api.authFetch(url, opts);
        if (!res.ok) {
          // 优先用服务端 error 文案，并挂 status 方便按状态码分支处理（如 409 重名）
          let serverMsg = '';
          try { serverMsg = (await res.json()).error || ''; } catch {}
          const err = new Error(serverMsg || `HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return await res.json();
      },

      // ===== 工具 =====
      showToast: (msg) => showToast(msg),
    };
  }, [agentId, chats, loadHistory, loadMoreHistory, clearHistory, showToast]);

  return bridge;
}