/**
 * TurnStreamServer —— 私聊流式回合的后端通用模块（解决 temp #8）
 *
 * 职责（仅限 #8 范围，不带分页/rewind/背压）：
 *  - 多轮生成时每轮正确分块落盘（判定 shouldStartNewBubble 由外部注入）
 *  - 当前回合的进程内内存态（activeUser / 未落盘 content / toolCalls + 状态）
 *  - buildSnapshot：磁盘已完成 turns + current 回合补全整轮（去重 + 必带 activeTurn）
 *
 * 不认识 reasoning/tool_call/compact 等业务名：content 作"流式增量"原语，
 *   其余作"带锚定 id 的命名事件"按 id 找记录合并。flush 时机由外部注入判定决定。
 *
 * 跨端 sealed 约定见 shared/turn-stream-contract.js。
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { sealedBubble } from '../shared/turn-stream-contract.js';

const logger = createLogger('turn-stream-server', 'gateway.log');

/** 当前工具是否有 executing 态。 */
function _hasExecuting(toolCalls) {
  return (toolCalls || []).some(tc => tc.status === 'executing');
}

/** user/assistant 消息序列按轮次聚合：user 开起新 turn，后续 assistant 进当前 turn 的气泡。 */
function messagesToTurns(messages) {
  const turns = [];
  let current = null;
  for (const msg of messages || []) {
    if (msg.role === 'user') {
      current = { id: `turn_${msg.id}`, userMessage: msg, assistantBubbles: [] };
      turns.push(current);
    } else if (msg.role === 'assistant') {
      if (!current) {
        current = { id: `turn_${msg.id}`, userMessage: null, assistantBubbles: [] };
        turns.push(current);
      }
      current.assistantBubbles.push({ ...msg, sealed: true });
    }
  }
  return turns;
}

export class TurnStreamServer {
  /**
   * @param {object} opts
   * @param {string} opts.historyFile - 写盘函数；签名 (record) => void，由外部注入（不绑死 jsonl）
   * @param {object} opts.historyStore - 历史读写接口：{ append(roomId, role, content, toolCalls, extraFields), updateCompact(roomId, id, patch), recent(roomId, limit) }
   * @param {Function} opts.shouldStartNewBubble - (streamStateSnapshot, eventName, data) => boolean；外部注入的多轮分块判定
   */
  constructor({ historyStore, shouldStartNewBubble }) {
    this._historyStore = historyStore;
    this._shouldStartNewBubble = shouldStartNewBubble || (() => false);
    // roomId → 进程内回合状态
    this._rooms = new Map();
    // 该外部注入的 SSE 广播器：roomId → (chunk) => void
    this._broadcaster = null;
  }

  /** 注入 SSE 广播器：调用方提供 `(roomId, chunk) => void`，模块只管"该广播时调它"，不碰 res。 */
  setBroadcaster(fn) { this._broadcaster = fn; }

  _ensure(roomId) {
    if (!this._rooms.has(roomId)) {
      this._rooms.set(roomId, {
        activeUser: null,        // {id, content, ts}
        assistantContent: '',    // 未落盘尾文本
        toolCalls: [],           // 未落盘工具调用（含 status）
        streaming: false,
        _hasHistoryOutput: false, // 整回合是否已有 assistant 记录落盘
        _currentLoop: null,      // 本轮当前 loop（main/reviewer/render），随 token/tool_call 的 data.loop 更新；落盘时写 bubble._loop 供前端刷新后折叠
      });
    }
    return this._rooms.get(roomId);
  }

  /** 仅供适配层读取广播 chunk。 */
  _broadcast(roomId, chunk) {
    if (this._broadcaster) this._broadcaster(roomId, chunk);
  }

  /** snapshot/public 读图用的只读状态（适配层鉴权用，不暴露内部可变结构）。 */
  getRoomState(roomId) {
    const st = this._rooms.get(roomId);
    return st ? { streaming: st.streaming } : null;
  }

  /** 已落盘 toolCalls 非空 且 无 executing → 可触发新轮 flush 的状态快照。 */
  _snapshotForFlush(st) {
    return { toolCalls: st.toolCalls };
  }

  /** 把当前累积落一条 assistant 记录并清空累积器。 */
  _flushBubble(roomId) {
    const st = this._ensure(roomId);
    const hasContent = st.assistantContent && st.assistantContent.length > 0;
    const hasTools = st.toolCalls.length > 0;
    if (!hasContent && !hasTools) return;
    const extra = st._currentLoop ? { _loop: st._currentLoop } : undefined;
    logger.info(`[history] room=${roomId} flushBubble content=${hasContent ? st.assistantContent.length : 0}chars toolCalls=${st.toolCalls.length} loop=${st._currentLoop || '-'}`);
    this._historyStore.append(roomId, 'assistant', st.assistantContent || '', st.toolCalls.length ? st.toolCalls : undefined, extra);
    st._hasHistoryOutput = true;
    st.assistantContent = '';
    st.toolCalls = [];
  }

