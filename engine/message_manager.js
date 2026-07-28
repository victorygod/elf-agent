/**
 * 对话历史管理 + 记忆压缩
 *
 * 管理对话消息数组，持久化到 context.json
 * - compactIfNeeded 支持 blocking / async 两种模式，由 config compactMode 切换
 * - async 模式：后台压缩，期间可继续对话
 * - 保留最近 1 个 group，其余摘要
 *
 * 可被子类继承扩展（如 elf-001/003 的 prefix/suffix 注入，elf-002 的阻塞 override）
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../shared/logger.js';
import { countMessageTokens } from '../shared/tokenizer.js';

let logFileName = null;

export function setLogFileName(name) {
  logFileName = name;
}

// 摘要包装前缀（对齐 Claude Code oF6 摘要包装）
const SUMMARY_PREAMBLE =
  'This session is being continued from a previous conversation that ran out of context. ' +
  'The summary below covers the earlier portion of the conversation.\n\n';

// 续写指令（对齐 CC continuationClause）
const CONTINUATION_CLAUSE =
  'Continue the conversation from where it left off without asking the user any further questions. ' +
  'Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface ' +
  'with "I\'ll continue" or similar. Pick up the last task as if the break never happened.\n\n';

// 断路器：连续压缩失败达到此阈值后禁用自动压缩
const COMPACT_FAIL_THRESHOLD = 3;

// 最小可压缩 token：保留最近 1 个 group 后，老区（将被摘要替换的内容）token 数
// 必须达到此阈值才发起压缩。低于此值压缩得不偿失（摘要可能比原文还长、且损失信息），
// 直接跳过。常量不可配，所有 agent 统一。天然涵盖"单组对话老区为空不压缩"。
// export 供子类（如 elf-002 override compactIfNeeded）复用同一阈值。
export const COMPACT_MIN_SAVINGS = 500;

export class MessageManager {
  /**
   * @param {object} params - 参数对象
   * @param {string} params.systemPrompt
   * @param {number} params.memoryTokenLimit
   * @param {string} params.compactSystemPrompt
   * @param {string} params.compactPrompt
   * @param {string} params.dataDir
   * @param {Config} [params.config] - Config 实例（可选，用于读取 compactMode 等动态配置）
   */
  constructor(params = {}) {
    this.messages = [];
    this.systemPrompt = params.systemPrompt || '';
    this.memoryTokenLimit = params.memoryTokenLimit || 8000;

    // 压缩提示词
    this.compactSystemPrompt = params.compactSystemPrompt || '';
    this.compactPrompt = params.compactPrompt || '';

    // 持久化
    this.dataDir = params.dataDir || null;
    this.contextFile = this.dataDir ? path.join(this.dataDir, 'context.json') : null;

    // Config 实例（用于子类读取 compactMode 等动态配置）
    this._config = params.config || null;

    // 事件出口（compactor 后台压缩完成/失败时推 compact/compact_error 给 Gateway→前端）。
    // 由 agent 构造时注入，等价 pushEvent。缺省 no-op（测试直接构造 mm 时无注入也能跑）。
    // 收口前：agent 在 fromConfigDir 里反挂 mm._onBgCompactDone/_onBgCompactError 两个私有方法。
    this._eventSink = typeof params.eventSink === 'function' ? params.eventSink : null;

    // —— 后台压缩状态 ——

    // —— 后台压缩状态 ——
    this._bgRunning = false;   // 后台任务是否在运行
    this._bgDone = false;      // 后台任务是否已完成（结果待应用）
    this._bgResult = null;     // 后台任务的压缩结果 { summary, anchorId }
    this._bgPromise = null;    // 后台 Promise 引用
    this._bgFailed = false;    // 上一轮后台是否失败（待通知上层）
    this._bgAbortController = null; // 后台压缩的独立 AbortController

    // —— 未决压缩任务（compactId 锚定前端气泡） ——
    // { compactId, attempt } | null。一次"把超阈历史压下来"的目标 = 一个 compactId，
    // 可能经历多次 attempt（仅 elf-002 阻塞重试跨轮复用同 compactId；async 恒 attempt=1）。
    this._pendingCompact = null;

    // —— 断路器 ——
    // 基类拥有断路器：连续 COMPACT_FAIL_THRESHOLD 次失败后禁用自动压缩。
    // 进程内状态，不持久化，重启/rewind 清零。
    this._compactFailCount = 0;
    this._compactDisabled = false;

    // compact 发生标记（兼容旧调用方，优先使用 event 消费）
    this._compactHappened = false;

    // skill 清单注入已迁移至 PromptAssembler（engine/skills/lister.js 注册 useBeforeLastUser 注入器），
    // 本类不再持 skillListing 字段，也不再临注入。

    // 确保目录存在
    if (this.dataDir) {
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
      } catch (err) {
        const logger = createLogger('message_manager', logFileName);
        logger.warn(`创建数据目录失败: ${err.message}`);
      }
    }

    // 启动时从文件加载
    this._load();
  }

  updateConfig(config) {
    if (config.systemPrompt !== undefined) this.systemPrompt = config.systemPrompt;
    if (config.memoryTokenLimit !== undefined) this.memoryTokenLimit = config.memoryTokenLimit;
    if (config.compactSystemPrompt !== undefined) this.compactSystemPrompt = config.compactSystemPrompt;
    if (config.compactPrompt !== undefined) this.compactPrompt = config.compactPrompt;
  }

  // ============ 消息 ID ============

  /** 生成消息 ID: msg_{timestamp}_{random4hex} */
  _genMsgId() {
    return `msg_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  }

  addUserMessage(content, isMeta = false) {
    if (!content || (typeof content === 'string' && !content.trim())) {
      return; // 忽略空消息，防止幽灵空行写入 context
    }
    this.messages.push({ id: this._genMsgId(), role: 'user', content, ...(isMeta ? { isMeta: true } : {}) });
    this._save();

      }

  addMetaMessage(content, tag) {
    this.messages.push({ id: this._genMsgId(), role: 'user', content, isMeta: true, metaTag: tag });
    this._save();
  }

  addAssistantMessage(content) {
    this.messages.push({ id: this._genMsgId(), role: 'assistant', content });
    this._save();
  }

  addAssistantToolCalls(toolCalls) {
    this.messages.push({ id: this._genMsgId(), role: 'assistant', content: null, tool_calls: toolCalls });
    this._save();
  }

  addToolResult(toolCallId, content) {
    this.messages.push({ id: this._genMsgId(), role: 'tool', tool_call_id: toolCallId, content });
    this._save();
  }

  // ============ LLM 交互 ============

  getMessagesForLLM() {
    // 提示词拼装（prefix/suffix/roster/skill listing/群聊行为）由 agent 的 PromptAssembler 在 assemble() 负责。
    // 本方法只产 base（系统提示词 + stripped 历史消息）。equals getBaseForLLM（保留两个名以兼容旧调用点）。
    return this.getBaseForLLM();
  }

  /** 产 base 给 PromptAssembler.assemble 用：[systemMsg, ...stripped messages]（不做任何点位拼装）。 */
  getBaseForLLM() {
    const systemMsg = { role: 'system', content: this.systemPrompt };
    const msgs = this.messages
      .filter(m => m.metaTag !== 'skill_listing')
      .map(m => {
        const { id, isMeta, metaTag, ...rest } = m;
        return rest;
      });
    return [systemMsg, ...msgs];
  }

  /**
   * 估算当前会话 token 数（含 PromptAssembler 注入的 prefix/suffix/roster/listing/群聊行为）。
   * 注入拼装的 content 也算进 token——与实际发 LLM 的口径一致，compact 判定才准。
   * agent 构造后经 _setPromptAssembler 回填 assembler 引用；未回填时退化为只算 base（兼容独立测试用 mm）。
   */
  estimateTokens() {
    const base = this.getBaseForLLM();
    const allMessages = this._promptAssembler
      ? this._promptAssembler.assemble(base, { messageManager: this })
      : base;
    return countMessageTokens(allMessages);
  }

  /** agent 构造后回填 PromptAssembler 引用（供 estimateTokens 含注入内容计数）。 */
  _setPromptAssembler(asm) { this._promptAssembler = asm; }

  // ============ 记忆压缩（双模式） ============

  /**
   * 记忆压缩 — 支持阻塞 / 非阻塞双模式
   *
   * 由 config compactMode 切换：'async'（默认）| 'blocking'
   * - async 模式：后台 fire-and-forget 压缩，yield compact_start 后立即返回，不阻塞对话
   * - blocking 模式：await 压缩完成再 yield compact
   *
   * 调用方：agent 主循环 for await 本方法，消费事件
   */
  async compactIfNeeded(llmModel, options = {}) {
    const emit = options.onEvent || (() => {});
    const logger = createLogger('message_manager', logFileName);
    const _est = this.estimateTokens();
    if (_est <= this.memoryTokenLimit) {
      logger.info(`[compact] tokens=${_est} <= memoryTokenLimit=${this.memoryTokenLimit}，未触发压缩`);
      return;
    }

    // 无 config 或未配 compactMode 时默认 blocking（兼容现有测试和同步行为）
    const async = this._config?.get('compactMode') === 'async';

    // 1. 后台结果已就绪 → apply 并 emit compact / final compact_error，然后停止本轮。
    if (this._bgDone) {
      const handled = await this._handleReadyBgResult(emit);
      if (handled) return;   // apply 成功 或 final error → 退出
      // 结果为 null（无可压缩）已 emit final compact_error，但继续往下走：仍超阈值时下一轮再试
    }

    // 2. apply 后可能已低于阈值
    const _est2 = this.estimateTokens();
    if (_est2 <= this.memoryTokenLimit) {
      logger.info(`[compact] bg apply 后 tokens=${_est2} <= memoryTokenLimit=${this.memoryTokenLimit}，本轮不再压`);
      return;
    }

    // 3. 后台失败待报 → emit compact_error（不阻断，继续往下）
    await this._reportBgFailure(emit);

    // 4. 老区 token < MIN_SAVINGS → 跳过（涵盖单组对话）
    const compactableTokens = this._countCompactableTokens();
    if (compactableTokens < COMPACT_MIN_SAVINGS) {
      const logger = createLogger('message_manager', logFileName);
      logger.info(`[compact] 老区可压缩 token ${compactableTokens} < ${COMPACT_MIN_SAVINGS}，跳过压缩`);
      return;
    }

    // 5/6-7. 按模式触发
    if (async) {
      await this._triggerAsync(llmModel, options, emit);
    } else {
      await this._triggerBlocking(llmModel, options, emit);
    }
  }

  /**
   * 压缩调用入口：转发 compactIfNeeded 的事件；压缩成功（emit compact）后调 onDone。
   * 供 agent reasoning 每轮入口 + 循环后兜底两处复用，消灭复制粘贴。
   * @param {object} llmModel
   * @param {{signal?: AbortSignal, onEvent?: Function, onDone?: Function}} [options]
   *
   * 说明：onDone 是 agent 注入的回调（内容如"压缩完重注入 skill"），mm 不知道也不关心其内容——
   * 职责不耦合，compactor 只负责"压缩完调它"。signal 由调用方传（复用当前轮 abort 信号），
   * abort 收尾（compact_abort/aborted/done）仍归 agent 的 reasoning，不在此处。
   */
  async runCompact(llmModel, { signal, onEvent, onDone } = {}) {
    let done = false;
    const wrappedEmit = (event) => {
      if (event.event === 'compact') done = true;
      onEvent?.(event);
    };
    await this.compactIfNeeded(llmModel, { signal, onEvent: wrappedEmit });
    if (done && typeof onDone === 'function') await onDone();
  }

  /**
   * 步骤 1：后台压缩结果已就绪（_bgDone=true）→ apply，emit compact / final compact_error。
   * @returns {Promise<boolean>} true=已处理（apply 成功 或 final error），编排应 return；false=结果 null，继续
   */
  async _handleReadyBgResult(emit) {
    const logger = createLogger('message_manager', logFileName);
    logger.info(`[compact] 检测到后台结果就绪，开始 apply (pending=${this._pendingCompact?.compactId})`);
    const result = this._applyBgResult();
    if (result) {
      const compact = this._pendingCompact;
      this._endCompactSuccess();
      logger.info(`[compact] 后台压缩成功 ${compact?.compactId}: 压后 ${result.tokenEstimate} tokens`);
      emit({ event: 'compact', data: { ...result, compactId: compact?.compactId } });
      return true;   // apply 成功，让编排 return
    }
    // _bgResult 为 null：可能是 _doCompact 返回 null（保留区外无可压缩，不计断路器）、
    // 空回复或 anchor 丢失（_applyBgResult 内已计断路器）。final 收尾气泡，编排继续（仍超阈值则下一轮再试）。
    logger.warn(`[compact] 后台压缩结果为 null，走 compact_error 收尾 (pending=${this._pendingCompact?.compactId})`);
    const compact = this._pendingCompact;
    this._endCompactAbandoned();
    emit({ event: 'compact_error', data: {
      compactId: compact?.compactId, attempt: compact?.attempt,
      error: '记忆压缩失败：无可压缩内容', final: true
    } });
    return false;
  }

  /**
   * 步骤 3：上轮后台失败待报（_bgFailed）→ emit compact_error。不阻断后续。
   */
  async _reportBgFailure(emit) {
    if (!this._bgFailed) return;
    this._bgFailed = false;
    const compact = this._pendingCompact;
    const final = this._compactDisabled;
    if (final) this._endCompactAbandoned();
    emit({ event: 'compact_error', data: {
      compactId: compact?.compactId, attempt: compact?.attempt,
      error: '记忆压缩失败', final: final || undefined
    } });
  }

  /**
   * 步骤 5：async 模式触发后台 fire-and-forget 压缩，emit compact_start。
   */
  async _triggerAsync(llmModel, options = {}, emit) {
    const logger = createLogger('message_manager', logFileName);
    if (this._bgRunning) { logger.info(`[compact] 后台已在跑，跳过本次触发`); return; }  // 后台在跑 → 不重触发
    if (this._compactDisabled) return;                          // 断路器禁用

    const compact = this._beginCompactAttempt();               // {compactId, attempt}（async 恒 attempt=1）
    const compactId = compact.compactId;                       // 闭包捕获，供 .then/.catch 内用
    logger.info(`[compact] 触发后台压缩 ${compactId} (attempt ${compact.attempt}): 估算 ${this.estimateTokens()} tokens > 上限 ${this.memoryTokenLimit}`);
    this._bgRunning = true;
    this._bgDone = false;
    this._bgResult = null;
    this._bgAbortController = new AbortController();           // 独立 signal，不依赖调用方

    this._bgPromise = this._doCompact(llmModel, {
      ...options,
      signal: this._bgAbortController.signal
    })
      .then(r => {
        logger.info(`[compact] 后台压缩完成 ${compactId}: result=${r ? (r.summary === null ? '空回复' : '有摘要') : 'null(null)'} anchorId=${r?.anchorId}`);
        this._bgResult = r;
        this._bgDone = true;
        this._bgRunning = false;
        // ★ events 通道：后台完成后立即 apply + 推事件，不等到下一轮 compactIfNeeded
        this._bgCompactDoneHandler(compactId);
      })
      .catch(err => {
        this._bgRunning = false;
        if (err?.name === 'AbortError') {
          logger.info(`[compact] 后台压缩被中止 ${compactId}`);
          return;
        }
        this._bgFailed = true;
        this._recordFailure();
        logger.error(`[compact] 后台压缩失败 ${compactId}: ${err.message}`);
        // ★ events 通道：失败立即推 compact_error
        if (this._bgCompactErrorHandler(err.message)) {
          this._bgFailed = false;  // events 通道已报，清标志避免 _bgFailed 分支重复报
        }
      });

    emit({ event: 'compact_start', data: compact });
  }

  /**
   * 步骤 6-7：blocking 模式同步压缩，emit compact_start → compact / compact_error。
   */
  async _triggerBlocking(llmModel, options = {}, emit) {
    const logger = createLogger('message_manager', logFileName);
    if (this._compactDisabled) return;
    const compact = this._beginCompactAttempt();
    logger.info(`[compact] 触发阻塞压缩 ${compact.compactId} (attempt ${compact.attempt}): 估算 ${this.estimateTokens()} tokens > 上限 ${this.memoryTokenLimit}`);
    emit({ event: 'compact_start', data: compact });

    try {
      const r = await this._doCompact(llmModel, options);
      if (!r) {
        // _doCompact 返回 null：保留区外无可压缩内容（如历史全是最近 group）。
        // 不计断路器（不是压缩失败，是没东西可压），但仍收尾气泡让用户知情。
        this._endCompactAbandoned();
        emit({ event: 'compact_error', data: { ...compact, error: '记忆压缩失败：无可压缩内容', final: true } });
        return;
      }
      if (r.summary === null) {
        // LLM 回复为空 → 记断路器 + compact_error 收尾，不替换 messages
        this._recordFailure();
        const final = this._compactDisabled;
        if (final) this._endCompactAbandoned();
        emit({ event: 'compact_error', data: { ...compact, error: '记忆压缩失败：响应为空', final: final || undefined } });
        return;
      }
      this._applyResultSync(r);
      this._endCompactSuccess();
      logger.info(`[compact] 阻塞压缩成功 ${compact.compactId}: 压后 ${this.estimateTokens()} tokens`);
      emit({ event: 'compact', data: { tokenEstimate: this.estimateTokens(), compactId: compact.compactId } });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;                  // abort 抛给 agent（收尾归 default_agent）
      this._recordFailure();
      const final = this._compactDisabled;
      if (final) this._endCompactAbandoned();
      emit({ event: 'compact_error', data: { ...compact, error: err.message || '记忆压缩失败', final: final || undefined } });
    }
  }

  /**
   * 后台压缩成功就绪回调（由 _triggerAsync 的 .then 调）：
   * apply 后台结果 → 经 _eventSink 推 compact / compact_error 给前端。
   * 收口自原 fromConfigDir 里反挂的 mm._onBgCompactDone。
   */
  _bgCompactDoneHandler(compactId) {
    const logger = createLogger('message_manager', logFileName);
    logger.info(`[events] _bgCompactDoneHandler: compactId=${compactId}, hasEventSink=${!!this._eventSink}`);
    const result = this._applyBgResult();
    if (result) {
      const c = this._pendingCompact;
      this._endCompactSuccess();
      logger.info(`[events] bg apply 成功, eventSink compact compactId=${compactId} tokenEstimate=${result.tokenEstimate}`);
      this._eventSink?.('compact', { tokenEstimate: result.tokenEstimate, compactId });
      return;
    }
    logger.warn(`[events] bg apply 失败, eventSink compact_error compactId=${compactId}`);
    const c = this._pendingCompact;
    this._endCompactAbandoned();
    this._eventSink?.('compact_error', {
      compactId,
      attempt: c?.attempt,
      error: '记忆压缩失败：无可压缩内容',
    });
  }

  /**
   * 后台压缩失败（非 abort）回调（由 _triggerAsync 的 .catch 调）：
   * 经 _eventSink 推 compact_error，返回 true 让 _triggerAsync 清 _bgFailed。
   * 收口自原 fromConfigDir 里反挂的 mm._onBgCompactError。
   */
  _bgCompactErrorHandler(msg) {
    const logger = createLogger('message_manager', logFileName);
    logger.info(`[events] _bgCompactErrorHandler: error=${msg}, hasEventSink=${!!this._eventSink}`);
    this._eventSink?.('compact_error', {
      compactId: this._pendingCompact?.compactId,
      attempt: this._pendingCompact?.attempt,
      error: msg,
    });
    return true;   // 告知 _triggerAsync：events 通道已报，清 _bgFailed
  }

  /**
   * 压缩核心逻辑（阻塞/异步共用）
   * - 按 assistant turn 切 group
   * - 保留最近 1 个 group，其余送摘要
   * - 返回 { summary, anchorId } 或 null
   */
  async _doCompact(llmModel, options = {}) {
    const groups = this._groupByAssistantTurn();

    // 统一逻辑：保留最近 1 个 group，其余（老 group）送摘要。
    // 单组对话时 summaryGroups 为空 → 老区无可压缩内容 → 守卫返回 null，不压缩、不替换。
    // （不再走"单组全量替换"——那会违背"保留最近 1 group"的设计。）
    const preserveGroup = groups[groups.length - 1];
    const summaryGroups = groups.length >= 2 ? groups.slice(0, -1) : [];
    const anchorId = groups.length >= 2 ? preserveGroup[0].id : null;
    const summaryMessages = summaryGroups.flat();

    // ★ 守卫：可被压缩的内容必须非空。否则喂给 LLM 的只有 system + 压缩指令，
    // 没有任何可摘要的对话，模型要么空回要么胡编。直接当"无可压缩内容"返回 null。
    // （单组对话、或老 group 皆为空时命中）
    if (!summaryMessages || summaryMessages.length === 0) {
      return null;
    }

    const summaryRequest = [
      { role: 'system', content: this.compactSystemPrompt || this.systemPrompt || '' },
      ...summaryMessages.map(m => ({ ...m })),
      { role: 'user', content: this.compactPrompt }
    ];

    const response = await llmModel.chat(summaryRequest, { enable_thinking: false, ...options });
    const summary = this._parseOrRaw(response);
    if (!summary) {
      // LLM 回复为空：返回 { summary: null } 以便上层区分"空回复"和"group不足"
      return { summary: null, anchorId };
    }

    return { summary, anchorId };
  }

  /**
   * 阻塞模式：应用压缩结果
   * anchor 位置之后的全保留，之前的替换为摘要
   */
  _applyResultSync({ summary, anchorId }) {
    // anchorId 必非 null（_doCompact 单组时已返回 null 不走到这）；anchor 定位保留 group 起点锚定
    const idx = this.messages.findIndex(m => m.id === anchorId);
    this.messages = [
      { id: this._genMsgId(), role: 'user', content: SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + summary, isCompactSummary: true },
      ...this.messages.slice(idx === -1 ? 0 : idx)   // anchor 真丢（理论不会）则退化为从开头保留
    ];
    this._compactHappened = true;
    this._save();
  }

  /**
   * 异步模式：应用后台压缩结果
   * @returns {{ tokenEstimate: number } | null} 成功返回 token 估算，失败返回 null
   */
  _applyBgResult() {
    if (!this._bgResult) {
      // _doCompact 返回 null（无可压缩内容）
      const logger = createLogger('message_manager', logFileName);
      logger.warn(`[compact] _applyBgResult: _bgResult 为 null`);
      this._bgRunning = false;
      this._bgDone = false;
      this._bgResult = null;
      return null;
    }

    const { summary, anchorId } = this._bgResult;
    this._bgRunning = false;
    this._bgDone = false;
    this._bgResult = null;

    if (summary === null) {
      // 后台压缩 LLM 空回复 → 返回 null，上层 bgDone 分支据 _bgResult.summary===null 报 compact_error
      const logger = createLogger('message_manager', logFileName);
      logger.warn(`[compact] _applyBgResult: summary 为 null（空回复）`);
      this._recordFailure();
      return null;
    }

    if (anchorId === null) {
      // 全量替换（group<2 退化路径，无保留 group）：消息整体替换为单条摘要
      this.messages = [
        { id: this._genMsgId(), role: 'user', content: SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + summary, isCompactSummary: true },
      ];
      this._compactHappened = true;
      this._save();
      return { tokenEstimate: this.estimateTokens() };
    }

    const idx = this.messages.findIndex(m => m.id === anchorId);
    if (idx === -1) {
      // anchor 真的丢了（rewind 后消息已变），才算失败
      const logger = createLogger('message_manager', logFileName);
      logger.warn(`[compact] _applyBgResult: anchorId ${anchorId} 在 messages 中找不到（已被压缩/rewind）`);
      this._recordFailure();
      return null;
    }

    this.messages = [
      { id: this._genMsgId(), role: 'user', content: SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + summary, isCompactSummary: true },
      ...this.messages.slice(idx)
    ];
    this._compactHappened = true;
    this._save();
    return { tokenEstimate: this.estimateTokens() };
  }

  // ============ group 切分 ============

  /**
   * 通用版：每条 assistant 消息开始新 group（不管有无 tool_calls）
   * 适用于 elf-001/003 等纯文本对话场景
   * elf-002 可 override 为按 tool_calls 切
   */
  _groupByAssistantTurn() {
    const groups = [];
    let current = [];
    for (const msg of this.messages) {
      const isNewTurn = msg.role === 'assistant' && current.length > 0;
      if (isNewTurn) {
        groups.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
    }
    if (current.length) groups.push(current);
    return groups;
  }

  /**
   * 保留最近 1 个 group 后，老区（将被摘要替换的内容）的 token 估算。
   * 口径：strip id/isMeta/metaTag 后的老区消息数组（不含 system——system 不被压缩）。
   * 用于 compactIfNeeded 预判：老区 token < COMPACT_MIN_SAVINGS 则压了得不偿失，跳过。
   */
  _countCompactableTokens() {
    const groups = this._groupByAssistantTurn();
    if (groups.length < 2) return 0;
    const summaryMessages = groups.slice(0, -1).flat().map(m => {
      const { id, isMeta, metaTag, ...rest } = m;
      return rest;
    });
    return countMessageTokens(summaryMessages);
  }

  // ============ 未决压缩任务（compactId 锚定前端气泡） ============

  /**
   * 开始一次压缩尝试。
   * - 有未决任务（上次失败未 final）→ attempt++（跨轮复用同 compactId，前端同气泡重试）
   * - 无未决任务 → 新建 compactId，attempt=1
   * 返回快照 { compactId, attempt } 供事件 data 用。
   * 注：async 模式失败即 final 清 _pendingCompact，所以 async 恒 attempt=1；
   *     仅 elf-002 阻塞重试走到 attempt>1。
   */
  _beginCompactAttempt() {
    if (this._pendingCompact) {
      this._pendingCompact.attempt++;
    } else {
      this._pendingCompact = { compactId: this._genMsgId(), attempt: 1 };
    }
    return { ...this._pendingCompact };
  }

  /** 压缩成功收尾：清未决任务 */
  _endCompactSuccess() {
    this._pendingCompact = null;
  }

  /** 彻底放弃（断路器禁用 / abort / 无可压缩内容）：清未决任务 */
  _endCompactAbandoned() {
    this._pendingCompact = null;
  }

  /**
   * 放弃未决压缩任务并返回其 compactId（供前端气泡标"已终止"）。
   * agent 的 abort 收尾调它：清压缩状态 + 拿回要终止的气泡 id。
   * 仅状态清理；compact_abort 事件的 yield 归 agent（mm 不染指前端 UI 事件）。
   * @returns {{compactId: string} | null} 有未决任务返回其 id，否则 null
   */
  abandonPendingCompact() {
    const pc = this._pendingCompact;
    if (!pc) return null;
    this._endCompactAbandoned();
    return { compactId: pc.compactId };
  }

  // ============ 工具方法 ============

  /**
   * naive 解析：直接用整段回复，不解析 <summary> 标签
   * 子类可 override 为结构化解析版
   */
  _parseOrRaw(response) {
    if (!response) return null;
    const text = (typeof response === 'string' ? response : '').trim();
    return text.length > 0 ? text : null;
  }

  /**
   * 记录一次压缩失败，连续达到阈值后禁用自动压缩
   */
  _recordFailure() {
    this._compactFailCount++;
    if (this._compactFailCount >= COMPACT_FAIL_THRESHOLD) {
      this._compactDisabled = true;
      const logger = createLogger('message_manager', logFileName);
      logger.warn(`记忆压缩连续失败 ${this._compactFailCount} 次，已禁用自动压缩`);
    }
  }

  /**
   * 中止后台压缩任务
   * 由 default_agent.js 的 abort() 调用，确保 abort 时同时中止压缩和 LLM 请求
   */
  abortBackgroundCompact() {
    if (this._bgAbortController) {
      this._bgAbortController.abort();
      this._bgAbortController = null;
    }
  }

  /** 检查是否有后台结果就绪（调试用） */
  _hasBgResult() {
    return this._bgDone && this._bgResult !== null;
  }

  // ============ 持久化 ============

  clear() {
    this.messages = [];
    this._save();
  }

  /**
   * compact 后调用，返回 compact 是否刚发生。
   * 调用即消费（重置为 false）。
   * 语义：MessageManager 只提供信号，不负责决定重推什么内容。
   */
  getCompactHappened() {
    const happened = this._compactHappened;
    this._compactHappened = false;
    return happened;
  }

  /**
   * 从 context.json 重新加载 messages（rewind 后由 agent /reload 调用）
   * 会重置所有运行时状态
   */
  reloadFromDisk() {
    // 中止任何正在跑的后台压缩（rewind 后历史已不存在）
    if (this._bgAbortController) {
      this._bgAbortController.abort();
      this._bgAbortController = null;
    }

    this.messages = [];
    this._load();

    // 重置所有运行时状态
    this._bgRunning = false;
    this._bgDone = false;
    this._bgResult = null;
    this._bgPromise = null;
    this._bgFailed = false;
    this._pendingCompact = null;
    this._compactFailCount = 0;
    this._compactDisabled = false;
    this._compactHappened = false;
  }

  /**
   * 持久化：全量写回 context.json
   */
  _save() {
    if (!this.contextFile) return;
    try {
      fs.writeFileSync(this.contextFile, JSON.stringify(this.messages, null, 2), 'utf-8');
    } catch (err) {
      const logger = createLogger('message_manager', logFileName);
      logger.error(`写入 context.json 失败: ${err.message}`);
    }
  }

  /**
   * 持久化：从 context.json 加载
   * 兼容旧数据：messages 无 id 字段时自动补生成
   */
  _load() {
    if (!this.contextFile) return;
    try {
      if (fs.existsSync(this.contextFile)) {
        const raw = fs.readFileSync(this.contextFile, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          // 兼容旧 context.json（无 id 字段）：每条补生成 id
          this.messages = data.map(m => m.id ? m : { ...m, id: this._genMsgId() });
          const logger = createLogger('message_manager', logFileName);
          logger.info(`从 context.json 加载了 ${data.length} 条消息`);
        }
      }
    } catch (err) {
      const logger = createLogger('message_manager', logFileName);
      logger.warn(`加载 context.json 失败，使用空历史: ${err.message}`);
      this.messages = [];
    }
  }
}