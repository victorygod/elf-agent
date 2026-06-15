/**
 * AgentChat — 每个 Agent 拥有独立的聊天实例
 * 管理：消息列表 DOM、输入框、流式状态、历史轮询、滚动位置
 */

import { cloneTemplate, formatTime, escapeHtml, renderAvatar, renderToolCalls } from './utils.js';
import { HISTORY_PAGE_SIZE, chat as apiChat, getHistory, getAgent, startAgent as apiStartAgent, abortAgent, deleteHistory as apiDeleteHistory, log } from './api.js';

export class AgentChat {
  /**
   * @param {string} agentId
   * @param {function} getAgents - 返回最新 agent 列表的回调 () => Array
   * @param {HTMLElement} container - #chatArea 容器
   * @param {object} callbacks - 回调函数
   * @param {function} callbacks.onRefreshAgents - 需要刷新 agent 列表时调用
   * @param {function} callbacks.onRequestConfig - 请求打开配置面板
   */
  constructor(agentId, getAgents, container, callbacks = {}) {
    this.agentId = agentId;
    this._getAgents = getAgents; // 通过回调获取最新 agent 列表，避免引用过期
    this.container = container;
    this.callbacks = callbacks;

    // per-instance 状态
    this.history = [];
    this.hasMore = false;
    this.loadingHistory = false;
    this.streaming = false;
    this.pendingMessages = [];
    this.pollingTimer = null;
    this.abortController = null;
    this.draft = '';
    this._savedScrollTop = 0;
    this._historyLoaded = false; // 是否已加载过历史

    // 创建 per-instance DOM
    this.el = this._createDOM();
    this.messagesEl = this.el.querySelector('.chat-messages');
    this.inputEl = this.el.querySelector('.message-input');
    this.sendBtn = this.el.querySelector('.send-btn');
    this.stopBtn = this.el.querySelector('.stop-btn');
    this.emptyEl = null; // 懒创建

    this._bindEvents();
    this.container.appendChild(this.el);
  }

  // ==================== 公共 API ====================

  /** 显示此 Agent 的聊天区（纯 DOM 切换，不触发数据加载） */
  show() {
    this.el.classList.remove('agent-hidden');
    this._restoreDraft();
    this._updateInputButtons();
  }

  /** 隐藏此 Agent 的聊天区 */
  hide() {
    this._saveDraft();
    this._saveScroll();
    this.el.classList.add('agent-hidden');
  }

  /** 加载聊天历史（首次或强制刷新） */
  async loadHistory(pageSize = HISTORY_PAGE_SIZE) {
    try {
      const data = await getHistory(this.agentId, { limit: pageSize });
      this.history = data.messages || [];
      this.hasMore = data.hasMore || false;
      this._historyLoaded = true;
      this.renderHistory();
      this._scrollToBottom();
    } catch (e) {
      log('ERROR', `加载聊天历史失败: ${e.message}`);
    }
  }

  /** 加载更多历史（向上翻页） */
  async loadMoreHistory() {
    if (this.loadingHistory || !this.hasMore) return;
    if (this.history.length === 0) return;
    this.loadingHistory = true;
    const oldestId = this.history[0].id;
    const oldScrollHeight = this.messagesEl.scrollHeight;
    const oldScrollTop = this.messagesEl.scrollTop;
    try {
      const data = await getHistory(this.agentId, { limit: HISTORY_PAGE_SIZE, before: oldestId });
      const messages = data.messages || [];
      this.hasMore = data.hasMore || false;
      this.history = [...messages, ...this.history];
      this.renderHistory();
      const newScrollHeight = this.messagesEl.scrollHeight;
      this.messagesEl.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
    } catch (e) {
      log('ERROR', '加载更多历史失败: ' + e.message);
    }
    this.loadingHistory = false;
  }

