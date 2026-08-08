/**
 * Mock LLM — 测试用，仅替换 API 请求层
 * 与 LLMModel 完全相同的接口签名和流式行为
 * 不做关键词匹配、不做调用历史，只返回可配置的固定响应
 */
import { estimateUsage } from './usage.js';

export class MockModel {
  /**
   * @param {object} options
   * @param {string} [options.defaultResponse] - 默认纯文本回复，默认 "这是一个模拟回复。"
   * @param {Array} [options.responses] - 按调用序号依次返回的响应列表，超出后回退到 defaultResponse
   *   每个元素: { content?: string, tool_calls?: Array } — content 和 tool_calls 二选一
   *   tool_calls 格式同 OpenAI: [{ id, type:'function', function: { name, arguments } }]
   * @param {number} [options.delayMs=0] - 每个 token 之间的延迟（毫秒），用于测试中断/流式
   */
  constructor(options = {}) {
    this.defaultResponse = options.defaultResponse || '这是一个模拟回复。';
    this.responses = options.responses || [];
    this.delayMs = options.delayMs || 0;
    this._callIndex = 0;
  }

  /**
   * 重置调用计数
   */
  reset() {
    this._callIndex = 0;
  }

  /**
   * 获取下一次调用的预设响应
   */
  _nextResponse() {
    if (this._callIndex < this.responses.length) {
      return this.responses[this._callIndex++];
    }
    this._callIndex++;
    return { content: this.defaultResponse };
  }

  /**
   * 流式调用（模拟），返回 AsyncIterable<chunk>
   * chunk 格式与 LLMModel 完全一致:
   *   { type: 'token', content: '...' } | { type: 'tool_calls', tool_calls: [...] }
   * 支持 options.signal — 收到 abort 信号时抛出 AbortError
   */
  async chatStream(messages, tools, options = {}) {
    const signal = options.signal;
    const onChunk = options.onChunk || (() => {});
    let resp = this._nextResponse();
    // 群聊模拟：未显式配 responses（走 default 文本）且注册的 tools 含 Speak 时，回 Speak tool_call，
    //   而非默认纯文本——贴合真实群 agent 行为（注册 Speak 就该调 Speak 发言），让集成测能验证 Speak→广播全链。
    if (this.responses.length === 0 && Array.isArray(tools) && tools.some(t => t?.function?.name === 'Speak' || t?.name === 'Speak')) {
      resp = {
        content: '',
        tool_calls: [{
          id: `call_mock_speak_${this._callIndex}`,
          type: 'function',
          function: { name: 'Speak', arguments: JSON.stringify({ message: '（mock 在群里的发言）' }) },
        }],
      };
    }
    // model 内部聚合（对齐 LLMModel / LangChain on_llm_end）。中断时挂 partial 供收尾类型B 保留。
    let content = '';
    let toolCalls = [];
    const abort = () => {
      const e = new DOMException('The operation was aborted.', 'AbortError');
      e.partial = { content, toolCalls };   // 已聚合的半成品
      throw e;
    };

    try {
      // 如果有 tool_calls，先逐 token 输出 content（如果有），再 onChunk tool_calls
      if (resp.tool_calls && resp.tool_calls.length > 0) {
        if (resp.content) {
          for (const char of resp.content) {
            if (signal?.aborted) abort();
            if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs));
            content += char;
            await onChunk({ type: 'token', content: char });
          }
        }
        toolCalls = resp.tool_calls;
        await onChunk({ type: 'tool_calls', tool_calls: resp.tool_calls });
      } else {
        // resp.content 显式为 '' 时照空返回（用于测 render 空内容自愈）；缺省（undefined）才回退 default。
        const fullContent = resp.content != null ? resp.content : this.defaultResponse;
        for (const char of fullContent) {
          if (signal?.aborted) abort();
          if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs));
          content += char;
          await onChunk({ type: 'token', content: char });
        }
      }
    } catch (err) {
      // abort 路径：abort() 已挂 partial；非 abort 异常原样抛
      throw err;
    }
    // mock 用量:tokenizer 估算(prompt=消息,completion=生成文本),source=mock。
    //   保证无 API 也能整链路自测用量采集/落盘/SSE(对齐 LLMModel 真实路径)。
    return { usage: estimateUsage(messages, content, { source: 'mock' }), content, toolCalls };
  }

  /**
   * 非流式调用（用于记忆压缩等内部调用）
   * 返回纯文本字符串，与 LLMModel.chat() 一致
   * 支持 options.signal — 收到 abort 信号时抛出 AbortError
   */
  async chat(messages, options = {}) {
    const signal = options.signal;
    if (this.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        }
      });
    }
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const resp = this._nextResponse();
    const contentText = resp.content || this.defaultResponse;
    // 非流式经 onUsage 透出用量(与 LLMModel.chat 对称),供压缩 record 记 mock 用量。
    options.onUsage?.(estimateUsage(messages, contentText, { source: 'mock' }));
    return contentText;
  }
}