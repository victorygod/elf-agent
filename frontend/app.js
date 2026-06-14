/**
 * Elf 前端应用
 * 微信聊天风格界面，每个 Agent 一个选项卡
 */

// ===== 前端日志 =====
function frontendLog(level, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [frontend] ${message}`;
  console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](line);
  // 异步发送到服务端写入 logs/frontend.log
  try {
    fetch(`${API_BASE}/api/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message, timestamp: ts })
    }).catch(() => {}); // 静默失败
  } catch (e) { /* ignore */ }
}

// ===== 工具函数 =====

/** 格式化 ISO 时间为可读时间 */
function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ===== 状态 =====
const API_BASE = '';  // 同源，留空
const HISTORY_PAGE_SIZE = 30;
let agents = [];       // [{agentId, port, status, pid}]
let activeAgentId = null;
let chatHistories = {};  // agentId → [{id, role, content, ts}]
let historyHasMore = {}; // agentId → boolean，是否还有更多历史
let loadingHistory = false; // 上拉加载锁
let streaming = false;

/** 判断是否为移动端窄屏 */
function isMobileView() {
  return window.innerWidth <= 768;
}

/** 进入聊天视图（移动端：隐藏侧边栏，滑入主区域） */
function showChatView() {
  if (!isMobileView()) return;
  document.getElementById('agentList').closest('.sidebar').classList.add('hidden-mobile');
  document.getElementById('mainArea').classList.add('active-mobile');
}

/** 返回 Agent 列表（移动端：滑出主区域，显示侧边栏） */
function goBackToList() {
  if (!isMobileView()) return;
  document.getElementById('mainArea').classList.remove('active-mobile');
  document.getElementById('agentList').closest('.sidebar').classList.remove('hidden-mobile');
}

// ===== 初始化 =====
async function init() {
  frontendLog('INFO', 'Elf 前端初始化');
  await loadAgents();
  renderAgentList();
  // 自动选中第一个 running 的 Agent，或第一个 Agent
  const running = agents.find(a => a.status === 'running');
  const first = agents[0];
  if (running) selectAgent(running.agentId);
  else if (first) selectAgent(first.agentId);
}

// ===== Agent 列表 =====
async function loadAgents() {
  try {
    const res = await fetch(`${API_BASE}/agents`);
    agents = await res.json();
  } catch (e) {
    frontendLog('ERROR', '加载 Agent 列表失败: ' + e.message);
  }
}

function renderAgentList() {
  const list = document.getElementById('agentList');
  list.innerHTML = agents.map(a => `
    <div class="agent-item ${a.agentId === activeAgentId ? 'active' : ''}"
         onclick="selectAgent('${a.agentId}')">
      <div class="agent-avatar">${renderAvatarContent(a.agentId, a.avatar)}</div>
      <div class="agent-info">
        <div class="agent-name">${a.name || a.agentId}</div>
        <div class="agent-status ${a.status}">
          <span class="agent-status-dot"></span>
          ${a.status === 'running' ? '运行中' : a.status === 'error' ? '错误' : '已停止'}
        </div>
      </div>
    </div>
  `).join('');
}

async function selectAgent(agentId) {
  activeAgentId = agentId;

  // 显示顶部栏和输入区
  document.getElementById('topBar').style.display = 'flex';
  document.getElementById('inputArea').style.display = 'block';

  // 移动端：滑入聊天视图
  showChatView();

  const agent = agents.find(a => a.agentId === agentId);
  document.getElementById('topTitle').textContent = agent?.name || agentId;

  // 从服务端加载聊天历史
  chatHistories[agentId] = [];
  historyHasMore[agentId] = false;
  await loadChatHistory(agentId, HISTORY_PAGE_SIZE);
  renderChatHistory();

  // 如果 Agent 未运行，自动启动
  if (agent && agent.status !== 'running') {
    updateControlButtons('stopped'); // 先显示启动按钮
    updateSendButton(false); // 发送按钮禁用
    addSystemMessage(`正在启动 Agent ${agentId}...`);
    await startAgent();
  } else {
    updateControlButtons(agent?.status);
  }

  renderAgentList();

  // 重新绑定滚动事件（上拉加载）
  const chatArea = document.getElementById('chatArea');
  chatArea.onscroll = handleChatScroll;

  scrollToBottom();
}

