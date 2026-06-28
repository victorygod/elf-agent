/**
 * Edit 工具
 * 精准字符串替换，old_string → new_string
 * 与 Claude Code Edit 工具对齐
 */

import fs from 'fs';
import { hasRead, markRead } from './read_state.js';

export const Edit = {
  name: 'Edit',
  description: "Performs exact string replacement in a file. old_string must include all whitespace, indentation, blank lines, and surrounding code exactly as it appears in the file. old_string must be unique in the file — the edit fails if there is more than one match. The file must have been previously Read in this conversation, or the call will fail.",
  isConcurrencySafe: false,

  statusEvent: {
    state: 'editing_file',
    detail: (args) => `正在编辑 ${args.file_path}`,
  },
  callSummary: (args) => args.file_path || '',

  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to modify'
      },
      old_string: {
        type: 'string',
        description: 'The text to replace'
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with (must be different from old_string)'
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences of old_string (default false)',
        default: false
      }
    },
    required: ['file_path', 'old_string', 'new_string']
  },

  execute: async (args, signal) => {
    if (signal?.aborted) return 'Error: aborted';
    const filePath = args.file_path;
    const oldString = args.old_string;
    const newString = args.new_string;
    const replaceAll = args.replace_all === true;

    // 检查文件是否被 Read 过
    if (!hasRead(filePath)) {
      return `Error: Cannot edit ${filePath} — must Read the file first`;
    }

    // old_string 和 new_string 不能相同
    if (oldString === newString) {
      return 'Error: old_string and new_string are identical';
    }

    // 读取文件内容
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return `Error: File not found: ${filePath}`;
      }
      return `Error reading ${filePath}: ${err.message}`;
    }

    // 统计 old_string 出现次数（转义特殊字符）
    const escaped = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = content.match(new RegExp(escaped, 'g'));
    const count = matches ? matches.length : 0;

    if (count === 0) {
      return `Error: old_string not found in ${filePath}`;
    }

    if (count > 1 && !replaceAll) {
      return `Error: old_string matched ${count} times in ${filePath}. Set replace_all=true to replace all, or provide more context to make it unique.`;
    }

    // 执行替换
    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    try {
      fs.writeFileSync(filePath, newContent, 'utf-8');
    } catch (err) {
      return `Error writing ${filePath}: ${err.message}`;
    }

    // 标记已读
    markRead(filePath);

    if (replaceAll && count > 1) {
      return `The file ${filePath} has been updated successfully (${count} replacements). (file state is current in your context — no need to Read it back)`;
    }
    return `The file ${filePath} has been updated successfully. (file state is current in your context — no need to Read it back)`;
  }
};
