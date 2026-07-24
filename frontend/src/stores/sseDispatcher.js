/**
 * sseDispatcher — SSE 事件 → agentStore 的纯分发逻辑（脱离 React 组件）
 *
 * 供 app 级常驻订阅（useAgentSubscriptions）和发消息流（api.chat 的 onEvent）共用。
 * 所有 store 读写经 useAgentStore.getState/setState，按 agentId 分发。token 事件用
 * rAF batching 合并高频写，raf 状态存模块级 Map（agent 级隔离），不依赖任何 ref/组件实例。
 *
 * 来源：原 useChat._handleSSEEvent + 顶部三个纯函数（_findBubbleByCompactId/_applyCompactResult/_formatCompactError）。
 */

import * as api from '../api/index.js';
import useAgentStore from './agentStore.js';

// ===== 压缩气泡 compactId 锚定辅助（纯函数，跨 turn 定位气泡）=====

function _findBubbleByCompactId(state, agentId, compactId) {
  if (!compactId) return null;
  const chat = state.chats.get(agentId);
  if (!chat) { api.log('INFO', `[compact-bubble] find: no chat for ${agentId}`); return null; }
  if (chat.activeTurn) {
    const ids = chat.activeTurn.assistantBubbles.map(b => b.id);
    const idx = chat.activeTurn.assistantBubbles.findIndex(b => b.id === compactId);
    api.log('INFO', `[compact-bubble] find activeTurn: ${compactId} ids=[${ids.join(',')}] found=${idx}`);
    if (idx !== -1) return { turn: chat.activeTurn, bubbleIdx: idx, inActive: true };
  }
  for (let i = chat.turns.length - 1; i >= 0; i--) {
    const ids = chat.turns[i].assistantBubbles.map(b => b.id);
    const idx = chat.turns[i].assistantBubbles.findIndex(b => b.id === compactId);
    api.log('INFO', `[compact-bubble] find turns[${i}]: ${compactId} ids=[${ids.join(',')}] found=${idx}`);
    if (idx !== -1) return { turn: chat.turns[i], bubbleIdx: idx, inActive: false };
  }
  api.log('WARN', `[compact-bubble] find NOT FOUND: ${compactId}`);
  return null;
}

function _applyCompactResult(agentId, compactId, patch, fallbackPatch) {
  const chats = new Map(useAgentStore.getState().chats);
  const chat = chats.get(agentId);
  if (!chat) { api.log('INFO', `[compact-bubble] _applyCompactResult: no chat for ${agentId}`); return; }

  api.log('INFO', `[compact-bubble] _applyCompactResult: agent=${agentId} compactId=${compactId} patch=${JSON.stringify(patch)} activeTurn=${!!chat.activeTurn} turns=${chat.turns.length}`);
  const found = _findBubbleByCompactId(useAgentStore.getState(), agentId, compactId);
  api.log('INFO', `[compact-bubble] _applyCompactResult result: ${found ? 'FOUND idx=' + found.bubbleIdx + ' inActive=' + found.inActive : 'NOT FOUND → fallback'}`);
  if (found) {
    const updated = {
      ...found.turn.assistantBubbles[found.bubbleIdx],
      ...patch,
      compactLoading: undefined,
      sealed: true,
    };
    const updatedBubbles = found.turn.assistantBubbles.map((b, i) => i === found.bubbleIdx ? updated : b);
    const updatedTurn = { ...found.turn, assistantBubbles: updatedBubbles };
    if (found.inActive) {
      chats.set(agentId, { ...chat, activeTurn: updatedTurn });
    } else {
      const turns = [...chat.turns];
      const turnIdx = chat.turns.indexOf(found.turn);
      turns[turnIdx] = updatedTurn;
      chats.set(agentId, { ...chat, turns });
    }
    useAgentStore.setState({ chats });
    return;
  }

  // fallback：无 compactId 或找不到 → 最后一个 bubble（blocking 单 turn 兜底）
  if (!chat.activeTurn) return;
  const at = chat.activeTurn;
  const last = at.assistantBubbles[at.assistantBubbles.length - 1];
  if (!last) return;
  const updated = { ...last, ...fallbackPatch, compactLoading: undefined, sealed: true };
  const newBubbles = at.assistantBubbles.map((b, i) => i === at.assistantBubbles.length - 1 ? updated : b);
  chats.set(agentId, { ...chat, activeTurn: { ...at, assistantBubbles: newBubbles } });
  useAgentStore.setState({ chats });
}

