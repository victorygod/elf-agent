/**
 * 私聊 sync 单测 + 离线补回 / 连发相同内容回归测试
 *
 * 背景：基类 Agent 的 _alignSeq/_fillGap/_seedCursor 此前零单测覆盖，且私聊路径因
 *   runContext.dataDir=null 而"假死"（_ensureSync 建不出 SyncCursor，整条 sync 短路）。
 * 本测试注入真实 dataDir + mock gateway sync-history 服务，驱动真实 sync 逻辑，锁住现状。
 *
 * 用 MockModel，不依赖真实 LLM API。
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Agent } from '../engine/agent.js';
import { RoomMiddleware } from '../engine/plugins/room_plugin.js';
import { PrivateChatMiddleware } from '../engine/plugins/private_chat_plugin.js';
import { MockModel } from '../engine/models/index.js';
import { ToolManager } from '../engine/tools/tool_manager.js';
import { MessageManager } from '../engine/message_manager.js';
import { buildRunContext } from '../engine/run_context.js';

/** 收集 callback emit 的所有事件。fn 接收 emit、内部 await agent.receive(msg, {emit}) */
async function collect(fn) {
  const events = [];
  await fn(e => events.push(e));
  return events;
}

/**
 * 起一个 mock gateway，实现私聊 + room sync-history。
 * seed=true → 返回 latestSeq；afterSeq=N → 返回 seq>N 的消息。
 * @param {string} agentId
 * @param {{latestSeq?: number, history?: Array}} store — history 项: {seq, role, content, speaker?, mentions?}
 */
function startMockGateway(agentId, store) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // GET /agents/:id/sync-history?seed=true | afterSeq=N — 私聊（只返回 role==='user'）
    const mPriv = url.pathname.match(/^\/agents\/([^/]+)\/sync-history$/);
    if (req.method === 'GET' && mPriv && mPriv[1] === agentId) {
      const seed = url.searchParams.get('seed') === 'true';
      const afterSeq = parseInt(url.searchParams.get('afterSeq') || '0', 10);
      if (seed) return _json(res, { messages: [], latestSeq: store.latestSeq ?? 0 });
      const msgs = (store.history || [])
        .filter(m => (m.seq ?? 0) > afterSeq && m.role === 'user')
        .map(m => ({ seq: m.seq, role: m.role, content: m.content, id: `msg_${m.seq}` }));
      return _json(res, { messages: msgs, latestSeq: store.latestSeq ?? 0 });
    }

    // GET /rooms/:rid/sync-history/:aid?seed=true | afterSeq=N — room（返回全部 speak，带 mentions）
    const mRoom = url.pathname.match(/^\/rooms\/([^/]+)\/sync-history\/([^/]+)$/);
    if (req.method === 'GET' && mRoom && mRoom[2] === agentId) {
      const seed = url.searchParams.get('seed') === 'true';
      const afterSeq = parseInt(url.searchParams.get('afterSeq') || '0', 10);
      if (seed) return _json(res, { messages: [], latestSeq: store.latestSeq ?? 0 });
      const msgs = (store.history || [])
        .filter(m => (m.seq ?? 0) > afterSeq)
        .map(m => ({ seq: m.seq, speaker: m.speaker, content: m.content, mentions: m.mentions || [], id: `rmsg_${m.seq}` }));
      return _json(res, { messages: msgs, latestSeq: store.latestSeq ?? 0 });
    }

    res.writeHead(404); res.end();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function _json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/** 构造一个私聊 Agent。
 *  alive=false：现状假死（runContext.dataDir=null，_ensureSync 建不出 cursor）
 *  alive=true：接活（runContext.dataDir 注入真实 dataDir，sync 真跑）
 */
