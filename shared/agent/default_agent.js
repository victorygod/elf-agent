/**
 * DefaultAgent — 默认 Agent 实现
 *
 * 经典 Agent Loop：调 LLM → 解析响应 → 执行工具 → 再调 LLM → 直到得到文本回复 → 压缩记忆
 * - 工具 status 事件和 tool_call 摘要从工具元数据（statusEvent / callSummary）读取，不硬编码工具名
 * - compactIfNeeded 为 generator，压缩逻辑内聚到 MessageManager
 * - fromConfigDir() 从配置目录自动创建 Model / ToolRegistry / MessageManager
 * - reloadConfig() 热更新 model 和 messageManager
 *
 * 可被自定义 Agent 类继承或替换，放在 agents/<id>/ 下
 */

import path from 'path';
import { createLogger } from '../logger.js';
import { Config } from './config_loader.js';
import { LLMModel } from './llm_model.js';
import { MockModel } from './mock_model.js';
import { ToolRegistry } from './tools/registry.js';
import * as allTools from './tools/index.js';
import { MessageManager } from './message_manager.js';

let logFileName = null;

export function setAgentLogFileName(name) {
  logFileName = name;
}

export class Agent {
  /**
   * 从配置目录创建 Agent（推荐入口）
   * 自动完成 Config → Model → ToolRegistry → MessageManager → Agent 的创建
   * @param {string} configDir - 配置目录路径
   * @param {object} [options] - 可选覆盖
   * @param {object} [options.model] - 自定义 model 实例（测试用）
   * @param {object} [options.toolRegistry] - 自定义 toolRegistry 实例（测试用）
   * @param {object} [options.messageManager] - 自定义 messageManager 实例（测试用）
   */
  static fromConfigDir(configDir, options = {}) {
    const logger = createLogger('agent-init', logFileName);

    // 1. 加载配置
    const config = new Config(configDir);
    config.load();

    // 2. 创建 Model
    const modelConfig = config.getModelConfig();
    let model;
    if (modelConfig.provider === 'mock') {
      model = new MockModel();
    } else {
      model = new LLMModel(modelConfig);
    }

    // 3. 创建 ToolRegistry — 从 tools/index.js 动态获取可用工具
    const toolRegistry = new ToolRegistry();
    const toolNames = config.get('tools');
    if (Array.isArray(toolNames)) {
      for (const name of toolNames) {
        const tool = allTools[name];
        if (tool) {
          toolRegistry.register(tool);
          logger.info(`注册工具: ${name}`);
        } else {
          logger.warn(`未知工具: ${name}，跳过`);
        }
      }
    } else {
      logger.warn('config.json 未指定 tools 字段，注册所有可用工具');
      for (const [name, tool] of Object.entries(allTools)) {
        toolRegistry.register(tool);
      }
    }

    // 4. 创建 MessageManager
    const dataDir = path.join(configDir, '..', 'data');
    const messageManager = new MessageManager({
      systemPrompt: config.get('systemPrompt') || '',
      memoryTokenLimit: config.get('memoryTokenLimit') || 8000,
      prefixPrompt: config.get('prefix_prompt') || '',
      suffixPrompt: config.get('suffix_prompt') || '',
      dataDir
    });

    return new Agent({
      config,
      model: options.model || model,
      toolRegistry: options.toolRegistry || toolRegistry,
      messageManager: options.messageManager || messageManager,
    });
  }

  /**
   * 直接构造 Agent
   * @param {object} params
   * @param {Config} params.config - 配置实例
   * @param {object} params.model - LLM 模型实例
   * @param {ToolRegistry} params.toolRegistry - 工具注册表
   * @param {MessageManager} params.messageManager - 消息管理器
   */
  constructor({ config, model, toolRegistry, messageManager }) {
    this.config = config;
    this.model = model;
    this.toolRegistry = toolRegistry;
    this.messageManager = messageManager;
    this._abortController = null;   // 当前 LLM 请求的 AbortController
    this._aborted = false;          // 本轮 reasoning 是否被中断
  }

