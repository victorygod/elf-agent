/**
 * PromptAssembler 纯函数单测（三点位临时拼装）。
 * 封装前后都应保持这些断言为真——它们是注入器行为的代码锚。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PromptAssembler } from '../engine/prompt/index.js';

const base = (systemPrompt, msgs = []) => [{ role: 'system', content: systemPrompt }, ...msgs];
const ctx = {};

describe('PromptAssembler', () => {
  describe('点位① 系统提示词', () => {
    it('useSystemAppend 追加到 system 尾', () => {
      const a = new PromptAssembler();
      a.useSystemAppend(() => ' [行为提示]');
      const out = a.assemble(base('你是 elf-001'), ctx);
      assert.equal(out[0].content, '你是 elf-001 [行为提示]');
    });
    it('多个 append 按 order 叠加', () => {
      const a = new PromptAssembler();
      a.useSystemAppend(() => ' A', { order: 1 });
      a.useSystemAppend(() => ' B', { order: 2 });
      const out = a.assemble(base('sys'), ctx);
      assert.equal(out[0].content, 'sys A B');
    });
    it('useSystemReplace 整体替换', () => {
      const a = new PromptAssembler();
      a.useSystemReplace(() => '新 system');
      const out = a.assemble(base('旧 system'), ctx);
      assert.equal(out[0].content, '新 system');
    });
    it('replace 和 append 共存：先 replace 再 append 叠到新 system 上', () => {
      const a = new PromptAssembler();
      a.useSystemReplace(() => '新 system');
      a.useSystemAppend(() => ' [附加]');
      const out = a.assemble(base('旧 system'), ctx);
      assert.equal(out[0].content, '新 system [附加]');
    });
    it('provider 返回 null/空 → 跳过', () => {
      const a = new PromptAssembler();
      a.useSystemAppend(() => null);
      a.useSystemAppend(() => '');
      const out = a.assemble(base('sys'), ctx);
      assert.equal(out[0].content, 'sys');
    });
  });

  describe('点位② 最近 user 及其前后', () => {
    const baseWithUser = () => base('sys', [{ role: 'user', content: '你好' }]);

    it('useBeforeLastUser 在最近 user 前插独立消息', () => {
      const a = new PromptAssembler();
      a.useBeforeLastUser(() => 'skill listing');
      const out = a.assemble(baseWithUser(), ctx);
      const userIdx = out.findIndex(m => m.role === 'user' && m.content === '你好');
      assert.equal(out[userIdx - 1].content, 'skill listing');
    });
    it('useAfterLastUser 在最近 user 后插独立消息', () => {
      const a = new PromptAssembler();
      a.useAfterLastUser(() => '后置提示');
      const out = a.assemble(baseWithUser(), ctx);
      const userIdx = out.findIndex(m => m.content === '你好');
      assert.equal(out[userIdx + 1].content, '后置提示');
    });
    it('useWrapLastUser 前后缀修改最近 user content', () => {
      const a = new PromptAssembler();
      a.useWrapLastUser(() => ({ prefix: '[前] ', suffix: ' [后]' }));
      const out = a.assemble(baseWithUser(), ctx);
      const u = out.find(m => m.content.includes('你好'));
      assert.equal(u.content, '[前] 你好 [后]');
    });
    it('多个 wrap 按 order 叠加前后缀', () => {
      const a = new PromptAssembler();
      a.useWrapLastUser(() => ({ prefix: 'A' }), { order: 1 });
      a.useWrapLastUser(() => ({ suffix: 'B' }), { order: 2 });
      const out = a.assemble(baseWithUser(), ctx);
      assert.equal(out.find(m => m.content.includes('你好')).content, 'A你好B');
    });
    it('只影响最近一条 user（多 user 时）', () => {
      const a = new PromptAssembler();
      a.useWrapLastUser(() => ({ prefix: '[前] ' }));
      const out = a.assemble(base('sys', [
        { role: 'user', content: '第一条' },
        { role: 'assistant', content: '回复' },
        { role: 'user', content: '第二条' },
      ]), ctx);
      const users = out.filter(m => m.role === 'user');
      assert.equal(users[0].content, '第一条');
      assert.equal(users[1].content, '[前] 第二条');
    });
    it('无 user 时 beforeLastUser 改末尾追加', () => {
      const a = new PromptAssembler();
      a.useBeforeLastUser(() => 'listing');
      const out = a.assemble(base('sys'), ctx);
      assert.equal(out[out.length - 1].content, 'listing');
    });
  });

  describe('点位③ 末尾追加', () => {
    it('useAppend 末尾追加一条', () => {
      const a = new PromptAssembler();
      a.useAppend(() => '尾部');
      const out = a.assemble(base('sys', [{ role: 'user', content: 'u' }]), ctx);
      assert.equal(out[out.length - 1].content, '尾部');
    });
  });

  describe('组合 + 纯函数', () => {
    it('不修改 base（纯函数）', () => {
      const a = new PromptAssembler();
      a.useSystemAppend(() => ' X');
      a.useWrapLastUser(() => ({ prefix: 'P' }));
      const b = base('sys', [{ role: 'user', content: 'u' }]);
      const bClone = JSON.parse(JSON.stringify(b));
      a.assemble(b, ctx);
      assert.deepEqual(b, bClone, 'base 不应被修改');
    });
    it('组合：system append + before user + wrap user + append', () => {
      const a = new PromptAssembler();
      a.useSystemAppend(() => ' [群聊]');
      a.useBeforeLastUser(() => 'roster');
      a.useWrapLastUser(() => ({ prefix: '[前]' }));
      a.useAppend(() => 'tail');
      const out = a.assemble(base('sys', [{ role: 'user', content: '你好' }]), ctx);
      assert.equal(out[0].content, 'sys [群聊]');
      const userIdx = out.findIndex(m => m.content === '[前]你好');
      assert.ok(userIdx > 0);
      assert.equal(out[userIdx - 1].content, 'roster', 'roster 在 user 前');
      assert.equal(out[out.length - 1].content, 'tail', 'tail 在末尾');
    });
  });
});