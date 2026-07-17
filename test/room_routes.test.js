import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createGatewayApp } from '../gateway/server.js';
import { ProcessManager } from '../gateway/process_manager.js';
import { ChatHistory } from '../gateway/chat_history.js';
import { RoomManager } from '../gateway/room_bus.js';

function fakeProcessManager(tmpAgentsDir) {
  return {
    agentsDir: tmpAgentsDir,
    agents: new Map(),
    hasAgent: () => false,
    listAgents: () => [],
    getAgent: () => null,
    getAgentStatus: () => 'stopped',
    getAgentPort: () => null,
  };
}

describe('/rooms/* routes', () => {
  let tmpDir, roomsDir, agentsDir, server, baseUrl, roomManager;
  let testRoomId;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rrt-'));
    roomsDir = path.join(tmpDir, 'rooms');
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const id of ['elf-001', 'elf-002']) {
      const cfgDir = path.join(agentsDir, id, 'config');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
        agentId: id, name: id, port: 0, provider: 'mock', systemPrompt: 't', tools: [],
      }));
    }
    const calls = [];
    roomManager = new RoomManager(roomsDir, 0, {
      spawnFn: () => { calls.push(1); return { pid: 10000 + calls.length, _fakeReady: true }; },
      agentConfigDir: (id) => path.join(agentsDir, id, 'config'),
      startTimeout: 500,
    });
    const pm = fakeProcessManager(agentsDir);
    const chatHistory = new ChatHistory(agentsDir);
    const app = createGatewayApp(pm, chatHistory, roomManager);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /rooms creates room', async () => {
    const res = await fetch(`${baseUrl}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', members: ['elf-001', 'elf-002'] }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.roomId);
    assert.deepEqual(data.members, ['elf-001', 'elf-002']);
    testRoomId = data.roomId;
  });

  it('POST /rooms without members -> 400', async () => {
    const res = await fetch(`${baseUrl}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.status, 400);
  });

  it('GET /rooms lists rooms', async () => {
    const res = await fetch(`${baseUrl}/rooms`);
    const data = await res.json();
    assert.ok(data.rooms.length >= 1);
  });

  it('GET /rooms/:rid returns room detail with member status', async () => {
    const res = await fetch(`${baseUrl}/rooms/${testRoomId}`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.members.length, 2);
    assert.ok(data.members[0].agentId);
    assert.ok(data.members[0].status);
  });

  it('GET /rooms/:rid not found -> 404', async () => {
    const res = await fetch(`${baseUrl}/rooms/nope`);
    assert.equal(res.status, 404);
  });

  it('DELETE /rooms/:rid/members/:agentId removes member', async () => {
    const res = await fetch(`${baseUrl}/rooms/${testRoomId}/members/elf-002`, { method: 'DELETE' });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.members.length, 1);
    assert.equal(data.members[0].agentId, 'elf-001');
  });

  it('POST /rooms/:rid/send writes history, returns id (no reply in B)', async () => {
    const res = await fetch(`${baseUrl}/rooms/${testRoomId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.id);
  });

  it('POST /rooms/:rid/send missing message -> 400', async () => {
    const res = await fetch(`${baseUrl}/rooms/${testRoomId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('GET /rooms/:rid/history returns sent message', async () => {
    const res = await fetch(`${baseUrl}/rooms/${testRoomId}/history`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.messages.length >= 1);
    const last = data.messages[data.messages.length - 1];
    // speaker 为用户名(来自 gateway.json userName,默认 'user');内容为 'hello'
    assert.ok(last.speaker, 'speaker 应存在');
    assert.equal(last.content, 'hello');
  });

  it('DELETE /rooms/:rid/history clears history', async () => {
    const res = await fetch(`${baseUrl}/rooms/${testRoomId}/history`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const h = await fetch(`${baseUrl}/rooms/${testRoomId}/history`).then((r) => r.json());
    assert.equal(h.messages.length, 0);
  });

  it('DELETE /rooms/:rid dissolves room (stops replicas, deletes dir)', async () => {
    // 先建一个临时群用于解散
    const created = await fetch(`${baseUrl}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete', members: ['elf-001'] }),
    }).then((r) => r.json());
    const rid = created.roomId;
    assert.ok(fs.existsSync(path.join(roomsDir, rid)));
    const res = await fetch(`${baseUrl}/rooms/${rid}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    // 目录已删
    assert.equal(fs.existsSync(path.join(roomsDir, rid)), false);
    // GET 404
    const after = await fetch(`${baseUrl}/rooms/${rid}`);
    assert.equal(after.status, 404);
  });

  it('POST /rooms/:rid/clear-all 清空记录+记忆', async () => {
    const created = await fetch(`${baseUrl}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'clear-test', members: ['elf-001'] }),
    }).then((r) => r.json());
    const rid = created.roomId;
    // 发条消息产生历史
    await fetch(`${baseUrl}/rooms/${rid}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const before = await fetch(`${baseUrl}/rooms/${rid}/history`).then(r => r.json());
    assert.ok(before.messages.length >= 1);
    // clear-all
    const res = await fetch(`${baseUrl}/rooms/${rid}/clear-all`, { method: 'POST' });
    assert.equal(res.status, 200);
    const after = await fetch(`${baseUrl}/rooms/${rid}/history`).then(r => r.json());
    assert.equal(after.messages.length, 0);
  });
});