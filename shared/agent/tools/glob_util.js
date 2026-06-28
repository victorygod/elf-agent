/**
 * 共享常量与工具函数
 * 供 Glob / Grep 等基于目录遍历的工具复用，避免逻辑重复
 */

// 默认排除目录 — Glob / Grep 一致
export const DEFAULT_EXCLUDES = ['node_modules', '.git'];

/**
 * 将 glob 模式转为正则（以 / 为分隔符）
 * 支持: ** (多层级), * (单层文件名), ? (单字符), [abc] (字符类)
 */
export function globToRegex(pattern) {
  let i = 0;
  let regexStr = '';
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      regexStr += '(?:.+/)*';
      i += 2;
      if (pattern[i] === '/') i += 1;
    } else if (ch === '*') {
      regexStr += '[^/]*';  // 零个或多个，对齐标准 shell glob 语义
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

/**
 * 人类可读的文件大小
 */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
