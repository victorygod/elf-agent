/**
 * elf-001 专属 MessageManager
 *
 * 继承 shared 基类，扩展 prefix_prompt / suffix_prompt 注入：
 * - 构造时从 config 读取 prefix_prompt / suffix_prompt
 * - getMessagesForLLM() 对最后一条 user 消息拼接前后缀（不发写入记忆）
 * - 热更新时从 config 重读
 *
 * 通过 config.json 的 messageManagerClass 字段激活
 */

import { MessageManager as BaseMessageManager } from '../../shared/agent/message_manager.js';

export class MessageManager extends BaseMessageManager {
  constructor(params) {
    super(params);
    this._config = params.config || null;
    this.prefixPrompt = this._config?.get('prefix_prompt') || '';
    this.suffixPrompt = this._config?.get('suffix_prompt') || '';
  }

  updateConfig(params) {
    super.updateConfig(params);
    if (this._config) {
      this.prefixPrompt = this._config.get('prefix_prompt') || '';
      this.suffixPrompt = this._config.get('suffix_prompt') || '';
    }
  }

  getMessagesForLLM() {
    const msgs = super.getMessagesForLLM();
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
    return msgs;
  }
}