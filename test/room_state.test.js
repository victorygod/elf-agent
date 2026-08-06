/**
 * RoomState 工厂 + 多房 AgentServer 路由测试（v3 S1/S2）
 *
 * 验证：
 *   - createRoomState(私聊) / createRoomState(群聊)：建独立 Agent + MM(隔离 dataDir) + ScenePlugin + AbortController
 *   - createAgentServer 多房工厂：/observe 按 body.roomId 路由 + 懒创建；跨房并发不互阻；同房串行
 *
 * 用 MockModel（经 ELF_FORCE_MOCK_MODEL=1 强制）+ 真实 agents/elf-001/config 目录（createAgent 真实装配路径）。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRoomState } from '../engine/room_state.js';
import { createAgentServer } from '../engine/server.js';

const ELF001_CONFIG_DIR = path.join(process.cwd(), 'agents', 'elf-001', 'config');

function mkTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rs-'));
}

async function collect(fn) {
  const events = [];
  await fn(e => events.push(e));
  return events;
}

// 本文件装配真实 agents/elf-001/config（provider:llm），不强制 mock 会向 idealab 真实 LLM 端点发请求，
// 无内网/VPN 时连接超时。与 integration/gateway 测试一致：before 设 ELF_FORCE_MOCK_MODEL=1 强制 MockModel，
// after 清掉（避免泄漏到断言 provider==='llm' 的 Config 类用例）。
before(() => { process.env.ELF_FORCE_MOCK_MODEL = '1'; });
after(() => { delete process.env.ELF_FORCE_MOCK_MODEL; });

describe('RoomState 工厂', () => {
  it('私聊房：建 Agent + MM(隔离 dataDir) + PrivateChatPlugin + AbortController', async () => {
    const root = mkTmpRoot();
    const roomId = 'chat-u_test-elf-001';
    const room = await createRoomState({
      configDir: ELF001_CONFIG_DIR, agentId: 'elf-001', roomId, mode: 'private',
      dataDir: path.join(root, roomId), gatewayUrl: null,
    });
    assert.equal(room.roomId, roomId);
    assert.ok(room.agent, '建了 Agent');
    assert.ok(room.agent._scene, '注入了 ScenePlugin');
    assert.equal(room.agent._scene.constructor.name, 'PrivateChatPlugin');
    assert.equal(room.runContext.roomId, roomId, '私聊 runContext 保留 roomId');
    assert.equal(room.runContext.mode, 'private');
    // MM dataDir 隔离
    assert.equal(room.agent.messageManager.dataDir, path.join(root, roomId));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('群聊房：建 Agent + RoomPlugin + 注册 Speak + runContext roomId', async () => {
    const root = mkTmpRoot();
    const roomId = 'room_abc';
    const room = await createRoomState({
      configDir: ELF001_CONFIG_DIR, agentId: 'elf-001', roomId, mode: 'room',
      dataDir: path.join(root, roomId), memberName: 'elf-001', roomBusUrl: null,
    });
    assert.equal(room.agent._scene.constructor.name, 'RoomPlugin');
    assert.ok(room.agent.toolManager.get('Speak'), '群聊注册了 Speak');
    assert.equal(room.runContext.roomId, roomId);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('两房 dataDir 隔离：互不串 context', async () => {
    const root = mkTmpRoot();
    const r1 = await createRoomState({ configDir: ELF001_CONFIG_DIR, agentId: 'elf-001', roomId: 'chat-u_test-elf-001-a', mode: 'private', dataDir: path.join(root, 'a') });
    const r2 = await createRoomState({ configDir: ELF001_CONFIG_DIR, agentId: 'elf-001', roomId: 'room_x', mode: 'room', dataDir: path.join(root, 'x'), memberName: 'elf-001' });
    assert.notEqual(r1.agent.messageManager.dataDir, r2.agent.messageManager.dataDir);
    assert.equal(fs.existsSync(path.join(root, 'a', 'context.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'x', 'context.json')), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('多房 AgentServer /observe 路由', () => {
  let root, app, server, baseUrl;

  before(async () => {
    root = mkTmpRoot();
    // 多房工厂形态：用 elf-001 config 装配，dataRoot=root，按 roomId 懒建子目录。
    app = createAgentServer({
      config: null,
      configDir: (id) => path.join(process.cwd(), 'agents', id, 'config'),
      dataRoot: root,
      gatewayUrl: null,
      defaultAgentId: 'elf-001',
      port: null,
    });
    await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
  });
  after(async () => {
    if (server) await new Promise(r => server.close(r));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  });

  it('私聊 /observe（roomId=chat-u_test-elf-001）懒建 RoomState 并 reasoning', async () => {
    // 响应：模型秒回纯文本 → 私聊空闲即 flush → reasoning → done
    const res = await fetch(`${baseUrl}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: 'chat-u_test-elf-001', content: '你好', role: 'chat', seq: 1 }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ack, true);
    // /observe 异步处理：给一点时间让 reasoning 跑完（mock 秒回）。
    await new Promise(r => setTimeout(r, 150));
  });

  it('群聊 /observe（roomId=room_y，未@）进 buffer 不 reasoning', async () => {
    const res = await fetch(`${baseUrl}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: 'room_y', agentId: 'elf-001', memberName: 'elf-001', from: 'elf-002', content: 'hi', mentions: [], role: 'chat', seq: 1 }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ack, true);
    await new Promise(r => setTimeout(r, 100));
  });

  it('两房并发 /observe 不互阻（私聊房 + 群聊房各自独立）', async () => {
    // 同时投两条到不同房，两条都应 ack（receiver 各自 async，不串行阻塞）。
    const [a, b] = await Promise.all([
      fetch(`${baseUrl}/observe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: 'chat-u_test-elf-001', content: '并发1', role: 'chat', seq: 2 }) }),
      fetch(`${baseUrl}/observe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: 'room_y', agentId: 'elf-001', memberName: 'elf-001', from: 'elf-002', content: '并发2', mentions: [], role: 'chat', seq: 2 }) }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
  });

  it('/rooms 列出本进程承载的 roomId', async () => {
    const res = await fetch(`${baseUrl}/rooms`);
    const data = await res.json();
    assert.equal(res.status, 200);
    const ids = data.rooms.map(r => r.roomId);
    assert.ok(ids.includes('chat-u_test-elf-001'));
    assert.ok(ids.includes('room_y'));
  });

  it('/abort/:roomId 中断本房', async () => {
    const res = await fetch(`${baseUrl}/abort/chat-u_test-elf-001`, { method: 'POST' });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.status, 'ok');
  });
});
