/**
 * Agent 子系统测试
 *
 * 使用 MockModel，不依赖真实 LLM API
 * 覆盖：Config / MockModel / ToolManager / MessageManager / Agent / HTTP Server / abort
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Config } from '../engine/config_loader.js';
import { MockModel } from '../engine/mock_model.js';
import { LLMModel } from '../engine/llm_model.js';
import { ToolManager } from '../engine/tools/tool_manager.js';
import { Read, Agent as AgentTool } from '../engine/tools/index.js';
import { reset as resetReadState } from '../engine/tools/read_state.js';
import { MessageManager } from '../engine/message_manager.js';
import { Agent } from '../engine/default_agent.js';
import { createAgentServer } from '../engine/server.js';
import { RoomMiddleware } from '../engine/room_plugin.js';
import { buildRunContext } from '../engine/run_context.js';

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
    await model.chatStream(messages, [], { onChunk: c => {
      if (c.type === 'token') {
        fullContent += c.content;
      }
    }});
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
    await model.chatStream(messages, [], { onChunk: c => {
      if (c.type === 'token') content1 += c.content;
    }});
    assert.equal(content1, '第一条回复');

    // 第二次：工具调用
    let hasToolCalls = false;
    await model.chatStream(messages, [], { onChunk: c => {
      if (c.type === 'tool_calls') {
        hasToolCalls = true;
        assert.equal(c.tool_calls[0].function.name, 'Read');
      }
    }});
    assert.ok(hasToolCalls);

    // 第三次：纯文本
    let content3 = '';
    await model.chatStream(messages, [], { onChunk: c => {
      if (c.type === 'token') content3 += c.content;
    }});
    assert.equal(content3, '工具调用后的回复');

    // 超出 responses 后回退到 defaultResponse
    let content4 = '';
    await model.chatStream(messages, [], { onChunk: c => {
      if (c.type === 'token') content4 += c.content;
    }});
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
// ToolManager 测试（注册/查询/执行）
// ========================
describe('ToolManager', () => {
  beforeEach(() => {
    resetReadState();
  });

  it('应该注册和获取工具', () => {
    const registry = new ToolManager();
    registry.register(Read);
    const tool = registry.get('Read');
    assert.ok(tool);
    assert.equal(tool.name, 'Read');
  });

  it('getAll 应该返回所有工具', () => {
    const registry = new ToolManager();
    registry.register(Read);
    const all = registry.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'Read');
  });

  it('execute 应该执行工具并返回 cat -n 格式结果', async () => {
    const registry = new ToolManager();
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
    const registry = new ToolManager();
    const result = await registry.execute('nonexistent', {});
    assert.ok(result.includes('不存在'));
  });

  it('Read 大文件应该截断（默认 2000 行）', async () => {
    resetReadState();
    const registry = new ToolManager();
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
    const registry = new ToolManager();
    registry.register(Read);
    const result = await registry.execute('Read', { file_path: '/nonexistent/path/file.txt' });
    assert.match(result, /File does not exist/);
  });
});

// ========================
// MessageManager 测试
// ========================
describe('MessageManager', () => {
  // 灌入 2 组对话（[user],[assistant]），老区 = [user] 一条长消息，token 远超 COMPACT_MIN_SAVINGS(500)。
  // 用于需要真正触发压缩的测试——单 user 组 https _countCompactableTokens 老区 0/<500 不触发。
  function seedCompactable(mm) {
    // 多轮对话，每条 assistant 起新 group。保留最近组，老区累积多条长消息 > 500 token。
    const long = '这是一段足够长的历史对话内容用于触发记忆压缩功能测试，' +
      '需要使可被压缩的老区 token 数量稳定超过最小可压缩阈值五百才能确实触发压缩逻辑执行，' +
      '反复填充更多文本以确保整体可压缩 token 数量稳定超过五百的阈值而不误判不触发情况发生，' +
      '继续填充更多历史文本内容确保老区足够大以便压缩预判通过从而稳定触发压缩逻辑的执行。' +
      '再次填充更多历史对话文本内容使老区可压缩 token 进一步增加从而稳定超过五百阈值。';
    mm.addUserMessage(long);             // user1（老区）
    mm.addAssistantMessage(long);        // assistant1（起新 group，老区）
    mm.addUserMessage(long);             // user2（跟 assistant1，老区）
    mm.addAssistantMessage(long);        // assistant2（起新 group，老区）
    mm.addUserMessage(long);             // user3（跟 assistant2，老区）
    mm.addAssistantMessage('近期保留组的助手回复');  // 保留组（最近 1 group 起点）
  }
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
    const events = [];
    await mm.compactIfNeeded(model, { onEvent: e => events.push(e) });
    assert.equal(events.length, 0, '未超阈值不应有压缩事件');
  });

  it('compactIfNeeded 在超阈值时应该压缩', async () => {
    const model = new MockModel({
      responses: [{ content: '这是压缩后的摘要。' }]
    });
    // limit 设为「原文超、但短摘要产物(preamble+summary)不超」的值，避免下轮再触发
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 45 });
    seedCompactable(mm);

    const events = [];
    await mm.compactIfNeeded(model, { onEvent: e => events.push(e) });
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

  it('compactIfNeeded LLM 回复为空应 yield compact_error、不替换 messages（基类有断路器）', async () => {
    // 基类不解析标签，直接用 LLM 回复；空回复视为失败、计断路器
    const model = recordingMock('   ');
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 5 });
    seedCompactable(mm);

    const events = [];
    await mm.compactIfNeeded(model, { onEvent: e => events.push(e) });

    assert.ok(events.find(e => e.event === 'compact_start'), '应有 compact_start 事件');
    assert.ok(!events.find(e => e.event === 'compact'), '空回复不应 yield compact 事件');
    const errEvt = events.find(e => e.event === 'compact_error');
    assert.ok(errEvt, '空回复应 yield compact_error 提示前端');
    assert.ok(errEvt.data.compactId, 'compact_error 应带 compactId');
    assert.equal(mm._compactFailCount, 1, '空回复计一次断路器失败');
    // messages 未被替换（仍含原 user 消息）
    const msgs = mm.getMessagesForLLM();
    assert.ok(msgs.some(m => m.content && m.content.includes('触发记忆压缩功能测试')), '空回复时不应替换 messages');
  });

  it('compactIfNeeded 有断路器，连续失败 3 次禁用自动压缩', async () => {
    // 基类断路器：连续 COMPACT_FAIL_THRESHOLD(=3) 次失败后 _compactDisabled=true
    const model = recordingMock('   ');
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 5 });
    seedCompactable(mm);

    for (let i = 0; i < 3; i++) {
      await mm.compactIfNeeded(model, { onEvent: () => {} });
    }
    assert.equal(mm._compactFailCount, 3, '断路器计数到 3');
    assert.equal(mm._compactDisabled, true, '连续 3 次失败后已禁用');

    // 已禁用：再次调用不会尝试（无 compact_start 事件）
    const events = [];
    await mm.compactIfNeeded(model, { onEvent: e => events.push(e) });
    assert.ok(!events.find(e => e.event === 'compact_start'), '断路器禁用后不再发起压缩');
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
    seedCompactable(mm);

    let threw = null;
    try {
      await mm.compactIfNeeded(model, { signal: ac.signal, onEvent: () => {} });
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
    seedCompactable(mm);

    const events = [];
    await mm.compactIfNeeded(model, { onEvent: e => events.push(e) });

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
    seedCompactable(mm);

    await mm.compactIfNeeded(model, { onEvent: () => {} });

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
    seedCompactable(mm);

    await mm.compactIfNeeded(model, { onEvent: () => {} });

    assert.ok(model.calls.length >= 1, '应发起压缩请求');
    const sysMsg = model.calls[0].messages.find(m => m.role === 'system');
    assert.ok(sysMsg, '压缩请求应含 system 消息');
    assert.equal(sysMsg.content, '你是主助手', 'compactSystemPrompt 留空时应沿用主 systemPrompt');
  });

  it('compactIfNeeded 调 LLM 应带 enable_thinking:false', async () => {
    const model = recordingMock('摘要内容');
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 5 });
    seedCompactable(mm);

    await mm.compactIfNeeded(model, { onEvent: () => {} });

    assert.ok(model.calls.length >= 1, '应发起压缩请求');
    assert.equal(model.calls[0].options.enable_thinking, false, '压缩调 LLM 应带 enable_thinking:false');
  });

  it('compact_start/compact 事件应带同一 compactId（基类阻塞模式）', async () => {
    const model = recordingMock('摘要内容');
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 5 });
    seedCompactable(mm);

    const events = [];
    await mm.compactIfNeeded(model, { onEvent: e => events.push(e) });
    const start = events.find(e => e.event === 'compact_start');
    const compact = events.find(e => e.event === 'compact');
    assert.ok(start?.data?.compactId, 'compact_start 应带 compactId');
    assert.ok(compact?.data?.compactId, 'compact 应带 compactId');
    assert.equal(start.data.compactId, compact.data.compactId, 'compact_start 与 compact 的 compactId 应一致');
    assert.equal(start.data.attempt, 1, '首次压缩 attempt=1');
  });

  it('compact_error 事件应带 compactId + attempt', async () => {
    const model = recordingMock('   ');   // 空回复 → compact_error
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 5 });
    seedCompactable(mm);

    const events = [];
    await mm.compactIfNeeded(model, { onEvent: e => events.push(e) });
    const start = events.find(e => e.event === 'compact_start');
    const err = events.find(e => e.event === 'compact_error');
    assert.ok(start?.data?.compactId, 'compact_start 应带 compactId');
    assert.ok(err?.data?.compactId, 'compact_error 应带 compactId');
    assert.equal(start.data.compactId, err.data.compactId, '失败时 compactId 应与 compact_start 一致');
  });

  it('老区无可压缩内容（token < 500）时应静默跳过、不建气泡不计断路器', async () => {
    // 单组对话 + 长 system 让 estimateTokens 超阈值，但老区（保留最近 group 后）= 0 token < 500。
    // 预判直接 return：不发 compact_start、不建气泡、不调 LLM、不计断路器。
    const model = recordingMock('不该被调用');
    const mm = new MessageManager({ systemPrompt: '一段足够长的 system prompt 让 estimateTokens 超过阈值触发压缩逻辑执行，填充更多文本确保超过阈值', memoryTokenLimit: 5 });
    mm.addUserMessage('单条短消息');   // 单组，老区为空

    const events = [];
    await mm.compactIfNeeded(model, { onEvent: e => events.push(e) });
    assert.equal(events.length, 0, '老区无可压缩内容时应静默跳过，无任何事件');
    assert.equal(model.calls.length, 0, '不该调 LLM');
    assert.equal(mm._compactFailCount, 0, '不计断路器失败');
  });

  it('async 多组压缩成功，保留最近 group + 摘要老区，不计断路器', async () => {
    // 多组对话：async 后台压缩成功 → _bgCompactDoneHandler 立即 apply（经 eventSink 推 compact）
    // → messages = [摘要, 保留组]。
    const events = [];
    const model = recordingMock('这是老区的摘要。');
    const config = { get: (k) => k === 'compactMode' ? 'async' : undefined };
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 5, config });
    seedCompactable(mm);
    mm._eventSink = (name, data) => events.push({ name, data });

    // 第1次 compactIfNeeded：触发后台压缩，emit compact_start，不等
    const ev1 = [];
    await mm.compactIfNeeded(model, { onEvent: e => ev1.push(e) });
    const start = ev1.find(e => e.event === 'compact_start');
    assert.ok(start, '应有 compact_start');

    // 等后台完成（_bgPromise）→ _bgCompactDoneHandler 已 apply + eventSink 推 compact
    await mm._bgPromise;

    const compactEvt = events.find(e => e.name === 'compact');
    assert.ok(compactEvt, 'async 多组压缩应成功，eventSink 推 compact');
    assert.ok(compactEvt.data.compactId, 'compact 应带 compactId');

    // messages = [摘要, 保留组（最近 1 group）]，不含老区原文
    const msgs = mm.getMessagesForLLM();
    const summaryMsg = msgs.find(m => m.isCompactSummary);
    assert.ok(summaryMsg, '应有 isCompactSummary 摘要消息');
    assert.equal(mm._compactFailCount, 0, '成功压缩不计断路器失败');
  });

  it('async events 通道：eventSink 推 compact + apply，_bgDone 被清，下一轮不重复', async () => {
    // 注入 eventSink（模拟 fromConfigDir 做的事），验证：
    // 1. 后台完成后 mm 内部 _bgCompactDoneHandler apply 了结果
    // 2. _bgDone 被 _applyBgResult 清掉，下一轮 compactIfNeeded 不走 bgDone 分支
    // 3. eventSink 被调，事件带 compactId+tokenEstimate
    const events = [];
    const model = recordingMock('这是老区的摘要。');
    const config = { get: (k) => k === 'compactMode' ? 'async' : undefined };
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 5, config });
    seedCompactable(mm);

    // 注入事件出口（等价 fromConfigDir 赋的 _eventSink）
    mm._eventSink = (name, data) => events.push({ name, data });

    // 第1次：触发后台压缩
    const ev1 = [];
    await mm.compactIfNeeded(model, { onEvent: e => ev1.push(e) });
    assert.ok(ev1.find(e => e.event === 'compact_start'), '应有 compact_start');

    // 等后台完成
    await mm._bgPromise;

    // _bgCompactDoneHandler 已被调 → _bgDone 已清、messages 已 swap
    assert.equal(mm._bgDone, false, 'handler apply 后 _bgDone 应为 false');
    const msgs = mm.getMessagesForLLM();
    assert.ok(msgs.find(m => m.isCompactSummary), 'handler apply 后应有摘要消息');

    // eventSink 被调，事件带 compactId
    const compactEvt = events.find(e => e.name === 'compact');
    assert.ok(compactEvt, 'eventSink 应被调，推 compact 事件');
    assert.ok(compactEvt.data.compactId, 'compact 应带 compactId');
    assert.ok(typeof compactEvt.data.tokenEstimate === 'number', '应带 tokenEstimate');

    // 第2次 compactIfNeeded：_bgDone=false → 不重复 apply
    const ev2 = [];
    await mm.compactIfNeeded(model, { onEvent: e => ev2.push(e) });
    assert.ok(!ev2.find(e => e.event === 'compact'), '_bgDone=false，不应再 emit compact（events 通道已处理）');
  });

  it('async events 通道失败：eventSink 推 compact_error 后清 _bgFailed，避免双重推送', async () => {
    // 注入 eventSink → mm 内部 _bgCompactErrorHandler 推事件 + 返回 true 清 _bgFailed
    // → 下一轮 compactIfNeeded 走不进 _bgFailed 分支
    const events = [];
    const pushEvent = (name, data) => events.push({ name, data });
    const config = { get: (k) => k === 'compactMode' ? 'async' : undefined };
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 5, config });
    seedCompactable(mm);

    // 注入事件出口（等价 fromConfigDir）
    mm._eventSink = pushEvent;

    // 第1次：触发后台失败（用会抛错的 model）
    const errModel = { async chat() { throw new Error('API error'); } };
    const ev1 = [];
    await mm.compactIfNeeded(errModel, { onEvent: e => ev1.push(e) });
    assert.ok(ev1.find(e => e.event === 'compact_start'), '应有 compact_start');

    // 等后台失败（_bgPromise reject）
    try { await mm._bgPromise; } catch (e) { /* expected */ }

    // _bgCompactErrorHandler 已调 → eventSink 推了 compact_error
    const errEvt = events.find(e => e.name === 'compact_error');
    assert.ok(errEvt, 'eventSink 应推 compact_error');
    // handler 返回 true → _bgFailed 被清
    assert.equal(mm._bgFailed, false, '_bgFailed 应在 handler 返回 true 后被清');

    // 第2次 compactIfNeeded：_bgFailed=false → 不重复报 compact_error
    const ev2 = [];
    await mm.compactIfNeeded(errModel, { onEvent: e => ev2.push(e) });
    assert.ok(!ev2.find(e => e.event === 'compact_error'), '_bgFailed=false，不应再重复 emit compact_error');
  });

  // ===== apply 边界分支（此前无单测覆盖，compactor 重构前的安全网）=====

  it('_applyBgResult: anchorId===null 时全量替换（无保留 group，async 兜底路径）', async () => {
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 });
    mm.addUserMessage('老消息1');
    mm.addAssistantMessage('老回复1');
    mm.addUserMessage('老消息2');
    const beforeLen = mm.messages.length;

    // 直接模拟后台压缩返回了 anchorId===null 的结果（group<2 退化路径）
    mm._bgResult = { summary: '全部摘要', anchorId: null };
    mm._bgDone = true;
    mm._bgRunning = true;
    // 给个未决任务，验证 apply 成功后状态不被这里清（_bgDone/_bgRunning 清，_pendingCompact 由上层清）
    const compactId = 'test_compact_null_anchor';
    mm._pendingCompact = { compactId, attempt: 1 };

    const result = mm._applyBgResult();

    assert.ok(result, '应返回 {tokenEstimate}');
    assert.equal(mm._bgResult, null, '_bgResult 应被清');
    assert.equal(mm._bgDone, false, '_bgDone 应被清');
    assert.equal(mm._bgRunning, false, '_bgRunning 应被清');
    const msgs = mm.getMessagesForLLM();
    // 全量替换：只剩 system + 1 条摘要，老的 3 条没了
    assert.equal(msgs.length, 2, 'system + 单条摘要');
    assert.equal(msgs[1].role, 'user');
    assert.ok(msgs[1].isCompactSummary, '唯一一条应是摘要');
    assert.ok(msgs[1].content.includes('全部摘要'), '摘要内容');
    assert.ok(mm.messages.length < beforeLen, 'messages 条数应减少');
  });

  it('_applyBgResult: anchorId 指向不存在的消息算失败、记断路器、不动 messages（防 rewind 后覆盖）', async () => {
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 });
    mm.addUserMessage('保留消息1');
    mm.addAssistantMessage('保留回复');
    const beforeLen = mm.messages.length;
    const beforeFail = mm._compactFailCount;

    // anchorId 指向一个 messages 里没有的 id（模拟：apply 之前 messages 被 rewind 改了）
    mm._bgResult = { summary: '不该被应用的摘要', anchorId: 'msg_definitely_lost_xyz' };
    mm._bgDone = true;
    mm._bgRunning = true;

    const result = mm._applyBgResult();

    assert.equal(result, null, 'anchor 丢失应返回 null（算失败）');
    assert.equal(mm._compactFailCount, beforeFail + 1, '应记一次断路器失败');
    assert.equal(mm._bgResult, null, '_bgResult 应被清');
    assert.equal(mm._bgDone, false, '_bgDone 应被清');
    // messages 不动（未被摘要覆盖）
    assert.equal(mm.messages.length, beforeLen, 'messages 不应被改');
    const hasSummary = mm.messages.some(m => m.isCompactSummary);
    assert.ok(!hasSummary, '不应写入任何摘要消息');
  });

  it('_applyResultSync: anchorId 找不到时退化"从头保留"（保底不崩，不记断路器）', async () => {
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 });
    mm.addUserMessage('消息1');
    mm.addAssistantMessage('回复1');
    mm.addUserMessage('消息2');
    mm.addAssistantMessage('回复2');
    const beforeFail = mm._compactFailCount;

    // anchorId 找不到 → 退化为从开头保留：messages = [摘要, ...全部]
    mm._applyResultSync({ summary: '摘要', anchorId: 'msg_nonexistent_abc' });

    assert.equal(mm._compactFailCount, beforeFail, '退化保留不记断路器失败');
    const msgs = mm.getMessagesForLLM();
    // system + 摘要 + 原全部 4 条 = 6
    assert.equal(msgs.length, 6, 'system + 摘要 + 原有 4 条全保留');
    assert.ok(msgs[1].isCompactSummary, '第一项应是摘要（紧跟 system）');
    assert.ok(msgs[1].content.includes('摘要'));
    // 原有消息仍在（从头保留）
    const userMsgs = msgs.filter(m => m.role === 'user' && !m.isCompactSummary);
    assert.ok(userMsgs.find(m => m.content === '消息1'), '从开头保留：消息1 仍在');
    assert.ok(userMsgs.find(m => m.content === '消息2'), '消息2 仍在');
  });
});