  /**
   * 标记新回合开始 + 写 user 落盘。
   * 并发互斥：streaming 中拒绝第二个 turn。
   */
  startTurn(roomId, userMessageRecord) {
    const st = this._ensure(roomId);
    if (st.streaming) throw new Error(`startTurn: room ${roomId} 已在 streaming 中，拒绝并发 turn`);
    st.activeUser = {
      id: userMessageRecord?.id || null,
      content: userMessageRecord?.content || '',
      ts: userMessageRecord?.ts || new Date().toISOString(),
    };
    st.assistantContent = '';
    st.toolCalls = [];
    st.streaming = true;
    st._hasHistoryOutput = false;
    st._currentLoop = null;
    // user 由调用方在路由层负责落盘（生产里 /say 路由 historyStore.append(roomId,'user',...) 单独写）
    // 此处只维护内存态 + streaming 标记，不重复落盘 user。
  }

  /**
   * 收一个事件：更新内存态 + 触发分块 flush + 落 compact 锚定 + 广播。
   * @param {string} roomId
   * @param {string} eventName - token / tool_call / tool_result / compact_start / compact / compact_error / compact_abort / done / aborted / error
   * @param {object} data - 事件数据（可选含 _roomId，模块不依赖）
   * @returns {boolean} 是否终结（done/aborted/error）
   */
  handleEvent(roomId, eventName, data = {}) {
    const st = this._ensure(roomId);

    // ── status 边界 flush：loop 切换时先把上一 loop 滞留的尾文本/工具 flush 成带旧 _loop 的气泡，再切 _currentLoop ──
    //   复盘 elf-018：reviewer 末尾纯文本「完成了」无工具，行 142 的分块 flush 要求 toolCalls>0 不触发，尾文本滞留
    //   assistantContent；render 首 token 到达时 _currentLoop 被翻成 render，于是「完成了」连同正文在 done 时落成
    //   「完成了正文…」一条 render 气泡，reviewer 丢了收尾气泡。engine/agent.js 在每个 loop 首个 token 前先 emit
    //   status(thinking, newLoop)，此刻 st._currentLoop 还是旧值——趁此主动封盘，尾文本盖旧 loop 戳落盘。
    //   仅随带 loop 的 status 触发（tool_manager.js:194 的工具执行 status 不带 loop，data.loop 为 falsy 不进）；
    //   同 loop 内多轮 status(thinking, sameLoop) 不切换、不 flush，不改 loop 内既有气泡粒度。空 buffer 时 _flushBubble
    //   行 100 兜底 no-op（如首个 loop 的 status）。
    if (eventName === 'status' && data?.loop && data.loop !== st._currentLoop) {
      this._flushBubble(roomId);
      st._currentLoop = data.loop;
    }

    // ── 多轮分块判定（外部注入）：新轮 token/tool_call 到达且上轮已可收尾 → flush 上一轮 ──
    const canBeNewRound = eventName === 'token' || eventName === 'tool_call';
    if (canBeNewRound && st.toolCalls.length > 0 && !_hasExecuting(st.toolCalls)) {
      if (this._shouldStartNewBubble(this._snapshotForFlush(st), eventName, data)) {
        this._flushBubble(roomId);
      }
    }

    // ── loop 标记：仅随 token/tool_call 捕获 data.loop ──
    //   只在这两种「累积事件」上捕获，且它们在新轮 flush 检查之后触发，保证上一 bubble 用旧 loop 落盘。
    //   不捕获 status：status 在 loop 边界（下一轮首个 token/tool_call 前）单独先到，此刻上一 bubble
    //   往往还悬在内存未 flush，若捕获会把上一 bubble 错盖成新 loop（elf-018 reviewer 末尾 Skip 气泡
    //   被盖成 render 即此因）。
    if ((eventName === 'token' || eventName === 'tool_call') && data?.loop) {
      st._currentLoop = data.loop;
    }

    // ── content / 工具累积 ──
    if (eventName === 'token' && data?.content) st.assistantContent += data.content;
    if (eventName === 'tool_call' && data?.tool_calls) {
      for (const tc of data.tool_calls) st.toolCalls.push({ ...tc, status: 'executing' });
    } else if (eventName === 'tool_result' && data?.id) {
      const t = st.toolCalls.find(tc => tc.id === data.id && tc.status === 'executing');
      if (t) t.status = data.status || 'success';
      if (t && data.message) t.message = data.message;
      if (t && data.result != null) t.result = data.result;
    }

    // ── compact 锚定落盘（按 compactId 就地更新，不新行）──
    const cid = data?.compactId;
    if (cid) {
      try {
        if (eventName === 'compact_start') {
          this._historyStore.append(roomId, 'assistant', '', undefined, { id: cid, compactId: cid, compactLoading: true, compactAttempt: data.attempt || 1 });
          st._hasHistoryOutput = true;
        } else if (eventName === 'compact') {
          this._historyStore.updateCompact(roomId, cid, { compactSummary: data.tokenEstimate || true });
        } else if (eventName === 'compact_error') {
          this._historyStore.updateCompact(roomId, cid, { compactError: data.error || '记忆压缩失败', final: data.final });
        } else if (eventName === 'compact_abort') {
          this._historyStore.updateCompact(roomId, cid, { compactError: '记忆压缩已终止' });
        }
      } catch (e) { logger.error(`compact 落盘失败 (${roomId}/${eventName}): ${e.message}`); }
    }

    // ── 终结：flush 尾 + 空 turn 兜底 ──
    let finished = false;
    if (eventName === 'aborted') {
      // 中断：丢弃本轮已累积的 partial（不落盘 history）。elf-018 的全量回退(删 user+还 runtime+回填输入框)
      //   由 agent 随后发的 abortRewind 信号触发 gateway rewindTo(latest) 统一处理,本处只清内存 partial。
      st.streaming = false;
      finished = true;
      st.assistantContent = '';
      st.toolCalls = [];
      st._hasHistoryOutput = false;
    } else if (eventName === 'done' || eventName === 'error') {
      st.streaming = false;
      finished = true;
      this._flushBubble(roomId);
      if (!st._hasHistoryOutput) {
        const hasContent = st.assistantContent && st.assistantContent.length > 0;
        const hasTools = st.toolCalls.length > 0;
        // content 与 tool 都空 → 不落盘（纯空回复不占历史行）；否则落盘保时序
        if (hasContent || hasTools) {
          const extra = st._currentLoop ? { _loop: st._currentLoop } : undefined;
          logger.info(`[history] room=${roomId} 空turn兜底 content=${hasContent ? st.assistantContent.length : 0}chars toolCalls=${st.toolCalls.length} loop=${st._currentLoop || '-'}`);
          try { this._historyStore.append(roomId, 'assistant', st.assistantContent || '', st.toolCalls.length ? st.toolCalls : undefined, extra); }
          catch (e) { logger.error(`空 turn 兜底落盘失败 (${roomId}): ${e.message}`); }
          st._hasHistoryOutput = true;
        }
      }
    }
    return finished;
  }

