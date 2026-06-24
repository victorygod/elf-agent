/**
 * SSE 聊天代理模块
 * 代理 Gateway 到 Agent 的 SSE 流，同时解析事件写入聊天历史
 * 支持 SSE 订阅：页面刷新后前端可重连到正在进行的流
 *
 * StreamContext 生命周期：
 *   - proxyChat 开始时创建新 ctx（每轮新建，不复用）
 *   - proxyChat 结束时 close ctx
 *   - subscribe 时读取 ctx 构建 snapshot
 *
 * subscribe 快照策略：
 *   - subscribe 总是返回 200 + event: snapshot
 *   - 有活跃流时：快照包含 streaming:true, turns（从 jsonl）, activeTurn（从 eventLog）
 *   - 无活跃流时：快照包含 streaming:false, turns（从 jsonl）, activeTurn:null
 *   - turns 中去掉 activeTurn 对应的 user 消息所在轮次（避免重复）
 */

import { createLogger } from '../shared/logger.js';

let logFileName = null;

export function setChatProxyLogFileName(name) {
  logFileName = name;
}

// ===== 流上下文注册表（模块级） =====
export const streamContexts = new Map(); // agentId → StreamContext

/**
 * 流上下文：per-agent 单轮生命周期对象
 */
export class StreamContext {
  constructor(agentId, chatHistory, activeStreams) {
    this.agentId = agentId;
    this.chatHistory = chatHistory;
    this.activeStreams = activeStreams;

    // 累积内容（给 history flush 用）
    this.assistantContent = '';
    this.assistantToolCalls = [];
    this.assistantExtraFields = {};
    this.pendingToolCount = 0;

    // 事件日志（给 snapshot 构建用）
    this.eventLog = []; // [{event, data}]

    // 订阅者列表
    this.subscribers = []; // [{res}]

    // 状态
    this.streamEnded = false;
    this.primaryClientDisconnected = false;
    this.primaryRes = null;
    this.closed = false;

    // 当前轮次的 user 消息信息（给 snapshot 构建用）
    this._activeUserMessage = null;
    this._activeUserMessageId = null;
    this._activeUserMessageTs = null;
  }

  /** 向主客户端 + 所有订阅者广播原始 chunk */
  broadcastChunk(chunk) {
    if (this.closed) return;
    if (!this.primaryClientDisconnected) {
      try {
        if (this.primaryRes.writable) this.primaryRes.write(chunk);
        else this.primaryClientDisconnected = true;
      } catch (e) { this.primaryClientDisconnected = true; }
    }
    this.subscribers = this.subscribers.filter(sub => {
      try {
        if (sub.res.writable) {
          sub.res.write(chunk);
          return true;
        }
        return false;
      } catch (e) { return false; }
    });
  }

  /** 记录一个已解析的事件（供 snapshot 构建用） */
  recordEvent(event, data) {
    this.eventLog.push({ event, data });
  }

  /**
   * 写入当前轮次累积的 assistant 产出到 history.jsonl
   */
  flushRoundToHistory() {
    if (this.chatHistory && (this.assistantContent || this.assistantToolCalls.length > 0)) {
      const extra = Object.keys(this.assistantExtraFields).length > 0 ? this.assistantExtraFields : undefined;
      this.chatHistory.addMessage(this.agentId, 'assistant', this.assistantContent, this.assistantToolCalls, extra);
      this.assistantContent = '';
      this.assistantToolCalls = [];
      this.assistantExtraFields = {};
      this.pendingToolCount = 0;
    }
  }

  /** 关闭所有订阅者 + 从注册表移除 */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.streamEnded = true;
    for (const sub of this.subscribers) {
      try {
        if (sub.res.writable) sub.res.end();
      } catch (e) { /* ignore */ }
    }
    this.subscribers = [];
    if (this.activeStreams) this.activeStreams.delete(this.agentId);
    streamContexts.delete(this.agentId);
  }
}