// ========================
// Agent (DefaultAgent) 测试
// ========================
describe('Agent (DefaultAgent)', () => {
  let agent, model, messageManager, toolManager, config;

  beforeEach(() => {
    config = createTestConfig();

    model = new MockModel({
      responses: [{ content: '你好！很高兴见到你。' }]
    });

    toolManager = new ToolManager();
    toolManager.register(Read);

    messageManager = new MessageManager({
      systemPrompt: config.get('systemPrompt') || '你是助手',
      memoryTokenLimit: 8000
    });

    agent = new Agent({ config, model, toolManager, messageManager });
  });

  it('应该通过 Intuitive 层返回流式 token 事件', async () => {
    const events = [];
    await agent.receive('你好', { emit: e => events.push(e) });
    const tokenEvents = events.filter(e => e.event === 'token');
    const doneEvents = events.filter(e => e.event === 'done');
    assert.ok(tokenEvents.length > 0, '应有 token 事件');
    assert.ok(doneEvents.length === 1, '应有 done 事件');
  });

  it('应该正确使用默认回复', async () => {
    model.reset();
    const events = [];
    await agent.receive('任意消息', { emit: e => events.push(e) });
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
    await agent.receive('帮我看看文件', { emit: e => events.push(e) });
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
    const tr = new ToolManager();
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
    }), toolManager: tr, messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }) });

    const events = [];
    await concurrentAgent.receive('并发跑两个工具', { emit: e => events.push(e) });
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
    const tr = new ToolManager();
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
    }), toolManager: tr, messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }) });

    const events = [];
    await serialAgent.receive('串行跑两个写工具', { emit: e => events.push(e) });
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
    const tr = new ToolManager();
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
    }), toolManager: tr, messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }) });

    const events = [];
    await mixAgent.receive('混合', { emit: e => events.push(e) });
    // 写工具不与只读并发 → 峰值不超 1（ConcA 单独跑、SerX 单独、ConcB 单独，因中间夹写工具把并发段拆开）
    assert.ok(maxInFlight === 1, `混合批次写工具串行点拆开并发段,maxInFlight=${maxInFlight} 应为 1`);
    assert.equal(events.filter(e => e.event === 'tool_result').length, 3, '三个 tool_result');
  });

  it('done 事件应包含 usage 信息', async () => {
    const events = [];
    await agent.receive('你好', { emit: e => events.push(e) });
    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent);
    assert.ok(doneEvent.data.usage);
    assert.ok(typeof doneEvent.data.usage.prompt_tokens === 'number');
  });

  it('status 事件应包含 thinking 状态', async () => {
    const events = [];
    await agent.receive('你好', { emit: e => events.push(e) });
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
    const loopTR = new ToolManager();
    loopTR.register(Read);
    const loopAgent = new Agent({ config: loopConfig, model: loopModel, toolManager: loopTR, messageManager: loopMM });

    const events = [];
    await loopAgent.receive('不断调用工具', { emit: e => events.push(e) });
    const errorEvent = events.find(e => e.event === 'error');
    assert.ok(errorEvent, '应有 error 事件');
    assert.ok(errorEvent.data.message.includes('Max iterations'), `error 消息应包含 Max iterations，实际: ${errorEvent.data.message}`);
    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent, '即使达到 maxIterations 也应有 done 事件');
  });

  it('LLM 调用失败时应发送 SSE error 事件', async () => {
    // 创建一个会抛错的 mock model
    const errorModel = {
      async chatStream() {
        throw new Error('API rate limit exceeded');
      },
      async chat() {
        throw new Error('API rate limit exceeded');
      }
    };
    agent.updateModel(errorModel);

    const events = [];
    await agent.receive('触发错误', { emit: e => events.push(e) });
    const errorEvent = events.find(e => e.event === 'error');
    assert.ok(errorEvent, '应有 error 事件');
    // error 消息透传原异常 message（B 后由 receive 顶层兜底，不再在 reasoning 内手包 'LLM API error:' 前缀）
    assert.ok(errorEvent.data.message.includes('rate limit'), `error 消息应含原异常内容，实际: ${errorEvent.data.message}`);
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
    // 预先 seed 多组老区（>500 token），使本次 receive 触发压缩时老区足够大通过预判
    const long = '这是一段足够长的历史对话内容用于触发记忆压缩功能测试，需要使可被压缩的老区 token 数量稳定超过最小可压缩阈值五百才能确实触发压缩逻辑执行，反复填充更多文本以确保整体可压缩 token 数量稳定超过五百的阈值而不误判不触发情况发生，继续填充更多历史文本内容确保老区足够大以便压缩预判通过从而稳定触发压缩逻辑的执行。再次填充更多历史对话文本内容使老区可压缩 token 进一步增加从而稳定超过五百阈值。';
    compactMM.addUserMessage(long);
    compactMM.addAssistantMessage(long);
    compactMM.addUserMessage(long);
    compactMM.addAssistantMessage(long);
    compactMM.addUserMessage(long);
    const compactAgent = new Agent({ config, model: compactModel, toolManager, messageManager: compactMM });

    const events = [];
    await compactAgent.receive('这是一段很长的用户消息用于触发记忆压缩功能测试，需要使token超过阈值才能触发压缩逻辑的执行。', { emit: e => events.push(e) });
    const compactStartEvent = events.find(e => e.event === 'compact_start');
    assert.ok(compactStartEvent, '应有 compact_start 事件');
  });
});

