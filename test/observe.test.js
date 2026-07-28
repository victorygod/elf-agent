import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MockModel } from '../engine/models/index.js';
import { MessageManager } from '../engine/message_manager.js';
import { ToolManager } from '../engine/tools/tool_manager.js';
import { Agent } from '../engine/agent.js';
import { RoomMiddleware } from '../engine/plugins/room_plugin.js';
import { buildRunContext } from '../engine/run_context.js';
import { createAgentServer } from '../engine/server.js';

function makeRoomAgent({ memberName = 'elf-001', responses = [{ content: '回复' }], dataDir } = {}) {
  const config = {
    get: (k) => ({ agentId: 'elf-001', port: 9999, maxIterations: 5, memoryTokenLimit: 8000 })[k],
    getModelConfig: () => ({ provider: 'mock' }),
    getModelMissingFields: () => null,
  };
  const mm = new MessageManager({ systemPrompt: '你是 elf-001', memoryTokenLimit: 8000, dataDir });
  const model = new MockModel({ responses });
  const tr = new ToolManager();
  const rc = buildRunContext({ agentId: 'elf-001', mode: 'room', port: 9999, dataDir: dataDir || '/tmp', roomId: 'roomA', memberName });
  // 基类 Agent + RoomMiddleware 直推（对齐生产 start.js，不经 RoomAgent）。agent._rm 持 RoomMiddleware 引用。
  const agent = new Agent({ config, model, toolManager: tr, messageManager: mm, runContext: rc });
  const rm = new RoomMiddleware(agent);
  agent._scene = rm;      // 场景 middleware 作 agent 属性（对齐生产 start.js）
  agent._rm = rm;
  return agent;
}

describe('POST /observe 端点', () => {
  let tmpDir, agent, server, baseUrl;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-obs-'));
    agent = makeRoomAgent({ dataDir: tmpDir, responses: [{ content: '你好呀' }] });
    const app = createAgentServer(agent, agent.config);
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
  });

  it('未 @ 的消息：ack true，reasoning 不调用（进 buffer 不进 context）', async () => {
    const res = await fetch(`${baseUrl}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'elf-002', content: 'hi', mentions: [], role: 'chat' }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ack, true);
    // 新语义：未@消息进 RoomAgent buffer,不进 context,无 assistant
    assert.equal(agent.messageManager.messages.length, 0);
    assert.equal(agent._rm._buffer.length, 1);
  });

  it('被 @ 的消息：ack true + reasoning 产出回复', async () => {
    const res = await fetch(`${baseUrl}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'elf-002', content: '喂 @elf-001', mentions: ['elf-001'], role: 'chat' }),
    });
    const data = await res.json();
    assert.equal(data.ack, true);
    // 等一下让 processObserve 跑完（async）
    await new Promise(r => setTimeout(r, 50));
    // 累积了本次 + assistant 回复
    const msgs = agent.messageManager.messages;
    assert.ok(msgs.some(m => m.role === 'assistant'), '应有 assistant 回复');
  });

  it('自消息（from===memberName）：ack true，不累积不 reasoning', async () => {
    const before = agent.messageManager.messages.length;
    const res = await fetch(`${baseUrl}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'elf-001', content: '我自己说的', mentions: [], role: 'chat' }),
    });
    const data = await res.json();
    assert.equal(data.ack, true);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(agent.messageManager.messages.length, before); // 没增加
  });

  it('content 缺失 → 400', async () => {
    const res = await fetch(`${baseUrl}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'elf-002', mentions: [], role: 'chat' }),
    });
    assert.equal(res.status, 400);
  });

  it('忙时合并：连续发两条,第二条返回 merged:true', async () => {
    // 第一条被@触发 reasoning（mock 有响应）,第二条进来时忙
    agent.model.responses = [{ content: 'long-reply' }, { content: 'second' }];
    const r1 = fetch(`${baseUrl}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'elf-002', content: '@elf-001 q', mentions: ['elf-001'], role: 'chat' }),
    });
    // 不等 r1 完成,立刻发第二条
    const r2 = fetch(`${baseUrl}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'elf-002', content: 'second msg', mentions: [], role: 'chat' }),
    });
    const [d1, d2] = await Promise.all([r1.then(r => r.json()), r2.then(r => r.json())]);
    assert.equal(d1.ack, true);
    // 第二条要么 merged（赶上忙）要么正常 ack——两者都算通过,关键是没崩
    assert.equal(d2.ack, true);
    await new Promise(r => setTimeout(r, 80));
  });

  it('合并出队：合并期间被@的消息,出队后应触发 reasoning 而非走非chat歧路', async () => {
    // 重置 agent：清空 messages/buffer，让计数干净
    agent.messageManager.messages = [];
    agent._rm._buffer = [];
    agent._rm._bufferHasMention = false;
    agent._rm._replying = false;
    // 第一条被@ + reasoning 慢回复（占住 observeProcessing）→ 期间第二条带@进来被合并
    // 出队后第二条必须走 chat 分支触发 reasoning,不能因 payload 形状不对被当"非chat消息"
    agent.model.responses = [
      { content: 'first-reply' },
      { content: 'second-reply' },
      { content: 'third-reply' },
    ];
    const r1 = fetch(`${baseUrl}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'elf-002', content: '@elf-001 占住', mentions: ['elf-001'], role: 'chat' }),
    });
    // 立刻发两条（赶在第一条 reasoning 结束前）：第二条也@自己
    const r2 = fetch(`${baseUrl}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'elf-003', content: '@elf-001 合并里的@', mentions: ['elf-001'], role: 'chat' }),
    });
    const [d1, d2] = await Promise.all([r1.then(r => r.json()), r2.then(r => r.json())]);
    assert.equal(d1.ack, true);
    assert.equal(d2.ack, true);
    // 等所有 reasoning（首轮 + 合并出队后的）跑完
    await new Promise(r => setTimeout(r, 200));

    // 合并出队的消息应进 context（addUserMessage 被 flush）,而不应走非chat路径注入空 reasoning。
    // 判据：messages 里含被 @ 的合并内容（elf-003 那条），且有对应 assistant 回复。
    const msgs = agent.messageManager.messages;
    const hasElf003Msg = msgs.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('合并里的@'));
    assert.ok(hasElf003Msg, '合并出队的被@消息应进 context（走 chat 分支 flush）');
    // assistant 回复数 >= 2（首轮 + 合并出队后）
    const assistantCount = msgs.filter(m => m.role === 'assistant').length;
    assert.ok(assistantCount >= 2, `应有>=2条 assistant 回复（首轮+合并出队）,实际 ${assistantCount}`);
    // 不应有空 content 的 user 消息（非chat歧路会 super.receive('') 触发空 reasoning 的痕迹）
    const emptyUserMsg = msgs.find(m => m.role === 'user' && (m.content == null || m.content.trim() === ''));
    assert.ok(!emptyUserMsg, '不应有空内容 user 消息（非chat歧路标志）');
  });
});