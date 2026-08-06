/**
 * 群聊状态管理（Zustand Store）
 *
 * 与私聊 agentStore 并列（不动 agentStore，私聊零回归）。
 * state：rooms 列表、activeRoomId、roomChats Map(roomId → {messages, members, loadingHistory})。
 *
 * selectRoom/createRoom 等会协调 agentStore.activeAgentId（选群时清私聊选中）。
 * 反向协调（选私聊清群）由 App/Sidebar 在 selectAgent 时调 clearActiveRoom。
 */
import { create } from 'zustand';
import * as api from '../api/index.js';
import useAgentStore from './agentStore.js';

export const useRoomStore = create((set, get) => ({
  rooms: [],          // [{roomId,name,members,createdAt}]
  activeRoomId: null,
  roomChats: new Map(), // roomId → {messages:[], members:[], hasMore:false, loadingHistory:false, noticeQueue:[]}
  userName: 'user',   // 全局用户名(gateway.json)
  userAvatar: null,   // 全局用户头像文件名 (gateway.json)
  userUid: 'default_userid',  // 全局用户稳定身份 uid(gateway.json)
  // 侧栏手动排序：{ rooms: [roomId...], agents: [agentId...] }，区段内各自排序
  sidebarOrder: { rooms: [], agents: [] },

  // ===== 群聊居中通知（多条竖排，与 agentStore.toastList 对称，复用共享 Toast 组件） =====
  roomToastList: [],
  _roomToastKey: 0,

  showRoomToast: (fields) => set(s => {
    const id = s._roomToastKey + 1;
    return { roomToastList: [...s.roomToastList, { id, fields }], _roomToastKey: id };
  }),

  removeRoomToast: (id) => set(s => ({ roomToastList: s.roomToastList.filter(t => t.id !== id) })),

  clearRoomToast: () => set({ roomToastList: [] }),

  /** 加载群列表 */
  loadRooms: async () => {
    const rooms = await api.loadRooms();
    set({ rooms });
  },

  /** 选中一个群（同时清私聊选中，避免双高亮） */
  selectRoom: (roomId) => {
    useAgentStore.getState().activeAgentId !== null &&
      useAgentStore.setState({ activeAgentId: null });
    set({ activeRoomId: roomId });
    // 进群即加载历史 + 成员状态
    get().loadRoomHistory(roomId);
    get().loadRoomMembers(roomId);
  },

  clearActiveRoom: () => set({ activeRoomId: null }),

  /** 加载全局用户名 + 用户头像 + uid + 侧栏排序 */
  loadUserName: async () => {
    const { userName, userAvatar, userUid, sidebarOrder } = await api.getSettings();
    const next = { userName, userAvatar, userUid };
    if (sidebarOrder) next.sidebarOrder = sidebarOrder;
    set(next);
  },

  /** 保存侧栏排序（持久化到 gateway.json） */
  setSidebarOrder: async (sidebarOrder) => {
    // 乐观更新：先写本地，再落盘；失败打日志不回滚（顺序纯展示，容错优先）
    set({ sidebarOrder });
    try {
      await api.putSidebarOrder(sidebarOrder);
    } catch (e) {
      api.log('ERROR', `保存侧栏排序失败: ${e.message}`);
    }
  },

  /** 设置全局用户名 */
  setUserName: async (userName) => {
    const r = await api.putSettings({ userName });
    set({ userName: r.userName });
    return r.userName;
  },

  /** 设置全局用户头像 */
  setUserAvatar: async (avatarData) => {
    const r = await api.putSettings({ userAvatar: avatarData });
    set({ userAvatar: r.userAvatar });
    return r.userAvatar;
  },

  /** 建群 */
  createRoom: async (name, members) => {
    const room = await api.createRoom(name, members);
    set({ rooms: [...get().rooms, { roomId: room.roomId, name: room.name, members: room.members, createdAt: new Date().toISOString() }] });
    return room;
  },

  /** 解散群 */
  deleteRoom: async (roomId) => {
    await api.deleteRoom(roomId);
    set((s) => {
      const chats = new Map(s.roomChats); chats.delete(roomId);
      return {
        rooms: s.rooms.filter(r => r.roomId !== roomId),
        roomChats: chats,
        activeRoomId: s.activeRoomId === roomId ? null : s.activeRoomId,
      };
    });
  },

  /** 加成员 */
  addMember: async (roomId, agentId) => {
    const room = await api.addRoomMember(roomId, agentId);
    get()._updateRoomInList(roomId, room);
    return room;
  },

  /** 移除成员 */
  removeMember: async (roomId, agentId) => {
    const room = await api.removeRoomMember(roomId, agentId);
    get()._updateRoomInList(roomId, room);
    return room;
  },

  /** 清空群历史（前端清 messages） */
  clearHistory: async (roomId) => {
    await api.clearRoomHistory(roomId);
    get()._patchChat(roomId, { messages: [] });
  },

  /** 清空成员记忆（后端调副本 /clear） */
  clearMemory: async (roomId) => {
    await api.clearRoomMemory(roomId);
  },

  /** 清空聊天记录 + 成员记忆（合一原子） */
  clearAll: async (roomId) => {
    await api.clearRoomAll(roomId);
    get()._patchChat(roomId, { messages: [] });
  },

  /** 加载群历史到 roomChats */
  loadRoomHistory: async (roomId) => {
    const { messages } = await api.getRoomHistory(roomId);
    get()._patchChat(roomId, { messages });
  },

  /** 加载群成员状态（含多用户目录 users：渲染其他用户发言者的名字/头像） */
  loadRoomMembers: async (roomId) => {
    const room = await api.getRoom(roomId);
    if (room) get()._patchChat(roomId, { members: room.members, users: room.users || [] });
  },

  /**
   * 重置 store 到初始状态（多用户：登录/登出/换号时由 App 调，清空上一个用户的房间数据）。
   */
  reset: () => set({
    rooms: [],
    activeRoomId: null,
    roomChats: new Map(),
    userName: 'user',
    userAvatar: null,
    userUid: 'default_userid',
    sidebarOrder: { rooms: [], agents: [] },
    roomToastList: [],
    _roomToastKey: 0,
  }),

  /** 上翻加载更早的群历史(滚到顶触发),与私聊 loadMoreHistory 同构 */
  loadMoreHistory: async (roomId) => {
    const chat = get().roomChats.get(roomId);
    if (!chat || chat.loadingHistory || !chat.hasMore || !chat.messages?.length) return;
    get()._patchChat(roomId, { loadingHistory: true });
    try {
      const beforeId = chat.messages[0].id;
      const data = await api.getRoomHistory(roomId, undefined, beforeId); // limit 默认 50
      const older = data.messages || [];
      get()._patchChat(roomId, {
        messages: [...older, ...chat.messages],          // prepend 更旧
        hasMore: data.hasMore ?? false,
        loadingHistory: false,
      });
      return older.length > 0;
    } catch (e) {
      api.log('ERROR', '群聊上翻加载失败: ' + e.message);
      get()._patchChat(roomId, { loadingHistory: false });
      return false;
    }
  },

  /** SSE 推来一条新消息 → 追加 */
  appendMessage: (roomId, msg) => {
    const chat = get().roomChats.get(roomId);
    if (!chat) return;
    get()._patchChat(roomId, { messages: [...chat.messages, msg] });
  },

  /** SSE 推成员状态变更 */
  updateMemberStatus: (roomId, agentId, status) => {
    const chat = get().roomChats.get(roomId);
    if (!chat) return;
    const members = (chat.members || []).map(m => m.agentId === agentId ? { ...m, status } : m);
    get()._patchChat(roomId, { members });
  },

  /** SSE snapshot 初始化 */
  initFromSnapshot: (roomId, { messages, members, hasMore } = {}) => {
    const updates = { messages: messages || [], members: members || [] };
    if (hasMore !== undefined) updates.hasMore = hasMore;
    get()._patchChat(roomId, updates, /* createIfMissing */ true);
  },

  _patchChat: (roomId, updates, createIfMissing = true) => {
    const chats = new Map(get().roomChats);
    const existing = chats.get(roomId) || { messages: [], members: [], hasMore: false, loadingHistory: false, noticeQueue: [] };
    if (!chats.has(roomId) && !createIfMissing) return;
    chats.set(roomId, { ...existing, ...updates });
    set({ roomChats: chats });
  },

  _updateRoomInList: (roomId, room) => {
    // rooms 列表里 members 一律存 agentId 字符串数组（与 loadRooms/createRoom 一致）。
    // addMember/removeMember 后端返回的是 getRoom() → 成员对象数组 {agentId,name,avatar,status}，
    // 若不规整，RoomConfigDrawer 的 room.members.map(id => ...) 会把对象当 React 子节点渲染 → 白屏。
    const members = (room?.members || [])
      .map(m => (typeof m === 'string' ? m : m?.agentId))
      .filter(Boolean);
    set((s) => ({
      rooms: s.rooms.map(r => r.roomId === roomId ? { ...r, members } : r),
    }));
  },
}));

/**
 * 群聊 SSE 事件分发(纯函数,供 useAggregatedSubscription 复用,从 useRoomChat 抽出)。
 * 事件 data 带 {roomId, roomType:'room'}(聚合注入);roomType 已在聚合层分流,此处只按 event 分发。
 */
export function roomDispatch(roomId, event, data) {
  const store = useRoomStore.getState();
  switch (event) {
    case 'snapshot':
      store.initFromSnapshot(roomId, {
        messages: data.messages || [],
        members: data.members || [],
        hasMore: data.hasMore ?? false,
      });
      break;
    case 'speak':
      store.appendMessage(roomId, {
        speaker: data.speaker,
        speakerUid: data.speakerUid,
        content: data.content,
        ts: data.ts, id: data.id,
      });
      break;
    case 'member_status':
      store.updateMemberStatus(roomId, data.agentId, data.status);
      break;
    case 'notice': {
      // 入该房 noticeQueue,激活时 RoomChatPanel effect 显示(按房隔离,切房显积压)。
      const chat = store.roomChats.get(roomId);
      store._patchChat(roomId, { noticeQueue: [...(chat?.noticeQueue || []), data] });
      break;
    }
    default: break;
  }
}

export default useRoomStore;