/**
 * Elf API 层
 * 所有后端 fetch 调用集中在此，前端其他模块不直接使用 fetch
 */

export const API_BASE = '';
export const HISTORY_PAGE_SIZE = 30;

// ===== Agent 列表 =====

/** 获取所有 agent 列表 */
export async function loadAgents() {
  const res = await fetch(`${API_BASE}/agents`);
  return await res.json();
}

/** 重新扫描 agent 目录 */
export async function rediscoverAgents() {
  const res = await fetch(`${API_BASE}/agents/rediscover`, { method: 'POST' });
  if (res.ok) {
    const data = await res.json();
    return data.agents;
  }
  return null;
}

/** 获取单个 agent 详情（含 streaming 状态） */
export async function getAgent(id) {
  const res = await fetch(`${API_BASE}/agents/${id}`);
  if (!res.ok) return null;
  return await res.json();
}

// ===== Agent 控制 =====

/** 启动 agent */
export async function startAgent(id) {
  const res = await fetch(`${API_BASE}/agents/${id}/start`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

/** 停止 agent */
export async function stopAgent(id) {
  const res = await fetch(`${API_BASE}/agents/${id}/stop`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

/** 中断当前生成 */
export async function abortAgent(id) {
  await fetch(`${API_BASE}/agents/${id}/abort`, { method: 'POST' });
}

// ===== 聊天 =====

/**
 * 发送消息并接收 SSE 流式响应
 * @param {string} agentId
 * @param {string} message
 * @param {Object} options
 * @param {function(string, object): void} options.onEvent - SSE 事件回调 (eventName, data)
 * @param {AbortSignal} [options.signal] - 可选的中断信号
 * @returns {Promise<void>}
 */
export async function chat(agentId, message, { onEvent, signal } = {}) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    signal
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw Object.assign(new Error(err.error || res.statusText), { status: res.status, data: err });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7).trim();
      } else if (trimmed.startsWith('data: ')) {
        try {
          onEvent?.(currentEvent, JSON.parse(trimmed.slice(6)));
        } catch (e) { /* ignore parse errors */ }
        currentEvent = '';
      } else if (trimmed === '') {
        currentEvent = '';
      }
    }
  }
}

/**
 * 订阅正在进行的 SSE 流（页面刷新后重连）
 * 不发送新消息，只接收已有流的回放 + 后续实时事件
 * @param {string} agentId
 * @param {Object} options
 * @param {function(string, object): void} options.onEvent - SSE 事件回调 (eventName, data)
 * @param {AbortSignal} [options.signal] - 可选的中断信号
 * @returns {Promise<void>}
 */
export async function subscribe(agentId, { onEvent, signal } = {}) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/subscribe`, { signal });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw Object.assign(new Error(err.error || res.statusText), {
      status: res.status,
      data: err,
      retry: err.retry || false,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7).trim();
      } else if (trimmed.startsWith('data: ')) {
        try {
          onEvent?.(currentEvent, JSON.parse(trimmed.slice(6)));
        } catch (e) { /* ignore parse errors */ }
        currentEvent = '';
      } else if (trimmed === '') {
        currentEvent = '';
      }
    }
  }
}

// ===== 聊天历史 =====

/** 获取聊天历史（分页 + 增量） */
export async function getHistory(agentId, { limit = HISTORY_PAGE_SIZE, before, afterId } = {}) {
  let url = `${API_BASE}/agents/${agentId}/history?limit=${limit}`;
  if (before) url += `&before=${before}`;
  if (afterId) url += `&afterId=${afterId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/** 清空聊天历史 */
export async function deleteHistory(agentId) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/history`, { method: 'DELETE' });
  return res.ok;
}

/** 清空 agent 记忆 */
export async function deleteMemory(agentId) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/memory`, { method: 'DELETE' });
  return res.ok;
}

// ===== 配置 =====

/** 获取 agent 配置 */
export async function getConfig(agentId) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/config`);
  if (!res.ok) return null;
  return await res.json();
}

/** 获取 agent 配置 UI 布局和配置数据 */
export async function getConfigUI(agentId) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/config-ui`);
  if (!res.ok) return null;
  return await res.json();
}

/** 更新 agent 配置 */
export async function updateConfig(agentId, data) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || res.statusText);
  }
  return true;
}

// ===== 头像 =====

/** 上传头像（base64） */
export async function uploadAvatar(agentId, field, base64, type) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/${field}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: base64, type })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || res.statusText);
  }
  return await res.json();
}

// ===== 日志 =====

/** 前端日志上报 */
export function log(level, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [frontend] ${message}`;
  console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](line);
  try {
    fetch(`${API_BASE}/api/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message, timestamp: ts })
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}