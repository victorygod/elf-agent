/**
 * LLM 调用模块
 * 封装 OpenAI 兼容的 /chat/completions API 调用，支持流式输出
 * 使用 Node.js 内置 fetch，不引入 SDK
 *
 * config 字段与 api_key.conf 对齐:
 *   base_url  — API 端点
 *   auth_token — API Key
 *   model     — 模型名
 *   其余字段（如 enable_thinking, thinking 等）原样透传到请求 body
 */

/**
 * 提取额外的请求参数（除 provider/base_url/auth_token/model 外的所有字段）
 */
function extractExtraParams(config) {
  const reserved = new Set(['provider', 'base_url', 'auth_token', 'model']);
  const extra = {};
  for (const [key, value] of Object.entries(config)) {
    if (!reserved.has(key)) {
      extra[key] = value;
    }
  }
  return extra;
}

/** 默认请求超时：连接 10 秒，整体 120 秒 */
const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_REQUEST_TIMEOUT = 120_000;

export class LLMModel {
  constructor(config) {
    this.baseUrl = (config.base_url || config.baseUrl || '').replace(/\/+$/, '');
    this.authToken = config.auth_token || config.apiKey || '';
    this.model = config.model;
    this.extraParams = extractExtraParams(config);
    this.connectTimeout = config.connectTimeout || DEFAULT_CONNECT_TIMEOUT;
    this.requestTimeout = config.requestTimeout || DEFAULT_REQUEST_TIMEOUT;
  }

  /**
   * 构建请求 headers
   */
  _headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.authToken}`
    };
  }

  /**
   * 构建请求 body（合并额外参数）
   */
  _body(messages, stream, tools, options = {}) {
    const body = {
      model: this.model,
      messages,
      stream,
      ...this.extraParams,
      ...options
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));
    }

    return body;
  }

  /**
   * 流式调用 LLM，返回 AsyncIterable<chunk>
   * chunk 格式: { type: 'token', content: '...' } | { type: 'tool_calls', tool_calls: [...] }
   */
  async *chat(messages, tools, options = {}) {
    const url = `${this.baseUrl}/chat/completions`;
    const body = this._body(messages, true, tools, options);

    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), this.connectTimeout);
    let requestTimer = setTimeout(() => controller.abort(), this.requestTimeout);
    let connected = false;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      connected = true;
      clearTimeout(connectTimer);
    } catch (err) {
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      if (err.name === 'AbortError') {
        throw new Error(connected
          ? `LLM API 请求超时（${this.requestTimeout / 1000}秒）`
          : `LLM API 连接超时（${this.connectTimeout / 1000}秒）`);
      }
      throw err;
    }

    if (!response.ok) {
      clearTimeout(requestTimer);
      const text = await response.text();
      throw new Error(`LLM API error: ${response.status} ${text}`);
    }

    // 解析 SSE 流 — 每收到数据重置请求超时，避免流式传输中途断连
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pendingToolCalls = {};

    // 重置超时的辅助函数
    const resetRequestTimer = () => {
      clearTimeout(requestTimer);
      requestTimer = setTimeout(() => controller.abort(), this.requestTimeout);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 收到数据，重置超时
        resetRequestTimer();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              yield { type: 'token', content: delta.content };
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!pendingToolCalls[idx]) {
                  pendingToolCalls[idx] = {
                    id: tc.id || '',
                    type: 'function',
                    function: { name: '', arguments: '' }
                  };
                }
                if (tc.id) pendingToolCalls[idx].id = tc.id;
                if (tc.function?.name) pendingToolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments) pendingToolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    } finally {
      clearTimeout(requestTimer);
      reader.releaseLock();
    }

    if (Object.keys(pendingToolCalls).length > 0) {
      const toolCalls = Object.keys(pendingToolCalls)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => pendingToolCalls[k]);
      yield { type: 'tool_calls', tool_calls: toolCalls };
    }
  }

  /**
   * 非流式调用（用于记忆压缩等内部调用）
   */
  async chatComplete(messages, options = {}) {
    const url = `${this.baseUrl}/chat/completions`;
    const body = this._body(messages, false, null, options);

    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), this.connectTimeout);
    let requestTimer = setTimeout(() => controller.abort(), this.requestTimeout);
    let connected = false;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      connected = true;
      clearTimeout(connectTimer);
    } catch (err) {
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      if (err.name === 'AbortError') {
        throw new Error(connected
          ? `LLM API 请求超时（${this.requestTimeout / 1000}秒）`
          : `LLM API 连接超时（${this.connectTimeout / 1000}秒）`);
      }
      throw err;
    }

    if (!response.ok) {
      clearTimeout(requestTimer);
      const text = await response.text();
      throw new Error(`LLM API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    clearTimeout(requestTimer);
    return data.choices?.[0]?.message?.content || '';
  }
}