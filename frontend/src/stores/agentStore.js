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
 *
 * 多用户：chats 用复合 key（<uid>:<agentId>，见 authStore.chatKey）——换用户后同一
 * agentId 不会命中旧用户数据；登录态变化（login/logout/换号）时由 App 调 reset() 清空。
 */
import { create } from 'zustand';
import * as api from '../api/index.js';
import { chatKey } from './authStore.js';

const HISTORY_PAGE_SIZE = 30;

const initialState = {
  agents: [],
  activeAgentId: null,
  chats: new Map(),       // chatKey(agentId) → chat state object
  configDrawerOpen: false,
  configAgentId: null,

  // ===== Toast 通知 =====
  toastList: [],
  toastMessage: null,
  _toastKey: 0,

  // 头像缓存破坏计数器
  _avatarBuster: 0,
};

/**
 * 从 history.jsonl 消息数组还原为 Turn 数组
 * 用于 loadHistory / loadMoreHistory
 */
function historyToTurns(messages) {
  const turns = [];
  let current = null;
  for (const msg of messages) {
    if (msg.role === 'user') {
      // turn.id 对齐后端 messagesToTurns(`turn_${msg.id}`),保证 loadHistory(REST)与
      //   snapshot(SSE)的 turn 关键 id 一致——snapshot merge 按此去重,否则会翻倍。
      current = { id: `turn_${msg.id}`, userMessage: msg, assistantBubbles: [] };
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
  ...initialState,

  // ===== Toast 通知（多条竖排，各自独立计时） =====
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
      const prevKey = chatKey(activeAgentId);
      const prevChat = newChats.get(prevKey);
      if (prevChat) {
        newChats.set(prevKey, { ...prevChat, _isActive: false });
      }
    }

    const key = chatKey(agentId);
    // 懒创建 chat
    if (!newChats.has(key)) {
      newChats.set(key, {
        turns: [],
        activeTurn: null,
        hasMore: false,
        historyLoaded: false,
        streaming: false,
        draft: '',
        noticeQueue: [],
        _isActive: true,
        _savedScrollTop: 0,
      });
    } else {
      // 重新激活已存在的 chat：常驻 SSE subscribe 在场期间持续更新 store，切 tab 不丢异步事件，
      //   切回无需重建。仅标 _isActive（historyLoaded 已由 SSE snapshot 置位；未 running 的由 ChatPanel init force 兜底）。
      newChats.set(key, { ...newChats.get(key), _isActive: true });
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
    const key = chatKey(agentId);
    const chat = chats.get(key);
    const defaults = { streaming: false, activeTurn: null, turns: [], historyLoaded: false, hasMore: false, noticeQueue: [] };
    // SSE subscribe 可能在 ChatPanel mount 前就收到 snapshot——chat 不存在时懒创建，防止事件被丢弃。
    chats.set(key, chat ? { ...chat, ...updates } : { ...defaults, ...updates });
    set({ chats });
  },

  // ===== 聊天历史 =====

  loadHistory: async (agentId, { force = false } = {}) => {
    // 初始历史由 SSE snapshot 提供（single source）。本方法仅 rewind 后 force 重建用。
    if (!force) return;
    const chats = new Map(get().chats);
    const key = chatKey(agentId);
    const chat = chats.get(key);
    if (!chat) return;
    api.log('INFO', `[loadHistory] agent=${agentId} force 重建（rewind）`);
    try {
      const data = await api.getHistory(agentId, { limit: HISTORY_PAGE_SIZE });
      const messages = data.messages || [];
      const turns = historyToTurns(messages);
      api.log('INFO', `[loadHistory] agent=${agentId} REST 返回 ${messages.length} 条，降为 ${turns.length} turns`);
      chats.set(key, {
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
    const key = chatKey(agentId);
    const chat = chats.get(key);
    if (!chat || chat.loadingHistory || !chat.hasMore || chat.turns.length === 0) return;
    chats.set(key, { ...chat, loadingHistory: true });
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
      const key2 = chatKey(agentId);
      const chat2 = chats2.get(key2);
      if (chat2) {
        chats2.set(key2, {
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
    const key = chatKey(agentId);
    const chat = chats.get(key);
    if (!chat) return;
    chats.set(key, { ...chat, ...updates });
    set({ chats });
  },

  // ===== 辅助 =====

  getAgent: (agentId) => {
    return get().agents.find(a => a.agentId === agentId);
  },

  /**
   * 重置 store 到初始状态（多用户：登录/登出/换号时由 App 调，清空上一个用户的 chats）。
   */
  reset: () => set({ ...initialState, chats: new Map() }),
}));

export default useAgentStore;