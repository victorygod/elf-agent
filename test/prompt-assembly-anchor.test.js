/**
 * Prompt 拼装行为锚定（PromptAssembler 注入器：取代旧 mm 子类 + plugin mutate）。
 *
 * 锚定：① 群聊模式 roster 前拼最近 user / 群聊时关 prefix-suffix
 *       ② prefix/suffix 拼最近 user（私聊）③ 无注入时 system 保持基线。
 *
 * 注：群聊行为提示已整合到 roster 的 <system_reminder> 中（RoomPlugin._formatRoster），
 *    不再单独 useSystemAppend 追加到 system 段，故不再有"群聊行为追加 system 尾"用例。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageManager } from '../engine/message_manager.js';
import { PromptAssembler } from '../engine/prompt/index.js';
import { registerPrefixSuffixInjectors } from '../engine/prompt/index.js';

const mockConfig = (values = {}) => ({ get: (k) => values[k] });

describe('prompt 拼装行为锚定（PromptAssembler 注入器）', () => {
  // ① 群聊模式：roster 前拼最近 user（且不拼 prefix/suffix）
  it('群聊模式 roster 前拼最近 user，且不拼 prefix/suffix', () => {
    const a = new PromptAssembler();
    registerPrefixSuffixInjectors(a, mockConfig({ prefix_prompt: '[私聊前缀]' })); // 私聊注入器
    a.useWrapLastUser(() => ({ prefix: '<system-reminder>roster</system-reminder>\n' }), { order: 50, name: 'roster' });
    const mm = new MessageManager({ systemPrompt: '你是 elf-001', memoryTokenLimit: 8000 });
    mm.addUserMessage('@elf-002 你好');
    // 模拟群聊 ctx
    const out = a.assemble(mm.getBaseForLLM(), { agent: { runContext: { mode: 'room' } }, messageManager: mm });
    const userMsg = out.find(m => m.role === 'user');
    assert.ok(userMsg.content.startsWith('<system-reminder>'), 'roster 应前拼到最近 user');
    assert.ok(userMsg.content.includes('@elf-002 你好'));
    assert.ok(!userMsg.content.includes('[私聊前缀]'), '群聊模式不应拼私聊 prefix');
  });

  // ③ 私聊模式：prefix/suffix 拼最近 user（无 roster）
  it('私聊模式 prefix/suffix 拼最近 user', () => {
    const a = new PromptAssembler();
    registerPrefixSuffixInjectors(a, mockConfig({ prefix_prompt: '[私聊前]', suffix_prompt: '[私聊后]' }));
    const mm = new MessageManager({ systemPrompt: '你是 elf-001', memoryTokenLimit: 8000 });
    mm.addUserMessage('你好');
    const out = a.assemble(mm.getBaseForLLM(), { agent: { runContext: { mode: 'private' } }, messageManager: mm });
    const userMsg = out.find(m => m.role === 'user');
    assert.equal(userMsg.content, '[私聊前]你好[私聊后]');
  });

  // ④ 无注入时 system 保持基线
  it('无注入器时 system 段保持基线 systemPrompt', () => {
    const a = new PromptAssembler();
    const mm = new MessageManager({ systemPrompt: '基线', memoryTokenLimit: 8000 });
    const out = a.assemble(mm.getBaseForLLM(), { messageManager: mm });
    assert.equal(out[0].content, '基线');
  });
});