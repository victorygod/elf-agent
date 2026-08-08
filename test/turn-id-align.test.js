/**
 * alignOptimisticTurn 单测（验修：本地乐观 turn.id 与后端 snapshot 不同源 → 聚合 SSE 重连翻倍）。
 *
 * 现象：私聊「整套消息记录出现两遍、刷新才好」。
 * 根因：useChat.send 用随机 turn.id/userMessage.id 乐观建回合；后端 snapshot 的 turn.id
 *   = `turn_${后端真实msg.id}`（messagesToTurns）。聚合 SSE 重连时前端 snapshot-merge 按 turn.id
 *   去重，id 不同源的本地版被误判为「更旧的上翻历史」整批保留 → 与 snapshot 那份并存翻倍。
 *   修：/say 返回真实 id 后对齐本地乐观 turn 的 id；真实版已存在则移除本地版（顺带自愈已翻倍）。
 *
 * 同构 sse-dispatcher-abort.test.js：垫片 localStorage/rAF + 动态 import 拉起前端 store。
 */
import { describe, it } from 'node:test';
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

function setChat(chat) {
  useAgentStore.setState({ chats: new Map([[chatKey(AGENT), chat]]) });
}
function chat() {
  return useAgentStore.getState().chats.get(chatKey(AGENT));
}
function fresh(extra = {}) {
  return { streaming: false, activeTurn: null, turns: [], historyLoaded: true, hasMore: false, noticeQueue: [], ...extra };
}
function turn(id, uid) {
  return { id, userMessage: { id: uid, role: 'user', content: 'hi' }, assistantBubbles: [{ id: 'b', role: 'assistant', content: 'ans', sealed: true }] };
}
function snapOf(id, uid) {
  return { turns: [turn(id, uid)], activeTurn: null, streaming: false, hasMore: false };
}

describe('alignOptimisticTurn（修：聚合 SSE 重连翻倍）', () => {
  it('常态：activeTurn 本地乐观 id → 改名为后端真实 id', () => {
    setChat(fresh({
      activeTurn: { id: 'turn_local_1', userMessage: { id: 'local_1', role: 'user', content: 'hi' }, assistantBubbles: [] },
    }));
    useAgentStore.getState().alignOptimisticTurn(AGENT, 'local_1', 'real_9');
    const at = chat().activeTurn;
    assert.equal(at.id, 'turn_real_9');
    assert.equal(at.userMessage.id, 'real_9');
  });

  it('常态：已 finalize 进 turns 的本地乐观 turn → 改名', () => {
    setChat(fresh({ turns: [turn('turn_local_2', 'local_2')] }));
    useAgentStore.getState().alignOptimisticTurn(AGENT, 'local_2', 'real_9');
    assert.equal(chat().turns.length, 1);
    assert.equal(chat().turns[0].id, 'turn_real_9');
    assert.equal(chat().turns[0].userMessage.id, 'real_9');
  });

  it('自愈：turns 已含真实版（先前重连翻倍）+ 本地乐观版 → 移除本地版，只剩一份', () => {
    setChat(fresh({ turns: [turn('turn_local_1', 'local_1'), turn('turn_real_9', 'real_9')] }));
    useAgentStore.getState().alignOptimisticTurn(AGENT, 'local_1', 'real_9');
    const t = chat().turns;
    assert.equal(t.length, 1, '本地版被移除，只剩真实版（翻倍修复）');
    assert.equal(t[0].id, 'turn_real_9');
  });

  it('自愈：本地乐观版还在 activeTurn、真实版已入 turns → 清掉本地 activeTurn', () => {
    setChat(fresh({
      activeTurn: { id: 'turn_local_1', userMessage: { id: 'local_1', role: 'user', content: 'hi' }, assistantBubbles: [] },
      turns: [turn('turn_real_9', 'real_9')],
    }));
    useAgentStore.getState().alignOptimisticTurn(AGENT, 'local_1', 'real_9');
    assert.equal(chat().activeTurn, null, '重复的本地 activeTurn 已清');
    assert.equal(chat().turns.length, 1);
  });

  it('端到端：对齐后聚合 SSE 重连 snapshot-merge 不翻倍', () => {
    // 模拟 send → 对齐 → finalize 后的 turns（已是真实 id 版）
    setChat(fresh({ turns: [turn('turn_real_9', 'real_9')] }));
    handleSSEEvent(AGENT, 'snapshot', snapOf('turn_real_9', 'real_9'));
    const t = chat().turns;
    assert.equal(t.length, 1, '去重命中，不翻倍');
    assert.equal(t[0].id, 'turn_real_9');
  });

  it('对照（复现 bug）：未对齐的本地乐观 turn + 重连 snapshot → 翻倍', () => {
    setChat(fresh({ turns: [turn('turn_local_1', 'local_1')] }));
    handleSSEEvent(AGENT, 'snapshot', snapOf('turn_real_9', 'real_9'));
    const t = chat().turns;
    assert.equal(t.length, 2, '未对齐 → 本地版被误留为 olderTurns，翻倍（此即原 bug）');
    assert.deepEqual(t.map((x) => x.id), ['turn_local_1', 'turn_real_9']);
  });

  it('幂等：localUserMsgId 不存在 / 重复对齐时无副作用', () => {
    const before = turn('turn_real_9', 'real_9');
    setChat(fresh({ activeTurn: { ...before, assistantBubbles: [] } }));
    useAgentStore.getState().alignOptimisticTurn(AGENT, 'local_1', 'real_9'); // local_1 不存在
    assert.equal(chat().activeTurn.id, 'turn_real_9');
    useAgentStore.getState().alignOptimisticTurn(AGENT, 'real_9', 'real_9'); // 已是真实版，无 fatal
    assert.equal(chat().activeTurn.id, 'turn_real_9');
  });

  it('空值守护：realId / localUserMsgId 缺省时不改 store', () => {
    setChat(fresh({ activeTurn: { id: 'turn_local_1', userMessage: { id: 'local_1' }, assistantBubbles: [] } }));
    useAgentStore.getState().alignOptimisticTurn(AGENT, 'local_1', null);
    useAgentStore.getState().alignOptimisticTurn(AGENT, null, 'real_9');
    assert.equal(chat().activeTurn.id, 'turn_local_1', '缺参不动');
  });
});
