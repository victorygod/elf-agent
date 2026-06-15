/**
 * Sidebar — Agent 列表侧边栏
 */

import { cloneTemplate, renderAvatar } from './utils.js';
import { EventBus } from './utils.js';

export class Sidebar extends EventBus {
  /**
   * @param {HTMLElement} el - #agentList 容器
   */
  constructor(el) {
    super();
    this.el = el;
    this.agents = [];
    this.activeAgentId = null;
  }

  /** 更新 agent 数据并重新渲染 */
  render(agents) {
    this.agents = agents;
    this.el.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (const a of agents) {
      const frag = cloneTemplate('tmplAgentItem');
      const el = frag.querySelector('.agent-item');
      el.setAttribute('data-agent-id', a.agentId);
      if (a.agentId === this.activeAgentId) el.classList.add('active');
      el.onclick = () => this.emit('agent-select', a.agentId);
      frag.querySelector('.agent-avatar').innerHTML = renderAvatar(a.agentId, a.avatar, (a.name || a.agentId).charAt(0).toUpperCase());
      frag.querySelector('.agent-name').textContent = a.name || a.agentId;
      frag.querySelector('.agent-path').textContent = a.path || ('agents/' + a.agentId);
      const statusEl = frag.querySelector('.agent-status');
      statusEl.classList.add(a.status);
      frag.querySelector('.status-text').textContent =
        a.status === 'running' ? '运行中' : a.status === 'error' ? '错误' : '已停止';
      fragment.appendChild(frag);
    }
    this.el.appendChild(fragment);
  }

  /** 设置当前激活的 agent */
  setActive(agentId) {
    this.activeAgentId = agentId;
    this.el.querySelectorAll('.agent-item').forEach(item => {
      item.classList.toggle('active', item.dataset.agentId === agentId);
    });
  }

  /** 获取指定 agent 的数据 */
  getAgent(agentId) {
    return this.agents.find(a => a.agentId === agentId);
  }
}