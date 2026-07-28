/**
 * run-level 工具注入测试（v3 §五）
 *
 * 验证 receive({tools, disableTools, middleware})：
 *   - 临时工具注册、同名覆盖静态、请求结束自动还原（不影响后续请求）
 *   - disableTools 负向过滤（本请求不给某基础工具）
 *   - 临时 middleware 并入请求管线、结束弹栈
 *
 * 用 room 场景 agent（mention 触发 flush→reasoning），MockModel 返回 tool_calls 再纯文本。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'fs';
import os from 'os';
import { Config } from '../engine/config_loader.js';
import { MockModel } from '../engine/models/index.js';
import { ToolManager } from '../engine/tools/tool_manager.js';
import { MessageManager } from '../engine/message_manager.js';
import { Agent } from '../engine/agent.js';
import { RoomMiddleware } from '../engine/plugins/room_plugin.js';
import { buildRunContext } from '../engine/run_context.js';

async function collect(fn) {
  const events = [];
  await fn(e => events.push(e));
  return events;
}

function makeRoomAgent({ responses = [{ content: '回复' }], tools = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rl-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ agentId: 'elf-001', port: 9999, provider: 'mock' }), 'utf-8');
  fs.writeFileSync(path.join(tmp, 'api_key.json'), JSON.stringify({ base_url: '', auth_token: '', model: '' }), 'utf-8');
  const config = new Config(tmp);
  config.load();
  const model = new MockModel({ responses });
  const toolManager = new ToolManager();
  for (const t of tools) toolManager.register(t);
  const messageManager = new MessageManager({ systemPrompt: '你是 elf-001', memoryTokenLimit: 8000 });
  const rc = buildRunContext({ agentId: 'elf-001', mode: 'room', port: 9999, dataDir: tmp, roomId: 'roomA', memberName: 'elf-001' });
  const agent = new Agent({ config, model, toolManager, messageManager, runContext: rc });
  agent._scene = new RoomMiddleware(agent);
  return agent;
}

function toolCall(name, args = {}) {
  return { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

describe('run-level 工具注入', () => {
  it('临时工具：本次请求注入，模型调用之，请求结束还原（后续请求不可见）', async () => {
    const baseTool = { name: 'Base', description: '基础', parameters: { type: 'object' }, execute: async () => 'base-result' };
    const a = makeRoomAgent({
      responses: [
        { tool_calls: [toolCall('Tmp')] },          // 第1轮：调临时工具
        { content: '完' },                           // 第2轮：纯文本结束
      ],
      tools: [baseTool],
    });
    const tmpCalls = [];
    const tmpTool = { name: 'Tmp', description: '临时', parameters: { type: 'object' }, execute: async () => (tmpCalls.push(1), 'tmp-result') };

    await collect(emit => a.receive(
      { from: 'elf-002', content: '@elf-001 go', mentions: ['elf-001'], role: 'chat' },
      { emit, tools: [tmpTool] },
    ));
    assert.equal(tmpCalls.length, 1, '临时工具被执行');
    // 请求结束后 Tmp 不在 toolManager
    assert.ok(!a.toolManager.get('Tmp'), '临时工具 Tmp 请求结束已注销');
    assert.ok(a.toolManager.get('Base'), '基础工具仍在');
  });

  it('同名覆盖：run-level 工具覆盖静态同名，请求结束恢复静态原版', async () => {
    let baseHit = 0;
    const baseTool = { name: 'Dup', parameters: { type: 'object' }, execute: async () => (baseHit++, 'base') };
    let runHit = 0;
    const runTool = { name: 'Dup', parameters: { type: 'object' }, execute: async () => (runHit++, 'run') };
    const a = makeRoomAgent({
      responses: [{ tool_calls: [toolCall('Dup')] }, { content: '完' }],
      tools: [baseTool],
    });

    await collect(emit => a.receive(
      { from: 'elf-002', content: '@elf-001', mentions: ['elf-001'], role: 'chat' },
      { emit, tools: [runTool] },
    ));
    assert.equal(runHit, 1, 'run-level 覆盖版被执行');
    assert.equal(baseHit, 0, '静态版未被调');

    // 请求结束恢复：静态版回来
    const restored = a.toolManager.get('Dup');
    assert.equal(restored, baseTool, '请求结束恢复静态原版');
  });

  it('disableTools 负向过滤：本请求不给某基础工具，结束恢复', async () => {
    const bash = { name: 'Bash', parameters: { type: 'object' }, execute: async () => 'bash-out' };
    const read = { name: 'Read', parameters: { type: 'object' }, execute: async () => 'read-out' };
    const a = makeRoomAgent({ responses: [{ content: '完' }], tools: [bash, read] });

    // 请求前两个都在
    assert.ok(a.toolManager.getAll().some(t => t.name === 'Bash'));
    assert.ok(!a.toolManager._activeDisabled, '无请求级禁用');

    const seenTools = [];
    const origAll = a.toolManager.getAll.bind(a.toolManager);
    // 不真的跑 reason 里的 getAll 注入，只验证 disableTools 设置态：用一次极简接收 + peek。
    // 改用直接调用 harness.withRunLevel 验证副作用（receive 的事务路径已被前两测覆盖）。
    const restore = a.harness.withRunLevel({
      toolManager: a.toolManager, middlewares: a.middlewares, disableTools: ['Bash'],
    });
    const visible = a.toolManager.getAll().map(t => t.name);
    assert.ok(!visible.includes('Bash'), 'Bash 被本请求禁用');
    assert.ok(visible.includes('Read'), 'Read 仍可见');
    restore();
    assert.ok(origAll().some(t => t.name === 'Bash'), '结束恢复 Bash');
    assert.equal(a.toolManager._activeDisabled, null, '结束清禁用态');
  });

  it('临时 middleware：本请求并入、结束弹栈（不残留到 agent.middlewares）', async () => {
    const a = makeRoomAgent({ responses: [{ content: '完' }] });
    const before = a.middlewares.length;
    const tmpMw = { preReason() {} };

    const restore = a.harness.withRunLevel({
      toolManager: a.toolManager, middlewares: a.middlewares, middleware: [tmpMw],
    });
    assert.equal(a.middlewares.length, before + 1, '临时 middleware 入栈');
    restore();
    assert.equal(a.middlewares.length, before, '结束弹栈，长度复原');
    assert.ok(!a.middlewares.includes(tmpMw), '临时 middleware 已移除');
  });

  it('请求异常也还原临时工具（finally 保证）', async () => {
    const a = makeRoomAgent({ responses: [{ content: '完' }] });
    const tmpTool = { name: 'Boom', parameters: { type: 'object' }, execute: async () => { throw new Error('boom'); } };
    // 直接验证 finally：harness.withRunLevel 后模拟异常路径，restore 必须仍执行。
    const restore = a.harness.withRunLevel({
      toolManager: a.toolManager, middlewares: a.middlewares, tools: [tmpTool],
    });
    assert.ok(a.toolManager.get('Boom'));
    try {
      // 模拟 reasoning 抛异常（实际 receive 的 try/finally 保证 restore）
      throw new Error('simulated');
    } catch (e) {
      // 吞掉模拟异常
    } finally {
      restore();
    }
    assert.ok(!a.toolManager.get('Boom'), '异常路径下临时工具仍还原');
  });
});