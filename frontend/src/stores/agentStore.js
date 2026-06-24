/**
 * Elf 全局状态管理（Zustand Store）
 *
 * Turn 模型：
 *   turns[]       — 已完成的对话回合
 *   activeTurn    — 当前流式中的回合（null = 空闲）
 *
 * Toast 通知：
 *   toastMessage  — 当前显示的 toast 文本（null = 不显示）
 *   _toastKey     — 递增 key，每次新 toast 触发重新计时
 */
import { create } from 'zustand';
import * as api from '../api/index.js';

const HISTORY_PAGE_SIZE = 30;

/**
 * 从 history.jsonl 消息数组还原为 Turn 数组
 * 用于 loadHistory / loadMoreHistory
 */
function historyToTurns(messages) {
  const turns = [];
  let current = null;
  for (const msg of messages) {
    if (msg.role === 'user') {
      current = { id: msg.id, userMessage: msg, assistantBubbles: [] };
      turns.push(current);
    } else if (msg.role === 'assistant') {
      if (!current) {
        current = { id: `turn_${msg.id}`, userMessage: null, assistantBubbles: [] };
        turns.push(current);
      }
      current.assistantBubbles.push({ ...msg, sealed: true });
    }
    // role === 'system' 的消息静默忽略
  }
  return turns;
}

const useAgentStore = create((set, get) => ({
  // ===== 状态 =====
  agents: [],
  activeAgentId: null,
  chats: new Map(),       // agentId → chat state object
  configDrawerOpen: false,
  configAgentId: null,

  // ===== Toast 通知 =====
  toastMessage: null,
  _toastKey: 0,

  showToast: (message) => set(s => ({
    toastMessage: message,
    _toastKey: s._toastKey + 1,
  })),

  // ===== Agent 列表 =====

  loadAgents: async () => {
    try {
      const agents = await api.loadAgents();
      set({ agents });
    } catch (e) {
      api.log('ERROR', '加载 Agent 列表失败: ' + e.message);
    }
  },

  refreshAgents: async () => {
    try {
      const agents = await api.rediscoverAgents();
      if (agents) {
        set({ agents });
      } else {
        await get().loadAgents();
      }
    } catch (e) {
      await get().loadAgents();
    }
  },

  selectAgent: async (agentId) => {
    const { activeAgentId, chats } = get();
    if (activeAgentId === agentId) return;

    const newChats = new Map(chats);

    // 隐藏当前 chat
    if (activeAgentId) {
      const prevChat = newChats.get(activeAgentId);
      if (prevChat) {
        newChats.set(activeAgentId, { ...prevChat, _isActive: false });
      }
    }

    // 懒创建 chat
    if (!newChats.has(agentId)) {
      newChats.set(agentId, {
        turns: [],
        activeTurn: null,
        hasMore: false,
        historyLoaded: false,
        streaming: false,
        draft: '',
        _isActive: true,
        _savedScrollTop: 0,
      });
    } else {
      newChats.set(agentId, { ...newChats.get(agentId), _isActive: true });
    }

    set({ activeAgentId: agentId, chats: newChats });

    // auto-start: 仅在选择 agent 时触发一次
    const agent = get().agents.find(a => a.agentId === agentId);
    if (agent && agent.status !== 'running') {
      get().showToast(`正在启动 Agent ${agentId}...`);
      try {
        const data = await api.startAgent(agentId);
        get().showToast(`Agent ${agentId} 已启动 (PID: ${data.pid})`);
        await get().refreshAgents();
      } catch (e) {
        get().showToast(`启动失败: ${e.message}`);
        await get().refreshAgents();
      }
    }
  },

  // ===== 内部辅助：更新 chat 对象（产出新引用） =====

  _patchChat: (agentId, updates) => {
    const chats = new Map(get().chats);
    const chat = chats.get(agentId);
    if (!chat) return;
    chats.set(agentId, { ...chat, ...updates });
    set({ chats });
  },

  // ===== 聊天历史 =====

  loadHistory: async (agentId) => {
    const chats = new Map(get().chats);
    const chat = chats.get(agentId);
    if (!chat) return;
    try {
      const data = await api.getHistory(agentId, { limit: HISTORY_PAGE_SIZE });
      const messages = data.messages || [];
      const turns = historyToTurns(messages);
      chats.set(agentId, {
        ...chat,
        turns,
        hasMore: data.hasMore || false,
        historyLoaded: true,
      });
      set({ chats });
    } catch (e) {
      api.log('ERROR', `加载聊天历史失败: ${e.message}`);
    }
  },

  loadMoreHistory: async (agentId) => {
    const chats = new Map(get().chats);
    const chat = chats.get(agentId);
    if (!chat || chat.loadingHistory || !chat.hasMore || chat.turns.length === 0) return;
    chats.set(agentId, { ...chat, loadingHistory: true });
    set({ chats });
    const oldestId = chat.turns[0]?.userMessage?.id || chat.turns[0]?.id;
    try {
      const data = await api.getHistory(agentId, { limit: HISTORY_PAGE_SIZE, before: oldestId });
      const messages = data.messages || [];
      const olderTurns = historyToTurns(messages);
      const chats2 = new Map(get().chats);
      const chat2 = chats2.get(agentId);
      if (chat2) {
        chats2.set(agentId, {
          ...chat2,
          turns: [...olderTurns, ...chat2.turns],
          hasMore: data.hasMore || false,
          loadingHistory: false,
        });
        set({ chats: chats2 });
      }
      return messages.length > 0;
    } catch (e) {
      api.log('ERROR', '加载更多历史失败: ' + e.message);
      get()._patchChat(agentId, { loadingHistory: false });
      return false;
    }
  },

  // ===== 聊天操作 =====

  abortRequest: async (agentId) => {
    try {
      await api.abortAgent(agentId);
      api.log('INFO', `已发送中断信号到 ${agentId}`);
    } catch (e) {
      api.log('ERROR', `中断请求失败: ${e.message}`);
    }
  },

  clearHistory: async (agentId) => {
    try {
      const ok = await api.deleteHistory(agentId);
      if (ok) {
        get()._patchChat(agentId, {
          turns: [],
          activeTurn: null,
          hasMore: false,
          historyLoaded: false,
        });
        get().showToast('聊天记录已清空');
        api.log('INFO', `Agent ${agentId} 聊天记录已清空`);
      }
    } catch (e) {
      get().showToast(`清空失败: ${e.message}`);
    }
  },

  clearMemory: async (agentId) => {
    try {
      const ok = await api.deleteMemory(agentId);
      if (ok) {
        get().showToast('Agent 记忆已清空');
        api.log('INFO', `Agent ${agentId} 记忆已清空`);
      } else {
        get().showToast('清空失败');
      }
    } catch (e) {
      get().showToast(`清空失败: ${e.message}`);
    }
  },

  // ===== 配置面板 =====

  openConfig: (agentId) => {
    set({ configDrawerOpen: true, configAgentId: agentId });
  },

  closeConfig: () => {
    set({ configDrawerOpen: false, configAgentId: null });
  },

  // ===== 通用 chat 字段更新 =====

  updateChatField: (agentId, updates) => {
    const chats = new Map(get().chats);
    const chat = chats.get(agentId);
    if (!chat) return;
    chats.set(agentId, { ...chat, ...updates });
    set({ chats });
  },

  // ===== 辅助 =====

  getAgent: (agentId) => {
    return get().agents.find(a => a.agentId === agentId);
  },
}));

export default useAgentStore;
