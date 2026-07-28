/**
 * Agent —— 默认 Agent 实现（业务编排层）
 *
 * 经典 Agent Loop：调 LLM → 解析响应 → 执行工具 → 再调 LLM → 直到得到文本回复 → 压缩记忆
 * - 工具 status 事件和 tool_call 摘要从工具元数据（statusEvent / callSummary）读取，不硬编码工具名
 * - 压缩逻辑内聚到 MessageManager；中断/收尾在 AbortFlow；middleware/callback 调度在 Harness
 * - 装配入口：agents/<id>/create_agent.js 显式建器官 + 调 buildAgentFromConfig（engine/build_agent.js）
 * - reloadConfig() 热更新 model 和 messageManager
 *
 * 可被自定义 Agent 类继承或替换，放在 agents/<id>/ 下（最后手段；优先 config/middleware/mm 子类）
 */

import { SyncSource } from './sync_source.js';
import { AbortFlow, setAbortFlowLogFileName } from './abort_flow.js';
import { Harness, setHarnessLogFileName } from './harness.js';
import { PromptAssembler } from './prompt/index.js';
import { sendNotice } from './notice.js';

import { createLogger } from '../shared/logger.js';
const defaultLogger = createLogger('default-agent');
import { Config } from './config_loader.js';
import { LLMModel, MockModel } from './models/index.js';
import { MessageManager } from './message_manager.js';

let logFileName = null;

export function setAgentLogFileName(name) {
  logFileName = name;
  setAbortFlowLogFileName(name);
  setHarnessLogFileName(name);
}

export class Agent {
  // 装配入口已移出：agents/<id>/create_agent.js 显式建器官 + 调 buildAgentFromConfig（engine/build_agent.js）
  //   完成 model/toolManager/skillLister/fileChangeDetection 装配 + new Agent。不再 fromConfigDir 反射。

  /**
   * 直接构造 Agent（业务编排核心 + 一行委托控制接口）。
   * @param {object} params
   * @param {Config} params.config - 配置实例
   * @param {object} params.model - LLM 模型实例
   * @param {ToolManager} params.toolManager - 工具管理器
   * @param {MessageManager} params.messageManager - 消息管理器（已实例化，由 create_agent.js 传入）
   * @param {object} [params.runContext] - 运行时身份
   */

  /**
   * 直接构造 Agent
   * @param {object} params
   * @param {Config} params.config - 配置实例
   * @param {object} params.model - LLM 模型实例
   * @param {ToolManager} params.toolManager - 工具管理器（注册表 + 编排，ToolManager 实例）
   * @param {MessageManager} params.messageManager - 消息管理器
   */
  constructor({ config, model, toolManager, messageManager, runContext = null }) {
    this.config = config;
    this.model = model;
    this.toolManager = toolManager;
    this.messageManager = messageManager;
    // ToolManager 的 executeBatch 需用 messageManager.addToolResult 落后端 history，注入引用。
    if (this.toolManager && typeof this.toolManager._setMessageManager === 'function') {
      this.toolManager._setMessageManager(messageManager);
    }
    // 运行时身份（实例化改造第三层，见 run_context.js + docs §10.2）。
    // null=私聊默认形态（向后兼容：现有 new Agent({config,model,toolManager,messageManager}) 无此参）。
    // startAgent 私聊路径会显式注入 buildPrivateRunContext；副本注入 room 形态。
    this.runContext = runContext;
    this._currentAbortController = null;  // 当前在跑段的 AbortController（任意时刻最多一个，串行）；
                                          // abort() abort 它即中止当前段（LLM/compact/tool/兜底），工具 signal 透传杀子进程
    this._aborted = false;          // 本轮 reasoning 是否被中断

    // skill 支持（opt-in，默认未启用）。对齐 CC `mhY` 门控：
    // null 表示本 agent 不支持 skill，reasoning 入口守卫短路，零开销、零清单注入。
    // skillLister 由 buildAgentFromConfig 在 config.json 含 "skills": true 时实例化并 enable()。
    this.skillLister = null;        // SkillLister 实例（null=未启用）

    // 消息同步源（私聊用）。惰性构建：_gatewayUrl 由 start.js 在构造后注入，
    // 故在 receive 首次调用时经 _ensureSyncSource() 建好。null=未建/私聊 dataDir 缺失 → align 短路。
    this.syncSource = null;

    this.abortFlow = new AbortFlow({ messageManager });
    this.abortFlow._setAgent(this);

    this.middlewares = [];
    this.callbacks = [];
    this.harness = new Harness();
    this.promptAssembler = new PromptAssembler();
    this.messageManager._setPromptAssembler?.(this.promptAssembler);
    this.messageManager._eventSink = (event, data) => this.harness.emit(this.callbacks, event, data);
  }

