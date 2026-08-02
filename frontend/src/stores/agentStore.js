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

  // ===== Toast 通知（多条竖排，各自独立计时） =====
  // toasts: [{ id, fields }] —— fields 为 string 或 notice 字段对象。
  toastList: [],
  toastMessage: null,   // 兼容旧引用（仅最后一条的字符串镜像）
  _toastKey: 0,

  showToast: (fields) => set(s => {
    const id = s._toastKey + 1;
    const next = [...s.toastList, { id, fields }];
    return {
      toastList: next,
      toastMessage: typeof fields === 'string' ? fields : (fields?.text || null),
      _toastKey: id,
    };
  }),

  removeToast: (id) => set(s => ({ toastList: s.toastList.filter(t => t.id !== id) })),

  clearToast: () => set({ toastList: [] }),

  // ===== Agent 列表 =====

  // 头像缓存破坏计数器：每次 refreshAgents 递增，附加到头像 URL 防止浏览器缓存旧图
  _avatarBuster: 0,

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
        // 不在此 bump _avatarBuster：autosave/start/stop 刷列表时不应触发全量头像重拉。
        // 头像 cache-buster 仅由 bustAvatars() 在真正上传头像时递增。
        set({ agents });
      } else {
        await get().loadAgents();
      }
    } catch (e) {
      await get().loadAgents();
    }
  },

  // 头像 cache-buster：仅在 agent 头像上传(ConfigField)/用户头像保存(Sidebar)成功后调用，
  // 强制浏览器重拉新图（头像文件名固定 avatar.webp/user_avatar.webp，覆盖写须靠 ?v= 破缓存）。
  bustAvatars: () => set({ _avatarBuster: Date.now() }),

  selectAgent: async (agentId) => {
    const { activeAgentId, chats } = get();
    if (activeAgentId === agentId) return;

    // 同步到 URL hash,刷新页面后能保留在当前 agent
    if (typeof window !== 'undefined' && window.location.hash.replace(/^#\/?/, '') !== agentId) {
      window.location.hash = agentId;
    }

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
      // 重新激活已存在的 chat：常驻 SSE subscribe 在场期间持续更新 store，切 tab 不丢异步事件，
      //   切回无需重建。仅标 _isActive（historyLoaded 已由 SSE snapshot 置位；未 running 的由 ChatPanel init force 兜底）。
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
    const defaults = { streaming: false, activeTurn: null, turns: [], historyLoaded: false, hasMore: false };
    // SSE subscribe 可能在 ChatPanel mount 前就收到 snapshot——chat 不存在时懒创建，防止事件被丢弃。
    chats.set(agentId, chat ? { ...chat, ...updates } : { ...defaults, ...updates });
    set({ chats });
  },

  // ===== 聊天历史 =====

  loadHistory: async (agentId, { force = false } = {}) => {
    // 初始历史由 SSE snapshot 提供（single source）。本方法仅 rewind 后 force 重建用。
    if (!force) return;
    const chats = new Map(get().chats);
    const chat = chats.get(agentId);
    if (!chat) return;
    api.log('INFO', `[loadHistory] agent=${agentId} force 重建（rewind）`);
    try {
      const data = await api.getHistory(agentId, { limit: HISTORY_PAGE_SIZE });
      const messages = data.messages || [];
      const turns = historyToTurns(messages);
      api.log('INFO', `[loadHistory] agent=${agentId} REST 返回 ${messages.length} 条，降为 ${turns.length} turns`);
      chats.set(agentId, {
        ...chat,
        turns,
        activeTurn: null,
        hasMore: data.hasMore || false,
        historyLoaded: true,
        loadingHistory: false,
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
    // 游标取当前最旧 turn 内的真实消息 id（jsonl 里存在的 id）。
    // turns[0].id 可能是 historyToTurns 给孤儿 assistant 造的合成前缀 "turn_…",
    // 不能直接用,否则后端 findIndex 返回 -1。优先取真实 userMessage.id,
    // 兜底取该 turn 第一条 assistant 气泡的 id。
    const oldestTurn = chat.turns[0];
    const oldestId = oldestTurn?.userMessage?.id
      || oldestTurn?.assistantBubbles?.[0]?.id
      || oldestTurn?.id;
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

  clearHistory: async (agentId, { silent } = {}) => {
    try {
      const ok = await api.deleteHistory(agentId);
      if (ok) {
        get()._patchChat(agentId, {
          turns: [],
          activeTurn: null,
          hasMore: false,
          historyLoaded: false,
        });
        if (!silent) get().showToast('聊天记录已清空');
        api.log('INFO', `Agent ${agentId} 聊天记录已清空`);
      }
    } catch (e) {
      if (!silent) get().showToast(`清空失败: ${e.message}`);
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