  /**
   * 构建新连接的 snapshot：磁盘已完成 turns + current 回合计视图（去重 + 补全整轮 + 必带 activeTurn）。
   * 这是 #8 刷新稳定的核心契约（详见 shared/turn-stream-contract.js）。
   * @param {string} roomId
   * @param {number} [limit=30]
   * @returns {{ turns: Array, activeTurn: object|null, streaming: boolean, hasMore: boolean }}
   */
  buildSnapshot(roomId, limit = 30) {
    const st = this._ensure(roomId);
    const recent = this._historyStore.recent(roomId, limit);
    const turns = messagesToTurns(recent.messages || []);
    let activeTurn = null;
    if (st.streaming) {
      // 当前回合的 user 与磁盘最后一条 user 同一轮 → pop 整轮，由 activeTurn 独占（防 user 翻倍）
      const flushedBubbles = [];
      if (turns.length > 0 && st.activeUser?.id) {
        const last = turns[turns.length - 1];
        if (last.userMessage?.id === st.activeUser.id) {
          for (const b of (last.assistantBubbles || [])) flushedBubbles.push(sealedBubble(b));
          turns.pop();
        }
      }
      const hasPartial = st.assistantContent || st.toolCalls.length > 0;
      const tailBubble = hasPartial
        ? [{ content: st.assistantContent || '', toolCalls: st.toolCalls.length ? st.toolCalls : undefined, ...(st._currentLoop ? { _loop: st._currentLoop } : {}) }]
        : [];
      activeTurn = {
        id: 'turn_active',
        userMessage: st.activeUser,
        assistantBubbles: [...flushedBubbles, ...tailBubble],
      };
    }
    const toolInfo = st.toolCalls.length ? `${st.toolCalls.length}tc(e=${st.toolCalls.filter(t => t.status === 'executing').length})` : '0tc';
    const turnInfo = turns.map(t => `${t.id}(${t.assistantBubbles.length}b)`).join(',');
    logger.info(`[snapshot] room=${roomId} streaming=${st.streaming} diskTurns=${turns.length}[${turnInfo}] activeContent=${st.assistantContent ? st.assistantContent.length : 0}chars activeTools=${toolInfo}`);
    return { turns, activeTurn, streaming: st.streaming, hasMore: !!recent.hasMore };
  }

  /** 仅供测试重置内存态。 */
  _testReset() { this._rooms.clear(); }

  /** 列出当前内存态中的所有 roomId（多用户：pm 断连兜底按 agent 后缀过滤用）。 */
  listRoomIds() { return [...this._rooms.keys()]; }
}

export { messagesToTurns };
