/**
 * 多用户鉴权测试（docs/multi-user-auth-design.md）
 *
 * 与 setup-env 的 ELF_SKIP_AUTH=1 相反：本文件显式关闭旁路，走真实 JWT 流程。
 * 覆盖：注册（首个用户=admin，后续=visitor）/ 重复注册 409 / 登录 / 错密码 401 /
 *   无 token 401 / 伪造 token 401 / 有效 token 放行 / 访客写操作 403 /
 *   内部服务 token / 私聊房归属隔离（403）。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// 隔离 profiles（用户存储落这里）
const __profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-auth-test-'));
process.env.ELF_PROFILES_ROOT = __profilesRoot;
// 固定密钥（生成随机也可，但固定值便于排查）
process.env.ELF_JWT_SECRET = 'auth-test-jwt-secret-0123456789abcdef0123456789';
process.env.ELF_INTERNAL_TOKEN = 'auth-test-internal-token-0123456789abcdef01';
// 关键：关闭测试旁路，走真实鉴权
process.env.ELF_SKIP_AUTH = '';

import { _resetProfilesRoot } from '../shared/profiles_paths.js';
import { createGatewayApp } from '../gateway/server.js';
import { ProcessManager } from '../gateway/process_manager.js';
import { RoomManager } from '../gateway/room_bus.js';
import { ChatHistory } from '../gateway/chat_history.js';
import { roomsRoot } from '../shared/profiles_paths.js';

const testPort = 9911;
let server;
const base = `http://127.0.0.1:${testPort}`;

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

before(async () => {
  _resetProfilesRoot();
  const pm = new ProcessManager();
  await pm.discoverAgents();
  const roomsDir = roomsRoot();
  fs.mkdirSync(roomsDir, { recursive: true });
  const roomManager = new RoomManager(roomsDir, testPort, { pm, gatewayUrl: base });
  const privateRoomHistory = new ChatHistory(roomsDir, roomsDir, { roomMode: true, roomsDir });
  pm.privateRoomHistory = privateRoomHistory;
  pm._gatewayUrl = base;
  const app = createGatewayApp(pm, roomManager, { privateRoomHistory });
  await new Promise((resolve) => { server = app.listen(testPort, resolve); });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(__profilesRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('auth 注册/登录', () => {
  it('第一个注册的用户自动成为 admin', async () => {
    const { status, data } = await api('/auth/register', { method: 'POST', body: { username: 'wolfgod', password: 'pass1234' } });
    assert.equal(status, 200);
    assert.ok(data.token, '应签发 token');
    assert.equal(data.user.role, 'admin');
    assert.equal(data.user.username, 'wolfgod');
    assert.ok(data.user.uid.startsWith('u_'), 'uid 应为 u_ 前缀');
    assert.ok(!data.user.uid.includes('-'), 'uid 不应含 -（roomId 分割约定）');
    assert.ok(!data.user.passwordHash, '不应外泄 passwordHash');
  });

  it('重复注册同一用户名 → 409', async () => {
    const { status } = await api('/auth/register', { method: 'POST', body: { username: 'wolfgod', password: 'xxxx' } });
    assert.equal(status, 409);
  });

  it('第二个注册的用户是 visitor', async () => {
    const { status, data } = await api('/auth/register', { method: 'POST', body: { username: 'alice', password: 'pass1234' } });
    assert.equal(status, 200);
    assert.equal(data.user.role, 'visitor');
  });

  it('非法用户名 / 短密码 → 400', async () => {
    let r = await api('/auth/register', { method: 'POST', body: { username: 'a', password: 'pass1234' } });
    assert.equal(r.status, 400);
    r = await api('/auth/register', { method: 'POST', body: { username: 'validname', password: '12' } });
    assert.equal(r.status, 400);
  });

  it('登录成功返回 token + user', async () => {
    const { status, data } = await api('/auth/login', { method: 'POST', body: { username: 'wolfgod', password: 'pass1234' } });
    assert.equal(status, 200);
    assert.ok(data.token);
    assert.equal(data.user.role, 'admin');
  });

  it('错误密码 → 401', async () => {
    const { status } = await api('/auth/login', { method: 'POST', body: { username: 'wolfgod', password: 'wrong' } });
    assert.equal(status, 401);
  });

  it('登录大小写不敏感', async () => {
    const { status } = await api('/auth/login', { method: 'POST', body: { username: 'WolfGod', password: 'pass1234' } });
    assert.equal(status, 200);
  });
});

describe('auth 中间件', () => {
  let adminToken, visitorToken, adminUid, visitorUid;

  before(async () => {
    const a = await api('/auth/login', { method: 'POST', body: { username: 'wolfgod', password: 'pass1234' } });
    adminToken = a.data.token; adminUid = a.data.user.uid;
    const v = await api('/auth/login', { method: 'POST', body: { username: 'alice', password: 'pass1234' } });
    visitorToken = v.data.token; visitorUid = v.data.user.uid;
  });

  it('GET /auth/me 有效 token → 返回当前用户', async () => {
    const { status, data } = await api('/auth/me', { token: adminToken });
    assert.equal(status, 200);
    assert.equal(data.user.uid, adminUid);
    assert.equal(data.user.role, 'admin');
  });

  it('无 token 访问业务路由 → 401', async () => {
    const { status } = await api('/agents');
    assert.equal(status, 401);
  });

  it('伪造 token → 401', async () => {
    const { status } = await api('/agents', { token: 'fake.token.here' });
    assert.equal(status, 401);
  });

  it('有效 token 访问 /agents → 200', async () => {
    const { status, data } = await api('/agents', { token: visitorToken });
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
  });

  it('内部服务 token 放行（req.service）', async () => {
    const { status } = await api('/agents', { token: process.env.ELF_INTERNAL_TOKEN });
    assert.equal(status, 200);
  });

  it('GET /settings per-user：各自读到自己的设置', async () => {
    const a = await api('/settings', { token: adminToken });
    assert.equal(a.data.userUid, adminUid);
    const v = await api('/settings', { token: visitorToken });
    assert.equal(v.data.userUid, visitorUid);
    assert.equal(v.data.role, 'visitor');
  });

  it('PUT /settings 只影响当前用户', async () => {
    const r = await api('/settings', { method: 'PUT', token: visitorToken, body: { userName: '爱丽丝' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.userName, '爱丽丝');
    const a = await api('/settings', { token: adminToken });
    assert.equal(a.data.userName, 'wolfgod', 'admin 的显示名不受访客修改影响');
  });
});

describe('权限分级（admin vs visitor）', () => {
  let adminToken, visitorToken;

  before(async () => {
    adminToken = (await api('/auth/login', { method: 'POST', body: { username: 'wolfgod', password: 'pass1234' } })).data.token;
    visitorToken = (await api('/auth/login', { method: 'POST', body: { username: 'alice', password: 'pass1234' } })).data.token;
  });

  it('访客读 config → 200（只读）', async () => {
    const { status } = await api('/agents/elf-001/config', { token: visitorToken });
    assert.equal(status, 200);
  });

  it('访客写 config → 403', async () => {
    const { status } = await api('/agents/elf-001/config', { method: 'PUT', token: visitorToken, body: { memoryTokenLimit: 12000 } });
    assert.equal(status, 403);
  });

  it('admin 写 config → 200', async () => {
    const get = await api('/agents/elf-001/config', { token: adminToken });
    const original = get.data.memoryTokenLimit;
    const { status } = await api('/agents/elf-001/config', { method: 'PUT', token: adminToken, body: { memoryTokenLimit: original } });
    assert.equal(status, 200);
  });

  it('访客建群 → 403；admin 建群 → 200', async () => {
    const v = await api('/rooms', { method: 'POST', token: visitorToken, body: { name: 'x', members: ['fake-agent'] } });
    assert.equal(v.status, 403);
    // members 用不存在的 agent：ensureAgentPresent 失败被 createRoom 容错（不 spawn 真实 agent-server）
    const a = await api('/rooms', { method: 'POST', token: adminToken, body: { name: 'x', members: ['fake-agent'] } });
    assert.equal(a.status, 200);
    // 清理
    await api(`/rooms/${a.data.roomId}`, { method: 'DELETE', token: adminToken });
  });

  it('访客停用/启用自己的私聊 room（不碰全局状态）', async () => {
    // 全局未启动 elf-001 → 访客 start 403
    const denied = await api('/agents/elf-001/start', { method: 'POST', token: visitorToken });
    assert.equal(denied.status, 403);
    // 访客 stop 自己的 room（幂等允许）
    const stop = await api('/agents/elf-001/stop', { method: 'POST', token: visitorToken });
    assert.equal(stop.status, 200);
    assert.equal(stop.data.status, 'stopped');
    // 全局视角该 agent 仍是 stopped（未受影响）
    const g = await api('/agents/elf-001', { token: adminToken });
    assert.equal(g.data.status, 'stopped');
  });
});

describe('私聊房隔离', () => {
  let adminToken, visitorToken, adminUid, visitorUid;

  before(async () => {
    const a = await api('/auth/login', { method: 'POST', body: { username: 'wolfgod', password: 'pass1234' } });
    adminToken = a.data.token; adminUid = a.data.user.uid;
    const v = await api('/auth/login', { method: 'POST', body: { username: 'alice', password: 'pass1234' } });
    visitorToken = v.data.token; visitorUid = v.data.user.uid;
  });

  it('读他人私聊历史 → 403', async () => {
    const rid = `chat-${adminUid}-elf-001`;
    const { status } = await api(`/rooms/${rid}/history`, { token: visitorToken });
    assert.equal(status, 403);
  });

  it('读自己私聊历史 → 200（空历史）', async () => {
    const rid = `chat-${visitorUid}-elf-001`;
    const { status, data } = await api(`/rooms/${rid}/history`, { token: visitorToken });
    assert.equal(status, 200);
    assert.deepEqual(data.messages, []);
  });

  it('无 token 读私聊 → 401', async () => {
    const rid = `chat-${adminUid}-elf-001`;
    const { status } = await api(`/rooms/${rid}/history`);
    assert.equal(status, 401);
  });

  it('内部服务 token 可读私聊 sync-history（agent 回调通道）', async () => {
    const rid = `chat-${adminUid}-elf-001`;
    const { status } = await api(`/rooms/${rid}/sync-history/elf-001?seed=true`, { token: process.env.ELF_INTERNAL_TOKEN });
    assert.equal(status, 200);
  });

  it('非法私聊房 ID（无 uid 段）→ 400/403', async () => {
    const { status } = await api('/rooms/chat-nodelimiter/history', { token: adminToken });
    assert.ok([400, 403].includes(status));
  });
});
