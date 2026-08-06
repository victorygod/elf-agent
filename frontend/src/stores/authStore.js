/**
 * authStore —— 登录态管理（Zustand）
 *
 * token 持久化在 localStorage('elf_token')；user 对象启动时经 GET /auth/me 校验后载入。
 * 401 处理在 api/index.js 的 authFetch：清 token + 置未登录 → App 渲染登录覆盖层。
 */
import { create } from 'zustand';

const TOKEN_KEY = 'elf_token';

export const useAuthStore = create((set, get) => ({
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,          // { uid, username, userName, userAvatar, role, sidebarOrder, disabledAgents }
  checked: false,      // 启动时是否已完成 me() 校验（未校验完前 App 显示加载态）

  setAuth: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    set({ token, user, checked: true });
  },

  setUser: (user) => set({ user }),

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    set({ token: null, user: null, checked: true });
  },

  /** 启动时校验 token：有效 → 载入 user；无效 → 清 token（触发登录页） */
  loadMe: async () => {
    const { token } = get();
    if (!token) { set({ checked: true }); return; }
    try {
      const res = await fetch('/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ user: data.user, checked: true });
    } catch (e) {
      localStorage.removeItem(TOKEN_KEY);
      set({ token: null, user: null, checked: true });
    }
  },
}));

/** 私聊 roomId：chat-<uid>-<agentId>（uid 不含 '-'） */
export function privateRoomId(uid, agentId) {
  return `chat-${uid}-${agentId}`;
}
