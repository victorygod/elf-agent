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
import { SkillRegistry } from './skills/registry.js';

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
    // options.dataDir 注入（实例化改造）：缺省回退现状 configDir/..，私聊零回归
    const dataDir = options.dataDir || path.join(configDir, '..', 'data');

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
    // dataDir 已在 step1 由 options.dataDir 注入（缺省回退 configDir/..，私聊零回归）
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
    // options.runContext 注入运行时身份（实例化改造第三层）。缺省 null→私聊默认形态，向后兼容。
    const agentParams = {
      config,
      model: options.model || model,
      toolRegistry: options.toolRegistry || toolRegistry,
      messageManager: options.messageManager || messageManager,
      runContext: options.runContext || null,
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

    // opt-in：config.json 声明 "skills": true 才启用 skill 支持
    // 对齐 CC `mhY` 门控——未启用则 _skillRegistry 恒为 null，reasoning 入口守卫短路，零开销
    if (config.get('skills') === true) {
      agent._enableSkills(process.cwd());
      logger.info('已启用 skill 支持');
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
  constructor({ config, model, toolRegistry, messageManager, runContext = null }) {
    this.config = config;
    this.model = model;
    this.toolRegistry = toolRegistry;
    this.messageManager = messageManager;
    // 运行时身份（实例化改造第三层，见 run_context.js + docs §10.2）。
    // null=私聊默认形态（向后兼容：现有 new Agent({config,model,toolRegistry,messageManager}) 无此参）。
    // startAgent 私聊路径会显式注入 buildPrivateRunContext；副本注入 room 形态。
    this.runContext = runContext;
    this._abortController = null;   // 当前 LLM 请求的 AbortController
    this._aborted = false;          // 本轮 reasoning 是否被中断

    // skill 支持（opt-in，默认未启用）。对齐 CC `mhY` 门控：
    // 三字段为 null 表示本 agent 不支持 skill，reasoning 入口守卫短路，零开销、零清单注入。
    // 由 _enableSkills() 初始化为真实结构。
    this._skillRegistry = null;     // SkillRegistry 实例（null=未启用）
    this._pushedSkills = null;      // Set<string> 增量去重（对齐 CC nT6，会话常驻、compact/rewind 不清）
    this._invokedSkills = null;     // 已触发 skill 全文记录（对齐 $O6），供 compact 恢复
  }

  /** 外部调用：中断当前请求（同时中止 LLM 请求和后台压缩） */
  abort() {
    this._aborted = true;
    if (this._abortController) {
      this._abortController.abort();
    }
    // 中止可能正在运行的后台记忆压缩
    if (this.messageManager && typeof this.messageManager.abortBackgroundCompact === 'function') {
      this.messageManager.abortBackgroundCompact();
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
   * 检查是否被中断，如果被中断则保留已生成的内容
   * @returns {boolean} 是否被中断
   */
  _checkAborted(fullContent) {
    if (!this._aborted) return false;
    if (fullContent) this.messageManager.addAssistantMessage(fullContent);
    return true;
  }

  /**
   * Intuitive 层入口
   */
  async *receive(message) {
    yield* this.reasoning(message);
  }

  /**
   * Reasoning 层 / Agent Loop
   * 主 agent 经 receive → reasoning 流式 yield 事件给前端。
   * 子 agent（subAgent 工程）也复用本方法：由 Agent 工具 execute 消费、吞掉中间事件、取最终文本。
   *
   * @param {*} message - 用户消息（string）。群聊 RoomAgent 已在 receive 累积过时传 null/undefined。
   * @param {object} [opts]
   * @param {boolean} [opts.skipAddUser=false] - 跳过开头 addUserMessage（RoomAgent 已在 receive 累积,防双份）。
   */
  async *reasoning(message, opts = {}) {
    const logger = createLogger('agent', logFileName);
    this._aborted = false;
    // room 模式 Speak 门控计数（问题1）：收到本组消息后，纯 content(不调 Speak) 的累计次数。
    // 每轮 reasoning 入口重置为 0——一次被 @ 的回应里第1次 content 注入提醒、第2次仍不调 Speak 才退出。
    this._speakAttempts = 0;

    // 1. skill 清单注入（opt-in + 门控 + 热更新：每轮入口重扫，纯新增推增量、删除/改动推修正清单）。
    //    位置：在用户输入之前（对齐 CC：isMeta 消息位于用户输入之前、历史之后）。
    this._injectSkillListing();

    // 2. 将消息追加到历史（RoomAgent 已在 receive 累积过则跳过,防双份）。
    if (!opts.skipAddUser && message != null) {
      this.messageManager.addUserMessage(message);
    }

    const maxIterations = this.config.get('maxIterations') ?? 5;
    let iteration = 0;

    // 2. Agent Loop（maxIterations ≤ 0 时无限迭代）
    while (maxIterations <= 0 || iteration < maxIterations) {
      iteration++;

      // a. 记忆压缩（循环内，对齐 Claude Code）：在构建 LLM 请求前先压，
      //    保证本轮请求用短历史、不发爆。仅 AbortError 抛出走中断流程；其他失败已被断路器吃掉。
      //    不再调用 getCompactHappened()，改由监听 compact 事件（与后台模式统一）。
      this._abortController = new AbortController();
      let compactDone = false;
      try {
        for await (const event of this.messageManager.compactIfNeeded(this.model, { signal: this._abortController.signal })) {
          yield event;
          if (event.event === 'compact') {
            compactDone = true;
          }
        }
        // compact 完成后重推系统注入消息
        if (compactDone) {
          await this._reinjectMetaMessages();
        }
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
              this.toolRegistry.execute(item.toolName, item.toolArgs, toolExecSignal, { agent: this })
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
          const result = await this.toolRegistry.execute(item.toolName, item.toolArgs, toolExecSignal, { agent: this });
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

        // 群聊模式:Speak 工具一旦执行(发言已完成),本轮就该结束——不再让 LLM 继续 loop
        // 调别的工具或再 Speak(避免同一轮多次发言 / 发完言还瞎调工具)。
        if (this.runContext?.mode === 'room' &&
            toolCallsResult.some(tc => tc.function?.name === 'Speak')) {
          break;
        }

        continue;
      } else {
        this.messageManager.addAssistantMessage(fullContent);
        // room 模式 Speak 门控（问题1）：content 群里没人能看见，不调 Speak = 没说话。
        // 第1次纯 content → 注入 role:user system-reminder 提醒，continue 再来一轮给 LLM 调 Speak 的机会；
        // 第2次仍不调 Speak（仍纯 content 或调了别的工具到此）→ 放弃，退出 loop。
        // 门控仅在 room 模式且注册了 Speak 时生效（私聊/测试用未注册 Speak 的副本不触发，纯 content 立即 break）。
        if (this.runContext?.mode === 'room' && this.toolRegistry.get('Speak')) {
          this._speakAttempts = (this._speakAttempts || 0) + 1;
          if (this._speakAttempts < 2) {
            this.messageManager.addMetaMessage(
              `<system-reminder>\n你刚才输出的文本(content)只在你自己的思考里，群里其他成员/agent 看不到——不调 Speak 就等于没说话。在群聊中公开发言必须调用 Speak 工具(传完整 message)。请现在调用 Speak 工具发言，让群里能看到你的回应。\n</system-reminder>`,
              'speak_reminder'
            );
            continue;   // 再来一轮，给 LLM 调 Speak 的机会
          }
          // 第2次仍不调 → 放弃，退出 loop
        }
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
    let bottomCompactDone = false;
    try {
      for await (const event of this.messageManager.compactIfNeeded(this.model, { signal: this._abortController.signal })) {
        yield event;
        if (event.event === 'compact') {
          bottomCompactDone = true;
        }
      }
      // compact 完成后重推系统注入消息
      if (bottomCompactDone) {
        await this._reinjectMetaMessages();
      }
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

  /**
   * 启用 skill 支持（opt-in 入口）。
   * 由 fromConfigDir() 在 config.json 含 "skills": true 时调用，或子类显式调用。
   * 未调用则三字段保持 null，reasoning 入口守卫短路——本 agent 不产生任何 skill 行为。
   */
  _enableSkills(cwd) {
    this._skillCwd = cwd ?? process.cwd();   // 记住扫描根，入口每轮重扫用
    this._skillRegistry = new SkillRegistry();
    this._skillRegistry.loadAll(this._skillCwd);
    // _pushedSkills 存「已推送过的 skill 签名」(name|desc|whenToUse)，用于增量去重 + 变化检测
    this._pushedSkills = new Set();   // 对齐 CC nT6 精神：会话常驻，compact 不清、rewind 不清
    this._pushedNames = new Set();    // 上次推送时的 visible name 全集，用于检测删除
    this._invokedSkills = [];          // 对齐 $O6：记录已触发 skill 全文，供 compact 恢复
  }

  /**
   * 重置 skill 清单的去重快照（_pushedSkills / _pushedNames）。
   * 语义对齐 CC `Pc()`：清 nT6（已推送记录）。
   * 用途：① 清空记忆（/clear，会话重开）前调；② compact 后重推清单前调——
   *   否则快照还记着"推过了"，下一轮/重推判定"无变化"→ 不推 → skill 从上下文蒸发。
   * **不清 _invokedSkills**：触发记录会话级累积，对齐 CC $O6，compact 不清（下次 compact 仍能重推 invoked_skills）。
   *   清空（会话重开）由 /clear 路由单独清 _invokedSkills。
   * 注意：rewind（reloadFromDisk）不调本方法——回退对话点≠会话重开，对齐 CC。
   */
  _resetSkillPushState() {
    if (this._pushedSkills) this._pushedSkills.clear();
    if (this._pushedNames) this._pushedNames.clear();
  }

  /**
   * 入口 skill 清单注入（重扫 + 增量/修正推送）。
   * reasoning 入口每轮调；/clear 清空后调一次，让空 messages 立即重含 listing，
   * 不必等用户发下一条消息才补——清空=会话重开，会话一开就该有 skill 清单在场。
   * 门控：仅当启用了 skill（_skillRegistry 非空）且注册了 Skill 工具才做。
   */
  _injectSkillListing() {
    if (!this._skillRegistry || !this.toolRegistry.get('Skill')) return;
    this._skillRegistry.loadAll(this._skillCwd);   // 热更新重扫
    const listing = this._formatSkillListing();
    if (listing) this.messageManager.addMetaMessage(listing, 'skill_listing');
  }

  /**
   * 生成 skill 清单（L1 注入），增量推送 + 热更新变化检测。
   *
   * 推送策略（每轮入口重扫后调用）：
   *  - 纯新增 skill → 只推增量（对齐 CC mhY 增量），轻
   *  - 有删除或内容改动 → 推一条【全量修正清单】，让模型看到当前完整可见集合，覆盖旧认知
   *  - 无变化 → 返回 ''，不注入
   *  - 首轮（_pushedSkills 空）→ 推全量
   *
   * 说明：旧 listing 消息仍留在历史里（transcript 不可变，对齐 CC），修正清单排在更后位、
   * 模型以后到的为准。compact 发生时不重推清单（对齐 CC），靠 _pushedSkills/_pushedNames 记忆。
   *
   * 单行格式：`- name: desc`，有 whenToUse 追加 ` - whenToUse`；<system-reminder> 包裹；16000 截断兜底。
   * @returns {string}
   */
  _formatSkillListing() {
    if (!this._skillRegistry || !this._pushedSkills) return '';
    if (!this.toolRegistry.get('Skill')) return '';   // 门控：未注册 Skill 工具不产出（对齐 mhY ①）
    const skills = this._skillRegistry.getVisible();

    const sig = s => `${s.name}|${s.description || ''}|${s.whenToUse || ''}`;
    const currentNames = new Set(skills.map(s => s.name));
    const currentSigs = new Set(skills.map(sig));

    // 首轮：推全量
    if (this._pushedSkills.size === 0) {
      return this._emitListing(skills, currentSigs, currentNames, /*full*/ true);
    }

    const removedNames = [...this._pushedNames].filter(n => !currentNames.has(n));   // 被删的
    const newOrChanged = skills.filter(s => !this._pushedSkills.has(sig(s)));         // 新增或内容变
    const hasChange = removedNames.length > 0 || newOrChanged.length > 0;
    if (!hasChange) return '';   // 无变化不推

    // 有删除或内容改动 → 推全量修正（覆盖旧认知）；纯新增 → 推增量
    const full = removedNames.length > 0 || newOrChanged.some(s => this._pushedNames.has(s.name));
    return this._emitListing(full ? skills : newOrChanged, currentSigs, currentNames, full);
  }

  /**
   * 实际拼装并发出一条 listing，同时更新去重快照。
   * @param skills    本次要列出的 skill 数组（全量 or 增量）
   * @param allSigs   当前 visible 全集签名（无论本次列哪些，快照都记全集）
   * @param allNames  当前 visible 全集 name
   * @param full      是否全量（仅用于日志，不影响行为）
   */
  _emitListing(skills, allSigs, allNames, full) {
    if (!skills.length) return '';
    const lines = skills.map(s => {
      const base = `- ${s.name}: ${s.description}`;
      return s.whenToUse ? `${base} - ${s.whenToUse}` : base;
    });
    // 快照更新到当前全集（无论推增量还是全量，都记住"现在可见的全部"）
    this._pushedSkills = allSigs;
    this._pushedNames = allNames;

    let body = lines.join('\n');
    const BUDGET = 16000;
    if (body.length > BUDGET) body = body.slice(0, BUDGET) + '…';
    return `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n${body}\n</system-reminder>`;
  }

  /**
   * compact 后重推系统注入消息。
   *
   * 对齐 CC：compact 后**不重推 skill 清单**（_pushedSkills 未清 → 下一轮入口
   * _formatSkillListing 自然返回空；CC 模型靠 Skill 工具常驻 + 摘要感知可用 skill）。
   * 唯一补的是 `invoked_skills`：本会话已触发过的 skill 正文全文（包 <system-reminder> + isMeta，
   * 对齐 CC dAq → dispatch 走 x5）。
   *
   * 调用时机：compactIfNeeded yield compact 事件后。
   */
  async _reinjectMetaMessages() {
    // compact 把旧 messages（含 skill 清单 isMeta）整体替换成摘要，listing 丢失。
    // 摘要里不一定保留了"有哪些 skill"，elf 没有 CC 那种"工具描述兜底识别"，故补一条全量清单。
    if (this._skillRegistry && this.toolRegistry.get('Skill')) {
      // 重置清单去重快照（_pushedSkills/_pushedNames），再重扫重推全量清单。
      // 不清 _invokedSkills——触发记录会话级累积，对齐 CC $O6，下次 compact 仍能重推。
      this._resetSkillPushState();
      this._skillRegistry.loadAll(this._skillCwd);   // 重扫，确保清单反映当前可见 skill
      const listing = this._formatSkillListing();
      if (listing) this.messageManager.addMetaMessage(listing, 'skill_listing');
    }

    // 重推 invoked_skills（已触发 skill 正文全文，对齐 CC dAq）。
    if (this._invokedSkills && this._invokedSkills.length > 0) {
      const blocks = this._invokedSkills.map(s =>
        `### Skill: ${s.name}\nPath: ${s.path}\n\n${s.contents.join('\n\n')}`
      ).join('\n\n---\n\n');
      const content =
        `<system-reminder>\n` +
        `The following skills were invoked in this session. Continue to follow these guidelines:\n\n` +
        `${blocks}\n` +
        `</system-reminder>`;
      this.messageManager.addMetaMessage(content, 'invoked_skills');
    }
  }
}