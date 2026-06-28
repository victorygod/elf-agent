/**
 * elf-001 专属 MessageManager 测试
 *
 * 测试 agents/elf-001/message_manager.js 的 prefix/suffix 注入逻辑
 * 使用 mock config 对象，不依赖真实配置文件
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageManager } from '../agents/elf-001/message_manager.js';
import { MockModel } from '../shared/agent/mock_model.js';

function createMockConfig(values = {}) {
  return { get: (key) => values[key] };
}

describe('elf-001 MessageManager', () => {
  it('构造函数应从 config 读取 prefix_prompt / suffix_prompt', () => {
    const config = createMockConfig({ prefix_prompt: '[前] ', suffix_prompt: ' [后]' });
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000, config });
    assert.equal(mm.prefixPrompt, '[前] ');
    assert.equal(mm.suffixPrompt, ' [后]');
  });

  it('prefix_prompt 应拼接到最后一条 user 消息前面', () => {
    const config = createMockConfig({ prefix_prompt: '[重要] ' });
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000, config });
    mm.addUserMessage('你好');
    const messages = mm.getMessagesForLLM();
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '[重要] 你好');
  });

  it('suffix_prompt 应拼接到最后一条 user 消息后面', () => {
    const config = createMockConfig({ suffix_prompt: ' [请简短回答]' });
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000, config });
    mm.addUserMessage('你好');
    const messages = mm.getMessagesForLLM();
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '你好 [请简短回答]');
  });

  it('prefix_prompt 和 suffix_prompt 应同时生效', () => {
    const config = createMockConfig({ prefix_prompt: '前置 ', suffix_prompt: ' 后置' });
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000, config });
    mm.addUserMessage('中间');
    const messages = mm.getMessagesForLLM();
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '前置 中间 后置');
  });

  it('prefix/suffix 应只影响最后一条 user 消息', () => {
    const config = createMockConfig({ prefix_prompt: '[前] ', suffix_prompt: ' [后]' });
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000, config });
    mm.addUserMessage('第一条');
    mm.addAssistantMessage('回复1');
    mm.addUserMessage('第二条');
    const messages = mm.getMessagesForLLM();
    const userMsgs = messages.filter(m => m.role === 'user');
    assert.equal(userMsgs[0].content, '第一条'); // 不受影响
    assert.equal(userMsgs[1].content, '[前] 第二条 [后]'); // 受影响
  });

  it('空 prefix/suffix 不应影响消息内容', () => {
    const config = createMockConfig({ prefix_prompt: '', suffix_prompt: '' });
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000, config });
    mm.addUserMessage('你好');
    const messages = mm.getMessagesForLLM();
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '你好');
  });

  it('无 config 时 prefix/suffix 应为空', () => {
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000 });
    assert.equal(mm.prefixPrompt, '');
    assert.equal(mm.suffixPrompt, '');
    mm.addUserMessage('你好');
    const messages = mm.getMessagesForLLM();
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '你好');
  });

  it('updateConfig 应从 config 重读 prefix/suffix', () => {
    const values = { prefix_prompt: '旧前', suffix_prompt: '旧后' };
    const config = createMockConfig(values);
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000, config });
    assert.equal(mm.prefixPrompt, '旧前');
    assert.equal(mm.suffixPrompt, '旧后');

    // 模拟 config 热更新
    values.prefix_prompt = '新前';
    values.suffix_prompt = '新后';
    mm.updateConfig({});
    assert.equal(mm.prefixPrompt, '新前');
    assert.equal(mm.suffixPrompt, '新后');
  });

  it('context.json 应存储裸内容（不含拼接）', () => {
    const config = createMockConfig({ prefix_prompt: '[前] ', suffix_prompt: ' [后]' });
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000, config });
    mm.addUserMessage('原始内容');
    // messages 数组里存储的是裸内容
    assert.equal(mm.messages[0].content, '原始内容');
    // getMessagesForLLM() 返回的才是拼接后的
    const messages = mm.getMessagesForLLM();
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '[前] 原始内容 [后]');
  });

  it('compactIfNeeded 中 estimateTokens 应包含 prefix/suffix', () => {
    const config = createMockConfig({ prefix_prompt: '很长的前缀内容用来测试token估算 ', suffix_prompt: ' 很长的后缀内容用来测试token估算' });
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000, config });
    mm.addUserMessage('短消息');
    // estimateTokens 应大于不含 prefix/suffix 时
    const mmNoPrefix = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000 });
    mmNoPrefix.addUserMessage('短消息');
    assert.ok(mm.estimateTokens() > mmNoPrefix.estimateTokens());
  });
});