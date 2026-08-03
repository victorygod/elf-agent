/**
 * Agent /events SSE 长连接管理
 *
 * Agent 暴露 GET /events 端点推送后台状态变更事件（compact 完成等）。
 * Gateway 在 Agent 启动后建立到该端点的 SSE 长连接，解析事件后通过 onEvent
 * 回调转发给前端 subscribe 连接 + 更新 history.jsonl。
 *
 * 连接与 StreamContext 生命周期解耦：Agent 重启/断连时自动重连。
 *
 * 通道生命周期与进程探活对齐（防孤儿 streaming）：
 *  - connectAgentEvents 幂等：已有未被 abort 的连接则不重建，避免 probe 反复建/断
 *    打断正在 streaming 的事件流。
 *  - onDisconnect 回调：SSE 在「连接关闭 / 读取错误 / 连接失败」三处断开分支触发，
 *    供上层（process_manager）强制结束该 agent 名下 chat-<id> 的孤儿 streaming 回合。
 *    主动 disconnectAgentEvents（abort）不触发 onDisconnect，区分「我们主动断」与「通道自己断」。
 */

import { createLogger } from '../shared/logger.js';

const logger = createLogger('agent-events', 'gateway.log');

/** 断线重连间隔 (ms) */
const RECONNECT_DELAY = 5000;

const connections = new Map(); // agentId → { controller: AbortController, onDisconnect?: () => void }

/**
 * 建立到 Agent /events 的 SSE 长连接，解析事件后回调 onEvent(eventName, data)。
 * 断线/异常后自动重连（5s 间隔）。
 *
 * 幂等：同一 agentId 若已有未被 abort 的连接，直接复用（仅刷新 onDisconnect 回调），
 *   不重复建连，避免 probeAgent 反复触发打断正在 streaming 的事件流。
 *
 * @param {string} agentId
 * @param {number} port - Agent HTTP 端口
 * @param {(eventName: string, data: object) => void} onEvent - 事件回调
 * @param {() => void} [onDisconnect] - SSE 通道断开（非主动 abort）时回调；上层据此清孤儿 streaming
 * @returns {AbortController} 用于外部 abort
 */
export function connectAgentEvents(agentId, port, onEvent, onDisconnect) {
  const existing = connections.get(agentId);
  if (existing && !existing.controller.signal.aborted) {
    // 复用现有活连接，仅刷新 onDisconnect（新调用方可能带最新回调）
    existing.onDisconnect = onDisconnect;
    return existing.controller;
  }
  disconnectAgentEvents(agentId); // 先清旧连接（已 abort / 不存在）

  const controller = new AbortController();
  connections.set(agentId, { controller, onDisconnect });

  (function connect() {
    if (controller.signal.aborted) return;
    logger.info(`[events] 连接 Agent ${agentId} /events (port ${port})`);

    fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal })
      .then(res => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', currentEvent = '';

        function pump() {
          if (controller.signal.aborted) return;
          reader.read().then(({ done, value }) => {
            if (done) {
              logger.warn(`[events] Agent ${agentId} /events 连接关闭，${RECONNECT_DELAY}ms 后重连`);
              // 通道断开 → 本回合后续事件（含 done）可能丢失 → 通知上层兜底清孤儿 streaming
              if (!controller.signal.aborted) onDisconnect?.();
              setTimeout(connect, RECONNECT_DELAY);
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('event: ')) {
                currentEvent = trimmed.slice(7).trim();
              } else if (trimmed.startsWith('data: ')) {
                try {
                  const data = JSON.parse(trimmed.slice(6));
                  onEvent(currentEvent, data);
                } catch (e) { /* ignore parse error */ }
              } else if (trimmed === '') {
                currentEvent = '';
              }
            }
            pump();
          }).catch(err => {
            if (controller.signal.aborted) return;
            logger.warn(`[events] Agent ${agentId} /events 读取错误: ${err.message}, ${RECONNECT_DELAY}ms 后重连`);
            if (!controller.signal.aborted) onDisconnect?.();
            setTimeout(connect, RECONNECT_DELAY);
          });
        }
        pump();
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        logger.warn(`[events] Agent ${agentId} /events 连接失败: ${err.message}, ${RECONNECT_DELAY}ms 后重连`);
        if (!controller.signal.aborted) onDisconnect?.();
        setTimeout(connect, RECONNECT_DELAY);
      });
  })();

  return controller;
}

/** 当前是否持有该 agent 的有效（未被 abort）SSE 连接。供 probeAgent 判定是否需要重建通道。 */
export function hasAgentEventsConnection(agentId) {
  const conn = connections.get(agentId);
  return !!conn && !conn.controller.signal.aborted;
}

/** 断开到 Agent /events 的连接（主动 abort，不触发 onDisconnect） */
export function disconnectAgentEvents(agentId) {
  const conn = connections.get(agentId);
  if (conn) {
    conn.controller.abort();
    connections.delete(agentId);
    logger.info(`[events] 断开 Agent ${agentId} /events 连接`);
  }
}