// ===== 加载聊天历史 =====
async function loadChatHistory(agentId, limit, beforeId) {
  try {
    let url = `${API_BASE}/agents/${agentId}/history?limit=${limit}`;
    if (beforeId) url += `&before=${beforeId}`;

    const res = await fetch(url);
    if (!res.ok) {
      frontendLog('ERROR', `加载聊天历史失败: HTTP ${res.status}`);
      return;
    }

    const data = await res.json();
    const messages = data.messages || [];
    historyHasMore[agentId] = data.hasMore || false;

    if (beforeId) {
      // 上拉加载：插入到现有历史前面
      chatHistories[agentId] = [...messages, ...(chatHistories[agentId] || [])];
    } else {
      // 初次加载：直接设置
      chatHistories[agentId] = messages;
    }
  } catch (e) {
    frontendLog('ERROR', '加载聊天历史失败: ' + e.message);
  }
}

/** 上拉加载更多历史 */
async function loadMoreHistory() {
  if (!activeAgentId || loadingHistory) return;
  if (!historyHasMore[activeAgentId]) return;

  const history = chatHistories[activeAgentId] || [];
  if (history.length === 0) return;

  loadingHistory = true;
  const oldestId = history[0].id;

  // 记录当前滚动位置
  const chatArea = document.getElementById('chatArea');
  const oldScrollHeight = chatArea.scrollHeight;
  const oldScrollTop = chatArea.scrollTop;

  await loadChatHistory(activeAgentId, HISTORY_PAGE_SIZE, oldestId);

  // 渲染并恢复滚动位置
  renderChatHistory();
  const newScrollHeight = chatArea.scrollHeight;
  chatArea.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);

  loadingHistory = false;
}

/** 聊天区域滚动事件处理 */
function handleChatScroll() {
  const chatArea = document.getElementById('chatArea');
  // 滚动到顶部时加载更多
  if (chatArea.scrollTop <= 50) {
    loadMoreHistory();
  }
}

function updateControlButtons(status) {
  const btnStart = document.getElementById('cfgBtnStart');
  const btnStop = document.getElementById('cfgBtnStop');

  if (status === 'running') {
    if (btnStart) btnStart.style.display = 'none';
    if (btnStop) btnStop.style.display = 'inline-block';
  } else {
    if (btnStart) btnStart.style.display = 'inline-block';
    if (btnStop) btnStop.style.display = 'none';
  }

  updateSendButton(status === 'running');
}

function updateSendButton(enabled) {
  document.getElementById('sendBtn').disabled = !enabled || streaming;
}

// ===== Agent 控制 =====
async function startAgent() {
  if (!activeAgentId) return;

  // 显示启动中状态
  updateControlButtons('starting');
  const startBtn = document.getElementById('cfgBtnStart');
  if (startBtn) {
    startBtn.textContent = '启动中...';
    startBtn.disabled = true;
  }

  try {
    const res = await fetch(`${API_BASE}/agents/${activeAgentId}/start`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      addSystemMessage(`Agent ${activeAgentId} 已启动 (PID: ${data.pid})`);
      frontendLog('INFO', `Agent ${activeAgentId} 已启动 (PID: ${data.pid})`);
    } else {
      addSystemMessage(`启动失败: ${data.error}`);
      frontendLog('ERROR', `Agent ${activeAgentId} 启动失败: ${data.error}`);
    }
  } catch (e) {
    addSystemMessage(`启动失败: ${e.message}`);
    frontendLog('ERROR', `Agent ${activeAgentId} 启动失败: ${e.message}`);
  }

  if (startBtn) {
    startBtn.textContent = '启动服务';
    startBtn.disabled = false;
  }
  await refreshAgents();
}

async function stopAgent() {
  if (!activeAgentId) return;
  try {
    const res = await fetch(`${API_BASE}/agents/${activeAgentId}/stop`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      addSystemMessage(`Agent ${activeAgentId} 已停止`);
      frontendLog('INFO', `Agent ${activeAgentId} 已停止`);
    } else {
      addSystemMessage(`停止失败: ${data.error}`);
      frontendLog('ERROR', `Agent ${activeAgentId} 停止失败: ${data.error}`);
    }
  } catch (e) {
    addSystemMessage(`停止失败: ${e.message}`);
    frontendLog('ERROR', `Agent ${activeAgentId} 停止失败: ${e.message}`);
  }
  await refreshAgents();
}

