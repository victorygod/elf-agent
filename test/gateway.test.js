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
    pm = new ProcessManager();
    pm.discoverAgents();
    // 杀掉所有可能占用端口的残留 Agent 进程
    for (const [id, agent] of pm.agents) {
      killPort(agent.port);
      await new Promise(r => setTimeout(r, 200));
      agent.status = 'stopped';
      agent.pid = null;
    }
    const app = createGatewayApp(pm);
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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
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

  it('POST /agents/:id/chat 应返回 SSE 流', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' })
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('event: token') || text.includes('event: done') || text.includes('event: status'));
    // 验证 SSE 事件格式完整：应有 done 事件
    assert.ok(text.includes('event: done'), '应包含 done 事件');
  });

  it('POST /agents/:id/chat 缺少 message 应返回 400', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/chat`, {
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

    // 重新启动后应仍能对话
    const chatRes = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '重启后你好' })
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

  it('POST /agents/:id/chat 未运行的 Agent 应返回 503', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/agents/elf-001/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' })
    });
    assert.equal(res.status, 503);
  });
});