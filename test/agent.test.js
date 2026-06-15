/**
 * Agent 子系统测试
 * 使用 MockModel，不依赖真实 LLM API
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Config } from '../agents/elf-001/config.js';
import { MockModel } from '../shared/agent/mock_model.js';
import { LLMModel } from '../shared/agent/llm_model.js';
import { ToolRegistry } from '../agents/elf-001/tools/registry.js';
import { readFileTool } from '../agents/elf-001/tools/read_file.js';
import { MessageManager } from '../agents/elf-001/message_manager.js';
import { Agent } from '../agents/elf-001/agent.js';

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
    for await (const chunk of model.chat(messages, [])) {
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
            function: { name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' }
          }]
        },
        { content: '工具调用后的回复' },
      ]
    });
    const messages = [{ role: 'user', content: '你好' }];

    // 第一次：纯文本
    let content1 = '';
    for await (const chunk of model.chat(messages, [])) {
      if (chunk.type === 'token') content1 += chunk.content;
    }
    assert.equal(content1, '第一条回复');

    // 第二次：工具调用
    let hasToolCalls = false;
    for await (const chunk of model.chat(messages, [])) {
      if (chunk.type === 'tool_calls') {
        hasToolCalls = true;
        assert.equal(chunk.tool_calls[0].function.name, 'read_file');
      }
    }
    assert.ok(hasToolCalls);

    // 第三次：纯文本
    let content3 = '';
    for await (const chunk of model.chat(messages, [])) {
      if (chunk.type === 'token') content3 += chunk.content;
    }
    assert.equal(content3, '工具调用后的回复');

    // 超出 responses 后回退到 defaultResponse
    let content4 = '';
    for await (const chunk of model.chat(messages, [])) {
      if (chunk.type === 'token') content4 += chunk.content;
    }
    assert.equal(content4, '这是一个模拟回复。');
  });

  it('chatComplete 应该返回完整文本', async () => {
    const model = new MockModel({
      responses: [{ content: '这是一段总结。' }]
    });
    const messages = [{ role: 'user', content: '请总结一下' }];
    const result = await model.chatComplete(messages);
    assert.equal(result, '这是一段总结。');
  });
});

// ========================
// ToolRegistry 测试
// ========================
describe('ToolRegistry', () => {
  it('应该注册和获取工具', () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    const tool = registry.get('read_file');
    assert.ok(tool);
    assert.equal(tool.name, 'read_file');
  });

  it('getAll 应该返回所有工具', () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    const all = registry.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'read_file');
  });

  it('execute 应该执行工具并返回结果', async () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    const tmpPath = path.join(process.cwd(), 'test_tmp_file.txt');
    fs.writeFileSync(tmpPath, 'hello world', 'utf-8');
    try {
      const result = await registry.execute('read_file', { path: tmpPath });
      assert.equal(result, 'hello world');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('execute 不存在的工具应返回错误信息', async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute('nonexistent', {});
    assert.ok(result.includes('不存在'));
  });

  it('read_file 大文件应该截断', async () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    const tmpPath = path.join(process.cwd(), 'test_large_file.txt');
    const longContent = 'a'.repeat(15000);
    fs.writeFileSync(tmpPath, longContent, 'utf-8');
    try {
      const result = await registry.execute('read_file', { path: tmpPath });
      assert.ok(result.includes('[文件过长，已截断]'));
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('read_file 不存在的文件应返回错误信息', async () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    const result = await registry.execute('read_file', { path: '/nonexistent/path/file.txt' });
    assert.ok(result.includes('[读取失败'));
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

  it('compactIfNeeded 在未超阈值时不应压缩', async () => {
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000 });
    mm.addUserMessage('少量文本');
    const model = new MockModel();
    const result = await mm.compactIfNeeded(model);
    assert.equal(result, null);
  });

  it('compactIfNeeded 在超阈值时应该压缩', async () => {
    const model = new MockModel({
      responses: [{ content: '这是压缩后的摘要。' }]
    });
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 5 });
    mm.addUserMessage('这是一段很长的文本用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行');
    mm.addAssistantMessage('好的，我明白了。这段对话内容需要被压缩以节省token空间，确保后续对话可以继续进行而不丢失关键信息。');
    const result = await mm.compactIfNeeded(model);
    assert.ok(result);
    const msgs = mm.getMessagesForLLM();
    assert.equal(msgs[0].role, 'system');
    assert.ok(msgs.length <= 3);
  });
});

// ========================
// Agent 集成测试（使用 MockModel）
// ========================
describe('Agent (with MockModel)', () => {
  let agent, model, messageManager, toolRegistry, config;

  beforeEach(() => {
    const configDir = path.join(process.cwd(), 'agents', 'elf-001', 'config');
    config = new Config(configDir);
    config.load();

    model = new MockModel({
      responses: [
        { content: '你好！很高兴见到你。' },
      ]
    });

    toolRegistry = new ToolRegistry();
    toolRegistry.register(readFileTool);

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
            function: { name: 'read_file', arguments: '{"path":"/etc/hostname"}' }
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
      e.data.state === 'tool_call' || e.data.state === 'reading_file'
    );
    assert.ok(hasToolStatus, '应有工具调用状态事件');
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
    // 用足够多的 tool_calls responses 使循环超出 maxIterations
    const toolCallResponse = {
      tool_calls: [{
        id: 'call_loop',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/tmp/fake"}' }
      }]
    };
    const loopModel = new MockModel({
      responses: [toolCallResponse, toolCallResponse, toolCallResponse, toolCallResponse, toolCallResponse]
    });
    const loopConfig = new Config(path.join(process.cwd(), 'agents', 'elf-001', 'config'));
    loopConfig.load();
    const loopMM = new MessageManager({
      systemPrompt: loopConfig.get('systemPrompt') || '你是助手',
      memoryTokenLimit: 80000
    });
    const loopTR = new ToolRegistry();
    loopTR.register(readFileTool);
    // 设置极低的 maxIterations
    loopConfig.data.maxIterations = 2;
    const loopAgent = new Agent({ config: loopConfig, model: loopModel, toolRegistry: loopTR, messageManager: loopMM });

    const events = [];
    for await (const event of loopAgent.receive('不断调用工具')) {
      events.push(event);
    }
    // 应有 error 事件表示达到最大迭代
    const errorEvent = events.find(e => e.event === 'error');
    assert.ok(errorEvent, '应有 error 事件');
    assert.ok(errorEvent.data.message.includes('Max iterations'), `error 消息应包含 Max iterations，实际: ${errorEvent.data.message}`);
    // done 事件仍应存在
    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent, '即使达到 maxIterations 也应有 done 事件');
  });

  it('LLM 调用失败时应发送 SSE error 事件', async () => {
    // 创建一个会抛错的 mock model
    const errorModel = {
      async *chat() {
        throw new Error('API rate limit exceeded');
      },
      async chatComplete() {
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
    // done 事件仍应存在
    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent, 'LLM 错误后也应有 done 事件');
  });

  it('记忆压缩时应发送 compact_start 事件', async () => {
    const compactModel = new MockModel({
      responses: [
        { content: '这是一段足够长的回复内容用于触发记忆压缩功能测试。' },  // 正常回复
        { content: '这是压缩后的摘要。' },  // 压缩用
      ]
    });
    const compactMM = new MessageManager({
      systemPrompt: '你是一个有用的助手，请回答用户的问题。',
      memoryTokenLimit: 10 // 低阈值触发压缩
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
    const configDir = path.join(process.cwd(), 'agents', 'elf-001', 'config');
    config = new Config(configDir);
    config.load();

    model = new MockModel({
      responses: [{ content: '你好！很高兴见到你。' }]
    });

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(readFileTool);

    const messageManager = new MessageManager({
      systemPrompt: config.get('systemPrompt') || '你是助手',
      memoryTokenLimit: 8000
    });

    agent = new Agent({ config, model, toolRegistry, messageManager });
    const { createAgentServer } = await import('../agents/elf-001/server.js');
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
    assert.equal(data.agentId, 'elf-001');
  });

  it('GET /config 应返回配置', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/config`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.agentId, 'elf-001');
    assert.ok(data.model);
    assert.ok(typeof data.model.auth_token === 'string');
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
    // 同时发送两个请求，验证都能正确返回
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
    // 两个请求都应包含 SSE 事件
    assert.ok(text1.includes('event: done'), '第一个请求应有 done 事件');
    assert.ok(text2.includes('event: done'), '第二个请求应有 done 事件');
  });

  it('消息合并：忙碌期间的消息应合并为一条', async () => {
    // 使用慢速 MockModel 使请求持续足够长
    const slowModel = new MockModel({
      responses: [{ content: '慢速回复' }],
      delayMs: 50
    });
    const slowMM = new MessageManager({
      systemPrompt: 'test',
      memoryTokenLimit: 8000
    });
    const slowTR = new ToolRegistry();
    slowTR.register(readFileTool);
    const slowConfig = new Config(path.join(process.cwd(), 'agents', 'elf-001', 'config'));
    slowConfig.load();
    const slowAgent = new Agent({ config: slowConfig, model: slowModel, toolRegistry: slowTR, messageManager: slowMM });
    const { createAgentServer } = await import('../agents/elf-001/server.js');
    const slowApp = createAgentServer(slowAgent, slowConfig);
    const slowPort = testPort + 10;
    const slowServer = await new Promise((resolve) => {
      const s = slowApp.listen(slowPort, () => resolve(s));
    });

    try {
      // 发送第一个请求（会开始处理）
      const res1Promise = fetch(`http://127.0.0.1:${slowPort}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '第一条消息' })
      }).then(r => r.text());

      // 等一下让第一个请求开始处理
      await new Promise(r => setTimeout(r, 30));

      // Agent 忙碌时发送第二条消息 — 应该被合并
      const res2Promise = fetch(`http://127.0.0.1:${slowPort}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '第二条消息' })
      }).then(r => r.text());

      // 等待两个请求都完成
      const [text1, text2] = await Promise.all([res1Promise, res2Promise]);

      // 两个请求都应成功返回 SSE 流
      assert.ok(text1.includes('event: done'), '第一个请求应有 done 事件');
      assert.ok(text2.includes('event: done'), '第二个请求应有 done 事件');

      // 验证消息合并：messageManager 中应只有两条 user 消息
      // （第一条：原始第一条消息，第二条：合并后的消息 "第二条消息"）
      // 而不是三条 user 消息（如果没合并的话）
      const msgs = slowMM.messages;
      const userMsgs = msgs.filter(m => m.role === 'user');
      assert.equal(userMsgs.length, 2, `应有2条user消息（原始+合并），实际: ${userMsgs.length}`);
      assert.equal(userMsgs[0].content, '第一条消息');
      assert.equal(userMsgs[1].content, '第二条消息');
    } finally {
      await new Promise(r => slowServer.close(r));
    }
  });

  it('POST /abort 应中断当前请求', async () => {
    // 使用慢速 MockModel 使请求持续足够长
    const slowModel = new MockModel({
      responses: [{ content: '这是一段足够长的慢速回复用于测试中断功能' }],
      delayMs: 100
    });
    const slowMM = new MessageManager({
      systemPrompt: 'test',
      memoryTokenLimit: 8000
    });
    const slowTR = new ToolRegistry();
    slowTR.register(readFileTool);
    const slowConfig = new Config(path.join(process.cwd(), 'agents', 'elf-001', 'config'));
    slowConfig.load();
    const slowAgent = new Agent({ config: slowConfig, model: slowModel, toolRegistry: slowTR, messageManager: slowMM });
    const { createAgentServer } = await import('../agents/elf-001/server.js');
    const slowApp = createAgentServer(slowAgent, slowConfig);
    const slowPort = testPort + 20;
    const slowServer = await new Promise((resolve) => {
      const s = slowApp.listen(slowPort, () => resolve(s));
    });

    try {
      // 发送请求
      const resPromise = fetch(`http://127.0.0.1:${slowPort}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '测试中断' })
      }).then(r => r.text());

      // 等待一下让请求开始处理
      await new Promise(r => setTimeout(r, 50));

      // 发送 abort 请求
      const abortRes = await fetch(`http://127.0.0.1:${slowPort}/abort`, { method: 'POST' });
      assert.equal(abortRes.status, 200);
      const abortData = await abortRes.json();
      assert.equal(abortData.status, 'ok');

      // 等待原始请求完成
      const text = await resPromise;

      // 应包含 aborted 事件
      assert.ok(text.includes('event: aborted'), `应包含 aborted 事件，实际内容: ${text.substring(0, 200)}`);
      // aborted 事件后应有 done 事件
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
    const configDir = path.join(process.cwd(), 'agents', 'elf-001', 'config');
    config = new Config(configDir);
    config.load();

    model = new MockModel({
      responses: [{ content: '你好！很高兴见到你。' }]
    });

    toolRegistry = new ToolRegistry();
    toolRegistry.register(readFileTool);

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
    // 使用慢速 MockModel 让 LLM 调用持续足够长时间
    const slowModel = new MockModel({
      responses: [{ content: '这是一段足够长的慢速回复用于测试中断功能' }],
      delayMs: 50
    });
    agent.updateModel(slowModel);

    const events = [];
    const iter = agent.receive('测试中断');

    // 开始消费事件
    const consumePromise = (async () => {
      for await (const event of iter) {
        events.push(event);
      }
    })();

    // 等待一些 token 产出后再 abort
    await new Promise(r => setTimeout(r, 80));
    agent.abort();

    // 等待 generator 完成
    await consumePromise;

    const abortedEvent = events.find(e => e.event === 'aborted');
    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(abortedEvent, '应有 aborted 事件');
    assert.ok(doneEvent, '应有 done 事件');
  });

  it('reasoning 入口应重置 _aborted 标志', async () => {
    // 先设置 _aborted
    agent._aborted = true;

    // 调用 receive 应重置
    const events = [];
    for await (const event of agent.receive('新的消息')) {
      events.push(event);
    }

    // 应正常完成（不被旧的 aborted 标志影响）
    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent, '应有 done 事件');
    const abortedEvent = events.find(e => e.event === 'aborted');
    assert.ok(!abortedEvent, '不应有 aborted 事件');
  });
});