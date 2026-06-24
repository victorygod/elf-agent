import { useRef, useCallback } from 'react';
import * as api from '../api/index.js';
import useAgentStore from '../stores/agentStore.js';

/**
 * useChat — 管理 SSE 流式聊天
 *
 * 核心设计：
 *   - send() 创建 activeTurn → 通过 SSE 发送 → 处理 SSE 事件流
 *   - Agent 回复中不允许再发送新消息（前端禁用输入 + 后端 422）
 *   - 页面刷新后通过 subscribe 获取 snapshot 恢复状态
 *   - snapshot 是唯一状态源：包含 turns + activeTurn，前端直接替换
 *   - subscribe 失败直接重试 subscribe，不降级到 polling
 *
 * rAF batching: token 事件累积后每帧 flush 一次
 */
export default function useChat(agentId) {
  const subscribeControllerRef = useRef(null);

  // rAF batching refs
  const pendingContentRef = useRef('');
  const pendingUpdateRef = useRef(null);
  const rafIdRef = useRef(null);

  const startPollingRef = useRef(null);

  const patchChat = useCallback((updates) => {
    useAgentStore.getState()._patchChat(agentId, updates);
  }, [agentId]);

  const getChat = useCallback(() => {
    return useAgentStore.getState().chats.get(agentId);
  }, [agentId]);

  // ===== rAF flush =====
  const flushRaf = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const update = pendingUpdateRef.current;
    const at = update?.activeTurn;
    if (!at) {
      pendingContentRef.current = '';
      pendingUpdateRef.current = null;
      return;
    }

    // ★ 创建新的 bubbles 数组和新的 bubble 对象，避免传同一引用
    const newBubbles = at.assistantBubbles.map((b, i) => {
      if (i === at.assistantBubbles.length - 1 && pendingContentRef.current) {
        return { ...b, content: b.content + pendingContentRef.current };
      }
      return { ...b };
    });

    patchChat({ activeTurn: { ...at, assistantBubbles: newBubbles } });

    pendingContentRef.current = '';
    pendingUpdateRef.current = null;
  }, [patchChat]);

  // ===== 辅助：将 activeTurn 收入 turns =====
  const finalizeActiveTurn = useCallback(() => {
    flushRaf();
    const chat = getChat();
    if (!chat || !chat.activeTurn) return;
    const at = chat.activeTurn;

    const sealedBubbles = at.assistantBubbles.map(b =>
      b.sealed ? b : { ...b, sealed: true }
    );

    patchChat({
      turns: [...chat.turns, { ...at, assistantBubbles: sealedBubbles }],
      activeTurn: null,
    });
  }, [agentId, getChat, patchChat, flushRaf]);

  // ===== SSE 事件处理 =====
  const _handleSSEEvent = useCallback((event, data) => {
    const chat = getChat();

    switch (event) {
      case 'snapshot': {
        // ★ snapshot 是刷新后的唯一状态源，直接替换 turns + activeTurn
        const { turns, activeTurn } = data;

        // activeTurn 的 assistantBubbles 补上 id
        const bubbles = (activeTurn?.assistantBubbles || []).map((b, i) => ({
          ...b,
          id: b.id || `snap_bubble_${Date.now()}_${i}`,
        }));

        const patchedActiveTurn = activeTurn
          ? { ...activeTurn, assistantBubbles: bubbles }
          : null;

        patchChat({
          turns: turns || [],
          activeTurn: patchedActiveTurn,
          historyLoaded: true,
          hasMore: data.hasMore !== undefined ? data.hasMore : false,
        });
        break;
      }

      case 'token': {
        if (!chat) return;
        let at = chat.activeTurn;
        if (!at) return;

        let lastBubble = at.assistantBubbles[at.assistantBubbles.length - 1];
        let needNewBubble = !lastBubble || lastBubble.sealed;
        if (needNewBubble) {
          lastBubble = {
            id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            content: '',
            toolCalls: [],
            ts: new Date().toISOString(),
            sealed: false,
          };
        }
        const cleanedBubble = lastBubble.typing ? { ...lastBubble, typing: undefined } : lastBubble;

        // rAF batching — 保存 immutable snapshot 供 flushRaf 使用
        const newBubbles = needNewBubble
          ? [...at.assistantBubbles, cleanedBubble]
          : at.assistantBubbles.map((b, i) => i === at.assistantBubbles.length - 1 ? cleanedBubble : b);
        pendingContentRef.current += data.content;
        pendingUpdateRef.current = { activeTurn: { ...at, assistantBubbles: newBubbles } };

        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(flushRaf);
        }
        break;
      }

      case 'tool_call': {
        const chat2 = getChat();
        let at = chat2?.activeTurn;
        if (!at) return;

        let lastBubble = at.assistantBubbles[at.assistantBubbles.length - 1];
        let needNewBubble = !lastBubble || lastBubble.sealed;
        if (needNewBubble) {
          lastBubble = {
            id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            content: '',
            toolCalls: [],
            ts: new Date().toISOString(),
            sealed: false,
          };
        }
        const cleanedBubble = lastBubble.typing ? { ...lastBubble, typing: undefined } : lastBubble;
        const existingToolCalls = cleanedBubble.toolCalls || [];
        const newToolCalls = [...existingToolCalls, ...(data.tool_calls || []).map(tc => ({ ...tc, status: 'executing' }))];
        const updatedBubble = { ...cleanedBubble, toolCalls: newToolCalls };

        const newBubbles = needNewBubble
          ? [...at.assistantBubbles, updatedBubble]
          : at.assistantBubbles.map((b, i) => i === at.assistantBubbles.length - 1 ? updatedBubble : b);

        patchChat({ activeTurn: { ...at, assistantBubbles: newBubbles } });
        break;
      }

      case 'tool_result': {
        const chat3 = getChat();
        const at = chat3?.activeTurn;
        if (!at) return;
        const lastBubble = at.assistantBubbles[at.assistantBubbles.length - 1];
        if (!lastBubble || !lastBubble.toolCalls) return;

        const idx = lastBubble.toolCalls.findIndex(tc => tc.status === 'executing');
        const newToolCalls = lastBubble.toolCalls.map((tc, i) => {
          if (i === idx) {
            const updated = { ...tc, status: data.status };
            if (data.message) updated.message = data.message;
            return updated;
          }
          return { ...tc };
        });
        const allDone = !newToolCalls.some(tc => tc.status === 'executing');
        const updatedBubble = { ...lastBubble, toolCalls: newToolCalls, sealed: allDone && newToolCalls.length > 0 ? true : lastBubble.sealed };

        const newBubbles = at.assistantBubbles.map((b, i) => i === at.assistantBubbles.length - 1 ? updatedBubble : b);
        patchChat({ activeTurn: { ...at, assistantBubbles: newBubbles } });
        break;
      }

      case 'status':
        break;

      case 'compact_start': {
        const chat4 = getChat();
        let at = chat4?.activeTurn;
        if (!at) return;

        const prevBubble = at.assistantBubbles[at.assistantBubbles.length - 1];
        const sealedPrev = prevBubble && !prevBubble.sealed
          ? { ...prevBubble, sealed: true }
          : prevBubble;

        const newBubble = {
          id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          content: '',
          toolCalls: [],
          ts: new Date().toISOString(),
          sealed: false,
          compactLoading: true,
        };

        const newBubbles = sealedPrev
          ? at.assistantBubbles.map((b, i) => i === at.assistantBubbles.length - 1 ? sealedPrev : b).concat(newBubble)
          : [...at.assistantBubbles, newBubble];

        patchChat({ activeTurn: { ...at, assistantBubbles: newBubbles } });
        break;
      }

      case 'compact': {
        const chat5 = getChat();
        const at2 = chat5?.activeTurn;
        if (!at2) return;
        const lastBubble2 = at2.assistantBubbles[at2.assistantBubbles.length - 1];
        if (lastBubble2) {
          const updatedBubble = {
            ...lastBubble2,
            compactLoading: undefined,
            compactSummary: data.tokenEstimate || true,
            sealed: true,
          };
          const newBubbles = at2.assistantBubbles.map((b, i) => i === at2.assistantBubbles.length - 1 ? updatedBubble : b);
          patchChat({ activeTurn: { ...at2, assistantBubbles: newBubbles } });
        }
        break;
      }

      case 'compact_error': {
        const chat6 = getChat();
        const at3 = chat6?.activeTurn;
        if (!at3) return;
        const lastBubble3 = at3.assistantBubbles[at3.assistantBubbles.length - 1];
        if (lastBubble3) {
          const updatedBubble = {
            ...lastBubble3,
            compactLoading: undefined,
            compactError: data.error || '记忆压缩失败',
            sealed: true,
          };
          const newBubbles = at3.assistantBubbles.map((b, i) => i === at3.assistantBubbles.length - 1 ? updatedBubble : b);
          patchChat({ activeTurn: { ...at3, assistantBubbles: newBubbles } });
        }
        break;
      }

      case 'done': {
        finalizeActiveTurn();
        break;
      }

      case 'idle': {
        // Agent 空闲，最终历史刷新
        const store = useAgentStore.getState();
        store.loadHistory(agentId);
        break;
      }

      case 'aborted': {
        // 如果有正在压缩中的 bubble，标记为终止
        const chatAborted = getChat();
        const atAborted = chatAborted?.activeTurn;
        if (atAborted) {
          const lastBubble = atAborted.assistantBubbles[atAborted.assistantBubbles.length - 1];
          if (lastBubble?.compactLoading && lastBubble.compactSummary == null && !lastBubble.compactError) {
            const updatedBubble = {
              ...lastBubble,
              compactLoading: undefined,
              compactError: '记忆压缩已终止',
              sealed: true,
            };
            const newBubbles = atAborted.assistantBubbles.map((b, i) =>
              i === atAborted.assistantBubbles.length - 1 ? updatedBubble : b
            );
            patchChat({ activeTurn: { ...atAborted, assistantBubbles: newBubbles } });
          }
        }
        finalizeActiveTurn();
        useAgentStore.getState().showToast('已停止生成');
        break;
      }

      case 'error': {
        finalizeActiveTurn();
        useAgentStore.getState().showToast(`错误: ${data.message}`);
        break;
      }
    }
  }, [agentId, patchChat, getChat, finalizeActiveTurn, flushRaf]);

  // ===== 发送消息 =====
  const send = useCallback(async (message) => {
    flushRaf();
    const chat = getChat();
    if (!chat) return;

    const agent = useAgentStore.getState().getAgent(agentId);
    if (!agent || agent.status !== 'running') {
      useAgentStore.getState().showToast('Agent 未运行，请先启动');
      return;
    }

    const msg = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      content: message,
      ts: new Date().toISOString(),
    };

    // ★ 不预先创建 typing bubble。server 真正开始回复（第一个 token/tool_call）
    //    才会在 _handleSSEEvent 中创建 assistant bubble。
    //    activeTurn 的 userMessage 让用户立即看到自己的消息。
    const newTurn = {
      id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userMessage: msg,
      assistantBubbles: [],
    };
    patchChat({ activeTurn: newTurn });

    try {
      await api.chat(agentId, message, {
        onEvent: _handleSSEEvent,
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        finalizeActiveTurn();
        return;
      }
      // 422 = Agent 正在回复中
      if (e.status === 422) {
        finalizeActiveTurn();
        useAgentStore.getState().showToast('Agent 正在回复中，请稍后再试');
        return;
      }
      finalizeActiveTurn();
      if (e.status) {
        useAgentStore.getState().showToast(`请求失败: ${e.message}`);
      } else {
        useAgentStore.getState().showToast(`连接失败: ${e.message}`);
      }
    }
  }, [agentId, getChat, patchChat, _handleSSEEvent, finalizeActiveTurn, flushRaf]);

  // ===== 中止 =====
  const abort = useCallback(async () => {
    if (subscribeControllerRef.current) {
      subscribeControllerRef.current.abort();
      subscribeControllerRef.current = null;
    }
    flushRaf();
    try {
      await api.abortAgent(agentId);
    } catch (e) {
      api.log('ERROR', `中断请求失败: ${e.message}`);
    }
  }, [agentId, flushRaf]);

  // ===== 页面刷新后 SSE 重连 =====
  const startPolling = useCallback(() => {
    const chat = getChat();
    if (!chat) return;

    // 中止已有的 subscribe
    if (subscribeControllerRef.current) {
      subscribeControllerRef.current.abort();
      subscribeControllerRef.current = null;
    }

    const subController = new AbortController();
    subscribeControllerRef.current = subController;

    api.log('INFO', `Agent ${agentId} 发起 SSE 重连`);
    api
      .subscribe(agentId, {
        onEvent: _handleSSEEvent,
        signal: subController.signal,
      })
      .then(() => {
        // subscribe 连接关闭 → 不再 streaming
        patchChat({ streaming: false });
      })
      .catch(e => {
        if (e.name === 'AbortError') return;
        // 失败直接重试 subscribe
        api.log('WARN', `SSE 重连失败: ${e.message}, 2s 后重试`);
        setTimeout(() => startPollingRef.current?.(), 2000);
      });
  }, [agentId, patchChat, getChat, _handleSSEEvent]);

  startPollingRef.current = startPolling;

  // ===== 清理 =====
  const cleanup = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (subscribeControllerRef.current) {
      subscribeControllerRef.current.abort();
      subscribeControllerRef.current = null;
    }
  }, []);

  return {
    send,
    abort,
    startPolling,
    cleanup,
  };
}
