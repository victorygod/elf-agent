/**
 * TurnStreamClient 纯计算核心 —— 可被 node:test 测的部分（不碰 React / IO / raf）
 *
 * 从 sseDispatcher 的 snapshot/token/tool_call/tool_result 续接逻辑抽出纯函数。
 * React 层（sseDispatcher / TurnStreamClient）负责 raf 批处理调度 + store 写入，
 * 本模块只做"给定当前 activeTurn + 事件 → 产新 activeTurn"的纯计算。
 *
 * sealed 续接约定由 ../shared/turn-stream-contract.shouldStartNewBubble 定义。
 */

import { shouldStartNewBubble } from '../../../shared/turn-stream-contract.js';

/**
 * 用 snapshot 重建 activeTurn（单源：snapshot 是唯一加载源，不另走 REST）。
 * @param {object} snapshot { turns, activeTurn, streaming, hasMore }
 * @returns {{ turns, activeTurn, streaming, hasMore, historyLoaded }} 给 patchChat 的更新
 */
export function rebuildFromSnapshot(snapshot) {
  const { turns, activeTurn, streaming, hasMore } = snapshot || {};
  // 保证 activeTurn.assistantBubbles 内每个 bubble 有 id（前端按 id 渲染/续接定位）
  //   次补 id 命名与旧 sseDispatcher.snapshot 一致：snap_bubble_<ts>_<i>
  const ts = Date.now();
  const patched = activeTurn
    ? {
        ...activeTurn,
        assistantBubbles: (activeTurn.assistantBubbles || []).map((b, i) => ({
          ...b,
          id: b.id || `snap_bubble_${ts}_${i}`,
        })),
      }
    : null;
  return {
    turns: turns || [],
    activeTurn: patched,
    streaming: !!streaming,
    hasMore: hasMore !== undefined ? hasMore : false,
    historyLoaded: true,
  };
}

/**
 * token 增量：追加 content 到尾 bubble（未 sealed→续接，sealed/无→新建）。
 * 纯计算，不碰 raf。pendingContent 由 React 层累积后一次性调本函数应用。
 * @param {object} activeTurn 当前 activeTurn（可 null）
 * @param {string} delta 待追加文本
 * @param {object} [opts] { newBubbleId, _loop }
 * @returns {object} 新 activeTurn（含更新 bubble）；null 入参返回 null（调用方应已有 activeTurn）
 */
export function applyToken(activeTurn, delta, opts = {}) {
  if (!activeTurn || !delta) return activeTurn;
  const newBubbleId = opts.newBubbleId || (() => `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const bubbles = activeTurn.assistantBubbles || [];
  const last = bubbles[bubbles.length - 1];
  if (shouldStartNewBubble(last)) {
    const nb = { id: newBubbleId(), content: delta, toolCalls: [], ts: new Date().toISOString(), sealed: false };
    // 盖戳 _loop：纯文本 bubble 也带 loop，避免后续 loop 切换（chat._currentLoop 被新 loop 的
    //   status 轮换）后回退 currentLoop 误判——reviewer 文本被盖成 render 即此因。
    if (opts._loop) nb._loop = opts._loop;
    return { ...activeTurn, assistantBubbles: [...bubbles, nb] };
  }
  // 续接：清掉 typing 标记，追加到尾 bubble
  const cleaned = last.typing ? { ...last, typing: undefined } : last;
  const updated = { ...cleaned, content: (cleaned.content || '') + delta };
  // 续接情形同样盖戳 _loop（尾 bubble 尚未带 loop 时），与 applyToolCall 续接盖戳口径一致。
  //   已有 _loop 不覆盖：续接可能是跨多帧的同一 bubble，保留首帧的 loop。
  if (opts._loop && !updated._loop) updated._loop = opts._loop;
  const newBubbles = bubbles.map((b, i) => (i === bubbles.length - 1 ? updated : b));
  return { ...activeTurn, assistantBubbles: newBubbles };
}

/**
 * tool_call 增量：加工具调用到尾 bubble（未 sealed→加，sealed/无→新建 bubble 再加）。
 * @param {object} activeTurn
 * @param {Array} toolCalls 新工具调用数组
 * @param {object} [opts] { newBubbleId }
 * @returns {object} 新 activeTurn
 */
export function applyToolCall(activeTurn, toolCalls, opts = {}) {
  if (!activeTurn) return activeTurn;
  const newBubbleId = opts.newBubbleId || (() => `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  const tcs = (toolCalls || []).map(tc => ({ ...tc, status: 'executing' }));
  if (tcs.length === 0) return activeTurn;
  let bubbles = activeTurn.assistantBubbles || [];
  let last = bubbles[bubbles.length - 1];
  if (shouldStartNewBubble(last)) {
    last = { id: newBubbleId(), content: '', toolCalls: [], ts: new Date().toISOString(), sealed: false };
    bubbles = [...bubbles, last];
  }
  const cleaned = last.typing ? { ...last, typing: undefined } : last;
  // 盖戳 _loop：toolCalls 气泡是折叠判定的对象，带上当前 loop 后，
  //   turn finalize（currentLoop 清空）与刷新重建都能凭 bubble._loop 继续折叠非 render 内容。
  const updated = { ...cleaned, toolCalls: [...(cleaned.toolCalls || []), ...tcs] };
  if (opts._loop) updated._loop = opts._loop;
  const newBubbles = bubbles.map((b, i) => (i === bubbles.length - 1 ? updated : b));
  return { ...activeTurn, assistantBubbles: newBubbles };
}

/**
 * tool_result 增量：按 id 更新尾 bubble 内某 tool 的 status/message；全完成→sealed。
 * @param {object} activeTurn
 * @param {{id?,status,message?}} data
 * @returns {object} 新 activeTurn（无匹配则原样返回 activeTurn）
 */
export function applyToolResult(activeTurn, data = {}) {
  if (!activeTurn) return activeTurn;
  const bubbles = activeTurn.assistantBubbles || [];
  const last = bubbles[bubbles.length - 1];
  if (!last || !last.toolCalls) return activeTurn;
  const idx = data.id != null
    ? last.toolCalls.findIndex(tc => tc.id === data.id)
    : last.toolCalls.findIndex(tc => tc.status === 'executing');
  if (idx < 0) return activeTurn;
  const newToolCalls = last.toolCalls.map((tc, i) => {
    if (i === idx) {
      const u = { ...tc, status: data.status };
      if (data.message) u.message = data.message;
      if (data.result != null) u.result = data.result;
      return u;
    }
    return { ...tc };
  });
  const allDone = !newToolCalls.some(tc => tc.status === 'executing');
  const updated = { ...last, toolCalls: newToolCalls, sealed: allDone && newToolCalls.length > 0 ? true : last.sealed };
  const newBubbles = bubbles.map((b, i) => (i === bubbles.length - 1 ? updated : b));
  return { ...activeTurn, assistantBubbles: newBubbles };
}
