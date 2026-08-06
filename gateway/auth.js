/**
 * auth —— 多用户账户体系（注册/登录/JWT/用户存储）
 *
 * 存储：profiles/users/<uid>/user.json
 *   { uid, username, passwordHash, userName, userAvatar, role, sidebarOrder, disabledAgents, createdAt }
 *   - uid：'u_' + 12 hex（**不含 '-'**，私聊 roomId = chat-<uid>-<agentId> 靠首个 '-' 分割）
 *   - username：登录名，全局唯一（大小写不敏感）
 *   - userName：显示名（群聊渲染、@ 解析用），可改
 *   - role：'admin' | 'visitor'；第一个注册的用户自动成为 admin，后续均为 visitor
 *   - disabledAgents：该用户停用的私聊 agentId 列表（用户级 room 开关，见 docs/multi-user-auth-design.md）
 *
 * 鉴权：JWT（jsonwebtoken，HS256）。签发单 token，30 天有效期，不做 refresh 流程
 *   （本地自托管规模下，长有效期单 token 是成熟惯例，如 Gitea/Immich 的 API token 模式）。
 *
 * 密码：bcryptjs（纯 JS 实现，避免 bcrypt 原生编译依赖；该规模下性能差异无感）。
 *
 * 内部服务 token：agent-server 回调 gateway（sync-history / Speak /say / notice）的机器凭证，
 *   持久化在 gateway.json internalToken，spawn 时经 ELF_INTERNAL_TOKEN 传给 agent-server。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { usersRoot, userDir } from '../shared/profiles_paths.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('auth', 'gateway.log');

const TOKEN_TTL = '30d';
const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/;

// ──────────────────────────── 用户存储 ────────────────────────────

function _userPath(uid) {
  return path.join(userDir(uid), 'user.json');
}

/** 读用户；不存在返回 null */
export function getUser(uid) {
  try {
    return JSON.parse(fs.readFileSync(_userPath(uid), 'utf-8'));
  } catch (err) {
    return null;
  }
}

/** 写用户（整份覆盖，调用方先 getUser 再合并字段） */
export function saveUser(user) {
  fs.mkdirSync(userDir(user.uid), { recursive: true });
  fs.writeFileSync(_userPath(user.uid), JSON.stringify(user, null, 2), 'utf-8');
  return user;
}

