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

// ===== Rewind（双击 Esc 回退）=====

/** 列出可回退的快照包 */
export async function listCheckpoints(agentId) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/checkpoints`);
  return res.json();
}

/**
 * 回退到指定快照包（省略 checkpointId = 最近一个）
 * @returns {Promise<{ status, restoredPrompt, checkpoints }>}
 */
export async function rewindAgent(agentId, checkpointId = null) {
  const res = await fetch(`${API_BASE}/agents/${agentId}/rewind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkpointId }),
  });
  return res.json();
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

/** 获取所有可用工具名（来自 shared/agent/tools/index.js） */
export async function getAvailableTools() {
  const res = await fetch(`${API_BASE}/available-tools`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.tools || [];
}

// ===== Skill 管理（平台级） =====

/** 列出 user + project 两目录下所有 skill */
export async function listSkills() {
  const res = await fetch(`${API_BASE}/skills`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();   // { skills, roots }
}

/** 读单个 skill 的 SKILL.md 全文 */
export async function getSkillDetail(source, name) {
  const res = await fetch(`${API_BASE}/skills/${source}/${encodeURIComponent(name)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return await res.json();   // { content }
}

/** 删除一个 skill 目录 */
export async function deleteSkill(source, name) {
  const res = await fetch(`${API_BASE}/skills/${source}/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return await res.json();
}

/** 安装 skill：把一个目录复制到 ~/.elf/skills/ */
export async function installSkill(sourcePath) {
  const res = await fetch(`${API_BASE}/skills/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourcePath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return await res.json();
}

/** 浏览目录子项（仅目录），供前端选 skill 源目录 */
export async function browseSkillDirs(dir) {
  const url = `${API_BASE}/skills/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return await res.json();   // { current, entries: [{name,path,isDirectory}] }
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

// ===== 群聊 /rooms/* =====

export const ROOM_HISTORY_PAGE_SIZE = 50;

/** 列所有群 */
export async function loadRooms() {
  const res = await fetch(`${API_BASE}/rooms`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.rooms || [];
}

/** 获取群详情（含成员在线状态） */
export async function getRoom(roomId) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}`);
  if (!res.ok) return null;
  return await res.json();
}

/** 建群 {name, members:[agentId]} */
export async function createRoom(name, members) {
  const res = await fetch(`${API_BASE}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, members }),
  });
  if (!res.ok) throw new Error(`建群失败: ${res.status}`);
  return await res.json();
}

/** 解散群 */
export async function deleteRoom(roomId) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`解散群失败: ${res.status}`);
  return await res.json();
}

/** 加成员 {agentId} */
export async function addRoomMember(roomId, agentId) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  if (!res.ok) throw new Error(`加成员失败: ${res.status}`);
  return await res.json();
}

/** 移除成员 */
export async function removeRoomMember(roomId, agentId) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}/members/${agentId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`移除成员失败: ${res.status}`);
  return await res.json();
}

/** 群历史分页 */
export async function getRoomHistory(roomId, limit = ROOM_HISTORY_PAGE_SIZE, beforeId = null) {
  const qs = beforeId ? `?limit=${limit}&before=${encodeURIComponent(beforeId)}` : `?limit=${limit}`;
  const res = await fetch(`${API_BASE}/rooms/${roomId}/history${qs}`);
  if (!res.ok) return { messages: [], hasMore: false };
  return await res.json();
}

/** 用户发言 */
export async function sendRoomMessage(roomId, message) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`发送失败: ${res.status}`);
  return await res.json();
}

/** 清空群历史 */
export async function clearRoomHistory(roomId) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}/history`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`清空历史失败: ${res.status}`);
  return await res.json();
}

/** 清空各成员记忆 */
export async function clearRoomMemory(roomId) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}/clear-memory`, { method: 'POST' });
  if (!res.ok) throw new Error(`清空记忆失败: ${res.status}`);
  return await res.json();
}

/** 清空聊天记录 + 成员记忆（合一原子操作） */
export async function clearRoomAll(roomId) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}/clear-all`, { method: 'POST' });
  if (!res.ok) throw new Error(`清空失败: ${res.status}`);
  return await res.json();
}

/** 群聊 SSE 订阅 URL（EventSource 用） */
export function roomSubscribeUrl(roomId) {
  return `${API_BASE}/rooms/${roomId}/subscribe`;
}

// ===== 全局设置（用户名等）=====

/** 获取设置（含 userName、userAvatar、userUid、sidebarOrder） */
export async function getSettings() {
  const res = await fetch(`${API_BASE}/settings`);
  if (!res.ok) return { userName: 'user', userAvatar: null, userUid: 'default_userid', sidebarOrder: { rooms: [], agents: [] } };
  return await res.json();
}

/** 更新设置（userName / userAvatar / userUid） */
export async function putSettings(data) {
  const res = await fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`保存设置失败: ${res.status}`);
  return await res.json();
}

/** 保存侧栏手动排序（区段内：rooms/agents 各自顺序） */
export async function putSidebarOrder(sidebarOrder) {
  const res = await fetch(`${API_BASE}/settings/sidebar-order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sidebarOrder }),
  });
  if (!res.ok) throw new Error(`保存侧栏排序失败: ${res.status}`);
  return await res.json();
}

/** 上传用户头像（base64 + mime type），返回保存后的文件名 */
export async function uploadUserAvatar(data, type) {
  const res = await fetch(`${API_BASE}/settings/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, type }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `头像上传失败: ${res.status}`);
  }
  return await res.json();
}