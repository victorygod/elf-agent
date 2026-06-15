/**
 * Elf 前端应用 — 主控制器
 * 管理侧边栏、AgentChat 实例池、配置面板的协调
 */

import { isMobileView } from './utils.js';
import * as api from './api.js';
import { Sidebar } from './sidebar.js';
import { AgentChat } from './agent-chat.js';
import { ConfigPanel } from './config-panel.js';

class App {
  constructor() {
    this.chats = new Map();         // agentId → AgentChat
    this.activeAgentId = null;
    this.agents = [];               // 全局 agent 列表（引用，供 AgentChat 读取头像等）

    // 全局 DOM
    this.chatContainer = document.getElementById('chatArea');
    this.topBar = document.getElementById('topBar');
    this.topTitle = document.getElementById('topTitle');
    this.sidebarEl = document.getElementById('agentList');

    // 模块
    this.sidebar = new Sidebar(this.sidebarEl);
    this.configPanel = new ConfigPanel();

    this._bindGlobalEvents();
  }

  async init() {
    api.log('INFO', 'Elf 前端初始化');
    await this._loadAgents();
    this.sidebar.render(this.agents);

    // 事件监听
    this.sidebar.on('agent-select', (agentId) => this.selectAgent(agentId));
    this.configPanel.on('saved', (agentId) => this._onConfigSaved(agentId));
    this.configPanel.on('agent-control', (agentId) => this._onAgentControl(agentId));

    // 选第一个 running 的 agent
    const running = this.agents.find(a => a.status === 'running');
    const first = this.agents[0];
    if (running) this.selectAgent(running.agentId);
    else if (first) this.selectAgent(first.agentId);
  }

  // ==================== Agent 选择 ====================

  async selectAgent(agentId) {
    if (this.activeAgentId === agentId) return;

    // 隐藏当前
    if (this.activeAgentId) {
      this.chats.get(this.activeAgentId)?.hide();
    }

    this.activeAgentId = agentId;

    // 显示顶栏
    this.topBar.classList.remove('hidden');

    // 懒创建 AgentChat
    if (!this.chats.has(agentId)) {
      this.chats.set(agentId, new AgentChat(agentId, () => this.agents, this.chatContainer, {
        onRefreshAgents: () => this._refreshAgents(),
        onRequestConfig: () => this.openConfig()
      }));
    }

    const chat = this.chats.get(agentId);
    chat.show();

    // 顶栏标题
    const agent = this.sidebar.getAgent(agentId);
    this.topTitle.textContent = agent?.name || agentId;

    // 侧边栏高亮
    this.sidebar.setActive(agentId);

    // 更新控制按钮
    if (agent) chat.updateControlButtons(agent.status);

    // 历史加载 / 滚动恢复
    if (!chat._historyLoaded) {
      // 首次加载：拉取历史并滚到底部
      await chat.loadHistory();
    } else {
      // 已有历史：恢复滚动位置
      chat.restoreScroll();
    }

    // 页面刷新后重连流式回复
    if (agent && agent.streaming && !chat.streaming) {
      chat.startHistoryPolling();
    }

    // 自动启动（历史已加载完成，addSystemMessage 不会被 renderHistory 清空）
    if (agent && agent.status !== 'running') {
      chat.addSystemMessage(`正在启动 Agent ${agentId}...`);
      chat.startAgent();
    }

    // 移动端
    if (isMobileView()) {
      this.sidebarEl.closest('.sidebar').classList.add('hidden-mobile');
      document.getElementById('mainArea').classList.add('active-mobile');
    }
  }

  // ==================== 配置面板 ====================

  openConfig() {
    if (!this.activeAgentId) return;
    const agent = this.sidebar.getAgent(this.activeAgentId);
    this.configPanel.open(this.activeAgentId);
    this.configPanel.updateButtons(agent?.status);
  }

  closeConfig() {
    this.configPanel.close();
  }

  async saveConfig() {
    await this.configPanel.save();
  }

  async startAgent() {
    await this.configPanel.startAgent();
  }

