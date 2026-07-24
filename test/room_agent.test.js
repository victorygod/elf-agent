import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { MockModel } from '../engine/mock_model.js';
import { MessageManager } from '../engine/message_manager.js';
import { ToolManager } from '../engine/tools/tool_manager.js';
import { Agent } from '../engine/default_agent.js';
import { RoomMiddleware } from '../engine/room_plugin.js';
import { buildRunContext } from '../engine/run_context.js';
import { Speak as RealSpeak } from '../engine/tools/Speak.js';

function makeRoomAgent({ memberName = 'elf-001', agentId = 'elf-001', responses = [{ content: '回复' }], dataDir = null, withSpeak = false } = {}) {
  const config = { get: (k) => ({ agentId, port: 9999, maxIterations: 5, memoryTokenLimit: 8000 })[k] };
  const mm = new MessageManager({ systemPrompt: '你是 elf-001', memoryTokenLimit: 8000, dataDir });
  const model = new MockModel({ responses });
  const tr = new ToolManager();
  if (withSpeak) {
    // 注册一个极简 Speak 占位工具（不真发 room_bus），使 Speak 门控与 Speak-break 分支可被测试驱动。
    // missingReminder 复用真实 Speak.js 的协议实现（提醒文案 + 阈值），保证门控逻辑与生产等价。
    tr.register({
      name: 'Speak',
      description: '占位',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      callSummary: (args) => `Speak: ${(args?.message || '').slice(0, 30)}`,
      statusEvent: { state: 'speaking', detail: () => '' },
      missingReminder: RealSpeak.missingReminder,
      execute: async () => '已发言',
    });
  }
  const rc = buildRunContext({ agentId, mode: 'room', port: 9999, dataDir: dataDir || '/tmp', roomId: 'roomA', memberName });
  // 基类 Agent + RoomMiddleware 直推（对齐生产 start.js，不经 RoomAgent）。agent._rm 持 RoomMiddleware 引用。
  const agent = new Agent({ config, model, toolManager: tr, messageManager: mm, runContext: rc });
  const rm = new RoomMiddleware(agent);
  agent._scene = rm;      // 场景 middleware 作 agent 属性（对齐生产 start.js，不 push agent.middlewares）
  agent._rm = rm;
  return agent;
}

/** 收集 callback emit 的所有事件。fn 接收 emit、内部 await agent.receive(msg, {emit}) 等 */
async function collect(fn) {
  const events = [];
  await fn(e => events.push(e));
  return events;
}

