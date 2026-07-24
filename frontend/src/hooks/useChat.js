/**
 * useChat — 发送消息 / 中止 / 回退等动作（不含 SSE 订阅）
 *
 * 重构说明（见 docs/subscribe-app-resident-design.md）：
 * - SSE 订阅已上移到 app 级 useAgentSubscriptions，常驻、切 tab 不断。
 * - SSE 事件 → store 的逻辑在 sseDispatcher.handleSSEEvent（脱离 React 组件）。
 * - 本 hook 只保留动作：send（POST /chat 发消息流）、abort、rewind、listCheckpoints。
 *
 * send 的流式事件依旧用 handleSSEEvent 写 store（与常驻 subscribe 同处理逻辑）。
 * abort 只中止生成（POST /abort），不再断 subscribe（subscribe 由 useAgentSubscriptions 管）。
 * rewind 成功后端从 snapshot 重发，常驻 subscribe 在场接收，无需本 hook 重连。
 */

import { useCallback } from 'react';
import * as api from '../api/index.js';
import useAgentStore from '../stores/agentStore.js';
import { handleSSEEvent, finalizeActiveTurn } from '../stores/sseDispatcher.js';

export default function useChat(agentId) {
  // ===== 发送消息 =====
  const send = useCallback(async (message) => {
    const chat = useAgentStore.getState().chats.get(agentId);
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

    const newTurn = {
      id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userMessage: msg,
      assistantBubbles: [],
    };
    useAgentStore.getState()._patchChat(agentId, { activeTurn: newTurn });

    try {
      await api.chat(agentId, message, {
        onEvent: (event, data) => handleSSEEvent(agentId, event, data),
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        finalizeActiveTurn(agentId);
        return;
      }
      // 422 = Agent 正在回复中
      if (e.status === 422) {
        finalizeActiveTurn(agentId);
        useAgentStore.getState().showToast('Agent 正在回复中，请稍后再试');
        return;
      }
      finalizeActiveTurn(agentId);
      if (e.status) {
        useAgentStore.getState().showToast(`请求失败: ${e.message}`);
      } else {
        useAgentStore.getState().showToast(`连接失败: ${e.message}`);
      }
    }
  }, [agentId]);

  // ===== 中止生成（不再断 subscribe）=====
  const abort = useCallback(async () => {
    try {
      await api.abortAgent(agentId);
    } catch (e) {
      api.log('ERROR', `中断请求失败: ${e.message}`);
    }
  }, [agentId]);

  // ===== Rewind（双击 Esc 回退）=====
  // 调 gateway /rewind 整文件替换 history。rewind 是服务端状态变更，但服务端不主动推 snapshot
  // （snapshot 仅在 subscribe 新建时推）。常驻 subscribe 不随 rewind 重建，故本 hook 成功后
  // 主动 loadHistory 从回退后的磁盘权威源重建 store（先 finalize 清在途）。
  const rewind = useCallback(async (checkpointId = null) => {
    try {
      const data = await api.rewindAgent(agentId, checkpointId);
      if (data?.status === 'ok') {
        finalizeActiveTurn(agentId);
        await useAgentStore.getState().loadHistory(agentId);
        return { ok: true, restoredPrompt: data.restoredPrompt ?? null };
      }
      api.log('WARN', `rewind 失败: ${data?.error || 'unknown'}`);
      return { ok: false, error: data?.error };
    } catch (e) {
      api.log('ERROR', `rewind 请求失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }, [agentId]);

  /** 列出可回退的快照包 */
  const listCheckpoints = useCallback(async () => {
    try {
      const data = await api.listCheckpoints(agentId);
      return data?.checkpoints ?? [];
    } catch (e) {
      api.log('ERROR', `列出 checkpoint 失败: ${e.message}`);
      return [];
    }
  }, [agentId]);

  return { send, abort, rewind, listCheckpoints };
}