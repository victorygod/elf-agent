/**
 * elf-002 专属 MessageManager
 *
 * 继承 shared 基类，实现上下文压缩（对齐 Claude Code 第 1/2 层 + microcompact + 第 4 层）：
 * - 第 1 层：单工具结果超 perToolLimit → 持久化到磁盘 + content 改写为 <persisted-output>
 * - 第 2 层：单次请求内 fresh 工具结果总量超 budgetWindow → 淘汰最大的持久化
 * - microcompact：estimateTokens ≥ microcompactThreshold 时，跨历史清老的、未持久化的
 *   tool_result → 占位（落盘可回读），保留最近 keepRecent 个；省不到 minSavings 不触发
 * - 第 4 层：累计超 memoryTokenLimit → 结构化摘要全量替换为 1 条 user 消息
 *
 * 数据模型：context.json = 内存镜像，持久化即改写 content 并 _save()；
 * 不维护 replacements map，持久化状态靠 content.startsWith('<persisted-output>') 判别。
 *
 * 通过 config.json 的 messageManagerClass 字段激活。
 */

import fs from 'fs';
import path from 'path';
import { MessageManager as BaseMessageManager, COMPACT_MIN_SAVINGS } from '../../engine/message_manager.js';
import { createLogger } from '../../shared/logger.js';
import { countTokens, countMessageTokens } from '../../shared/tokenizer.js';

let logFileName = null;

export function setLogFileName(name) {
  logFileName = name;
}

// Claude Code 原文常量（对齐 oF6 摘要包装前缀）
const SUMMARY_PREAMBLE =
  'This session is being continued from a previous conversation that ran out of context. ' +
  'The summary below covers the earlier portion of the conversation.\n\n';

// 续写指令（对齐 CC 全量自动路径 continuationClause；elf-002 选择加，混合行为）
const CONTINUATION_CLAUSE =
  'Continue the conversation from where it left off without asking the user any further questions. ' +
  'Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface ' +
  'with "I\'ll continue" or similar. Pick up the last task as if the break never happened.\n\n';

// 断路器：连续压缩失败达到此阈值后禁用自动压缩
const COMPACT_FAIL_THRESHOLD = 3;

// microcompact 常量（对齐 CC 源码硬编码、不可配；CC A$d=5 / $Ls=20000）
const MC_KEEP_RECENT = 5;          // 保留最近 N 个 tool_result 原样（CC A$d=5）
const MC_MIN_SAVINGS = 20000;      // 最小节省 token，省不到不触发（CC $Ls=20000）
// MC 触发阈值 = memoryTokenLimit × 0.6 派生（CC 靠服务端 context_hint,elf 无信号→改客户端阈值）

export class MessageManager extends BaseMessageManager {
  constructor(params) {
    super(params);
    this._config = params.config || null;

    // 阈值参数：config 未配时代码兜底，配置覆盖
    this.perToolLimit = this._getThreshold('perToolLimit', 50000);
    this.previewLength = this._getThreshold('previewLength', 2000);
    this.budgetWindow = this._getThreshold('budgetWindow', 200000);

    // microcompact：开关 config 可配；keepRecent/minSavings/threshold 对齐 CC 不可配（常量/派生）。
    // CC 靠服务端 context_hint 触发,elf 无信号→改客户端阈值 = memoryTokenLimit×0.6 派生。
    this.microcompactEnabled = this._config?.get('microcompactEnabled') === true;
    this.microcompactThreshold = Math.floor(this.memoryTokenLimit * 0.6);
    this.microcompactKeepRecent = MC_KEEP_RECENT;
    this.microcompactMinSavings = MC_MIN_SAVINGS;

    // 注：compactSystemPrompt/compactPrompt 由基类构造/updateConfig 从 mmParams 读（start.js 装配），
    //    此处不再重复读取。基类 reloadConfig 也会同步更新。

    // 工具结果持久化目录：<dataDir>/tool-results/
    this.toolResultsDir = this.dataDir ? path.join(this.dataDir, 'tool-results') : null;

    // 断路器：进程内状态，不持久化，重启清零
    this._compactFailCount = 0;
    this._compactDisabled = false;

    // 群聊动态 roster prefix（RoomMiddleware._refreshRoster 写入,发往 LLM 时拼到最近一条 user 开头）。
    this.roomRosterPrefix = '';
  }

