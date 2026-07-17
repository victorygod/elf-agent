/**
 * Speak —— 群聊发言工具（唯一对外出口）
 *
 * 设计见 docs/chat-room-design.md §2（Speak-as-a-Tool）。
 * - 副本 agent 用它发言：execute 内 fetch room_bus 的 /rooms/:rid/member-said。
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
   * @param {object} args - { message }
   * @param {AbortSignal} [signal]
   * @param {object} ctx - { agent } 主 agent 实例（ToolRegistry.execute 透传）
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
      const resp = await fetch(`${rc.roomBusUrl}/member-said`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member: rc.memberName,
          content: message,
        }),
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