/**
 * 从 rawMessages 数组构建 Turn 数组
 * rawMessages 是 chat_history.getRecent 返回的 [{id, role, content, ts, toolCalls, ...}]
 * @param {Array} messages
 * @param {string} [excludeUserContent] - 如果提供，排除包含此内容的 user 消息所在轮次
 * @returns {Array} turns
 */
function messagesToTurns(messages, excludeUserContent) {
  const turns = [];
  let current = null;
  let skipping = false; // ★ 标记正在跳过活跃轮次（user + 后续 assistant 全部跳过）
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (excludeUserContent && msg.content === excludeUserContent) {
        // 这是 activeTurn 的 user 消息，开始跳过模式
        skipping = true;
        current = null;
        continue;
      }
      skipping = false;
      current = { id: `turn_${msg.id}`, userMessage: msg, assistantBubbles: [] };
      turns.push(current);
    } else if (msg.role === 'assistant') {
      if (skipping) continue; // ★ 跳过活跃轮次中已写入 jsonl 的 assistant 消息
      if (!current) {
        current = { id: `turn_${msg.id}`, userMessage: null, assistantBubbles: [] };
        turns.push(current);
      }
      current.assistantBubbles.push({ ...msg, sealed: true });
    }
    // role === 'system' 的消息静默忽略
  }
  return turns;
}


/**
 * 从 StreamContext 的 eventLog 构建 assistantBubbles
 */
function buildBubblesFromContext(ctx) {
  const bubbles = [];
  let currentBubble = null;

  for (const entry of ctx.eventLog) {
    switch (entry.event) {
      case 'token': {
        if (!currentBubble || currentBubble.sealed) {
          currentBubble = { content: '', toolCalls: [], sealed: false };
          bubbles.push(currentBubble);
        }
        if (entry.data.content) {
          currentBubble.content += entry.data.content;
        }
        break;
      }
      case 'tool_call': {
        if (!currentBubble || currentBubble.sealed) {
          currentBubble = { content: '', toolCalls: [], sealed: false };
          bubbles.push(currentBubble);
        }
        for (const tc of (entry.data.tool_calls || [])) {
          currentBubble.toolCalls.push({ ...tc, status: 'executing' });
        }
        break;
      }
      case 'tool_result': {
        if (currentBubble && currentBubble.toolCalls) {
          const idx = currentBubble.toolCalls.findIndex(tc => tc.status === 'executing');
          if (idx !== -1) {
            currentBubble.toolCalls[idx].status = entry.data.status;
            if (entry.data.message) currentBubble.toolCalls[idx].message = entry.data.message;
          }
          if (!currentBubble.toolCalls.some(tc => tc.status === 'executing')) {
            currentBubble.sealed = true;
          }
        }
        break;
      }
      case 'compact_start': {
        if (currentBubble && !currentBubble.sealed) currentBubble.sealed = true;
        currentBubble = { content: '', toolCalls: [], sealed: false, compactLoading: true };
        bubbles.push(currentBubble);
        break;
      }
      case 'compact': {
        if (currentBubble) {
          delete currentBubble.compactLoading;
          currentBubble.compactSummary = entry.data.tokenEstimate || true;
          currentBubble.sealed = true;
        }
        break;
      }
      case 'compact_error': {
        if (currentBubble) {
          delete currentBubble.compactLoading;
          currentBubble.compactError = entry.data.error || '记忆压缩失败';
          currentBubble.sealed = true;
        }
        break;
      }
    }
  }

  return bubbles;
}


/**
 * 从 StreamContext + ChatHistory 构建当前状态快照
 * @returns {{ streaming: boolean, turns: Array, activeTurn: object|null }}
 */
