/**
 * auth_middleware —— 全局鉴权中间件 + 角色门
 *
 * 挂载位置：express.json() 之后、一切业务路由之前（含 plugin-loader 动态注册的 agent 路由）。
 *
 * 判定顺序：
 *  1. ELF_SKIP_AUTH=1（测试用）→ req.user = 内置测试管理员，放行
 *  2. 白名单路径（/auth/*、前端静态资源、头像图片等 <img> 发不了 Authorization 头的）→ 放行
 *  3. Authorization: Bearer <internalToken> → req.service = true（agent-server 机器身份）
 *  4. Authorization: Bearer <用户 JWT> → req.user = 完整用户对象
 *  5. 都没有 → 401
 *
 * req.service 与 req.user 的权限由路由层细分：
 *   - /say 当 X-Speaker-Id=agentId 时要求 req.service（Speak 工具回调）
 *   - /say 用户发言要求 req.user
 *   - sync-history 允许 req.service（agent 同步自己的房历史）或房主用户
 */

import { extractTokenPayload, getUser } from './auth.js';

/** ELF_SKIP_AUTH=1 时的内置身份（测试注入，默认管理员，uid 固定便于测试断言） */
export const SKIP_AUTH_USER = {
  uid: 'u_test',
  username: 'test',
  userName: 'test',
  userAvatar: null,
  role: 'admin',
  sidebarOrder: { rooms: [], agents: [] },
  disabledAgents: [],
};

/** 不需要鉴权的路径前缀（精确前缀匹配） */
const PUBLIC_PREFIXES = [
  '/auth',        // 注册/登录/me（me 自己验 token）
];

/**
 * 头像等 <img> 直连资源：GET 且匹配这些正则则免鉴权。
 *  - /users/<uid>/avatar       用户头像
 *  - /agents/<id>/config/<file> agent 头像等静态配置文件（仅限图片扩展名，config.json 仍要鉴权）
 */
const PUBLIC_GET_RE = [
  /^\/users\/[^/]+\/avatar$/,
  /^\/agents\/[^/]+\/config\/[^/]+\.(webp|png|jpe?g|gif)$/i,
  // 前端 SPA 外壳（登录页本身 + Vite 构建产物）：不含敏感数据，数据全走鉴权 API
  /^\/$/,                       // 首页 index.html
  /^\/index\.html$/,
  /^\/assets\/.+$/,             // 构建产物 JS/CSS/图片
  /^\/favicon\.ico$/,
];

/**
 * 创建全局鉴权中间件。
 * @param {{ internalToken: string }} opts
 */
export function createAuthMiddleware({ internalToken } = {}) {
  return function authMiddleware(req, res, next) {
    // 1. 测试旁路（user + service 双身份，覆盖用户发言与 agent 回调两类测试）
    if (process.env.ELF_SKIP_AUTH === '1') {
      req.user = { ...SKIP_AUTH_USER };
      req.service = true;
      return next();
    }
    // 2. 白名单
    if (PUBLIC_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'))) {
      return next();
    }
    if (req.method === 'GET' && PUBLIC_GET_RE.some(re => re.test(req.path))) {
      return next();
    }
    // 3. Bearer 判定
    const header = req.headers['authorization'] || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) {
      const token = m[1];
      if (internalToken && token === internalToken) {
        req.service = true;
        return next();
      }
      const payload = extractTokenPayload(req);
      if (payload) {
        const user = getUser(payload.uid);
        if (user) {
          req.user = user;
          return next();
        }
      }
    }
    return res.status(401).json({ error: '未登录或登录已过期' });
  };
}

/** 角色门：仅超级管理员。挂在具体路由上（配置写、群管理、skill 管理等）。 */
export function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  return res.status(403).json({ error: '权限不足' });
}
