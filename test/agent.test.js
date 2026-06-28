/**
 * Agent 子系统测试
 *
 * 使用 MockModel，不依赖真实 LLM API
 * 覆盖：Config / MockModel / ToolRegistry / MessageManager / Agent / HTTP Server / abort
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Config } from '../shared/agent/config_loader.js';
import { MockModel } from '../shared/agent/mock_model.js';
import { LLMModel } from '../shared/agent/llm_model.js';
import { ToolRegistry } from '../shared/agent/tools/registry.js';
import { Read } from '../shared/agent/tools/index.js';
import { reset as resetReadState } from '../shared/agent/tools/read_state.js';
import { MessageManager } from '../shared/agent/message_manager.js';
import { Agent } from '../shared/agent/default_agent.js';
import { createAgentServer } from '../shared/agent/server.js';

/** 创建临时 Config 用于测试 */
function createTestConfig(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-test-'));
  const configData = {
    agentId: 'test-agent',
    port: 9000,
    provider: 'mock',
    ...overrides
  };
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(configData, null, 2), 'utf-8');
  fs.writeFileSync(path.join(tmpDir, 'api_key.json'), JSON.stringify({
    base_url: '', auth_token: '', model: ''
  }), 'utf-8');
  const config = new Config(tmpDir);
  config.load();
  return config;
}

// ========================
// Config 测试
// ========================
describe('Config', () => {
  it('应该正确加载 config.json 及 systemPrompt', () => {
    const configDir = path.join(process.cwd(), 'agents', 'elf-001', 'config');
    const config = new Config(configDir);
    config.load();
    assert.equal(config.get('agentId'), 'elf-001');
    assert.ok(typeof config.get('port') === 'number');
    assert.ok(typeof config.get('memoryTokenLimit') === 'number');
    // systemPrompt 应为非空字符串
    assert.ok(typeof config.get('systemPrompt') === 'string');
    assert.ok(config.get('systemPrompt').length > 0);
  });
});

// ========================
// MockModel 测试
// ========================
describe('MockModel', () => {
  it('应该流式返回默认回复', async () => {
    const model = new MockModel();
    const messages = [{ role: 'user', content: '你好' }];
    let fullContent = '';
    for await (const chunk of model.chatStream(messages, [])) {
      if (chunk.type === 'token') {
        fullContent += chunk.content;
      }
    }
    assert.equal(fullContent, '这是一个模拟回复。');
  });

  it('应该按序返回预设的 responses 并支持工具调用', async () => {
    const model = new MockModel({
      responses: [
        { content: '第一条回复' },
        {
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"/tmp/test.txt"}' }
          }]
        },
        { content: '工具调用后的回复' },
      ]
    });
    const messages = [{ role: 'user', content: '你好' }];

    // 第一次：纯文本
    let content1 = '';
    for await (const chunk of model.chatStream(messages, [])) {
      if (chunk.type === 'token') content1 += chunk.content;
    }
    assert.equal(content1, '第一条回复');

    // 第二次：工具调用
    let hasToolCalls = false;
    for await (const chunk of model.chatStream(messages, [])) {
      if (chunk.type === 'tool_calls') {
        hasToolCalls = true;
        assert.equal(chunk.tool_calls[0].function.name, 'Read');
      }
    }
    assert.ok(hasToolCalls);

    // 第三次：纯文本
    let content3 = '';
    for await (const chunk of model.chatStream(messages, [])) {
      if (chunk.type === 'token') content3 += chunk.content;
    }
    assert.equal(content3, '工具调用后的回复');

    // 超出 responses 后回退到 defaultResponse
    let content4 = '';
    for await (const chunk of model.chatStream(messages, [])) {
      if (chunk.type === 'token') content4 += chunk.content;
    }
    assert.equal(content4, '这是一个模拟回复。');
  });

  it('chat (非流式) 应该返回完整文本', async () => {
    const model = new MockModel({
      responses: [{ content: '这是一段总结。' }]
    });
    const messages = [{ role: 'user', content: '请总结一下' }];
    const result = await model.chat(messages);
    assert.equal(result, '这是一段总结。');
  });
});

