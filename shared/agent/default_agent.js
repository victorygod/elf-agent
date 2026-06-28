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
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Agent {
  /**
   * 从配置目录创建 Agent（推荐入口）
   * 自动完成 Config → Model → ToolRegistry → MessageManager → Agent 的创建
   * config.json 可选声明 agentClass / messageManagerClass 替换默认类
   * @param {string} configDir - 配置目录路径
   * @param {object} [options] - 可选覆盖
   * @param {object} [options.model] - 自定义 model 实例（测试用）
   * @param {object} [options.toolRegistry] - 自定义 toolRegistry 实例（测试用）
   * @param {object} [options.messageManager] - 自定义 messageManager 实例（测试用）
   */
  static async fromConfigDir(configDir, options = {}) {
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

    // 4. 创建 MessageManager（config.json 的 messageManagerClass 可替换实现）
    const dataDir = path.join(configDir, '..', 'data');
    const mmParams = {
      systemPrompt: config.get('systemPrompt') || '',
      memoryTokenLimit: config.get('memoryTokenLimit') || 8000,
      compactSystemPrompt: config.get('compactSystemPrompt') || '',
      compactPrompt: config.get('compactPrompt') || '',
      dataDir,
      config
    };

    let messageManager;
    const mmFile = config.get('messageManagerClass');
    if (mmFile) {
      const MMClass = await Agent._loadModuleClass(mmFile, configDir);
      logger.info(`加载自定义 MessageManager: ${mmFile}`);
      messageManager = new MMClass(mmParams);
    } else {
      messageManager = new MessageManager(mmParams);
    }

    // 5. 创建 Agent（config.json 的 agentClass 可替换实现）
    const agentParams = {
      config,
      model: options.model || model,
      toolRegistry: options.toolRegistry || toolRegistry,
      messageManager: options.messageManager || messageManager,
    };

    let agent;
    const agentFile = config.get('agentClass');
    if (agentFile) {
      const AgentClass = await Agent._loadModuleClass(agentFile, configDir);
      logger.info(`加载自定义 Agent: ${agentFile}`);
      agent = new AgentClass(agentParams);
    } else {
      agent = new Agent(agentParams);
    }

    return agent;
  }

  /**
   * 从文件加载类（查找 agents/{id}/ 目录，回退 shared/agent/）
   * @param {string} fileName - 文件名（不含 .js 后缀）
   * @param {string} configDir - Agent 配置目录
   * @returns {Promise<Function>} 模块中导出的第一个 class/function
   */
  static async _loadModuleClass(fileName, configDir) {
    const candidates = [
      path.join(configDir, '..', fileName + '.js'),  // agents/{id}/{name}.js
      path.join(__dirname, fileName + '.js'),          // shared/agent/{name}.js
    ];
    for (const filePath of candidates) {
      if (fs.existsSync(filePath)) {
        const mod = await import(pathToFileURL(filePath).href);
        const Cls = Object.values(mod).find(v => typeof v === 'function');
        if (Cls) return Cls;
        throw new Error(`文件 "${fileName}.js" 未导出类`);
      }
    }
    throw new Error(`文件 "${fileName}.js" 未找到`);
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
      compactSystemPrompt: this.config.get('compactSystemPrompt'),
      compactPrompt: this.config.get('compactPrompt')
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

      // a. 记忆压缩（循环内，对齐 Claude Code）：在构建 LLM 请求前先压，
      //    保证本轮请求用短历史、不发爆。仅 AbortError 抛出走中断流程；其他失败已被断路器吃掉。
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
        logger.error(`压缩失败: ${err.message}`);
      }

      // b. 构建 LLM 请求
      const messages = await this.messageManager.getMessagesForLLM();
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

        // 工具执行：CC processQueue 语义——isConcurrencySafe=true 的只读工具并发（上限 10），
        // 写工具串行；执行并发、yield 串行（按 tool_call 原序发 status、按原序补 tool_result）。
        // abort 时立刻中断（signal 传工具、主 loop 不等剩余并发 Promise）。
        const MAX_TOOL_USE_CONCURRENCY = parseInt(process.env.MAX_TOOL_USE_CONCURRENCY, 10) || 10;
        const toolExecSignal = this._abortController?.signal;  // 复用当前轮 abortController（工具中断用）

        const isErrorResult = (r) => typeof r === 'string' && (
          r.startsWith('Error:') || r.startsWith('Exit code') ||
          r.startsWith('Permission denied') || r.startsWith('File does not exist') ||
          (r.match && r.match(/is a directory\.?\s*$/))
        );

        // 预解析每个 tool_call
        const parsed = toolCallsResult.map(tc => {
          const toolName = tc.function.name;
          let toolArgs = {};
          try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch (e) { toolArgs = {}; }
          const tool = this.toolRegistry.get(toolName);
          return { tc, toolName, toolArgs, tool, safe: this.toolRegistry.isConcurrencySafe(toolName) };
        });

        // 按 tool_call 原序遍历：连续安全工具并发段 + 写工具串行点
        let idx = 0;
        let abortedHere = false;
        while (idx < parsed.length) {
          const batch = [];
          while (idx < parsed.length && parsed[idx].safe && batch.length < MAX_TOOL_USE_CONCURRENCY) {
            batch.push(parsed[idx]); idx++;
          }

          if (batch.length > 0) {
            // 并发段：先按原序 yield 各 status，再并发执行，结果按原序 addToolResult + tool_result
            for (const item of batch) {
              if (item.tool?.statusEvent) {
                yield { event: 'status', data: { state: item.tool.statusEvent.state, detail: item.tool.statusEvent.detail?.(item.toolArgs) || '' } };
              }
            }
            const results = await Promise.all(batch.map(item =>
              this.toolRegistry.execute(item.toolName, item.toolArgs, toolExecSignal)
            ));
            for (let k = 0; k < batch.length; k++) {
              this.messageManager.addToolResult(batch[k].tc.id, results[k]);
              yield { event: 'tool_result', data: { status: isErrorResult(results[k]) ? 'error' : 'success', message: isErrorResult(results[k]) ? results[k] : undefined } };
              if (this._checkAborted('')) {
                logger.info('用户中断了请求（工具执行后）');
                yield { event: 'aborted', data: {} };
                yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
                abortedHere = true; break;
              }
            }
            if (abortedHere) break;
            continue;
          }

          // 写工具串行点
          const item = parsed[idx]; idx++;
          if (item.tool?.statusEvent) {
            yield { event: 'status', data: { state: item.tool.statusEvent.state, detail: item.tool.statusEvent.detail?.(item.toolArgs) || '' } };
          }
          const result = await this.toolRegistry.execute(item.toolName, item.toolArgs, toolExecSignal);
          this.messageManager.addToolResult(item.tc.id, result);
          yield { event: 'tool_result', data: { status: isErrorResult(result) ? 'error' : 'success', message: isErrorResult(result) ? result : undefined } };
          if (this._checkAborted('')) {
            logger.info('用户中断了请求（工具执行后）');
            yield { event: 'aborted', data: {} };
            yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
            abortedHere = true; break;
          }
        }

        if (abortedHere) return;

        continue;
      } else {
        this.messageManager.addAssistantMessage(fullContent);
        break;
      }
    }

    if (maxIterations > 0 && iteration >= maxIterations) {
      yield { event: 'error', data: { message: 'Max iterations reached' } };
    }

    // d. 循环后兜底压缩：loop 退出（break 纯文本回复 / 达 maxIterations）后，
    //    若最后一轮累积的消息超阈值而循环内没压到（如纯文本长回复 break 前顶部不超、回复后超），
    //    在 done 前补压一次。compactIfNeeded 内部不超阈值即 return，无副作用。
    this._abortController = new AbortController();
    try {
      yield* this.messageManager.compactIfNeeded(this.model, { signal: this._abortController.signal });
      this._abortController = null;
    } catch (err) {
      this._abortController = null;
      if (err.name === 'AbortError' || this._aborted) {
        logger.info('用户中断了请求（兜底压缩期间）');
        yield { event: 'compact_abort', data: {} };
        yield { event: 'aborted', data: {} };
        yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
        return;
      }
      logger.error(`兜底压缩失败: ${err.message}`);
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