function makePrivateAgent({ dataDir, gatewayUrl, alive = false, responses = [{ content: '回复' }] }) {
  const config = {
    get: (k) => ({ agentId: 'elf-test', port: 9999, maxIterations: 5, memoryTokenLimit: 9999 })[k],
    getModelConfig: () => ({ provider: 'mock' }),
    getModelMissingFields: () => null,
  };
  const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 9999, dataDir, config });
  const model = new MockModel({ responses });
  const tr = new ToolManager();
  // alive=true 时给私聊 runContext 注入 dataDir（对齐"接活后 _ensureSync 用真实 dataDir"）。
  //   buildRunContext 私聊模式不会 fail-fast 校验 dataDir，直接塞即可。
  const rc = buildRunContext({ agentId: 'elf-test', mode: 'private', port: 9999, roomId: 'chat-elf-test' });
  if (alive) rc.dataDir = dataDir;
  const agent = new Agent({ config, model, toolManager: tr, messageManager: mm, runContext: rc });
  agent._gatewayUrl = gatewayUrl;  // 注入 sync 源（PrivateChatMiddleware._ensureSyncSource 读用）
  // 阶段二：私聊 syncSource 接入迁 PrivateChatMiddleware（对齐 start.js 注入）
  const pcm = new PrivateChatMiddleware(agent);
  agent._scene = pcm;      // 场景 middleware 作 agent 属性（对齐生产 start.js）
  agent._pcm = pcm;   // 测试便捷引用
  return agent;
}

describe('私聊 sync（现状：假死）+ 接活后行为', () => {
  let gw, store;
  const agentId = 'elf-test';
  let tmpDir;

  before(async () => {
    store = { latestSeq: 0, history: [] };
    gw = await startMockGateway(agentId, store);
  });
  after(async () => { if (gw?.server) await new Promise(r => gw.server.close(r)); });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-pvt-sync-'));
    store.latestSeq = 0;
    store.history = [];
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  });

  it('现状：私聊 runContext.dataDir=null，syncSource 建不出（但 messageManager.dataDir 仍让接活可用）', async () => {
    // 注：接活后 syncSource 用 messageManager.dataDir（非 runContext.dataDir），所以 alive=true 时总会建。
    //   此用例改为验证"无 _gatewayUrl 时 syncSource 能建但 align 不发请求、不崩"。
    const a = makePrivateAgent({ dataDir: tmpDir, gatewayUrl: null, alive: true });
    await collect(emit => a.receive({ content: '你好', seq: 1, role: 'chat' }, { emit }));
    assert.ok(a.syncSource, 'syncSource 已建（用 MM dataDir）');
    // 无 gatewayUrl → seed 拉取短路，cursor 仍 null；消息进了 context
    assert.equal(a.messageManager.messages.filter(m => m.role === 'user').length, 1);
  });

  it('接活主分支：cursor 连续（cursor+1===seq）不补洞，直接进 context', async () => {
    const a = makePrivateAgent({ dataDir: tmpDir, gatewayUrl: gw.url, alive: true });
    a._pcm._ensureSyncSource();   // 提前建 syncSource
    // seed 把 cursor 置成 latestSeq=0
    store.latestSeq = 0;
    await a.syncSource.seed();
    // 收 seq=1，cursor=0，1===0+1 连续，不补洞
    const events = await collect(emit => a.receive({ content: '你好', seq: 1, role: 'chat' }, { emit }));
    assert.ok(events.some(e => e.event === 'done'), '应正常结束');
    const users = a.messageManager.messages.filter(m => m.role === 'user');
    assert.equal(users.length, 1, '只进当前消息一条');
    assert.equal(users[0].content, '你好');
  });

  it('离线补回回归：cursor 落后，fillGap 补回漏掉的 user 消息进 context', async () => {
    // 场景 B：gateway 里已有 seq=3,5 的 user 消息（agent 离线时用户发的），
    //   agent 上线后 cursor=2，收到 seq=6 → fillGap(3,5) 应补回 seq=3,5 两条 user。
    store.history = [
      { seq: 3, role: 'user', content: 'm3' },
      { seq: 4, role: 'assistant', content: 'a4' },
      { seq: 5, role: 'user', content: '离线发的' },
      { seq: 6, role: 'user', content: '上线后第一条' },
    ];

    const a = makePrivateAgent({ dataDir: tmpDir, gatewayUrl: gw.url, alive: true });
    a._pcm._ensureSyncSource();
    a.syncSource.advance(2);   // cursor=2（模拟"重启前只处理到 2"）
    assert.equal(a.syncSource.getCursor(), 2, 'cursor=2');

    store.latestSeq = 6;
    // 收 seq=6：6 !== 2+1=3 → fillGap(3,5)
    await collect(emit => a.receive({ content: '上线后第一条', seq: 6, role: 'chat' }, { emit }));

    const users = a.messageManager.messages.filter(m => m.role === 'user').map(m => m.content);
    assert.ok(users.includes('m3'), '应补回 seq=3 的 user 消息');
    assert.ok(users.includes('离线发的'), '应补回 seq=5 的离线 user 消息');
    assert.ok(users.includes('上线后第一条'), '当前消息应进 context');
  });

  // ⚠️ 此测试现状会红（内容去重静默丢消息）—— SyncSource 重构（删内容去重）后转绿。
  //    重构完成后删掉 .skip，让它成为永久回归门。
  it('连发相同内容不丢消息（重构删内容去重后应转绿）', async () => {
    // 场景：pre-added seq=1 "嗯"。cursor=1，收 seq=4 "现在"，fillGap(2,3) 应补回 seq=2,3 两条 "嗯"。
    //   现状（内容去重）：补 seq=2 时 context 已有 "嗯"(pre) → existingUserContents 命中 → 跳过；seq=3 同理。
    //     结果 context = ['嗯'(pre), '现在'(当前)]，seq=2,3 的"嗯"静默丢失。
    //   接活+删内容去重后：seq=2,3 正常补回，context = ['嗯','嗯','嗯','现在']，4 条 user。
    store.history = [
      { seq: 2, role: 'user', content: '嗯' },
      { seq: 3, role: 'user', content: '嗯' },
      { seq: 4, role: 'user', content: '现在' },
    ];

    const a = makePrivateAgent({ dataDir: tmpDir, gatewayUrl: gw.url, alive: true });
    a.messageManager.addUserMessage('嗯');   // pre-added seq=1
    a._pcm._ensureSyncSource();
    a.syncSource.advance(1);                 // cursor=1

    store.latestSeq = 4;
    await collect(emit => a.receive({ content: '现在', seq: 4, role: 'chat' }, { emit }));

    const users = a.messageManager.messages.filter(m => m.role === 'user');
    // 接活+去重后应 4 条：pre(1) + 补回(2,3) + 当前(4=现在)
    assert.equal(users.length, 4, `应 4 条 user（pre + 补回2条 + 当前），实际=${users.length}；` +
      `内容=${JSON.stringify(users.map(m => m.content))}`);
  });
});