// ========================
// ToolRegistry 测试
// ========================
describe('ToolRegistry', () => {
  beforeEach(() => {
    resetReadState();
  });

  it('应该注册和获取工具', () => {
    const registry = new ToolRegistry();
    registry.register(Read);
    const tool = registry.get('Read');
    assert.ok(tool);
    assert.equal(tool.name, 'Read');
  });

  it('getAll 应该返回所有工具', () => {
    const registry = new ToolRegistry();
    registry.register(Read);
    const all = registry.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'Read');
  });

  it('execute 应该执行工具并返回 cat -n 格式结果', async () => {
    const registry = new ToolRegistry();
    registry.register(Read);
    const tmpPath = path.join(process.cwd(), 'test_tmp_file.txt');
    fs.writeFileSync(tmpPath, 'hello world', 'utf-8');
    try {
      const result = await registry.execute('Read', { file_path: tmpPath });
      // Read 返回 cat -n 格式（行号 + 内容）
      assert.match(result, /^\d+\t/);
      assert.ok(result.includes('hello world'));
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('execute 不存在的工具应返回错误信息', async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute('nonexistent', {});
    assert.ok(result.includes('不存在'));
  });

  it('Read 大文件应该截断（默认 2000 行）', async () => {
    resetReadState();
    const registry = new ToolRegistry();
    registry.register(Read);
    const tmpPath = path.join(process.cwd(), 'test_large_file.txt');
    // 生成超过 2000 行的文件
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(tmpPath, lines.join('\n'), 'utf-8');
    try {
      const result = await registry.execute('Read', { file_path: tmpPath });
      // Read 默认 limit=2000，应该只返回前 2000 行
      const resultLines = result.trim().split('\n');
      assert.ok(resultLines.length <= 2002, '应不超过 2000 行+header');  // cat -n 格式可能多1行header
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('Read 不存在的文件应返回错误信息', async () => {
    const registry = new ToolRegistry();
    registry.register(Read);
    const result = await registry.execute('Read', { file_path: '/nonexistent/path/file.txt' });
    assert.match(result, /File does not exist/);
  });
});

// ========================
// MessageManager 测试
// ========================
describe('MessageManager', () => {
  it('应该正确追加和获取消息', () => {
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000 });
    mm.addUserMessage('你好');
    mm.addAssistantMessage('你好！有什么可以帮你的？');
    const messages = mm.getMessagesForLLM();
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, 'You are helpful.');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content, '你好');
    assert.equal(messages[2].role, 'assistant');
    assert.equal(messages[2].content, '你好！有什么可以帮你的？');
  });

  it('应该支持工具调用消息', () => {
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000 });
    mm.addUserMessage('看文件');
    mm.addAssistantToolCalls([{
      id: 'call_1', type: 'function',
      function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' }
    }]);
    mm.addToolResult('call_1', 'file content here');
    const messages = mm.getMessagesForLLM();
    assert.equal(messages[2].role, 'assistant');
    assert.ok(messages[2].tool_calls);
    assert.equal(messages[3].role, 'tool');
    assert.equal(messages[3].content, 'file content here');
  });

  it('estimateTokens 应该返回合理的估算值', () => {
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000 });
    mm.addUserMessage('这是一段测试文本');
    const tokens = mm.estimateTokens();
    assert.ok(tokens > 0);
  });

  it('updateConfig 应该更新配置', () => {
    const mm = new MessageManager({ systemPrompt: 'old', memoryTokenLimit: 8000 });
    mm.updateConfig({ systemPrompt: 'new', memoryTokenLimit: 16000 });
    assert.equal(mm.systemPrompt, 'new');
    assert.equal(mm.memoryTokenLimit, 16000);
  });

  it('clear 应该清空消息', () => {
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000 });
    mm.addUserMessage('test');
    mm.clear();
    assert.equal(mm.messages.length, 0);
  });

  it('compactIfNeeded (generator) 在未超阈值时不应压缩', async () => {
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000 });
    mm.addUserMessage('少量文本');
    const model = new MockModel();
    const events = [];
    for await (const event of mm.compactIfNeeded(model)) {
      events.push(event);
    }
    assert.equal(events.length, 0, '未超阈值不应有压缩事件');
  });

  it('compactIfNeeded (generator) 在超阈值时应该压缩', async () => {
    const model = new MockModel({
      responses: [{ content: '这是压缩后的摘要。' }]
    });
    // limit 设为「原文超、但短摘要产物(preamble+summary)不超」的值，避免下轮再触发
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 45 });
    mm.addUserMessage('这是一段很长的文本用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行，反复填充使其超过设阈值以便确实触发压缩逻辑执行而不误判不触发情况发生，继续填充更多文本以确保整体token数量稳定超过四十五的阈值。');
    mm.addAssistantMessage('好的，我明白了。这段对话内容需要被压缩以节省token空间，确保后续对话可以继续进行而不丢失关键信息，继续填充文本使整体tokens超过上述设定阈值从而稳定触发压缩逻辑的执行。');

    const events = [];
    for await (const event of mm.compactIfNeeded(model)) {
      events.push(event);
    }
    assert.ok(events.find(e => e.event === 'compact_start'), '应有 compact_start 事件');
    assert.ok(events.find(e => e.event === 'compact'), '应有 compact 事件');

    const msgs = mm.getMessagesForLLM();
    assert.equal(msgs[0].role, 'system');
    assert.ok(msgs.length <= 3, '压缩后消息应大幅减少');
    // naive 产物：单条带标记的摘要 user（SUMMARY_PREAMBLE + LLM 回复），isCompactSummary
    const compactMsg = msgs.find(m => m.isCompactSummary);
    assert.ok(compactMsg, '压缩产物应有 isCompactSummary 标志');
    assert.equal(compactMsg.role, 'user');
    assert.ok(compactMsg.content.includes('这是压缩后的摘要。'), '摘要内容应为 LLM 回复加 SUMMARY_PREAMBLE 前缀');
  });

  // 以下为 compact 第 4 层上提基类后的目标测试（基类改造完即绿）。
  // 用一个记录型 mock，捕获压缩请求的 messages 与 options
  function recordingMock(content) {
    const calls = [];
    const mock = {
      async chat(messages, options = {}) { calls.push({ messages, options }); return content; }
    };
    mock.calls = calls;
    return mock;
  }

  it('compactIfNeeded LLM 回复为空应 yield compact_error、不替换 messages（naive 无断路器）', async () => {
    // naive 基类不解析标签，直接用 LLM 回复；空回复视为失败
    const model = recordingMock('   ');
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 5 });
    mm.addUserMessage('这是一段很长的文本用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行');

    const events = [];
    for await (const event of mm.compactIfNeeded(model)) { events.push(event); }

    assert.ok(events.find(e => e.event === 'compact_start'), '应有 compact_start 事件');
    assert.ok(!events.find(e => e.event === 'compact'), '空回复不应 yield compact 事件');
    assert.ok(events.find(e => e.event === 'compact_error'), '空回复应 yield compact_error 提示前端');
    assert.ok(mm._compactFailCount === undefined, 'naive 基类无断路器字段');
    // messages 未被替换（仍含原 user 消息）
    const msgs = mm.getMessagesForLLM();
    assert.ok(msgs.some(m => m.content && m.content.includes('触发记忆压缩功能测试')), '空回复时不应替换 messages');
  });

  it('compactIfNeeded 无断路器，反复失败仍每次尝试（naive）', async () => {
    // naive 基类没有断路器禁用机制，每次调用都正常尝试
    const model = recordingMock('   ');
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 5 });
    mm.addUserMessage('这是一段很长的文本用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行');

    for (let i = 0; i < 3; i++) {
      for await (const _ of mm.compactIfNeeded(model)) { /* drain */ }
    }
    assert.ok(mm._compactDisabled === undefined, 'naive 基类无 _compactDisabled，不会因失败禁用');

    // 再次调用仍会尝试（有 compact_start 事件），不会静默跳过
    const events = [];
    for await (const event of mm.compactIfNeeded(model)) { events.push(event); }
    assert.ok(events.find(e => e.event === 'compact_start'), '无断路器：每次调用仍尝试压缩');
  });

  it('compactIfNeeded 遇 AbortError 应抛出，不被内部吞', async () => {
    const ac = new AbortController();
    const model = {
      async chat(_messages, options = {}) {
        // 用 signal 触发 AbortError，模拟压缩期间用户中断
        if (options.signal) {
          options.signal.dispatchEvent(new Event('abort'));
          throw new DOMException('aborted', 'AbortError');
        }
        return 'x';
      }
    };
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 5 });
    mm.addUserMessage('这是一段很长的文本用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行');

    let threw = null;
    try {
      for await (const _ of mm.compactIfNeeded(model, { signal: ac.signal })) { /* drain */ }
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'Compact AbortError 应抛出给调用方');
    assert.equal(threw?.name, 'AbortError');
  });

  it('compactIfNeeded 压一次即返回、不本轮递归（对齐 CC：仍超阈值留待下一轮 loop 顶部再压）', async () => {
    // 摘要产物本身仍超 memoryTokenLimit，但不应本轮递归再压
    const model = recordingMock('压缩后依然非常非常长的摘要内容，远超 token 上限，用于验证不递归。');
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 1 });
    mm.addUserMessage('触发压缩的长文本');

    const events = [];
    for await (const event of mm.compactIfNeeded(model)) { events.push(event); }

    const compactCount = events.filter(e => e.event === 'compact').length;
    assert.equal(compactCount, 1, '对齐 CC：每轮只压一次，不本轮递归');
    // messages 仍超阈值，但本轮不再压（留待下一轮 agent loop 顶部）
    assert.ok(mm.estimateTokens() > mm.memoryTokenLimit, '压缩后仍超阈值，但本轮不再压');
  });

  it('compactIfNeeded 压缩请求应使用配置的 compactPrompt/compactSystemPrompt', async () => {
    const model = recordingMock('摘要内容');
    const mm = new MessageManager({
      systemPrompt: 'sys',
      memoryTokenLimit: 5,
      compactSystemPrompt: '你是压缩器',
      compactPrompt: '请总结以上对话'
    });
    mm.addUserMessage('这是一段很长的文本用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行');

    for await (const _ of mm.compactIfNeeded(model)) { /* drain */ }

    assert.ok(model.calls.length >= 1, '应发起压缩请求');
    const req = model.calls[0].messages;
    assert.ok(req.find(m => m.role === 'system' && m.content === '你是压缩器'), '请求应含配置的 compactSystemPrompt');
    assert.ok(req.find(m => m.role === 'user' && m.content === '请总结以上对话'), '请求应含配置的 compactPrompt');
  });

  it('compactSystemPrompt 留空时应退化沿用主 systemPrompt（而非发空 system）', async () => {
    const model = recordingMock('摘要内容');
    const mm = new MessageManager({
      systemPrompt: '你是主助手',
      memoryTokenLimit: 5
      // compactSystemPrompt 未配 → 留空
    });
    mm.addUserMessage('这是一段很长的文本用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行');

    for await (const _ of mm.compactIfNeeded(model)) { /* drain */ }

    assert.ok(model.calls.length >= 1, '应发起压缩请求');
    const sysMsg = model.calls[0].messages.find(m => m.role === 'system');
    assert.ok(sysMsg, '压缩请求应含 system 消息');
    assert.equal(sysMsg.content, '你是主助手', 'compactSystemPrompt 留空时应沿用主 systemPrompt');
  });

  it('compactIfNeeded 调 LLM 应带 enable_thinking:false', async () => {
    const model = recordingMock('摘要内容');
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 5 });
    mm.addUserMessage('这是一段很长的文本用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行');

    for await (const _ of mm.compactIfNeeded(model)) { /* drain */ }

    assert.ok(model.calls.length >= 1, '应发起压缩请求');
    assert.equal(model.calls[0].options.enable_thinking, false, '压缩调 LLM 应带 enable_thinking:false');
  });
});

