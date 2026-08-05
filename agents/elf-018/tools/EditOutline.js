/**
 * EditOutline 工具 —— 精准编辑本轮大纲（elf-018 专属，工厂构造，持 agent 实例）
 *
 * old_string → new_string 精确替换，语义对齐 Edit（唯一性 / replace_all），但目标锁定本轮大纲、
 * 无需也不能指定路径，不要求先 Read（大纲已落盘本轮文件，直接读改）。outline loop 用（自查发现抄录缺失时回补）。
 */
import fs from 'fs';
import path from 'path';

export function makeEditOutline(agent) {
  return {
    name: 'EditOutline',
    description: '精准编辑本轮大纲。old_string→new_string 精确替换（old_string 须在本轮大纲中唯一，或多处替换时设 replace_all=true）。无需也不能指定路径，只能改本轮大纲。',
    isConcurrencySafe: false,

    statusEvent: { state: 'editing_outline', detail: () => `编辑本轮大纲 round-${agent._roundNumber}` },
    callSummary: () => `改本轮大纲 round-${agent._roundNumber}`,

    parameters: {
      type: 'object',
      properties: {
        old_string: { type: 'string', description: '要替换的文本（须与文件中完全一致，含空白换行）' },
        new_string: { type: 'string', description: '替换为的文本（须与 old_string 不同）' },
        replace_all: { type: 'boolean', description: '替换全部匹配（默认 false）', default: false },
      },
      required: ['old_string', 'new_string'],
    },

    execute: async (args, signal) => {
      if (signal?.aborted) return 'Error: aborted';
      const oldString = args && args.old_string;
      const newString = args && args.new_string;
      const replaceAll = args && args.replace_all === true;
      if (typeof oldString !== 'string' || typeof newString !== 'string') return 'Error: old_string/new_string 必填且为字符串';
      if (oldString === newString) return 'Error: old_string and new_string are identical';

      const filePath = path.join(agent._roots.outline, `round-${agent._roundNumber}.md`);
      let content;
      try { content = fs.readFileSync(filePath, 'utf-8'); }
      catch (e) { return `Error: 读本轮大纲失败: ${e.message}`; }

      const escaped = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const count = (content.match(new RegExp(escaped, 'g')) || []).length;
      if (count === 0) {
        // old_string 未命中时返回大纲全文（cat -n 格式），方便定位上下文
        const lines = content.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        const body = lines.map((line, idx) => `${idx + 1}\t${line}`).join('\n');
        return `Error: old_string not found in 本轮大纲。\n当前大纲内容：\n${body}`;
      }
      if (count > 1 && !replaceAll) return `Error: old_string matched ${count} times in 本轮大纲. Set replace_all=true or provide more context.`;

      const newContent = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
      try { fs.writeFileSync(filePath, newContent, 'utf-8'); }
      catch (e) { return `Error: 写本轮大纲失败: ${e.message}`; }

      return `本轮大纲已更新（round-${agent._roundNumber}，${replaceAll && count > 1 ? `${count} 处` : '1 处'}）。`;
    },
  };
}