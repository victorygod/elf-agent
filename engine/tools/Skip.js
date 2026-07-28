/**
 * Skip —— 观测式策略下"主动不发言"工具
 *
 * 观测式触发 reasoning 不强制发言。agent 看完 buffer 后若决定不回，调用 Skip 明确放弃本轮，
 * RoomPlugin.shouldBreakAfterTools 见 Skip → 立即 break，不注入 Speak 提醒。
 *
 * 仅在 interaction.strategy ∈ {observe, both} 时由 room_state.js 注册。
 * 私聊 / mention-only agent 不注册，避免多一个无用工具。
 */

export const Skip = {
  name: 'Skip',
  description: '明确不回应时调用本工具',
  isConcurrencySafe: false,

  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: '（可选）不发言原因，仅记录用' },
    },
    required: [],
  },

  callSummary: (args) => `Skip${args?.reason ? `: ${String(args.reason).slice(0, 30)}` : ''}`,

  /**
   * @param {object} args - { reason? }
   * @param {AbortSignal} [signal]
   * @param {object} ctx - { agent }
   * @returns {Promise<string>} tool_result 给 LLM
   */
  execute: async (args, signal, ctx) => {
    if (signal?.aborted) return 'Error: aborted';
    const reason = args?.reason;
    return reason ? `已跳过发言（${String(reason).slice(0, 100)}）` : '已跳过发言';
  },
};