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
import { createLogger } from '../logger.js';
import { countMessageTokens } from '../tokenizer.js';

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

    // —— 后台压缩状态 ——
    this._bgRunning = false;   // 后台任务是否在运行
    this._bgDone = false;      // 后台任务是否已完成（结果待应用）
    this._bgResult = null;     // 后台任务的压缩结果 { summary, anchorId }
    this._bgPromise = null;    // 后台 Promise 引用
    this._bgFailed = false;    // 上一轮后台是否失败（待通知上层）
    this._bgAbortController = null; // 后台压缩的独立 AbortController

    // —— 断路器 ——
    // 基类不初始化断路器字段，子类（如 elf-002）按需初始化。
    // _recordFailure() 只在这些字段存在时生效。

    // compact 发生标记（兼容旧调用方，优先使用 event 消费）
    this._compactHappened = false;

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
    const systemMsg = { role: 'system', content: this.systemPrompt };
    const msgs = this.messages.map(m => {
      // strip id、isMeta、metaTag — LLM API 不接受额外字段
      const { id, isMeta, metaTag, ...rest } = m;
      return rest;
    });
    return [systemMsg, ...msgs];
  }

  estimateTokens() {
    // 基于 getMessagesForLLM（已 strip id）计数，确保与 LLM 口径一致
    const allMessages = this.getMessagesForLLM();
    return countMessageTokens(allMessages);
  }

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
  async *compactIfNeeded(llmModel, options = {}) {
    if (this.estimateTokens() <= this.memoryTokenLimit) return;

    const logger = createLogger('message_manager', logFileName);
    // 无 config 或未配 compactMode 时默认 blocking（兼容现有测试和同步行为）
    const async = this._config?.get('compactMode') === 'async';

    // 1. 如果后台结果已就绪，先应用
    if (this._bgDone) {
      const result = this._applyBgResult();
      if (result) {
        yield { event: 'compact', data: result };
        // 关键：apply 成功后先退出 generator，让前端有机会更新气泡 UI
        // （否则同一轮中会立即继续 yield compact_start，前端来不及切换状态）
        return;
      }
      // _bgResult 为 null（无可压缩内容），不算失败但也不 yield
      // 仍然超阈值的话会在下面进入新一轮
    }

    // 2. 再次检查是否还需要压缩（apply 后可能已低于阈值）
    if (this.estimateTokens() <= this.memoryTokenLimit) return;

    // 3. 后台失败待报（上一轮后台 catch 设的标志）
    if (this._bgFailed) {
      this._bgFailed = false;
      yield { event: 'compact_error', data: { error: '记忆压缩失败' } };
      // 报了 error 后如果仍然超阈值，会在下一轮再尝试
      // （除非断路器已禁用）
    }

    if (async) {
      // ——— 非阻塞模式 ———
      if (this._bgRunning) return;                                // 后台在跑 → 不重触发
      if (this._compactDisabled) return;                          // 断路器禁用

      this._bgRunning = true;
      this._bgDone = false;
      this._bgResult = null;
      this._bgAbortController = new AbortController();           // 独立 signal，不依赖调用方

      this._bgPromise = this._doCompact(llmModel, {
        ...options,
        signal: this._bgAbortController.signal
      })
        .then(r => {
          this._bgResult = r;
          this._bgDone = true;
          this._bgRunning = false;
        })
        .catch(err => {
          this._bgRunning = false;
          // abort 是主动行为，不算失败、不触发断路器
          if (err?.name === 'AbortError') {
            logger.info('后台记忆压缩被中止');
          } else {
            this._bgFailed = true;
            this._recordFailure();
            logger.error(`后台记忆压缩失败: ${err.message}`);
          }
        });

      yield { event: 'compact_start', data: {} };
      return;                                                     // 不等
    }

    // ——— 阻塞模式 ———
    if (this._compactDisabled) return;
    yield { event: 'compact_start', data: {} };

    try {
      const r = await this._doCompact(llmModel, options);
      if (!r) {
        // _doCompact 返回 null（无 group），静默返回
        return;
      }
      if (r.summary === null) {
        // LLM 回复为空 → 提示前端，不替换 messages
        yield { event: 'compact_error', data: { error: '记忆压缩失败：响应为空' } };
        return;
      }
      this._applyResultSync(r);
      yield { event: 'compact', data: { tokenEstimate: this.estimateTokens() } };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;                  // abort 抛给 agent
      this._recordFailure();
      yield { event: 'compact_error', data: { error: err.message || '记忆压缩失败' } };
    }
  }

  /**
   * 压缩核心逻辑（阻塞/异步共用）
   * - 按 assistant turn 切 group
   * - 保留最近 1 个 group，其余送摘要
   * - 返回 { summary, anchorId } 或 null
   */
  async _doCompact(llmModel, options = {}) {
    const groups = this._groupByAssistantTurn();

    let summaryRequest;
    let anchorId = null;

    if (groups.length >= 2) {
      // 新逻辑：保留最近 1 个 group，其余送摘要
      const preserveGroup = groups[groups.length - 1];
      const summaryGroups = groups.slice(0, -1);
      anchorId = preserveGroup[0].id;

      summaryRequest = [
        { role: 'system', content: this.compactSystemPrompt || this.systemPrompt || '' },
        ...summaryGroups.flat().map(m => ({ ...m })),
        { role: 'user', content: this.compactPrompt }
      ];
    } else {
      // 退化：group 不足时走全量摘要（兼容 naive 旧行为）
      summaryRequest = [
        { role: 'system', content: this.compactSystemPrompt || this.systemPrompt || '' },
        ...this.messages.map(m => ({ ...m })),
        { role: 'user', content: this.compactPrompt }
      ];
    }

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
    if (anchorId === null) {
      // group 不足时的退化全量替换
      this.messages = [{
        id: this._genMsgId(),
        role: 'user',
        content: SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + summary,
        isCompactSummary: true
      }];
    } else {
      const idx = this.messages.findIndex(m => m.id === anchorId);
      if (idx === -1) {
        // anchor 丢失（理论上不应发生），降级为全量替换
        this.messages = [{
          id: this._genMsgId(),
          role: 'user',
          content: SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + summary,
          isCompactSummary: true
        }];
      } else {
        this.messages = [
          { id: this._genMsgId(), role: 'user', content: SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + summary, isCompactSummary: true },
          ...this.messages.slice(idx)
        ];
      }
    }
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
      this._bgRunning = false;
      this._bgDone = false;
      this._bgResult = null;
      return null;
    }

    const { summary, anchorId } = this._bgResult;
    this._bgRunning = false;
    this._bgDone = false;
    this._bgResult = null;

    const idx = this.messages.findIndex(m => m.id === anchorId);
    if (idx === -1) {
      // anchor 没了（可能是 rewind 后消息已变）
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