/**
 * Grep 工具
 * 文件内容正则搜索，对齐 Claude Code Grep
 * 优先使用 ripgrep (rg)，未安装时回退到纯 Node 实现
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DEFAULT_EXCLUDES, globToRegex } from './glob_util.js';

const MAX_OUTPUT = 100 * 1024;     // 100KB，与 Bash.js 一致
const MAX_FILES = 1000;            // 回退模式下扫描文件上限
const FILE_SIZE_LIMIT = 1024 * 1024; // 1MB：回退模式跳过超限文件
const DEFAULT_TIMEOUT = 30000;      // 30s
const BIN_CHECK_BYTES = 8192;       // 二进制探测窗口

/**
 * 测试钩子：强制走纯 Node 回退引擎（对齐 rg 路径行为）
 * 设为 true 时跳过 ripgrep，即便运行环境装了 rg。
 * @internal 仅供测试使用
 */
let __forceFallback = false;
export function __setForceFallback(v) { __forceFallback = !!v; }

export const Grep = {
  name: 'Grep',
  description: "Search file contents using a regular expression. Returns matching lines with file paths and line numbers. Useful for finding code, definitions, or text across a project. Defaults to searching the current working directory recursively. Uses ripgrep (Rust regex syntax) when available.",
  isConcurrencySafe: true,

  statusEvent: {
    state: 'searching_content',
    detail: (args) => `正在搜索 ${args.pattern || ''}`,
  },
  callSummary: (args) => args.pattern || '',

  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regular expression to search for in file contents. ripgrep uses Rust regex syntax; the fallback uses JavaScript RegExp.'
      },
      path: {
        type: 'string',
        description: 'File or directory to search. Defaults to the current working directory (recursive).'
      },
      glob: {
        type: 'string',
        description: 'Glob pattern to filter which files to search (e.g. "*.js", "src/**/*.{ts,tsx}"). Applied to file paths.'
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: "Set to 'files_with_matches' to return only file paths, 'count' to return match counts per file. Defaults to 'content'.",
        default: 'content'
      },
      '-i': {
        type: 'boolean',
        description: 'Case-insensitive search.',
        default: false
      },
      '-n': {
        type: 'boolean',
        description: 'Include line numbers in content output (default true in content mode; ignored for other modes).',
        default: true
      },
      '-A': {
        type: 'integer',
        minimum: 0,
        description: 'Number of context lines to show after each match.'
      },
      '-B': {
        type: 'integer',
        minimum: 0,
        description: 'Number of context lines to show before each match.'
      },
      '-C': {
        type: 'integer',
        minimum: 0,
        description: 'Number of context lines to show before and after each match (shorthand for -A and -B).'
      }
    },
    required: ['pattern']
  },

  execute: async (args, signal) => {
    if (signal?.aborted) return 'Error: aborted';
    // 1. 参数归一
    const pattern = args.pattern;
    if (typeof pattern !== 'string' || pattern === '') {
      return 'Error: pattern is required and must be a non-empty string';
    }
    const outputMode = ['content', 'files_with_matches', 'count'].includes(args.output_mode)
      ? args.output_mode
      : 'content';
    const searchPath = args.path ? path.resolve(args.path) : process.cwd();
    const showLineNumbers = args['-n'] !== false; // 默认 true

    // 上下文合并：-C 同时设给 -A/-B
    let aCtx = args['-A'];
    let bCtx = args['-B'];
    if (typeof args['-C'] === 'number') {
      aCtx = args['-C'];
      bCtx = args['-C'];
    }

    // 2. 路径检查
    if (!fs.existsSync(searchPath)) {
      return `No such file or directory: ${searchPath}`;
    }

    // 3. 优先 ripgrep（测试钩子可强制回退）
    const rgAvailable = __forceFallback ? false : await whichRg();
    if (rgAvailable) {
      return grepWithRg({ pattern, searchPath, outputMode, glob: args.glob,
        ignoreCase: args['-i'] === true, showLineNumbers, aCtx, bCtx });
    }

    // 4. 回退纯 Node
    return grepFallback({ pattern, searchPath, outputMode, glob: args.glob,
      ignoreCase: args['-i'] === true, showLineNumbers, aCtx, bCtx });
  }
};

// ---------------------------------------------------------------------------
// ripgrep 路径
// ---------------------------------------------------------------------------

/**
 * 构造 rg 命令参数
 */
