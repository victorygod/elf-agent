/**
 * DNDMessageManager —— DM agent 的 MM。
 *
 * - compactIfNeeded：用 base 异步压缩（compactMode=async），调本类 _doCompact override（lastUser 制：
 *   摘要"最近一条 user 之前"的全部，保留最近 user 及之后）。压缩摘要同时供 render 取用（DNDAgent._compactSummaryText）。
 * - getBaseForLLM override：outline loop 跨轮累积时，"最近一条 user 之前"的 tool_result 超长则
 *   持久化到 dataDir/tool-results/<id>.txt + 替换为 <persisted-output> 占位带 preview（参考 elf-002 L1/microcompact），
 *   最近 user 及之后不剪。assistant（render 正文）保留。
 */
import fs from 'fs';
import path from 'path';
import { MessageManager as BaseMessageManager } from '../../engine/message_manager.js';
import { createLogger } from '../../shared/logger.js';

const PER_TOOL_LIMIT = 50000;   // 对齐 elf-002 perToolLimit
const PREVIEW_LENGTH = 2000;     // 对齐 elf-002 previewLength

export class MessageManager extends BaseMessageManager {
  constructor(params) {
    super(params);
    this.toolResultsDir = this.dataDir ? path.join(this.dataDir, 'tool-results') : null;
  }

  // add* override：每条消息记 _loop（供前端折叠 + 刷新重建）
  addAssistantMessage(content) {
    super.addAssistantMessage(content);
    if (this._currentLoop) this.messages[this.messages.length - 1]._loop = this._currentLoop;
  }
  addAssistantToolCalls(toolCalls) {
    super.addAssistantToolCalls(toolCalls);
    if (this._currentLoop) this.messages[this.messages.length - 1]._loop = this._currentLoop;
  }
  addToolResult(toolCallId, content) {
    super.addToolResult(toolCallId, content);
    if (this._currentLoop) this.messages[this.messages.length - 1]._loop = this._currentLoop;
  }

  /** 最近 user 之前的 tool_result 超长 → 持久化 + <persisted-output> 占位。 */
  getBaseForLLM() {
    const base = super.getBaseForLLM();   // [systemMsg, ...stripped msgs]
    let lastUserIdx = -1;
    for (let i = base.length - 1; i >= 0; i--) {
      if (base[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return base;
    for (let i = 0; i < lastUserIdx; i++) {
      const m = base[i];
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > PER_TOOL_LIMIT) {
        const meta = this._persistToolResult(m.tool_call_id, m.content);
        if (meta) m.content = this._buildPersistedOutput(meta);
      }
    }
    return base;
  }

  _persistToolResult(toolCallId, content) {
    if (!this.toolResultsDir || !toolCallId) return null;
    try {
      if (!fs.existsSync(this.toolResultsDir)) fs.mkdirSync(this.toolResultsDir, { recursive: true });
      const filepath = path.join(this.toolResultsDir, `${toolCallId}.txt`);
      if (!fs.existsSync(filepath)) fs.writeFileSync(filepath, content, 'utf-8');
      const { preview, hasMore } = this._extractPreview(content, PREVIEW_LENGTH);
      return { filepath, originalSize: content.length, preview, hasMore };
    } catch (e) {
      createLogger('message_manager').warn(`持久化 tool-result 失败: ${e.message}`);
      return null;
    }
  }

  _extractPreview(content, length) {
    if (!content || content.length <= length) return { preview: content || '', hasMore: false };
    const slice = content.slice(0, length);
    const newlineIdx = slice.lastIndexOf('\n');
    const cut = newlineIdx > length * 0.5 ? newlineIdx : length;
    return { preview: slice.slice(0, cut), hasMore: true };
  }

  _buildPersistedOutput(meta) {
    return [
      '<persisted-output>',
      `Output too large (${this._formatSize(meta.originalSize)}). Full output saved to: ${meta.filepath}`,
      '',
      `Preview (first ${this._formatSize(PREVIEW_LENGTH)}):`,
      meta.preview,
      meta.hasMore ? '...' : '',
      '</persisted-output>',
    ].filter((line, i, arr) => !(line === '' && (i === 0 || i === arr.length - 1))).join('\n');
  }

  _formatSize(bytes) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }

  // 保留：按最近 user 切（供手动/测试）。
  async _doCompact(llmModel, options = {}) {
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'user' && !m.isMeta && !m.isCompactSummary) { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return super._doCompact(llmModel, options);
    const summaryMessages = this.messages.slice(0, lastUserIdx);
    if (!summaryMessages.length) return null;
    const anchorId = this.messages[lastUserIdx].id;
    const summaryRequest = [
      { role: 'system', content: this.compactSystemPrompt || this.systemPrompt || '' },
      ...summaryMessages.map((m) => ({ ...m })),
      { role: 'user', content: this.compactPrompt },
    ];
    const response = await llmModel.chat(summaryRequest, { enable_thinking: false, ...options });
    const summary = this._parseOrRaw(response);
    if (!summary) return { summary: null, anchorId };
    return { summary, anchorId };
  }
}