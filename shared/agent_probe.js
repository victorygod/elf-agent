/**
 * Agent 进程探活工具（纯函数）
 *
 * 从 process_manager 抽出的协议级探活方法，去 this.agents 注册表依赖。
 * process_manager 和 room_bus 共用。
 *
 * 见 docs/chat-room-design.md §8.3（gateway/room_bus 复用探活）。
 */

import { execSync } from 'child_process';

/** 启动后探活轮询间隔 (ms) */
export const PROBE_INTERVAL = 300;
/** 停止确认轮询间隔 (ms) */
export const STOP_PROBE_INTERVAL = 300;

/**
 * 探活指定端口上的进程（GET /status），返回 pid 与 status 数据。
 * 语义对齐 process_manager.probeAgent 的协议部分（不更新任何注册表）。
 * @param {number} port
 * @param {number} [timeoutMs=3000] fetch 超时
 * @returns {Promise<{ok:boolean, pid?:number, runKey?:string, agentId?:string, mode?:string, data?:object}>}
 */
export async function probePort(port, timeoutMs = 3000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      const data = await response.json();
      return { ok: true, pid: data.pid, runKey: data.runKey, agentId: data.agentId, mode: data.mode, data };
    }
  } catch (err) {
    // 不可达/超时
  }
  return { ok: false };
}

/**
 * 通过 lsof 查找占用端口的进程 PID。
 * 语义对齐 process_manager.findPidFromPort。
 * @param {number} port
 * @returns {number|null}
 */
export function findPidFromPort(port) {
  try {
    const result = execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (result) {
      const pids = result.split('\n').filter(Boolean).map(Number);
      return pids[0] || null;
    }
  } catch (err) {
    // lsof 未找到或执行失败
  }
  return null;
}

/**
 * 轮询等待端口上的进程 HTTP 就绪。
 * 语义对齐 process_manager._waitForReady，但用 probePort 替代 probeAgent。
 * @param {number} port
 * @param {number} timeout - 超时毫秒
 * @param {number} [interval=PROBE_INTERVAL]
 * @returns {Promise<boolean>} 是否就绪
 */
export async function waitForReady(port, timeout, interval = PROBE_INTERVAL) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { ok } = await probePort(port);
    if (ok) return true;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return false;
}

/**
 * POST /shutdown 优雅关闭端口上的进程。
 * 语义对齐 process_manager._httpShutdown。
 * @param {number} port
 * @param {number} [timeoutMs=5000]
 */
export async function httpShutdown(port, timeoutMs = 5000) {
  const response = await fetch(`http://127.0.0.1:${port}/shutdown`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`/shutdown 返回 ${response.status}`);
  }
}

/**
 * 轮询等待端口释放（lsof 不再发现 LISTEN 进程）。
 * 语义对齐 process_manager._waitForPortFree。
 * @param {number} port
 * @param {number} timeout - 超时毫秒
 * @returns {Promise<void>} 端口释放 resolve；超时 reject
 */
export async function waitForPortFree(port, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const pid = findPidFromPort(port);
    if (!pid) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`端口 ${port} 在 ${timeout}ms 内未释放`);
}