function buildSnapshot(agentId, ctx, chatHistory) {
  // 无活跃流：返回 idle 快照
  if (!ctx || ctx.closed || ctx.streamEnded) {
    const rawMessages = chatHistory ? chatHistory.getRecent(agentId, 50).messages : [];
    const turns = messagesToTurns(rawMessages);
    return { streaming: false, turns, activeTurn: null };
  }

  // 有活跃流：turns 去掉 activeTurn 对应的轮次
  const rawMessages = chatHistory ? chatHistory.getRecent(agentId, 50).messages : [];
  const turns = messagesToTurns(rawMessages, ctx._activeUserMessage);

  const bubbles = buildBubblesFromContext(ctx);
  const activeTurn = {
    id: 'turn_active',
    userMessage: ctx._activeUserMessage
      ? { id: ctx._activeUserMessageId, content: ctx._activeUserMessage, ts: ctx._activeUserMessageTs }
      : null,
    assistantBubbles: bubbles,
  };

  return { streaming: true, turns, activeTurn };
}


/**
 * 订阅一个正在进行中的 SSE 流（快照优先）
 * 先发送 event: snapshot，然后加入 subscribers 接收后续事件
 */
export function subscribeToStream(agentId, res, chatHistory) {
  const ctx = streamContexts.get(agentId);

  // SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);

  // 发送快照
  const snapshot = buildSnapshot(agentId, ctx, chatHistory);
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  // 有活跃流：注册 subscriber 接收后续事件
  if (ctx && !ctx.closed && !ctx.streamEnded) {
    ctx.subscribers.push({ res });
    res.on('close', () => {
      const idx = ctx.subscribers.findIndex(s => s.res === res);
      if (idx !== -1) ctx.subscribers.splice(idx, 1);
    });
  } else {
    // 无活跃流：快照即终态，关闭连接
    res.end();
  }

  return ctx;
}


/**
 * 获取指定 agent 的流上下文（供 server.js 路由使用）
 */
export function getStreamContext(agentId) {
  return streamContexts.get(agentId) || null;
}


/**
 * 代理到 Agent 的 SSE 聊天请求
 * @param {object} params
 * @param {string} params.agentId
 * @param {number} params.port
 * @param {string} params.message - 用户消息
 * @param {object} params.res - Express response
 * @param {object} params.chatHistory - ChatHistory 实例
 * @param {Map} params.activeStreams - 活跃 SSE 流追踪 Map
 * @param {object} params.userMessageRecord - { id, content, ts } 写入 jsonl 后返回的记录
 */
