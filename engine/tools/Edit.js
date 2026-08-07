/**
 * Edit 工具
 * 精准字符串替换，old_string → new_string
 * 与 Claude Code Edit 工具对齐
 */

import fs from 'fs';
import crypto from 'crypto';
import { hasRead, getReadState, markRead, hashContent } from './read_state.js';
import { track as trackFileHistory } from '../../shared/file_history.js';

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

  execute: async (args, signal, ctx) => {
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

    // ★ L2：陈旧检查 + 恢复尝试（对齐 CC errorCode 7 / J7i）
    try {
      const st = getReadState(filePath);
      const mtimeMs = Math.floor(fs.statSync(filePath).mtimeMs);
      if (st && mtimeMs > st.timestamp) {
        if (st.isPartialView) {
          return `Error: File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.`;
        }
        // 全文读取过 → 先比哈希
        const diskHash = crypto.createHash('sha1').update(content).digest('base64');
        if (diskHash !== st.contentHash) {
          // 内容不同 → 尝试 recovery：old_string 在当前磁盘内容中还能匹配吗？
          const escapedCheck = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const diskMatches = content.match(new RegExp(escapedCheck, 'g'));
          const diskCount = diskMatches ? diskMatches.length : 0;
          if (diskCount === 0 || (diskCount > 1 && !replaceAll)) {
            return `Error: File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.`;
          }
          // recovery 成功：content 已是磁盘最新，继续正常流程
        }
        // 哈希相同（touch）→ 静默通过
      }
    } catch (err) {
      // stat 失败时不拦截，让后续流程自然报错
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

    // 文件轴 rewind：写盘前抓"改前内容"快照到 file-history（dataDir 经 ctx.agent 取私聊房；无则跳过，如直跑测试）
    trackFileHistory(ctx?.agent?.messageManager?.dataDir, filePath);

    try {
      fs.writeFileSync(filePath, newContent, 'utf-8');
    } catch (err) {
      return `Error writing ${filePath}: ${err.message}`;
    }

    // 标记已读（带完整状态）
    markRead(filePath, {
      content: newContent,
      timestamp: Math.floor(Date.now()),
    });

    if (replaceAll && count > 1) {
      return `The file ${filePath} has been updated. All occurrences were successfully replaced. (file state is current in your context — no need to Read it back)`;
    }
    return `The file ${filePath} has been updated successfully. (file state is current in your context — no need to Read it back)`;
  }
};
