/**
 * elf-002 专属 MessageManager
 *
 * 继承 shared 基类，实现三层上下文压缩（对齐 Claude Code 第 1/2/4 层）：
 * - 第 1 层：单工具结果超 perToolLimit → 持久化到磁盘 + content 改写为 <persisted-output>
 * - 第 2 层：单次请求内 fresh 工具结果总量超 budgetWindow → 淘汰最大的持久化
 * - 第 4 层：累计超 memoryTokenLimit → 结构化摘要全量替换为 1 条 user 消息
 *
 * 数据模型：context.json = 内存镜像，持久化即改写 content 并 _save()；
 * 不维护 replacements map，持久化状态靠 content.startsWith('<persisted-output>') 判别。
 *
 * 通过 config.json 的 messageManagerClass 字段激活。
 */

import fs from 'fs';
import path from 'path';
import { MessageManager as BaseMessageManager } from '../../shared/agent/message_manager.js';
import { createLogger } from '../../shared/logger.js';

let logFileName = null;

export function setLogFileName(name) {
  logFileName = name;
}

// Claude Code 原文常量（对齐 oF6 摘要包装前缀）
const SUMMARY_PREAMBLE =
  'This session is being continued from a previous conversation that ran out of context. ' +
  'The summary below covers the earlier portion of the conversation.\n\n';

// 断路器：连续压缩失败达到此阈值后禁用自动压缩
const COMPACT_FAIL_THRESHOLD = 3;

export class MessageManager extends BaseMessageManager {
  constructor(params) {
    super(params);
    this._config = params.config || null;

    // 阈值参数：config 未配时代码兜底，配置覆盖
    this.perToolLimit = this._getThreshold('perToolLimit', 50000);
    this.previewLength = this._getThreshold('previewLength', 2000);
    this.budgetWindow = this._getThreshold('budgetWindow', 200000);

    // 注：compactSystemPrompt/compactPrompt 由基类构造/updateConfig 从 mmParams 读（start.js 装配），
    //    此处不再重复读取。基类 reloadConfig 也会同步更新。

    // 工具结果持久化目录：<dataDir>/tool-results/
    this.toolResultsDir = this.dataDir ? path.join(this.dataDir, 'tool-results') : null;

    // 断路器：进程内状态，不持久化，重启清零
    this._compactFailCount = 0;
    this._compactDisabled = false;
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
    const msgs = this.messages.map(m => ({ ...m }));
    return [systemMsg, ...msgs];
  }

  /**
   * override：纯计算，不调 getMessagesForLLM()，无 budget 副作用
   * 直接读 this.messages + systemPrompt 长度
   */
  estimateTokens() {
    let total = 0;
    if (this.systemPrompt) total += this.systemPrompt.length;
    for (const msg of this.messages) {
      if (msg.content) total += msg.content.length;
      if (msg.tool_calls) total += JSON.stringify(msg.tool_calls).length;
    }
    return Math.ceil(total / 4);
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

  // ============ 第 4 层：结构化摘要压缩 ============

  /**
   * override：async generator，全量替换 messages 为 1 条摘要 user 消息
   * 流程对齐 Claude Code sZ6 + QAq
   */
  async *compactIfNeeded(llmModel, options = {}) {
    if (this._compactDisabled) return;
    if (this.estimateTokens() <= this.memoryTokenLimit) return;

    const logger = createLogger('message_manager', logFileName);
    logger.info(`触发记忆压缩: 估算 ${this.estimateTokens()} tokens > 上限 ${this.memoryTokenLimit}`);

    yield { event: 'compact_start', data: {} };

    try {
      // 1+2. 手拼摘要请求（不走 getMessagesForLLM，避免 budget 误替换）
      const summaryRequest = [
        { role: 'system', content: this.compactSystemPrompt },
        ...this.messages.map(m => ({ ...m })),
        { role: 'user', content: this.compactPrompt }
      ];

      logger.info(`记忆压缩 Request messages: ${JSON.stringify(summaryRequest, null, 2)}`);

      // 3. 调用 LLM，禁用 thinking（options 后置覆盖 extraParams）
      const response = await llmModel.chat(summaryRequest, { enable_thinking: false, ...options });
      logger.info(`记忆压缩 Response: ${response}`);

      // 4. 解析：<analysis> 删除，<summary> 提取并加前缀
      const summary = this._parseSummaryResponse(response);
      if (!summary) {
        // 解析结果为空 → 计入断路器
        this._recordCompactFailure();
        return;
      }

      // 5. 包装摘要（对齐 oF6）
      const wrappedSummary = SUMMARY_PREAMBLE + 'Summary:\n' + summary;

      // 6. 替换消息 + 落盘事务：先 _save，再 _cleanupToolResults
      this.messages = [
        { role: 'user', content: wrappedSummary, isCompactSummary: true }
      ];
      this._save();
      this._cleanupToolResults();

      // 压缩成功，重置断路器
      this._compactFailCount = 0;

      yield { event: 'compact', data: { tokenEstimate: this.estimateTokens() } };

      // 7. 对齐 CC：压一次即返回，不本轮递归。仍超阈值靠下一轮 agent loop 顶部再触发
      // （agent reasoning 的 while 多轮往返保证可达；memoryTokenLimit << 模型上下文窗口，本轮照常发请求不会发爆）。
      if (this.estimateTokens() > this.memoryTokenLimit) {
        logger.info(`压缩后仍超阈值 ${this.estimateTokens()} > ${this.memoryTokenLimit}，留待下一轮 loop 顶部再压`);
      }
    } catch (err) {
      // 异常不由这里 catch 负全部责任：AbortError 抛给 agent；其他错误计断路器
      if (err?.name === 'AbortError') throw err;
      logger.error(`记忆压缩失败: ${err.message}`);
      this._recordCompactFailure();
    }
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
   * 清空 tool-results 目录全部文件（摘要成功后调用，孤儿即删）
   * 先 _save() 已落盘 context.json（无引用），再调本方法删文件
   */
  _cleanupToolResults() {
    if (!this.toolResultsDir) return;
    try {
      fs.rmSync(this.toolResultsDir, { recursive: true, force: true });
      fs.mkdirSync(this.toolResultsDir, { recursive: true });
      const logger = createLogger('message_manager', logFileName);
      logger.info('已清空 tool-results 目录');
    } catch (err) {
      const logger = createLogger('message_manager', logFileName);
      logger.warn(`清空 tool-results 目录失败: ${err.message}`);
    }
  }
}