  /** 全量渲染聊天历史 */
  renderHistory() {
    const history = this.history;
    this.messagesEl.innerHTML = '';

    if (history.length === 0) {
      const frag = cloneTemplate('tmplEmptyState');
      const textEl = frag.querySelector('.empty-state .text');
      const agent = this._getAgent();
      if (textEl) textEl.textContent = `开始和 ${agent?.name || this.agentId} 对话`;
      this.messagesEl.appendChild(frag);
      if (this.streaming) this._showTypingIndicator();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < history.length; i++) {
      fragment.appendChild(this._renderMessage(history[i], i));
    }
    this.messagesEl.appendChild(fragment);
    this.messagesEl.onscroll = () => this._handleScroll();

    // 流式回复中：恢复 streaming UI
    if (this.streaming) {
      const lastMsg = history[history.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content) {
        const existingMsgs = this.messagesEl.querySelectorAll('.message.assistant');
        const lastEl = existingMsgs[existingMsgs.length - 1];
        if (lastEl && !this.messagesEl.querySelector('#streamingMsg')) lastEl.id = 'streamingMsg';
      } else {
        if (!this.messagesEl.querySelector('#typingIndicator')) this._showTypingIndicator();
      }
    }
  }

  /** 添加一条消息到当前聊天 */
  addMessage(role, content, ts) {
    const msg = { role, content, ts: ts || new Date().toISOString() };
    this.history.push(msg);
    const empty = this.messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();
    this.messagesEl.appendChild(this._renderMessage(msg, -1));
    this._scrollToBottom();
  }

  /** 添加系统消息 */
  addSystemMessage(content) {
    this.addMessage('system', content);
  }

  /** 发送消息 */
  async sendMessage() {
    const message = this.inputEl.value.trim();
    if (!message) return;
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.draft = '';

    const agent = this._getAgent();
    if (!agent || agent.status !== 'running') {
      this.addSystemMessage('Agent 未运行，请先启动');
      return;
    }
    this.addMessage('user', message);
    if (this.streaming) {
      this.pendingMessages.push(message);
      return;
    }
    await this._doSend(message);
  }

  /** 中止当前生成 */
  async abortRequest() {
    if (!this.streaming) return;
    try {
      await abortAgent(this.agentId);
      log('INFO', `已发送中断信号到 ${this.agentId}`);
    } catch (e) {
      log('ERROR', `中断请求失败: ${e.message}`);
    }
  }

  /** 启动 Agent */
  async startAgent() {
    this._setControlButtons('starting');
    try {
      const data = await apiStartAgent(this.agentId);
      if (data && data.pid) {
        this.addSystemMessage(`Agent ${this.agentId} 已启动 (PID: ${data.pid})`);
        log('INFO', `Agent ${this.agentId} 已启动 (PID: ${data.pid})`);
      } else {
        this.addSystemMessage(`启动失败: ${data?.error || '未知错误'}`);
        log('ERROR', `Agent ${this.agentId} 启动失败: ${data?.error || '未知错误'}`);
      }
    } catch (e) {
      this.addSystemMessage(`启动失败: ${e.message}`);
      log('ERROR', `Agent ${this.agentId} 启动失败: ${e.message}`);
    }
    this.callbacks.onRefreshAgents?.();
  }

  /** 清空聊天记录 */
  async clearChatHistory() {
    if (!confirm('确定要清空聊天记录吗？此操作不可恢复。')) return;
    try {
      const ok = await apiDeleteHistory(this.agentId);
      if (ok) {
        this.history = [];
        this.hasMore = false;
        this.renderHistory();
        this.addSystemMessage('聊天记录已清空');
        log('INFO', `Agent ${this.agentId} 聊天记录已清空`);
      } else {
        this.addSystemMessage('清空失败');
      }
    } catch (e) {
      this.addSystemMessage(`清空失败: ${e.message}`);
      log('ERROR', `Agent ${this.agentId} 清空聊天记录失败: ${e.message}`);
    }
  }

  /** 更新控制按钮状态 */
  updateControlButtons(status) {
    this._setControlButtons(status);
  }

  /** 销毁实例 */
  destroy() {
    this.stopHistoryPolling();
    this.abortController?.abort();
    this.el.remove();
  }

  // ==================== 流式消息 ====================

  _showTypingIndicator() {
    const empty = this.messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();
    const frag = cloneTemplate('tmplTypingIndicator');
    frag.querySelector('.message-avatar').innerHTML = this._getAgentAvatar();
    this.messagesEl.appendChild(frag);
    this._scrollToBottom();
  }

  _removeTypingIndicator() {
    const el = this.messagesEl.querySelector('#typingIndicator');
    if (el) el.remove();
  }

