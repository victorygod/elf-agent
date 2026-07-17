/**
 * 运行时身份（runContext）测试 —— 实例化改造
 *
 * 覆盖：
 * - buildRunContext 各形态（private / room）
 * - room 模式 fail-fast（缺 roomId / dataDir → 抛错，不静默回退私聊）
 * - Agent 构造器 runContext 可选（向后兼容：new Agent 无 runContext）
 * - /status 返回 runKey/mode（保留 agentId/pid 兼容）
 *
 * 用 MockModel，不依赖真实 LLM API。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildRunContext, buildPrivateRunContext } from '../shared/agent/run_context.js';
import { Config } from '../shared/agent/config_loader.js';
import { MockModel } from '../shared/agent/mock_model.js';
import { ToolRegistry } from '../shared/agent/tools/registry.js';
import { MessageManager } from '../shared/agent/message_manager.js';
import { Agent } from '../shared/agent/default_agent.js';
import { createAgentServer } from '../shared/agent/server.js';

/** 造临时 config 目录（仿 agent.test.js 风格） */
function makeConfigDir(agentId, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rc-'));
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    agentId,
    name: agentId,
    port,
    provider: 'mock',
    systemPrompt: 'test',
    tools: [],
  }));
  return configDir;
}

describe('buildRunContext', () => {
  it('private 模式：runKey=agentId，room 字段为 null', () => {
    const rc = buildRunContext({ agentId: 'elf-001', mode: 'private', port: 8081 });
    assert.equal(rc.runKey, 'elf-001');
    assert.equal(rc.mode, 'private');
    assert.equal(rc.port, 8081);
    assert.equal(rc.dataDir, null);
    assert.equal(rc.roomId, null);
    assert.equal(rc.memberName, null);
    assert.equal(rc.roomBusUrl, null);
  });

  it('room 模式（全参）：runKey=roomId/agentId，memberName 缺省回退 agentId', () => {
    const rc = buildRunContext({
      agentId: 'elf-001', mode: 'room', port: 9001,
      dataDir: '/tmp/x', roomId: 'roomA',
    });
    assert.equal(rc.runKey, 'roomA/elf-001');
    assert.equal(rc.mode, 'room');
    assert.equal(rc.roomId, 'roomA');
    assert.equal(rc.memberName, 'elf-001'); // 缺省回退
    assert.equal(rc.dataDir, '/tmp/x');
  });

  it('room 模式显式 memberName 生效', () => {
    const rc = buildRunContext({
      agentId: 'elf-001', mode: 'room', port: 9001,
      dataDir: '/tmp/x', roomId: 'roomA', memberName: '小明',
    });
    assert.equal(rc.memberName, '小明');
  });

  it('mode 非 room/private 静默降级 private（安全默认）', () => {
    const rc = buildRunContext({ agentId: 'x', mode: 'whatever', port: 1 });
    assert.equal(rc.mode, 'private');
    assert.equal(rc.runKey, 'x');
  });

  it('缺 agentId 抛错', () => {
    assert.throws(() => buildRunContext({}), /agentId 必填/);
  });

  // —— room 模式 fail-fast：防 #1/#2 —— 静默回退私聊会破坏数据/身份碰撞

  it('room 模式缺 roomId → fail-fast（防 #2 身份碰撞）', () => {
    assert.throws(
      () => buildRunContext({ agentId: 'elf-001', mode: 'room', port: 9001, dataDir: '/tmp/x' }),
      /room 模式必须提供 roomId/
    );
  });

  it('room 模式缺 dataDir → fail-fast（防 #1 数据破坏）', () => {
    assert.throws(
      () => buildRunContext({ agentId: 'elf-001', mode: 'room', port: 9001, roomId: 'roomA' }),
      /room 模式必须提供 dataDir/
    );
  });
});

describe('buildPrivateRunContext', () => {
  it('构造私聊默认形态', () => {
    const rc = buildPrivateRunContext('elf-002', 8082);
    assert.equal(rc.runKey, 'elf-002');
    assert.equal(rc.mode, 'private');
    assert.equal(rc.port, 8082);
  });
});

describe('Agent 构造器 runContext 向后兼容', () => {
  it('new Agent 不传 runContext → this.runContext === null（现有测试/私聊零回归）', () => {
    const configDir = makeConfigDir('compat-agent', 9999);
    const config = new Config(configDir);
    config.load();
    const agent = new Agent({
      config,
      model: new MockModel({ responses: [{ content: 'ok' }] }),
      toolRegistry: new ToolRegistry(),
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }),
    });
    assert.equal(agent.runContext, null);
  });

  it('new Agent 传 runContext → 挂载到实例', () => {
    const configDir = makeConfigDir('rc-agent', 9998);
    const config = new Config(configDir);
    config.load();
    const rc = buildPrivateRunContext('rc-agent', 9998);
    const agent = new Agent({
      config,
      model: new MockModel({ responses: [{ content: 'ok' }] }),
      toolRegistry: new ToolRegistry(),
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }),
      runContext: rc,
    });
    assert.equal(agent.runContext, rc);
    assert.equal(agent.runContext.runKey, 'rc-agent');
  });
});

describe('/status 返回 runKey/mode（保留 agentId/pid 兼容）', () => {
  let server, port;

  before(async () => {
    port = 9300 + Math.floor(Math.random() * 100);
    const configDir = makeConfigDir('status-agent', port);
    const config = new Config(configDir);
    config.load();
    const rc = buildRunContext({ agentId: 'status-agent', mode: 'room', port, dataDir: '/tmp/x', roomId: 'roomS', memberName: 'SA' });
    const agent = new Agent({
      config,
      model: new MockModel({ responses: [{ content: 'ok' }] }),
      toolRegistry: new ToolRegistry(),
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }),
      runContext: rc,
    });
    const app = createAgentServer(agent, config);
    await new Promise(r => { server = app.listen(port, r); });
  });

  after(async () => { if (server) await new Promise(r => server.close(r)); });

  it('返回 runKey=roomS/status-agent, mode=room, 且保留 agentId/pid', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.agentId, 'status-agent');  // 兼容字段保留
    assert.equal(data.runKey, 'roomS/status-agent');  // 新字段
    assert.equal(data.mode, 'room');
    assert.equal(typeof data.pid, 'number');
  });
});

describe('/status 无 runContext 时回退（直构造，无 startAgent 注入）', () => {
  let server, port;

  before(async () => {
    port = 9500 + Math.floor(Math.random() * 100);
    const configDir = makeConfigDir('fallback-agent', port);
    const config = new Config(configDir);
    config.load();
    // 不传 runContext（模拟旧测试/直接 new Agent）
    const agent = new Agent({
      config,
      model: new MockModel({ responses: [{ content: 'ok' }] }),
      toolRegistry: new ToolRegistry(),
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }),
    });
    const app = createAgentServer(agent, config);
    await new Promise(r => { server = app.listen(port, r); });
  });

  after(async () => { if (server) await new Promise(r => server.close(r)); });

  it('runKey 回退 agentId，mode 回退 private', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    const data = await res.json();
    assert.equal(data.runKey, 'fallback-agent');  // 回退
    assert.equal(data.mode, 'private');
  });
});