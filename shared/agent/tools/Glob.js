/**
 * Glob 工具
 * 文件名模式匹配，纯文本返回每行 path (type, sizeB)
 * 与 Claude Code Glob 工具对齐
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_EXCLUDES = ['node_modules', '.git'];
const MAX_RESULTS = 500;

export const Glob = {
  name: 'Glob',
  description: "Find files matching a glob pattern. Returns matching file paths with type and size information. Useful for discovering files in a project by naming convention.",

  statusEvent: {
    state: 'searching_files',
    detail: (args) => `正在搜索 ${args.pattern}`,
  },
  callSummary: (args) => args.pattern || '',

  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against. Supports standard glob syntax: ** for recursive matching, * for wildcards, ? for single character, [abc] for character classes.'
      }
    },
    required: ['pattern']
  },

  execute: async (args) => {
    const pattern = args.pattern.replace(/\\/g, '/');
    const rootDir = process.cwd();

    const results = [];
    let truncated = 0;

    // 将 glob 模式转为正则
    const regex = globToRegex(pattern);

    function walk(dir, depth) {
      if (results.length >= MAX_RESULTS) {
        truncated++;
        return;
      }

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // 权限不足等跳过
      }

      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) break;

        // 排除目录
        if (DEFAULT_EXCLUDES.includes(entry.name) && entry.isDirectory()) continue;

        const fullPath = path.join(dir, entry.name);
        // normalize: 统一用 / 分隔符，兼容 Windows + 中文路径
        const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          // 递归进入子目录处理 **
          if (pattern.includes('**')) {
            walk(fullPath, depth + 1);
          } else {
            // 非 ** 模式也递归进入子目录（匹配中间层目录）
            walk(fullPath, depth + 1);
          }
        }

        // 检查匹配
        if (regex.test(relativePath)) {
          if (results.length < MAX_RESULTS) {
            let size = null;
            try {
              size = entry.isFile() ? fs.statSync(fullPath).size : null;
            } catch {
              // ignore
            }

            const type = entry.isDirectory() ? 'directory' : 'file';
            const sizeStr = entry.isFile() ? `, ${formatSize(size)}` : '';
            results.push(`${relativePath} (${type}${sizeStr})`);
          } else {
            truncated++;
          }
        }
      }
    }

    walk(rootDir, 0);

    let output = results.join('\n');
    if (truncated > 0) {
      output += `\n... and ${truncated} more results`;
    }

    return output;
  }
};

/**
 * 将 glob 模式转为正则
 * 支持: **, *, ?, [abc]
 */
/**
 * 将 glob 模式转为正则（以 / 为分隔符）
 * 支持: ** (多层级), * (单层文件名), ? (单字符), [abc] (字符类)
 */
function globToRegex(pattern) {
  let i = 0;
  let regexStr = '';
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      regexStr += '(?:.+/)*';
      i += 2;
      if (pattern[i] === '/') i += 1;
    } else if (ch === '*') {
      regexStr += '[^/]+';
      i += 1;
    } else if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if (ch === '[') {
      // 字符类 [abc] — 原样保留给正则引擎
      const end = pattern.indexOf(']', i);
      if (end !== -1) {
        regexStr += pattern.slice(i, end + 1);
        i = end + 1;
      } else {
        regexStr += '\\[';
        i += 1;
      }
    } else if ('.+^${}()|\\'.includes(ch)) {
      regexStr += '\\' + ch;
      i += 1;
    } else {
      regexStr += ch;
      i += 1;
    }
  }
  return new RegExp('^' + regexStr + '$');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
