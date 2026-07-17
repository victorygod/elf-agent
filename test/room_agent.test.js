import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { MockModel } from '../shared/agent/mock_model.js';
import { MessageManager } from '../shared/agent/message_manager.js';
import { ToolRegistry } from '../shared/agent/tools/registry.js';
import { RoomAgent } from '../shared/agent/room_agent.js';
import { buildRunContext } from '../shared/agent/run_context.js';

function makeRoomAgent({ memberName = 'elf-001', agentId = 'elf-001', responses = [{ content: '回复' }], dataDir = null, withSpeak = false } = {}) {
  const config = { get: (k) => ({ agentId, port: 9999, maxIterations: 5, memoryTokenLimit: 8000 })[k] };
  const mm = new MessageManager({ systemPrompt: '你是 elf-001', memoryTokenLimit: 8000, dataDir });
  const model = new MockModel({ responses });
  const tr = new ToolRegistry();
  if (withSpeak) {
    // 注册一个极简 Speak 占位工具（不真发 room_bus），使 Speak 门控与 Speak-break 分支可被测试驱动
    tr.register({
      name: 'Speak',
      description: '占位',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      callSummary: (args) => `Speak: ${(args?.message || '').slice(0, 30)}`,
      statusEvent: { state: 'speaking', detail: () => '' },
      execute: async () => '已发言',
    });
  }
  const rc = buildRunContext({ agentId, mode: 'room', port: 9999, dataDir: dataDir || '/tmp', roomId: 'roomA', memberName });
  return new RoomAgent({ config, model, toolRegistry: tr, messageManager: mm, runContext: rc });
}