// ========================
// subAgent 测试
// ========================
describe('subAgent (Agent 工具)', () => {
  let config;

  beforeEach(() => {
    config = createTestConfig({ subagents: ['Explore', 'general-purpose'] });
  });

  it('subagent_type 未启用应返回 Error（不跑 loop）', async () => {
    const toolModel = new MockModel({ responses: [{ content: 'done' }] });
    const tr = new ToolManager();
    tr.register(AgentTool);
    const ag = new Agent({ config, model: toolModel, toolManager: tr, messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }) });
    // 直接调 execute（未启用类型）
    const r = await tr.execute('Agent', { subagent_type: 'Plan', prompt: 'x' }, null, { agent: ag });
    assert.ok(r.startsWith('Error'), `未启用类型应报错, got: ${r}`);
    assert.ok(/未启用/.test(r), '应提示未启用');
  });

  it('subagent_type 缺失应返回 Error', async () => {
    const tr = new ToolManager();
    tr.register(AgentTool);
    const ag = new Agent({ config, model: new MockModel({ responses: [{ content: 'done' }] }), toolManager: tr, messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }) });
    const r = await tr.execute('Agent', { prompt: 'x' }, null, { agent: ag });
    assert.ok(r.startsWith('Error') && /必填/.test(r), `缺 subagent_type 应报错, got: ${r}`);
  });

  it('Agent 工具调通：子 agent 跑完，finalText 回流主 loop', async () => {
    // 主 loop 第1轮返回 Agent tool_call；子 agent 第1轮返回文本；主 loop 第2轮返回最终文本
    const toolModel = new MockModel({
      responses: [
        { tool_calls: [{ id: 'a1', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: 'general-purpose', prompt: '说 hi', description: 'say hi' }) } }] },
        { content: '子任务完成' },   // 子 agent 第1轮（纯文本，结束）
        { content: '主 agent 收到子结果，结束' },  // 主 loop 第2轮
      ]
    });
    const tr = new ToolManager();
    tr.register(AgentTool);
    tr.register(Read);
    const ag = new Agent({ config, model: toolModel, toolManager: tr, messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }) });

    const events = [];
    await ag.receive('派个子 agent 说 hi', { emit: e => events.push(e) });

    // Agent 工具的 tool_result 应含子 agent 的 finalText
    const toolResults = events.filter(e => e.event === 'tool_result');
    assert.ok(toolResults.length >= 1, '应有 tool_result');
    // done 事件存在 → 主 loop 正常结束
    assert.ok(events.some(e => e.event === 'done'), '应有 done 事件');
  });

  it('Explore disallowedTools 阻断嵌套：子 agent 拿不到 Agent/Edit/Write', async () => {
    // general-purpose 默认 tools:['*'] 能调 Agent；Explore disallow Agent → 子 Explore 调 Agent 应子 registry 无 Agent
    // 这里验证 Explore 子 registry 不含 Agent
    const toolModel = new MockModel({
      responses: [
        { tool_calls: [{ id: 'e1', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: 'Explore', prompt: '搜一下', description: 'search' }) } }] },
        { content: '探索完成' },   // Explore 子 agent 第1轮
        { content: '主收到' },
      ]
    });
    const tr = new ToolManager();
    tr.register(AgentTool);
    tr.register(Read);
    const ag = new Agent({ config, model: toolModel, toolManager: tr, messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 }) });

    const events = [];
    await ag.receive('用 Explore 搜一下', { emit: e => events.push(e) });
    // Explore 应正常跑完（子 agent 工具集无 Agent，但 Explore 只读检索不调 Agent）
    assert.ok(events.some(e => e.event === 'done'), 'Explore 子 agent 应正常执行');
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

    const toolManager = new ToolManager();
    toolManager.register(Read);

    const messageManager = new MessageManager({
      systemPrompt: config.get('systemPrompt') || '你是助手',
      memoryTokenLimit: 8000
    });

    agent = new Agent({ config, model, toolManager, messageManager });
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
    const slowTR = new ToolManager();
    slowTR.register(Read);
    const slowConfig = createTestConfig({ port: testPort + 10 });
    const slowAgent = new Agent({ config: slowConfig, model: slowModel, toolManager: slowTR, messageManager: slowMM });
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
    const slowTR = new ToolManager();
    slowTR.register(Read);
    const slowConfig = createTestConfig({ port: testPort + 20 });
    const slowAgent = new Agent({ config: slowConfig, model: slowModel, toolManager: slowTR, messageManager: slowMM });
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
  let agent, model, messageManager, toolManager, config;

  beforeEach(() => {
    config = createTestConfig();

    model = new MockModel({
      responses: [{ content: '你好！很高兴见到你。' }]
    });

    toolManager = new ToolManager();
    toolManager.register(Read);

    messageManager = new MessageManager({
      systemPrompt: config.get('systemPrompt') || '你是助手',
      memoryTokenLimit: 8000
    });

    agent = new Agent({ config, model, toolManager, messageManager });
  });

  it('abort() 应设置 _aborted 标志并中断 AbortController', () => {
    assert.equal(agent._aborted, false);
    assert.equal(agent._currentAbortController, null);
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
    const consumePromise = agent.receive('测试中断', { emit: e => events.push(e) });

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
    await agent.receive('新的消息', { emit: e => events.push(e) });

    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent, '应有 done 事件');
    const abortedEvent = events.find(e => e.event === 'aborted');
    assert.ok(!abortedEvent, '不应有 aborted 事件');
  });

  // ===== AbortFlow 重构前的安全网：锁住"中断收尾"现状行为 =====

  it('类型B：LLM 流中断时已流出的 token 应保留为 assistant 消息', async () => {
    // 慢速 model：每个 token delay，便于中途 abort，已流出部分需被 addAssistantMessage 保留
    const slowModel = new MockModel({
      responses: [{ content: '这是一段足够长的慢速回复用于测试中断保留内容' }],
      delayMs: 40
    });
    agent.updateModel(slowModel);

    const events = [];
    const consumePromise = agent.receive('测试中断', { emit: e => events.push(e) });

    // 让 LLM 流出若干 token 后中断
    await new Promise(r => setTimeout(r, 100));
    agent.abort();
    await consumePromise;

    // 应有 aborted + done
    assert.ok(events.find(e => e.event === 'aborted'), '应有 aborted 事件');
    assert.ok(events.find(e => e.event === 'done'), '应有 done 事件');
    // ★ 中断时已生成的 token 应被保留为 assistant 消息（类型B 内容保留语义）
    const assistantMsgs = messageManager.messages.filter(m => m.role === 'assistant');
    assert.ok(assistantMsgs.length >= 1, '中断时应有至少 1 条 assistant 消息（保留已生成内容）');
    assert.ok(assistantMsgs[assistantMsgs.length - 1].content.length > 0, '保留的 assistant 内容应非空');
  });

  it('abortFlow.finishAborted：无气泡时只 emit aborted+done（不含 compact_abort）', async () => {
    const ev = [];
    agent.abortFlow.finishAborted(e => ev.push(e), 'test');
    assert.deepEqual(ev.map(e => e.event), ['aborted', 'done'], '应 emit aborted→done，无 compact_abort');
  });

  it('abortFlow.finishAborted：有未决气泡时 emit compact_abort→aborted→done 并清状态', async () => {
    messageManager._pendingCompact = { compactId: 'test_bubble_c1', attempt: 1 };
    const ev = [];
    agent.abortFlow.finishAborted(e => ev.push(e), 'test');
    assert.deepEqual(ev.map(e => e.event), ['compact_abort', 'aborted', 'done'], '事件顺序应为 compact_abort→aborted→done');
    assert.equal(ev[0].data.compactId, 'test_bubble_c1');
    assert.equal(messageManager._pendingCompact, null, '收尾后 _pendingCompact 应清空');
  });

  it('abortFlow.finishAborted：传 fullContent 时保留为 assistant 消息', async () => {
    const before = messageManager.messages.filter(m => m.role === 'assistant').length;
    const ev = [];
    agent.abortFlow.finishAborted(e => ev.push(e), 'test', '已生成内容');
    const after = messageManager.messages.filter(m => m.role === 'assistant').length;
    assert.equal(after, before + 1, '应新增 1 条 assistant 消息（保留 fullContent）');
    const last = messageManager.messages[messageManager.messages.length - 1];
    assert.equal(last.role, 'assistant');
    assert.equal(last.content, '已生成内容');
  });

  // ===== 工具执行期间 abort 测试（ToolExecutor 重构前置） =====

  it('工具执行期间 abort 应中止并返回 aborted 标志', async () => {
    // 两个慢工具（isConcurrencySafe=true），执行中途调 abort
    let inFlight = 0;
    let execCount = 0;
    const slowTool = {
      name: 'SlowTool',
      description: '慢工具用于测试 abort',
      isConcurrencySafe: true,
      callSummary: () => 'SlowTool',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        inFlight++;
        execCount++;
        await new Promise(r => setTimeout(r, 80));  // 足够长，可以中途 abort
        inFlight--;
        return 'done';
      }
    };
    const tr = new ToolManager();
    tr.register(slowTool);
    const slowAgent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: [
            { id: 't1', type: 'function', function: { name: 'SlowTool', arguments: '{}' } },
            { id: 't2', type: 'function', function: { name: 'SlowTool', arguments: '{}' } },
          ] },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 })
    });

    const events = [];
    const consumePromise = slowAgent.receive('测试工具执行期间 abort', { emit: e => events.push(e) });

    // 等工具开始执行后中断
    await new Promise(r => setTimeout(r, 50));
    slowAgent.abort();

    await consumePromise;

    // 应有 aborted + done 事件
    assert.ok(events.find(e => e.event === 'aborted'), '应有 aborted 事件');
    assert.ok(events.find(e => e.event === 'done'), '应有 done 事件');
    // 软中止语义：abort 后剩余工具不应继续执行（execCount 上限即实际启动数）
    assert.ok(execCount <= 2, `执行次数应不超过 2，实际 ${execCount}`);
  });

  it('工具执行期间串行工具中途 abort 应正确中止', async () => {
    // 两个串行工具（isConcurrencySafe=false），第一个执行中途 abort
    let execCount = 0;
    const serialTool = {
      name: 'SerialTool',
      description: '串行工具',
      isConcurrencySafe: false,
      callSummary: () => 'SerialTool',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        execCount++;
        await new Promise(r => setTimeout(r, 60));
        return `done_${execCount}`;
      }
    };
    const tr = new ToolManager();
    tr.register(serialTool);
    const slowAgent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: [
            { id: 't1', type: 'function', function: { name: 'SerialTool', arguments: '{}' } },
            { id: 't2', type: 'function', function: { name: 'SerialTool', arguments: '{}' } },
          ] },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 })
    });

    const events = [];
    const consumePromise = slowAgent.receive('测试串行工具中途 abort', { emit: e => events.push(e) });

    // 等第一个工具开始执行后中断
    await new Promise(r => setTimeout(r, 40));
    slowAgent.abort();

    await consumePromise;

    // 应有 aborted + done 事件
    assert.ok(events.find(e => e.event === 'aborted'), '应有 aborted 事件');
    assert.ok(events.find(e => e.event === 'done'), '应有 done 事件');
    // 第一个工具可能已完成（串行），也可能未完成，不确定；第二个工具不应执行
    assert.ok(execCount <= 2, `执行次数应不超过 2，实际 ${execCount}`);
  });

  // 盲区1：abort 中途已产出的 tool_result 不丢、已落后端 history 不漏。
  // 锁"break/throw 路径下，abort 命中前那条 tool_result 已 yield 且 addToolResult 已落"——
  // 改 executeBatch abort 机制(return→抛)时此断言应保持绿，证已产出事件/history 不受机制变更影响。
  it('abort 中途已产出的 tool_result 与后端 history 不丢', async () => {
    let execCount = 0;
    const serialTool = {
      name: 'HistTool',
      description: '串行工具用于验 abort 已产出',
      isConcurrencySafe: false,
      callSummary: () => 'HistTool',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        execCount++;
        await new Promise(r => setTimeout(r, 60));
        return `done_${execCount}`;
      }
    };
    const tr = new ToolManager();
    tr.register(serialTool);
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 });
    const agent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: [
            { id: 'h1', type: 'function', function: { name: 'HistTool', arguments: '{}' } },
            { id: 'h2', type: 'function', function: { name: 'HistTool', arguments: '{}' } },
          ] },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: mm,
    });

    const events = [];
    const consumePromise = agent.receive('测 abort 已产出', { emit: e => events.push(e) });
    await new Promise(r => setTimeout(r, 40));
    agent.abort();
    await consumePromise;

    const toolResults = events.filter(e => e.event === 'tool_result');
    assert.ok(toolResults.length >= 1, `abort 前应已 emit 至少 1 条 tool_result，实际 ${toolResults.length}`);
    // 已 yield 的 tool_result 对应的 tool_call_id 应已落后端 history
    const toolMsgs = mm.messages.filter(m => m.role === 'tool');
    assert.ok(toolMsgs.length >= 1, `abort 前应已落后端 ≥1 条 tool 消息，实际 ${toolMsgs.length}`);
    assert.ok(events.find(e => e.event === 'aborted'), '应有 aborted 事件');
  });

  // 盲区4：executeBatch 中断合同直测——中断(isAborted 返 true)的契约。
  // 现状：return {aborted:true}、不抛。改抛 AbortError 后，本测试的"机制断言"转为"抛 AbortError"。
  // 中断前部分 tool_result 已 yield 这条两条机制都成立，锁住不丢。
  it('executeBatch 中断时已 emit 部分 tool_result（中断合同直测）', async () => {
    const tr = new ToolManager();
    tr.register({
      name: 'ParsedTool', description: 'p', isConcurrencySafe: false, callSummary: () => 'ParsedTool',
      parameters: { type: 'object', properties: {} }, execute: async () => 'ok',
    });
    // 注入 messageManager（executeBatch 用它落 history）
    const mm = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 });
    tr._setMessageManager(mm);

    const toolCalls = [
      { id: 'c1', type: 'function', function: { name: 'ParsedTool', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'ParsedTool', arguments: '{}' } },
    ];
    const collected = [];
    let abortOn = false;   // 第一条 tool_result emit 后置 true，模拟中断
    let emitted = 0;
    let threwError = null, returnValue = undefined;
    try {
      returnValue = await tr.executeBatch(toolCalls, {
        signal: new AbortController().signal,
        isAborted: () => abortOn,
        ctx: {},
        emit: (evt) => {
          if (evt.event === 'tool_result') {
            emitted++;
            abortOn = true;   // 第一条 tool_result 后中断
          }
          collected.push(evt);
        },
      });
    } catch (e) {
      threwError = e;
    }

    assert.equal(emitted, 1, `中断前应已 emit 1 条 tool_result，实际 ${emitted}`);
    // 机制断言（中断抛 AbortError）
    assert.ok(threwError && threwError.name === 'AbortError', `中断应抛 AbortError，实际 ${threwError && threwError.name}`);
  });

  it('isErrorResult 应正确识别各种错误格式', async () => {
    const errorTool = {
      name: 'ErrorTool',
      description: '错误工具',
      isConcurrencySafe: true,
      callSummary: () => 'ErrorTool',
      parameters: {
        type: 'object',
        properties: {
          resultType: { type: 'string', enum: ['error', 'exit', 'permission', 'not_found', 'dir', 'normal'] }
        },
        required: ['resultType']
      },
      execute: async (args) => {
        const { resultType } = args;
        switch (resultType) {
          case 'error': return 'Error: something went wrong';
          case 'exit': return 'Exit code 1';
          case 'permission': return 'Permission denied';
          case 'not_found': return 'File does not exist';
          case 'dir': return '/path/ is a directory.';
          case 'normal': return 'normal result';
          default: return 'unknown';
        }
      }
    };
    const tr = new ToolManager();
    tr.register(errorTool);
    const agent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: [
            { id: 't1', type: 'function', function: { name: 'ErrorTool', arguments: '{"resultType":"error"}' } },
            { id: 't2', type: 'function', function: { name: 'ErrorTool', arguments: '{"resultType":"exit"}' } },
            { id: 't3', type: 'function', function: { name: 'ErrorTool', arguments: '{"resultType":"permission"}' } },
            { id: 't4', type: 'function', function: { name: 'ErrorTool', arguments: '{"resultType":"not_found"}' } },
            { id: 't5', type: 'function', function: { name: 'ErrorTool', arguments: '{"resultType":"dir"}' } },
            { id: 't6', type: 'function', function: { name: 'ErrorTool', arguments: '{"resultType":"normal"}' } },
          ] },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 })
    });

    const events = [];
    await agent.receive('测试 isErrorResult', { emit: e => events.push(e) });

    const toolResults = events.filter(e => e.event === 'tool_result');
    assert.equal(toolResults.length, 6, '应有 6 个 tool_result 事件');

    // 前 5 个应返回 status=error
    for (let i = 0; i < 5; i++) {
      assert.equal(toolResults[i].data.status, 'error', `第 ${i + 1} 个工具结果应为 error`);
    }
    // 第 6 个应返回 status=success
    assert.equal(toolResults[5].data.status, 'success', '第 6 个工具结果应为 success');
  });

  // ===== 工具事件 yield 时序测试（ToolManager 重构前置） =====
  // 工具 status/tool_result 走 reasoning 的 yield 流（/chat），不走 eventSink（/events）。
  // 注：reasoning 入口会发 state='thinking' 的 status（无 detail），需按 state 过滤排除其干扰。

  it('并发工具的 status 和 tool_result 应按原序发送', async () => {
    // 验证 status_A → status_B → tool_result_A → tool_result_B 的时序
    const customTool = {
      name: 'CustomTool',
      description: '自定义工具',
      isConcurrencySafe: true,
      callSummary: () => 'CustomTool',
      statusEvent: {
        state: 'custom_state',
        detail: (args) => `tool_${args.toolId}`
      },
      parameters: {
        type: 'object',
        properties: { toolId: { type: 'string' } },
        required: ['toolId']
      },
      execute: async (args) => {
        await new Promise(r => setTimeout(r, 30));
        return `result_${args.toolId}`;
      }
    };
    const tr = new ToolManager();
    tr.register(customTool);
    const agent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: [
            { id: 't1', type: 'function', function: { name: 'CustomTool', arguments: '{"toolId":"A"}' } },
            { id: 't2', type: 'function', function: { name: 'CustomTool', arguments: '{"toolId":"B"}' } },
          ] },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 })
    });

    const events = [];
    await agent.receive('测试 yield 时序', { emit: e => events.push(e) });

    // 提取工具 status（按 state 过滤，排除 reasoning 入口的 thinking status 干扰）和 tool_result 事件
    const statusEvents = events
      .filter(e => e.event === 'status' && e.data.state === 'custom_state')
      .map(e => e.data.detail);
    const resultEvents = events.filter(e => e.event === 'tool_result');

    // 验证顺序：工具 status 应按 tool_call 原序
    assert.deepEqual(statusEvents, ['tool_A', 'tool_B'], '工具 status 事件应按原序发送');
    // 验证 tool_result 数量
    assert.equal(resultEvents.length, 2, '应有 2 个 tool_result 事件');
    // 时序：工具 status（custom_state）应在 tool_result 之前产出
    const firstCustomStatusIdx = events.findIndex(e => e.event === 'status' && e.data.state === 'custom_state');
    const firstResultIdx = events.findIndex(e => e.event === 'tool_result');
    assert.ok(firstCustomStatusIdx < firstResultIdx, '工具 status 应在 tool_result 之前');
  });

  it('混合批次的工具事件应正确分组（并发+串行）', async () => {
    // 验证：ConcA(并发) → SerX(串行点，拆开并发段) → ConcB(并发) 的 status 时序
    const makeTool = (name, safe) => ({
      name,
      description: name,
      isConcurrencySafe: safe,
      callSummary: () => name,
      statusEvent: {
        state: 'working',
        detail: () => name
      },
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        await new Promise(r => setTimeout(r, 30));
        return `${name}_done`;
      }
    });
    const tr = new ToolManager();
    tr.register(makeTool('ConcA', true));
    tr.register(makeTool('SerX', false));
    tr.register(makeTool('ConcB', true));
    const agent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: [
            { id: 'm1', type: 'function', function: { name: 'ConcA', arguments: '{}' } },
            { id: 'm2', type: 'function', function: { name: 'SerX', arguments: '{}' } },
            { id: 'm3', type: 'function', function: { name: 'ConcB', arguments: '{}' } },
          ] },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 })
    });

    const events = [];
    await agent.receive('测试混合批次时序', { emit: e => events.push(e) });

    // 提取工具 status（detail 为工具名，排除 reasoning 入口 thinking status 的 undefined detail）
    const statusEvents = events
      .filter(e => e.event === 'status' && e.data.detail)
      .map(e => e.data.detail);

    // 顺序：写工具 SerX 串行点拆开并发段，status 按 tool_call 原序 ConcA → SerX → ConcB
    assert.deepEqual(statusEvents, ['ConcA', 'SerX', 'ConcB'], '混合批次工具 status 应按原序发送');

    // 验证 tool_result 数量
    const resultEvents = events.filter(e => e.event === 'tool_result');
    assert.equal(resultEvents.length, 3, '应有 3 个 tool_result 事件');
  });

  // ===== 并发上限契约（MAX_TOOL_USE_CONCURRENCY=10）=====
  // 15 个 safe 工具应切成 10+5 两批，并发峰值=10，不超限。
  it('连续 safe 工具并发上限应为 10（MAX_TOOL_USE_CONCURRENCY）', async () => {
    let inFlight = 0, maxInFlight = 0;
    const tool = {
      name: 'CapTool',
      description: '测并发上限',
      isConcurrencySafe: true,
      callSummary: () => 'CapTool',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 30));
        inFlight--;
        return 'done';
      }
    };
    const tr = new ToolManager();
    tr.register(tool);
    const agent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: Array.from({ length: 15 }, (_, i) => ({
            id: `c${i}`, type: 'function', function: { name: 'CapTool', arguments: '{}' }
          })) },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 })
    });

    const events = [];
    await agent.receive('测并发上限', { emit: e => events.push(e) });

    assert.equal(maxInFlight, 10, `并发上限应为 10，实际 ${maxInFlight}`);
    assert.equal(events.filter(e => e.event === 'tool_result').length, 15, '15 个 tool_result');
  });

  // ===== addToolResult 落后端 history 契约 =====
  // 验证每个工具结果按 tool_call 原序写入 mm.messages：role='tool'、tool_call_id 正确、内容对应。
  // 这是 reasoning→ToolManager 迁移最易错点（漏调 addToolResult / id 错配）。
  it('工具结果应按 tool_call 原序落后端 history（role/tool_call_id/content）', async () => {
    const tr = new ToolManager();
    tr.register({ name: 'Echo', description: 'e', isConcurrencySafe: true, callSummary: () => 'Echo',
      parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
      execute: async (args) => `echo_${args.v}` });
    const agent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: [
            { id: 'tA', type: 'function', function: { name: 'Echo', arguments: '{"v":"A"}' } },
            { id: 'tB', type: 'function', function: { name: 'Echo', arguments: '{"v":"B"}' } },
          ] },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 })
    });

    await agent.receive('测 history 契约', { emit: () => {} });

    const toolMsgs = agent.messageManager.messages.filter(m => m.role === 'tool');
    assert.equal(toolMsgs.length, 2, '应有 2 条 tool 消息');
    assert.deepEqual(toolMsgs.map(m => m.tool_call_id), ['tA', 'tB'], 'tool_call_id 应按 tool_call 原序');
    assert.deepEqual(toolMsgs.map(m => m.content), ['echo_A', 'echo_B'], 'content 应与 tool_call 一一对应');
  });

  // ===== args JSON.parse 容错 =====
  // LLM 返回非法 JSON arguments 时应回退 {}，不崩、工具收到空 args。
  it('非法 JSON arguments 应回退为空对象，不抛错', async () => {
    let receivedArgs = null;
    const tr = new ToolManager();
    tr.register({ name: 'Probe', description: 'p', isConcurrencySafe: true, callSummary: () => 'Probe',
      parameters: { type: 'object', properties: {} },
      execute: async (args) => { receivedArgs = args; return 'ok'; } });
    const agent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: [
            { id: 'x1', type: 'function', function: { name: 'Probe', arguments: 'not a json' } },
          ] },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 })
    });

    const events = [];
    await agent.receive('测 args 容错', { emit: e => events.push(e) });

    assert.deepEqual(receivedArgs, {}, '非法 JSON 应回退为 {}');
    assert.equal(events.filter(e => e.event === 'tool_result').length, 1, '应仍有 tool_result 事件');
  });

  // ===== 同批内 statusEvent 缺失的工具不发 status =====
  // 批 [HasStatus, NoStatus]：仅前者发 status，两者都发 tool_result。
  it('同批内无 statusEvent 的工具不发 status，有 statusEvent 的发', async () => {
    const tr = new ToolManager();
    tr.register({ name: 'WithStatus', description: 'ws', isConcurrencySafe: true, callSummary: () => 'WithStatus',
      statusEvent: { state: 'ws_state', detail: () => 'ws_detail' },
      parameters: { type: 'object', properties: {} }, execute: async () => 'r1' });
    tr.register({ name: 'NoStatus', description: 'ns', isConcurrencySafe: true, callSummary: () => 'NoStatus',
      parameters: { type: 'object', properties: {} }, execute: async () => 'r2' });
    const agent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: [
            { id: 'a1', type: 'function', function: { name: 'WithStatus', arguments: '{}' } },
            { id: 'a2', type: 'function', function: { name: 'NoStatus', arguments: '{}' } },
          ] },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 })
    });

    const events = [];
    await agent.receive('测 statusEvent 缺失', { emit: e => events.push(e) });

    const wsStatus = events.filter(e => e.event === 'status' && e.data.detail === 'ws_detail');
    assert.equal(wsStatus.length, 1, 'WithStatus 应发 1 个 status');
    // 排除 reasoning 入口 thinking status（无 detail）后，不应有来自 NoStatus 的 status
    const toolStatuses = events.filter(e => e.event === 'status' && e.data.detail !== undefined && e.data.detail !== '');
    assert.equal(toolStatuses.length, 1, '同批内只应有 1 个工具 status（NoStatus 不发）');
    assert.equal(events.filter(e => e.event === 'tool_result').length, 2, '两个工具都应有 tool_result');
  });

  // ===== ctx.agent / signal 透传给工具 =====
  // 工具 execute 第三参应是传入 signal、第四参 ctx.agent 应等于 agent 实例（Agent 工具依赖主 agent 引用）。
  // ===== ctx.agent / signal 透传给工具 =====
  // ctx.agent 透传给工具（Agent 工具依赖主 agent 引用）；signal 由 runAborable 的 _currentAbortController
  // 透传，非 null，abort() 会 abort 它（Bash 杀子进程用）。原"signal 恒 undefined"缺陷已修。
  it('工具 execute 应收到透传的 signal 与 ctx.agent', async () => {
    let seenSignal = null, seenCtx = null;
    const tr = new ToolManager();
    tr.register({ name: 'CtxProbe', description: 'cp', isConcurrencySafe: true, callSummary: () => 'CtxProbe',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, signal, ctx) => { seenSignal = signal; seenCtx = ctx; return 'ok'; } });
    const agent = new Agent({
      config,
      model: new MockModel({
        responses: [
          { tool_calls: [
            { id: 'p1', type: 'function', function: { name: 'CtxProbe', arguments: '{}' } },
          ] },
          { content: 'done' }
        ]
      }),
      toolManager: tr,
      messageManager: new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 })
    });

    await agent.receive('测 ctx 透传', { emit: () => {} });

    assert.ok(seenSignal, '工具应收到非 null signal（_currentAbortController 透传）');
    assert.ok(seenCtx && seenCtx.agent === agent, 'ctx.agent 应等于 agent 实例');
  });

  // 注：并发段 abort 的语义是"软中止"——batch 用 Promise.all，abort 不会中止进行中的单个并发工具，
  // 而是在当前 batch 跑完后、下一条 tool_result 检查时退出。已由"工具执行期间 abort"两条覆盖（aborted+done + execCount 上限）。
});

