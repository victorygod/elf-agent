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
    // 群聊动态 roster prefix（RoomAgent._refreshRoster 写入,发往 LLM 时拼到最近一条 user 开头）。
    this.roomRosterPrefix = '';
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
    // 群聊模式:只拼 roster 动态 prefix,不拼私聊 prefix/suffix（§12.2 1:1 语境不适用群聊）。
    if (this._roomMode) {
      const roster = this.roomRosterPrefix || '';
      if (roster) this._prependToLastUser(msgs, roster, '');
      return msgs;
    }
    const prefix = this.prefixPrompt || '';
    const suffix = this.suffixPrompt || '';
    if (prefix || suffix) {
      this._prependToLastUser(msgs, prefix, suffix);
    }
    return msgs;
  }

  /** 把 prefix/suffix 拼到最近一条 user 消息（不发写入记忆，仅在请求副本上拼）。 */
  _prependToLastUser(msgs, prefix, suffix) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        msgs[i].content = prefix + msgs[i].content + suffix;
        break;
      }
    }
  }
}