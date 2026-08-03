/**
 * WriteOutline 工具 —— 写本轮大纲（elf-018 专属，工厂构造，持 agent 实例）
 *
 * 只接受 content，自动落盘到 outline/round-<本轮N>.md。LLM 无需也不能指定路径或轮次，
 * 硬约束"只能写本轮大纲"，避免写错轮次文件、省掉提示词里的路径注入。main loop 用。
 */
import fs from 'fs';
import path from 'path';

export function makeWriteOutline(agent) {
  return {
    name: 'WriteOutline',
    description: '写本轮大纲。只传 content（完整大纲内容，含 剧情节拍 + 数值结算 initial/changes/final），自动落盘到本轮大纲文件；无需也不能指定路径或轮次，只能写本轮。',
    isConcurrencySafe: false,

    statusEvent: { state: 'writing_outline', detail: () => `写本轮大纲 round-${agent._roundNumber}` },
    callSummary: () => `写本轮大纲 round-${agent._roundNumber}`,

    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '本轮大纲完整内容' },
      },
      required: ['content'],
    },

    execute: async (args, signal) => {
      if (signal?.aborted) return 'Error: aborted';
      const content = args && args.content;
      if (typeof content !== 'string') return 'Error: content 必填且为字符串';
      const filePath = path.join(agent._roots.outline, `round-${agent._roundNumber}.md`);
      try {
        fs.writeFileSync(filePath, content, 'utf-8');
      } catch (e) {
        return `Error: 写本轮大纲失败: ${e.message}`;
      }
      return `本轮大纲已写入（round-${agent._roundNumber}）。`;
    },
  };
}