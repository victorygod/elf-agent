/**
 * TurnStream 契约 —— 前后端共享的数据形状定义（纯函数，无 IO / 无 Node API 依赖）
 *
 * 固化"私聊流式 + snapshot + 刷新稳定"的跨端约定。后端 TurnStreamServer 用工厂产 bubble，
 * 前端 TurnStreamClient 用 shouldStartNewBubble 决定续接/新建。 sealed 是唯一的跨端状态约定：
 *   - 已落盘的 bubble → sealed=true（前端不可再往它追加内容）
 *   - 当前未落盘的尾 bubble → 不带 sealed（前端可续接 token）
 * 换项目时 import 同一份，改一处全联动。不靠文档。
 */

/**
 * 落盘/history 已完成的 bubble：标 sealed=true，前端续接时见 sealed→新建下一块。
 * @param {object} bubble 含 content / toolCalls / compactId 等字段
 * @returns {object} 含 sealed:true 的副本
 */
export function sealedBubble(bubble) {
  return { ...(bubble || {}), sealed: true };
}

/**
 * 未落盘的尾 bubble：不带 sealed，前端可续接 token / 更新 tool 状态。
 * @param {string} [content] 当前累积文本
 * @param {Array} [toolCalls] 当前工具调用（含 status）
 * @returns {object} { content, toolCalls, sealed:false }
 */
export function openBubble(content = '', toolCalls) {
  return {
    content,
    toolCalls: toolCalls || [],
    sealed: false,
  };
}

/**
 * 前端续接判定：尾 bubble 为空 / sealed → 新建；未 sealed → 续接当前。
 * 这是契约③（前端按 sealed 决定续接还是新建）的代码定义。
 * @param {object|null} lastBubble activeTurn 的最后一个 bubble（无则 null）
 * @returns {boolean} true=该新建 bubble
 */
export function shouldStartNewBubble(lastBubble) {
  if (!lastBubble) return true;
  return lastBubble.sealed === true;
}

/**
 * snapshot 形状工厂：统一 { turns, activeTurn, streaming, hasMore } 结构 + 默认值。
 * @param {object} parts
 * @returns {object}
 */
export function makeSnapshot({ turns, activeTurn, streaming, hasMore } = {}) {
  return {
    turns: turns || [],
    activeTurn: activeTurn || null,
    streaming: !!streaming,
    hasMore: !!hasMore,
  };
}
