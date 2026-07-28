/**
 * Harness —— 无状态机制调度器（agent 的"引擎室"）
 *
 * 收口原 default_agent 的 dispatchInjection / dispatchGate / emit / abort 四套机制（agent 直调，无私有转发方法）。
 * 设计为**无状态**：不持 middlewares / callbacks / agent，每次调用收参数跑。
 *   - agent-level middleware / callbacks 存 agent 自己（this.agentLevel / this.callbacks）；
 *   - run-level middleware 每次 invoke 传；合并 [agentLevel, runLevel] 后传进来。
 *   - 这样 Harness 定位单一（只调度、不持有），避免"持状态对象 + 无状态调度"的定位模糊。
 *
 * 与 LangChain 对照：middleware / callback 只声明 hook、**不自己调度**；调度是机制层职责。
 *   LangChain 藏在 create_agent 编译产物里，ELF 显式成 Harness 类（但 ELF 不要 create_agent 工厂，
 *   Harness 由 Agent constructor 内部 new）。
 */

import { createLogger } from '../shared/logger.js';

let logFileName = null;
export function setHarnessLogFileName(name) { logFileName = name; }

export class Harness {
  /**
   * 注入型 middleware 点：所有 provider 按注册序顺序执行，效果累积，无返回值。
   * 用途：preReason（改 prompt / 注册工具 / roster / skill / detectChangedFiles）、onRoomEnter。
   * @param {Array} middlewares - 本次跑的 middleware 数组（调用方合并 agent-level + run-level 后传入）
   * @param {string} point - middleware 方法名（如 'preReason'）
   * @param  {...any} args - 透传给各 provider 的参数
   */
  async runInjection(middlewares, point, ...args) {
    for (const m of middlewares || []) {
      if (m && typeof m[point] === 'function') {
        await m[point](...args);
      }
    }
  }

  /**
   * 门控型 middleware 点：链式执行，按点位的合并语义归并各 provider 返回值。
   * acc 初始为 null（≡ 无 provider 接管 → 调用方走默认）。每个 provider 收到前序 acc，
   * 自行决定是否改写（返回新值）或放行（返回 null/undefined，等价于 acc 不变）。
   * 合并语义由调用方按点位解释 acc（OR / first-wins / first-action-wins / merge），本方法只做链式递进。
   * @param {Array} middlewares - 本次跑的 middleware 数组
   * @param {string} point - middleware 方法名
   * @param {*} initAcc - 初始累积值（通常 null）
   * @param  {...any} args - 透传给各 provider 的参数（在 initAcc 之后）
   * @returns {*} 归并后的 acc；null 表示无人接管
   */
  async dispatchGate(middlewares, point, initAcc, ...args) {
    let acc = initAcc;
    for (const m of middlewares || []) {
      if (m && typeof m[point] === 'function') {
        const val = await m[point](acc, ...args);
        if (val !== undefined && val !== null) acc = val;
      }
    }
    return acc;
  }

  /**
   * callback 事件总线：fan-out 给所有 handler，handler 异常自吞（不阻断）。
   * handler 方法名 = 'on' + 事件名首字母大写（compact → onCompact / compact_error → onCompactError）。
   * observer-only，不改 reasoning 产出流；承载后台异步 compact 完成通知（→ /events）。
   * @param {Array} callbacks - handler 数组（agent 持有，传入）
   * @param {string} event - 事件名（如 'compact'）
   * @param {*} payload - 事件数据
   */
  emit(callbacks, event, payload) {
    if (!callbacks || callbacks.length === 0) return;
    const methodName = 'on' + event
      .split('_')
      .map(seg => seg.charAt(0).toUpperCase() + seg.slice(1))
      .join('');
    for (const h of callbacks) {
      if (h && typeof h[methodName] === 'function') {
        try {
          h[methodName].call(h, payload);
        } catch (e) {
          // 异常自吞：handler 失效不应影响 agent 主流程与其它 handler。记日志但不抛。
          const logger = createLogger('agent-callback', logFileName);
          logger.error(`callback handler "${methodName}" 异常: ${e.message}`);
        }
      }
    }
  }

  /**
   * 中断当前请求：中止当前在跑的段（AbortController）+ 后台压缩。
   * 无状态——收 agent 参数，操作其字段（_aborted / _currentAbortController / messageManager）。
   * 与 dispatchGate 收 middlewares 同形态（机制层控制面）。
   * @param {object} agent - 被中断的 agent
   */
  abort(agent) {
    agent._aborted = true;
    if (agent._currentAbortController) {
      agent._currentAbortController.abort();   // 中止当前段（LLM/compact/tool/兜底），工具 signal 透传杀子进程
    }
    if (agent.messageManager && typeof agent.messageManager.abortBackgroundCompact === 'function') {
      agent.messageManager.abortBackgroundCompact();
    }
  }

  // ---- run-level 作用域：三件覆盖的 setup/teardown（机制层控制面，无自有状态）----
  //  无状态约定：tools/disabled 借 toolManager 入参操作（工具注册表归 ToolManager）；
  //             middleware 借传入的数组操作（中间件归 agent，harness 只做 push/pop 机制）。
  //  全部 run-level 逻辑收口于 withRunLevel，agent 不写 run-level 代码。
  //  runScoped 包 try/finally 保证异常也还原。

  /**
   * 进入一次 run-level 请求作用域：注册临时工具、设请求级禁用集、并入临时 middleware，返回 restore。
   *   机制层总入口：agent.receive 直接调本方法拿 restore，用 runScoped 包请求体。
   *   无自有状态：toolManager / middlewares 数组均由调用方传入，harness 借它们做覆盖。
   * @param {object} opts
   * @param {object} opts.toolManager - 工具注册表（借入参操作）
   * @param {Array} opts.middlewares - agent 的 this.middlewares（借入参 push/pop）
   * @param {Array<object>} [opts.tools] - 临时工具（同名覆盖静态）
   * @param {Iterable<string>} [opts.disableTools] - 本请求禁用工具名
   * @param {Array} [opts.middleware] - 临时 middleware
   * @param {(tools:Array)=>Array} [opts.filterTools] - 工具裁剪函数（场景插件 filterRunLevelTools，默认透传）
   * @returns {() => void} restore（清理临时工具/disable/middleware）
   */
  withRunLevel({ toolManager, middlewares, tools, disableTools, middleware, filterTools } = {}) {
    const restoreFns = [];
    if (toolManager && Array.isArray(tools) && tools.length > 0) {
      const filtered = typeof filterTools === 'function' ? filterTools(tools) : tools;
      if (filtered.length > 0) restoreFns.push(toolManager.registerRunLevel(filtered));
    }
    if (toolManager && Array.isArray(disableTools) && disableTools.length > 0) {
      restoreFns.push(toolManager.withDisabled(disableTools));
    }
    if (Array.isArray(middlewares) && Array.isArray(middleware) && middleware.length > 0) {
      const startLen = middlewares.length;
      for (const m of middleware) middlewares.push(m);
      restoreFns.push(() => { middlewares.length = startLen; });
    }
    return () => { for (const fn of restoreFns) fn(); };
  }

  /**
   * 执行一段 fn，保证 restore 在 fn 结束（含异常）后调用。run-level 作用域的 try/finally 括号。
   * @param {() => void} restore - 还原函数
   * @param {() => Promise<any>|any} fn - 请求体
   * @returns {Promise<any>|any} fn 的返回值
   */
  async runScoped(restore, fn) {
    try { return await fn(); }
    finally { if (typeof restore === 'function') restore(); }
  }
}
