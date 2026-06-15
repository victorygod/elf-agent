/**
 * 集成测试 — Agent + Gateway 协作功能
 * 使用 MockModel，不依赖真实 LLM API
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ProcessManager } from '../gateway/process_manager.js';
import { createGatewayApp } from '../gateway/server.js';

const GATEWAY_PORT = 9880;

let gatewayServer, pm;

describe('Agent + Gateway 集成测试', () => {
  before(async () => {
    pm = new ProcessManager();
    pm.discoverAgents();
    // 清理可能残留的端口占用
    for (const [id, agent] of pm.agents) {
      try {
        execSync(`lsof -ti :${agent.port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
      } catch (e) {
        // 忽略
      }
      agent.status = 'stopped';
      agent.pid = null;
    }
    await new Promise(r => setTimeout(r, 200));
    const app = createGatewayApp(pm);
    await new Promise((resolve) => {
      gatewayServer = app.listen(GATEWAY_PORT, resolve);
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
    // 等待进程退出
    await new Promise(r => setTimeout(r, 500));
    // 清理可能残留的端口占用
    for (const [id, agent] of pm.agents) {
      try {
        execSync(`lsof -ti :${agent.port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
      } catch (e) {
        // 忽略
      }
    }
    if (gatewayServer) {
      await new Promise((resolve) => gatewayServer.close(resolve));
    }
  });

  it('启动 Agent 后应能通过 Gateway 对话，SSE 事件格式完整', async () => {
    const startRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/start`, {
      method: 'POST'
    });
    assert.equal(startRes.status, 200);

    await new Promise(r => setTimeout(r, 2000));

    const chatRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' })
    });
    assert.equal(chatRes.status, 200);
    const text = await chatRes.text();
    // 验证 SSE 事件流格式完整
    assert.ok(text.includes('event: done'), '应包含 done 事件');
    assert.ok(text.includes('thinking') || text.includes('token'), '应包含 thinking 或 token 事件');
  });

  it('停止再启动 Agent 后应仍能对话', async () => {
    const stopRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/stop`, {
      method: 'POST'
    });
    assert.equal(stopRes.status, 200);
    await new Promise(r => setTimeout(r, 1000));

    const startRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/start`, {
      method: 'POST'
    });
    assert.equal(startRes.status, 200);

    await new Promise(r => setTimeout(r, 2000));

    const chatRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' })
    });
    assert.equal(chatRes.status, 200);
  });

  it('多个 Agent 应独立运行', async () => {
    const startRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-002/start`, {
      method: 'POST'
    });
    assert.equal(startRes.status, 200);

    await new Promise(r => setTimeout(r, 2000));

    const listRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents`);
    const agents = await listRes.json();
    const runningCount = agents.filter(a => a.status === 'running').length;
    assert.ok(runningCount >= 2, `应有至少2个running的Agent, 实际${runningCount}`);
  });

  it('停止 Agent 后应不可对话', async () => {
    await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-002/stop`, { method: 'POST' });

    const chatRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-002/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' })
    });
    assert.equal(chatRes.status, 503);
  });

  it('配置更新后应持久化到文件', async () => {
    const originalRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/config`);
    const original = await originalRes.json();

    // 更新 systemPrompt
    await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: '这是一个测试提示词。' })
    });

    // 验证文件
    const promptPath = path.join(process.cwd(), 'agents', 'elf-001', 'config', 'system_prompt.md');
    const content = fs.readFileSync(promptPath, 'utf-8');
    assert.equal(content, '这是一个测试提示词。');

    // 恢复
    await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: original.systemPrompt })
    });
  });

  it('Agent 进程崩溃后 status 应变为 stopped', async () => {
    // 确保 elf-002 已停止
    await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-002/stop`, { method: 'POST' });
    await new Promise(r => setTimeout(r, 500));

    // 启动 elf-002
    const startRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-002/start`, {
      method: 'POST'
    });
    assert.equal(startRes.status, 200);
    await new Promise(r => setTimeout(r, 2000));

    // 确认 running
    const statusBefore = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-002`);
    const dataBefore = await statusBefore.json();
    assert.equal(dataBefore.status, 'running');

    // 通过 ProcessManager 找到 PID 并 SIGKILL 模拟崩溃
    const agentInternal = pm.agents.get('elf-002');
    assert.ok(agentInternal, '应存在于 agents Map 中');
    assert.ok(agentInternal.pid, `应有 pid，实际为 ${agentInternal.pid}`);

    // SIGKILL 进程模拟崩溃
    try {
      process.kill(agentInternal.pid, 'SIGKILL');
    } catch (e) {
      // 进程可能已退出
    }

    // 等待进程退出
    await new Promise(r => setTimeout(r, 1000));

    // 通过探活刷新状态
    await pm.probeAgent('elf-002');

    // 验证 status 变为 stopped
    const statusAfter = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-002`);
    const dataAfter = await statusAfter.json();
    assert.equal(dataAfter.status, 'stopped', 'Agent 崩溃后 status 应为 stopped');
  });

  it('配置热加载：修改文件后 Agent 应自动重载配置', async () => {
    // 确保 elf-001 在运行
    let statusRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001`);
    let statusData = await statusRes.json();
    if (statusData.status !== 'running') {
      await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/start`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 2000));
    }

    // 读取原始配置
    const origConfigRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/config`);
    const origConfig = await origConfigRes.json();
    const origLimit = origConfig.memoryTokenLimit;

    // 通过 API 更新 memoryTokenLimit（写文件 → 触发 fs.watch → 热加载）
    const newLimit = origLimit === 8000 ? 12000 : 8000;
    const putRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryTokenLimit: newLimit })
    });
    assert.equal(putRes.status, 200);

    // 等待 fs.watch 回调触发 + 热加载完成
    await new Promise(r => setTimeout(r, 500));

    // 验证：通过 Agent 的 /config 端点确认内存中配置已更新
    const agentConfigRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/config`);
    const agentConfig = await agentConfigRes.json();
    assert.equal(agentConfig.memoryTokenLimit, newLimit,
      `热加载后 memoryTokenLimit 应为 ${newLimit}，实际为 ${agentConfig.memoryTokenLimit}`);

    // 恢复
    await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryTokenLimit: origLimit })
    });
  });
});