async function refreshAgents() {
  await loadAgents();
  renderAgentList();
  const agent = agents.find(a => a.agentId === activeAgentId);
  updateControlButtons(agent?.status);
}

// ===== 清空数据 =====
async function clearChatHistory() {
  if (!activeAgentId) return;
  if (!confirm('确定要清空聊天记录吗？此操作不可恢复。')) return;

  try {
    const res = await fetch(`${API_BASE}/agents/${activeAgentId}/history`, { method: 'DELETE' });
    if (res.ok) {
      chatHistories[activeAgentId] = [];
      historyHasMore[activeAgentId] = false;
      renderChatHistory();
      addSystemMessage('聊天记录已清空');
      frontendLog('INFO', `Agent ${activeAgentId} 聊天记录已清空`);
    } else {
      const data = await res.json();
      addSystemMessage(`清空失败: ${data.error}`);
      frontendLog('ERROR', `Agent ${activeAgentId} 清空聊天记录失败: ${data.error}`);
    }
  } catch (e) {
    addSystemMessage(`清空失败: ${e.message}`);
    frontendLog('ERROR', `Agent ${activeAgentId} 清空聊天记录失败: ${e.message}`);
  }
}

async function clearMemory() {
  if (!activeAgentId) return;
  if (!confirm('确定要清空 Agent 记忆吗？此操作不可恢复，Agent 将忘记之前的对话内容。')) return;

  try {
    const res = await fetch(`${API_BASE}/agents/${activeAgentId}/memory`, { method: 'DELETE' });
    if (res.ok) {
      addSystemMessage('Agent 记忆已清空');
      frontendLog('INFO', `Agent ${activeAgentId} 记忆已清空`);
    } else {
      const data = await res.json();
      addSystemMessage(`清空失败: ${data.error}`);
      frontendLog('ERROR', `Agent ${activeAgentId} 清空记忆失败: ${data.error}`);
    }
  } catch (e) {
    addSystemMessage(`清空失败: ${e.message}`);
    frontendLog('ERROR', `Agent ${activeAgentId} 清空记忆失败: ${e.message}`);
  }
}

// ===== 聊天 =====
function renderChatHistory() {
  const chatArea = document.getElementById('chatArea');
  const history = chatHistories[activeAgentId] || [];

  const currentAgent = agents.find(a => a.agentId === activeAgentId);
  if (history.length === 0) {
    chatArea.innerHTML = `<div class="empty-state">
      <div class="icon">💬</div>
      <div class="text">开始和 ${currentAgent?.name || activeAgentId} 对话</div>
    </div>`;
    return;
  }

  chatArea.innerHTML = history.map(msg => {
    const timeStr = msg.ts ? formatTime(msg.ts) : '';
    const timeHtml = timeStr ? `<div class="message-time">${timeStr}</div>` : '';
    if (msg.role === 'system') {
      return `<div class="message system" data-msg-id="${msg.id || ''}"><div class="message-bubble">${escapeHtml(msg.content)}</div></div>`;
    }
    const avatar = msg.role === 'user' ? getUserAvatar() : getAgentAvatar();
    return `<div class="message ${msg.role}" data-msg-id="${msg.id || ''}">
      <div class="message-avatar">${avatar}</div>
      <div class="message-body">
        ${timeHtml}
        <div class="message-bubble">${escapeHtml(msg.content)}</div>
      </div>
    </div>`;
  }).join('');

  // 重新绑定滚动事件
  chatArea.onscroll = handleChatScroll;
}

function addMessage(role, content, ts) {
  if (!chatHistories[activeAgentId]) chatHistories[activeAgentId] = [];
  const msg = { role, content, ts: ts || new Date().toISOString() };
  chatHistories[activeAgentId].push(msg);

  const chatArea = document.getElementById('chatArea');
  // 移除空状态
  const empty = chatArea.querySelector('.empty-state');
  if (empty) empty.remove();

  const timeStr = formatTime(msg.ts);
  const timeHtml = `<div class="message-time">${timeStr}</div>`;

  if (role === 'system') {
    chatArea.insertAdjacentHTML('beforeend',
      `<div class="message system"><div class="message-bubble">${escapeHtml(content)}</div></div>`);
  } else {
    const avatar = role === 'user' ? getUserAvatar() : getAgentAvatar();
    chatArea.insertAdjacentHTML('beforeend',
      `<div class="message ${role}">
        <div class="message-avatar">${avatar}</div>
        <div class="message-body">
          ${timeHtml}
          <div class="message-bubble">${escapeHtml(content)}</div>
        </div>
      </div>`);
  }
  scrollToBottom();
}