/** 收集 generator 的所有事件 */
async function collect(gen) {
  const events = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('RoomAgent 门控', () => {
  it('自消息（from===memberName）立即 done,不调 model', async () => {
    const a = makeRoomAgent();
    const events = await collect(a.receive({ from: 'elf-001', content: '我说', mentions: [], role: 'chat' }));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'done');
    // context 不累积自消息
    assert.equal(a.messageManager.messages.length, 0);
  });

  it('未 @ 的消息进 buffer,不进 context,不 reasoning(立即 done)', async () => {
    const a = makeRoomAgent();
    const events = await collect(a.receive({ from: 'elf-002', content: 'hello', mentions: [], role: 'chat' }));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'done');
    // 未@消息进 buffer,不进 context
    assert.equal(a.messageManager.messages.length, 0);
    assert.equal(a._buffer.length, 1);
    assert.match(a._buffer[0], /elf-002: hello/);
    assert.equal(a._bufferHasMention, false);
  });

  it('被 @ 的消息:该消息揉入 buffer,合成一条 user 消息进 context + reasoning', async () => {
    const a = makeRoomAgent({ responses: [{ content: '你好呀' }] });
    const events = await collect(a.receive({ from: 'elf-002', content: '喂 @elf-001', mentions: ['elf-001'], role: 'chat' }));
    const tokens = events.filter(e => e.event === 'token');
    assert.ok(tokens.length > 0, '应有 token 事件');
    // 一条 user(buffer 合成) + 一条 assistant
    assert.equal(a.messageManager.messages.length, 2);
    assert.match(a.messageManager.messages[0].content, /elf-002: 喂 @elf-001/);
    // buffer 已清
    assert.equal(a._buffer.length, 0);
  });

  it('未@消息先攒 buffer,被@时把 buffer 累积内容 + 被@消息揉成一条 user 进 reasoning', async () => {
    const a = makeRoomAgent({ responses: [{ content: '答' }] });
    // 两条未@ 进 buffer
    await collect(a.receive({ from: 'elf-002', content: 'm1', mentions: [], role: 'chat' }));
    await collect(a.receive({ from: 'elf-003', content: 'm2', mentions: [], role: 'chat' }));
    assert.equal(a.messageManager.messages.length, 0); // 都在 buffer,没进 context
    assert.equal(a._buffer.length, 2);
    // 被@触发:buffer(m1,m2) + 被@消息 揉成一条 user 消息进 context
    const events = await collect(a.receive({ from: 'elf-002', content: '@elf-001 回我', mentions: ['elf-001'], role: 'chat' }));
    assert.ok(events.some(e => e.event === 'token'));
    // 一条 user(含 m1 m2 + 被@消息) + 一条 assistant
    assert.equal(a.messageManager.messages.length, 2);
    const merged = a.messageManager.messages[0].content;
    assert.ok(merged.includes('m1') && merged.includes('m2') && merged.includes('@elf-001 回我'), '应揉成一条含所有内容');
    assert.equal(a._buffer.length, 0);
  });

  it('回复期间(_replying)来的消息只攒 buffer,不重复 reasoning', async () => {
    // 模拟回复中:先简化用 makeRoomAgent 单层 receive(非真回复中)→ 此条作为回复中第二条
    const a = makeRoomAgent({ responses: [{ content: '答' }] });
    a._replying = true; // 模拟正在回复
    const events = await collect(a.receive({ from: 'elf-002', content: '回复中来的', mentions: ['elf-001'], role: 'chat' }));
    assert.equal(events[0].event, 'done');
    assert.equal(a._buffer.length, 1); // 只攒进 buffer
    assert.equal(a._bufferHasMention, true); // 标记了@我
    assert.equal(a.messageManager.messages.length, 0); // 没进 context 没 reasoning
  });

  it('prefix/suffix：room 模式设 _roomMode（若 MM 支持）', async () => {
    const a = makeRoomAgent();
    // 默认 MessageManager 无 prefixPrompt,_roomMode 不会被设
    await collect(a.receive({ from: 'elf-002', content: 'hi', mentions: [], role: 'chat' }));
    // 默认 MM 无 prefixPrompt 字段,不设 _roomMode（无妨）
    assert.equal(a.messageManager._roomMode, undefined);
  });

  it('非 chat role 降级默认 reasoning', async () => {
    const a = makeRoomAgent({ responses: [{ content: '直接回' }] });
    const events = await collect(a.receive({ content: '私聊式', role: 'direct' }));
    assert.ok(events.some(e => e.event === 'token'));
  });

  // ===== 问题1：Speak 门控（content 不可见→提醒→二次仍不调才退出）=====
  it('问题1：第1次纯 content 注入 speak_reminder 提醒,第2次仍不调 Speak 才退出', async () => {
    const a = makeRoomAgent({
      withSpeak: true,
      // 第1轮纯 content → 注入提醒 continue；第2轮仍纯 content → break 退出
      responses: [{ content: '心里想想' }, { content: '还是不调' }],
    });
    await collect(a.receive({ from: 'elf-002', content: '@elf-001 说句话', mentions: ['elf-001'], role: 'chat' }));
    // 注入了 speak_reminder meta 消息
    const metas = a.messageManager.messages.filter(m => m.metaTag === 'speak_reminder');
    assert.equal(metas.length, 1, '第1次纯 content 应注入一条 speak_reminder');
    // 第2次仍不调 → _speakAttempts 到 2、退出
    assert.equal(a._speakAttempts, 2);
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
    await collect(a.receive({ from: 'elf-002', content: '@elf-001 hi', mentions: ['elf-001'], role: 'chat' }));
    const metas = a.messageManager.messages.filter(m => m.metaTag === 'speak_reminder');
    assert.equal(metas.length, 1, '第1轮应注入一次提醒');
    assert.equal(a._speakAttempts, 1, '第2轮调了 Speak,不算纯 content,attempts 只到 1');
  });

  it('问题1：未注册 Speak 的副本纯 content 仍立即 break(门控不触发,向后兼容)', async () => {
    const a = makeRoomAgent({ responses: [{ content: '随手回' }] }); // withSpeak:false
    await collect(a.receive({ from: 'elf-002', content: '@elf-001 hi', mentions: ['elf-001'], role: 'chat' }));
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
    const ev1 = await collect(a.receive({ from: 'elf-002', content: '@大黑塔 hi', mentions: ['elf-001'], role: 'chat' }));
    // 注意：parseMentions 已归一到 agentId，此处直接模拟 mentions 含 agentId 的命中
    assert.ok(ev1.some(e => e.event === 'token' || e.event === 'tool_call'), '@agentId 应触发 reasoning');
  });

  it('问题3：自消息按 agentId 与 memberName 双路过滤(防 ping-pong)', async () => {
    const a = makeRoomAgent({ agentId: 'elf-001', memberName: '大黑塔' });
    // from=memberName('大黑塔') 自消息 → 过滤
    const ev1 = await collect(a.receive({ from: '大黑塔', content: '我说', mentions: [], role: 'chat' }));
    assert.equal(ev1.length, 1);
    assert.equal(ev1[0].event, 'done');
    assert.equal(a.messageManager.messages.length, 0);
    // from=agentId('elf-001') 自消息 → 同样过滤
    const ev2 = await collect(a.receive({ from: 'elf-001', content: '我说2', mentions: [], role: 'chat' }));
    assert.equal(ev2[0].event, 'done');
    assert.equal(a.messageManager.messages.length, 0);
  });
});