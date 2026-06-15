/**
 * Mock LLM — 测试用，仅替换 API 请求层
 * 与 LLMModel 完全相同的接口签名和流式行为
 * 不做关键词匹配、不做调用历史，只返回可配置的固定响应
 */
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
  async *chat(messages, tools, options = {}) {
    const signal = options.signal;
    const resp = this._nextResponse();

    // 如果有 tool_calls，先逐 token 输出 content（如果有），再 yield tool_calls
    if (resp.tool_calls && resp.tool_calls.length > 0) {
      if (resp.content) {
        for (const char of resp.content) {
          if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
          if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs));
          yield { type: 'token', content: char };
        }
      }
      yield { type: 'tool_calls', tool_calls: resp.tool_calls };
    } else {
      const content = resp.content || this.defaultResponse;
      for (const char of content) {
        if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        if (this.delayMs > 0) await new Promise(r => setTimeout(r, this.delayMs));
        yield { type: 'token', content: char };
      }
    }
  }

  /**
   * 非流式调用（用于记忆压缩等内部调用）
   * 返回纯文本字符串，与 LLMModel.chatComplete() 一致
   * 支持 options.signal — 收到 abort 信号时抛出 AbortError
   */
  async chatComplete(messages, options = {}) {
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
    return resp.content || this.defaultResponse;
  }
}