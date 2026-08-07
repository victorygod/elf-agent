/**
 * sseDispatcher abort 行为单测（验改 1：aborted → finalizeActiveTurn 保留 partial）。
 *
 * 仓库无前端单测 runner，sseDispatcher 是纯 store 分发（脱离 React），可在 Node 里拉起来直测。
 * 垫片：authStore 模块加载即读 localStorage、token 路径用 rAF —— 用动态 import 把垫片排在
 *   平台/store 加载之前（ESM 静态 import 会被提升，故用 top-level await import）。
 *
 * 对照旧逻辑（aborted → activeTurn:null 丢弃 partial）：本断言要求 partial 落进 turns，旧逻辑下 turns 为空会失败。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// 垫片必须在 import 平台/store 之前生效
globalThis.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {},
};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const [{ default: useAgentStore }, { handleSSEEvent }, { chatKey }] = await Promise.all([
  import('../frontend/src/stores/agentStore.js'),
  import('../frontend/src/stores/sseDispatcher.js'),
  import('../frontend/src/stores/authStore.js'),
]);

const AGENT = 'elf-002';

function seedActiveTurn() {
  // 构造一个"正在流式、已累积 partial 文本气泡"的 activeTurn
  const activeTurn = {
    id: 'turn_u1',
    userMessage: { id: 'u1', role: 'user', content: '你好' },
    assistantBubbles: [
      { id: 'b1', role: 'assistant', content: '生成的半成品正文', sealed: false, ts: '2026-08-07T00:00:00.000Z' },
    ],
  };
  useAgentStore.setState({
    chats: new Map([
      [chatKey(AGENT), {
        streaming: true, activeTurn, turns: [], historyLoaded: true, hasMore: false, noticeQueue: [],
      }],
    ]),
  });
}

function chat() {
  return useAgentStore.getState().chats.get(chatKey(AGENT));
}

describe('sseDispatcher aborted 保留 partial（改 1）', () => {
  it('aborted → finalizeActiveTurn：partial seal 进 turns，activeTurn 清空', () => {
    seedActiveTurn();
    const before = chat();
    assert.ok(before.activeTurn, 'seed: 有 activeTurn');
    assert.equal(before.turns.length, 0, 'seed: turns 空');

    handleSSEEvent(AGENT, 'aborted', {});

    const after = chat();
    assert.equal(after.activeTurn, null, 'activeTurn 已清');
    assert.equal(after.turns.length, 1, 'partial 收成 1 个 turn（旧丢弃逻辑下此处为 0）');
    const bub = after.turns[0].assistantBubbles[0];
    assert.equal(bub.content, '生成的半成品正文', 'partial 文本保留可见');
    assert.equal(bub.sealed, true, '气泡已 seal');
  });

  it('aborted 无 activeTurn（空 abort）→ no-op，不抛、turns 不变', () => {
    useAgentStore.setState({
      chats: new Map([
        [chatKey(AGENT), { streaming: true, activeTurn: null, turns: [], historyLoaded: true, hasMore: false, noticeQueue: [] }],
      ]),
    });
    assert.doesNotThrow(() => handleSSEEvent(AGENT, 'aborted', {}));
    const after = chat();
    assert.equal(after.activeTurn, null, '仍无 activeTurn');
    assert.equal(after.turns.length, 0, 'turns 不变');
  });
});