describe('RoomAgent 门控', () => {
  it('自消息（from===memberName）立即 done,不调 model', async () => {
    const a = makeRoomAgent();
    const events = await collect(emit => a.receive({ from: 'elf-001', content: '我说', mentions: [], role: 'chat' }, { emit }));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'done');
    // context 不累积自消息
    assert.equal(a.messageManager.messages.length, 0);
  });

  it('未 @ 的消息进 buffer,不进 context,不 reasoning(立即 done)', async () => {
    const a = makeRoomAgent();
    const events = await collect(emit => a.receive({ from: 'elf-002', content: 'hello', mentions: [], role: 'chat' }, { emit }));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'done');
    // 未@消息进 buffer,不进 context
    assert.equal(a.messageManager.messages.length, 0);
    assert.equal(a._rm._buffer.length, 1);
    assert.match(a._rm._buffer[0], /elf-002: hello/);
    assert.equal(a._rm._bufferHasMention, false);
  });

  it('被 @ 的消息:该消息揉入 buffer,合成一条 user 消息进 context + reasoning', async () => {
    const a = makeRoomAgent({ responses: [{ content: '你好呀' }] });
    const events = await collect(emit => a.receive({ from: 'elf-002', content: '喂 @elf-001', mentions: ['elf-001'], role: 'chat' }, { emit }));
    const tokens = events.filter(e => e.event === 'token');
    assert.ok(tokens.length > 0, '应有 token 事件');
    // 一条 user(buffer 合成) + 一条 assistant
    assert.equal(a.messageManager.messages.length, 2);
    assert.match(a.messageManager.messages[0].content, /elf-002: 喂 @elf-001/);
    // buffer 已清
    assert.equal(a._rm._buffer.length, 0);
  });

  it('未@消息先攒 buffer,被@时把 buffer 累积内容 + 被@消息揉成一条 user 进 reasoning', async () => {
    const a = makeRoomAgent({ responses: [{ content: '答' }] });
    // 两条未@ 进 buffer
    await collect(emit => a.receive({ from: 'elf-002', content: 'm1', mentions: [], role: 'chat' }, { emit }));
    await collect(emit => a.receive({ from: 'elf-003', content: 'm2', mentions: [], role: 'chat' }, { emit }));
    assert.equal(a.messageManager.messages.length, 0); // 都在 buffer,没进 context
    assert.equal(a._rm._buffer.length, 2);
    // 被@触发:buffer(m1,m2) + 被@消息 揉成一条 user 消息进 context
    const events = await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 回我', mentions: ['elf-001'], role: 'chat' }, { emit }));
    assert.ok(events.some(e => e.event === 'token'));
    // 一条 user(含 m1 m2 + 被@消息) + 一条 assistant
    assert.equal(a.messageManager.messages.length, 2);
    const merged = a.messageManager.messages[0].content;
    assert.ok(merged.includes('m1') && merged.includes('m2') && merged.includes('@elf-001 回我'), '应揉成一条含所有内容');
    assert.equal(a._rm._buffer.length, 0);
  });

  it('回复期间(_replying)来的消息入 pending 队列不等同 buffer', async () => {
    const a = makeRoomAgent({ responses: [{ content: '答' }] });
    a._rm._replying = true; // 模拟正在回复
    const events = await collect(emit => a.receive({ from: 'elf-002', content: '回复中来的', mentions: ['elf-001'], role: 'chat' }, { emit }));
    assert.equal(events[0].event, 'done');
    // 消息进 pending 队列，不进 buffer
    assert.equal(a._rm._buffer.length, 0);
    assert.equal(a._rm._pendingBuffer.length, 1);
    assert.equal(a._rm._pendingHasMention, true);
    assert.equal(a._rm._bufferHasMention, false);
    assert.equal(a.messageManager.messages.length, 0); // 没进 context 没 reasoning
  });

  it('prefix/suffix：room 模式设 _roomMode（若 MM 支持）', async () => {
    const a = makeRoomAgent();
    // 默认 MessageManager 无 prefixPrompt,_roomMode 不会被设
    await collect(emit => a.receive({ from: 'elf-002', content: 'hi', mentions: [], role: 'chat' }, { emit }));
    // 默认 MM 无 prefixPrompt 字段,不设 _roomMode（无妨）
    assert.equal(a.messageManager._roomMode, undefined);
  });

  it('非 chat role 降级默认 reasoning', async () => {
    const a = makeRoomAgent({ responses: [{ content: '直接回' }] });
    const events = await collect(emit => a.receive({ content: '私聊式', role: 'direct' }, { emit }));
    assert.ok(events.some(e => e.event === 'token'));
  });

  // ===== 问题1：Speak 门控（content 不可见→提醒→二次仍不调才退出）=====
  it('问题1：第1次纯 content 注入 speak_reminder 提醒,第2次仍不调 Speak 才退出', async () => {
    const a = makeRoomAgent({
      withSpeak: true,
      // 第1轮纯 content → 注入提醒 continue；第2轮仍纯 content → break 退出
      responses: [{ content: '心里想想' }, { content: '还是不调' }],
    });
    await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 说句话', mentions: ['elf-001'], role: 'chat' }, { emit }));
    // 注入了 speak_reminder meta 消息
    const metas = a.messageManager.messages.filter(m => m.metaTag === 'speak_reminder');
    assert.equal(metas.length, 1, '第1次纯 content 应注入一条 speak_reminder');
    // 第2次仍不调 → _speakAttempts 到 2、退出
    assert.equal(a._rm._speakAttempts, 2);
  });

  // 回归（阶段二步4）：场景 middleware 走 run-level（agent._sceneMiddleware，对齐生产 start.js）时，
  //   flushLoop→reasoning 必须透传场景 middleware，否则 onAssistantContent 跑不到 RoomMiddleware → injectReminder 不触发。
  it('run-level 场景 middleware：flushLoop 内 onAssistantContent 仍触发 injectReminder（不丢场景）', async () => {
    const a = makeRoomAgent({
      withSpeak: true,
      responses: [{ content: '心里想想' }, { content: '还是不调' }],
    });
    // 把 rm 从 agent-level（middlewares）移到 _sceneMiddleware（场景 middleware 作 agent 属性，对齐生产 start.js）
    const rm = a._rm;
    a.middlewares = a.middlewares.filter(m => m !== rm);
    a._scene = rm;   
    await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 说句话', mentions: ['elf-001'], role: 'chat' }, { emit }));
    const metas = a.messageManager.messages.filter(m => m.metaTag === 'speak_reminder');
    assert.equal(metas.length, 1, 'run-level 场景 middleware 下，第1次纯 content 仍应注入 speak_reminder');
    assert.equal(rm._speakAttempts, 2, '第2次仍不调 Speak → attempts 到 2 退出');
  });

  it('问题1：第1次纯 content,第2次调 Speak → 正常发言结束(走 Speak-break)', async () => {
    const a = makeRoomAgent({
      withSpeak: true,
      // 第1轮纯 content → 提醒；第2轮调 Speak → Speak-break 结束
      responses: [
        { content: '想一下' },
        { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Speak', arguments: '{"message":"你好"}' } }] },
      ],
    });
    await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 hi', mentions: ['elf-001'], role: 'chat' }, { emit }));
    const metas = a.messageManager.messages.filter(m => m.metaTag === 'speak_reminder');
    assert.equal(metas.length, 1, '第1轮应注入一次提醒');
    assert.equal(a._rm._speakAttempts, 1, '第2轮调了 Speak,不算纯 content,attempts 只到 1');
  });

  it('问题1：未注册 Speak 的副本纯 content 仍立即 break(门控不触发,向后兼容)', async () => {
    const a = makeRoomAgent({ responses: [{ content: '随手回' }] }); // withSpeak:false
    await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 hi', mentions: ['elf-001'], role: 'chat' }, { emit }));
    const metas = a.messageManager.messages.filter(m => m.metaTag === 'speak_reminder');
    assert.equal(metas.length, 0, '未注册 Speak 不注入提醒');
    // 一条 user + 一条 assistant，无 meta
    assert.equal(a.messageManager.messages.length, 2);
  });

  // ===== 问题3a：身份用 agentId,memberName≠agentId 时仍正确 =====
  it('问题3：memberName 与 agentId 不同时,@agentId 仍命中(mentionedMe 用 agentId)', async () => {
    const a = makeRoomAgent({
      agentId: 'elf-001', memberName: '大黑塔', withSpeak: true,
      responses: [{ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Speak', arguments: '{"message":"hi"}' } }] }],
    });
    // @大黑塔(memberName) 不该命中(mentions 是 agentId);@elf-001(agentId) 命中
    const ev1 = await collect(emit => a.receive({ from: 'elf-002', content: '@大黑塔 hi', mentions: ['elf-001'], role: 'chat' }, { emit }));
    // 注意：parseMentions 已归一到 agentId，此处直接模拟 mentions 含 agentId 的命中
    assert.ok(ev1.some(e => e.event === 'token' || e.event === 'tool_call'), '@agentId 应触发 reasoning');
  });

  it('问题3：自消息按 agentId 与 memberName 双路过滤(防 ping-pong)', async () => {
    const a = makeRoomAgent({ agentId: 'elf-001', memberName: '大黑塔' });
    // from=memberName('大黑塔') 自消息 → 过滤
    const ev1 = await collect(emit => a.receive({ from: '大黑塔', content: '我说', mentions: [], role: 'chat' }, { emit }));
    assert.equal(ev1.length, 1);
    assert.equal(ev1[0].event, 'done');
    assert.equal(a.messageManager.messages.length, 0);
    // from=agentId('elf-001') 自消息 → 同样过滤
    const ev2 = await collect(emit => a.receive({ from: 'elf-001', content: '我说2', mentions: [], role: 'chat' }, { emit }));
    assert.equal(ev2[0].event, 'done');
    assert.equal(a.messageManager.messages.length, 0);
  });

  // ===== seq cursor 追踪 + gap 检测 =====

  it('cursor：有 dataDir 时 _syncCursor 应初始化', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rac-'));
    try {
      const a = makeRoomAgent({ dataDir: tmp });
      a._rm.ensureState();
      assert.ok(a.syncSource.cursor, '有 dataDir 时 _syncCursor 应初始化');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cursor：flush 后 cursor 推进到 seq', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rac-'));
    try {
      const a = makeRoomAgent({ dataDir: tmp, responses: [{ content: '答' }] });
      await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 hi', mentions: ['elf-001'], role: 'chat', seq: 10 }, { emit }));
      assert.equal(a.syncSource.cursor.get(), 10, 'cursor 推进到 seq');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cursor：多条消息后 flush cursor 取最大 seq', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rac-'));
    try {
      const a = makeRoomAgent({ dataDir: tmp, responses: [{ content: '答' }] });
      await collect(emit => a.receive({ from: 'elf-002', content: 'm1', mentions: [], role: 'chat', seq: 1 }, { emit }));
      await collect(emit => a.receive({ from: 'elf-003', content: 'm2', mentions: [], role: 'chat', seq: 2 }, { emit }));
      await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 now', mentions: ['elf-001'], role: 'chat', seq: 3 }, { emit }));
      assert.equal(a.syncSource.cursor.get(), 3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cursor：无 seq 的消息不推动 cursor', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rac-'));
    try {
      const a = makeRoomAgent({ dataDir: tmp, responses: [{ content: '答' }] });
      await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 hi', mentions: ['elf-001'], role: 'chat' }, { emit }));
      assert.equal(a.syncSource.cursor.get(), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('gap 检测：seq 连续不触发 sync', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rac-'));
    try {
      const a = makeRoomAgent({ dataDir: tmp });
      a._rm.ensureState();
      a.syncSource.cursor.advance(1);
      await collect(emit => a.receive({ from: 'elf-002', content: 'm2', mentions: [], role: 'chat', seq: 2 }, { emit }));
      // seq 连续 1→2，不触发 sync，正常进 buffer
      assert.equal(a._rm._buffer.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('gap 检测：seq 不连续触发 sync', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rac-'));
    try {
      const a = makeRoomAgent({ dataDir: tmp });
      a._rm.ensureState();
      a.syncSource.cursor.advance(2);
      // seq=5 收到，连续应为 3，不连续 → 触发 sync。
      // roomBusUrl 为空，sync 内部直接 return（不崩溃）
      await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 hi', mentions: ['elf-001'], role: 'chat', seq: 5 }, { emit }));
      assert.ok(true, 'gap 检测不抛异常');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ===== seq 类型与幂等去重测试（对应 bug：rec.id 字符串被误传为 seq）=====

  it('幂等去重：同一条消息重复 arrive 只处理一次', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-idem-'));
    try {
      const a = makeRoomAgent({ dataDir: tmp });
      // 第一条 seq=1 进 buffer
      await collect(emit => a.receive({ from: 'elf-002', content: 'm1', mentions: [], role: 'chat', seq: 1 }, { emit }));
      assert.equal(a._rm._buffer.length, 1);
      assert.equal(a._rm._processedSeqs.size, 1);

      // 同一条 seq=1 再次到达（模拟 /observe + _fillGap 双重投递）
      await collect(emit => a.receive({ from: 'elf-002', content: 'm1', mentions: [], role: 'chat', seq: 1 }, { emit }));
      // 不应重复加入 buffer
      assert.equal(a._rm._buffer.length, 1, '同 seq 不应重复加入 buffer');
      assert.equal(a._rm._processedSeqs.size, 1, 'Set 不应新增 entry');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('_advanceCursor：字符串 seq 不污染 cursor', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-cur-str-'));
    try {
      const a = makeRoomAgent({ dataDir: tmp });
      a._rm.ensureState();
      a.syncSource.cursor.advance(5);

      // 传入字符串（模拟 bug 场景：rec.id 被当 seq 传进来）
      a.syncSource.advance('rmsg_1784383138579_f781');
      // cursor 应保持为 5，不被 NaN 污染
      assert.equal(a.syncSource.cursor.get(), 5, 'cursor 不应被字符串污染');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('_advanceCursor：数字 seq 正常推进', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-cur-num-'));
    try {
      const a = makeRoomAgent({ dataDir: tmp });
      a._rm.ensureState();
      a.syncSource.cursor.advance(5);
      a.syncSource.advance(10);
      assert.equal(a.syncSource.cursor.get(), 10);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('_advanceCursor：null/undefined 不操作', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-cur-nil-'));
    try {
      const a = makeRoomAgent({ dataDir: tmp });
      a._rm.ensureState();
      a.syncSource.cursor.advance(5);
      a.syncSource.advance(null);
      a.syncSource.advance(undefined);
      assert.equal(a.syncSource.cursor.get(), 5);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ===== 缺口补测：RoomMiddleware.flushLoop 多轮 reflush + _flushPending mention 继承 =====
  // 这两块是 Room 行为里跨 reasoning 边界的循环，重构最高风险项（flush 循环归 RoomMiddleware），必须先锁现状。
  // 阶段一 flush 循环从基类 _roomFlushLoop 移回 RoomMiddleware.flushLoop，本组测试改测 RoomMiddleware 真路径。

  it('_flushPending：pending 有 mention → 应返回 reflush=true，并继承 mention 到 buffer', async () => {
    const a = makeRoomAgent({ dataDir: '/tmp', responses: [{ content: '答' }] });
    a._rm.ensureState();
    // 模拟回复期间来了一条被@的消息入 pending
    a._rm._pendingBuffer.push({ text: 'elf-002: @elf-001 追问', payload: { from: 'elf-002', content: '@elf-001 追问', mentions: ['elf-001'], role: 'chat' } });
    a._rm._pendingHasMention = true;
    a._rm._replying = false; // _flushPending 在 reasoning 结束的 finally 里调，此时 _replying 已被还原
    const reflush = await a._rm._flushPending('test');
    assert.equal(reflush, true, 'pending 有 mention 应要求 reflush');
    assert.ok(a._rm._buffer.length >= 1, 'pending 文本应 drain 进 buffer');
    assert.equal(a._rm._bufferHasMention, true, 'mention 应继承到 buffer');
    assert.equal(a._rm._pendingBuffer.length, 0, 'pending 清空');
  });

  it('_flushPending：pending 无 mention → 返回 reflush=false', async () => {
    const a = makeRoomAgent({ dataDir: '/tmp', responses: [{ content: '答' }] });
    a._rm.ensureState();
    a._rm._pendingBuffer.push({ text: 'elf-002: 嗯嗯', payload: { from: 'elf-002', content: '嗯嗯', mentions: [], role: 'chat' } });
    a._rm._pendingHasMention = false;
    a._rm._replying = false;
    const reflush = await a._rm._flushPending('test');
    assert.equal(reflush, false, 'pending 无 mention 不 reflush');
    assert.equal(a._rm._bufferHasMention, false);
  });

  it('flushLoop 多轮 reflush：第一轮回完，pending 有 mention → 触发第二轮 reasoning', async () => {
    // 构造：buffer 里有被@消息 → 第一轮 reasoning → 手工塞 pending(mention) → flushLoop 循环应再跑一轮
    const a = makeRoomAgent({
      dataDir: '/tmp',
      // 第1轮答完、第2轮（reflush）再答一次
      responses: [{ content: '第一答' }, { content: '第二答' }],
    });
    a._rm.ensureState();
    a._rm._buffer.push('elf-002: @elf-001 开问');
    a._rm._bufferHasMention = true;

    // 在 _replying 期间往 pending 塞消息：用 monkey-patch reasoning 包装
    const origReasoning = a.reasoning.bind(a);
    let reasoningCall = 0;
    a.reasoning = async function (...args) {
      reasoningCall++;
      // 第一轮 reasoning 进行中时模拟新消息到达（入 pending）
      if (reasoningCall === 1) {
        a._rm._pendingBuffer.push({ text: 'elf-003: @elf-001 追问', payload: { from: 'elf-003', content: '@elf-001 追问', mentions: ['elf-001'], role: 'chat' } });
        a._rm._pendingHasMention = true;
      }
      return origReasoning(...args);
    };

    await collect(emit => a._rm.flushLoop(emit));
    assert.equal(reasoningCall, 2, '应触发两轮 reasoning（第一轮完后 pending 有 mention → reflush 第二轮）');
    assert.equal(a._rm._buffer.length, 0, 'reflush 后 buffer 清空');
    assert.equal(a._rm._replying, false, 'flushLoop 结束后 _replying 还原');
  });

  it('flushLoop 单轮：第一轮回完无 pending mention → 不 reflush', async () => {
    const a = makeRoomAgent({ dataDir: '/tmp', responses: [{ content: '答' }] });
    a._rm.ensureState();
    a._rm._buffer.push('elf-002: @elf-001 问');
    a._rm._bufferHasMention = true;
    let calls = 0;
    const orig = a.reasoning.bind(a);
    a.reasoning = async function (...args) { calls++; return orig(...args); };
    await collect(emit => a._rm.flushLoop(emit));
    assert.equal(calls, 1, '无 pending mention 只跑一轮');
  });

  // ===== 缺口补测：_parse 的 contents 数组（合并消息）分支 =====
  it('_parse：payload.contents 多内容合并，每条加前缀', async () => {
    const a = makeRoomAgent({ dataDir: '/tmp' });
    a._rm.ensureState();
    a._rm._agentNames.set('elf-002', 'elf-002');
    const { text, mentionedMe } = a._rm._parse({ from: 'elf-002', contents: ['第一句', '第二句'], mentions: ['elf-001'] });
    assert.ok(text.includes('elf-002: 第一句') && text.includes('elf-002: 第二句'), '每条加前缀');
    assert.ok(text.includes('\n'), '多条用换行连接');
    assert.equal(mentionedMe, true, 'mentions 含本 agentId 命中');
  });

  it('_parse：contents 全空 → 返回 null text', async () => {
    const a = makeRoomAgent({ dataDir: '/tmp' });
    a._rm.ensureState();
    const { text, mentionedMe } = a._rm._parse({ from: 'elf-002', contents: ['  ', null, ''], mentions: [] });
    assert.equal(text, null, '全空内容返回 null');
    assert.equal(mentionedMe, false);
  });

  // ===== 缺口补测：roster 名字映射 → _parse 前缀用显示名 =====
  it('_parse：from 是 id 但 _agentNames 有映射 → 前缀用显示名', async () => {
    const a = makeRoomAgent({ dataDir: '/tmp' });
    a._rm.ensureState();
    a._rm._agentNames.set('elf-002', '小二');
    const { text } = a._rm._parse({ from: 'elf-002', content: 'hi', mentions: [] });
    assert.match(text, /^小二: hi/, '前缀应是映射后的显示名');
  });

  // ===== 缺口补测：_consumeGapMessage 路径的自消息 + seq 去重 =====
  it('_consumeGapMessage：自消息过滤 + 已处理 seq 跳过', async () => {
    const a = makeRoomAgent({ agentId: 'elf-001', memberName: 'elf-001', dataDir: '/tmp' });
    a._rm.ensureState();
    // 自消息（speaker===memberName）→ 跳过
    a._rm._consumeGapMessage({ seq: 1, speaker: 'elf-001', content: '我自己说的' });
    assert.equal(a._rm._buffer.length, 0, '自消息不进 buffer');
    // 标记 seq=2 已处理，再补同 seq → 跳过
    a._rm._processedSeqs.add(2);
    a._rm._consumeGapMessage({ seq: 2, speaker: 'elf-002', content: '重复的' });
    assert.equal(a._rm._buffer.length, 0, '已处理 seq 跳过');
    // 全新的别人消息 → 进 buffer
    a._rm._consumeGapMessage({ seq: 3, speaker: 'elf-002', content: '新的' });
    assert.equal(a._rm._buffer.length, 1, '全新消息进 buffer');
  });
});