  /** 外部调用：中断当前请求 */
  abort() {
    this._aborted = true;
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  /**
   * 热更新配置（配置文件变化时调用）
   * 重新加载 config，然后更新 model 和 messageManager
   */
  reloadConfig() {
    const logger = createLogger('agent', logFileName);
    this.config.load();

    // 更新 Model
    const modelConfig = this.config.getModelConfig();
    if (modelConfig.provider === 'mock') {
      this.model = new MockModel();
    } else {
      this.model = new LLMModel(modelConfig);
    }

    // 更新 MessageManager
    this.messageManager.updateConfig({
      systemPrompt: this.config.get('systemPrompt'),
      memoryTokenLimit: this.config.get('memoryTokenLimit'),
      prefixPrompt: this.config.get('prefix_prompt'),
      suffixPrompt: this.config.get('suffix_prompt')
    });

    logger.info('配置热加载完成');
  }

  /**
   * Intuitive 层入口
   */
  async *receive(message) {
    yield* this.reasoning(message);
  }

  /**
   * 检查是否被中断，如果被中断则保留已生成的内容
   * @returns {boolean} 是否被中断
   */
  _checkAborted(fullContent) {
    if (!this._aborted) return false;
    if (fullContent) this.messageManager.addAssistantMessage(fullContent);
    return true;
  }

  /**
   * Reasoning 层 / Agent Loop
   */
  async *reasoning(message) {
    const logger = createLogger('agent', logFileName);
    this._aborted = false;

    // 1. 将消息追加到历史
    this.messageManager.addUserMessage(message);

    const maxIterations = this.config.get('maxIterations') ?? 5;
    let iteration = 0;

    // 2. Agent Loop（maxIterations ≤ 0 时无限迭代）
    while (maxIterations <= 0 || iteration < maxIterations) {
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

      this._abortController = new AbortController();
      try {
        for await (const chunk of this.model.chatStream(messages, tools, { signal: this._abortController.signal })) {
          if (this._aborted) break;
          if (chunk.type === 'token') {
            fullContent += chunk.content;
            yield { event: 'token', data: { content: chunk.content } };
          } else if (chunk.type === 'tool_calls') {
            toolCallsResult = chunk.tool_calls;
          }
        }
      } catch (err) {
        this._abortController = null;
        if (err.name === 'AbortError' || this._aborted) {
          if (this._checkAborted(fullContent)) {
            yield { event: 'aborted', data: {} };
            yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
            return;
          }
          // 如果没有内容但被中断
          yield { event: 'aborted', data: {} };
          yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
          return;
        }
        logger.error(`LLM 调用失败: ${err.message}`);
        yield { event: 'error', data: { message: `LLM API error: ${err.message}` } };
        yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
        return;
      }
      this._abortController = null;

      // 中断检查（LLM 流正常结束后也可能已被 abort）
      if (this._checkAborted(fullContent)) {
        logger.info('用户中断了请求');
        yield { event: 'aborted', data: {} };
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

        // 构建工具调用摘要 — 从工具元数据读取 callSummary
        const toolCallsSummary = toolCallsResult.map(tc => {
          const toolName = tc.function.name;
          let toolArgs = {};
          try {
            toolArgs = JSON.parse(tc.function.arguments || '{}');
          } catch (e) {
            toolArgs = {};
          }
          const tool = this.toolRegistry.get(toolName);
          const entry = { name: toolName, args: toolArgs };
          if (tool?.callSummary) {
            entry.description = tool.callSummary(toolArgs);
          }
          return entry;
        });

        // 发出 tool_call 事件（前端用于渲染工具调用标记）
        yield {
          event: 'tool_call',
          data: { tool_calls: toolCallsSummary }
        };

        for (const tc of toolCallsResult) {
          const toolName = tc.function.name;
          let toolArgs = {};
          try {
            toolArgs = JSON.parse(tc.function.arguments || '{}');
          } catch (e) {
            toolArgs = {};
          }
          const tool = this.toolRegistry.get(toolName);

          // 发射 status 事件 — 从工具元数据读取 statusEvent
          if (tool?.statusEvent) {
            yield {
              event: 'status',
              data: {
                state: tool.statusEvent.state,
                detail: tool.statusEvent.detail?.(toolArgs) || '',
              },
            };
          }

          // 执行工具
          const result = await this.toolRegistry.execute(toolName, toolArgs);
          this.messageManager.addToolResult(tc.id, result);

          // 发送工具执行结果状态
          const isError = typeof result === 'string' && (
            result.startsWith('Error:') ||
            result.startsWith('Exit code') ||
            result.startsWith('Permission denied') ||
            result.startsWith('File does not exist') ||
            (result.match && result.match(/is a directory\.?\s*$/))
          );
          yield {
            event: 'tool_result',
            data: {
              status: isError ? 'error' : 'success',
              message: isError ? result : undefined
            }
          };

          // 工具执行后检查中断
          if (this._checkAborted('')) {
            logger.info('用户中断了请求（工具执行后）');
            yield { event: 'aborted', data: {} };
            yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
            return;
          }
        }

        continue;
      } else {
        this.messageManager.addAssistantMessage(fullContent);
        break;
      }
    }

    if (maxIterations > 0 && iteration >= maxIterations) {
      yield { event: 'error', data: { message: 'Max iterations reached' } };
    }

    // d. 记忆压缩 — compactIfNeeded 为 generator，触发条件和成功事件内聚到 MM
    this._abortController = new AbortController();
    try {
      yield* this.messageManager.compactIfNeeded(this.model, { signal: this._abortController.signal });
      this._abortController = null;
    } catch (err) {
      this._abortController = null;
      if (err.name === 'AbortError' || this._aborted) {
        logger.info('用户中断了请求（压缩期间）');
        yield { event: 'compact_abort', data: {} };
        yield { event: 'aborted', data: {} };
        yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
        return;
      }
      yield { event: 'compact_error', data: { error: err.message || '记忆压缩失败' } };
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