function addSystemMessage(content) {
  addMessage('system', content);
}

function showTypingIndicator() {
  const chatArea = document.getElementById('chatArea');
  // 移除空状态
  const empty = chatArea.querySelector('.empty-state');
  if (empty) empty.remove();

  chatArea.insertAdjacentHTML('beforeend',
    `<div class="message assistant" id="typingIndicator">
      <div class="message-avatar">${getAgentAvatar()}</div>
      <div class="message-body">
        <div class="message-bubble">
          <div class="typing-indicator"><span></span><span></span><span></span></div>
        </div>
      </div>
    </div>`);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function startAssistantMessage() {
  removeTypingIndicator();
  if (!chatHistories[activeAgentId]) chatHistories[activeAgentId] = [];
  const now = new Date().toISOString();
  chatHistories[activeAgentId].push({ role: 'assistant', content: '', ts: now });

  const chatArea = document.getElementById('chatArea');
  const avatar = getAgentAvatar();
  const timeStr = formatTime(now);
  chatArea.insertAdjacentHTML('beforeend',
    `<div class="message assistant" id="streamingMsg">
      <div class="message-avatar">${avatar}</div>
      <div class="message-body">
        <div class="message-time">${timeStr}</div>
        <div class="message-bubble"></div>
      </div>
    </div>`);
  scrollToBottom();
}

function appendStreamingContent(content) {
  const bubble = document.querySelector('#streamingMsg .message-bubble');
  if (bubble) {
    bubble.textContent += content;
  }
  const history = chatHistories[activeAgentId];
  if (history && history.length > 0 && history[history.length - 1].role === 'assistant') {
    history[history.length - 1].content += content;
  }
  scrollToBottom();
}

function finishStreaming() {
  const el = document.getElementById('streamingMsg');
  if (el) el.removeAttribute('id');
  streaming = false;
  updateSendButton(activeAgentId !== null &&
    agents.find(a => a.agentId === activeAgentId)?.status === 'running');
}

async function sendMessage() {
  if (streaming) return;
  const input = document.getElementById('messageInput');
  const message = input.value.trim();
  if (!message) return;
  if (!activeAgentId) return;

  input.value = '';
  autoResize(input);

  const agent = agents.find(a => a.agentId === activeAgentId);
  if (!agent || agent.status !== 'running') {
    addSystemMessage('Agent 未运行，请先启动');
    return;
  }

  // 显示用户消息
  addMessage('user', message);

  // 显示输入中指示
  streaming = true;
  updateSendButton(false);
  showTypingIndicator();

  frontendLog('INFO', `发送消息到 ${activeAgentId}: ${message.substring(0, 50)}...`);

  try {
    const res = await fetch(`${API_BASE}/agents/${activeAgentId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });

    if (!res.ok) {
      removeTypingIndicator();
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      addSystemMessage(`请求失败: ${err.error || res.statusText}`);
      frontendLog('ERROR', `聊天请求失败: ${err.error || res.statusText}`);
      streaming = false;
      updateSendButton(true);
      return;
    }

    // 处理 SSE 流
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
          const jsonStr = trimmed.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            handleSSEEvent(currentEvent, data);
          } catch (e) {
            // 忽略解析错误
          }
          currentEvent = '';
        } else if (trimmed === '') {
          currentEvent = '';
        }
      }
    }

    // 确保流结束
    if (streaming) finishStreaming();

  } catch (e) {
    removeTypingIndicator();
    addSystemMessage(`连接失败: ${e.message}`);
    frontendLog('ERROR', `聊天连接失败: ${e.message}`);
    streaming = false;
    updateSendButton(true);
  }
}

function handleSSEEvent(event, data) {
  if (event === 'token') {
    if (!document.getElementById('streamingMsg')) {
      startAssistantMessage();
    }
    appendStreamingContent(data.content);
  } else if (event === 'status') {
    // 状态事件，保持 typing indicator
  } else if (event === 'done') {
    finishStreaming();
  } else if (event === 'error') {
    removeTypingIndicator();
    addSystemMessage(`错误: ${data.message}`);
    frontendLog('ERROR', `SSE 错误: ${data.message}`);
    finishStreaming();
  }
}

function scrollToBottom() {
  const chatArea = document.getElementById('chatArea');
  chatArea.scrollTop = chatArea.scrollHeight;
}

function handleKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
}

// 自动调整 textarea 高度
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ===== 配置面板 =====
async function openConfig() {
  if (!activeAgentId) return;

  // 加载配置表单到 iframe（头像上传已内嵌在 iframe 的 Agent 选项卡中）
  const frame = document.getElementById('configFormFrame');
  frame.src = `${API_BASE}/agents/${activeAgentId}/config-ui`;

  document.getElementById('configOverlay').classList.add('open');
  document.getElementById('configPanel').classList.add('open');
}

function closeConfig() {
  document.getElementById('configOverlay').classList.remove('open');
  document.getElementById('configPanel').classList.remove('open');
  // 清空 iframe
  document.getElementById('configFormFrame').src = '';
}

/**
 * 从 iframe 中收集配置表单数据
 * 遍历 [data-key] 元素，构造 update 对象
 *
 * 模型选项卡中的字段（base_url, auth_token, model）收集到 update.model
 * Agent 选项卡中的字段收集到 update 顶层
 */
function collectConfigFromFrame() {
  const frame = document.getElementById('configFormFrame');
  const update = {};
  try {
    const doc = frame.contentDocument || frame.contentWindow.document;

    // 获取当前配置（用于 model 深度合并）
    let currentConfig = null;
    // 同步 XMLHttpRequest 获取当前配置
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${API_BASE}/agents/${activeAgentId}/config`, false);
    xhr.send();
    if (xhr.status === 200) currentConfig = JSON.parse(xhr.responseText);

    // 模型配置字段集合（对应 api_key.json 中的字段）
    const MODEL_KEYS = new Set(['base_url', 'auth_token', 'model']);

    // 遍历所有带 data-key 的元素
    const elements = doc.querySelectorAll('[data-key]');
    let modelChanged = false;
    const modelUpdate = {};

    for (const el of elements) {
      const key = el.getAttribute('data-key');
      let value;

      if (el.type === 'checkbox') {
        value = el.checked;
      } else if (el.type === 'number') {
        value = el.value !== '' ? Number(el.value) : undefined;
      } else {
        value = el.value;
      }

      if (value === undefined || value === '') continue;

      // systemPrompt 特殊处理：写入文件
      if (key === 'systemPrompt') {
        update.systemPrompt = value;
        continue;
      }

      // 模型配置字段（对应 api_key.json）
      if (MODEL_KEYS.has(key)) {
        modelUpdate[key] = value;
        modelChanged = true;
        continue;
      }

      // model.* 前缀字段（兼容旧版 UI）
      if (key.startsWith('model.')) {
        const modelKey = key.slice(6);
        modelUpdate[modelKey] = value;
        modelChanged = true;
        continue;
      }

      // Agent 配置顶层字段
      update[key] = value;
    }

    // 合并 model
    if (modelChanged && currentConfig && currentConfig.model) {
      update.model = { ...currentConfig.model, ...modelUpdate };
    } else if (modelChanged) {
      update.model = modelUpdate;
    }
  } catch (e) {
    frontendLog('ERROR', '收集配置数据失败: ' + e.message);
  }
  return update;
}

async function saveConfig() {
  if (!activeAgentId) return;

  const update = collectConfigFromFrame();
  if (Object.keys(update).length === 0) {
    closeConfig();
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/agents/${activeAgentId}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update)
    });

    if (res.ok) {
      addSystemMessage('配置已保存');
      frontendLog('INFO', '配置已保存');
      closeConfig();
      await refreshAgents();
      renderChatHistory();
    } else {
      const err = await res.json();
      alert('保存失败: ' + (err.error || res.statusText));
      frontendLog('ERROR', '配置保存失败: ' + (err.error || res.statusText));
    }
  } catch (e) {
    alert('保存失败: ' + e.message);
    frontendLog('ERROR', '配置保存失败: ' + e.message);
  }
}

