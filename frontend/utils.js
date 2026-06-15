/**
 * Elf 前端工具函数
 * 纯函数，无状态依赖
 */

/** 从 <template> 克隆内容 */
export function cloneTemplate(id) {
  const tmpl = document.getElementById(id);
  if (!tmpl) throw new Error(`Template #${id} not found`);
  return tmpl.content.cloneNode(true);
}

/** ISO 时间字符串 → HH:MM */
export function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** HTML 转义 */
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** 是否移动端视图 */
export function isMobileView() {
  return window.innerWidth <= 768;
}

/** 渲染头像 HTML */
export function renderAvatar(agentId, avatar, fallback) {
  if (avatar) {
    return `<img src="/agents/${agentId}/config/${avatar}" alt="${agentId}">`;
  }
  return `<span class="avatar-default">${fallback}</span>`;
}

/** 渲染工具调用标记 HTML */
export function renderToolCalls(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  return toolCalls.map(tc => {
    const name = escapeHtml(tc.name || 'unknown');
    const argsHtml = Object.entries(tc.args || {}).map(([key, val]) => {
      const raw = String(val);
      const displayVal = raw.length > 20 ? escapeHtml('…' + raw.slice(-20)) : escapeHtml(raw);
      const fullVal = escapeHtml(raw);
      return `<div class="tool-call-arg" title="${fullVal}">${escapeHtml(key)}: ${displayVal}</div>`;
    }).join('');
    return `<div class="tool-call-badge">[工具] ${name}${argsHtml ? '<div class="tool-call-args">' + argsHtml + '</div>' : ''}</div>`;
  }).join('');
}


/**
 * 简易事件发射器 mixin
 * 用法：class Foo extends EventMixin() { ... } 或 Object.assign(obj, EventMixin.prototype)
 */
export class EventBus {
  constructor() {
    this._handlers = {};
  }

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
  }

  off(event, handler) {
    if (!this._handlers[event]) return;
    this._handlers[event] = this._handlers[event].filter(h => h !== handler);
  }

  emit(event, ...args) {
    if (!this._handlers[event]) return;
    for (const h of this._handlers[event]) h(...args);
  }
}