  /**
   * override：热更新时刷新本子类新增的参数
   * 基类 updateConfig 处理 systemPrompt / memoryTokenLimit
   */
  updateConfig(params) {
    super.updateConfig(params);
    if (this._config) {
      this.perToolLimit = this._getThreshold('perToolLimit', 50000);
      this.previewLength = this._getThreshold('previewLength', 2000);
      this.budgetWindow = this._getThreshold('budgetWindow', 200000);
      this.microcompactEnabled = this._config?.get('microcompactEnabled') === true;
      this.microcompactThreshold = Math.floor(this.memoryTokenLimit * 0.6);
      this.microcompactKeepRecent = MC_KEEP_RECENT;
      this.microcompactMinSavings = MC_MIN_SAVINGS;
      // compactSystemPrompt/compactPrompt 由基类 updateConfig 处理（params 传入），此处不重复
    }
  }

  /** 从 config 读阈值，缺失用 def 兜底 */
  _getThreshold(name, def) {
    const v = this._config?.get(name);
    return (typeof v === 'number' && v > 0) ? v : def;
  }

  // ============ 第 1 层：单工具结果持久化 ============

  /**
   * override 基类原签名：超 perToolLimit 时持久化 + content 改写
   * toolName 不参与（持久化只用 toolCallId）
   */
  addToolResult(toolCallId, content) {
    let finalContent = content;
    if (typeof content === 'string' && content.length > this.perToolLimit) {
      const meta = this._persistToolResult(toolCallId, content);
      if (meta) {
        finalContent = this._buildPersistedOutput(meta);
      }
    }
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: finalContent
    });
    this._save();
  }

  // ============ 第 2 层：跨消息预算窗口 ============

  /**
   * override：先跑 budget 强制（按 turn group 淘汰最大 fresh），再返回拼好的消息
   */
  getMessagesForLLM() {
    this._enforceBudgetWindow();
    const systemMsg = { role: 'system', content: this.systemPrompt };
    // skill_listing 改为临注入：旧持久化清单不再送 LLM（对齐 CC 每轮重算 attachment）。
    const msgs = this.messages
      .filter(m => m.metaTag !== 'skill_listing')
      .map(m => {
        // strip id、isMeta、metaTag — LLM API 不接受额外字段（对齐基类 getMessagesForLLM）
        const { id, isMeta, metaTag, ...rest } = m;
        return rest;
      });
    // 群聊动态 roster prefix：拼到最近一条 user 开头（不发写入记忆）。私聊 roomRosterPrefix 空串不影响。
    const roster = this.roomRosterPrefix || '';
    if (roster) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          msgs[i].content = roster + msgs[i].content;
          break;
        }
      }
    }
    // skill 清单临注入到最近一条 user 之前（与基类 getMessagesForLLM 一致）。
    const out = this._injectTransientListing(msgs);
    return [systemMsg, ...out];
  }

  /**
   * override：纯计算，不调 getMessagesForLLM()，无 budget/roster 副作用
   * 直接对 this.messages + systemPrompt 做全量 JSON 序列化计数，
   * 确保 role、tool_call_id、JSON 结构开销等全部参与 token 估算。
   * 与 getMessagesForLLM 口径对齐：过滤旧 skill_listing 持久化消息 + 临注入本轮 listing。
   */
  estimateTokens() {
    const systemMsg = { role: 'system', content: this.systemPrompt };
    const msgs = this.messages
      .filter(m => m.metaTag !== 'skill_listing')
      .map(m => {
        const { id, isMeta, metaTag, ...rest } = m;
        return rest;
      });
    const out = this._injectTransientListing(msgs);
    const allMessages = [systemMsg, ...out];
    return countMessageTokens(allMessages);
  }

  /**
   * 预算强制：按 assistant turn 分 group，group 内 fresh（未持久化）tool 结果
   * 总量超 budgetWindow 时，贪心淘汰最大的 → 持久化 + 改写 content。
   * 已是 <persisted-output> 的 tool 结果（mustReapply）不计入 fresh，保留不动。
   */
  _enforceBudgetWindow() {
    if (!this.messages.length) return;

    // 按 assistant turn 分 group：每个 assistant(tool_calls) 后跟着若干 tool 结果
    const groups = this._groupToolResultsByTurn();
    if (!groups.length) return;

    for (const group of groups) {
      // group 内 fresh（未持久化）的 tool 结果
      const fresh = group.filter(m =>
        m.role === 'tool' &&
        m.content &&
        typeof m.content === 'string' &&
        !m.content.startsWith('<persisted-output>')
      );
      // group 内已持久化 + frozen 总量
      const persistedSize = group
        .filter(m => m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('<persisted-output>'))
        .reduce((s, m) => s + (m.content?.length || 0), 0);

      let freshTotal = fresh.reduce((s, m) => s + (m.content?.length || 0), 0);
      const total = persistedSize + freshTotal;
      if (total <= this.budgetWindow) continue;

      // 按体积降序，贪心淘汰最大的 fresh
      fresh.sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0));
      for (const msg of fresh) {
        if (persistedSize + freshTotal <= this.budgetWindow) break;
        const meta = this._persistToolResult(msg.tool_call_id, msg.content);
        if (meta) {
          msg.content = this._buildPersistedOutput(meta);
          freshTotal -= meta.originalSize;
        }
      }
      this._save();
    }
  }

  /** 把 messages 按每个 assistant(tool_calls) turn 切成 group */
  _groupToolResultsByTurn() {
    const groups = [];
    let current = [];
    for (const msg of this.messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        if (current.length) groups.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
    }
    if (current.length) groups.push(current);
    return groups.filter(g => g.some(m => m.role === 'tool'));
  }

  // ============ microcompact：跨历史轻量清理 ============

  /**
   * L4 之前的轻量省 token 闸（对齐 CC microcompact / BLs + fZr）。
   * 不调 LLM、不摘要：跨历史清理偏老的、未持久化的 tool_result content，保留全局最近
   * keepRecent 个原样。省不到 minSavings（token 口径）不触发，避免无意义裁剪。
   *
   * 触发源：CC 用服务端 context_hint SSE；elf 无此信号 → 改客户端 estimateTokens 判定
   *         （≥ microcompactThreshold 时尝试）。与 L2 正交：L2 管单 group 内 fresh 合计
   *         超 budgetWindow → 落盘预览；microcompact 管跨 group 累计的老 result → 清成占位。
   * 占位落盘 + filepath（复用 _persistToolResult），可 Read 回读，不丢信息。
   * 独立于 L4 断路器（不调 LLM，不会失败）。
   */
  _microcompactIfNeeded() {
    if (!this.microcompactEnabled) return;
    if (this.estimateTokens() < this.microcompactThreshold) return;

    const toolMsgs = this.messages.filter(m => m.role === 'tool');
    if (toolMsgs.length <= this.microcompactKeepRecent) return;

    // 保留全局最近 keepRecent 个原样，其余为候选
    const keepIds = new Set(
      toolMsgs.slice(-this.microcompactKeepRecent).map(m => m.tool_call_id)
    );
    const candidates = toolMsgs.filter(m => !keepIds.has(m.tool_call_id));

    // 只清"未处理过的原始 result"。对齐 CC b4y:跳过已处理的（L1/L2 的 <persisted-output>
    // 和 microcompact 自己的 [Old tool result content cleared]），防重复清。
    const toClear = [];
    let savedTokens = 0;
    for (const m of candidates) {
      if (typeof m.content !== 'string') continue;
      if (m.content.startsWith('<persisted-output>')) continue;          // L1/L2 已压 (CC m4y)
      if (m.content.startsWith('[Old tool result content cleared]')) continue;  // microcompact 已清 (CC kvo)
      const placeholder = this._buildMicrocompactPlaceholder(m);

      // 实际 token 差值（与 estimateTokens 同源 BPE 口径）
      const tokenDiff = countTokens(m.content) - countTokens(placeholder);
      
      if (tokenDiff > 0) {
        savedTokens += tokenDiff;
        toClear.push({ m, placeholder });
      }
    }

    // 最小节省阈值（BPE 口径，对齐 estimateTokens；公共 tokenizer 统一计数）
    if (savedTokens < this.microcompactMinSavings) return;

    for (const { m, placeholder } of toClear) m.content = placeholder;
    this._save();
    const logger = createLogger('message_manager', logFileName);
    logger.info(`[microcompact] cleared ${toClear.length} tool results (~${savedTokens} tokens saved), kept last ${this.microcompactKeepRecent}`);
  }

  /**
   * 构建 microcompact 占位（对齐 CC fZr + T4y）。
   * CC microcompact 的占位与 L1/L2 的 <persisted-output> 外壳**严格分开**：
   *   - 落盘成功 → T4y 返回的轻量单行占位（"[Old tool result content cleared] ... saved to <filepath>"），
   *     模型需细节时主动 Read filepath。不带 <persisted-output> 标签、不带 Preview。
   *   - 落盘失败 / 含媒体 → 纯 kvo = "[Old tool result content cleared]"。
   * 三态互斥：L1/L2 = m4y 外壳(+Preview)；microcompact 落盘 = 单行指引；失败 = 纯 kvo。
   */
  _buildMicrocompactPlaceholder(msg) {
    const meta = this._persistToolResult(msg.tool_call_id, msg.content);
    if (meta) {
      return `[Old tool result content cleared] Full output saved to: ${meta.filepath}`;
    }
    return '[Old tool result content cleared]';
  }

  // ============ 第 4 层：结构化摘要压缩（保留最近 1 个 group） ============

  /**
   * override：保留最近 1 个 group 原文不变，只摘要更早的老历史。
   * 对齐 Claude Code sZ6 + QAq（reactive compact 思路，s=1 不重试）。
   *
   * - 固定保留最近 1 个 group（s=1，对齐 CC 起步值）
   * - 不重试：失败走断路器、不回退全量、不扩保留区
   * - 老摘要(isCompactSummary)作为普通消息参与，不排除（对齐 CC Ub.slice(r) 含老摘要）
   * - 续写指令加（elf-002 混合行为）
   */
  async *compactIfNeeded(llmModel, options = {}) {
    // microcompact：L4 之前的轻量省 token 闸（对齐 CC microcompact）。不调 LLM、不会失败 →
    // 放在断路器检查之前，不受 L4 断路器连坐。每轮 agent loop 顶部经本入口自然带上，无需改 default_agent.js。
    this._microcompactIfNeeded();

    if (this._compactDisabled) {
      // 断路器已禁：若有未决压缩任务的气泡（上次失败没 final 收尾），补一个 final error 收尾
      if (this._pendingCompact) {
        const c = this._pendingCompact;
        this._endCompactAbandoned();
        yield { event: 'compact_error', data: { ...c, error: '记忆压缩已禁用（连续失败）', final: true } };
      }
      return;
    }
    if (this.estimateTokens() <= this.memoryTokenLimit) return;

    // 预判：保留最近 1 个 group 后老区 token 是否达到最小可压缩阈值。
    // 基类 _countCompactableTokens 调用本类的 _groupByAssistantTurn（按 tool_calls 切），
    // 与基类同源阈值 COMPACT_MIN_SAVINGS。老区不足则压了得不偿失，跳过——不发气泡、不调 LLM。
    // 天然涵盖单组对话（老区为空 = 0 token）。
    const compactableTokens = this._countCompactableTokens();
    if (compactableTokens < COMPACT_MIN_SAVINGS) {
      const logger = createLogger('message_manager', logFileName);
      logger.info(`[compact] 老区可压缩 token ${compactableTokens} < ${COMPACT_MIN_SAVINGS}，跳过压缩`);
      return;
    }

    const logger = createLogger('message_manager', logFileName);

    // 复用基类未决压缩任务封装：首次 attempt=1；上次失败未 final → attempt++（跨轮同气泡重试）
    const compact = this._beginCompactAttempt();
    logger.info(`[compact] 触发压缩 ${compact.compactId} (attempt ${compact.attempt}): 估算 ${this.estimateTokens()} tokens > 上限 ${this.memoryTokenLimit}`);
    yield { event: 'compact_start', data: compact };

    try {
      // 1. 切 group（assistant 带 tool_calls 起新 group）
      const groups = this._groupByAssistantTurn();
      const o = groups.length;
      if (o < 2) {
        const f = this._fail(compact, '记忆压缩失败：无可压缩内容（group 不足）');
        yield { event: 'compact_error', data: { ...compact, ...f } };
        return;
      }

      // 2. 固定保留最近 1 个 group（s=1），其余送摘要
      const s = 1;
      const summaryCount = o - s;
      if (summaryCount < 1) {
        const f = this._fail(compact, '记忆压缩失败：无可压缩内容');
        yield { event: 'compact_error', data: { ...compact, ...f } };
        return;
      }

      const summaryGroups = groups.slice(0, summaryCount);     // 老（送摘要，含老摘要 isCompactSummary，不排除）
      const preserveGroups = groups.slice(summaryCount);       // 近期（保留 1 个）

      // 3. 手拼摘要请求：只送老 history、不送近期
      const summaryRequest = [
        { role: 'system', content: this.compactSystemPrompt },
        ...summaryGroups.flat().map(m => ({ ...m })),
        { role: 'user', content: this.compactPrompt }
      ];

      logger.info(`记忆压缩 Request: 摘要${summaryCount}组/保留${preserveGroups.length}组`);

      // 4. 调用 LLM，禁用 thinking（options 后置覆盖 extraParams）
      const response = await llmModel.chat(summaryRequest, { enable_thinking: false, ...options });
      logger.info(`记忆压缩 Response: ${response}`);

      // 5. 解析：<analysis> 删除，<summary> 提取
      const summary = this._parseSummaryResponse(response);
      if (!summary) {
        const f = this._fail(compact, '记忆压缩失败：响应为空或无 <summary>');
        yield { event: 'compact_error', data: { ...compact, ...f } };
        return;
      }

      // 6. 包装摘要（对齐 oF6）+ 续写指令（elf-002 选择加）
      const wrappedSummary = SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + 'Summary:\n' + summary;

      // 7. 替换消息 + 落盘事务：先 _save，再 _cleanupToolResults
      //    消息 = [摘要 user 消息, 近期 group 原文]
      this.messages = [
        { role: 'user', content: wrappedSummary, isCompactSummary: true },
        ...preserveGroups.flat()
      ];
      this._compactHappened = true;
      this._save();
      this._cleanupToolResults(this._referencedToolCallIds());

      // 压缩成功，重置断路器 + 清未决任务
      this._compactFailCount = 0;
      this._endCompactSuccess();
      logger.info(`[compact] 压缩成功 ${compact.compactId} (attempt ${compact.attempt}): 压后 ${this.estimateTokens()} tokens`);

      yield { event: 'compact', data: { tokenEstimate: this.estimateTokens(), compactId: compact.compactId } };

      // 8. 对齐 CC：压一次即返回，不本轮递归。仍超阈值靠下一轮 agent loop 顶部再触发
      if (this.estimateTokens() > this.memoryTokenLimit) {
        logger.info(`压缩后仍超阈值 ${this.estimateTokens()} > ${this.memoryTokenLimit}，留待下一轮 loop 顶部再压`);
      }
    } catch (err) {
      // AbortError 抛给 agent，不清状态、不收尾（收尾归 default_agent 的 _abortCompactBubble）
      if (err?.name === 'AbortError') throw err;
      logger.error(`记忆压缩失败: ${err.message}`);
      const f = this._fail(compact, err.message || '记忆压缩失败');
      yield { event: 'compact_error', data: { ...compact, ...f } };
    }
  }

  /**
   * 压缩失败收尾：记断路器 + 算 final + 按需清未决任务。返回 { error, final } 供
   * 调用方 yield compact_error 用（普通方法不能 yield）。
   * - final=true（断路器到阈值）→ 彻底放弃，清 _pendingCompact（下轮不再重试同气泡）
   * - final=false → 保留 _pendingCompact，下轮 _beginCompactAttempt 走 attempt++（同气泡重试）
   */
  _fail(compact, msg) {
    this._recordCompactFailure();
    const final = this._compactDisabled;
    if (final) this._endCompactAbandoned();
    return { error: msg, final: final || undefined };
  }

  /**
   * 按每条 assistant(tool_calls) 消息切 group（对齐 CC xXt 的语义，但无需 message.id）。
   *
   * CC 用 message.id 变化判新回合——但 elf-002 无 id，且一个回合有两条 assistant：
   *   一条带 tool_calls（调工具）、一条纯文本（回复）。
   * 所以用"assistant 带 tool_calls = 新回合起点"区分，等价于 CC 的"新 assistant id"。
   *
   * 一个 group = 一条 assistant(tool_calls) + 紧随其后的 tool/user/assistant(文本) 消息，
   * 到下一条 assistant(tool_calls) 为止。开头若无 tool_calls assistant（只有 user），首 group 自成。
   */
  _groupByAssistantTurn() {
    const groups = [];
    let current = [];
    for (const msg of this.messages) {
      const isNewTurn = msg.role === 'assistant' && msg.tool_calls && current.length > 0;
      if (isNewTurn) { groups.push(current); current = [msg]; }
      else { current.push(msg); }
    }
    if (current.length) groups.push(current);
    return groups;
  }

  /** 扫当前 messages 里所有 tool 消息的 tool_call_id（保留后引用的 tool-results 文件留） */
  _referencedToolCallIds() {
    const ids = new Set();
    for (const m of this.messages) {
      if (m.role === 'tool' && m.tool_call_id) ids.add(m.tool_call_id);
    }
    return ids;
  }

  /** 记录一次压缩失败，达到阈值则禁用 */
  _recordCompactFailure() {
    this._compactFailCount++;
    if (this._compactFailCount >= COMPACT_FAIL_THRESHOLD) {
      this._compactDisabled = true;
      const logger = createLogger('message_manager', logFileName);
      logger.warn(`记忆压缩连续失败 ${this._compactFailCount} 次，已禁用自动压缩`);
    }
  }

  /**
   * 解析摘要回复（对齐 Claude Code lL9）
   * - 去掉 <analysis>...</analysis>
   * - 提取 <summary>...</summary> 内容
   * - 返回纯文本（不含标签），失败返回 null
   */
  _parseSummaryResponse(response) {
    if (!response || typeof response !== 'string') return null;
    let text = response;
    // 1. 去掉 <analysis>...</analysis>
    text = text.replace(/<analysis>[\s\S]*?<\/analysis>/g, '');
    // 2. 提取 <summary>...</summary> 内容
    const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
    if (summaryMatch) {
      text = summaryMatch[1] || '';
    }
    // 3. 压缩多余空行
    text = text.replace(/\n\n+/g, '\n\n').trim();
    return text.length > 0 ? text : null;
  }

  // ============ 持久化工具方法 ============

  _ensureToolResultsDir() {
    if (!this.toolResultsDir) return;
    try {
      fs.mkdirSync(this.toolResultsDir, { recursive: true });
    } catch (err) {
      const logger = createLogger('message_manager', logFileName);
      logger.warn(`创建 tool-results 目录失败: ${err.message}`);
    }
  }

  /**
   * 持久化工具结果到磁盘（对齐 Claude Code CX1）
   * - 文件名 = toolCallId.txt
   * - stat 已存在则跳过（不覆盖、不更新 mtime）
   * - 返回 { filepath, originalSize, preview, hasMore }，失败返回 null
   */
  _persistToolResult(toolCallId, content) {
    if (!this.toolResultsDir || !toolCallId) return null;
    this._ensureToolResultsDir();
    const filepath = path.join(this.toolResultsDir, `${toolCallId}.txt`);

    try {
      // 已存在则跳过写
      if (!fs.existsSync(filepath)) {
        fs.writeFileSync(filepath, content, 'utf-8');
      }
    } catch (err) {
      const logger = createLogger('message_manager', logFileName);
      logger.error(`持久化工具结果失败: ${err.message}`);
      return null;
    }

    const { preview, hasMore } = this._extractPreview(content, this.previewLength);
    return {
      filepath,
      originalSize: content.length,
      preview,
      hasMore
    };
  }

  /**
   * 提取预览（对齐 Claude Code iv8）
   * 取前 length 字符；在该范围内后 50% 有换行则在换行处截断，否则硬切
   */
  _extractPreview(content, length) {
    if (!content || content.length <= length) {
      return { preview: content || '', hasMore: false };
    }
    const slice = content.slice(0, length);
    const newlineIdx = slice.lastIndexOf('\n');
    const cut = newlineIdx > length * 0.5 ? newlineIdx : length;
    return { preview: slice.slice(0, cut), hasMore: true };
  }

  /**
   * 构建 <persisted-output> 替换字符串（对齐 Claude Code IX1，英文）
   */
  _buildPersistedOutput(meta) {
    return [
      '<persisted-output>',
      `Output too large (${this._formatSize(meta.originalSize)}). Full output saved to: ${meta.filepath}`,
      '',
      `Preview (first ${this._formatSize(this.previewLength)}):`,
      meta.preview,
      meta.hasMore ? '...' : '',
      '</persisted-output>'
    ].filter((line, i, arr) => !(line === '' && (i === 0 || i === arr.length - 1))).join('\n');
  }

  /** 字节数 → XX.XKB */
  _formatSize(bytes) {
    const kb = bytes / 1024;
    return `${kb.toFixed(1)}KB`;
  }

  /**
   * override：rewind 后由 agent /reload 调用，从 context.json 重新 _load messages，
   * 并重置 elf-002 特有的进程内累计态。
   *
   * - 断路器 _compactFailCount / _compactDisabled 是进程内累计、不持久化，
   *   回退到快照点应丢弃该点之后的 compact 失败计数，重置回构造态。
   * - tool-results/ 文件由 gateway rewind 整份换回，占位符指向的文件已一致，
   *   无需在此处理。
   * - 阈值类（perToolLimit/budgetWindow 等）来自 config，无需动。
   */
  reloadFromDisk() {
    super.reloadFromDisk();
    this._compactFailCount = 0;
    this._compactDisabled = false;
    this._compactHappened = false;
  }

  /**
   * 清理 tool-results 目录中未被保留消息引用的文件。
   * 保留近期 group 后，近期 group 里的 <persisted-output> 引用的文件必须留，否则引用悬空。
   *
   * @param {Set<string>} keepIds - 保留的 tool_call_id 集合（来自 _referencedToolCallIds）
   */
  _cleanupToolResults(keepIds) {
    if (!this.toolResultsDir) return;
    const logger = createLogger('message_manager', logFileName);
    try {
      if (!fs.existsSync(this.toolResultsDir)) return;
      const files = fs.readdirSync(this.toolResultsDir);
      let deleted = 0;
      for (const file of files) {
        // 文件名格式：<toolCallId>.txt
        const id = file.replace(/\.txt$/, '');
        if (!keepIds || !keepIds.has(id)) {
          try {
            fs.unlinkSync(path.join(this.toolResultsDir, file));
            deleted++;
          } catch (e) { /* 单个文件删除失败不阻塞 */ }
        }
      }
      logger.info(`清理 tool-results: 删 ${deleted} 个孤儿文件, 保留 ${files.length - deleted} 个`);
    } catch (err) {
      logger.warn(`清理 tool-results 目录失败: ${err.message}`);
    }
  }
}