function _formatCompactError(data) {
  const attempt = data.attempt || 1;
  const attemptPart = attempt > 1 ? `（第 ${attempt} 次重试）` : '';
  if (data.final) return `记忆压缩已禁用${attemptPart}`;
  return `记忆压缩失败${attemptPart}`;
}

// ===== rAF batching（模块级，agent 级隔离）=====
// token 高频，累积 pendingContent，每帧 flush 一次写 store。
const _rafState = new Map(); // agentId → { rafId, pendingContent, pendingUpdate }

function _patchChat(agentId, updates) {
  useAgentStore.getState()._patchChat(agentId, updates);
}

function _flushRaf(agentId) {
  const st = _rafState.get(agentId);
  if (!st) return;
  if (st.rafId) {
    cancelAnimationFrame(st.rafId);
    st.rafId = null;
  }
  const update = st.pendingUpdate;
  const at = update?.activeTurn;
  if (!at) {
    st.pendingContent = '';
    st.pendingUpdate = null;
    return;
  }
  const newBubbles = at.assistantBubbles.map((b, i) => {
    if (i === at.assistantBubbles.length - 1 && st.pendingContent) {
      return { ...b, content: b.content + st.pendingContent };
    }
    return { ...b };
  });
  _patchChat(agentId, { activeTurn: { ...at, assistantBubbles: newBubbles } });
  st.pendingContent = '';
  st.pendingUpdate = null;
}

/** activeTurn 收入 turns（done/aborted/error/发消息失败时调） */
export function finalizeActiveTurn(agentId) {
  _flushRaf(agentId);
  const chat = useAgentStore.getState().chats.get(agentId);
  if (!chat || !chat.activeTurn) return;
  const at = chat.activeTurn;
  const sealedBubbles = at.assistantBubbles.map(b => b.sealed ? b : { ...b, sealed: true });
  _patchChat(agentId, {
    turns: [...chat.turns, { ...at, assistantBubbles: sealedBubbles }],
    activeTurn: null,
  });
}

/**
 * SSE 事件分发：按事件名更新 agentStore 里该 agent 的 chat。
 * 纯 store 操作，可从任意上下文调（app 级常驻订阅 / api.chat 流）。
 */
