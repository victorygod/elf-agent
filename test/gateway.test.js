/**
 * Gateway 子系统测试
 * 使用 MockModel，不依赖真实 LLM API
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';

// profiles 根隔离到 tmpDir（仿 integration.test.js），防 gateway test 写真实 cwd/rooms、cwd/profiles。
const __profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-gw-profiles-'));
process.env.ELF_PROFILES_ROOT = __profilesRoot;
import path from 'path';
import { _resetProfilesRoot, roomsRoot } from '../shared/profiles_paths.js';
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

  it('loadGatewayConfig 返回端口与密钥（多用户：用户字段已移 profiles/users/，见 auth.js）', () => {
    const config = loadGatewayConfig();
    // 密钥经 env 注入（setup-env.js），不入库、不写真实 gateway.json
    assert.ok(config.jwtSecret && config.jwtSecret.length >= 32, 'jwtSecret 应存在');
    assert.ok(config.internalToken && config.internalToken.length >= 32, 'internalToken 应存在');
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
    // v4：共享 agent-server 模型下，agent.port = 共享 server 端口，server 未起时为 null（不再是 per-agent config.port）。
    assert.equal(agent.port, null);
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
    // v3：注入 roomManager + 私聊房历史，挂 /rooms/chat-<id>/* 路由。roomsDir 走 profilesRoot 隔离。
    _resetProfilesRoot();   // 确保读已设的 ELF_PROFILES_ROOT
    const { RoomManager } = await import('../gateway/room_bus.js');
    const { ChatHistory } = await import('../gateway/chat_history.js');
    const roomsDir = roomsRoot();
    try { fs.mkdirSync(roomsDir, { recursive: true }); } catch (e) {}
    const roomManager = new RoomManager(roomsDir, testPort, { pm, gatewayUrl: `http://127.0.0.1:${testPort}` });
    const privateRoomHistory = new ChatHistory(roomsDir, roomsDir, { roomMode: true, roomsDir });
    pm.privateRoomHistory = privateRoomHistory;
    pm._gatewayUrl = `http://127.0.0.1:${testPort}`;
    const app = createGatewayApp(pm, roomManager, { privateRoomHistory });
    await new Promise((resolve) => {
      server = app.listen(testPort, resolve);
    });
  });

  after(async () => {
    // v4：停共享 agent-server 进程（承载全部 agent 的单进程）。
    try { await pm.stopServer(); } catch (e) { /* 忽略 */ }
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
    delete process.env.ELF_PROFILES_ROOT;
    _resetProfilesRoot();
    try { fs.rmSync(__profilesRoot, { recursive: true, force: true }); } catch { /* ignore */ }
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
    // v4：共享 server 未启 → port null（该 it 在 start 之前运行）。
    assert.equal(data.port, null);
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
    const sseRes = await fetch(`http://127.0.0.1:${testPort}/rooms/chat-u_test-elf-001/subscribe`);
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
    const sayRes = await fetch(`http://127.0.0.1:${testPort}/rooms/chat-u_test-elf-001/say`, {
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
    const res = await fetch(`http://127.0.0.1:${testPort}/rooms/chat-u_test-elf-001/say`, {
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
    const chatRes = await fetch(`http://127.0.0.1:${testPort}/rooms/chat-u_test-elf-001/say`, {
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
    const res = await fetch(`http://127.0.0.1:${testPort}/rooms/chat-u_test-elf-001/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '你好' })
    });
    // v3：agent 未运行时私聊房 /say 直接拒绝（503），不再离线排队
    assert.equal(res.status, 503);
  });

  // ===== 语言风格 styles CRUD（elf-018）=====
  it('GET /agents/:id/styles 列出风格文件（含 default，body 已剥 frontmatter）', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/agents/elf-018/styles`);
    assert.equal(res.status, 200);
    const data = await res.json();
    const def = (data.styles || []).find((s) => s.filename === 'default_style.md');
    assert.ok(def, '应有 default_style.md');
    assert.equal(def.isDefault, true);
    assert.ok(def.description, 'default 带简介');
    assert.ok(def.body.includes('默认'), 'default 正文已剥 frontmatter');
  });

  it('styles CRUD：新建→改名→删除（throwaway 名，finally 兜底清理，不污染 canon）', async () => {
    const base = `http://127.0.0.1:${testPort}/agents/elf-018/styles`;
    const hdr = { 'Content-Type': 'application/json' };
    try {
      const post = await fetch(base, { method: 'POST', headers: hdr, body: JSON.stringify({ name: '_gwtest_a', description: '测试风格', body: '测试正文' }) });
      assert.equal(post.status, 200);
      assert.equal((await post.json()).filename, '_gwtest_a.md');

      const list1 = await (await fetch(base)).json();
      const got = list1.styles.find((s) => s.filename === '_gwtest_a.md');
      assert.ok(got, '新建后列表含 a');
      assert.equal(got.description, '测试风格');
      assert.ok(got.body.includes('测试正文'), '读回正文');

      const put = await fetch(`${base}/_gwtest_a.md`, { method: 'PUT', headers: hdr, body: JSON.stringify({ name: '_gwtest_b', description: '改名后', body: '正文改' }) });
      assert.equal(put.status, 200);
      assert.equal((await put.json()).filename, '_gwtest_b.md');
      const list2 = await (await fetch(base)).json();
      assert.ok(!list2.styles.some((s) => s.filename === '_gwtest_a.md'), '改名后旧名消失');
      assert.ok(list2.styles.some((s) => s.filename === '_gwtest_b.md'), '改名后新名出现');

      const del = await fetch(`${base}/_gwtest_b.md`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      const list3 = await (await fetch(base)).json();
      assert.ok(!list3.styles.some((s) => s.filename === '_gwtest_b.md'), '删除后列表不含 b');
    } finally {
      for (const f of ['_gwtest_a.md', '_gwtest_b.md']) {
        try { await fetch(`${base}/${f}`, { method: 'DELETE' }); } catch (e) { /* 兜底清理 */ }
      }
    }
  });

  it('styles 校验：default 不可删/不可新建、非法 name 400、description 必填 400、重名 409', async () => {
    const base = `http://127.0.0.1:${testPort}/agents/elf-018/styles`;
    const hdr = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/default_style.md`, { method: 'DELETE' })).status, 400, 'default 不可删');
    assert.equal((await fetch(base, { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'default_style', description: 'x', body: 'y' }) })).status, 400, 'default 不可新建');
    assert.equal((await fetch(base, { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'bad name', description: 'x', body: 'y' }) })).status, 400, '非法 name');
    assert.equal((await fetch(base, { method: 'POST', headers: hdr, body: JSON.stringify({ name: '_gwtest_c', description: '', body: 'y' }) })).status, 400, 'description 必填');
    try {
      assert.equal((await fetch(base, { method: 'POST', headers: hdr, body: JSON.stringify({ name: '_gwtest_d', description: 'd', body: 'b' }) })).status, 200);
      assert.equal((await fetch(base, { method: 'POST', headers: hdr, body: JSON.stringify({ name: '_gwtest_d', description: 'd', body: 'b' }) })).status, 409, '重名 409');
    } finally {
      try { await fetch(`${base}/_gwtest_d.md`, { method: 'DELETE' }); } catch (e) { /* 兜底清理 */ }
    }
  });
});