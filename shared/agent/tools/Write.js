/**
 * Write 工具
 * 创建或覆盖文件，自动建父目录。覆盖已有文件必须先 Read
 * 与 Claude Code Write 工具对齐
 */

import fs from 'fs';
import path from 'path';
import { hasRead, markRead } from './read_state.js';

export const Write = {
  name: 'Write',
  description: "Writes a file to the local filesystem, overwriting if one exists. Creates parent directories automatically. The file to be overwritten must have been previously Read in this conversation, or the call will fail.",

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

  execute: async (args) => {
    const filePath = args.file_path;
    const content = args.content;

    const exists = fs.existsSync(filePath);

    if (exists) {
      // 覆盖已有文件：必须先 Read 过
      if (!hasRead(filePath)) {
        return `Error: Cannot overwrite ${filePath} — must Read the file first`;
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

    // 写入后标记为已读（之后可直接覆盖/编辑）
    markRead(filePath);

    if (exists) {
      return `File overwritten successfully at: ${filePath} (file state is current in your context — no need to Read it back)`;
    } else {
      return `File created successfully at: ${filePath} (file state is current in your context — no need to Read it back)`;
    }
  }
};