function buildRgArgs({ pattern, searchPath, outputMode, glob, ignoreCase, showLineNumbers, aCtx, bCtx }) {
  const rgArgs = [];

  if (ignoreCase) rgArgs.push('-i');
  rgArgs.push('--color=never', '--no-heading');

  // content 模式默认带行号；files_with_matches / count 模式 -n 无意义
  if (outputMode === 'content') {
    if (showLineNumbers) rgArgs.push('-n');
    if (typeof aCtx === 'number') rgArgs.push('-A', String(aCtx));
    if (typeof bCtx === 'number') rgArgs.push('-B', String(bCtx));
  } else if (outputMode === 'files_with_matches') {
    rgArgs.push('-l');
  } else if (outputMode === 'count') {
    rgArgs.push('-c');
  }

  if (glob) rgArgs.push('--glob', glob);

  // 排除默认目录：rg 不自动排除 .git 外的目录，显式加 --glob '!xxx'
  for (const ex of DEFAULT_EXCLUDES) {
    rgArgs.push('--glob', `!${ex}`);
  }

  rgArgs.push('--', pattern, searchPath);
  return rgArgs;
}

async function grepWithRg(opts) {
  const rgArgs = buildRgArgs(opts);

  return new Promise((resolve) => {
    let stdout = '';
    let stdoutLen = 0;
    let truncated = 0;
    let timedOut = false;

    const child = spawn('rg', rgArgs, {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000);
    }, DEFAULT_TIMEOUT);

    child.stdout.on('data', (data) => {
      const str = data.toString();
      if (stdoutLen < MAX_OUTPUT) {
        const remaining = MAX_OUTPUT - stdoutLen;
        stdout += str.slice(0, remaining);
        stdoutLen += str.length;
      } else {
        truncated += str.length;
      }
    });

    // 吃掉 stderr，避免 rg 无匹配时的 "No files were searched" 噪声
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (exitCode) => {
      clearTimeout(timer);

      if (timedOut) {
        resolve(`Grep timed out after ${DEFAULT_TIMEOUT}ms${stdout ? '\n' + stdout : ''}`);
        return;
      }

      // rg: 0 = 有匹配, 1 = 无匹配, 2 = 错误
      if (exitCode === 2) {
        // 解析常见错误：非法正则
        if (/invalid flag|regex parse error|unrecognized|error/i.test(stderr)) {
          resolve(`Error: invalid pattern or option: ${stderr.trim() || opts.pattern}`);
        } else {
          resolve(`Error: ${stderr.trim() || 'ripgrep failed (exit 2)'}`);
        }
        return;
      }

      // exitCode 0 或 1 均为正常
      let result = stdout;
      if (truncated > 0) {
        result += `\n... [truncated: ${truncated} bytes omitted]`;
      }
      if (stderr && /warning/i.test(stderr)) {
        result += `\n${stderr.trim()}`;
      }
      resolve(result);
    });

    child.on('error', () => {
      clearTimeout(timer);
      // rg 探测命中但 spawn 失败（罕见，如被 kill）—— 回退
      resolve(grepFallback(opts));
    });
  });
}

// ---------------------------------------------------------------------------
// 纯 Node 回退路径
// ---------------------------------------------------------------------------

