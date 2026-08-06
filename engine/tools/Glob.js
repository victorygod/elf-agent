/**
 * Glob 工具
 * 文件名模式匹配，纯文本返回每行 path (type, sizeB)
 * 与 Claude Code Glob 工具对齐
 *
 * 对齐 CC 行为：
 * - 结果按修改时间倒序（最近修改优先）
 * - 默认遵守 .gitignore（递归向上累计各层 .gitignore 规则）
 */

import fs from 'fs';
import path from 'path';
import { DEFAULT_EXCLUDES, globToRegex, formatSize } from './glob_util.js';

const MAX_RESULTS = 500;

export const Glob = {
  name: 'Glob',
  description: "Find files matching a glob pattern. Returns matching file paths with type and size information, sorted by modification time (most recent first). Respects .gitignore. Useful for discovering files in a project by naming convention.",
  isConcurrencySafe: true,

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

  execute: async (args, signal) => {
    if (signal?.aborted) return 'Error: aborted';
    const pattern = args.pattern.replace(/\\/g, '/');
    const rootDir = process.cwd();

    const results = [];
    let truncated = 0;
    const regex = globToRegex(pattern);

    // 预读根 .gitignore（整树共用根级规则；子目录自己的 .gitignore 递归时叠加）
    const rootIgnorePaths = readGitignore(rootDir, null);

    function walk(dir, parentIgnorePaths) {
      if (results.length >= MAX_RESULTS) { truncated++; return; }

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        console.warn(`[Glob] 读目录失败 ${dir}: ${e.message}`);
        return; // 权限不足等跳过
      }

      // 当前目录的 .gitignore 叠加到父级
      const dirIgnorePaths = readGitignore(dir, parentIgnorePaths);

      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) break;

        const name = entry.name;

        // 排除目录级默认（node_modules / .git）
        if (entry.isDirectory() && DEFAULT_EXCLUDES.includes(name)) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

        const isDir = entry.isDirectory();

        // .gitignore 命中 → 跳过（目录命中则整棵子树跳过）
        if (isIgnored(relativePath, isDir, dirIgnorePaths)) continue;

        if (isDir) {
          walk(fullPath, dirIgnorePaths);
        }

        if (regex.test(relativePath)) {
          if (results.length < MAX_RESULTS) {
            let mtimeMs = 0;
            let size = null;
            try {
              const st = fs.statSync(fullPath);
              mtimeMs = Math.floor(st.mtimeMs);
              if (entry.isFile()) size = st.size;
            } catch (e) {
              console.warn(`[Glob] stat 失败 ${fullPath}: ${e.message}`);
            }
            const type = isDir ? 'directory' : 'file';
            const sizeStr = entry.isFile() ? `, ${formatSize(size)}` : '';
            results.push({ relativePath, type, sizeStr, mtimeMs });
          } else {
            truncated++;
          }
        }
      }
    }

    walk(rootDir, rootIgnorePaths);

    // 按修改时间倒序（最近优先），对齐 CC
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let output = results.map(r => `${r.relativePath} (${r.type}${r.sizeStr})`).join('\n');
    if (truncated > 0) {
      output += `\n... and ${truncated} more results`;
    }

    return output;
  }
};

// ---------------------------------------------------------------------------
// .gitignore 支持
// ---------------------------------------------------------------------------

/**
 * 读取 dir/.gitignore，叠加到父级规则返回新数组。
 * 规则数组元素：{ regex, negate }（已按 .gitignore 语义编译）。
 * 父级规则在前、本层在后（后者优先级更高，靠 isIgnored 内遍历顺序保证）。
 */
function readGitignore(dir, parentRules) {
  const rules = parentRules ? parentRules.slice() : [];
  const giPath = path.join(dir, '.gitignore');
  let content;
  try {
    content = fs.readFileSync(giPath, 'utf-8');
  } catch {
    return rules; // 无 .gitignore → 继承父级
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    let pat = line;
    if (pat.startsWith('!')) { negate = true; pat = pat.slice(1); }
    const compiled = compileGitignorePattern(pat);
    if (compiled) rules.push({ regex: compiled, negate });
  }
  return rules;
}

/**
 * 将单条 .gitignore 模式编译为正则（以 / 为分隔符，作用于相对 rootDir 的路径）。
 * 简化实现，支持：行模式、/ 前缀（根锚定）、*、**、?、[abc]、目录尾 / 。
 */
function compileGitignorePattern(pat) {
  let anchored = pat.startsWith('/');
  if (anchored) pat = pat.slice(1);
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.slice(0, -1);

  let i = 0, regexStr = '';
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === '*' && pat[i + 1] === '*') {
      regexStr += '(?:.+/)*';
      i += 2;
      if (pat[i] === '/') i += 1;
    } else if (ch === '*') {
      regexStr += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if (ch === '[') {
      const end = pat.indexOf(']', i);
      if (end !== -1) { regexStr += pat.slice(i, end + 1); i = end + 1; }
      else { regexStr += '\\['; i += 1; }
    } else if ('.+^${}()|\\'.includes(ch)) {
      regexStr += '\\' + ch;
      i += 1;
    } else {
      regexStr += ch;
      i += 1;
    }
  }

  // 非锚定模式可在任意层级匹配 → 允许前缀路径
  const body = anchored ? regexStr : `(?:.+/)?${regexStr}`;
  return new RegExp(dirOnly ? `^${body}/${''}$|^${body}$` : `^${body}$`);
}

/**
 * 判断 relativePath 是否被 .gitignore 规则忽略。
 * 遍历规则（父→子顺序），后到的 negate 可覆盖先到的 ignore。
 */
function isIgnored(relativePath, isDir, rules) {
  let ignored = false;
  for (const r of rules) {
    const m = r.regex.test(relativePath) || r.regex.test(relativePath + (isDir ? '/' : ''));
    if (m) ignored = !r.negate;
  }
  return ignored;
}