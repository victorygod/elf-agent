/**
 * ConfigPanel — 配置面板（右侧抽屉）
 */

import { API_BASE } from './api.js';
import * as api from './api.js';
import { EventBus } from './utils.js';

export class ConfigPanel extends EventBus {
  constructor() {
    super();
    this.overlay = document.getElementById('configOverlay');
    this.panel = document.getElementById('configPanel');
    this.frame = document.getElementById('configFormFrame');
    this.currentAgentId = null;

    // 绑定按钮
    this._bindEvents();
  }

  /** 打开配置面板 */
  open(agentId) {
    this.currentAgentId = agentId;
    this.frame.src = `${API_BASE}/agents/${agentId}/config-ui`;
    this.overlay.classList.add('open');
    this.panel.classList.add('open');
  }

  /** 关闭配置面板 */
  close() {
    this.overlay.classList.remove('open');
    this.panel.classList.remove('open');
    this.frame.src = '';
    this.currentAgentId = null;
  }

  /** 从 iframe 收集配置数据 */
  async collectConfig() {
    const update = {};
    try {
      const doc = this.frame.contentDocument || this.frame.contentWindow.document;
      let currentConfig = await api.getConfig(this.currentAgentId);

      const MODEL_KEYS = new Set(['base_url', 'auth_token', 'model']);
      const elements = doc.querySelectorAll('[data-key]');
      let modelChanged = false;
      const modelUpdate = {};

      for (const el of elements) {
        const key = el.getAttribute('data-key');
        let value;
        if (el.type === 'checkbox') { value = el.checked; }
        else if (el.type === 'number') { value = el.value !== '' ? Number(el.value) : undefined; }
        else { value = el.value; }

        if (key === 'systemPrompt' || key === 'prefix_prompt' || key === 'suffix_prompt') {
          if (value !== undefined) update[key] = value;
          continue;
        }
        if (value === undefined || value === '') continue;

        if (MODEL_KEYS.has(key)) { modelUpdate[key] = value; modelChanged = true; continue; }
        if (key.startsWith('model.')) { modelUpdate[key.slice(6)] = value; modelChanged = true; continue; }
        update[key] = value;
      }

      if (modelChanged && currentConfig && currentConfig.model) {
        update.model = { ...currentConfig.model, ...modelUpdate };
      } else if (modelChanged) {
        update.model = modelUpdate;
      }
    } catch (e) {
      api.log('ERROR', '收集配置数据失败: ' + e.message);
    }
    return update;
  }

  /** 保存配置 */
  async save() {
    if (!this.currentAgentId) return;
    const update = await this.collectConfig();
    if (Object.keys(update).length === 0) { this.close(); return; }
    try {
      await api.updateConfig(this.currentAgentId, update);
      api.log('INFO', '配置已保存');
      const savedAgentId = this.currentAgentId;
      this.close();
      this.emit('saved', savedAgentId);
    } catch (e) {
      alert('保存失败: ' + e.message);
      api.log('ERROR', '配置保存失败: ' + e.message);
    }
  }

  /** 启动 Agent */
  async startAgent() {
    if (!this.currentAgentId) return;
    const btnStart = document.getElementById('cfgBtnStart');
    if (btnStart) { btnStart.textContent = '启动中...'; btnStart.disabled = true; }
    try {
      const data = await api.startAgent(this.currentAgentId);
      if (data.error) {
        alert('启动失败: ' + data.error);
      }
    } catch (e) {
      alert('启动失败: ' + e.message);
    }
    if (btnStart) { btnStart.textContent = '启动服务'; btnStart.disabled = false; }
    this.emit('agent-control', this.currentAgentId);
  }

  /** 停止 Agent */
  async stopAgent() {
    if (!this.currentAgentId) return;
    try {
      const data = await api.stopAgent(this.currentAgentId);
      if (data.error) {
        alert('停止失败: ' + data.error);
      }
    } catch (e) {
      alert('停止失败: ' + e.message);
    }
    this.emit('agent-control', this.currentAgentId);
  }

  /** 更新启停按钮状态 */
  updateButtons(status) {
    const btnStart = document.getElementById('cfgBtnStart');
    const btnStop = document.getElementById('cfgBtnStop');
    if (status === 'running') {
      btnStart?.classList.add('hidden');
      btnStop?.classList.remove('hidden');
    } else {
      btnStart?.classList.remove('hidden');
      btnStop?.classList.add('hidden');
    }
  }

  /** 调整 iframe 高度 */
  resizeFrame() {
    try {
      const doc = this.frame.contentDocument || this.frame.contentWindow.document;
      this.frame.style.height = doc.documentElement.scrollHeight + 4 + 'px';
    } catch (e) { /* cross-origin */ }
  }

  _bindEvents() {
    // 配置面板的按钮在 index.html 中有 onclick，需要全局函数桥接
    // 这里只绑定 overlay 和 frame 事件
    this.overlay.addEventListener('click', () => this.close());
    this.frame.addEventListener('load', () => this.resizeFrame());
  }
}