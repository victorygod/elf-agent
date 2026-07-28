/**
 * prefix/suffix 注入器测试（重构前测 elf-001 mm 子类，重构后测 registerPrefixSuffixInjectors）。
 *
 * 重构：prefix/suffix 不再由 elf-001 message_manager 子类重写 getMessagesForLLM，
 *   改由 PromptAssembler 的 useWrapLastUser 注入器（engine/prompt/injectors.js registerPrefixSuffixInjectors）。
 * 本测试锚定注入器行为与旧子类逐行等价。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageManager } from '../engine/message_manager.js';
import { PromptAssembler } from '../engine/prompt/index.js';
import { registerPrefixSuffixInjectors } from '../engine/prompt/index.js';

function mockConfig(values = {}) {
  return { get: (k) => values[k] };
}

describe('prefix/suffix 注入器（取代旧 elf-001 mm 子类）', () => {
  it('从 config 读 prefix_prompt / suffix_prompt 并注册', () => {
    const a = new PromptAssembler();
    registerPrefixSuffixInjectors(a, mockConfig({ prefix_prompt: '[前] ', suffix_prompt: ' [后]' }));
    assert.equal(a.list().length, 2);
  });

  it('prefix_prompt 拼到最后一条 user 消息前面', () => {
    const a = new PromptAssembler();
    registerPrefixSuffixInjectors(a, mockConfig({ prefix_prompt: '[重要] ' }));
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000 });
    mm.addUserMessage('你好');
    const messages = a.assemble(mm.getBaseForLLM(), { agent: { messageManager: mm }, messageManager: mm });
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '[重要] 你好');
  });

  it('suffix_prompt 拼到最后一条 user 消息后面', () => {
    const a = new PromptAssembler();
    registerPrefixSuffixInjectors(a, mockConfig({ suffix_prompt: ' [请简短回答]' }));
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000 });
    mm.addUserMessage('你好');
    const messages = a.assemble(mm.getBaseForLLM(), { agent: { messageManager: mm }, messageManager: mm });
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '你好 [请简短回答]');
  });

  it('prefix 和 suffix 同时生效', () => {
    const a = new PromptAssembler();
    registerPrefixSuffixInjectors(a, mockConfig({ prefix_prompt: '前置 ', suffix_prompt: ' 后置' }));
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000 });
    mm.addUserMessage('中间');
    const messages = a.assemble(mm.getBaseForLLM(), { agent: { messageManager: mm }, messageManager: mm });
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '前置 中间 后置');
  });

  it('只影响最后一条 user 消息', () => {
    const a = new PromptAssembler();
    registerPrefixSuffixInjectors(a, mockConfig({ prefix_prompt: '[前] ', suffix_prompt: ' [后]' }));
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000 });
    mm.addUserMessage('第一条');
    mm.addAssistantMessage('回复1');
    mm.addUserMessage('第二条');
    const messages = a.assemble(mm.getBaseForLLM(), { agent: { messageManager: mm }, messageManager: mm });
    const userMsgs = messages.filter(m => m.role === 'user');
    assert.equal(userMsgs[0].content, '第一条');
    assert.equal(userMsgs[1].content, '[前] 第二条 [后]');
  });

  it('空 prefix/suffix 不影响消息内容', () => {
    const a = new PromptAssembler();
    registerPrefixSuffixInjectors(a, mockConfig({ prefix_prompt: '', suffix_prompt: '' }));
    const mm = new MessageManager({ systemPrompt: 'You are helpful.', memoryTokenLimit: 8000 });
    mm.addUserMessage('你好');
    const messages = a.assemble(mm.getBaseForLLM(), { agent: { messageManager: mm }, messageManager: mm });
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '你好');
  });

  it('无 config 时不影响消息内容', () => {
    const a = new PromptAssembler();
    registerPrefixSuffixInjectors(a, null);
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000 });
    mm.addUserMessage('你好');
    const messages = a.assemble(mm.getBaseForLLM(), { agent: { messageManager: mm }, messageManager: mm });
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '你好');
  });

  it('context.json 存储裸内容（不含拼接）', () => {
    const a = new PromptAssembler();
    registerPrefixSuffixInjectors(a, mockConfig({ prefix_prompt: '[前] ', suffix_prompt: ' [后]' }));
    const mm = new MessageManager({ systemPrompt: 'test', memoryTokenLimit: 8000 });
    mm.addUserMessage('原始内容');
    // mm.messages 存裸内容（拼接只发生在 assemble 的请求副本上）
    assert.equal(mm.messages[0].content, '原始内容');
    const messages = a.assemble(mm.getBaseForLLM(), { agent: { messageManager: mm }, messageManager: mm });
    const userMsg = messages.find(m => m.role === 'user');
    assert.equal(userMsg.content, '[前] 原始内容 [后]');
  });
});