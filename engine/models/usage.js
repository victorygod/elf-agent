/**
 * Usage 归一化与估算 —— LLM 用量的统一口径
 *
 * provider 返回的 usage 命名不统一(OpenAI vs Anthropic 原生字段),本模块归一为
 * 标准字段;provider 不返回 usage 时用 tokenizer 估算。供 LLMModel / MockModel 共用,
 * 避免 llm.js/mock.js 各自处理散落、口径漂移。
 *
 * 归一后字段(扁平,落盘直接用):
 *   prompt_tokens / completion_tokens / total_tokens
 *   cached_tokens         — 命中 prompt 缓存(OpenAI prompt_tokens_details.cached_tokens
 *                           | Anthropic cache_read_input_tokens)。价格通常 0.1~0.5x。
 *   reasoning_tokens      — 思维链消耗(含在 completion_tokens 内,OpenAI
 *                           completion_tokens_details.reasoning_tokens)。
 *   cache_creation_tokens — Anthropic 写缓存一次性成本(cache_creation_input_tokens),
 *                           OpenAI 兼容层未必暴露。
 *   source                — provider(真实) | estimate(回退估算) | mock
 */
import { countTokens, countMessageTokens } from '../../shared/tokenizer.js';

/**
 * 把 provider 原始 usage 归一为标准字段。无 usage 返回 null。
 * @param {object} raw - provider 返回的 usage 对象
 * @param {object} [opts]
 * @param {string} [opts.source='provider']
 */
export function normalizeUsage(raw, { source = 'provider' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = raw.prompt_tokens ?? raw.input_tokens ?? 0;
  const completion = raw.completion_tokens ?? raw.output_tokens ?? 0;
  const total = raw.total_tokens ?? (prompt + completion);
  const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? 0;
  const reasoning = raw.completion_tokens_details?.reasoning_tokens ?? 0;
  const cacheCreation = raw.cache_creation_input_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: cached,
    reasoning_tokens: reasoning,
    cache_creation_tokens: cacheCreation,
    source,
  };
}

/**
 * 无 provider usage 时用 tokenizer 估算(prompt=消息数组,completion=生成文本)。
 * 与 message_manager.estimateTokens() 同源(gpt-tokenizer),elf-002 compact 已验证口径可信。
 * completion 的 content 为流式聚合最终文本(取代旧"按 chunk 数"的错误口径)。
 * @param {Array} messages - 发往 LLM 的消息数组
 * @param {string} content - 生成文本
 * @param {object} [opts]
 * @param {string} [opts.source='estimate']
 */
export function estimateUsage(messages, content, { source = 'estimate' } = {}) {
  const prompt = countMessageTokens(messages);
  const completion = countTokens(content);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cached_tokens: 0,
    reasoning_tokens: 0,
    cache_creation_tokens: 0,
    source,
  };
}