  async stopAgent() {
    await this.configPanel.stopAgent();
  }

  async clearChatHistory() {
    const chat = this.chats.get(this.activeAgentId);
    if (chat) await chat.clearChatHistory();
  }

  async clearMemory() {
    if (!this.activeAgentId) return;
    if (!confirm('确定要清空 Agent 记忆吗？此操作不可恢复，Agent 将忘记之前的对话内容。')) return;
    try {
      const ok = await api.deleteMemory(this.activeAgentId);
      if (ok) {
        const chat = this.chats.get(this.activeAgentId);
        if (chat) chat.addSystemMessage('Agent 记忆已清空');
        api.log('INFO', `Agent ${this.activeAgentId} 记忆已清空`);
      } else {
        const chat = this.chats.get(this.activeAgentId);
        if (chat) chat.addSystemMessage('清空失败');
      }
    } catch (e) {
      const chat = this.chats.get(this.activeAgentId);
      if (chat) chat.addSystemMessage(`清空失败: ${e.message}`);
      api.log('ERROR', `Agent ${this.activeAgentId} 清空记忆失败: ${e.message}`);
    }
  }

  // ==================== 刷新 ====================

  async _refreshAgents() {
    try {
      const agents = await api.rediscoverAgents();
      if (agents) {
        this.agents = agents;
      } else {
        await this._loadAgents();
      }
    } catch (e) {
      await this._loadAgents();
    }
    this.sidebar.render(this.agents);
    const agent = this.sidebar.getAgent(this.activeAgentId);
    if (agent) {
      const chat = this.chats.get(this.activeAgentId);
      if (chat) chat.updateControlButtons(agent.status);
      this.configPanel.updateButtons(agent.status);
    }
  }

  async _loadAgents() {
    try {
      this.agents = await api.loadAgents();
    } catch (e) {
      api.log('ERROR', '加载 Agent 列表失败: ' + e.message);
    }
  }

  // ==================== 事件处理 ====================

  async _onConfigSaved(agentId) {
    // 保存配置后刷新 agent 列表和历史
    await this._refreshAgents();
    const chat = this.chats.get(agentId);
    if (chat) {
      // 先重新加载历史（反映可能的系统提示词变更），再添加系统消息
      // 顺序不能反过来，否则 addSystemMessage 添加的消息会被 renderHistory 清空
      await chat.loadHistory();
      chat.addSystemMessage('配置已保存');
    }
  }

  async _onAgentControl(agentId) {
    // 启动/停止 agent 后刷新状态
    await this._refreshAgents();
  }

  _bindGlobalEvents() {
    // 刷新按钮 — 需要通过全局函数桥接 onlick
    window.refreshAgentList = () => this._refreshAgentListWithSpin();
    // iframe 配置页可能调用 window.parent.refreshAgents()
    window.refreshAgents = () => this._refreshAgents();

    // 返回按钮（移动端）
    window.goBackToList = () => {
      if (!isMobileView()) return;
      document.getElementById('mainArea').classList.remove('active-mobile');
      this.sidebarEl.closest('.sidebar').classList.remove('hidden-mobile');
    };

    // 配置面板按钮
    window.openConfig = () => this.openConfig();
    window.closeConfig = () => this.closeConfig();
    window.saveConfig = () => this.saveConfig();
    window.startAgent = () => this.startAgent();
    window.stopAgent = () => this.stopAgent();
    window.clearChatHistory = () => this.clearChatHistory();
    window.clearMemory = () => this.clearMemory();

    // resize 处理
    window.addEventListener('resize', () => {
      if (!isMobileView()) {
        document.getElementById('mainArea').classList.remove('active-mobile');
        this.sidebarEl.closest('.sidebar').classList.remove('hidden-mobile');
      }
    });
  }

  async _refreshAgentListWithSpin() {
    // 旋转动画由 CSS class 触发
    const btn = document.querySelector('.sidebar-header .btn-icon-sm');
    if (btn) { btn.classList.remove('spinning'); void btn.offsetWidth; btn.classList.add('spinning'); }
    await this._refreshAgents();
  }
}

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});