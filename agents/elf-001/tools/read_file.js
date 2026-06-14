/**
 * read_file 工具
 * 读取本地文件内容，返回字符串
 */

import fs from 'fs';

const MAX_FILE_LENGTH = 10000;

export const readFileTool = {
  name: 'read_file',
  description: '读取本地文件的内容',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径'
      }
    },
    required: ['path']
  },
  execute: async (args) => {
    const filePath = args.path;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.length > MAX_FILE_LENGTH) {
        return content.slice(0, MAX_FILE_LENGTH) + '\n[文件过长，已截断]';
      }
      return content;
    } catch (err) {
      return `[读取失败: ${err.code || err.message}, path=${filePath}]`;
    }
  }
};