// ===== 工具函数 =====
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** 获取当前 Agent 的头像，没有则用首字母 */
function getAgentAvatar() {
  const agent = agents.find(a => a.agentId === activeAgentId);
  if (agent?.avatar) {
    return `<img src="/agents/${activeAgentId}/config/${agent.avatar}" alt="${activeAgentId}">`;
  }
  const displayName = agent?.name || activeAgentId;
  return `<span class="avatar-default">${displayName.charAt(0).toUpperCase()}</span>`;
}

/** 获取当前 Agent 的用户头像 */
function getUserAvatar() {
  const agent = agents.find(a => a.agentId === activeAgentId);
  if (agent?.userAvatar) {
    return `<img src="/agents/${activeAgentId}/config/${agent.userAvatar}" alt="我">`;
  }
  return '<span class="avatar-default">👤</span>';
}

/** 渲染头像内容（侧栏用）*/
function renderAvatarContent(agentId, avatar) {
  const agent = agents.find(a => a.agentId === agentId);
  if (avatar) {
    return `<img src="/agents/${agentId}/config/${avatar}" alt="${agentId}">`;
  }
  const displayName = agent?.name || agentId;
  return `<span class="avatar-default">${displayName.charAt(0).toUpperCase()}</span>`;
}

// ===== 手动刷新 Agent 状态 =====
async function refreshAgentList() {
  // 旋转动画反馈
  const btn = event?.currentTarget;
  if (btn) {
    btn.classList.remove('spinning');
    // 强制 reflow 以重新触发动画
    void btn.offsetWidth;
    btn.classList.add('spinning');
  }
  await loadAgents();
  renderAgentList();
  const agent = agents.find(a => a.agentId === activeAgentId);
  if (agent) updateControlButtons(agent.status);
}

