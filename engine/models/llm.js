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
export function extractExtraParams(config) {
  const reserved = new Set(['provider', 'base_url', 'auth_token', 'model']);
  const extra = {};
  for (const [key, value] of Object.entries(config)) {
    if (!reserved.has(key)) {
      extra[key] = value;
    }
  }
  return extra;
}

/** 默认请求超时：连接 120 秒，整体 120 秒 */
const DEFAULT_CONNECT_TIMEOUT = 120_000;
const DEFAULT_REQUEST_TIMEOUT = 120_000;

/** 把 streaming 累积的 pendingToolCalls（按 index）排成有序数组。空则返回 []。 */
function finalizeToolCalls(pending) {
  return Object.keys(pending).length === 0 ? [] : Object.keys(pending)
    .sort((a, b) => Number(a) - Number(b))
    .map(k => pending[k]);
}

const MAX_RETRIES = 3;   // 写死：瞬时错误重试 3 次（建连断/5xx/429/超时）。对齐 LangChain maxRetries。

/** 错误是否值得重试：网络/超时/5xx/429 重试；AbortError 与 4xx（非 429，请求本身错）不重试。 */
function isRetryable(err) {
  if (err.name === 'AbortError') return false;
  const m = err.message.match(/LLM API error: (\d+)/);
  if (m) { const s = Number(m[1]); return s === 429 || s >= 500; }
  return true;   // 超时（含"超时"字样）/ 网络瞬断 → 重试
}

/** 指数退避：300ms → 600ms（不打第 4 次，MAX_RETRIES=3 时只用前两次）。 */
function backoff(attempt) {
  return new Promise(r => setTimeout(r, Math.min(300 * 2 ** (attempt - 1), 2000)));
}

/**
 * 重试包装：仅覆盖"建连 + 首响应"阶段（chatStream）/ 整体（chat 非流式）。
 *   - AbortError：立即抛（用户中断，不重试）。
 *   - 4xx（非 429）：立即抛（请求本身错，重试无用）。
 *   - 其余瞬时错误：重试至 MAX_RETRIES 次，退避；全失败抛最后一次。
 * @param {() => Promise<*>} fn - 单次尝试（返回 response 或结果）
 * @param {({attempt:number, maxRetries:number, error:Error, final?:boolean}) => void} [onRetry]
 *        可重试失败回调：重试前（attempt=即将重试的序号）唤一次；耗尽前 final=true。
 * @returns {Promise<*>} fn 的返回值
 */
async function withRetry(fn, onRetry) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      if (attempt < MAX_RETRIES) {
        onRetry?.({ attempt: attempt + 1, maxRetries: MAX_RETRIES, error: err, final: false });
        await backoff(attempt);
      } else {
        onRetry?.({ attempt: MAX_RETRIES, maxRetries: MAX_RETRIES, error: err, final: true });
      }
    }
  }
  throw lastErr;
}

export class LLMModel {
  constructor(config) {
    this.baseUrl = (config.base_url || config.baseUrl || '').trim().replace(/\/+$/, '');
    // config_store / config_loader 产出 snake_case auth_token；同时兼容旧 camelCase / apiKey 别名
    this.authToken = config.auth_token || config.authToken || config.apiKey || '';
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
   * 流式调用 LLM，经 onChunk 推 chunk（传输），return 聚合结果 { usage, content, toolCalls }（业务）。
   *   - onChunk 推 token/tool_calls chunk 给传输层，可返回 Promise（背压：未 drain 则等）。
   *   - content/toolCalls 在 model 内部聚合（对齐 LangChain on_llm_end：正常完成随 return 带出）。
   *   - 中断（AbortError）时把已聚合的 { content, toolCalls } 挂到 err.partial 带出，
   *     供 runAborable finishAborted 做类型B 已生成内容保留（我们比 LangChain 更严的契约——
   *     LangGraph issue #5672：取消时 in-progress state 不保留；我们用 err.partial 保留）。
   */
  async chatStream(messages, tools, options = {}) {
    const onChunk = options.onChunk || (() => {});

    // 校验配置完整性
    if (!this.baseUrl || !this.baseUrl.trim()) {
      throw new Error('LLM 配置不完整：base_url 未设置，请在 Agent 配置中选择模型或配置 API 地址');
    }
    if (!this.authToken || !this.authToken.trim()) {
      throw new Error('LLM 配置不完整：auth_token 未设置，请在 Agent 配置中选择模型或配置 API 密钥');
    }
    if (!this.model || !this.model.trim()) {
      throw new Error('LLM 配置不完整：model 未设置，请在 Agent 配置中选择模型或配置模型名称');
    }

    const url = `${this.baseUrl}/chat/completions`;
    const body = this._body(messages, true, tools, options);

    // model 内部聚合（对齐 LangChain on_llm_end）。中断时挂 err.partial 供收尾保留。
    let content = '';
    let pendingToolCalls = {};
    let completionTokens = 0;

    // 建连 + 首响应阶段包装重试（瞬时错误 3 次）。reader 循环（已吐 token）不在此范围内，防 token 重复。
    let internalController, connectTimer, requestTimer, signal, response;
    let connected = false;
    try {
      response = await withRetry(async (attempt) => {
        internalController = new AbortController();
        connectTimer = setTimeout(() => internalController.abort(), this.connectTimeout);
        requestTimer = setTimeout(() => internalController.abort(), this.requestTimeout);
        connected = false;
        const signals = [internalController.signal];
        if (options.signal) signals.push(options.signal);
        const sig = AbortSignal.any(signals);
        let resp;
        try {
          resp = await fetch(url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body), signal: sig });
          connected = true;
          clearTimeout(connectTimer);
        } catch (err) {
          clearTimeout(connectTimer); clearTimeout(requestTimer);
          if (err.name === 'AbortError') {
            // 外部主动中断：挂 partial 后抛（withRetry 不重试 AbortError）
            if (options.signal?.aborted) { err.partial = { content, toolCalls: null }; }
            throw err;
          }
          throw new Error(connected
            ? `LLM API 请求超时（${this.requestTimeout / 1000}秒，第 ${attempt} 次）`
            : `LLM API 连接超时（${this.connectTimeout / 1000}秒，第 ${attempt} 次）`);
        }
        if (!resp.ok) {
          clearTimeout(requestTimer);
          const text = await resp.text();
          throw new Error(`LLM API error: ${resp.status} ${text}`);   // 4xx 在 withRetry 内不重试，5xx 重试
        }
        return resp;
      }, options.onRetry);
      signal = options.signal;   // 保留外层引用（reader 循环超时仍用 internalController）
    } catch (err) {
      // 重试耗尽或不可重试：原样抛（AbortError 已可能带 partial）
      clearTimeout(requestTimer);
      throw err;
    }