  /** 外部调用：中断当前请求。委托 Harness（机制层控制面），操作本 agent 字段。 */
  abort() {
    this.harness.abort(this);
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
   * Intuitive 层入口（v3 统一 buffer 模式）。
   * 私聊/群聊都经场景插件（_scene）的 preReceive 决策，统一走 action:'buffer' + 内联 flush 循环。
   *   私聊 PrivateChatPlugin：flushNow = !_replying（空闲即 flush）。
   *   群聊 RoomPlugin：flushNow = mention 命中。
   * 兼容: 纯字符串 / 非 chat role → 直接 reasoning（子 agent 内部调用、Room 非 chat 转发）。
   */
  async receive(message, options = {}) {
    const emit = options.emit || (() => {});
    // 场景插件是 agent 属性（this._scene），效中间件就地展开 agent-level + 场景（无状态）。
    //   {role:'chat'} 消息必须经场景插件的 preReceive 决策（私聊 PrivateChatPlugin/群聊 RoomPlugin），
    //   无场景插件 → 抛错，不退化（生产 start.js 必注入；测试注对应场景插件）。
    try {
      if (message && typeof message === 'object' && message.role === 'chat' && message.content != null) {
        const gate = await this.harness.dispatchGate([...this.middlewares, ...(this._scene ? [this._scene] : [])], 'preReceive', null, message);
        if (gate == null) {
          throw new Error('receive(chat): 无场景插件（_scene 为空）——私聊必注 PrivateChatPlugin、群聊必注 RoomPlugin');
        }
        // 统一 buffer 编排路径：场景插件 preReceive 决策 drop/pending/buffer，flushNow 决定是否进内联 flush 循环。
        await this.harness.runInjection([...this.middlewares, ...(this._scene ? [this._scene] : [])], 'onRoomEnter');
        this.syncSource?.advance(gate.seq);
        if (gate.action === 'buffer' && gate.flushNow) {
          // buffer flush 循环：merge→addUser→reasoning→postReason，while shouldFlush()。
          //   preReceive 已设 scene._currentTrigger；_runFlushLoop 收尾调 scene.onFlushDone（重置观测窗口）。
          //   run-level 临时工具注入（options.tools/disableTools）由 _runFlushLoop 经 withRunLevel 处理。
          await this._runFlushLoop({ emit, tools: options.tools, disableTools: options.disableTools, middleware: options.middleware });
        } else {
          // drop / pending / buffer(不立即 flush)：本轮不发 reasoning，emit done 收尾。
          this.abortFlow.emitDone(emit);
        }
        return;
      }
      // 非 chat（纯字符串/子 agent 内部调用）：直接 reasoning，不需场景插件。
      //   同样支持 run-level 工具注入（子 agent 调用可带工具）。run-level 逻辑归 harness.withRunLevel。
      const restore = this.harness.withRunLevel({
        toolManager: this.toolManager,
        middlewares: this.middlewares,
        tools: options.tools,
        disableTools: options.disableTools,
        middleware: options.middleware,
      });
      try {
        await this.reasoning(message, { emit });
      } finally {
        restore();
      }
    } catch (err) {
      const logger = createLogger('agent', logFileName);
      logger.error(`receive 失败: ${err.message}`);
      this.abortFlow.emitError(emit, err.message || '服务器内部错误');
      this.abortFlow.emitDone(emit);
    }
  }

  // v3：flush 循环内联于 receive 的 chat 分支（merge→addUser→reasoning→postReason，while shouldFlush）。
  //   run-level 作用域（临时工具/禁用/middleware 的 setup-restore）归 Harness.withRunLevel，agent 不写 run-level 逻辑。
  //   私聊/群聊统一 buffer 模式，不再有 action:'private' 特判直推。

  /**
   * 复用的 buffer flush 循环。receive(chat, flushNow) 与 triggerRoomFlush(观测窗口到期) 共用。
   * 每轮：mergeForReason→addUserMessage→reasoning→postReason，while scene.shouldContinue()。
   * 收尾调 scene.onFlushDone（观测式重置窗口起算点 + 重 arm timer）。
   *
   * @param {object} opts
   * @param {Function} [opts.emit] - 事件出口
   * @param {Array} [opts.tools] - run-level 临时工具（receive options 透传）
   * @param {Array} [opts.disableTools] - run-level 禁用工具
   * @param {Array} [opts.middleware] - run-level 临时 middleware
   * @param {string} [opts.trigger] - 触发来源（'mention'|'observe'），设 scene._currentTrigger；缺省不覆盖
   */
  async _runFlushLoop({ emit, tools, disableTools, middleware, trigger } = {}) {
    emit = emit || (() => {});
    const scene = this._scene;
    if (!scene) { this.abortFlow.emitDone(emit); return; }
    if (trigger && typeof scene.setCurrentTrigger === 'function') scene.setCurrentTrigger(trigger);
    const mws = [...this.middlewares, scene];
    const restore = this.harness.withRunLevel({
      toolManager: this.toolManager,
      middlewares: this.middlewares,
      tools,
      disableTools,
      middleware,
      filterTools: typeof scene.filterRunLevelTools === 'function'
        ? (ts) => scene.filterRunLevelTools(ts) : undefined,
    });
    let ranReasoning = false;
    try {
      let merged;
      while ((merged = await this.harness.dispatchGate(mws, 'mergeForReason', null)) && merged.trim()) {
        ranReasoning = true;
        scene.replying(true);
        this.messageManager.addUserMessage(merged);
        try {
          await this.reasoning(null, { skipAddUser: true, emit });
        } finally {
          scene.replying(false);
          await this.harness.dispatchGate(mws, 'postReason', null);
        }
        if (!scene.shouldContinue()) break;
      }
    } finally {
      restore();
    }
    if (!ranReasoning) this.abortFlow.emitDone(emit);
    if (typeof scene.onFlushDone === 'function') scene.onFlushDone();
  }

  /**
   * 观测式自驱动触发：窗口到期时由 RoomPlugin 定时器调用，不经 /observe 直接进 flush 循环。
   * 复核 scene.shouldFlushObserve（buffer 非空 ∧ 窗口到期 ∧ !replying），不满足静默返回。
   * @param {string} [reason='observe'] - 触发来源，设 scene._currentTrigger 决定门控阈值
   * @param {object} [options] - { emit? } 测试注入用；生产默认走 agent._pushEvent（/events 转发）
   */
  async triggerRoomFlush(reason = 'observe', options = {}) {
    const scene = this._scene;
    if (!scene || typeof scene.shouldFlushObserve !== 'function') return;
    if (!scene.shouldFlushObserve()) return;   // 复核：防重复触发、buffer 已空
    const emit = options.emit || ((e) => this._pushEvent?.(e.event, e.data));
    await this._runFlushLoop({ emit, trigger: reason });
  }

  /**
   * Reasoning 层 / Agent Loop
   * 主 agent 经 receive → reasoning，事件经 emit 推送给前端（callback 模式）。
   * 子 agent（subAgent 工程）也复用本方法：由 Agent 工具 execute 消费、吞掉中间事件、取最终文本。
   *
   * @param {*} message - 用户消息（string）。群聊 RoomMiddleware 已在 preReceive 累积过时传 null/undefined。
   * @param {object} [opts]
   * @param {boolean} [opts.skipAddUser=false] - 跳过开头 addUserMessage（RoomMiddleware 已在 preReceive 累积,防双份）。
   */
  async reasoning(message, opts = {}) {
    const emit = opts.emit || (() => {});
    const logger = createLogger('agent', logFileName);
    this._aborted = false;
    // 场景插件是 agent 属性（this._scene），效中间件就地展开 agent-level + 场景（无状态）。
    //   所有 call site（receive 内联 flush 循环/reasoning 直调）自动一致——场景总在，无漏设/覆盖。

    // 1. skill 清单注入（opt-in + 门控 + 热更新：每轮入口重扫，纯新增推增量、删除/改动推修正清单）。
    //    位置：在用户输入之前（对齐 CC：isMeta 消息位于用户输入之前、历史之后）。
    this.skillLister?.inject();

    // preReason 注入型 middleware 点：每轮入口顺序执行（addUserMessage 之前，位于上一轮 tool_result 与本轮 user 之间）。
    await this.harness.runInjection([...this.middlewares, ...(this._scene ? [this._scene] : [])], 'preReason', this.messageManager);

    // 2. 将消息追加到历史（RoomMiddleware 已在 preReceive 累积过则跳过,防双份）。
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
      const cr = await this.abortFlow.runAborable(
        { reason: 'compact', onError: 'continue' },
        (signal, ev) => this.messageManager.runCompact(this.model, {
          signal,
          onEvent: ev,
          onDone: () => this.skillLister?.reinvokeAfterCompact(),
        }),
        emit,
      );
      if (cr.aborted) {
        logger.info('用户中断了请求（压缩期间）');
        return;
      }
      // cr.errored=true 时续循环（不 return）——内部已 log，落 LLM 请求构建

      // b. 构建 LLM 请求：base（mm 产）→ PromptAssembler 三点位拼装（prefix/suffix/roster/listing/群聊行为）
      const messages = this.promptAssembler.assemble(this.messageManager.getBaseForLLM(), { agent: this, messageManager: this.messageManager });
      const tools = this.toolManager.getAll();

      // 记录发送给 LLM 的 messages
      logger.info(`LLM Request [第${iteration}轮] messages: ${JSON.stringify(messages, null, 2)}`);

      // b. 调用 LLM（流式）——chatStream 经 onChunk 推 chunk，reasoning onChunk 内转 emit
      //   await onChunk 传递背压（chatStream 内 await onChunk；emit 主流写 SSE 未 drain 则等）
      emit({ event: 'status', data: { state: 'thinking' } });

      // LLM 流段经 runAborable（与 compact/tool-exec 段同构）：中断 → chatStream 抛 AbortError（带 partial）
      //   → runAborable catch → finishAborted（含类型B 已生成内容保留）。非 abort 异常外层 catch 出 error+done。
      // onChunk 纯传输：只 emit token，不累加（content/toolCalls 由 model 聚合、随 return 带出，对齐 LangChain on_llm_end）。
      let fullContent = '';
      let toolCallsResult = null;
      // LLM 流段：不可恢复异常（API 错误）由 runAborable 原样上抛 → receive 顶层统一兜底 emit error+done。
      // 中断 → runAborable catch → finishAborted（含类型B 内容保留）。本段不写 try/catch。
      const r = await this.abortFlow.runAborable(
        { reason: 'llm-stream' },
        async (signal) => {
          const res = await this.model.chatStream(messages, tools, {
            signal,
            onChunk: (chunk) => {
              if (chunk.type === 'token') emit({ event: 'token', data: { content: chunk.content } });
            },
            onRetry: (info) => sendNotice(
              { emit, runContext: this.runContext },
              {
                kind: info.final ? 'error' : 'retry',
                agentId: this.runContext?.agentId,
                memberName: this.runContext?.memberName,
                attempt: info.attempt,
                maxRetries: info.maxRetries,
                error: String(info.error?.message || info.error || ''),
                final: info.final === true,
              },
            ),
          });
          return res;   // { content, toolCalls } —— model 聚合
        },
        emit,
      );
      if (r.aborted) {
        logger.info('用户中断了请求（LLM 流期间）');
        return;
      }
      fullContent = r.value.content;
      toolCallsResult = r.value.toolCalls && r.value.toolCalls.length > 0 ? r.value.toolCalls : null;

      // 记录 LLM 返回结果
      if (toolCallsResult && toolCallsResult.length > 0) {
        logger.info(`LLM Response [第${iteration}轮] tool_calls: ${JSON.stringify(toolCallsResult, null, 2)}`);
      } else {
        logger.info(`LLM Response [第${iteration}轮] content: ${fullContent}`);
      }

      // c. 解析响应
      if (toolCallsResult && toolCallsResult.length > 0) {
        this.messageManager.addAssistantToolCalls(toolCallsResult);

        // 发出 tool_call 事件（前端用于渲染工具调用标记）— 摘要由 toolManager.summarize 生成
        // （从工具元数据读 callSummary；与 executeBatch 共享解析，调用参数容错逻辑单一来源）
        emit({ event: 'tool_call', data: { tool_calls: this.toolManager.summarize(toolCallsResult) } });

        // 工具执行：委托 toolManager.executeBatch（CC processQueue 语义——只读并发上限 10、写串行、
        // status/tool_result 经 emit 推）。executeBatch 中断时抛 AbortError，由 abortFlow.runAborable
        // 的 catch 接管收尾（与 compact 段同构）；signal 透传工具（杀 Bash 子进程），abort() abort _currentAbortController。
        const r = await this.abortFlow.runAborable(
          { reason: 'tool-exec' },
          (signal, ev) => this.toolManager.executeBatch(toolCallsResult, {
            signal,
            emit: ev,
            isAborted: () => this._aborted,
            ctx: { agent: this },
          }),
          emit,
        );
        if (r.aborted) {
          logger.info('用户中断了请求（工具执行后）');
          return;
        }

        // 门控 shouldBreakAfterTools：任一 middleware 返回 true → break（OR 合并）。
        if (await this.harness.dispatchGate([...this.middlewares, ...(this._scene ? [this._scene] : [])], 'shouldBreakAfterTools', null, toolCallsResult) === true) {
          break;
        }

        continue;
      } else {
        this.messageManager.addAssistantMessage(fullContent);
        // 门控 onAssistantContent：返回 {break:true} → break；{break:false, injectReminder} → 注入提醒 continue。
        const r = await this.harness.dispatchGate([...this.middlewares, ...(this._scene ? [this._scene] : [])], 'onAssistantContent', null, fullContent);
        if (r && r.injectReminder) {
          this.messageManager.addMetaMessage(r.injectReminder, 'speak_reminder');
          continue;   // 注入提醒，再来一轮给 LLM 调 Speak 的机会
        }
        break;   // 默认 / r.break / 已达阈值放弃 → 退出 loop
      }
    }

    if (maxIterations > 0 && iteration >= maxIterations) {
      this.abortFlow.emitError(emit, 'Max iterations reached');
    }

    // d. 循环后兜底压缩：loop 退出（break 纯文本回复 / 达 maxIterations）后，
    //    若最后一轮累积的消息超阈值而循环内没压到（如纯文本长回复 break 前顶部不超、回复后超），
    //    在 done 前补压一次。compactIfNeeded 内部不超阈值即 return，无副作用。
    // d. 循环后兜底压缩：可恢复异常 onError:'continue'（内部 log、续到 done）。
    const r = await this.abortFlow.runAborable(
      { reason: 'compact-bottom', onError: 'continue' },
      (signal, ev) => this.messageManager.runCompact(this.model, {
        signal,
        onEvent: ev,
        onDone: () => this.skillLister?.reinvokeAfterCompact(),
      }),
      emit,
    );
    if (r.aborted) {
      logger.info('用户中断了请求（兜底压缩期间）');
      return;
    }

    // e. done
    const tokenEstimate = this.messageManager.estimateTokens();
    this.abortFlow.emitDone(emit, { promptTokens: tokenEstimate });
  }

  // ============================================================
  // middleware 调度（直调 Harness，无私有方法转发）
  // ============================================================
  // agent 不持 dispatch/injection/emit 的封装方法，调用点直接调 this.harness.* 就地展开
  //   效中间件 = [...this.middlewares, ...(this._scene ? [this._scene] : [])]，每次显式写。
  //   this.harness.runInjection(mws, point, ...args)        注入型（无返回，效果累积）
  //   this.harness.dispatchGate(mws, point, initAcc, ...args) 门控型（链式归并 acc）
  //   this.harness.emit(this.callbacks, event, payload)     callback 总线（异常自吞）
}