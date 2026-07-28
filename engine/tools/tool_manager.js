/**
 * ToolManager — 工具注册表 + 工具编排（合并自 ToolRegistry）
 *
 * 职责：
 *  - 工具注册/查询/单工具执行（原 ToolRegistry 的 register/get/getAll/execute/isConcurrencySafe）
 *  - 批次工具编排 executeBatch（CC processQueue 语义：连续 isConcurrencySafe=true 的只读工具并发上限 10，
 *    写工具串行；混合批次里只读工具并发跑完才跑写工具）
 *
 * 设计：executeBatch 是 generator，status/tool_result 事件由它 yield、reasoning `yield*` 接力
 * （走 /chat SSE 流，前端时序零 diff）。ToolManager 不持有 eventSink、不碰 /events 通道。
 * abort 采用软中止：每条 tool_result 后由传入的 isAborted() 检查，命中则设 aborted 标志退出；
 * signal 透传给工具，供 Bash 等工具按需杀子进程。不持有 abortFlow——中止后由调用方收尾。
 */

const MAX_TOOL_USE_CONCURRENCY = parseInt(process.env.MAX_TOOL_USE_CONCURRENCY, 10) || 10;

// 工具结果是否视为错误（决定 tool_result 事件 status=error/success）
const isErrorResult = (r) => typeof r === 'string' && (
  r.startsWith('Error:') || r.startsWith('Exit code') ||
  r.startsWith('Permission denied') || r.startsWith('File does not exist') ||
  (r.match && r.match(/is a directory\.?\s*$/))
);

export class ToolManager {
  constructor(options = {}) {
    this.tools = new Map();
    this._messageManager = options.messageManager || null;
  }

  /** 注入 messageManager（由 Agent constructor 在持齐引用后回填，executeBatch 用它落 history） */
  _setMessageManager(mm) {
    this._messageManager = mm;
  }

  /**
   * 注册工具
   * @param {object} tool - 工具定义 { name, description, parameters, execute }
   */
  register(tool) {
    this.tools.set(tool.name, tool);
  }

  /**
   * 获取工具
   */
  get(name) {
    return this.tools.get(name);
  }

  /**
   * 获取所有工具定义（用于 LLM tools 参数）。
   * run-level 临时覆盖：被 _disabled 遮蔽的静态工具不返回；run-level 临时工具（_runLevel）
   *   已 register 覆盖同名静态工具（Map 同 key 去重），故 getAll 天然只返回一份。
   * @param {object} [view] - 视图过滤器（run-level 请求用）：{ disabled:Set<string> }
   *   不传则用 this._activeDisabled（由 runLevelScope 设置的请求级禁用集）。
   */
  getAll(view) {
    const disabled = (view && view.disabled) || this._activeDisabled || null;
    const out = [];
    for (const [name, tool] of this.tools) {
      if (disabled && disabled.has(name)) continue;
      out.push(tool);
    }
    return out;
  }

  /**
   * run-level 工具注入：注册本次请求专用的临时工具，返回还原函数（请求结束调）。
   *   - 同名覆盖静态工具（Map 同 key，注册即覆盖）；
   *   - 记录被覆盖的旧工具，还原时恢复，保证不影响其它请求/其它 room。
   * 典型用法见 Harness.withRunLevel（run-level 作用域总入口）。
   * @param {Array<object>} tools - 临时工具定义
   * @returns {() => void} 还原函数
   */
  registerRunLevel(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return () => {};
    const backups = [];
    const newNames = [];
    for (const tool of tools) {
      const prev = this.tools.get(tool.name);
      if (prev !== undefined) backups.push({ name: tool.name, tool: prev });
      else newNames.push(tool.name);
      this.tools.set(tool.name, tool);
    }
    return () => {
      for (const name of newNames) this.tools.delete(name);
      for (const { name, tool } of backups) this.tools.set(name, tool);
    };
  }

  /**
   * run-level 负向禁用：设本次请求的 _activeDisabled 集，返回还原函数（请求结束调）。
   *   getAll(view) 不传 view 时读 _activeDisabled 跳过被禁工具；不动 Map。
   *   收口原 Agent._enterRunLevel 里直接戳 _activeDisabled 私有字段的逻辑，由 ToolManager 自管。
   * @param {Iterable<string>} names - 本请求禁用的工具名
   * @returns {() => void} 还原函数
   */
  withDisabled(names) {
    if (!names) return () => {};
    const prevDisabled = this._activeDisabled || null;
    const newDisabled = new Set();
    if (prevDisabled) for (const n of prevDisabled) newDisabled.add(n);
    for (const n of names) newDisabled.add(n);
    this._activeDisabled = newDisabled;
    return () => { this._activeDisabled = prevDisabled; };
  }

