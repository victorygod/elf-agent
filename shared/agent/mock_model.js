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
   */
  constructor(options = {}) {
    this.defaultResponse = options.defaultResponse || '这是一个模拟回复。';
    this.responses = options.responses || [];
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
   */
  async *chat(messages, tools, options = {}) {
    const resp = this._nextResponse();

    // 如果有 tool_calls，先逐 token 输出 content（如果有），再 yield tool_calls
    if (resp.tool_calls && resp.tool_calls.length > 0) {
      if (resp.content) {
        // 模拟流式逐字符输出文本部分
        for (const char of resp.content) {
          yield { type: 'token', content: char };
        }
      }
      yield { type: 'tool_calls', tool_calls: resp.tool_calls };
    } else {
      // 纯文本回复，逐字符模拟流式
      const content = resp.content || this.defaultResponse;
      for (const char of content) {
        yield { type: 'token', content: char };
      }
    }
  }

  /**
   * 非流式调用（用于记忆压缩等内部调用）
   * 返回纯文本字符串，与 LLMModel.chatComplete() 一致
   */
  async chatComplete(messages, options = {}) {
    const resp = this._nextResponse();
    return resp.content || this.defaultResponse;
  }
}