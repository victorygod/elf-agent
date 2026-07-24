/**
 * Agent /events SSE 长连接管理
 *
 * Agent 暴露 GET /events 端点推送后台状态变更事件（compact 完成等）。
 * Gateway 在 Agent 启动后建立到该端点的 SSE 长连接，解析事件后通过 onEvent
 * 回调转发给前端 subscribe 连接 + 更新 history.jsonl。
 *
 * 连接与 StreamContext 生命周期解耦：Agent 重启/断连时自动重连。
 */

import { createLogger } from '../shared/logger.js';

const logger = createLogger('agent-events', 'gateway.log');

/** 断线重连间隔 (ms) */
const RECONNECT_DELAY = 5000;

const connections = new Map(); // agentId → { controller: AbortController }

/**
 * 建立到 Agent /events 的 SSE 长连接，解析事件后回调 onEvent(eventName, data)。
 * 断线/异常后自动重连（5s 间隔）。重复调用同一 agentId 会先断开旧连接。
 *
 * @param {string} agentId
 * @param {number} port - Agent HTTP 端口
 * @param {(eventName: string, data: object) => void} onEvent - 事件回调
 * @returns {AbortController} 用于外部 abort
 */
export function connectAgentEvents(agentId, port, onEvent) {
  disconnectAgentEvents(agentId); // 先清旧连接

  const controller = new AbortController();
  connections.set(agentId, { controller });

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
            setTimeout(connect, RECONNECT_DELAY);
          });
        }
        pump();
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        logger.warn(`[events] Agent ${agentId} /events 连接失败: ${err.message}, ${RECONNECT_DELAY}ms 后重连`);
        setTimeout(connect, RECONNECT_DELAY);
      });
  })();

  return controller;
}

/** 断开到 Agent /events 的连接 */
export function disconnectAgentEvents(agentId) {
  const conn = connections.get(agentId);
  if (conn) {
    conn.controller.abort();
    connections.delete(agentId);
    logger.info(`[events] 断开 Agent ${agentId} /events 连接`);
  }
}