export function handleSSEEvent(agentId, event, data) {
  const getState = useAgentStore.getState;
  const chat = getState().chats.get(agentId);

  switch (event) {
    case 'snapshot': {
      const { turns, activeTurn } = data;

      const snapCompactBubbles = [];
      for (const t of (turns || [])) {
        for (const b of (t.assistantBubbles || [])) {
          if (b.compactId || b.compactLoading || b.compactSummary || b.compactError) {
            snapCompactBubbles.push(`turn@${t.id} id=${b.id} loading=${b.compactLoading} summary=${b.compactSummary} error=${b.compactError}`);
          }
        }
      }
      for (const b of (activeTurn?.assistantBubbles || [])) {
        if (b.compactId || b.compactLoading || b.compactSummary || b.compactError) {
          snapCompactBubbles.push(`activeTurn id=${b.id} loading=${b.compactLoading} summary=${b.compactSummary} error=${b.compactError}`);
        }
      }
      api.log('INFO', `[compact-bubble][DIAG] snapshot arrive: streaming=${data.streaming} turns=${(turns||[]).length} activeTurn=${!!activeTurn} compactBubbles=[${snapCompactBubbles.join(' | ')}]`);

      const bubbles = (activeTurn?.assistantBubbles || []).map((b, i) => ({
        ...b,
        id: b.id || `snap_bubble_${Date.now()}_${i}`,
      }));
      const patchedActiveTurn = activeTurn ? { ...activeTurn, assistantBubbles: bubbles } : null;

      _patchChat(agentId, {
        turns: turns || [],
        activeTurn: patchedActiveTurn,
        historyLoaded: true,
        hasMore: data.hasMore !== undefined ? data.hasMore : false,
      });
      break;
    }

    case 'token': {
      if (!chat) return;
      let at = chat.activeTurn;
      if (!at) return;
      let lastBubble = at.assistantBubbles[at.assistantBubbles.length - 1];
      let needNewBubble = !lastBubble || lastBubble.sealed;
      if (needNewBubble) {
        lastBubble = {
          id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          content: '', toolCalls: [], ts: new Date().toISOString(), sealed: false,
        };
      }
      const cleanedBubble = lastBubble.typing ? { ...lastBubble, typing: undefined } : lastBubble;
      const newBubbles = needNewBubble
        ? [...at.assistantBubbles, cleanedBubble]
        : at.assistantBubbles.map((b, i) => i === at.assistantBubbles.length - 1 ? cleanedBubble : b);

      let st = _rafState.get(agentId);
      if (!st) { st = { rafId: null, pendingContent: '', pendingUpdate: null }; _rafState.set(agentId, st); }
      st.pendingContent += data.content;
      st.pendingUpdate = { activeTurn: { ...at, assistantBubbles: newBubbles } };
      if (!st.rafId) {
        st.rafId = requestAnimationFrame(() => _flushRaf(agentId));
      }
      break;
    }

    case 'tool_call': {
      const chat2 = getState().chats.get(agentId);
      let at = chat2?.activeTurn;
      if (!at) return;
      let lastBubble = at.assistantBubbles[at.assistantBubbles.length - 1];
      let needNewBubble = !lastBubble || lastBubble.sealed;
      if (needNewBubble) {
        lastBubble = {
          id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          content: '', toolCalls: [], ts: new Date().toISOString(), sealed: false,
        };
      }
      const cleanedBubble = lastBubble.typing ? { ...lastBubble, typing: undefined } : lastBubble;
      const existingToolCalls = cleanedBubble.toolCalls || [];
      const newToolCalls = [...existingToolCalls, ...(data.tool_calls || []).map(tc => ({ ...tc, status: 'executing' }))];
      const updatedBubble = { ...cleanedBubble, toolCalls: newToolCalls };
      const newBubbles = needNewBubble
        ? [...at.assistantBubbles, updatedBubble]
        : at.assistantBubbles.map((b, i) => i === at.assistantBubbles.length - 1 ? updatedBubble : b);
      _patchChat(agentId, { activeTurn: { ...at, assistantBubbles: newBubbles } });
      break;
    }

    case 'tool_result': {
      const chat3 = getState().chats.get(agentId);
      const at = chat3?.activeTurn;
      if (!at) return;
      const lastBubble = at.assistantBubbles[at.assistantBubbles.length - 1];
      if (!lastBubble || !lastBubble.toolCalls) return;
      // 按工具调用 id 匹配 executeBatch 的逐个完成即推（tool_result.data.id = tool_call.id）。
      // 无 id 时回退到"第一个 executing"（兼容旧事件）。
      const idx = data.id != null
        ? lastBubble.toolCalls.findIndex(tc => tc.id === data.id)
        : lastBubble.toolCalls.findIndex(tc => tc.status === 'executing');
      if (idx < 0) break;
      const newToolCalls = lastBubble.toolCalls.map((tc, i) => {
        if (i === idx) {
          const updated = { ...tc, status: data.status };
          if (data.message) updated.message = data.message;
          return updated;
        }
        return { ...tc };
      });
      const allDone = !newToolCalls.some(tc => tc.status === 'executing');
      const updatedBubble = { ...lastBubble, toolCalls: newToolCalls, sealed: allDone && newToolCalls.length > 0 ? true : lastBubble.sealed };
      const newBubbles = at.assistantBubbles.map((b, i) => i === at.assistantBubbles.length - 1 ? updatedBubble : b);
      _patchChat(agentId, { activeTurn: { ...at, assistantBubbles: newBubbles } });
      break;
    }

    case 'status':
      break;

    case 'compact_start': {
      const { compactId, attempt } = data;
      const state = getState();
      const chat4 = state.chats.get(agentId);
      let at = chat4?.activeTurn;

      const _atIds = at?.assistantBubbles?.map(b => b.id) ?? [];
      api.log('INFO', `[compact-bubble][DIAG] compact_start arrive: compactId=${compactId} attempt=${attempt} activeTurn=${!!at} activeTurnBubbles=${_atIds.length} ids=[${_atIds.join(',')}]`);

      if (compactId && attempt > 1) {
        const found = _findBubbleByCompactId(state, agentId, compactId);
        if (found) {
          const chats = new Map(state.chats);
          const chat = chats.get(agentId);
          const updated = {
            ...found.turn.assistantBubbles[found.bubbleIdx],
            compactLoading: true, compactError: undefined, compactSummary: undefined,
            compactAttempt: attempt, sealed: false,
          };
          const updatedBubbles = found.turn.assistantBubbles.map((b, i) => i === found.bubbleIdx ? updated : b);
          const updatedTurn = { ...found.turn, assistantBubbles: updatedBubbles };
          if (found.inActive) {
            chats.set(agentId, { ...chat, activeTurn: updatedTurn });
          } else {
            const turns = [...chat.turns];
            turns[chat.turns.indexOf(found.turn)] = updatedTurn;
            chats.set(agentId, { ...chat, turns });
          }
          useAgentStore.setState({ chats });
          break;
        }
      }

      if (!at) return;
      const prevBubble = at.assistantBubbles[at.assistantBubbles.length - 1];
      let sealedPrev = prevBubble && !prevBubble.sealed ? { ...prevBubble, sealed: true } : prevBubble;
      if (sealedPrev && sealedPrev.compactLoading && sealedPrev.compactSummary == null && !sealedPrev.compactError) {
        sealedPrev = { ...sealedPrev, compactLoading: undefined, compactError: '记忆压缩未完成', sealed: true };
      }
      const newBubble = {
        id: compactId || `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        content: '', toolCalls: [], ts: new Date().toISOString(),
        sealed: false, compactLoading: true, compactAttempt: attempt || 1,
      };
      const newBubbles = sealedPrev
        ? at.assistantBubbles.map((b, i) => i === at.assistantBubbles.length - 1 ? sealedPrev : b).concat(newBubble)
        : [...at.assistantBubbles, newBubble];
      _patchChat(agentId, { activeTurn: { ...at, assistantBubbles: newBubbles } });
      break;
    }

    case 'compact': {
      _applyCompactResult(agentId, data.compactId,
        { compactSummary: data.tokenEstimate || true, compactError: undefined, final: undefined },
        { compactSummary: data.tokenEstimate || true });
      break;
    }

    case 'compact_error': {
      const errMsg = _formatCompactError(data);
      _applyCompactResult(agentId, data.compactId,
        { compactError: errMsg, final: data.final || undefined },
        { compactError: errMsg });
      break;
    }

    case 'done': {
      finalizeActiveTurn(agentId);
      break;
    }

    case 'idle': {
      getState().loadHistory(agentId);
      break;
    }

    case 'compact_abort': {
      _applyCompactResult(agentId, data.compactId,
        { compactError: '记忆压缩已终止' },
        { compactError: '记忆压缩已终止' });
      break;
    }

    case 'aborted': {
      const chatAborted = getState().chats.get(agentId);
      const atAborted = chatAborted?.activeTurn;
      if (atAborted) {
        const lastBubble = atAborted.assistantBubbles[atAborted.assistantBubbles.length - 1];
        // 中断收尾：把还没跑完（仍 executing）的工具统一标 canceled——它本是软中止，
        //   后端只对已杀进程的工具回 error tool_result，没轮到的会悬在 executing。
        //   aborted 到来时已是收尾，前面 error 结果已先到并定位（非 executing 了），故只覆盖仍 executing 的。
        if (lastBubble?.toolCalls && lastBubble.toolCalls.some(tc => tc.status === 'executing')) {
          const canceledToolCalls = lastBubble.toolCalls.map(tc =>
            tc.status === 'executing' ? { ...tc, status: 'canceled' } : tc
          );
          const allSettled = !canceledToolCalls.some(tc => tc.status === 'executing');
          const updatedBubble = {
            ...lastBubble,
            toolCalls: canceledToolCalls,
            sealed: allSettled ? true : lastBubble.sealed,
          };
          const sealBubbles = atAborted.assistantBubbles.map((b, i) => i === atAborted.assistantBubbles.length - 1 ? updatedBubble : b);
          _patchChat(agentId, { activeTurn: { ...atAborted, assistantBubbles: sealBubbles } });
        }
        if (lastBubble?.compactLoading && lastBubble.compactSummary == null && !lastBubble.compactError) {
          const updatedBubble = { ...lastBubble, compactLoading: undefined, compactError: '记忆压缩已终止', sealed: true };
          const newBubbles = atAborted.assistantBubbles.map((b, i) => i === atAborted.assistantBubbles.length - 1 ? updatedBubble : b);
          _patchChat(agentId, { activeTurn: { ...atAborted, assistantBubbles: newBubbles } });
        }
      }
      finalizeActiveTurn(agentId);
      getState().showToast('已停止生成');
      break;
    }

    case 'error': {
      finalizeActiveTurn(agentId);
      getState().showToast(`错误: ${data.message}`);
      break;
    }
  }
}