  _startAssistantMessage() {
    this._removeTypingIndicator();
    const now = new Date().toISOString();
    this.history.push({ role: 'assistant', content: '', ts: now });
    const frag = cloneTemplate('tmplStreamingMsg');
    frag.querySelector('.message-avatar').innerHTML = this._getAgentAvatar();
    frag.querySelector('.message-time').textContent = formatTime(now);
    this.messagesEl.appendChild(frag);
    this._scrollToBottom();
  }

  _appendStreamingContent(content) {
    const bubble = this.messagesEl.querySelector('#streamingMsg .message-bubble');
    if (bubble) {
      const toolCallBadges = bubble.querySelectorAll('.tool-call-badge');
      if (toolCallBadges.length > 0) {
        const lastBadge = toolCallBadges[toolCallBadges.length - 1];
        let textNode = lastBadge.nextSibling;
        if (textNode && textNode.nodeType === Node.TEXT_NODE) {
          textNode.textContent += content;
        } else {
          let textSpan = bubble.querySelector('.streaming-text');
          if (!textSpan) {
            textSpan = document.createElement('span');
            textSpan.className = 'streaming-text';
            bubble.appendChild(textSpan);
          }
          textSpan.textContent += content;
        }
      } else {
        bubble.textContent += content;
      }
    }
    const history = this.history;
    if (history.length > 0 && history[history.length - 1].role === 'assistant') {
      history[history.length - 1].content += content;
    }
    this._scrollToBottom();
  }

  _appendStreamingToolCall(toolCalls) {
    const bubble = this.messagesEl.querySelector('#streamingMsg .message-bubble');
    if (!bubble) return;
    const html = renderToolCalls(toolCalls);
    if (html) bubble.insertAdjacentHTML('beforeend', html);
    const history = this.history;
    if (history.length > 0 && history[history.length - 1].role === 'assistant') {
      const lastMsg = history[history.length - 1];
      if (!lastMsg.toolCalls) lastMsg.toolCalls = [];
      lastMsg.toolCalls.push(...toolCalls);
    }
    this._scrollToBottom();
  }

  _showCompactStart() {
    // 只更新 DOM 提示，不写入 history（压缩是 agent 内部记忆行为，与聊天内容无关）
    const streamingBubble = this.messagesEl.querySelector('#streamingMsg .message-bubble');
    if (streamingBubble) {
      if (!streamingBubble.querySelector('#compactBadge')) {
        streamingBubble.insertAdjacentHTML('beforeend',
          '<div class="compact-badge compact-loading" id="compactBadge">压缩中...</div>');
      }
    } else {
      const existing = this.messagesEl.querySelector('.compact-badge');
      if (!existing) {
        const frag = cloneTemplate('tmplCompactLoading');
        this.messagesEl.appendChild(frag);
      }
    }
    this._scrollToBottom();
  }

  _updateCompactSuccess(summary) {
    // 只更新 DOM 提示，不写入 history
    const badge = this.messagesEl.querySelector('#compactBadge') || this.messagesEl.querySelector('.compact-badge.compact-loading');
    if (badge) {
      const tokenInfo = summary ? ` (≈${summary} tokens)` : '';
      badge.className = 'compact-badge compact-success';
      badge.innerHTML = `记忆已压缩${tokenInfo}`;
      badge.removeAttribute('id');
    }
  }

  _updateCompactError(error) {
    // 只更新 DOM 提示，不写入 history
    const badge = this.messagesEl.querySelector('#compactBadge') || this.messagesEl.querySelector('.compact-badge.compact-loading');
    if (badge) {
      badge.className = 'compact-badge compact-error';
      badge.textContent = '记忆压缩失败';
      badge.removeAttribute('id');
    }
  }

  _finishStreaming() {
    const el = this.messagesEl.querySelector('#streamingMsg');
    if (el) el.removeAttribute('id');
    this.streaming = false;
    this._updateInputButtons();

    const compactBadge = this.messagesEl.querySelector('#compactBadge');
    if (compactBadge) this._updateCompactError();
  }

  // ==================== SSE ====================