  /**
   * 执行工具
   * @param {string} name - 工具名称
   * @param {object} args - 工具参数
   * @param {AbortSignal} [signal] - 中断信号（并发执行时传，工具按需检查/Bash 杀子进程）
   * @param {object} [ctx] - 工具上下文 { agent } 主 agent 引用（Agent 工具用，其他工具忽略）
   * @returns {Promise<string>} 工具执行结果
   */
  async execute(name, args, signal, ctx) {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[错误: 工具 "${name}" 不存在]`;
    }
    try {
      return await tool.execute(args, signal, ctx);
    } catch (err) {
      return `[工具执行错误: ${err.message}]`;
    }
  }

  /**
   * 工具是否并发安全（isConcurrencySafe 字段，默认 false）
   */
  isConcurrencySafe(name) {
    const tool = this.tools.get(name);
    return tool?.isConcurrencySafe === true;
  }

  /**
   * 解析单个 tool_call：name / args（JSON.parse 容错回退 {}）/ tool 引用 / safe 标志。
   * executeBatch 与 summarize 共用此方法，保证两处解析逻辑不漂移。
   * @private
   */
  _parseToolCall(tc) {
    const toolName = tc.function.name;
    let toolArgs = {};
    try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch (e) { toolArgs = {}; }
    const tool = this.get(toolName);
    return { tc, toolName, toolArgs, tool, safe: this.isConcurrencySafe(toolName) };
  }

  /**
   * 构建工具调用摘要（供前端 tool_call 事件渲染工具调用标记）。
   * 从工具元数据读 callSummary 生成描述；纯计算，不执行、不 yield。
   * @param {Array} toolCallsResult - LLM 返回的 tool_calls 数组
   * @returns {Array<{name:string, args:object, description?:string}>}
   */
  summarize(toolCallsResult) {
    return toolCallsResult.map(tc => {
      const { toolName, toolArgs, tool } = this._parseToolCall(tc);
      const entry = { id: tc.id, name: toolName, args: toolArgs };
      if (tool?.callSummary) {
        entry.description = tool.callSummary(toolArgs);
      }
      return entry;
    });
  }

  /**
   * 批次工具编排（CC processQueue 语义）。普通 async + emit callback：
   *   连续 isConcurrencySafe=true 的只读工具并发上限 10，写工具串行。
   *   事件经 emit 推送：status（工具开始）/ tool_result（工具完成，含 id 供前端按 id 匹配）。
   *   tool_result 逐个完成即推（不锁原序到达）；addToolResult 仍按 tool_call 原序落 history（保 LLM 顺序）。
   *   中断：软中止，每条 tool_result 后由 isAborted() 检查，命中则抛 AbortError 由调用方收尾。
   *
   * @param {Array} toolCallsResult - LLM 返回的 tool_calls 数组
   * @param {object} options
   * @param {AbortSignal} [options.signal] - 当前轮 abortController.signal（传给工具，Bash 杀子进程用）
   * @param {() => boolean} options.isAborted - 返回 _aborted 状态（调用方注入，避免持 agent 引用）
   * @param {object} [options.ctx] - 工具上下文 { agent }（传给工具，Agent 工具需要主 agent 引用）
   * @param {(event:object) => void|Promise<void>} [options.emit] - 事件推送 callback
   * @returns {Promise<{aborted:boolean}>}
   */
  async executeBatch(toolCallsResult, options = {}) {
    const signal = options.signal;
    const isAborted = options.isAborted || (() => false);
    const ctx = options.ctx || {};
    const emit = options.emit || (() => {});

    // 预解析每个 tool_call（与 summarize 共用 _parseToolCall，解析逻辑单一来源）
    const parsed = toolCallsResult.map(tc => this._parseToolCall(tc));
    const mm = this._messageManager;

    // status 事件辅助：按 tool_call 原序发该工具的开始状态
    const emitStatus = (item) => {
      if (item.tool?.statusEvent) {
        emit({ event: 'status', data: { state: item.tool.statusEvent.state, detail: item.tool.statusEvent.detail?.(item.toolArgs) || '' } });
      }
    };
    // tool_result 事件辅助：完成即推，payload 带 id 供前端按 id 匹配（到达顺序不限原序）
    const emitToolResult = (item, result) => {
      const isErr = isErrorResult(result);
      emit({
        event: 'tool_result',
        data: { id: item.tc.id, status: isErr ? 'error' : 'success', message: isErr ? result : undefined },
      });
    };

    // 按 tool_call 原序遍历：连续安全工具并发段 + 写工具串行点
    let idx = 0;
    while (idx < parsed.length) {
      const batch = [];
      while (idx < parsed.length && parsed[idx].safe && batch.length < MAX_TOOL_USE_CONCURRENCY) {
        batch.push(parsed[idx]); idx++;
      }

      if (batch.length > 0) {
        // 并发段：先按原序发各 status，再并发执行。
        //   每个任务完成即 emit tool_result（逐个即推，到达顺序不限原序）。
        //   addToolResult 按原序落 history：各任务把结果存入 results[k]（原序位），统一等完后按原序落盘。
        for (const item of batch) emitStatus(item);
        const results = new Array(batch.length);
        let aborted = false;
        await Promise.all(batch.map(async (item, k) => {
          const result = await this.execute(item.toolName, item.toolArgs, signal, ctx);
          results[k] = result;                       // 原序位存结果
          emitToolResult(item, result);              // 完成即推（谁先完成谁先 emit）
          if (isAborted()) aborted = true;
        }));
        // history 按原序落盘（保 LLM 看到的 tool_result 顺序 = tool_call 顺序）
        for (let k = 0; k < batch.length; k++) {
          mm?.addToolResult(batch[k].tc.id, results[k]);
        }
        if (aborted) {
          throw new DOMException('aborted', 'AbortError');  // 中断：抛 AbortError，调用方（runAborable）catch 接管
        }
        continue;
      }

      // 写工具串行点
      const item = parsed[idx]; idx++;
      emitStatus(item);
      const result = await this.execute(item.toolName, item.toolArgs, signal, ctx);
      mm?.addToolResult(item.tc.id, result);
      emitToolResult(item, result);
      if (isAborted()) {
        throw new DOMException('aborted', 'AbortError');
      }
    }
    return { aborted: false };
  }
}