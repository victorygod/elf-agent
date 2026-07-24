/**
 * Write 工具
 * 创建或覆盖文件，自动建父目录。覆盖已有文件必须先 Read
 * 与 Claude Code Write 工具对齐
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { hasRead, getReadState, markRead, hashContent } from './read_state.js';

export const Write = {
  name: 'Write',
  description: "Writes a file to the local filesystem, overwriting if one exists. Creates parent directories automatically. The file to be overwritten must have been previously Read in this conversation, or the call will fail.",
  isConcurrencySafe: false,

  statusEvent: {
    state: 'writing_file',
    detail: (args) => `正在写入 ${args.file_path}`,
  },
  callSummary: (args) => args.file_path || '',

  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to write (must be absolute, not relative)'
      },
      content: {
        type: 'string',
        description: 'The content to write to the file'
      }
    },
    required: ['file_path', 'content']
  },

  execute: async (args, signal) => {
    if (signal?.aborted) return 'Error: aborted';
    const filePath = args.file_path;
    const content = args.content;

    const exists = fs.existsSync(filePath);

    if (exists) {
      // 覆盖已有文件：必须先 Read 过
      if (!hasRead(filePath)) {
        return `Error: Cannot overwrite ${filePath} — must Read the file first`;
      }
      // ★ L2 陈旧检查：mtime + 哈希比对（对齐 CC errorCode 3）
      const st = getReadState(filePath);
      try {
        const mtimeMs = Math.floor(fs.statSync(filePath).mtimeMs);
        if (mtimeMs > st.timestamp) {
          if (st.isPartialView) {
            return `Error: File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.`;
          }
          const diskContent = fs.readFileSync(filePath, 'utf-8');
          if (hashContent(diskContent) !== st.contentHash) {
            return `Error: File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.`;
          }
          // mtime 变了但哈希相同（如 touch）→ 静默通过
        }
      } catch (err) {
        if (err.code === 'ENOENT') return `Error: File does not exist: ${filePath}`;
        return `Error reading ${filePath}: ${err.message}`;
      }
    } else {
      // 新文件：确保父目录存在
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
          if (err.code === 'EACCES') {
            return `Error: Permission denied creating parent directory for ${filePath}`;
          }
          return `Error: Failed to create directory structure for ${filePath}: ${err.message}`;
        }
      }
    }

    try {
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (err) {
      if (err.code === 'EACCES') {
        return `Error: Permission denied writing to ${filePath}`;
      }
      return `Error: Failed to write ${filePath}: ${err.message}`;
    }

    // 写入后标记为已读（带完整状态）
    markRead(filePath, {
      content,
      timestamp: Math.floor(Date.now()),
    });

    if (exists) {
      return `File overwritten successfully at: ${filePath} (file state is current in your context — no need to Read it back)`;
    } else {
      return `File created successfully at: ${filePath} (file state is current in your context — no need to Read it back)`;
    }
  }
};
