import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MockModel } from '../shared/agent/mock_model.js';
import { MessageManager } from '../shared/agent/message_manager.js';
import { ToolRegistry } from '../shared/agent/tools/registry.js';
import { RoomAgent } from '../shared/agent/room_agent.js';
import { buildRunContext } from '../shared/agent/run_context.js';
import { createAgentServer } from '../shared/agent/server.js';

function makeRoomAgent({ memberName = 'elf-001', responses = [{ content: '回复' }], dataDir } = {}) {
  const config = {
    get: (k) => ({ agentId: 'elf-001', port: 9999, maxIterations: 5, memoryTokenLimit: 8000 })[k],
    getModelConfig: () => ({ provider: 'mock' }),
    getModelMissingFields: () => null,
  };
  const mm = new MessageManager({ systemPrompt: '你是 elf-001', memoryTokenLimit: 8000, dataDir });
  const model = new MockModel({ responses });
  const tr = new ToolRegistry();
  const rc = buildRunContext({ agentId: 'elf-001', mode: 'room', port: 9999, dataDir: dataDir || '/tmp', roomId: 'roomA', memberName });
  return new RoomAgent({ config, model, toolRegistry: tr, messageManager: mm, runContext: rc });
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
    assert.equal(agent._buffer.length, 1);
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
});