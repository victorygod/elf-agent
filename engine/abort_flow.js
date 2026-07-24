import { createLogger } from '../shared/logger.js';

let logFileName = null;
export function setAbortFlowLogFileName(name) { logFileName = name; }

/**
 * AbortFlow —— reasoning 中断后的统一收尾 + 可中断段的生命周期管理
 *
 * 中断检查点（何时被中断）仍归 reasoning 的控制流——只有 reasoning 知道"我刚调完 LLM/工具/压缩，
 * 该检查一下"。但"被中断后怎么收尾"（内容保留 + aborted/done）参差重复，收口到本类的 finishAborted。
 *
 * 此外，reasoning 里"建 controller + 挂 agent 字段 + try/await /catch 分辨 AbortError/finally 清字段"
 * 这套样板（压缩/工具执行等段）反复出现，收口到 runAborable——统一管可中断段的生命周期与中断收尾。
 *
 * 收尾步骤：
 *   1. 收尾压缩气泡：有未决压缩任务（_pendingCompact）→ emit compact_abort（经 mm.abandonPendingCompact）
 *   2. 保留已生成内容：LLM 流中断时已流出的 token 存为 assistant 消息（类型 B）
 *   3. 报中断 + done
 *
 * callback 化后：workFn 是普通 async 函数（接收 signal + emit），runAborable 是普通 async 函数，
 * finishAborted 是同步普通函数（含 mm 副作用）。事件经 emit 推送，不再 yield。
 *
 * 不是独立业务领域——依附 reasoning 的中断点。无门控、每 agent 都建。agent 引用在 agent 构造后回填。
 */

export class AbortFlow {
  /**
   * @param {object} params
   * @param {object} params.messageManager - 用 abandonPendingCompact + addAssistantMessage
   */
  constructor({ messageManager } = {}) {
    this._mm = messageManager;
    this._agent = null;   // agent 引用，由 Agent constructor 在构造后回填（runAborable 用它读/写 controller 字段）
  }

  /** Agent 构造后回填自身引用（与 ToolManager._setMessageManager 同模式，避开自引用循环） */
  _setAgent(agent) {
    this._agent = agent;
  }

  /**
   * 统一中断收尾（同步普通函数，含 mm 副作用）。
   *   1. 放弃未决压缩 → emit compact_abort
   *   2. 保留已生成内容（fullContent 存为 assistant 消息）
   *   3. emit aborted + done
   * 事件顺序由函数体语句序保证（与原 yield 版 L44/51/52 等价）。
   * @param {(event:object)=>void} emit - 事件推送 callback
   * @param {string} reason - 中断原因（日志/备用信号，不影响事件产出）
   * @param {string} [fullContent=''] - 已生成内容（类型 B：LLM 流中断时已流出的 token），有则保留
   */
  finishAborted(emit, reason, fullContent = '') {
    // 1. 收尾压缩气泡（有未决压缩 → emit compact_abort）
    const pc = this._mm?.abandonPendingCompact?.();
    if (pc) {
      emit({ event: 'compact_abort', data: { compactId: pc.compactId } });
    }
    // 2. 中断时保留已生成内容（类型 B：已流出 token 存为 assistant 消息）—— mm 副作用
    if (fullContent) {
      this._mm?.addAssistantMessage(fullContent);
    }
    // 3. 报中断 + done
    emit({ event: 'aborted', data: {} });
    this.emitDone(emit);
    return reason;
  }

  /**
   * 终止/结束事件 helper：集中 done 事件的 usage 构造（全 agent 唯一出口，防散落重复）。
   * @param {(event:object)=>void} emit
   * @param {{promptTokens?:number, completionTokens?:number}} [usage]
   */
  emitDone(emit, { promptTokens = 0, completionTokens = 0 } = {}) {
    emit({ event: 'done', data: { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } } });
  }

  /** 错误事件 helper。@param {(event:object)=>void} emit @param {string} msg */
  emitError(emit, msg) {
    emit({ event: 'error', data: { message: msg } });
  }

  /**
   * 运行一段可中断的工作，统一管 controller 生命周期 + 中断收尾。
   *
   * 替代 reasoning 里"建 controller + 挂字段 + try-await-catch 分辨 AbortError / 清字段 + finishAborted"
   * 这套样板。Controller 挂到 agent 的 _currentAbortController 字段——任意时刻最多一段在跑（串行），
   * agent.abort() 只需 abort 这一个即可中止当前段（含 LLM/compact/tool/兜底，工具 signal 透传杀子进程）。
   *
   * 中断时类型B 内容保留：workFn（LLM 流段）把已聚合内容挂到 AbortError.partial（{content,toolCalls}），
   *   本方法 catch 时取 err.partial.content 喂给 finishAborted 存档。其余段无 partial → 空。
   *
   * @param {object} opts
   * @param {string} opts.reason - 中断原因（传 finishAborted，日志/备用信号）
   * @param {boolean|string|((err:Error)=>(string|'terminate'|Promise<string|'terminate'>))} [opts.onError]
   *        非 abort 异常的可恢复策略（对齐 LangChain handle_parsing_errors：声明式，不写 try/catch）。
   *        不传 → 异常原样抛（不可恢复，调用方上抛到顶层兜底）。
   *        'continue'/true → 记日志续循环（返回 errored:true）。callable → 返回 'terminate' 或上抛则视为终止，
   *        返回 string 则作为 observation log（此处不回灌 LLM，仅记）续循环。
   * @param {(signal:AbortSignal, emit:(e:object)=>void) => Promise<*>} workFn - 要跑的可中断 async 工作（接收 signal+emit，return 值）
   * @param {(event:object)=>void} emit - 事件推送 callback
   * @returns {Promise<{aborted:boolean, value?:*, errored?:boolean}>} aborted=true 已收尾；
   *          errored=true 表示可恢复异常已吞、调用方应续循环；正常则 value 是 workFn return 值。
   */
  async runAborable({ reason, onError } = {}, workFn, emit) {
    const ac = new AbortController();
    this._agent._currentAbortController = ac;
    try {
      const ret = await workFn(ac.signal, emit);
      this._agent._currentAbortController = null;
      return { aborted: false, value: ret };
    } catch (err) {
      this._agent._currentAbortController = null;              // ← 清字段
      if (err.name === 'AbortError' || this._agent._aborted) { // ← 双条件
        const fc = err.partial?.content || '';                 // LLM 流段中断时 model 挂的半成品
        this.finishAborted(emit, reason, fc);                 // emit 收尾三事件（含类型B 保留）
        return { aborted: true };
      }
      // 非 abort 异常：按 onError 策略分流（可恢复声明式，对齐 LangChain handle_parsing_errors）
      if (onError) {
        const log = createLogger('abort-flow', logFileName);
        let terminate = false;
        if (typeof onError === 'function') {
          const r = await onError(err);
          if (r === 'terminate') terminate = true;
          else log.error(`${reason} 失败（observation: ${typeof r === 'string' ? r : ''}）: ${err.message}`);
        } else {
          log.error(`${reason} 失败（续循环）: ${err.message}`);
        }
        if (terminate) { this.emitError(emit, err.message); this.emitDone(emit); return { aborted: true }; }
        return { aborted: false, errored: true };   // 续循环
      }
      throw err;   // 不可恢复：原样上抛，由 receive 顶层兜底 emit error+done
    }
  }
}