/**
 * Gateway 子系统测试
 * 使用 MockModel，不依赖真实 LLM API
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ProcessManager } from '../gateway/process_manager.js';
import { createGatewayApp } from '../gateway/server.js';
import { loadGatewayConfig } from '../gateway/config.js';

/**
 * 清理指定端口上的进程
 */
function killPort(port) {
  try {
    execSync(`lsof -ti :${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
  } catch (e) {
    // 忽略
  }
}

// ========================
// Gateway Config 测试
// ========================
describe('Gateway Config', () => {
  it('应该正确加载 gateway.json', () => {
    const config = loadGatewayConfig();
    assert.ok(config.port);
    assert.equal(config.port, 8080);
  });

  it('loadGatewayConfig 返回稳定 userUid(默认 default_userid,问题3)', () => {
    const config = loadGatewayConfig();
    assert.ok(config.userUid, 'userUid 应存在');
    assert.equal(config.userUid, 'default_userid');
    assert.ok(config.userName, 'userName 应存在');
  });
});

// ========================
// ProcessManager 测试
// ========================
describe('ProcessManager', () => {
  let pm;

  beforeEach(() => {
    pm = new ProcessManager();
  });

  it('discoverAgents 应该发现 agents 目录下的 Agent', () => {
    pm.discoverAgents();
    assert.ok(pm.hasAgent('elf-001'));
    assert.ok(pm.hasAgent('elf-002'));
    const agents = pm.listAgents();
    assert.ok(agents.length >= 2);
  });

  it('getAgent 应返回正确的 Agent 信息', () => {
    pm.discoverAgents();
    const agent = pm.getAgent('elf-001');
    assert.ok(agent);
    assert.equal(agent.agentId, 'elf-001');
    assert.equal(agent.port, 8081);
    assert.equal(agent.status, 'stopped');
  });

  it('getAgent 不存在的 Agent 应返回 null', () => {
    pm.discoverAgents();
    const agent = pm.getAgent('nonexistent');
    assert.equal(agent, null);
  });

  it('listAgents 应返回所有 Agent', () => {
    pm.discoverAgents();
    const agents = pm.listAgents();
    const ids = agents.map(a => a.agentId);
    assert.ok(ids.includes('elf-001'));
    assert.ok(ids.includes('elf-002'));
  });

  it('startAgent 不存在的 Agent 应抛出 404', async () => {
    pm.discoverAgents();
    await assert.rejects(() => pm.startAgent('nonexistent'), { statusCode: 404 });
  });

  it('stopAgent 不存在的 Agent 应抛出 404', async () => {
    pm.discoverAgents();
    await assert.rejects(() => pm.stopAgent('nonexistent'), { statusCode: 404 });
  });

  it('stopAgent 已停止的 Agent 应抛出 409', async () => {
    pm.discoverAgents();
    await assert.rejects(() => pm.stopAgent('elf-001'), { statusCode: 409 });
  });
});

// ========================
// Gateway HTTP Server 测试
// ========================
describe('Gateway HTTP Server', () => {
  let server, pm;
  const testPort = 9877;

  before(async () => {
    // 强制子进程用 mock model：不连真实 LLM、秒回、无网络依赖。
    process.env.ELF_FORCE_MOCK_MODEL = '1';
    pm = new ProcessManager();
    pm.discoverAgents();
    // 杀掉所有可能占用端口的残留 Agent 进程
    for (const [id, agent] of pm.agents) {
      killPort(agent.port);
      await new Promise(r => setTimeout(r, 200));
      agent.status = 'stopped';
      agent.pid = null;
    }
    // v3：注入 roomManager + 私聊房历史，挂 /rooms/chat-<id>/* 路由。
    const { RoomManager } = await import('../gateway/room_bus.js');
    const { ChatHistory } = await import('../gateway/chat_history.js');
    const roomsDir = path.join(process.cwd(), 'rooms');
    try { fs.mkdirSync(roomsDir, { recursive: true }); } catch (e) {}
    const roomManager = new RoomManager(roomsDir, testPort, { pm, gatewayUrl: `http://127.0.0.1:${testPort}` });
    const privateRoomHistory = new ChatHistory(roomsDir, roomsDir, { roomMode: true, roomsDir });
    pm.privateRoomHistory = privateRoomHistory;
    pm.chatDir = path.join(process.cwd(), 'chat');
    pm._gatewayUrl = `http://127.0.0.1:${testPort}`;
    const app = createGatewayApp(pm, roomManager, { privateRoomHistory });
    await new Promise((resolve) => {
      server = app.listen(testPort, resolve);
    });
  });

  after(async () => {
    // 停止所有 Agent（通过 HTTP /shutdown 或端口清理）
    for (const [id, agent] of pm.agents) {
      try {
        await fetch(`http://127.0.0.1:${agent.port}/shutdown`, { method: 'POST' });
      } catch (e) {
        // Agent 可能未运行
      }
    }
    // 等待进程退出并清理端口
    await new Promise(r => setTimeout(r, 500));
    for (const [id, agent] of pm.agents) {
      killPort(agent.port);
    }
    // 探活刷新内存态 + 断 /events 重连器，防 gateway 卡在重连链、node --test 不退出。
    for (const [id] of pm.agents) {
      try { await pm.probeAgent(id); } catch (e) { /* 忽略 */ }
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    delete process.env.ELF_FORCE_MOCK_MODEL;
  });

  it('GET /agents 应返回 Agent 列表', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/agents`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.ok(data.length >= 2);
    const ids = data.map(a => a.agentId);
    assert.ok(ids.includes('elf-001'));
    assert.ok(ids.includes('elf-002'));
  });

  it('GET /agents/:id 应返回单个 Agent 信息', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.agentId, 'elf-001');
    assert.equal(data.port, 8081);
  });

  it('GET /agents/:id 不存在的 Agent 应返回 404', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/agents/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('GET /available-tools 应返回工具名列表（读 engine/tools/index.js）', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/available-tools`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.tools), '应返回 tools 数组');
    assert.ok(data.tools.includes('Bash'), '应包含 Bash');
    assert.ok(data.tools.includes('Read'), '应包含 Read');
  });

  it('POST /agents/:id/start 应启动 Agent', async () => {
    // 确保 Agent 处于 stopped 状态
    const statusRes = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001`);
    const statusData = await statusRes.json();
    if (statusData.status === 'running') {
      await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/stop`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 1000));
    }

    const res = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/start`, {
      method: 'POST'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'running');
    assert.ok(data.pid);

    // 等待 Agent HTTP 服务启动
    await new Promise(r => setTimeout(r, 1500));

    // 再次启动应返回 409
    const res2 = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/start`, {
      method: 'POST'
    });
    assert.equal(res2.status, 409);
  });

  it('v3 /rooms/chat-<id>/say + subscribe 应经 SSE 收到 token/done', async () => {
    // 确保 elf-001 运行
    await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/start`, { method: 'POST' });
    await new Promise(r => setTimeout(r, 2500));
    // 先建常驻 subscribe SSE
    const sseRes = await fetch(`http://127.0.0.1:${testPort}/rooms/chat-elf-001/subscribe`);
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buf = '', curEvent = '';
    const readNext = async () => {
      const { done, value } = await reader.read();
      if (done) return false;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('event: ')) curEvent = t.slice(7).trim();
        else if (t.startsWith('data: ')) { try { events.push({ event: curEvent, data: JSON.parse(t.slice(6)) }); } catch (e) {} }
        else if (t === '') curEvent = '';
      }
      return true;
    };
    await readNext(); // snapshot
    // 发消息（fire-and-forget ack）
    const sayRes = await fetch(`http://127.0.0.1:${testPort}/rooms/chat-elf-001/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '你好' }),
    });
    assert.equal(sayRes.status, 200);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !events.some(e => e.event === 'done')) {
      await Promise.race([readNext(), new Promise(r => setTimeout(r, 50))]);
    }
    try { reader.cancel(); } catch (e) {}
    const names = events.map(e => e.event);
    assert.ok(names.includes('snapshot') || names.length > 0, `应收到事件，实际 ${names.join(',')}`);
    assert.ok(names.includes('done'), `应收到 done，实际 ${names.join(',')}`);
  });

  it('v3 /rooms/chat-<id>/say 缺少 content 应返回 400', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/rooms/chat-elf-001/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });

  it('GET /agents/:id/config 应返回 Agent 配置', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/config`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.agentId, 'elf-001');
    assert.ok(data.systemPrompt);
    assert.ok(typeof data.model.auth_token === 'string' && data.model.auth_token.length > 0); // auth_token 明文返回
  });

  it('PUT /agents/:id/config 应更新配置', async () => {
    // 先读取原始配置
    const getRes = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/config`);
    const originalConfig = await getRes.json();
    const originalLimit = originalConfig.memoryTokenLimit;

    // 更新配置
    const putRes = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryTokenLimit: 12000 })
    });
    assert.equal(putRes.status, 200);
    const data = await putRes.json();
    assert.equal(data.status, 'ok');

    // 验证更新
    const verifyRes = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/config`);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.memoryTokenLimit, 12000);

    // 恢复原始配置
    await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryTokenLimit: originalLimit })
    });
  });

  it('先 stop 再 start 应能重新运行 Agent', async () => {
    // elf-001 应该在 running 状态（上一个测试启动了它）
    const stopRes = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/stop`, {
      method: 'POST'
    });
    assert.equal(stopRes.status, 200);
    await new Promise(r => setTimeout(r, 1000));

    const startRes = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/start`, {
      method: 'POST'
    });
    assert.equal(startRes.status, 200);
    const data = await startRes.json();
    assert.equal(data.status, 'running');
    assert.ok(data.pid);

    // 等待 Agent 启动完成
    await new Promise(r => setTimeout(r, 1500));

    // 重新启动后应仍能经 v3 私聊房发言
    const chatRes = await fetch(`http://127.0.0.1:${testPort}/rooms/chat-elf-001/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '重启后你好' })
    });
    assert.equal(chatRes.status, 200);
  });

  it('POST /agents/:id/stop 应停止 Agent', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/stop`, {
      method: 'POST'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'stopped');

    // 再次停止应返回 409
    const res2 = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/stop`, {
      method: 'POST'
    });
    assert.equal(res2.status, 409);
  });

  it('v3 /rooms/chat-<id>/say 未运行的 Agent 应返回 503', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/rooms/chat-elf-001/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '你好' })
    });
    // v3：agent 未运行时私聊房 /say 直接拒绝（503），不再离线排队
    assert.equal(res.status, 503);
  });
});