// ========================
// Agent (DefaultAgent) 测试
// ========================
describe('Agent (DefaultAgent)', () => {
  let agent, model, messageManager, toolRegistry, config;

  beforeEach(() => {
    config = createTestConfig();

    model = new MockModel({
      responses: [{ content: '你好！很高兴见到你。' }]
    });

    toolRegistry = new ToolRegistry();
    toolRegistry.register(Read);

    messageManager = new MessageManager({
      systemPrompt: config.get('systemPrompt') || '你是助手',
      memoryTokenLimit: 8000
    });

    agent = new Agent({ config, model, toolRegistry, messageManager });
  });

  it('应该通过 Intuitive 层返回流式 token 事件', async () => {
    const events = [];
    for await (const event of agent.receive('你好')) {
      events.push(event);
    }
    const tokenEvents = events.filter(e => e.event === 'token');
    const doneEvents = events.filter(e => e.event === 'done');
    assert.ok(tokenEvents.length > 0, '应有 token 事件');
    assert.ok(doneEvents.length === 1, '应有 done 事件');
  });

  it('应该正确使用默认回复', async () => {
    model.reset();
    const events = [];
    for await (const event of agent.receive('任意消息')) {
      events.push(event);
    }
    const tokenEvents = events.filter(e => e.event === 'token');
    assert.ok(tokenEvents.length > 0);
  });

  it('应该处理工具调用', async () => {
    const toolModel = new MockModel({
      responses: [
        {
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"/etc/hostname"}' }
          }]
        },
        { content: '文件内容已读取完毕。' }
      ]
    });
    agent.updateModel(toolModel);
    const events = [];
    for await (const event of agent.receive('帮我看看文件')) {
      events.push(event);
    }
    const statusEvents = events.filter(e => e.event === 'status');
    const hasToolStatus = statusEvents.some(e =>
      e.data.state === 'reading_file'
    );
    assert.ok(hasToolStatus, '应有 reading_file 状态事件');
  });

  it('isConcurrencySafe=true 的只读工具应并发执行（CC processQueue 语义）', async () => {
    // 两个自定义只读工具（isConcurrencySafe=true），延迟执行；并发时 inFlight 峰值=2，串行则恒=1
    let inFlight = 0, maxInFlight = 0;
    const makeConcurrentTool = (name) => ({
      name,
      description: name,
      isConcurrencySafe: true,
      callSummary: () => name,
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 40));
        inFlight--;
        return `${name} done`;
      }
    });
    const tr = new ToolRegistry();
    tr.register(makeConcurrentTool('ConcA'));
    tr.register(makeConcurrentTool('ConcB'));
    const concurrentAgent = new Agent({ config, model: new MockModel({
      responses: [
        { tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'ConcA', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'ConcB', arguments: '{}' } },
        ] },
        { content: 'done' }
      ]
    }), toolRegistry: tr, messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }) });

    const events = [];
    for await (const e of concurrentAgent.receive('并发跑两个工具')) events.push(e);
    assert.ok(maxInFlight >= 2, `两个只读工具应并发执行,maxInFlight=${maxInFlight} 应为 2`);
    // 两个 tool_result 都应按原序返回
    const results = events.filter(e => e.event === 'tool_result');
    assert.equal(results.length, 2, '应有两个 tool_result 事件');
  });

  it('isConcurrencySafe=false 的写工具应串行执行（不并发）', async () => {
    let inFlight = 0, maxInFlight = 0;
    const makeSerialTool = (name) => ({
      name,
      description: name,
      isConcurrencySafe: false,
      callSummary: () => name,
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 40));
        inFlight--;
        return `${name} done`;
      }
    });
    const tr = new ToolRegistry();
    tr.register(makeSerialTool('SerA'));
    tr.register(makeSerialTool('SerB'));
    const serialAgent = new Agent({ config, model: new MockModel({
      responses: [
        { tool_calls: [
          { id: 's1', type: 'function', function: { name: 'SerA', arguments: '{}' } },
          { id: 's2', type: 'function', function: { name: 'SerB', arguments: '{}' } },
        ] },
        { content: 'done' }
      ]
    }), toolRegistry: tr, messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }) });

    const events = [];
    for await (const e of serialAgent.receive('串行跑两个写工具')) events.push(e);
    assert.equal(maxInFlight, 1, `写工具应串行,maxInFlight=${maxInFlight} 应为 1`);
    const results = events.filter(e => e.event === 'tool_result');
    assert.equal(results.length, 2, '应有两个 tool_result 事件');
  });

  it('混合批次：只读并发 + 写工具串行，结果按原序', async () => {
    // 顺序 [ConcA(读), SerX(写), ConcB(读)]：ConcA/ConcB 不与 SerX 并发
    let inFlight = 0, maxInFlight = 0;
    const makeTool = (name, safe) => ({
      name, description: name, isConcurrencySafe: safe, callSummary: () => name,
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 30));
        inFlight--;
        return `${name} done`;
      }
    });
    const tr = new ToolRegistry();
    tr.register(makeTool('ConcA', true));
    tr.register(makeTool('SerX', false));
    tr.register(makeTool('ConcB', true));
    const mixAgent = new Agent({ config, model: new MockModel({
      responses: [
        { tool_calls: [
          { id: 'm1', type: 'function', function: { name: 'ConcA', arguments: '{}' } },
          { id: 'm2', type: 'function', function: { name: 'SerX', arguments: '{}' } },
          { id: 'm3', type: 'function', function: { name: 'ConcB', arguments: '{}' } },
        ] },
        { content: 'done' }
      ]
    }), toolRegistry: tr, messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }) });

    const events = [];
    for await (const e of mixAgent.receive('混合')) events.push(e);
    // 写工具不与只读并发 → 峰值不超 1（ConcA 单独跑、SerX 单独、ConcB 单独，因中间夹写工具把并发段拆开）
    assert.ok(maxInFlight === 1, `混合批次写工具串行点拆开并发段,maxInFlight=${maxInFlight} 应为 1`);
    assert.equal(events.filter(e => e.event === 'tool_result').length, 3, '三个 tool_result');
  });

  it('done 事件应包含 usage 信息', async () => {
    const events = [];
    for await (const event of agent.receive('你好')) {
      events.push(event);
    }
    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent);
    assert.ok(doneEvent.data.usage);
    assert.ok(typeof doneEvent.data.usage.prompt_tokens === 'number');
  });

  it('status 事件应包含 thinking 状态', async () => {
    const events = [];
    for await (const event of agent.receive('你好')) {
      events.push(event);
    }
    const thinkingStatus = events.find(e => e.event === 'status' && e.data.state === 'thinking');
    assert.ok(thinkingStatus, '应有 thinking 状态事件');
  });

  it('Agent Loop 达到 maxIterations 时应终止并发 error 事件', async () => {
    const toolCallResponse = {
      tool_calls: [{
        id: 'call_loop',
        type: 'function',
        function: { name: 'Read', arguments: '{"file_path":"/tmp/fake"}' }
      }]
    };
    const loopModel = new MockModel({
      responses: [toolCallResponse, toolCallResponse, toolCallResponse, toolCallResponse, toolCallResponse]
    });
    const loopConfig = createTestConfig({ maxIterations: 2 });
    const loopMM = new MessageManager({
      systemPrompt: '你是助手',
      memoryTokenLimit: 80000
    });
    const loopTR = new ToolRegistry();
    loopTR.register(Read);
    const loopAgent = new Agent({ config: loopConfig, model: loopModel, toolRegistry: loopTR, messageManager: loopMM });

    const events = [];
    for await (const event of loopAgent.receive('不断调用工具')) {
      events.push(event);
    }
    const errorEvent = events.find(e => e.event === 'error');
    assert.ok(errorEvent, '应有 error 事件');
    assert.ok(errorEvent.data.message.includes('Max iterations'), `error 消息应包含 Max iterations，实际: ${errorEvent.data.message}`);
    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent, '即使达到 maxIterations 也应有 done 事件');
  });

  it('LLM 调用失败时应发送 SSE error 事件', async () => {
    // 创建一个会抛错的 mock model
    const errorModel = {
      async *chatStream() {
        throw new Error('API rate limit exceeded');
      },
      async chat() {
        throw new Error('API rate limit exceeded');
      }
    };
    agent.updateModel(errorModel);

    const events = [];
    for await (const event of agent.receive('触发错误')) {
      events.push(event);
    }
    const errorEvent = events.find(e => e.event === 'error');
    assert.ok(errorEvent, '应有 error 事件');
    assert.ok(errorEvent.data.message.includes('LLM API error'), `error 消息应包含 LLM API error，实际: ${errorEvent.data.message}`);
    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent, 'LLM 错误后也应有 done 事件');
  });

  it('记忆压缩时应发送 compact_start 事件', async () => {
    const compactModel = new MockModel({
      responses: [
        { content: '这是一段足够长的回复内容用于触发记忆压缩功能测试。' },
        { content: '<summary>这是压缩后的摘要。</summary>' },
      ]
    });
    const compactMM = new MessageManager({
      systemPrompt: '你是一个有用的助手，请回答用户的问题。',
      memoryTokenLimit: 10
    });
    const compactAgent = new Agent({ config, model: compactModel, toolRegistry, messageManager: compactMM });

    const events = [];
    for await (const event of compactAgent.receive('这是一段很长的用户消息用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行。')) {
      events.push(event);
    }
    const compactStartEvent = events.find(e => e.event === 'compact_start');
    assert.ok(compactStartEvent, '应有 compact_start 事件');
  });
});