  async _doSend(message) {
    this.streaming = true;
    this.abortController = new AbortController();
    this.stopHistoryPolling();
    this._showTypingIndicator();
    this._updateInputButtons();
    log('INFO', `发送消息到 ${this.agentId}: ${message.substring(0, 50)}...`);

    try {
      await apiChat(this.agentId, message, {
        onEvent: (event, data) => this._handleSSEEvent(event, data),
        signal: this.abortController.signal
      });
      if (this.streaming) this._finishStreaming();
    } catch (e) {
      if (e.name === 'AbortError') {
        // 用户主动中止，不报错
        this._removeTypingIndicator();
        this.streaming = false;
        this._updateInputButtons();
        return;
      }
      this._removeTypingIndicator();
      if (e.status) {
        this.addSystemMessage(`请求失败: ${e.message}`);
        log('ERROR', `聊天请求失败: ${e.message}`);
      } else {
        this.addSystemMessage(`连接失败: ${e.message}`);
        log('ERROR', `聊天连接失败: ${e.message}`);
      }
      this.streaming = false;
      this._updateInputButtons();
    }

    // 必须在流完全结束后再处理排队消息，避免流式状态交错
    if (this.pendingMessages.length > 0) {
      const merged = this.pendingMessages.join('\n');
      this.pendingMessages = [];
      await this._doSend(merged);
    }
  }

  _handleSSEEvent(event, data) {
    if (event === 'token') {
      if (!this.messagesEl.querySelector('#streamingMsg')) this._startAssistantMessage();
      this._appendStreamingContent(data.content);
    } else if (event === 'tool_call') {
      if (!this.messagesEl.querySelector('#streamingMsg')) this._startAssistantMessage();
      if (data.tool_calls && Array.isArray(data.tool_calls)) this._appendStreamingToolCall(data.tool_calls);
    } else if (event === 'status') {
      // keep typing indicator
    } else if (event === 'compact_start') {
      this._showCompactStart();
    } else if (event === 'compact') {
      this._updateCompactSuccess(data.summary || '上下文已自动压缩');
    } else if (event === 'compact_error') {
      this._updateCompactError(data.error || '记忆压缩失败');
    } else if (event === 'done') {
      this._finishStreaming();
    } else if (event === 'aborted') {
      this._removeTypingIndicator();
      this.addSystemMessage('已停止生成');
      this._finishStreaming();
    } else if (event === 'error') {
      this._removeTypingIndicator();
      this.addSystemMessage(`错误: ${data.message}`);
      log('ERROR', `SSE 错误: ${data.message}`);
      this._finishStreaming();
    }
  }

  // ==================== History Polling ====================

  startHistoryPolling() {
    this.stopHistoryPolling();
    this.streaming = true;
    this._updateInputButtons();

    const lastMsg = this.history.slice().pop();
    if (lastMsg && lastMsg.role === 'assistant') {
      const existingMsgs = this.messagesEl.querySelectorAll('.message.assistant');
      const lastEl = existingMsgs[existingMsgs.length - 1];
      if (lastEl && !this.messagesEl.querySelector('#streamingMsg')) lastEl.id = 'streamingMsg';
    } else {
      this._showTypingIndicator();
    }

    log('INFO', `Agent ${this.agentId} 正在回复中，启动 history 轮询`);
    let lastKnownMessageCount = this.history.length;

    this.pollingTimer = setInterval(async () => {
      try {
        const agentInfo = await getAgent(this.agentId);
        if (!agentInfo) return;
        const stillStreaming = agentInfo.streaming === true;

        const data = await getHistory(this.agentId, { limit: HISTORY_PAGE_SIZE });
        const messages = data.messages || [];
        this.hasMore = data.hasMore || false;

        if (messages.length !== lastKnownMessageCount) {
          lastKnownMessageCount = messages.length;
          this.history = messages;
          this.renderHistory();
          this._scrollToBottom();
        }

        if (!stillStreaming) {
          log('INFO', `Agent ${this.agentId} 回复完成，停止 history 轮询`);
          this.stopHistoryPolling();
          this._finishStreaming();
          // 最终一次刷新完整历史
          const finalData = await getHistory(this.agentId, { limit: HISTORY_PAGE_SIZE });
          this.history = finalData.messages || [];
          this.hasMore = finalData.hasMore || false;
          this.renderHistory();
          this._scrollToBottom();

          // 轮询期间用户可能发了消息（streaming=true 导致消息排队）
          if (this.pendingMessages.length > 0) {
            const merged = this.pendingMessages.join('\n');
            this.pendingMessages = [];
            await this._doSend(merged);
          }
        }
      } catch (e) {
        log('ERROR', 'History 轮询失败: ' + e.message);
      }
    }, 1500);
  }

