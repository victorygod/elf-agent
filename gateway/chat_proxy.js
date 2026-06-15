/**
 * SSE 聊天代理模块
 * 代理 Gateway 到 Agent 的 SSE 流，同时解析事件写入聊天历史
 */

import { createLogger } from '../shared/logger.js';

let logFileName = null;

export function setChatProxyLogFileName(name) {
  logFileName = name;
}

/**
 * 代理到 Agent 的 SSE 聊天请求
 * @param {object} params
 * @param {string} params.agentId - Agent ID
 * @param {number} params.port - Agent 端口
 * @param {object} params.req - Express request
 * @param {object} params.res - Express response
 * @param {object} params.chatHistory - ChatHistory 实例
 * @param {Map} params.activeStreams - 活跃 SSE 流追踪 Map
 */
export function proxyChat({ agentId, port, req, res, chatHistory, activeStreams }) {
  const logger = createLogger('chat-proxy', logFileName);
  const id = agentId;

  // 写入用户消息到 history
  const userMessage = req.body.message;
  if (chatHistory) {
    chatHistory.addMessage(id, 'user', userMessage);
  }

  // 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // 立即发送 HTTP 响应头
  res.flushHeaders();

  // 禁用 Nagle 算法
  if (res.socket) {
    res.socket.setNoDelay(true);
  }

  const agentUrl = `http://127.0.0.1:${port}/chat`;

  // 追踪 active stream
  activeStreams.set(id, (activeStreams.get(id) || 0) + 1);

  // 用于拼接 assistant 完整回复和工具调用信息
  let assistantContent = '';
  let assistantToolCalls = [];
  let clientDisconnected = false;
  let streamEnded = false;

  /** 流结束时统一清理 */
  function streamFinished() {
    const count = (activeStreams.get(id) || 1) - 1;
    if (count <= 0) {
      activeStreams.delete(id);
    } else {
      activeStreams.set(id, count);
    }
  }

  /** 写入 assistant 回复到 history（避免重复写入） */
  function flushAssistantToHistory() {
    if (chatHistory && (assistantContent || assistantToolCalls.length > 0)) {
      chatHistory.addMessage(id, 'assistant', assistantContent, assistantToolCalls);
      assistantContent = '';
      assistantToolCalls = [];
    }
  }

  logger.info(`[SSE] 请求 Agent: ${agentUrl}`);

  fetch(agentUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body)
  }).then(agentRes => {
    if (!agentRes.ok) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: `Agent returned ${agentRes.status}` })}\n\n`);
      res.end();
      streamFinished();
      return;
    }

    // 解析 SSE 流，同时转发给客户端
    const reader = agentRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let currentEvent = '';

    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          flushAssistantToHistory();
          streamEnded = true;
          streamFinished();
          if (!clientDisconnected) {
            res.end();
          }
          return;
        }
        const chunk = decoder.decode(value, { stream: true });

        // 只有客户端未断开时才转发
        if (!clientDisconnected) {
          try {
            res.write(chunk);
          } catch (e) {
            clientDisconnected = true;
          }
        }

        // 无论客户端是否断开，都继续解析 SSE 事件以拼接 assistant 内容
        sseBuffer += chunk;
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7).trim();
          } else if (trimmed.startsWith('data: ')) {
            if (currentEvent === 'token') {
              try {
                const data = JSON.parse(trimmed.slice(6));
                if (data.content) {
                  assistantContent += data.content;
                }
              } catch (e) { /* ignore */ }
            } else if (currentEvent === 'tool_call') {
              try {
                const data = JSON.parse(trimmed.slice(6));
                if (data.tool_calls) {
                  assistantToolCalls.push(...data.tool_calls);
                }
              } catch (e) { /* ignore */ }
            } else if (currentEvent === 'error') {
              flushAssistantToHistory();
            } else if (currentEvent === 'compact') {
              try {
                flushAssistantToHistory();
                const compactData = JSON.parse(trimmed.slice(6));
                if (chatHistory) {
                  chatHistory.addMessage(id, 'compact', compactData.summary || '上下文已自动压缩');
                }
              } catch (e) { /* ignore */ }
            } else if (currentEvent === 'compact_error') {
              try {
                flushAssistantToHistory();
                const compactData = JSON.parse(trimmed.slice(6));
                if (chatHistory) {
                  chatHistory.addMessage(id, 'compact_error', compactData.error || '记忆压缩失败');
                }
              } catch (e) { /* ignore */ }
            }
            currentEvent = '';
          } else if (trimmed === '') {
            currentEvent = '';
          }
        }

        pump();
      }).catch(err => {
        logger.error(`SSE 透传错误: ${err.message}`);
        flushAssistantToHistory();
        streamEnded = true;
        streamFinished();
        if (!clientDisconnected) {
          try {
            res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
          } catch (e) { /* stream may be closed */ }
          res.end();
        }
      });
    }
    pump();

  }).catch(err => {
    logger.error(`[SSE] Agent 请求失败: ${err.message}, stack: ${err.stack}`);
    streamEnded = true;
    streamFinished();
    if (!clientDisconnected) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Agent unavailable' })}\n\n`);
      } catch (e) { /* stream may be closed */ }
      res.end();
    }
  });

  // 客户端断开连接时的处理
  res.on('close', () => {
    clientDisconnected = true;
    if (streamEnded && (assistantContent || assistantToolCalls.length > 0)) {
      if (chatHistory) {
        chatHistory.addMessage(id, 'assistant', assistantContent, assistantToolCalls);
      }
      assistantContent = '';
      assistantToolCalls = [];
    }
  });
}