// ========================
// Agent HTTP 服务测试
// ========================
describe('Agent HTTP Server', () => {
  let server, agent, model, config;
  const testPort = 9876;

  before(async () => {
    config = createTestConfig({ port: testPort });

    model = new MockModel({
      responses: [{ content: '你好！很高兴见到你。' }]
    });

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(Read);

    const messageManager = new MessageManager({
      systemPrompt: config.get('systemPrompt') || '你是助手',
      memoryTokenLimit: 8000
    });

    agent = new Agent({ config, model, toolRegistry, messageManager });
    const app = createAgentServer(agent, config);

    await new Promise((resolve) => {
      server = app.listen(testPort, resolve);
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('GET /status 应返回 ok', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.agentId, 'test-agent');
  });

  it('GET /config 应返回配置', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/config`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.agentId, 'test-agent');
    assert.ok(data.model);
  });

  it('POST /chat 应返回 SSE 流', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' })
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/event-stream'));

    const text = await res.text();
    assert.ok(text.includes('event: token'));
    assert.ok(text.includes('event: done'));
  });

  it('POST /chat 缺少 message 应返回 400', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 400);
  });

  it('并发请求应串行处理', async () => {
    const [res1, res2] = await Promise.all([
      fetch(`http://127.0.0.1:${testPort}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '第一条消息' })
      }),
      fetch(`http://127.0.0.1:${testPort}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '第二条消息' })
      })
    ]);
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
    const [text1, text2] = await Promise.all([res1.text(), res2.text()]);
    assert.ok(text1.includes('event: done'), '第一个请求应有 done 事件');
    assert.ok(text2.includes('event: done'), '第二个请求应有 done 事件');
  });

  it('消息合并：忙碌期间的消息应合并为一条', async () => {
    const slowModel = new MockModel({
      responses: [{ content: '慢速回复' }],
      delayMs: 50
    });
    const slowMM = new MessageManager({
      systemPrompt: 'test',
      memoryTokenLimit: 8000
    });
    const slowTR = new ToolRegistry();
    slowTR.register(Read);
    const slowConfig = createTestConfig({ port: testPort + 10 });
    const slowAgent = new Agent({ config: slowConfig, model: slowModel, toolRegistry: slowTR, messageManager: slowMM });
    const slowApp = createAgentServer(slowAgent, slowConfig);
    const slowPort = testPort + 10;
    const slowServer = await new Promise((resolve) => {
      const s = slowApp.listen(slowPort, () => resolve(s));
    });

    try {
      const res1Promise = fetch(`http://127.0.0.1:${slowPort}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '第一条消息' })
      }).then(r => r.text());

      await new Promise(r => setTimeout(r, 30));

      const res2Promise = fetch(`http://127.0.0.1:${slowPort}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '第二条消息' })
      }).then(r => r.text());

      const [text1, text2] = await Promise.all([res1Promise, res2Promise]);
      assert.ok(text1.includes('event: done'), '第一个请求应有 done 事件');
      assert.ok(text2.includes('event: done'), '第二个请求应有 done 事件');

      const msgs = slowMM.messages;
      const userMsgs = msgs.filter(m => m.role === 'user');
      assert.equal(userMsgs.length, 2, `应有2条user消息（原始+合并），实际: ${userMsgs.length}`);
    } finally {
      await new Promise(r => slowServer.close(r));
    }
  });

  it('POST /abort 应中断当前请求', async () => {
    const slowModel = new MockModel({
      responses: [{ content: '这是一段足够长的慢速回复用于测试中断功能' }],
      delayMs: 100
    });
    const slowMM = new MessageManager({
      systemPrompt: 'test',
      memoryTokenLimit: 8000
    });
    const slowTR = new ToolRegistry();
    slowTR.register(Read);
    const slowConfig = createTestConfig({ port: testPort + 20 });
    const slowAgent = new Agent({ config: slowConfig, model: slowModel, toolRegistry: slowTR, messageManager: slowMM });
    const slowApp = createAgentServer(slowAgent, slowConfig);
    const slowPort = testPort + 20;
    const slowServer = await new Promise((resolve) => {
      const s = slowApp.listen(slowPort, () => resolve(s));
    });

    try {
      const resPromise = fetch(`http://127.0.0.1:${slowPort}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '测试中断' })
      }).then(r => r.text());

      await new Promise(r => setTimeout(r, 50));

      const abortRes = await fetch(`http://127.0.0.1:${slowPort}/abort`, { method: 'POST' });
      assert.equal(abortRes.status, 200);
      const abortData = await abortRes.json();
      assert.equal(abortData.status, 'ok');

      const text = await resPromise;
      assert.ok(text.includes('event: aborted'), `应包含 aborted 事件，实际内容: ${text.substring(0, 200)}`);
      assert.ok(text.includes('event: done'), '应包含 done 事件');
    } finally {
      await new Promise(r => slowServer.close(r));
    }
  });

  it('POST /abort 无活跃请求时应返回 ok', async () => {
    const abortRes = await fetch(`http://127.0.0.1:${testPort}/abort`, { method: 'POST' });
    assert.equal(abortRes.status, 200);
    const abortData = await abortRes.json();
    assert.equal(abortData.status, 'ok');
    assert.ok(abortData.message.includes('no active request'));
  });
});