  stopHistoryPolling() {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  // ==================== 渲染辅助 ====================

  _renderMessage(msg, index) {
    const timeStr = msg.ts ? formatTime(msg.ts) : '';

    if (msg.role === 'system') {
      const frag = cloneTemplate('tmplMsgSystem');
      const el = frag.querySelector('.message');
      if (msg.id) el.setAttribute('data-msg-id', msg.id);
      frag.querySelector('.message-bubble').textContent = msg.content;
      return frag;
    }

    const templateId = msg.role === 'user' ? 'tmplMsgUser' : 'tmplMsgAssistant';
    const frag = cloneTemplate(templateId);
    const el = frag.querySelector('.message');
    if (msg.id) el.setAttribute('data-msg-id', msg.id);

    frag.querySelector('.message-avatar').innerHTML = msg.role === 'user' ? this._getUserAvatar() : this._getAgentAvatar();
    if (timeStr) frag.querySelector('.message-time').textContent = timeStr;

    const bubble = frag.querySelector('.message-bubble');
    const toolCallsHtml = renderToolCalls(msg.toolCalls);
    const textContent = escapeHtml(msg.content || '');
    bubble.innerHTML = (toolCallsHtml + textContent).trim();

    return frag;
  }

  _getAgent() {
    const agents = this._getAgents();
    return agents.find(a => a.agentId === this.agentId);
  }

  _getAgentAvatar() {
    const agent = this._getAgent();
    const displayName = agent?.name || this.agentId;
    return renderAvatar(this.agentId, agent?.avatar, displayName.charAt(0).toUpperCase());
  }

  _getUserAvatar() {
    const agent = this._getAgent();
    return renderAvatar(this.agentId, agent?.userAvatar, 'U');
  }

  // ==================== 输入控制 ====================

  _updateInputButtons() {
    if (this.streaming) {
      this.sendBtn.classList.add('hidden');
      this.stopBtn.classList.remove('hidden');
    } else {
      this.sendBtn.classList.remove('hidden');
      this.stopBtn.classList.add('hidden');
    }
    const agent = this._getAgent();
    this.sendBtn.disabled = !(agent && agent.status === 'running');
  }

  _setControlButtons(status) {
    // 更新配置面板的按钮（由外部 App 控制，此处仅更新输入区按钮）
    this._updateInputButtons();
  }

  // ==================== 滚动与草稿 ====================

  _scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  _handleScroll() {
    if (this.messagesEl.scrollTop <= 50) this.loadMoreHistory();
  }

  _saveDraft() {
    this.draft = this.inputEl.value;
  }

  _restoreDraft() {
    this.inputEl.value = this.draft;
    this.inputEl.style.height = 'auto';
    if (this.draft) {
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    }
  }

  _saveScroll() {
    this._savedScrollTop = this.messagesEl.scrollTop;
  }

  restoreScroll() {
    // 仅在之前已加载过历史时恢复滚动位置；首次加载应滚到底部（由 loadHistory 处理）
    if (!this._historyLoaded) return;
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this._savedScrollTop;
    });
  }

  /** 清空本地历史（配置面板保存后或清除聊天后调用） */
  clearLocalHistory() {
    this.history = [];
    this.hasMore = false;
    this._historyLoaded = false;
    this.renderHistory();
  }

  // ==================== DOM 创建 ====================

  _createDOM() {
    const div = document.createElement('div');
    div.className = 'agent-chat agent-hidden';
    div.dataset.agentId = this.agentId;
    div.innerHTML = `
      <div class="chat-messages"></div>
      <div class="input-area">
        <div class="input-wrapper">
          <textarea class="message-input" placeholder="输入消息..." rows="1"></textarea>
          <button class="stop-btn hidden" title="停止生成">■</button>
          <button class="send-btn" title="发送"></button>
        </div>
      </div>
    `;
    return div;
  }

  _bindEvents() {
    // 输入框自动调整高度
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    });

    // Enter 发送
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // 发送按钮
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    // 停止按钮
    this.stopBtn.addEventListener('click', () => this.abortRequest());

    // 点击气泡切换时间显示
    this.messagesEl.addEventListener('click', (e) => {
      const bubble = e.target.closest('.message-bubble');
      if (!bubble) return;
      const body = bubble.closest('.message-body');
      if (!body) return;
      body.classList.toggle('show-time');
    });
  }
}