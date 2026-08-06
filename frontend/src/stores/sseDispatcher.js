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
import { rebuildFromSnapshot, applyToken, applyToolCall, applyToolResult } from '../lib/turn-stream-client-core.js';

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
const _rafState = new Map(); // agentId → { rafId, pendingContent, pendingLoop }

function _patchChat(agentId, updates) {
  useAgentStore.getState()._patchChat(agentId, updates);
}

/** 入该房 noticeQueue(按房隔离:激活时 ChatPanel effect 显示,切房显积压,不全局串房)。 */
function _pushNotice(agentId, fields) {
  const chats = new Map(useAgentStore.getState().chats);
  const chat = chats.get(agentId);
  if (chat) {
    chats.set(agentId, { ...chat, noticeQueue: [...(chat.noticeQueue || []), fields] });
  } else {
    // chat 尚未建(notice 先于 snapshot 到达):懒创建带 noticeQueue
    chats.set(agentId, { streaming: false, activeTurn: null, turns: [], historyLoaded: false, hasMore: false, noticeQueue: [fields] });
  }
  useAgentStore.setState({ chats });
}

function _flushRaf(agentId) {
  const st = _rafState.get(agentId);
  if (!st) return;
  if (st.rafId) {
    cancelAnimationFrame(st.rafId);
    st.rafId = null;
  }
  const delta = st.pendingContent;
  const loop = st.pendingLoop;
  st.pendingContent = '';
  st.pendingLoop = null;
  if (!delta) return;
  // ↑ 关键：flush 时直接读 store 里【最新】activeTurn，不再用 token 到达时缓存的陈旧快照。
  //   rAF 是异步帧，在「上一次 token」与「flush」之间活跃 activeTurn 可能被 tool_call/tool_result
  //   改动（loop 边界尤甚）。若用陈旧快照 applyToken 后 _patchChat 整体覆盖，会把中间改动连同刚
  //   累积的文本一起冲掉——render 流式不出来、刷新才有，即此覆盖丢失。读最新态续接则不会丢。
  const at = useAgentStore.getState().chats.get(agentId)?.activeTurn;
  if (!at) return;   // activeTurn 已被 finalize 收走（done 后）→ 丢弃残留 pending
  // content 续接走 client-core（sealed 契约决定续接/新建）；带 _loop 给纯文本 bubble 盖戳，
  //   防止后续 loop 切换后回退 currentLoop 误判（reviewer 文本被盖成 render 即此因）。
  const newAt = applyToken(at, delta, {
    newBubbleId: () => `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    _loop: loop,
  });
  _patchChat(agentId, { activeTurn: newAt });
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
      // 日志：snapshot 到达时的关键数据（tool 气泡数 + 各 turn bubble 数）
      const toolBubblesInTurn = [];
      for (const t of (turns || [])) {
        for (const b of (t.assistantBubbles || [])) {
          if (b.toolCalls?.length) toolBubblesInTurn.push(`${t.id}(${b.id}):${b.toolCalls.length}tc`);
        }
      }
      const toolBubblesInActive = [];
      for (const b of (activeTurn?.assistantBubbles || [])) {
        if (b.toolCalls?.length) toolBubblesInActive.push(`${b.id}:${b.toolCalls.length}tc`);
      }
      api.log('INFO', `[snapshot] agent=${agentId} streaming=${data.streaming} turns=${(turns||[]).length} active=${!!activeTurn} toolBubbles=[turn:${toolBubblesInTurn.join(',')}|active:${toolBubblesInActive.join(',')}] compact=[${snapCompactBubbles.join('|')}]`);

      // 状态构建走 client-core 纯函数（sealed 契约 + bubble 补 id；输出形状与旧逻辑逐行等价）
      const rebuilt = rebuildFromSnapshot(data);
      // 重连 merge:保留已上翻的 olderTurns(snapshot 只含最新窗口),按 turn.id 去重,
      //   不丢上翻历史(§4.7)。activeTurn 由 snapshot 直接覆盖(optimistic local_ id 被真实版替代)。
      const existing = useAgentStore.getState().chats.get(agentId)?.turns || [];
      const snapIds = new Set((rebuilt.turns || []).map(t => t.id));
      const olderTurns = existing.filter(t => !snapIds.has(t.id));
      _patchChat(agentId, {
        turns: [...olderTurns, ...(rebuilt.turns || [])],
        activeTurn: rebuilt.activeTurn,
        historyLoaded: rebuilt.historyLoaded,
        hasMore: rebuilt.hasMore,
      });
      break;
    }

    case 'token': {
      if (!chat) return;
      const at = chat.activeTurn;
      if (!at) return;
      // raf 批处理：pendingContent 累加 delta；flush 时调 applyToken 一次应用（写 store）。
      //   applyToken 内部按 shouldStartNewBubble（sealed 契约）决定续接尾 bubble / 新建。
      //   同时缓存本批 token 的 loop（与后端 turn-stream-server 捕获口径一致：随 token），
      //   flush 时盖戳到文本 bubble，避免后续 loop 切换后回退 currentLoop 误判。
      //   注意：不缓存 activeTurn 快照——flush 时直接读 store 最新态，避免陈旧快照覆盖丢文本。
      let st = _rafState.get(agentId);
      if (!st) { st = { rafId: null, pendingContent: '', pendingLoop: null }; _rafState.set(agentId, st); }
      st.pendingContent += data.content;
      if (data.loop) st.pendingLoop = data.loop;
      if (!st.rafId) {
        st.rafId = requestAnimationFrame(() => _flushRaf(agentId));
      }
      break;
    }

    case 'tool_call': {
      // 先把 rAF 里悬着的 token 落到 activeTurn：紧跟文本到达的 tool_call 若读到「陈旧 activeTurn」，
      //   会把上一段文本与 tool 拆进两个 bubble（elf-018 reviewer「完成了」文本 + Skip 即此 race）。
      _flushRaf(agentId);
      const chat2 = getState().chats.get(agentId);
      const at = chat2?.activeTurn;
      if (!at) return;
      const newAt = applyToolCall(at, data.tool_calls, {
        newBubbleId: () => `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        _loop: data.loop,   // 盖戳到 toolCalls 气泡：finalize/刷新后凭 bubble._loop 继续折叠
      });
      _patchChat(agentId, { activeTurn: newAt, _currentLoop: data.loop });
      break;
    }

    case 'tool_result': {
      const chat3 = getState().chats.get(agentId);
      const at = chat3?.activeTurn;
      if (!at) return;
      const newAt = applyToolResult(at, data);
      if (newAt !== at) _patchChat(agentId, { activeTurn: newAt });
      break;
    }

    case 'status':
      // loop 边界封盘：新 loop 的 status 在首个 token 前先到，先把 rAF 里悬着的上一 loop 尾文本 flush 成
      //   旧 loop 气泡（pendingLoop 是上一 loop token 缓存的，applyToken 盖旧 loop 戳），再切 _currentLoop。
      //   复盘 elf-018：reviewer 末尾「完成了」token 缓存了 pendingLoop=reviewer，render 首 token 到达时
      //   pendingLoop 被覆盖成 render、pendingContent 累加成「完成了正文…」合成一个 render bubble。此处
      //   status 边界先 flush，让「完成了」成独立 reviewer bubble（前端按 _loop 折叠非 render）。
      //   仅 loop 切换时封盘（cur 与 data.loop 不同且 cur 存在）；同 loop 内多轮 status 不改气泡粒度，
      //   工具执行 status（tool_manager.js:194，不带 loop）不入此分支。
      if (data.loop) {
        const cur = useAgentStore.getState().chats.get(agentId)?._currentLoop;
        if (cur && cur !== data.loop) {
          _flushRaf(agentId);
          // flush 后再把上一 loop 的尾 bubble seal 掉——否则下一 loop 的 token 因尾 bubble 未 sealed
          //   被 applyToken 判定续接，render 正文会续进 outline 尾文本气泡、继承 _loop=outline 被折叠。
          //   （服务端 turn-stream-server 的 status 切换 _flushBubble 落盘即 sealed；前端 LIVE 须对齐。）
          const atSeal = useAgentStore.getState().chats.get(agentId)?.activeTurn;
          const lastB = atSeal?.assistantBubbles?.[atSeal.assistantBubbles.length - 1];
          api.log('INFO', `[loop-switch] agent=${agentId} ${cur}→${data.loop} lastBubble._loop=${lastB?._loop} sealed=${lastB?.sealed}`);
          if (atSeal && lastB && !lastB.sealed) {
            const newBubbles = atSeal.assistantBubbles.map((b, i) => i === atSeal.assistantBubbles.length - 1 ? { ...b, sealed: true } : b);
            _patchChat(agentId, { activeTurn: { ...atSeal, assistantBubbles: newBubbles } });
            api.log('INFO', `[loop-switch] sealed last bubble (_loop=${lastB._loop || '-'}) so ${data.loop} token starts a new bubble`);
          }
        }
        _patchChat(agentId, { _currentLoop: data.loop });
      }
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

    case 'abortRewind': {
      // elf-018 abort 信号:gateway 已用 rewindTo(latest) 把本轮 user 从 history.jsonl/context 删除并回填输入框。
      //   这里标记 pendingRestorePrompt 供 ChatPanel 一次性消费写 inputRef,并 force 重载历史(user 气泡消失)。
      //   'aborted' 已先到并清了 activeTurn,此处不重复清。
      _patchChat(agentId, { pendingRestorePrompt: data?.restoredPrompt ?? null });
      useAgentStore.getState().loadHistory(agentId, { force: true });
      break;
    }

    case 'compact_abort': {
      _applyCompactResult(agentId, data.compactId,
        { compactError: '记忆压缩已终止' },
        { compactError: '记忆压缩已终止' });
      break;
    }

    case 'aborted': {
      // 中断 = 丢弃本轮 partial：与 elf-018 auto-rewind（rewindToLastUser）一致——
      //   用户点终止即回退到 user 前，partial 不入 turns、不保留。后端 history 也同步丢弃。
      //   （旧逻辑 finalizeActiveTurn 把 partial 存为可见 turn，与 auto-rewind 设计冲突。）
      _patchChat(agentId, { activeTurn: null });
      _pushNotice(agentId, { text: '已停止生成' });
      break;
    }

    case 'error': {
      // 最终失败的居中提示统一由 notice(kind:'error') 驱动（私聊 emitError / 也会发 notice）。
      // error 这里只收尾 activeTurn，不再单独弹 toast，避免与 notice 重复。
      finalizeActiveTurn(agentId);
      break;
    }

    case 'notice': {
      // 入该房 noticeQueue,激活时 ChatPanel effect 显示(按房隔离不串房,切房显积压)。
      _pushNotice(agentId, data);
      break;
    }
  }
}