// ========================
// Agent abort 机制单元测试
// ========================
describe('Agent abort', () => {
  let agent, model, messageManager, toolRegistry, config;

  beforeEach(() => {
    config = createTestConfig();

    model = new MockModel({
      responses: [{ content: '你好！很高兴见到你。' }]
    });

    toolRegistry = new ToolRegistry();
    toolRegistry.register(Read);

    messageManager = new MessageManager({
      systemPrompt: config.get('systemPrompt') || '你是助手',
      memoryTokenLimit: 8000
    });

    agent = new Agent({ config, model, toolRegistry, messageManager });
  });

  it('abort() 应设置 _aborted 标志并中断 AbortController', () => {
    assert.equal(agent._aborted, false);
    assert.equal(agent._abortController, null);
    agent.abort();
    assert.equal(agent._aborted, true);
  });

  it('LLM 调用期间 abort 应产生 aborted 事件', async () => {
    const slowModel = new MockModel({
      responses: [{ content: '这是一段足够长的慢速回复用于测试中断功能' }],
      delayMs: 50
    });
    agent.updateModel(slowModel);

    const events = [];
    const iter = agent.receive('测试中断');

    const consumePromise = (async () => {
      for await (const event of iter) {
        events.push(event);
      }
    })();

    await new Promise(r => setTimeout(r, 80));
    agent.abort();

    await consumePromise;

    const abortedEvent = events.find(e => e.event === 'aborted');
    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(abortedEvent, '应有 aborted 事件');
    assert.ok(doneEvent, '应有 done 事件');
  });

  it('reasoning 入口应重置 _aborted 标志', async () => {
    agent._aborted = true;

    const events = [];
    for await (const event of agent.receive('新的消息')) {
      events.push(event);
    }

    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent, '应有 done 事件');
    const abortedEvent = events.find(e => e.event === 'aborted');
    assert.ok(!abortedEvent, '不应有 aborted 事件');
  });
});