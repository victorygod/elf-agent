/**
 * 对话历史管理 + 记忆压缩
 *
 * 管理对话消息数组，持久化到 context.json
 * - compactIfNeeded 为 async generator，触发条件和正常路径事件内聚
 * - 异常不 catch，抛给 Agent 处理
 *
 * 可被子类继承扩展（如 elf-001 的 prefix/suffix 注入）
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger.js';

let logFileName = null;

export function setLogFileName(name) {
  logFileName = name;
}

// 摘要包装前缀（对齐 Claude Code oF6 摘要包装）
const SUMMARY_PREAMBLE =
  'This session is being continued from a previous conversation that ran out of context. ' +
  'The summary below covers the earlier portion of the conversation.\n\n';

export class MessageManager {
  constructor(config) {
    this.messages = [];
    this.systemPrompt = config.systemPrompt || '';
    this.memoryTokenLimit = config.memoryTokenLimit || 8000;

    // 第 4 层压缩提示词（默认空串，各 agent 显式配）
    this.compactSystemPrompt = config.compactSystemPrompt || '';
    this.compactPrompt = config.compactPrompt || '';

    // 持久化：context.json 路径
    this.dataDir = config.dataDir || null;
    this.contextFile = this.dataDir ? path.join(this.dataDir, 'context.json') : null;

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
    if (config.systemPrompt !== undefined) {
      this.systemPrompt = config.systemPrompt;
    }
    if (config.memoryTokenLimit !== undefined) {
      this.memoryTokenLimit = config.memoryTokenLimit;
    }
    if (config.compactSystemPrompt !== undefined) {
      this.compactSystemPrompt = config.compactSystemPrompt;
    }
    if (config.compactPrompt !== undefined) {
      this.compactPrompt = config.compactPrompt;
    }
  }

  addUserMessage(content) {
    this.messages.push({ role: 'user', content });
    this._save();
  }

  addAssistantMessage(content) {
    this.messages.push({ role: 'assistant', content });
    this._save();
  }

  addAssistantToolCalls(toolCalls) {
    this.messages.push({
      role: 'assistant',
      content: null,
      tool_calls: toolCalls
    });
    this._save();
  }

  addToolResult(toolCallId, content) {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content
    });
    this._save();
  }

  getMessagesForLLM() {
    const systemMsg = { role: 'system', content: this.systemPrompt };
    const msgs = this.messages.map(m => ({ ...m }));
    return [systemMsg, ...msgs];
  }

  estimateTokens() {
    const allMessages = this.getMessagesForLLM();
    let total = 0;
    for (const msg of allMessages) {
      if (msg.content) {
        total += msg.content.length;
      }
      if (msg.tool_calls) {
        total += JSON.stringify(msg.tool_calls).length;
      }
    }
    return Math.ceil(total / 4);
  }

  /**
   * 记忆压缩（async generator）——第 4 层压缩（naive 基线版）
   *
   * 设计：基类只提供最朴素可靠的压缩，不依赖模型输出格式（不解析 <summary> 标签）、
   * 无断路器、无二次压缩递归、无成功钩子。这些「CC 复杂特性」由特化子类（如 elf-002）
   * override 本方法自行实现。基类职责 = 超阈值 → 调 LLM 总结 → 前缀 SUMMARY_PREAMBLE 替换历史。
   *
   * - 触发条件：estimateTokens() > memoryTokenLimit
   * - 压缩请求：手拼（不走 getMessagesForLLM，避免子类 override 误触副作用，如 elf-002 预算窗口）
   * - system：compactSystemPrompt 非空用它（临时替换）；留空沿用主 systemPrompt（退化，不发空 system）
   * - 产物：单条摘要 user 消息（SUMMARY_PREAMBLE + LLM 回复），isCompactSummary:true
   * - 失败：LLM 回复空 / 非 Abort 异常 → yield compact_error、不替换 messages、loop 继续（无断路器）
   * - AbortError 抛给 agent 走中断流程
   * - 二次压缩：不递归；仍超阈值靠下一轮 agent loop 顶部再触发（agent reasoning while 多轮往返可达）
   * - 事件：compact_start / compact / compact_error
   */
  async *compactIfNeeded(llmModel, options = {}) {
    if (this.estimateTokens() <= this.memoryTokenLimit) return;

    const logger = createLogger('message_manager', logFileName);
    logger.info(`触发记忆压缩: 估算 ${this.estimateTokens()} tokens > 上限 ${this.memoryTokenLimit}`);

    yield { event: 'compact_start', data: {} };

    try {
      // 手拼压缩请求：[{system}, ...messages, {user:compactPrompt}]
      // system：compactSystemPrompt 非空用它，留空沿用主 systemPrompt（退化，不发空 system）
      const summaryRequest = [
        { role: 'system', content: this.compactSystemPrompt || this.systemPrompt || '' },
        ...this.messages.map(m => ({ ...m })),
        { role: 'user', content: this.compactPrompt }
      ];

      logger.info(`记忆压缩 Request messages: ${JSON.stringify(summaryRequest, null, 2)}`);
      const response = await llmModel.chat(summaryRequest, { enable_thinking: false, ...options });
      logger.info(`记忆压缩 Response: ${response}`);

      // naive：不解析标签，直接用 LLM 回复；空回复视为失败
      const summary = (typeof response === 'string' ? response : '').trim();
      if (!summary) {
        yield { event: 'compact_error', data: { error: '记忆压缩失败：响应为空' } };
        return;
      }

      // 前缀 SUMMARY_PREAMBLE + 回复，替换为单条摘要 user 消息 + 落盘
      this.messages = [{ role: 'user', content: SUMMARY_PREAMBLE + summary, isCompactSummary: true }];
      this._save();

      yield { event: 'compact', data: { tokenEstimate: this.estimateTokens() } };

      // 仍超阈值不本轮递归，留待下一轮 loop 顶部再压
      if (this.estimateTokens() > this.memoryTokenLimit) {
        logger.info(`压缩后仍超阈值 ${this.estimateTokens()} > ${this.memoryTokenLimit}，留待下一轮 loop 顶部再压`);
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      logger.error(`记忆压缩失败: ${err.message}`);
      yield { event: 'compact_error', data: { error: err.message || '记忆压缩失败' } };
    }
  }

  clear() {
    this.messages = [];
    this._save();
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
   */
  _load() {
    if (!this.contextFile) return;
    try {
      if (fs.existsSync(this.contextFile)) {
        const raw = fs.readFileSync(this.contextFile, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.messages = data;
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