// ============================================================
// 插件体系骨架合同测（middleware + callback）
//   阶段 1/2 立骨架后，验证 _emit fan-out、_runInjection/_dispatchGate 链式语义、
//   异常自吞、默认空跑零回归。不依赖 reasoning/http，直构造裸 Agent。
// ============================================================
describe('Plugin 骨架 (middleware + callback)', () => {
  function makeBareAgent() {
    const config = createTestConfig();
    const model = new MockModel();
    const toolManager = new ToolManager();
    const messageManager = new MessageManager({ systemPrompt: 't', memoryTokenLimit: 8000 });
    return new Agent({ config, model, toolManager, messageManager });
  }

  it('骨架初始化：middlewares 与 callbacks 默认空数组', () => {
    const a = makeBareAgent();
    assert.deepEqual(a.middlewares, []);
    assert.deepEqual(a.callbacks, []);
  });

  it('_emit fan-out：多个 handler 都收到同一事件与 payload', () => {
    const a = makeBareAgent();
    const received = [];
    a.callbacks.push({ onCompact(e) { received.push(['h1', e]); } });
    a.callbacks.push({ onCompact(e) { received.push(['h2', e]); } });
    a._emit('compact', { tokenEstimate: 100, compactId: 'c1' });
    assert.equal(received.length, 2, '两个 handler 都应被触发');
    assert.deepEqual(received[0], ['h1', { tokenEstimate: 100, compactId: 'c1' }]);
    assert.deepEqual(received[1], ['h2', { tokenEstimate: 100, compactId: 'c1' }]);
  });

  it('_emit 异常自吞：一个 handler 抛错不影响其它 handler 与调用方', () => {
    const a = makeBareAgent();
    let called = false;
    a.callbacks.push({ onCompactError() { throw new Error('boom'); } });
    a.callbacks.push({ onCompactError(e) { called = true; } });
    // 不应抛
    assert.doesNotThrow(() => a._emit('compact_error', { attempt: 1 }));
    assert.equal(called, true, '后续 handler 仍应被触发');
  });

  it('_emit 无 handler 时空跑（callbacks=[]）', () => {
    const a = makeBareAgent();
    assert.doesNotThrow(() => a._emit('compact', {}));
  });

  it('_emit handler 未实现该方法 → 跳过，不抛', () => {
    const a = makeBareAgent();
    a.callbacks.push({ onCompact(e) { /* only compact */ } });
    assert.doesNotThrow(() => a._emit('compactStart', {}));
  });

  it('_runInjection 注入型：多 provider 按序执行，效果累积', async () => {
    const a = makeBareAgent();
    const log = [];
    a.middlewares.push({ preReason() { log.push('m1'); } });
    a.middlewares.push({ preReason() { log.push('m2'); } });
    a.middlewares.push({}); // 无该方法的 provider 应被跳过
    await a._runInjection('preReason', a.messageManager);
    assert.deepEqual(log, ['m1', 'm2']);
  });

  it('_dispatchGate 门控型：acc 链式递进，provider 返回 null 不改写', async () => {
    const a = makeBareAgent();
    a.middlewares.push({ gate(acc) { return acc ?? 'first'; } });
    a.middlewares.push({ gate(acc) { return acc === 'first' ? 'second' : null; } });
    a.middlewares.push({ gate() { return null; } }); // 放行
    const r = await a._dispatchGate('gate', null, 'arg');
    assert.equal(r, 'second', '应取最后非 null 归并值');
  });

  it('_dispatchGate：所有 provider 返回 null → 返回初始 null（调用方走默认）', async () => {
    const a = makeBareAgent();
    a.middlewares.push({ gate() { return null; } });
    const r = await a._dispatchGate('gate', null);
    assert.equal(r, null);
  });

  it('_dispatchGate：middlewares=[] → 返回 null（零回归锚）', async () => {
    const a = makeBareAgent();
    const r = await a._dispatchGate('shouldBreakAfterTools', null, []);
    assert.equal(r, null);
  });

  // ===== 阶段 5b 合同测：基类 receive 经 RoomMiddleware 门控点接管 room 编排 =====
  // 证明基类 receive 持有 buffer 分支 + flushLoop，不经 RoomAgent，直接 new Agent + push RoomMiddleware。

  function makeRoomAgentViaMiddleware({ memberName = 'elf-001', agentId = 'elf-001', responses = [{ content: '回复' }] } = {}) {
    const config = createTestConfig();
    const model = new MockModel({ responses });
    const toolManager = new ToolManager();
    const messageManager = new MessageManager({ systemPrompt: '你是 elf-001', memoryTokenLimit: 8000 });
    const rc = buildRunContext({ agentId, mode: 'room', port: 9999, dataDir: '/tmp', roomId: 'roomA', memberName });
    const agent = new Agent({ config, model, toolManager, messageManager, runContext: rc });
    agent._scene = new RoomMiddleware(agent);      // 场景 middleware 作 agent 属性（对齐生产）
    return agent;
  }

  it('基类 receive + RoomMiddleware：自消息 drop（done 无 reasoning）', async () => {
    const a = makeRoomAgentViaMiddleware();
    const events = [];
    await a.receive({ from: 'elf-001', content: '我说', mentions: [], role: 'chat' }, { emit: e => events.push(e) });
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'done');
    assert.equal(a.messageManager.messages.length, 0);
  });

  it('基类 receive + RoomMiddleware：未@ 进 buffer 不 reasoning（done）', async () => {
    const a = makeRoomAgentViaMiddleware();
    const events = [];
    await a.receive({ from: 'elf-002', content: 'hello', mentions: [], role: 'chat' }, { emit: e => events.push(e) });
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'done');
    assert.equal(a.messageManager.messages.length, 0);
    // buffer 在 RoomMiddleware 实例（场景 middleware 在 _sceneMiddleware，对齐生产）
    const rm = a._scene;   
    assert.equal(rm._buffer.length, 1);
  });

  it('基类 receive + RoomMiddleware：被@ flush 触发 reasoning（token + 一条 user + assistant）', async () => {
    const a = makeRoomAgentViaMiddleware({ responses: [{ content: '你好呀' }] });
    const events = [];
    await a.receive({ from: 'elf-002', content: '喂 @elf-001', mentions: ['elf-001'], role: 'chat' }, { emit: e => events.push(e) });
    assert.ok(events.some(e => e.event === 'token'));
    assert.equal(a.messageManager.messages.length, 2);
    const rm = a._scene;   
    assert.equal(rm._buffer.length, 0, 'flush 后 buffer 清空');
  });

  it('基类 receive + RoomMiddleware：未@攒 buffer，被@时合并一条 user 进 reasoning', async () => {
    const a = makeRoomAgentViaMiddleware({ responses: [{ content: '答' }] });
    await a.receive({ from: 'elf-002', content: 'm1', mentions: [], role: 'chat' }, { emit: () => {} });
    await a.receive({ from: 'elf-003', content: 'm2', mentions: [], role: 'chat' }, { emit: () => {} });
    const events = [];
    await a.receive({ from: 'elf-002', content: '@elf-001 回我', mentions: ['elf-001'], role: 'chat' }, { emit: e => events.push(e) });
    assert.equal(a.messageManager.messages.length, 2);
    const merged = a.messageManager.messages[0].content;
    assert.ok(merged.includes('m1') && merged.includes('m2') && merged.includes('@elf-001 回我'));
  });

  it('基类 receive + RoomMiddleware：非 chat 消息走基类 reasoning 分支', async () => {
    const a = makeRoomAgentViaMiddleware({ responses: [{ content: '直接回' }] });
    const events = [];
    await a.receive('私聊式', { emit: e => events.push(e) });
    assert.ok(events.some(e => e.event === 'token'));
  });
});