function grepFallback({ pattern, searchPath, outputMode, glob, ignoreCase, showLineNumbers, aCtx, bCtx }) {
  // 编译正则
  let regex;
  try {
    regex = new RegExp(pattern, ignoreCase ? 'g' : '');
  } catch (err) {
    return `Error: invalid pattern: ${err.message}`;
  }

  // glob 过滤器
  let globRegex = null;
  if (glob) {
    try {
      globRegex = globToRegex(glob.replace(/\\/g, '/'));
    } catch {
      globRegex = null;
    }
  }

  // 收集待搜索文件
  const files = [];
  let fileScanTruncated = false;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) { fileScanTruncated = true; return; }
      if (DEFAULT_EXCLUDES.includes(entry.name) && entry.isDirectory()) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  // searchPath 可能是文件或目录
  let rootDir;
  try {
    const stat = fs.statSync(searchPath);
    if (stat.isFile()) {
      files.push(searchPath);
      rootDir = path.dirname(searchPath);
    } else {
      rootDir = searchPath;
      walk(searchPath);
    }
  } catch (err) {
    return `Error reading ${searchPath}: ${err.message}`;
  }

  const results = [];        // content 输出行
  const matchFiles = new Set();  // files_with_matches
  const counts = [];         // count: { path, n }
  let outputLen = 0;
  let outTruncated = false;

  for (const filePath of files) {
    if (outTruncated) break;

    // glob 过滤（针对文件相对/全路径）
    if (globRegex) {
      const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
      if (!globRegex.test(rel) && !globRegex.test(filePath.replace(/\\/g, '/'))) continue;
    }

    const fileResult = grepFile({ filePath, regex, ignoreCase, outputMode, showLineNumbers, aCtx, bCtx });
    if (!fileResult) continue;

    const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/') || filePath;

    if (outputMode === 'files_with_matches') {
      matchFiles.add(relPath);
      outputLen += relPath.length + 1;
    } else if (outputMode === 'count') {
      counts.push({ path: relPath, n: fileResult.matchCount });
      outputLen += relPath.length + 8;
    } else {
      // content: fileResult.lines = [{ num, text, type }]
      for (const ln of fileResult.lines) {
        let prefix;
        if (ln.type === 'context') {
          prefix = showLineNumbers ? `${relPath}-${ln.num}-` : `${relPath}-`;
        } else {
          prefix = showLineNumbers ? `${relPath}:${ln.num}:` : `${relPath}:`;
        }
        const line = `${prefix}${ln.text}`;
        if (outputLen + line.length + 1 > MAX_OUTPUT) { outTruncated = true; break; }
        results.push(line);
        outputLen += line.length + 1;
      }
    }
  }

  // 组装输出
  let output;
  if (outputMode === 'files_with_matches') {
    output = Array.from(matchFiles).join('\n');
  } else if (outputMode === 'count') {
    output = counts.map(c => `${c.path}:${c.n}`).join('\n');
  } else {
    output = results.join('\n');
  }

  if (output === '') output = 'No matches found.';

  const notes = [];
  if (outTruncated) notes.push(`... [truncated: exceeded ${MAX_OUTPUT} bytes]`);
  if (fileScanTruncated) notes.push(`... [scanned first ${MAX_FILES} files only]`);
  if (notes.length) output += (output && !output.endsWith('\n') ? '\n' : '') + notes.join('\n');

  return output;
}

/**
 * 在单个文件中搜索
 * @returns {object|null} { matchCount, lines: [{num, text, type}] } 或 null（跳过/无匹配）
 */
function grepFile({ filePath, regex, ignoreCase, outputMode, showLineNumbers, aCtx, bCtx }) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  if (stat.size > FILE_SIZE_LIMIT) return null; // 跳过大文件

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  // 二进制文件探测：前 8KB 含 NUL 字节视为二进制，跳过
  const head = content.slice(0, BIN_CHECK_BYTES);
  let isBinary = false;
  for (let i = 0; i < head.length; i++) {
    if (head.charCodeAt(i) === 0) { isBinary = true; break; }
  }
  if (isBinary) return null;

  const lines = content.split('\n');
  // 去掉末尾空行（文件以换行结尾）
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const matchCount = countMatches(regex, lines, ignoreCase);
  if (matchCount === 0) return null;

  // 非 content 模式无需行细节
  if (outputMode !== 'content') {
    return { matchCount, lines: [] };
  }

  const outLines = [];
  const emitted = new Set(); // 已输出行号，去重上下文重叠

  for (let i = 0; i < lines.length; i++) {
    if (lineMatches(regex, lines[i], ignoreCase)) {
      const start = Math.max(0, i - (bCtx || 0));
      const end = Math.min(lines.length - 1, i + (aCtx || 0));
      for (let j = start; j <= end; j++) {
        if (emitted.has(j)) continue;
        emitted.add(j);
        outLines.push({
          num: j + 1,
          text: lines[j],
          type: j === i ? 'match' : 'context'
        });
      }
    }
  }

  // 无行号模式由调用方按 showLineNumbers 决定前缀，此处保持行序即可

  return { matchCount, lines: outLines };
}

/**
 * 统计匹配行数（按行计，非按匹配次数，与 rg -c 一致）
 */
function countMatches(regex, lines, ignoreCase) {
  let n = 0;
  for (const line of lines) {
    if (lineMatches(regex, line, ignoreCase)) n++;
  }
  return n;
}

function lineMatches(regex, line, ignoreCase) {
  // 重置 lastIndex 防止 g flag 状态泄漏
  const re = new RegExp(regex.source, ignoreCase ? 'i' : '');
  return re.test(line);
}

// ---------------------------------------------------------------------------
// ripgrep 探测
// ---------------------------------------------------------------------------

function whichRg() {
  return new Promise((resolve) => {
    const child = spawn('which', ['rg'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      resolve(code === 0 && out.trim().length > 0);
    });
    child.on('error', () => resolve(false));
  });
}
