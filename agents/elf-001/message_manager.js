/**
 * 对话历史管理 + 记忆压缩
 * 上下文持久化到 context.json，与内存状态保持一致
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../../shared/logger.js';

let logFileName = null;

export function setMessageManagerLogFileName(name) {
  logFileName = name;
}

export class MessageManager {
  constructor(config) {
    this.messages = [];
    this.systemPrompt = config.systemPrompt || '';
    this.memoryTokenLimit = config.memoryTokenLimit || 8000;
    this.prefixPrompt = config.prefixPrompt || '';
    this.suffixPrompt = config.suffixPrompt || '';

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
    if (config.prefixPrompt !== undefined) {
      this.prefixPrompt = config.prefixPrompt;
    }
    if (config.suffixPrompt !== undefined) {
      this.suffixPrompt = config.suffixPrompt;
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

    // 对最后一条 user 消息拼接 prefix_prompt / suffix_prompt
    const prefix = this.prefixPrompt || '';
    const suffix = this.suffixPrompt || '';
    if (prefix || suffix) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          msgs[i].content = prefix + msgs[i].content + suffix;
          break;
        }
      }
    }

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

  async compactIfNeeded(llmModel) {
    if (this.estimateTokens() <= this.memoryTokenLimit) {
      return null;
    }

    const logger = createLogger('message_manager', logFileName);
    logger.info(`触发记忆压缩: 估算 ${this.estimateTokens()} tokens > 上限 ${this.memoryTokenLimit}`);

    const compressMessages = [
      ...this.getMessagesForLLM(),
      { role: 'user', content: '请简要总结以上对话的关键信息和待办事项，保留重要细节。' }
    ];

    try {
      logger.info(`记忆压缩 Request messages: ${JSON.stringify(compressMessages, null, 2)}`);
      const summary = await llmModel.chatComplete(compressMessages);
      logger.info(`记忆压缩 Response: ${summary}`);

      this.messages = [
        { role: 'user', content: '请简要总结以上对话的关键信息和待办事项，保留重要细节。' },
        { role: 'assistant', content: summary }
      ];

      this._save();
      return summary;
    } catch (err) {
      logger.error(`记忆压缩失败: ${err.message}`);
      throw err;
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