/**
 * Token 计数公共能力
 *
 * 全 elf 统一使用 gpt-tokenizer（cl100k_base 编码）做客户端 token 估算，
 * 避免各模块各自 `import 'gpt-tokenizer'` + `encode(...).length` 散落、口径漂移。
 * 将来换编码（如 o200k_base）或接 Anthropic 官方 countTokens API 时，只改本文件。
 *
 * 口径说明：
 * - countTokens(text)：对裸字符串 BPE 计数。用于子串相对差值（如 microcompact
 *   清理前后 content 变化），JSON 包裹对 content / placeholder 是固定开销量级一致可抵消。
 * - countMessageTokens(messages)：对消息数组 JSON.stringify 后整体 BPE 计数。
 *   role / tool_calls(含 arguments 入参) / tool_call_id / tool content / JSON 结构
 *   开销全部计入，用于 estimateTokens()（压缩阈值判定），与实际发往 LLM 的 prompt 口径一致。
 *
 * 注：cl100k_base ≠ Claude 官方 BPE，英文/代码近乎 1:1，中文略低估 ~10%，
 *     阈值校准（memoryTokenLimit / microcompactMinSavings）已按此口径设定。
 */
import { encode } from 'gpt-tokenizer';

/** 对裸字符串计 token 数 */
export function countTokens(text) {
  if (!text) return 0;
  return encode(text).length;
}

/** 对消息数组(JSON 序列化后)计 token 数，含 role/工具入参/JSON 结构开销 */
export function countMessageTokens(messages) {
  if (!messages || messages.length === 0) return 0;
  return encode(JSON.stringify(messages)).length;
}