// ===== 头像上传 =====

/** 更新头像预览 */
function updateAvatarPreview(elementId, agentId, avatarPath) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (avatarPath) {
    el.classList.add('has-avatar');
    el.innerHTML = `<img src="/agents/${agentId}/config/${avatarPath}?t=${Date.now()}" alt="头像">`;
  } else {
    el.classList.remove('has-avatar');
    const isUser = elementId.includes('User');
    el.innerHTML = `<span class="placeholder">${isUser ? '点击<br>上传' : '点击<br>上传'}</span>`;
  }
}

/** 处理头像文件选择 */
async function handleAvatarUpload(input, field) {
  const file = input.files?.[0];
  if (!file || !activeAgentId) return;

  // 文件大小限制 2MB
  if (file.size > 2 * 1024 * 1024) {
    alert('图片大小不能超过 2MB');
    return;
  }

  // 转 base64
  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target.result;
    try {
      const res = await fetch(`${API_BASE}/agents/${activeAgentId}/${field}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: base64, type: file.type })
      });
      if (res.ok) {
        const data = await res.json();
        frontendLog('INFO', `头像上传成功: ${data.path}`);
        // 刷新预览
        const previewId = field === 'avatar' ? 'cfgAvatarPreview' : 'cfgUserAvatarPreview';
        const filename = data.path?.split('/').pop();
        if (filename) {
          updateAvatarPreview(previewId, activeAgentId, filename);
        }
        // 刷新 agent 列表
        await refreshAgents();
        renderChatHistory();
      } else {
        const err = await res.json();
        alert('上传失败: ' + (err.error || res.statusText));
      }
    } catch (e) {
      alert('上传失败: ' + e.message);
    }
  };
  reader.readAsDataURL(file);
}

// ===== DOMContentLoaded =====
document.addEventListener('DOMContentLoaded', () => {
  const textarea = document.getElementById('messageInput');
  textarea.addEventListener('input', () => autoResize(textarea));
  autoResize(textarea);
  init();

  // 触屏点击气泡切换时间显示
  const chatArea = document.getElementById('chatArea');
  chatArea.addEventListener('click', (e) => {
    const bubble = e.target.closest('.message-bubble');
    if (!bubble) return;
    const body = bubble.closest('.message-body');
    if (!body) return;
    body.classList.toggle('show-time');
  });

  // 窗口尺寸变化时重置移动端状态
  window.addEventListener('resize', () => {
    if (!isMobileView()) {
      // 桌面端：移除移动端 class，恢复并排布局
      document.getElementById('mainArea').classList.remove('active-mobile');
      document.getElementById('agentList').closest('.sidebar').classList.remove('hidden-mobile');
    }
  });
});