/**
 * TurnStream 契约纯函数单测（前后端共享形状定义）
 * 换项目/封装都应保持这些断言为真——它们是跨端 sealed 约定的代码锚。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sealedBubble, openBubble, shouldStartNewBubble, makeSnapshot } from '../shared/turn-stream-contract.js';

describe('turn-stream-contract', () => {
  describe('sealedBubble', () => {
    it('标 sealed=true 并保留原字段', () => {
      const b = sealedBubble({ content: 'x', toolCalls: [{ id: 't1' }], compactId: 'c1' });
      assert.equal(b.sealed, true);
      assert.equal(b.content, 'x');
      assert.equal(b.compactId, 'c1');
      assert.equal(b.toolCalls.length, 1);
    });
    it('不修改原对象（返回副本）', () => {
      const orig = { content: 'x' };
      const b = sealedBubble(orig);
      assert.equal(orig.sealed, undefined, '原对象不被加 sealed');
      assert.equal(b.sealed, true);
    });
    it('空入参兜底', () => {
      const b = sealedBubble(null);
      assert.equal(b.sealed, true);
    });
  });

  describe('openBubble', () => {
    it('产未 sealed 的尾 bubble', () => {
      const b = openBubble('部分', [{ id: 't1', status: 'executing' }]);
      assert.equal(b.sealed, false);
      assert.equal(b.content, '部分');
      assert.equal(b.toolCalls.length, 1);
    });
    it('默认空 content + 空 toolCalls + sealed=false', () => {
      const b = openBubble();
      assert.equal(b.content, '');
      assert.deepEqual(b.toolCalls, []);
      assert.equal(b.sealed, false);
    });
  });

  describe('shouldStartNewBubble', () => {
    it('无 bubble（null）→ true（新建）', () => {
      assert.equal(shouldStartNewBubble(null), true);
      assert.equal(shouldStartNewBubble(undefined), true);
    });
    it('sealed=true → true（新建下一块）', () => {
      assert.equal(shouldStartNewBubble({ sealed: true, content: 'a' }), true);
    });
    it('sealed=false / 无 sealed → false（续接当前）', () => {
      assert.equal(shouldStartNewBubble({ sealed: false, content: '部分' }), false);
      assert.equal(shouldStartNewBubble({ content: '部分' }), false); // 历史落盘尾不带 sealed 时也可续接
    });
  });

  describe('makeSnapshot', () => {
    it('结构 + 默认值', () => {
      const snap = makeSnapshot();
      assert.deepEqual(snap.turns, []);
      assert.equal(snap.activeTurn, null);
      assert.equal(snap.streaming, false);
      assert.equal(snap.hasMore, false);
    });
    it('保留传入值，streaming/hasMore 强制布尔', () => {
      const turns = [{ id: 't1', userMessage: {}, assistantBubbles: [] }];
      const active = { id: 'active', userMessage: {}, assistantBubbles: [] };
      const snap = makeSnapshot({ turns, activeTurn: active, streaming: 1, hasMore: 0 });
      assert.equal(snap.turns, turns);
      assert.equal(snap.activeTurn, active);
      assert.equal(snap.streaming, true);
      assert.equal(snap.hasMore, false);
    });
  });
});
