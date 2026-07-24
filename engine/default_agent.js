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

import { createLogger } from '../shared/logger.js';
const defaultLogger = createLogger('default-agent');
import { Config } from './config_loader.js';
import { LLMModel } from './llm_model.js';
import { MockModel } from './mock_model.js';
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
    this.messageManager._eventSink = (event, data) => this._emit(event, data);
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
   * 私聊/群聊都经场景插件（_scene）的 preReceive 决策，统一走 action:'buffer' + flushLoop。
   *   私聊 PrivateChatPlugin：flushNow = !_replying（空闲即 flush）。
   *   群聊 RoomPlugin：flushNow = mention 命中。
   * 兼容: 纯字符串 / 非 chat role → 直接 reasoning（子 agent 内部调用、Room 非 chat 转发）。
   */
  async receive(message, options = {}) {
    const emit = options.emit || (() => {});
    // 场景插件是 agent 属性（this._scene），_mw 直接合 agent-level + 场景（无状态）。
    //   {role:'chat'} 消息必须经场景插件的 preReceive 决策（私聊 PrivateChatPlugin/群聊 RoomPlugin），
    //   无场景插件 → 抛错，不退化（生产 start.js 必注入；测试注对应场景插件）。
    try {
      if (message && typeof message === 'object' && message.role === 'chat' && message.content != null) {
        const gate = await this._dispatchGate('preReceive', null, message);
        if (gate == null) {
          throw new Error('receive(chat): 无场景插件（_scene 为空）——私聊必注 PrivateChatPlugin、群聊必注 RoomPlugin');
        }
        // 统一 buffer 编排路径：场景插件 preReceive 决策 drop/pending/buffer，flushNow 决定是否进 flushLoop。
        await this._runInjection('onRoomEnter');
        this.syncSource?.advance(gate.seq);
        if (gate.action === 'buffer' && gate.flushNow) {
          // run-level：本次请求临时注入工具/中间件/disableTools，reasoning 结束（或异常）自动还原。
          //   flushLoop 内 reasoning 读 toolManager.getAll(view) 走请求级视图，结束 restore。
          const restore = this._enterRunLevel(options);
          try {
            const scene = this._scene;
            if (scene && typeof scene.flushLoop === 'function') await scene.flushLoop(emit);
            else this.abortFlow.emitDone(emit);
          } finally {
            restore();
          }
        } else {
          // drop / pending / buffer(不立即 flush)：本轮不发 reasoning，emit done 收尾。
          this.abortFlow.emitDone(emit);
        }
        return;
      }
      // 非 chat（纯字符串/子 agent 内部调用）：直接 reasoning，不需场景插件。
      //   同样支持 run-level 工具注入（子 agent 调用可带工具）。
      const restore = this._enterRunLevel(options);
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

  /**
   * 进入一次 run-level 请求：注册临时工具、设请求级禁用集、并入临时 middleware；返回还原函数。
   *   - options.tools：临时追加到 toolManager（同名覆盖静态），请求结束注销/恢复，不影响其它请求/room。
   *   - options.disableTools：负向过滤（本请求不给某些基础工具），随请求清理，不需把基础工具全转 run-level。
   *   - options.middleware：本次请求临时横切 middleware，并入 _mw 链（用临时数组包裹注入），结束弹栈。
   * 场景插件可对 tools 做裁剪门控（filterRunLevelTools，默认透传）。
   * @returns {() => void} 还原函数（清理临时工具/disable/middleware）。
   */
  _enterRunLevel(options = {}) {
    const restoreFns = [];
    // 工具：场景插件裁剪门控 → 临时注册（同名覆盖）
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      const scene = this._scene;
      const filtered = (scene && typeof scene.filterRunLevelTools === 'function')
        ? scene.filterRunLevelTools(options.tools)
        : options.tools;
      if (filtered.length > 0) {
        restoreFns.push(this.toolManager.registerRunLevel(filtered));
      }
    }
    // 负向过滤：设请求级禁用集（toolManager.getAll 用）
    if (Array.isArray(options.disableTools) && options.disableTools.length > 0) {
      const prevDisabled = this.toolManager._activeDisabled || null;
      const newDisabled = new Set();
      if (prevDisabled) for (const n of prevDisabled) newDisabled.add(n);
      for (const n of options.disableTools) newDisabled.add(n);
      this.toolManager._activeDisabled = newDisabled;
      restoreFns.push(() => { this.toolManager._activeDisabled = prevDisabled; });
    }
    // 临时 middleware：并入 middleware 链，请求结束弹栈
    if (Array.isArray(options.middleware) && options.middleware.length > 0) {
      const startLen = this.middlewares.length;
      for (const m of options.middleware) this.middlewares.push(m);
      restoreFns.push(() => { this.middlewares.length = startLen; });
    }
    return () => { for (const fn of restoreFns) fn(); };
  }

  // v3：flush 循环归场景插件 ScenePlugin.flushLoop；基类 receive 只找引用 + 调。
  //   私聊/群聊统一 buffer 模式，不再有 action:'private' 特判直推。

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
    // 场景插件是 agent 属性（this._scene），_mw 直接合 agent-level + 场景（无状态）。
    //   所有 call site（receive/reasoning/flushLoop 直调）自动一致——场景总在，无漏设/覆盖。

    // 1. skill 清单注入（opt-in + 门控 + 热更新：每轮入口重扫，纯新增推增量、删除/改动推修正清单）。
    //    位置：在用户输入之前（对齐 CC：isMeta 消息位于用户输入之前、历史之后）。
    this.skillLister?.inject();

    // preReason 注入型 middleware 点：每轮入口顺序执行（addUserMessage 之前，位于上一轮 tool_result 与本轮 user 之间）。
    await this._runInjection('preReason', this.messageManager);

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

      // b. 构建 LLM 请求
      const messages = await this.messageManager.getMessagesForLLM();
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
        if (await this._dispatchGate('shouldBreakAfterTools', null, toolCallsResult) === true) {
          break;
        }

        continue;
      } else {
        this.messageManager.addAssistantMessage(fullContent);
        // 门控 onAssistantContent：返回 {break:true} → break；{break:false, injectReminder} → 注入提醒 continue。
        const r = await this._dispatchGate('onAssistantContent', null, fullContent);
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

  updateModel(newModel) {
    this.model = newModel;
  }

  updateMessageManagerConfig(configUpdate) {
    this.messageManager.updateConfig(configUpdate);
  }

  // ============================================================
  // middleware 调度（委托 Harness）
  // ============================================================

  /**
   * 注入型 middleware 点：所有 provider 按注册序顺序执行，效果累积，无返回值。
   * 用途：preReason（改 prompt / 注册工具 / roster 刷新 / skill 清单 / detectChangedFiles）。
   * @param {string} point - middleware 方法名（如 'preReason'）
   * @param  {...any} args - 透传给各 provider 的参数
   */
  /**
   * 当前生效的 middleware 集：agent-level（this.middlewares）+ 场景（this._scene）。
   *   无状态——直接合两个稳定来源，不靠临时 _activeMiddleware（避免漏设/覆盖丢场景）。
   *   场景是 agent 属性（start.js 注入），所有 call site（receive/reasoning/flushLoop 直调）自动一致。
   */
  get _mw() {
    return [...this.middlewares, ...(this._scene ? [this._scene] : [])];
  }

  async _runInjection(point, ...args) {
    return this.harness.runInjection(this._mw, point, ...args);
  }

  /**
   * 门控型 middleware 点：链式执行，按点位的合并语义归并各 provider 返回值。
   * acc 初始为 null（≡ 无 provider 接管 → 调用方走默认）。每个 provider 收到前序 acc，
   * 自行决定是否改写（返回新值）或放行（返回 null/undefined，等价于 acc 不变）。
   * 合并语义由调用方按点位解释 acc（OR / first-wins / first-action-wins / merge），本方法只做链式递进。
   * @param {string} point - middleware 方法名
   * @param {*} initAcc - 初始累积值（通常 null）
   * @param  {...any} args - 透传给各 provider 的参数（在 initAcc 之后）
   * @returns {*} 归并后的 acc；null 表示无人接管
   */
  async _dispatchGate(point, initAcc, ...args) {
    return this.harness.dispatchGate(this._mw, point, initAcc, ...args);
  }

  /**
   * callback 事件总线：fan-out 给所有 handler，handler 异常自吞（不阻断）。
   * handler 方法名 = 'on' + 事件名首字母大写（如 compact → onCompact）。
   * observer-only，不改 reasoning 产出流；当前承载后台异步 compact 完成通知。
   * @param {string} event - 事件名（如 'compact'）
   * @param {*} payload - 事件数据
   */
  _emit(event, payload) {
    this.harness.emit(this.callbacks, event, payload);
  }
}