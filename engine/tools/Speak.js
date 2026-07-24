/**
 * Speak —— 群聊发言工具（唯一对外出口）
 *
 * 设计见 docs/chat-room-design.md §2（Speak-as-a-Tool）。
 * - 副本 agent 用它发言：execute 内 fetch room_bus 的 /rooms/:rid/say（X-Speaker-Id: memberName）。
 * - 身份（roomBusUrl / roomId / memberName）从 ctx.agent.runContext 取（对齐现有工具经 ctx.agent 拿运行时信息的约定）。
 * - 私聊 agent 无 runContext 或 mode!=='room' → 返回错误（子 agent 调用也走此分支，§12.3 双保险）。
 * - 整块、非流式：message 是完整字符串，一次性提交。
 */

export const Speak = {
  name: 'Speak',
  description: '在群里发言。整块消息一次性进群聊,所有人和 agent 可见。这是你在群聊里唯一让别人看见的出口——其他内心活动/思考对外不可见。',
  isConcurrencySafe: false, // 发言是"对外动作",串行避免乱序

  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: '要发言的完整消息（一次性整块提交）' },
    },
    required: ['message'],
  },

  callSummary: (args) => `Speak: ${(args?.message || '').slice(0, 30)}`,

  /**
   * 没调 Speak 时的提醒（Speak 协议的业务知识：文案 + 重试阈值）。
   * room 模式下，LLM 一轮只产 content 没调 Speak（群里没人看得见）→ reasoning 注入此 reminder
   * 再给一轮机会；超过阈值仍不调则放弃（返回 null）。
   * @param {number} attempts - 本次前已连续没调 Speak 的次数（0=第一次没调）
   * @returns {string|null} reminder 文本；null=已达阈值，不再提醒、放弃
   */
  missingReminder: (attempts) => {
    if (attempts >= 1) return null;   // 已给过一次机会仍不调 → 放弃（阈值=1 次重试）
    return `<system-reminder>\n你刚才输出的文本(content)只在你自己的思考里，群里其他成员/agent 看不到——不调 Speak 就等于没说话。在群聊中公开发言必须调用 Speak 工具(传完整 message)。请现在调用 Speak 工具发言，让群里能看到你的回应。\n</system-reminder>`;
  },

  /**
   * @param {object} args - { message }
   * @param {AbortSignal} [signal]
   * @param {object} ctx - { agent } 主 agent 实例（ToolManager.execute 透传）
   * @returns {Promise<string>} tool_result 给 LLM
   */
  execute: async (args, signal, ctx) => {
    if (signal?.aborted) return 'Error: aborted';

    const message = args?.message;
    if (typeof message !== 'string' || !message.trim()) {
      return 'Error: message 必填且非空';
    }

    const rc = ctx?.agent?.runContext;
    if (!rc || rc.mode !== 'room') {
      // 私聊 agent 或子 agent（无 runContext）调用 → 边界违反,拒绝
      return 'Error: Speak 仅群聊可用';
    }
    if (!rc.roomBusUrl) {
      return 'Error: 缺 roomBusUrl,无法发言';
    }

    try {
      const resp = await fetch(`${rc.roomBusUrl}/say`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': rc.memberName },
        body: JSON.stringify({ content: message }),
        signal,
      });
      if (!resp.ok) {
        return `Error: 发言失败 (room_bus 返回 ${resp.status})`;
      }
      return `已发言`;
    } catch (err) {
      if (err.name === 'AbortError') return 'Error: aborted';
      return `Error: 发言请求失败: ${err.message}`;
    }
  },
};