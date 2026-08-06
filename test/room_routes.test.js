import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createGatewayApp } from '../gateway/server.js';
import { ProcessManager } from '../gateway/process_manager.js';
import { ChatHistory } from '../gateway/chat_history.js';
import { RoomManager } from '../gateway/room_bus.js';
import { _resetProfilesRoot } from '../shared/profiles_paths.js';

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
    // profiles 根隔离到 tmpDir（snapshot/agentMemory 落盘全在 tmpDir 下，避免污染真实 cwd/profiles）。
    process.env.ELF_PROFILES_ROOT = tmpDir + '/profiles';
    _resetProfilesRoot();
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
    const privateRoomHistory = new ChatHistory(roomsDir, roomsDir, { roomMode: true, roomsDir });
    pm.privateRoomHistory = privateRoomHistory;
    const app = createGatewayApp(pm, roomManager, { privateRoomHistory });
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
    delete process.env.ELF_PROFILES_ROOT;
    _resetProfilesRoot();
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

  it('POST /rooms/:rid/say (user) writes history, returns id', async () => {
    const res = await fetch(`${baseUrl}/rooms/${testRoomId}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'user' },
      body: JSON.stringify({ content: 'hello' }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.id);
  });

  it('POST /rooms/:rid/say missing content -> 400', async () => {
    const res = await fetch(`${baseUrl}/rooms/${testRoomId}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'user' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('POST /rooms/:rid/say 未知 X-Speaker-Id -> 400', async () => {
    const res = await fetch(`${baseUrl}/rooms/${testRoomId}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'ghost' },
      body: JSON.stringify({ content: 'x' }),
    });
    assert.equal(res.status, 400);
  });

  it('GET /rooms/:rid/history returns sent message', async () => {
    const res = await fetch(`${baseUrl}/rooms/${testRoomId}/history`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.messages.length >= 1);
    const last = data.messages[data.messages.length - 1];
    // speaker 为用户名(来自 gateway.json userName,默认 'user')
    assert.ok(last.speaker, 'speaker 应存在');
    assert.ok(typeof last.content === 'string' && last.content.length > 0, '应有内容');
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
    await fetch(`${baseUrl}/rooms/${rid}/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'user' },
      body: JSON.stringify({ content: 'hello' }),
    });
    const before = await fetch(`${baseUrl}/rooms/${rid}/history`).then(r => r.json());
    assert.ok(before.messages.length >= 1);
    // clear-all
    const res = await fetch(`${baseUrl}/rooms/${rid}/clear-all`, { method: 'POST' });
    assert.equal(res.status, 200);
    const after = await fetch(`${baseUrl}/rooms/${rid}/history`).then(r => r.json());
    assert.equal(after.messages.length, 0);
  });

  // ===== sync-history 端点 =====

  it('GET /rooms/:rid/sync-history/:agentId?seed=true 返回 latestId', async () => {
    // 先发条消息保证有内容
    const created = await fetch(`${baseUrl}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sync-test', members: ['elf-001'] }),
    }).then((r) => r.json());
    const rid = created.roomId;
    await fetch(`${baseUrl}/rooms/${rid}/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'user' },
      body: JSON.stringify({ content: 'sync-hello' }),
    });

    const res = await fetch(`${baseUrl}/rooms/${rid}/sync-history/elf-001?seed=true`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.latestSeq != null, 'seed=true 应返回 latestSeq');
    assert.equal(data.messages.length, 0, 'seed=true 不返回 messages');
  });

  it('GET /rooms/:rid/sync-history/:agentId?afterSeq= 返回游标后消息', async () => {
    const created = await fetch(`${baseUrl}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sync-after-test', members: ['elf-001'] }),
    }).then((r) => r.json());
    const rid = created.roomId;

    // 发 3 条消息
    for (const msg of ['m1', 'm2', 'm3']) {
      await fetch(`${baseUrl}/rooms/${rid}/say`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'user' },
        body: JSON.stringify({ content: msg }),
      });
    }

    // afterSeq=1 → 应返回 seq>1，即 2 条 (m2, m3)
    const res = await fetch(`${baseUrl}/rooms/${rid}/sync-history/elf-001?afterSeq=1`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.messages.length, 2, `afterSeq=1 应返回 2 条，实际 ${data.messages.length}`);
    assert.equal(data.messages[0].content, 'm2');
    assert.equal(data.messages[1].content, 'm3');
    assert.ok(data.latestSeq != null, '应包含 latestSeq');
  });

  it('sync-history 返回消息附带 mentions', async () => {
    const created = await fetch(`${baseUrl}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sync-mentions', members: ['elf-001', 'elf-002'] }),
    }).then((r) => r.json());
    const rid = created.roomId;

    await fetch(`${baseUrl}/rooms/${rid}/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'user' },
      body: JSON.stringify({ content: '@elf-001 hello' }),
    });

    const res = await fetch(`${baseUrl}/rooms/${rid}/sync-history/elf-002`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.messages.length >= 1);
    // mentions 应包含 elf-001（因为内容 @elf-001）
    assert.ok(data.messages[0].mentions.includes('elf-001'),
      `mentions 应包含 elf-001, 实际: ${JSON.stringify(data.messages[0].mentions)}`);
  });

  it('sync-history 404 on unknown room', async () => {
    const res = await fetch(`${baseUrl}/rooms/nonexistent/sync-history/elf-001`);
    assert.equal(res.status, 404);
  });

  // ===== /say (agent 发言) 测试：X-Speaker-Id=agentId =====

  it('POST /say (agent) 写入历史并返回 id，seq 为数字，speaker 落盘 uid', async () => {
    const created = await fetch(`${baseUrl}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'say-agent-test', members: ['elf-001', 'elf-002'] }),
    }).then(r => r.json());
    const rid = created.roomId;

    const res = await fetch(`${baseUrl}/rooms/${rid}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'elf-001' },
      body: JSON.stringify({ content: 'agent 发言' }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.id, '应返回 id');

    // history 接口返回 name 版（speaker=name，本测试 name=id）
    const history = await fetch(`${baseUrl}/rooms/${rid}/history`).then(r => r.json());
    const last = history.messages[history.messages.length - 1];
    assert.equal(typeof last.seq, 'number', 'seq 应为数字');
    assert.equal(last.content, 'agent 发言');
    assert.equal(last.speaker, 'elf-001', 'speaker 渲染为 name');
    assert.equal(last.speakerUid, 'elf-001', 'speakerUid 为 uid');
  });

  it('POST /say 未知 X-Speaker-Id(非成员) -> 400', async () => {
    const created = await fetch(`${baseUrl}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'say-unknown', members: ['elf-001'] }),
    }).then(r => r.json());
    const rid = created.roomId;

    const res = await fetch(`${baseUrl}/rooms/${rid}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'ghost' },
      body: JSON.stringify({ content: 'no speaker' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /say (agent) 缺 content 返回 400', async () => {
    const created = await fetch(`${baseUrl}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'say-no-content', members: ['elf-001'] }),
    }).then(r => r.json());
    const rid = created.roomId;

    const res = await fetch(`${baseUrl}/rooms/${rid}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'elf-001' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('content @id 落盘 uid、返回 name 版（uid→name 改写）', async () => {
    // 用 name≠id 的成员验证改写：elf-001 name=Star
    const cfgDir = path.join(agentsDir, 'elf-001', 'config');
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
      agentId: 'elf-001', name: 'Star', port: 0, provider: 'mock', systemPrompt: 't', tools: [],
    }));
    const created = await fetch(`${baseUrl}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'say-rewrite', members: ['elf-001', 'elf-002'] }),
    }).then(r => r.json());
    const rid = created.roomId;

    // 用户发言 @elf-001(id 形式)
    await fetch(`${baseUrl}/rooms/${rid}/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'user' },
      body: JSON.stringify({ content: '@elf-001 hi' }),
    });
    // history 返回 name 版:content 里 @ 应改写成 @Star
    const hist = await fetch(`${baseUrl}/rooms/${rid}/history`).then(r => r.json());
    const last = hist.messages[hist.messages.length - 1];
    assert.ok(last.content.includes('@Star'), `content 应含 @Star,实际: ${last.content}`);
    assert.ok(!last.content.includes('@elf-001'), 'content 不应再含 @elf-001');

    // 落盘原文是 uid 版:读 history.jsonl 验证（v3 统一路径）
    const raw = fs.readFileSync(path.join(roomsDir, rid, 'history.jsonl'), 'utf-8').trim().split('\n');
    const rec = JSON.parse(raw[raw.length - 1]);
    assert.ok(rec.content.includes('@elf-001'), '落盘 content 应含 @elf-001(uid)');
    assert.equal(rec.speaker, 'u_test', '落盘 speaker 应为当前用户 uid（SKIP_AUTH=u_test）');
    assert.equal(rec.speakerUid, 'u_test');

    // 复原 elf-001 name
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
      agentId: 'elf-001', name: 'elf-001', port: 0, provider: 'mock', systemPrompt: 't', tools: [],
    }));
  });
});
