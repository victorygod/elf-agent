/**
 * Read 工具
 * 读取本地文件内容，cat -n 格式输出，支持 offset/limit 分页
 * 与 Claude Code Read 工具对齐
 */

import fs from 'fs';
import path from 'path';
import { markRead, getReadState } from './read_state.js';

const DEFAULT_LIMIT = 2000;

export const Read = {
  name: 'Read',
  description: "Reads a file from the local filesystem. Returns content in cat -n format (line numbers starting at 1). Supports pagination via offset and limit. Files that don't exist, empty files, and directories return an error.",
  isConcurrencySafe: true,

  statusEvent: {
    state: 'reading_file',
    detail: (args) => `正在读取 ${args.file_path || ''}`,
  },
  callSummary: (args) => args.file_path || '',

  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to read'
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'The line number to start reading from. Only provide if the file is too large to read at once'
      },
      limit: {
        type: 'integer',
        minimum: 0,
        description: 'The number of lines to read. Only provide if the file is too large to read at once.'
      }
    },
    required: ['file_path']
  },

  execute: async (args, signal) => {
    if (signal?.aborted) return 'Error: aborted';
    const filePath = args.file_path;
    const startLine = args.offset || 1;
    const maxLines = args.limit || DEFAULT_LIMIT;

    // 检查路径是否存在
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return `File does not exist: ${filePath}.`;
      }
      if (err.code === 'EACCES') {
        return `Permission denied: ${filePath}.`;
      }
      return `Error reading ${filePath}: ${err.message}.`;
    }

    // 目录
    if (stat.isDirectory()) {
      return `${filePath} is a directory.`;
    }

    // 空文件
    if (stat.size === 0) {
      return '';
    }

    const mtimeMs = Math.floor(stat.mtimeMs);

    // L3 短路：已读文件全文重读且 mtime 未变 → 不读盘、不返回内容、不刷 timestamp
    // 对齐 CC file_unchanged 分支（普通重读用 d0c 文案，无 <system-reminder>）
    // 必须在 markRead 之前，此时 readFileState 里还是旧记录
    const priorState = getReadState(filePath);
    if (priorState
        && !priorState.isPartialView
        && !args.offset && !args.limit
        && mtimeMs === Math.floor(priorState.timestamp)) {
      return `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // 如果最后一行是空字符串（文件以换行结尾），去掉
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }

      const totalLines = lines.length;
      const endLine = Math.min(startLine + maxLines - 1, totalLines);
      const selectedLines = lines.slice(startLine - 1, endLine);

      // cat -n 格式：行号 + tab + 内容
      const numbered = selectedLines.map((line, idx) => {
        const lineNum = startLine + idx;
        return `${lineNum}\t${line}`;
      });

      // 读取成功后标记为已读（带完整状态）
      markRead(filePath, {
        content,
        timestamp: mtimeMs,
        offset: args.offset || undefined,
        limit: args.limit || undefined,
      });

      return numbered.join('\n');
    } catch (err) {
      return `Error reading ${filePath}: ${err.message}`;
    }
  }
};