describe('Room fillGap 真实拉取（此前靠 roomBusUrl 为空短路，无真实拉取单测）', () => {
  let gw, store;
  const agentId = 'elf-001';
  let tmpDir;

  before(async () => {
    store = { latestSeq: 0, history: [] };
    gw = await startMockGateway(agentId, store);
  });
  after(async () => { if (gw?.server) await new Promise(r => gw.server.close(r)); });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-room-sync-'));
    store.latestSeq = 0;
    store.history = [];
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  });

  function makeRoom({ memberName = 'elf-001', responses = [{ content: '回复' }], withSpeak = false } = {}) {
    const config = { get: (k) => ({ agentId, port: 9999, maxIterations: 5, memoryTokenLimit: 8000 })[k] };
    const mm = new MessageManager({ systemPrompt: '你是 elf-001', memoryTokenLimit: 8000, dataDir: tmpDir });
    const tr = new ToolManager();
    if (withSpeak) {
      tr.register({
        name: 'Speak', description: '占位',
        parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        callSummary: (a) => '', statusEvent: { state: 'speaking', detail: () => '' },
        execute: async () => '已发言',
      });
    }
    const rc = buildRunContext({ agentId, mode: 'room', port: 9999, dataDir: tmpDir, roomId: 'roomA', memberName });
    // roomBusUrl 对齐 gateway 实际形态：http://<host>/rooms/<rid>。SyncSource 拼 sync URL = `${roomBusUrl}/sync-history/${agentId}`。
    rc.roomBusUrl = `${gw.url}/rooms/roomA`;
    // _refreshRoster 会 fetch roomBusUrl（GET /rooms/:rid 拿成员）。mock 不实现该路由，
    // 返回 404 → _refreshRoster 静默失败（不阻断），_agentNames 为空 → _parse 用 from 原值作前缀。
    // 基类 Agent + RoomMiddleware 直推（对齐生产 start.js，不经 RoomAgent）。a._rm 持 RoomMiddleware 引用。
    const a = new Agent({ config, model: new MockModel({ responses }), toolManager: tr, messageManager: mm, runContext: rc });
    const rm = new RoomMiddleware(a);
    a._scene = rm;      // 场景 middleware 作 agent 属性（对齐生产 start.js）
    a._rm = rm;
    rm.ensureState();
    return a;
  }

  it('_fillGap 从 mock 拉取 speak 消息，push buffer + 追踪 mention', async () => {
    store.history = [
      { seq: 3, speaker: 'user', content: '@elf-001 hi', mentions: ['elf-001'] },
      { seq: 4, speaker: 'elf-002', content: 'm4', mentions: [] },
    ];
    store.latestSeq = 4;
    const a = makeRoom();
    a.syncSource.advance(2);   // cursor=2，补 3..4

    await a.syncSource._fillGap(3, 4);

    assert.equal(a._rm._buffer.length, 2, '应补回 2 条进 buffer');
    assert.ok(a._rm._bufferHasMention, 'seq=3 @了 elf-001，bufferHasMention 应 true');
    assert.equal(a.syncSource.getCursor(), 4, 'fillGap 完应推进 cursor 到 4');
    assert.ok(a._rm._processedSeqs.has(3) && a._rm._processedSeqs.has(4), '两条 seq 进 _processedSeqs');
  });

  it('_fillGap 过滤自消息（speaker===memberName）', async () => {
    store.history = [
      { seq: 3, speaker: 'elf-001', content: '我之前说的', mentions: [] },  // 自消息，跳过
      { seq: 4, speaker: 'user', content: 'user说的', mentions: [] },
    ];
    store.latestSeq = 4;
    const a = makeRoom();
    a.syncSource.advance(2);

    await a.syncSource._fillGap(3, 4);

    assert.equal(a._rm._buffer.length, 1, '自消息 seq=3 跳过，只补 seq=4');
    assert.ok(a._rm._buffer[0].includes('user说的'), 'buffer 里是 user 那条');
    assert.ok(!a._rm._processedSeqs.has(3), '自消息 seq=3 不进 _processedSeqs');
    assert.ok(a._rm._processedSeqs.has(4), 'seq=4 进 _processedSeqs');
  });

  it('_alignSeq：cursor 落后触发 _fillGap 补洞', async () => {
    store.history = [
      { seq: 3, speaker: 'user', content: '漏的', mentions: [] },
    ];
    store.latestSeq = 5;
    const a = makeRoom();
    a.syncSource.advance(2);   // cursor=2

    // align(5)：5 !== 2+1=3 → fillGap(3,4)；history 里只有 seq=3，补回 1 条；随后 receive 会处理 seq=5
    await a.syncSource.align(5);

    assert.equal(a._rm._buffer.length, 1, 'align 补回 seq=3 到 buffer');
    assert.equal(a.syncSource.getCursor(), 4, 'cursor 推进到 toSeq=4');
  });

  it('_alignSeq：seq>=cursor+2 但 history 空（未命中），不崩、cursor 不动', async () => {
    store.history = [];   // mock 返回空 messages
    store.latestSeq = 5;
    const a = makeRoom();
    a.syncSource.advance(2);

    await a.syncSource.align(5);
    // _fillGap 拉回空 → 不补；同步源 fillGap 内部不会推进 cursor（room_agent.js 现状：拉空时 return）
    assert.equal(a._rm._buffer.length, 0, '无可补消息，buffer 空');
  });

  it('seq 去重：_fillGap 补过的 seq，再次进 receive 不重复入 buffer', async () => {
    // 双通道场景：fillGap 先补了 seq=3，随后 /observe 又把 seq=3 推来
    store.history = [{ seq: 3, speaker: 'user', content: 'm3', mentions: [] }];
    store.latestSeq = 3;
    const a = makeRoom();
    a.syncSource.advance(2);
    await a.syncSource._fillGap(3, 3);
    assert.equal(a._rm._buffer.length, 1);

    // 模拟 /observe 通道再次投递 seq=3：直接调 receive（自消息过滤?不命中，进 _processedSeqs 判定）
    await collect(emit => a.receive({ from: 'user', content: 'm3', mentions: [], role: 'chat', seq: 3 }, { emit }));
    assert.equal(a._rm._buffer.length, 1, '同 seq 不应重复入 buffer（_processedSeqs 去重生效）');
  });
});
