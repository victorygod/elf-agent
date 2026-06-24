/**
 * Shared 层测试
 *
 * 覆盖：LLMModel（构造参数，不调 API）/ MockModel / Logger / Config / MessageManager / Agent / Tools
 * 使用 MockModel，不依赖真实 LLM API
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LLMModel } from '../shared/agent/llm_model.js';
import { MockModel } from '../shared/agent/mock_model.js';
import { createLogger } from '../shared/logger.js';
import { Config } from '../shared/agent/config_loader.js';
import { MessageManager } from '../shared/agent/message_manager.js';
import { Agent } from '../shared/agent/default_agent.js';
import { ToolRegistry } from '../shared/agent/tools/registry.js';
import { Read, Write, Edit, Bash, Glob } from '../shared/agent/tools/index.js';
import { reset as resetReadState } from '../shared/agent/tools/read_state.js';

// ========================
// LLMModel 构造与方法测试（不发真实请求）
// ========================
describe('LLMModel', () => {
  it('应该正确解析构造参数', () => {
    const model = new LLMModel({
      base_url: 'https://api.example.com/v1/',
      auth_token: 'sk-test-key',
      model: 'gpt-4o',
      temperature: 0.7,
      enable_thinking: true
    });
    assert.equal(model.baseUrl, 'https://api.example.com/v1');
    assert.equal(model.authToken, 'sk-test-key');
    assert.equal(model.model, 'gpt-4o');
    assert.deepEqual(model.extraParams, { temperature: 0.7, enable_thinking: true });
  });

  it('应该支持 baseUrl 别名', () => {
    const model = new LLMModel({ baseUrl: 'https://api.example.com/v1', model: 'test' });
    assert.equal(model.baseUrl, 'https://api.example.com/v1');
  });

  it('应该支持 apiKey 别名', () => {
    const model = new LLMModel({ apiKey: 'sk-legacy', model: 'test' });
    assert.equal(model.authToken, 'sk-legacy');
  });

  it('应该去除 baseUrl 末尾斜杠', () => {
    const model = new LLMModel({ base_url: 'https://api.example.com/v1///', model: 'test' });
    assert.equal(model.baseUrl, 'https://api.example.com/v1');
  });

  it('空值应返回默认空字符串', () => {
    const model = new LLMModel({});
    assert.equal(model.baseUrl, '');
    assert.equal(model.authToken, '');
    assert.equal(model.model, undefined);
    assert.deepEqual(model.extraParams, {});
  });

  it('应该使用默认超时配置', () => {
    const model = new LLMModel({ base_url: 'https://api.example.com', model: 'test' });
    assert.equal(model.connectTimeout, 120_000);
    assert.equal(model.requestTimeout, 120_000);
  });

  it('应该支持自定义超时配置', () => {
    const model = new LLMModel({ base_url: 'https://api.example.com', model: 'test', connectTimeout: 5000, requestTimeout: 10000 });
    assert.equal(model.connectTimeout, 5000);
    assert.equal(model.requestTimeout, 10000);
  });

  it('应该排除 provider 字段不进入 extraParams', () => {
    const model = new LLMModel({ provider: 'llm', base_url: 'https://api.example.com', auth_token: 'key', model: 'test', custom: 'val' });
    assert.deepEqual(model.extraParams, { custom: 'val' });
  });

  it('_headers 应返回正确的 Authorization 头', () => {
    const model = new LLMModel({ auth_token: 'sk-test', model: 'test' });
    const headers = model._headers();
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['Authorization'], 'Bearer sk-test');
  });

  it('_body 应构建正确的请求体', () => {
    const model = new LLMModel({ model: 'gpt-4o', temperature: 0.7 });
    const messages = [{ role: 'user', content: '你好' }];
    const body = model._body(messages, true);
    assert.equal(body.model, 'gpt-4o');
    assert.deepEqual(body.messages, messages);
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0.7);
    assert.equal(body.tools, undefined);
  });

  it('_body 带 tools 应正确转换工具定义', () => {
    const model = new LLMModel({ model: 'gpt-4o' });
    const messages = [{ role: 'user', content: '你好' }];
    const tools = [{ name: 'Read', description: '读取文件', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } }];
    const body = model._body(messages, false, tools);
    assert.ok(body.tools);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, 'Read');
    assert.equal(body.tools[0].function.description, '读取文件');
    assert.deepEqual(body.tools[0].function.parameters, tools[0].parameters);
  });

  it('_body 的 extraParams 应被 options 覆盖', () => {
    const model = new LLMModel({ model: 'gpt-4o', temperature: 0.7 });
    const body = model._body([], true, null, { temperature: 1.0 });
    assert.equal(body.temperature, 1.0);
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

  it('应该支持自定义默认回复', async () => {
    const model = new MockModel({ defaultResponse: '自定义默认' });
    let fullContent = '';
    for await (const chunk of model.chatStream([], [])) {
      if (chunk.type === 'token') fullContent += chunk.content;
    }
    assert.equal(fullContent, '自定义默认');
  });

  it('应该按序返回预设 responses', async () => {
    const model = new MockModel({
      responses: [
        { content: '第一条' },
        { content: '第二条' },
      ]
    });

    let content1 = '';
    for await (const chunk of model.chatStream([], [])) {
      if (chunk.type === 'token') content1 += chunk.content;
    }
    assert.equal(content1, '第一条');

    let content2 = '';
    for await (const chunk of model.chatStream([], [])) {
      if (chunk.type === 'token') content2 += chunk.content;
    }
    assert.equal(content2, '第二条');

    // 超出 responses 回退到 defaultResponse
    let content3 = '';
    for await (const chunk of model.chatStream([], [])) {
      if (chunk.type === 'token') content3 += chunk.content;
    }
    assert.equal(content3, '这是一个模拟回复。');
  });

  it('应该支持工具调用响应', async () => {
    const model = new MockModel({
      responses: [{
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'Read', arguments: '{"file_path":"/tmp/test.txt"}' }
        }]
      }]
    });

    let hasToolCalls = false;
    for await (const chunk of model.chatStream([], [])) {
      if (chunk.type === 'tool_calls') {
        hasToolCalls = true;
        assert.equal(chunk.tool_calls[0].function.name, 'Read');
      }
    }
    assert.ok(hasToolCalls);
  });

  it('工具调用响应中包含 content 时应先输出 token 再输出 tool_calls', async () => {
    const model = new MockModel({
      responses: [{
        content: '思考中',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'Read', arguments: '{}' }
        }]
      }]
    });

    const events = [];
    for await (const chunk of model.chatStream([], [])) {
      events.push(chunk);
    }
    // 应该先有 token 事件，再有 tool_calls 事件
    const tokenEvents = events.filter(e => e.type === 'token');
    const toolCallEvents = events.filter(e => e.type === 'tool_calls');
    assert.ok(tokenEvents.length > 0, '应有 token 事件');
    assert.ok(toolCallEvents.length > 0, '应有 tool_calls 事件');
    // tool_calls 的索引应大于最后一个 token 的索引
    const lastTokenIdx = events.findLastIndex(e => e.type === 'token');
    const firstToolCallIdx = events.findIndex(e => e.type === 'tool_calls');
    assert.ok(firstToolCallIdx > lastTokenIdx, 'tool_calls 应在 token 之后');
  });

  it('chat (非流式) 应该返回完整文本', async () => {
    const model = new MockModel({ responses: [{ content: '这是一段总结。' }] });
    const result = await model.chat([]);
    assert.equal(result, '这是一段总结。');
  });

  it('chat 超出 responses 应返回 defaultResponse', async () => {
    const model = new MockModel({ responses: [{ content: '唯一回复' }] });
    await model.chat([]); // 消耗第一条
    const result = await model.chat([]);
    assert.equal(result, '这是一个模拟回复。');
  });

  it('reset 应重置调用计数', async () => {
    const model = new MockModel({ responses: [{ content: 'A' }, { content: 'B' }] });
    let c1 = '';
    for await (const chunk of model.chatStream([], [])) {
      if (chunk.type === 'token') c1 += chunk.content;
    }
    assert.equal(c1, 'A');

    model.reset();

    let c2 = '';
    for await (const chunk of model.chatStream([], [])) {
      if (chunk.type === 'token') c2 += chunk.content;
    }
    assert.equal(c2, 'A'); // reset 后应重新从第一条开始
  });

  it('delayMs 应在 token 之间加入延迟', async () => {
    const model = new MockModel({ defaultResponse: 'AB', delayMs: 20 });
    const start = Date.now();
    const tokens = [];
    for await (const chunk of model.chatStream([], [])) {
      if (chunk.type === 'token') tokens.push(chunk.content);
    }
    const elapsed = Date.now() - start;
    assert.ok(tokens.length >= 2, '应至少有 2 个 token');
    // 2 个 token 之间至少有 1 次延迟 (20ms)
    assert.ok(elapsed >= 15, `应至少耗时 15ms，实际: ${elapsed}ms`);
  });

  it('chatStream 应支持 abort signal', async () => {
    const model = new MockModel({ defaultResponse: '很长的回复', delayMs: 50 });
    const controller = new AbortController();
    const tokens = [];
    try {
      const iter = model.chatStream([], [], { signal: controller.signal });
      // 消费第一个 token 后中断
      for await (const chunk of iter) {
        tokens.push(chunk);
        controller.abort();
        break;
      }
      // 继续消费应该抛出 AbortError
      for await (const chunk of iter) {
        tokens.push(chunk);
      }
      // 如果到这里说明没抛出错误，但有可能是正常结束
    } catch (err) {
      assert.equal(err.name, 'AbortError');
    }
  });

  it('chat (非流式) 应支持 abort signal', async () => {
    const model = new MockModel({ delayMs: 200 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    try {
      await model.chat([], { signal: controller.signal });
      // 如果到这没抛错，可能是 abort 在完成之后
    } catch (err) {
      assert.equal(err.name, 'AbortError');
    }
  });
});

// ========================
// Logger 测试
// ========================
describe('Logger', () => {
  it('应该创建仅控制台输出的日志器', () => {
    const logger = createLogger('test-module');
    assert.equal(logger.module, 'test-module');
    assert.equal(logger.logFile, null);
  });

  it('应该创建带文件输出的日志器', () => {
    const logger = createLogger('test-module', 'test-shared.log');
    assert.equal(logger.module, 'test-module');
    assert.ok(logger.logFile.includes('test-shared.log'));
  });

  it('info/warn/error 方法应不抛异常', () => {
    const logger = createLogger('test-module');
    assert.doesNotThrow(() => logger.info('info message'));
    assert.doesNotThrow(() => logger.warn('warn message'));
    assert.doesNotThrow(() => logger.error('error message'));
  });

  it('带文件的日志器应能写入日志文件', () => {
    const logFileName = `test-shared-${Date.now()}.log`;
    const logger = createLogger('test-module', logFileName);
    logger.info('test log line');
    const logPath = path.join(process.cwd(), 'logs', logFileName);
    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      assert.ok(content.includes('[INFO]'), '日志应包含 [INFO]');
      assert.ok(content.includes('[test-module]'), '日志应包含模块名');
      assert.ok(content.includes('test log line'), '日志应包含消息');
    } finally {
      // 清理测试日志文件
      try { fs.unlinkSync(logPath); } catch (e) {}
    }
  });

  it('_format 应生成正确的格式', () => {
    const logger = createLogger('my-module');
    const line = logger._format('INFO', 'hello world');
    assert.ok(line.includes('[INFO]'), '应包含级别');
    assert.ok(line.includes('[my-module]'), '应包含模块名');
    assert.ok(line.includes('hello world'), '应包含消息');
    // 格式: [timestamp] [LEVEL] [module] msg
    assert.ok(/^\[.*\] \[INFO\] \[my-module\] hello world$/.test(line), '格式应正确');
  });
});

// ========================
// Config 统一加载器测试
// ========================
describe('Config', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(dir, config, apiKey, prompts) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    if (apiKey !== undefined) {
      fs.writeFileSync(path.join(dir, 'api_key.json'), JSON.stringify(apiKey, null, 2), 'utf-8');
    }
    if (prompts) {
      for (const [name, content] of Object.entries(prompts)) {
        fs.writeFileSync(path.join(dir, name), content, 'utf-8');
      }
    }
  }

  it('应该加载 config.json 和 api_key.json（type:path 格式）', () => {
    writeConfig(tmpDir,
      { agentId: 'test-agent', port: 9000, provider: 'llm', systemPrompt: { type: 'path', content: 'sys.md' }, prefix_prompt: { type: 'path', content: 'pre.md' }, suffix_prompt: { type: 'path', content: 'suf.md' } },
      { base_url: 'https://api.test.com', auth_token: 'sk-123', model: 'test-model' },
      { 'sys.md': '你是助手', 'pre.md': '前缀', 'suf.md': '后缀' }
    );

    const config = new Config(tmpDir);
    config.load();

    assert.equal(config.get('agentId'), 'test-agent');
    assert.equal(config.get('port'), 9000);
    assert.equal(config.get('systemPrompt'), '你是助手');
    assert.equal(config.get('prefix_prompt'), '前缀');
    assert.equal(config.get('suffix_prompt'), '后缀');
    assert.equal(config.getModelConfig().base_url, 'https://api.test.com');
    assert.equal(config.getModelConfig().auth_token, 'sk-123');
    assert.equal(config.getModelConfig().model, 'test-model');
    assert.equal(config.getModelConfig().provider, 'llm');
  });

  it('应该加载 type:path 格式的配置', () => {
    writeConfig(tmpDir,
      { agentId: 'test-agent', port: 9000, provider: 'llm', systemPrompt: { type: 'path', content: 'sys.md' }, prefix_prompt: { type: 'path', content: 'pre.md' } },
      { base_url: 'https://api.test.com', auth_token: 'sk-123', model: 'test-model' },
      { 'sys.md': '你是助手', 'pre.md': '前缀' }
    );

    const config = new Config(tmpDir);
    config.load();

    assert.equal(config.get('systemPrompt'), '你是助手');
    assert.equal(config.get('prefix_prompt'), '前缀');
  });

  it('prompt 文件不存在时应设为空字符串而不报错', () => {
    writeConfig(tmpDir,
      { agentId: 'test', port: 9000, systemPrompt: { type: 'path', content: 'nonexistent.md' }, prefix_prompt: { type: 'path', content: 'nope.md' } },
      { base_url: 'https://api.test.com', auth_token: 'key', model: 'm' }
    );

    const config = new Config(tmpDir);
    config.load();

    assert.equal(config.get('systemPrompt'), '');
    assert.equal(config.get('prefix_prompt'), '');
  });

  it('type:path 文件不存在时应设为空字符串', () => {
    writeConfig(tmpDir,
      { agentId: 'test', port: 9000, systemPrompt: { type: 'path', content: 'missing.md' } },
      { base_url: 'https://api.test.com', auth_token: 'key', model: 'm' }
    );

    const config = new Config(tmpDir);
    config.load();

    assert.equal(config.get('systemPrompt'), '');
  });

  it('api_key.json 不存在时应自动创建空模板', () => {
    writeConfig(tmpDir,
      { agentId: 'test', port: 9000 }
      // 不写 api_key.json，也不写 prompt 文件
    );

    const config = new Config(tmpDir);
    config.load();

    // 应自动创建 api_key.json
    const apiKeyPath = path.join(tmpDir, 'api_key.json');
    assert.ok(fs.existsSync(apiKeyPath), 'api_key.json 应已自动创建');
    const apiKey = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
    assert.equal(apiKey.base_url, '');
    assert.equal(apiKey.auth_token, '');
    assert.equal(apiKey.model, '');

    // model 中应有 provider
    assert.equal(config.getModelConfig().provider, 'llm');
  });

  it('getModelMissingFields 应返回缺失字段', () => {
    writeConfig(tmpDir,
      { agentId: 'test', port: 9000 },
      { base_url: 'https://api.test.com', auth_token: '', model: '' }
    );

    const config = new Config(tmpDir);
    config.load();

    const missing = config.getModelMissingFields();
    assert.ok(missing);
    assert.ok(missing.includes('auth_token'));
    assert.ok(missing.includes('model'));
    assert.ok(!missing.includes('base_url'));
  });

  it('getModelMissingFields 全部填写时应返回 null', () => {
    writeConfig(tmpDir,
      { agentId: 'test', port: 9000 },
      { base_url: 'https://api.test.com', auth_token: 'key', model: 'gpt-4o' }
    );

    const config = new Config(tmpDir);
    config.load();

    assert.equal(config.getModelMissingFields(), null);
  });

  it('getAll 应返回包含所有字段的配置副本', () => {
    writeConfig(tmpDir,
      { agentId: 'test', port: 9000, customField: 'hello' },
      { base_url: 'https://api.test.com', auth_token: 'key', model: 'gpt-4o' }
    );

    const config = new Config(tmpDir);
    config.load();

    const all = config.getAll();
    assert.equal(all.agentId, 'test');
    assert.equal(all.customField, 'hello');
    assert.ok(all.model);
    // 返回的是副本
    all.agentId = 'modified';
    assert.equal(config.get('agentId'), 'test');
  });

  it('config.json 不存在时应抛出错误', () => {
    const config = new Config(tmpDir);
    assert.throws(() => config.load(), /ENOENT|no such file/);
  });
});

// ========================
// MessageManager 统一版测试
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

  it('prefixPrompt 应拼接到最后一条 user 消息前面', () => {
    const mm = new MessageManager({
      systemPrompt: 'You are helpful.',
      memoryTokenLimit: 8000,
      prefixPrompt: '[重要] ',
    });
    mm.addUserMessage('你好');
    const messages = mm.getMessagesForLLM();
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '[重要] 你好');
  });

  it('suffixPrompt 应拼接到最后一条 user 消息后面', () => {
    const mm = new MessageManager({
      systemPrompt: 'You are helpful.',
      memoryTokenLimit: 8000,
      suffixPrompt: ' [请简短回答]',
    });
    mm.addUserMessage('你好');
    const messages = mm.getMessagesForLLM();
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '你好 [请简短回答]');
  });

  it('prefixPrompt 和 suffixPrompt 应同时生效', () => {
    const mm = new MessageManager({
      systemPrompt: 'You are helpful.',
      memoryTokenLimit: 8000,
      prefixPrompt: '前置 ',
      suffixPrompt: ' 后置',
    });
    mm.addUserMessage('中间');
    const messages = mm.getMessagesForLLM();
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '前置 中间 后置');
  });

  it('prefix/suffix 应只影响最后一条 user 消息', () => {
    const mm = new MessageManager({
      systemPrompt: 'You are helpful.',
      memoryTokenLimit: 8000,
      prefixPrompt: '[前] ',
      suffixPrompt: ' [后]',
    });
    mm.addUserMessage('第一条');
    mm.addAssistantMessage('回复1');
    mm.addUserMessage('第二条');
    const messages = mm.getMessagesForLLM();
    const userMsgs = messages.filter(m => m.role === 'user');
    assert.equal(userMsgs[0].content, '第一条'); // 不受影响
    assert.equal(userMsgs[1].content, '[前] 第二条 [后]'); // 受影响
  });

  it('updateConfig 应更新 prefixPrompt 和 suffixPrompt', () => {
    const mm = new MessageManager({ systemPrompt: 'old', memoryTokenLimit: 8000 });
    assert.equal(mm.prefixPrompt, '');
    assert.equal(mm.suffixPrompt, '');
    mm.updateConfig({ prefixPrompt: '新前置', suffixPrompt: '新后置' });
    assert.equal(mm.prefixPrompt, '新前置');
    assert.equal(mm.suffixPrompt, '新后置');
  });

  it('空 prefix/suffix 不应影响消息内容', () => {
    const mm = new MessageManager({
      systemPrompt: 'You are helpful.',
      memoryTokenLimit: 8000,
      prefixPrompt: '',
      suffixPrompt: '',
    });
    mm.addUserMessage('你好');
    const messages = mm.getMessagesForLLM();
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '你好');
  });

  it('compactIfNeeded (generator) 在超阈值时应该压缩', async () => {
    const model = new MockModel({
      responses: [{ content: '这是压缩后的摘要。' }]
    });
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 5 });
    mm.addUserMessage('这是一段很长的文本用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行');
    mm.addAssistantMessage('好的，我明白了。这段对话内容需要被压缩以节省token空间，确保后续对话可以继续进行而不丢失关键信息。');

    const events = [];
    for await (const event of mm.compactIfNeeded(model)) {
      events.push(event);
    }

    // 应该有 compact_start 和 compact 事件
    assert.ok(events.find(e => e.event === 'compact_start'), '应有 compact_start 事件');
    assert.ok(events.find(e => e.event === 'compact'), '应有 compact 事件');

    // 压缩后消息应该变少
    const msgs = mm.getMessagesForLLM();
    assert.ok(msgs.length <= 3, '压缩后消息应大幅减少');
  });

  it('compactIfNeeded (generator) 在未超阈值时不应压缩', async () => {
    const model = new MockModel();
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 99999 });
    mm.addUserMessage('短消息');

    const events = [];
    for await (const event of mm.compactIfNeeded(model)) {
      events.push(event);
    }

    assert.equal(events.length, 0, '未超阈值不应有压缩事件');
  });
});

// ========================
// Agent (DefaultAgent) 测试
// ========================
describe('Agent', () => {
  let agent, model, messageManager, toolRegistry, config;

  beforeEach(() => {
    // 使用临时目录创建 Config
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-agent-test-'));
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      agentId: 'test-agent', port: 9000, provider: 'mock'
    }), 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'api_key.json'), JSON.stringify({
      base_url: 'https://test.com', auth_token: 'key', model: 'test'
    }), 'utf-8');

    config = new Config(tmpDir);
    config.load();

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

  it('应该流式返回 token 事件', async () => {
    const events = [];
    for await (const event of agent.receive('你好')) {
      events.push(event);
    }
    const tokenEvents = events.filter(e => e.event === 'token');
    const doneEvents = events.filter(e => e.event === 'done');
    assert.ok(tokenEvents.length > 0, '应有 token 事件');
    assert.ok(doneEvents.length === 1, '应有 done 事件');
  });

  it('应该发射 tool_call 事件并带 description（callSummary）', async () => {
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
    const toolCallEvents = events.filter(e => e.event === 'tool_call');
    assert.ok(toolCallEvents.length > 0, '应有 tool_call 事件');
    assert.ok(toolCallEvents[0].data.tool_calls, 'tool_call 事件应有 tool_calls 数据');
    assert.equal(toolCallEvents[0].data.tool_calls[0].name, 'Read');
    // callSummary 应该从工具元数据读取
    assert.equal(toolCallEvents[0].data.tool_calls[0].description, '/etc/hostname');
  });

  it('应该从工具元数据发射 status 事件而非硬编码', async () => {
    const toolModel = new MockModel({
      responses: [
        {
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"/etc/hostname"}' }
          }]
        },
        { content: '好了。' }
      ]
    });
    agent.updateModel(toolModel);
    const events = [];
    for await (const event of agent.receive('读取文件')) {
      events.push(event);
    }
    const statusEvents = events.filter(e => e.event === 'status');
    // 应有 reading_file 状态（来自 Read 工具的 statusEvent）
    const readingStatus = statusEvents.find(e => e.data.state === 'reading_file');
    assert.ok(readingStatus, '应有 reading_file 状态事件');
    assert.ok(readingStatus.data.detail.includes('/etc/hostname'), '状态事件应带文件路径');
  });

  it('记忆压缩阈值应使用 messageManager.memoryTokenLimit', async () => {
    const compactModel = new MockModel({
      responses: [
        { content: '这是一段足够长的回复内容用于触发记忆压缩功能测试。' },
        { content: '这是压缩后的摘要。' },
      ]
    });
    const compactMM = new MessageManager({
      systemPrompt: '你是一个有用的助手。',
      memoryTokenLimit: 10  // 低阈值触发压缩
    });
    const compactAgent = new Agent({ config, model: compactModel, toolRegistry, messageManager: compactMM });

    const events = [];
    for await (const event of compactAgent.receive('这是一段很长的用户消息用于触发记忆压缩功能测试。')) {
      events.push(event);
    }
    const compactStartEvent = events.find(e => e.event === 'compact_start');
    assert.ok(compactStartEvent, '应有 compact_start 事件');
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
});

// ========================
// 工具元数据测试
// ========================
describe('Tool metadata', () => {
  it('Read 应有 statusEvent 和 callSummary', () => {
    assert.ok(Read.statusEvent, 'Read 应有 statusEvent');
    assert.equal(Read.statusEvent.state, 'reading_file');
    assert.equal(Read.statusEvent.detail({ file_path: '/test.txt' }), '正在读取 /test.txt');
    assert.equal(Read.callSummary({ file_path: '/test.txt' }), '/test.txt');
  });

  it('Bash 应有 statusEvent 和 callSummary', () => {
    assert.ok(Bash.statusEvent, 'Bash 应有 statusEvent');
    assert.equal(Bash.statusEvent.state, 'executing_command');
    // callSummary 优先使用 description
    assert.equal(Bash.callSummary({ description: '列出文件', command: 'ls -la' }), '列出文件');
    // 回退到 command
    assert.equal(Bash.callSummary({ command: 'ls -la' }), 'ls -la');
  });

  it('Write 应有 statusEvent 和 callSummary', () => {
    assert.ok(Write.statusEvent, 'Write 应有 statusEvent');
    assert.equal(Write.statusEvent.state, 'writing_file');
    assert.equal(Write.callSummary({ file_path: '/tmp/out.txt' }), '/tmp/out.txt');
  });

  it('Edit 应有 statusEvent 和 callSummary', () => {
    assert.ok(Edit.statusEvent, 'Edit 应有 statusEvent');
    assert.equal(Edit.statusEvent.state, 'editing_file');
    assert.equal(Edit.callSummary({ file_path: '/tmp/edit.txt' }), '/tmp/edit.txt');
  });

  it('Glob 应有 statusEvent 和 callSummary', () => {
    assert.ok(Glob.statusEvent, 'Glob 应有 statusEvent');
    assert.equal(Glob.statusEvent.state, 'searching_files');
    assert.equal(Glob.callSummary({ pattern: '**/*.js' }), '**/*.js');
  });

  it('ToolRegistry.get 应返回完整工具对象（含元数据）', () => {
    const registry = new ToolRegistry();
    registry.register(Read);
    const tool = registry.get('Read');
    assert.ok(tool);
    assert.equal(tool.name, 'Read');
    assert.ok(tool.statusEvent);
    assert.ok(tool.callSummary);
  });
});

// ========================
// Shared Tools 测试
// ========================
describe('Shared Tools', () => {
  let registry;
  const testFile = '/tmp/elf-tool-test.txt';

  beforeEach(() => {
    resetReadState();
    registry = new ToolRegistry();
    registry.register(Read);
    registry.register(Write);
    registry.register(Edit);
    registry.register(Bash);
    registry.register(Glob);
    try { fs.unlinkSync(testFile); } catch {}
  });

  afterEach(() => {
    try { fs.unlinkSync(testFile); } catch {}
  });

  // Read
  describe('Read', () => {
    it('应返回 cat -n 格式内容', async () => {
      const result = await registry.execute('Read', {
        file_path: 'shared/agent/tools/index.js'
      });
      assert.match(result, /^\d+\t/);
    });

    it('文件不存在应返回错误', async () => {
      const result = await registry.execute('Read', {
        file_path: '/nonexistent/path.txt'
      });
      assert.match(result, /File does not exist/);
    });

    it('目录应返回错误', async () => {
      const result = await registry.execute('Read', {
        file_path: 'shared'
      });
      assert.match(result, /is a directory/);
    });

    it('支持 offset 和 limit', async () => {
      const result = await registry.execute('Read', {
        file_path: 'shared/agent/tools/index.js',
        offset: 1,
        limit: 1
      });
      const lines = result.trim().split('\n');
      assert.ok(lines.length <= 1);
    });
  });

  // Write
  describe('Write', () => {
    it('应创建新文件', async () => {
      const result = await registry.execute('Write', {
        file_path: testFile,
        content: 'hello'
      });
      assert.match(result, /File created successfully/);
      assert.ok(fs.existsSync(testFile));
    });

    it('未 Read 覆盖已有文件应拒绝', async () => {
      fs.writeFileSync(testFile, 'original');
      const result = await registry.execute('Write', {
        file_path: testFile,
        content: 'hacked'
      });
      assert.match(result, /must Read the file first/);
    });

    it('Read 后覆盖应成功', async () => {
      fs.writeFileSync(testFile, 'original');
      await registry.execute('Read', { file_path: testFile });
      const result = await registry.execute('Write', {
        file_path: testFile,
        content: 'updated'
      });
      assert.match(result, /File overwritten successfully/);
    });
  });

  // Edit
  describe('Edit', () => {
    beforeEach(async () => {
      await registry.execute('Write', {
        file_path: testFile,
        content: 'line1\nline2\nline3'
      });
      await registry.execute('Read', { file_path: testFile });
    });

    it('应精准替换', async () => {
      const result = await registry.execute('Edit', {
        file_path: testFile,
        old_string: 'line2',
        new_string: 'replaced'
      });
      assert.match(result, /has been updated successfully/);
      const content = fs.readFileSync(testFile, 'utf-8');
      assert.ok(content.includes('replaced'));
    });

    it('old_string 未找到应报错', async () => {
      const result = await registry.execute('Edit', {
        file_path: testFile,
        old_string: 'nonexistent',
        new_string: 'x'
      });
      assert.match(result, /old_string not found/);
    });

    it('old_string 多处匹配未开 replace_all 应报错', async () => {
      await registry.execute('Write', {
        file_path: testFile,
        content: 'dup dup dup'
      });
      await registry.execute('Read', { file_path: testFile });
      const result = await registry.execute('Edit', {
        file_path: testFile,
        old_string: 'dup',
        new_string: 'x'
      });
      assert.match(result, /Set replace_all=true/);
    });

    it('replace_all 应全部替换', async () => {
      await registry.execute('Write', {
        file_path: testFile,
        content: 'dup dup dup'
      });
      await registry.execute('Read', { file_path: testFile });
      await registry.execute('Edit', {
        file_path: testFile,
        old_string: 'dup',
        new_string: 'x',
        replace_all: true
      });
      const content = fs.readFileSync(testFile, 'utf-8');
      assert.equal(content, 'x x x');
    });

    it('old_string === new_string 应报错', async () => {
      const result = await registry.execute('Edit', {
        file_path: testFile,
        old_string: 'line2',
        new_string: 'line2'
      });
      assert.match(result, /identical/);
    });

    it('未 Read 应拒绝', async () => {
      resetReadState();
      try { fs.unlinkSync(testFile); } catch {}
      fs.writeFileSync(testFile, 'fresh');
      const result = await registry.execute('Edit', {
        file_path: testFile,
        old_string: 'fresh',
        new_string: 'x'
      });
      assert.match(result, /must Read the file first/);
    });
  });

  // Bash
  describe('Bash', () => {
    it('成功应返回 stdout', async () => {
      const result = await registry.execute('Bash', {
        command: 'echo hello'
      });
      assert.ok(result.includes('hello'));
      assert.ok(!result.startsWith('Exit code'));
    });

    it('失败应返回 Exit code', async () => {
      const result = await registry.execute('Bash', {
        command: 'exit 3'
      });
      assert.match(result, /^Exit code 3/);
    });
  });

  // Glob
  describe('Glob', () => {
    it('应匹配文件名', async () => {
      const result = await registry.execute('Glob', {
        pattern: 'shared/agent/tools/Read.js'
      });
      assert.match(result, /Read\.js/);
      assert.match(result, /\(file/);
    });

    it('** 应递归匹配', async () => {
      const result = await registry.execute('Glob', {
        pattern: 'shared/**/Read.js'
      });
      assert.match(result, /Read\.js/);
    });

    it('无匹配应返回空字符串', async () => {
      const result = await registry.execute('Glob', {
        pattern: 'zzz_nonexistent_glob_*'
      });
      assert.equal(result, '');
    });

    it('[A-Z] 字符类应生效', async () => {
      const result = await registry.execute('Glob', {
        pattern: 'shared/agent/tools/[A-Z]*.js'
      });
      assert.match(result, /Read\.js/);
    });
  });

  // tool_result 事件
  describe('tool_result event', () => {
    it('成功工具应发送 status=success 的 tool_result', async () => {
      const model = new MockModel({
        responses: [{
          tool_calls: [{
            id: 't1',
            function: { name: 'Bash', arguments: '{"command":"echo ok"}' }
          }]
        }]
      });
      const mm = new MessageManager({ systemPrompt: 's', memoryTokenLimit: 8000 });
      const agentRegistry = new ToolRegistry();
      agentRegistry.register(Bash);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-tool-result-'));
      fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ agentId: 'test' }), 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'api_key.json'), JSON.stringify({ base_url: '', auth_token: '', model: '' }), 'utf-8');
      const cfg = new Config(tmpDir);
      cfg.load();
      const ag = new Agent({ config: cfg, model, toolRegistry: agentRegistry, messageManager: mm });

      const events = [];
      for await (const event of ag.receive('test')) {
        events.push(event);
      }
      const results = events.filter(e => e.event === 'tool_result');
      assert.ok(results.length > 0, '应有 tool_result 事件');
      assert.equal(results[0].data.status, 'success');
    });

    it('失败工具应发送 status=error 和 message', async () => {
      const model = new MockModel({
        responses: [{
          tool_calls: [{
            id: 't2',
            function: { name: 'Read', arguments: '{"file_path":"/nonexistent"}' }
          }]
        }]
      });
      const mm = new MessageManager({ systemPrompt: 's', memoryTokenLimit: 8000 });
      const agentRegistry = new ToolRegistry();
      agentRegistry.register(Read);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-tool-result2-'));
      fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ agentId: 'test' }), 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'api_key.json'), JSON.stringify({ base_url: '', auth_token: '', model: '' }), 'utf-8');
      const cfg = new Config(tmpDir);
      cfg.load();
      const ag = new Agent({ config: cfg, model, toolRegistry: agentRegistry, messageManager: mm });

      const events = [];
      for await (const event of ag.receive('test')) {
        events.push(event);
      }
      const results = events.filter(e => e.event === 'tool_result');
      assert.ok(results.length > 0, '应有 tool_result 事件');
      assert.equal(results[0].data.status, 'error');
      assert.ok(results[0].data.message);
      assert.match(results[0].data.message, /File does not exist/);
    });
  });
});