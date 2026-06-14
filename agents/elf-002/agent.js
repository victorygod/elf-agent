/**
 * Agent 核心 — Intuitive + Reasoning
 */

import { createLogger } from '../../shared/logger.js';

let logFileName = null;

export function setAgentLogFileName(name) {
  logFileName = name;
}

export class Agent {
  constructor({ config, model, toolRegistry, messageManager }) {
    this.config = config;
    this.model = model;
    this.toolRegistry = toolRegistry;
    this.messageManager = messageManager;
  }

  /**
   * Intuitive 层入口
   */
  async *receive(message) {
    yield* this.reasoning(message);
  }

  /**
   * Reasoning 层 / Agent Loop
   */
  async *reasoning(message) {
    const logger = createLogger('agent', logFileName);

    // 1. 将消息追加到历史
    this.messageManager.addUserMessage(message);

    const maxIterations = this.config.get('maxIterations') || 5;
    let iteration = 0;

    // 2. Agent Loop
    while (iteration < maxIterations) {
      iteration++;

      // a. 构建 LLM 请求
      const messages = this.messageManager.getMessagesForLLM();
      const tools = this.toolRegistry.getAll();

      // 记录发送给 LLM 的 messages
      logger.info(`LLM Request [第${iteration}轮] messages: ${JSON.stringify(messages, null, 2)}`);

      // b. 调用 LLM（流式）
      yield { event: 'status', data: { state: 'thinking' } };

      let fullContent = '';
      let toolCallsResult = null;

      try {
        for await (const chunk of this.model.chat(messages, tools)) {
          if (chunk.type === 'token') {
            fullContent += chunk.content;
            yield { event: 'token', data: { content: chunk.content } };
          } else if (chunk.type === 'tool_calls') {
            toolCallsResult = chunk.tool_calls;
          }
        }
      } catch (err) {
        logger.error(`LLM 调用失败: ${err.message}`);
        yield { event: 'error', data: { message: `LLM API error: ${err.message}` } };
        yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
        return;
      }

      // 记录 LLM 返回结果
      if (toolCallsResult && toolCallsResult.length > 0) {
        logger.info(`LLM Response [第${iteration}轮] tool_calls: ${JSON.stringify(toolCallsResult, null, 2)}`);
      } else {
        logger.info(`LLM Response [第${iteration}轮] content: ${fullContent}`);
      }

      // c. 解析响应
      if (toolCallsResult && toolCallsResult.length > 0) {
        this.messageManager.addAssistantToolCalls(toolCallsResult);

        for (const tc of toolCallsResult) {
          const toolName = tc.function.name;
          let toolArgs = {};
          try {
            toolArgs = JSON.parse(tc.function.arguments || '{}');
          } catch (e) {
            toolArgs = {};
          }

          yield {
            event: 'status',
            data: { state: 'tool_call', detail: `正在执行工具: ${toolName}` }
          };

          if (toolName === 'read_file') {
            yield {
              event: 'status',
              data: { state: 'reading_file', detail: `正在读取 ${toolArgs.path || ''}` }
            };
          }

          const result = await this.toolRegistry.execute(toolName, toolArgs);
          this.messageManager.addToolResult(tc.id, result);
        }

        continue;
      } else {
        this.messageManager.addAssistantMessage(fullContent);
        break;
      }
    }

    if (iteration >= maxIterations) {
      yield { event: 'error', data: { message: 'Max iterations reached' } };
    }

    // d. 记忆压缩
    if (this.messageManager.estimateTokens() > this.messageManager.memoryTokenLimit) {
      yield { event: 'compact_start', data: {} };
      try {
        const summary = await this.messageManager.compactIfNeeded(this.model);
        if (summary) {
          yield { event: 'compact', data: { summary: summary.substring(0, 100) } };
        }
      } catch (err) {
        yield { event: 'compact_error', data: { error: err.message || '记忆压缩失败' } };
      }
    }

    // e. done
    const tokenEstimate = this.messageManager.estimateTokens();
    yield {
      event: 'done',
      data: { usage: { prompt_tokens: tokenEstimate, completion_tokens: 0 } }
    };
  }

  updateModel(newModel) {
    this.model = newModel;
  }

  updateMessageManagerConfig(configUpdate) {
    this.messageManager.updateConfig(configUpdate);
  }
}