/** 列全部用户（扫描 usersRoot；注册唯一性检查 / 登录查找 / 群聊用户目录用，规模小直接扫） */
export function listUsers() {
  let entries;
  try {
    entries = fs.readdirSync(usersRoot(), { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const u = getUser(e.name);
    if (u) out.push(u);
  }
  return out;
}

/** 按登录名查找（大小写不敏感） */
export function findByUsername(username) {
  const lower = String(username || '').toLowerCase();
  if (!lower) return null;
  return listUsers().find(u => (u.username || '').toLowerCase() === lower) || null;
}

/**
 * 注册用户。第一个注册的用户自动成为 admin（超级权限），后续均为 visitor。
 * @returns {{ user: object } | { error: string, statusCode: number }}
 */
export function registerUser({ username, password }) {
  username = String(username || '').trim();
  if (!USERNAME_RE.test(username)) {
    return { error: '用户名非法（2-32 位字母/数字/_.-）', statusCode: 400 };
  }
  if (typeof password !== 'string' || password.length < 4) {
    return { error: '密码至少 4 位', statusCode: 400 };
  }
  if (findByUsername(username)) {
    return { error: '用户名已存在', statusCode: 409 };
  }
  const isFirst = listUsers().length === 0;
  const user = {
    uid: `u_${crypto.randomBytes(6).toString('hex')}`,
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    userName: username,           // 显示名默认 = 登录名，后续可在设置里改
    userAvatar: null,             // 头像文件名（avatar.<ext>），null = 默认色块
    role: isFirst ? 'admin' : 'visitor',
    sidebarOrder: { rooms: [], agents: [] },
    disabledAgents: [],           // 该用户停用的私聊 agentId（用户级 room 开关）
    createdAt: new Date().toISOString(),
  };
  saveUser(user);
  logger.info(`用户注册: ${username} (${user.uid}) role=${user.role}`);
  return { user };
}

/** 校验用户名密码，通过返回 user，否则 null */
export function verifyUser(username, password) {
  const user = findByUsername(username);
  if (!user) return null;
  if (!bcrypt.compareSync(String(password || ''), user.passwordHash)) return null;
  return user;
}

/**
 * 修改密码：校验旧密码 → 更新 passwordHash。
 * @returns {{ ok: true } | { error: string, statusCode: number }}
 */
export function changeUserPassword(uid, oldPassword, newPassword) {
  const user = getUser(uid);
  if (!user) return { error: '用户不存在', statusCode: 404 };
  if (typeof oldPassword !== 'string' || !bcrypt.compareSync(oldPassword, user.passwordHash)) {
    return { error: '旧密码错误', statusCode: 400 };
  }
  if (typeof newPassword !== 'string' || newPassword.length < 4) {
    return { error: '新密码至少 4 位', statusCode: 400 };
  }
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUser(user);
  logger.info(`用户 ${user.username} 已修改密码`);
  return { ok: true };
}

// ──────────────────────────── JWT ────────────────────────────

let _jwtSecret = null;
/** 注入 JWT 密钥（gateway 启动时从 config 注入） */
export function setJwtSecret(secret) { _jwtSecret = secret; }

/** 签发用户 token：{ uid, role }，30 天有效 */
export function signToken(user) {
  return jwt.sign({ uid: user.uid, role: user.role }, _jwtSecret, { expiresIn: TOKEN_TTL });
}

/** 验证 token，返回 { uid, role } 或 null */
export function verifyToken(token) {
  try {
    return jwt.verify(token, _jwtSecret);
  } catch (err) {
    return null;
  }
}

// ──────────────────────────── 用户级 room 开关 ────────────────────────────

/** 某用户对某 agent 的私聊 room 是否启用（默认启用；停用 = 该用户的 /say 503） */
export function isRoomEnabledForUser(uid, agentId) {
  // 测试旁路：SKIP_AUTH 的内置用户 u_test 不落盘 user.json，默认启用全部私聊 room
  if (process.env.ELF_SKIP_AUTH === '1') return true;
  const u = getUser(uid);
  if (!u) return false;
  return !(u.disabledAgents || []).includes(agentId);
}

/** 设置某用户对某 agent 的私聊 room 开关 */
export function setRoomEnabledForUser(uid, agentId, enabled) {
  const u = getUser(uid);
  if (!u) return null;
  const set = new Set(u.disabledAgents || []);
  if (enabled) set.delete(agentId); else set.add(agentId);
  u.disabledAgents = [...set];
  return saveUser(u);
}

// ──────────────────────────── 群聊用户目录（uid → 显示名） ────────────────────────────

/**
 * 用户目录：RoomManager 渲染群消息（uid→name 改写、@ 解析）+ 前端群聊参与者头像用。
 * @returns {Array<{ uid: string, name: string, avatar: string|null }>}
 */
export function getUserDirectory() {
  return listUsers().map(u => ({
    uid: u.uid,
    name: u.userName || u.username || u.uid,
    avatar: u.userAvatar ?? null,
  }));
}

// ──────────────────────────── HTTP 路由 ────────────────────────────

/** 对外暴露的用户信息（不含 passwordHash） */
function publicUser(u) {
  return {
    uid: u.uid,
    username: u.username,
    userName: u.userName,
    userAvatar: u.userAvatar ?? null,
    role: u.role,
    sidebarOrder: u.sidebarOrder || { rooms: [], agents: [] },
    disabledAgents: u.disabledAgents || [],
  };
}

/** 创建 /auth 路由 */
export function createAuthRouter() {
  const router = express.Router();

  // POST /auth/register — { username, password } → { token, user }
  router.post('/register', (req, res) => {
    const result = registerUser(req.body || {});
    if (result.error) return res.status(result.statusCode).json({ error: result.error });
    res.json({ token: signToken(result.user), user: publicUser(result.user) });
  });

  // POST /auth/login — { username, password } → { token, user }
  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = verifyUser(username, password);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    res.json({ token: signToken(user), user: publicUser(user) });
  });

  // GET /auth/me — 需 Authorization: Bearer <token>；返回当前用户（前端启动时校验 token 有效性）
  router.get('/me', (req, res) => {
    const payload = _extract(req);
    if (!payload) return res.status(401).json({ error: '未登录' });
    const user = getUser(payload.uid);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    res.json({ user: publicUser(user) });
  });

  return router;
}

/** 从请求头提取并验证 JWT（供 /auth/me 与中间件复用） */
function _extract(req) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1]);
}

/** 中间件用的提取器（导出） */
export function extractTokenPayload(req) {
  return _extract(req);
}