    // 解析 SSE 流 — 每收到数据重置请求超时，避免流式传输中途断连
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 重置超时的辅助函数
    const resetRequestTimer = () => {
      clearTimeout(requestTimer);
      requestTimer = setTimeout(() => internalController.abort(), this.requestTimeout);
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
              completionTokens += 1;
              content += delta.content;
              await onChunk({ type: 'token', content: delta.content });
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
    } catch (err) {
      // reader.read() 中断（AbortError）：挂已聚合的 partial 供收尾类型B 保留
      if (err.name === 'AbortError') {
        err.partial = {
          content,
          toolCalls: finalizeToolCalls(pendingToolCalls),
        };
      }
      throw err;
    } finally {
      clearTimeout(requestTimer);
      reader.releaseLock();
    }

    const toolCalls = finalizeToolCalls(pendingToolCalls);
    if (toolCalls.length > 0) await onChunk({ type: 'tool_calls', tool_calls: toolCalls });
    return { usage: { prompt_tokens: 0, completion_tokens: completionTokens }, content, toolCalls };
  }

  /**
   * 非流式调用（用于记忆压缩等内部调用）
   */
  async chat(messages, options = {}) {
    // 校验配置完整性（与 chatStream 对称——记忆压缩等非流式调用同样不能带着空配置发起请求）
    if (!this.baseUrl || !this.baseUrl.trim()) {
      throw new Error('LLM 配置不完整：base_url 未设置，请在 Agent 配置中选择模型或配置 API 地址');
    }
    if (!this.authToken || !this.authToken.trim()) {
      throw new Error('LLM 配置不完整：auth_token 未设置，请在 Agent 配置中选择模型或配置 API 密钥');
    }
    if (!this.model || !this.model.trim()) {
      throw new Error('LLM 配置不完整：model 未设置，请在 Agent 配置中选择模型或配置模型名称');
    }

    const url = `${this.baseUrl}/chat/completions`;
    const body = this._body(messages, false, null, options);

    // 非流式：整体重试（安全——整体返回，重试不重复 token）
    let requestTimer;
    try {
      return await withRetry(async (attempt) => {
        const internalController = new AbortController();
        const connectTimer = setTimeout(() => internalController.abort(), this.connectTimeout);
        requestTimer = setTimeout(() => internalController.abort(), this.requestTimeout);
        let connected = false;
        const signals = [internalController.signal];
        if (options.signal) signals.push(options.signal);
        const sig = AbortSignal.any(signals);
        let response;
        try {
          response = await fetch(url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body), signal: sig });
          connected = true;
          clearTimeout(connectTimer);
        } catch (err) {
          clearTimeout(connectTimer); clearTimeout(requestTimer);
          if (err.name === 'AbortError') throw err;   // 中断不重试
          throw new Error(connected
            ? `LLM API 请求超时（${this.requestTimeout / 1000}秒，第 ${attempt} 次）`
            : `LLM API 连接超时（${this.connectTimeout / 1000}秒，第 ${attempt} 次）`);
        }
        if (!response.ok) {
          clearTimeout(requestTimer);
          const text = await response.text();
          throw new Error(`LLM API error: ${response.status} ${text}`);
        }
        const data = await response.json();
        clearTimeout(requestTimer);
        return data.choices?.[0]?.message?.content || '';
      }, options.onRetry);
    } catch (err) {
      clearTimeout(requestTimer);
      throw err;
    }
  }
}