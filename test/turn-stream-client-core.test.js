/**
 * TurnStreamClient 纯计算核心单测（snapshot 重建 + sealed 续接）。
 * React 层（raf/store）不在单测范围；这里只测纯函数。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildFromSnapshot, applyToken, applyToolCall, applyToolResult } from '../frontend/src/lib/turn-stream-client-core.js';

const fixedId = (function () { let n = 0; return () => `b${n++}`; });

describe('turn-stream-client-core', () => {
  describe('rebuildFromSnapshot', () => {
    it('单源重建：snapshot → {turns, activeTurn, historyLoaded:true}', () => {
      const out = rebuildFromSnapshot({
        turns: [{ id: 't1' }],
        activeTurn: { id: 'active', userMessage: {}, assistantBubbles: [] },
        streaming: true,
        hasMore: true,
      });
      assert.equal(out.historyLoaded, true);
      assert.equal(out.turns.length, 1);
      assert.equal(out.activeTurn.id, 'active');
      assert.equal(out.streaming, true);
      assert.equal(out.hasMore, true);
    });
    it('bubble 无 id 时补 id（前端按 id 定位续接）', () => {
      const out = rebuildFromSnapshot({
        activeTurn: { assistantBubbles: [{ content: 'x' }, { content: 'y' }] },
      });
      assert.match(out.activeTurn.assistantBubbles[0].id, /^snap_bubble_\d+_0$/);
      assert.match(out.activeTurn.assistantBubbles[1].id, /^snap_bubble_\d+_1$/);
    });
    it('空 snapshot 兜底', () => {
      const out = rebuildFromSnapshot(null);
      assert.deepEqual(out.turns, []);
      assert.equal(out.activeTurn, null);
      assert.equal(out.historyLoaded, true);
    });
  });

  describe('applyToken sealed 续接', () => {
    it('尾 bubble 未 sealed → 续接到它', () => {
      const at = { assistantBubbles: [{ id: 'b0', content: '部', sealed: false }] };
      const out = applyToken(at, '分', { newBubbleId: fixedId() });
      assert.equal(out.assistantBubbles.length, 1, '续接不新建');
      assert.equal(out.assistantBubbles[0].content, '部分');
    });
    it('尾 bubble sealed → 新建 bubble', () => {
      const at = { assistantBubbles: [{ id: 'b0', content: '上一轮', sealed: true }] };
      const out = applyToken(at, '新轮', { newBubbleId: () => 'new1' });
      assert.equal(out.assistantBubbles.length, 2);
      assert.equal(out.assistantBubbles[1].id, 'new1');
      assert.equal(out.assistantBubbles[1].content, '新轮');
      assert.equal(out.assistantBubbles[1].sealed, false);
    });
    it('无 bubble → 新建', () => {
      const at = { assistantBubbles: [] };
      const out = applyToken(at, '首', { newBubbleId: () => 'first' });
      assert.equal(out.assistantBubbles.length, 1);
      assert.equal(out.assistantBubbles[0].content, '首');
    });
    it('清掉 typing 标记', () => {
      const at = { assistantBubbles: [{ id: 'b0', content: '部', typing: true }] };
      const out = applyToken(at, '分', { newBubbleId: fixedId() });
      assert.equal(out.assistantBubbles[0].typing, undefined);
    });
  });

  describe('applyToolCall', () => {
    it('加工具到尾 bubble，status=executing', () => {
      const at = { assistantBubbles: [{ id: 'b0', content: '', toolCalls: [] }] };
      const out = applyToolCall(at, [{ id: 't1', name: 'Read', args: {} }], { newBubbleId: fixedId() });
      assert.equal(out.assistantBubbles[0].toolCalls.length, 1);
      assert.equal(out.assistantBubbles[0].toolCalls[0].status, 'executing');
    });
    it('尾 sealed → 新建 bubble 再加', () => {
      const at = { assistantBubbles: [{ id: 'b0', content: '上轮', toolCalls: [], sealed: true }] };
      const out = applyToolCall(at, [{ id: 't1', name: 'Bash', args: {} }], { newBubbleId: () => 'nb' });
      assert.equal(out.assistantBubbles.length, 2);
      assert.equal(out.assistantBubbles[1].toolCalls[0].id, 't1');
    });
  });

  describe('applyToolResult', () => {
    it('按 id 更新 tool status + message', () => {
      const at = { assistantBubbles: [{ id: 'b0', toolCalls: [
        { id: 't1', status: 'executing' }, { id: 't2', status: 'executing' },
      ] }] };
      const out = applyToolResult(at, { id: 't1', status: 'success', message: 'ok' });
      const tcs = out.assistantBubbles[0].toolCalls;
      assert.equal(tcs[0].status, 'success');
      assert.equal(tcs[0].message, 'ok');
      assert.equal(tcs[1].status, 'executing', '其它工具不动');
      assert.notEqual(out.assistantBubbles[0].sealed, true, '还有 executing 不 sealed');
    });
    it('全部完成 → 标 sealed', () => {
      const at = { assistantBubbles: [{ id: 'b0', toolCalls: [{ id: 't1', status: 'success' }] }] };
      // 单个 tool 已 success，再发个无 id 的不会改；用一个全完成场景
      const at2 = { assistantBubbles: [{ id: 'b0', toolCalls: [{ id: 't1', status: 'executing' }] }] };
      const out = applyToolResult(at2, { id: 't1', status: 'success' });
      assert.equal(out.assistantBubbles[0].sealed, true, '全完成应 sealed');
    });
    it('无匹配 id → 原样返回', () => {
      const at = { assistantBubbles: [{ id: 'b0', toolCalls: [{ id: 't1', status: 'executing' }] }] };
      const out = applyToolResult(at, { id: 'nope', status: 'success' });
      assert.equal(out, at, '无匹配返回原对象');
    });
  });
});