export function proxyChat({ agentId, port, message, res, chatHistory, activeStreams, userMessageRecord }) {
  const logger = createLogger('chat-proxy', logFileName);
  const id = agentId;

  // 关闭旧 ctx（如果有，如上一个请求异常未清理）
  const oldCtx = streamContexts.get(id);
  if (oldCtx && !oldCtx.closed) {
    oldCtx.close();
  }

  // 创建新 ctx
  const ctx = new StreamContext(id, chatHistory, activeStreams);
  ctx.primaryRes = res;
  ctx._activeUserMessage = userMessageRecord?.content || message;
  ctx._activeUserMessageId = userMessageRecord?.id || null;
  ctx._activeUserMessageTs = userMessageRecord?.ts || new Date().toISOString();
  streamContexts.set(id, ctx);

  // 追踪 active stream
  activeStreams.set(id, (activeStreams.get(id) || 0) + 1);

  res.on('close', () => {
    if (!ctx.closed) {
      ctx.primaryClientDisconnected = true;
    }
  });

  function streamFinished() {
    const count = (activeStreams.get(id) || 1) - 1;
    if (count <= 0) {
      activeStreams.delete(id);
    } else {
      activeStreams.set(id, count);
    }
    if (!ctx.closed) {
      ctx.close();
    }
  }

  logger.info(`[SSE] 请求 Agent: ${id}`);

  fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).then(agentRes => {
    if (!agentRes.ok) {
      ctx.recordEvent('error', { message: `Agent returned ${agentRes.status}` });
      ctx.broadcastChunk(`event: error\ndata: ${JSON.stringify({ message: `Agent returned ${agentRes.status}` })}\n\n`);
      try { if (ctx.primaryRes.writable) ctx.primaryRes.end(); } catch (e) { /* ignore */ }
      streamFinished();
      return;
    }

    const reader = agentRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let currentEvent = '';

    function pump() {
      if (ctx.closed) return;

      reader.read().then(({ done, value }) => {
        if (ctx.closed) return;

        if (done) {
          ctx.flushRoundToHistory();
          ctx.streamEnded = true;

          // ★ 通知前端流结束（abort 也触发这里，解决 abort 后 typing 不消失的问题）
          ctx.broadcastChunk('event: done\ndata: {}\n\n');
          try { if (ctx.primaryRes.writable) ctx.primaryRes.end(); } catch (e) { /* ignore */ }

          streamFinished();
          return;
        }
        const chunk = decoder.decode(value, { stream: true });

        ctx.broadcastChunk(chunk);

        sseBuffer += chunk;
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7).trim();
          } else if (trimmed.startsWith('data: ')) {
            let parsedData = null;
            try { parsedData = JSON.parse(trimmed.slice(6)); } catch (e) { /* ignore */ }

            if (parsedData) {
              ctx.recordEvent(currentEvent, parsedData);

              if (currentEvent === 'token') {
                if (parsedData.content) ctx.assistantContent += parsedData.content;
              } else if (currentEvent === 'tool_call') {
                if (parsedData.tool_calls) {
                  parsedData.tool_calls.forEach(tc => {
                    tc.status = 'executing';
                    ctx.assistantToolCalls.push(tc);
                    ctx.pendingToolCount++;
                  });
                }
              } else if (currentEvent === 'tool_result') {
                const idx = ctx.assistantToolCalls.findIndex(tc => tc.status === 'executing');
                if (idx !== -1) {
                  ctx.assistantToolCalls[idx].status = parsedData.status;
                  if (parsedData.message) ctx.assistantToolCalls[idx].message = parsedData.message;
                }
                ctx.pendingToolCount--;
                if (ctx.pendingToolCount === 0 && ctx.assistantToolCalls.length > 0) {
                  ctx.flushRoundToHistory();
                }
              } else if (currentEvent === 'error') {
                ctx.flushRoundToHistory();
              } else if (currentEvent === 'compact_start') {
                ctx.flushRoundToHistory();
                if (ctx.chatHistory) {
                  ctx.chatHistory.addMessage(id, 'assistant', '', undefined, { compactLoading: true });
                }
              } else if (currentEvent === 'compact') {
                if (ctx.chatHistory) {
                  ctx.chatHistory.addMessage(id, 'assistant', '', undefined, { compactSummary: parsedData.tokenEstimate || true });
                }
              } else if (currentEvent === 'compact_error') {
                if (ctx.chatHistory) {
                  ctx.chatHistory.addMessage(id, 'assistant', '', undefined, { compactError: parsedData.error || '记忆压缩失败' });
                }
              } else if (currentEvent === 'compact_abort') {
                if (ctx.chatHistory) {
                  ctx.chatHistory.addMessage(id, 'assistant', '', undefined, { compactError: '记忆压缩已终止' });
                }
              }
            }
            currentEvent = '';
          } else if (trimmed === '') {
            currentEvent = '';
          }
        }

        pump();
      }).catch(err => {
        logger.error(`SSE 透传错误: ${err.message}`);
        ctx.flushRoundToHistory();
        if (!ctx.primaryClientDisconnected) {
          try {
            if (ctx.primaryRes.writable) ctx.primaryRes.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
          } catch (e) { /* ignore */ }
          try { if (ctx.primaryRes.writable) ctx.primaryRes.end(); } catch (e) { /* ignore */ }
        }
        streamFinished();
      });
    }
    pump();

  }).catch(err => {
    logger.error(`[SSE] Agent 请求失败: ${err.message}`);
    if (!ctx.primaryClientDisconnected) {
      try {
        if (ctx.primaryRes.writable) ctx.primaryRes.write(`event: error\ndata: ${JSON.stringify({ message: 'Agent unavailable' })}\n\n`);
      } catch (e) { /* ignore */ }
      try { if (ctx.primaryRes.writable) ctx.primaryRes.end(); } catch (e) { /* ignore */ }
    }
    streamFinished();
  });
}
