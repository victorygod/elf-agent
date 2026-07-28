/**
 * 集成测试 — Agent + Gateway 协作功能
 * 使用 MockModel，不依赖真实 LLM API
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

// profiles 根隔离到 tmpDir：logger.js 顶层在 import 阶段就求值 logsDir()→profilesRoot() 并缓存，
//   必须在 import gateway 模块（触发 logger）之前设 env，否则 _root 锁死成真实 cwd/profiles。
//   agent 子进程 spawn 时继承此 env，data 同样落 tmpDir/profiles，端到端不污染真实项目目录。
const __profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-int-profiles-'));
process.env.ELF_PROFILES_ROOT = __profilesRoot;

// 集成测试需要实际的 Agent 进程运行，检查 gateway 模块是否存在
let ProcessManager, createGatewayApp;
try {
  const pm = await import('../gateway/process_manager.js');
  ProcessManager = pm.ProcessManager;
  const server = await import('../gateway/server.js');
  createGatewayApp = server.createGatewayApp;
} catch (e) {
  // gateway 模块不存在时跳过
}

const GATEWAY_PORT = 9880;

let gatewayServer, pm;

describe('Agent + Gateway 集成测试', () => {
  before(async () => {
    // 强制子进程用 mock model：不连真实 LLM、秒回、无网络依赖；同时让 Config 跳过 api_key 必填校验。
    // 子进程经 ProcessManager spawn 继承本测试进程的 env。
    process.env.ELF_FORCE_MOCK_MODEL = '1';
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
    // v3：注入 roomManager + 私聊房历史，供 /rooms/* 路由（含私聊 chat-<id>）。
    //   roomsDir 走 profilesRoot 下的 roomsRoot()，与 agent data（ELF_DATA_DIR=agentMemory）同根，snapshot 跨两根一致。
    const { RoomManager } = await import('../gateway/room_bus.js');
    const { ChatHistory } = await import('../gateway/chat_history.js');
    const { roomsRoot, _resetProfilesRoot } = await import('../shared/profiles_paths.js');
    _resetProfilesRoot();   // 确保读已有 env
    const roomsDir = roomsRoot();
    try { fs.mkdirSync(roomsDir, { recursive: true }); } catch (e) {}
    const roomManager = new RoomManager(roomsDir, GATEWAY_PORT, { pm, gatewayUrl: `http://127.0.0.1:${GATEWAY_PORT}` });
    const privateRoomHistory = new ChatHistory(roomsDir, roomsDir, { roomMode: true, roomsDir });
    pm.privateRoomHistory = privateRoomHistory;
    pm._gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}`;
    const app = createGatewayApp(pm, roomManager, { privateRoomHistory });
    await new Promise((resolve) => {
      gatewayServer = app.listen(GATEWAY_PORT, resolve);
    });
  });

  after(async () => {
    // ① 立即断开所有 events 长连接
    //    每个 Agent 都有独立的 connectAgentEvents + AbortController。
    //    abort 后所有 setTimeout 回调因 signal.aborted 而静默退出，
    //    彻底切断 events 重连链，防止 node --test 进程卡住无法退出。
    if (pm) {
      try {
        const { disconnectAgentEvents } = await import('../gateway/agent_events.js');
        for (const [id] of pm.agents) {
          disconnectAgentEvents(id);
        }
      } catch (e) { /* agent_events 不可用不阻塞后续清理 */ }
    }

    // ② 优雅停止所有 Agent（给 /shutdown 2 秒超时）
    for (const [, agent] of pm?.agents ?? []) {
      try {
        await fetch(`http://127.0.0.1:${agent.port}/shutdown`, {
          method: 'POST',
          signal: AbortSignal.timeout(2000),
        });
      } catch { /* Agent 可能未运行或已崩溃 */ }
    }
    await new Promise(r => setTimeout(r, 500));

    // ③ 兜底：强制 kill 仍占端口的进程
    for (const [id, agent] of pm?.agents ?? []) {
      try {
        execSync(`lsof -ti :${agent.port} -sTCP:LISTEN | xargs kill -9 2>/dev/null || true`, {
          stdio: 'ignore',
        });
      } catch { /* 忽略 */ }
    }

    // ④ 关闭 Gateway 服务器
    if (gatewayServer) {
      await new Promise(resolve => gatewayServer.close(resolve));
    }

    // ⑤ 清理隔离的 profiles 临时目录
    try { fs.rmSync(__profilesRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    delete process.env.ELF_PROFILES_ROOT;
    delete process.env.ELF_FORCE_MOCK_MODEL;
  });

  it('启动 Agent 后应能通过 Gateway 对话，SSE 事件格式完整', async () => {
    const startRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/start`, {
      method: 'POST'
    });
    assert.equal(startRes.status, 200);
    await new Promise(r => setTimeout(r, 2500));

    // v3：私聊走 /rooms/chat-<id>/subscribe + /say，token 经 gateway /events 转发
    const sseRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/chat-elf-001/subscribe`);
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
    await readNext();
    const sayRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/chat-elf-001/say`, {
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
    assert.ok(names.includes('done'), `应包含 done 事件，实际 ${names.join(',')}`);
    assert.ok(names.includes('token') || names.includes('status'), `应包含 token/status，实际 ${names.join(',')}`);
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
    await new Promise(r => setTimeout(r, 2500));

    // v3：经私聊房 /say 验证可对话
    const chatRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/chat-elf-001/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '你好' }),
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

  it('停止 Agent 后应不可对话（503）', async () => {
    await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-002/stop`, { method: 'POST' });
    await new Promise(r => setTimeout(r, 800));

    const chatRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/chat-elf-002/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '你好' }),
    });
    // v3：agent 未运行 → /rooms/chat-<id>/say 503
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
  // ===== v3 私聊房路由（合并到本套件，复用同一 gateway/pm，避免多 suite 抢 agent 端口）=====

  it('v3 私聊 /rooms/chat-elf-001/say 流式 token + done 经 subscribe 到达', async () => {
    // 确保 elf-001 在运行
    let st = await (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001`)).json();
    if (st.status !== 'running') {
      const r = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/start`, { method: 'POST' });
      assert.equal(r.status, 200);
      await new Promise(r => setTimeout(r, 2500));
    }
    // 建 subscribe SSE 连接
    const sseRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/chat-elf-001/subscribe`);
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
    const sayRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/chat-elf-001/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'v3私聊你好' }),
    });
    assert.equal(sayRes.status, 200);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !events.some(e => e.event === 'done')) {
      await Promise.race([readNext(), new Promise(r => setTimeout(r, 50))]);
    }
    try { reader.cancel(); } catch (e) {}
    const names = events.map(e => e.event);
    assert.ok(names.includes('snapshot'), `应收到 snapshot，实际 ${names.join(',')}`);
    assert.ok(names.includes('token') || names.includes('status'), `应收到 token/status，实际 ${names.join(',')}`);
    assert.ok(names.includes('done'), `应收到 done，实际 ${names.join(',')}`);
  });

  it('v3 建群复用 pm 进程（不额外 spawn）+ 历史写入', async () => {
    // 确保两个 agent 运行
    for (const id of ['elf-001', 'elf-002']) {
      let s = await (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/${id}`)).json();
      if (s.status !== 'running') {
        await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/${id}/start`, { method: 'POST' });
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    const before = await (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001`)).json();
    const portBefore = before.port;
    // 建群（经 RoomManager.ensureAgentPresent 复用 pm 进程）
    const createRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'v3集成群', members: ['elf-001', 'elf-002'] }),
    });
    const room = await createRes.json();
    assert.ok(room.roomId, '建群成功');
    await new Promise(r => setTimeout(r, 800));
    // 复用验证：elf-001 端口不变（未 spawn 新进程）
    const after = await (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001`)).json();
    assert.equal(after.port, portBefore, '群聊复用 agent 进程，端口不变');
    // 用户发言 @elf-001 → 经 /observe 路由到 elf-001 进程的群 RoomState
    const sayRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/${room.roomId}/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'user' },
      body: JSON.stringify({ content: '@elf-001 你好' }),
    });
    assert.equal(sayRes.status, 200);
    // 等 reasoning + Speak 回调 gateway /rooms/:rid/say 落群历史
    //   MockModel 在 tools 含 Speak 时回 Speak tool_call（见 mock_model.js），故 mock 也能走完 Speak 全链。
    //   修复前 @elm-001 因 roomBusUrl 缺失 Speak 报错 → 无回复；本断言锁 Speak→广播→落 history 全链。
    const deadline = Date.now() + 10000;
    let elmSpoke = false;
    while (Date.now() < deadline && !elmSpoke) {
      await new Promise(r => setTimeout(r, 700));
      const histRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/${room.roomId}/history`);
      const hist = await histRes.json();
      elmSpoke = !!(hist.messages || []).some(m => m.speakerUid === 'elf-001' || m.speaker === 'elf-001');
    }
    assert.ok(elmSpoke, '@elm-001 后 elm-001 应经 Speak 回复并落群历史（roomBusUrl 修复 + Speak 全链验证）');
  });

  it('v3 私聊 /rooms/chat-elf-001/rewind 重建私聊房 history（前端 rewind 同步正确性）', async () => {
    let st = await (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001`)).json();
    if (st.status !== 'running') {
      await fetch(`http://127.0.0.1:${GATEWAY_PORT}/agents/elf-001/start`, { method: 'POST' });
      await new Promise(r => setTimeout(r, 2500));
    }
    // 第 1 条用户消息：snapshotBeforeSend 记下「说话前」私聊房 history 快照
    const say1 = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/chat-elf-001/say`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'rewind-A' }),
    });
    assert.equal(say1.status, 200);
    await new Promise(r => setTimeout(r, 1200));
    // 此时私聊房 history 应含 rewind-A
    let hist = await (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/chat-elf-001/history`)).json();
    assert.ok(hist.messages.some(m => m.content === 'rewind-A'), `rewind 前 history 应含 rewind-A，实际 ${JSON.stringify(hist.messages.map(m=>m.content))}`);
    // rewind 最近一个 checkpoint（回到 rewind-A 发出之前）
    const rwRes = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/chat-elf-001/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(rwRes.status, 200);
    const rwData = await rwRes.json();
    assert.equal(rwData.status, 'ok', `rewind 应返回 ok，实际 ${JSON.stringify(rwData)}`);
    // ★ 修复验证：rewind 后私聊房 history 不再含 rewind-A（snapshot 覆盖回写 room-history.jsonl）
    hist = await (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/rooms/chat-elf-001/history`)).json();
    assert.ok(!hist.messages.some(m => m.content === 'rewind-A'), `rewind 后 history 不应含 rewind-A，实际 ${JSON.stringify(hist.messages.map(m=>m.content))}`);
  });
});
