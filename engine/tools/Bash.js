/**
 * Bash 工具
 * 执行 shell 命令，超时 + 输出缓存/落盘
 * 与 Claude Code Bash 工具对齐
 *
 * 输出处理（对齐 CC TaskOutput 落盘可回读）：
 * - 输出 < PERSIST_THRESHOLD → 直接返回（不落盘）
 * - 输出 ≥ PERSIST_THRESHOLD → 整份落盘临时文件，返回尾部预览 + "Full output saved to: <path>"
 *   模型可用 Read 工具读该 path 取完整输出，不丢失
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const DEFAULT_TIMEOUT = 120000;            // 2 分钟
const MAX_TIMEOUT = 600000;                // 10 分钟
const MAX_OUTPUT = 100 * 1024;             // 内存缓冲上限（返回预览大小）
const PERSIST_THRESHOLD = 30 * 1024;       // 落盘阈值：真实输出超此则落盘整份
const PERSIST_DIR = path.join(os.tmpdir(), 'elf-bash-outputs');

export const Bash = {
  name: 'Bash',
  description: "Executes a bash command and returns its output. Working directory persists between calls. Shell state (env vars, functions) does not persist — the shell is initialized from the user's profile each time.",
  isConcurrencySafe: false,

  statusEvent: {
    state: 'executing_command',
    detail: (args) => `正在执行：${(args.description || args.command || '').substring(0, 50)}`,
  },
  callSummary: (args) => args.description || args.command?.substring(0, 50) || '',

  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute'
      },
      description: {
        type: 'string',
        description: 'Clear, concise description of what this command does in active voice. For simple commands keep it brief (5-10 words). For commands that are harder to parse at a glance, add enough context to clarify what it does.'
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000, default 120000)'
      },
      dangerouslyDisableSandbox: {
        type: 'boolean',
        description: 'Set this to true to dangerously override sandbox mode and run commands without sandboxing.',
        default: false
      }
    },
    required: ['command']
  },

  execute: async (args, signal) => {
    const command = args.command;
    const timeout = Math.min(args.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);

    return new Promise((resolve) => {
      let stdoutBuf = '';              // 返回预览缓冲（≤ MAX_OUTPUT）
      let stderrBuf = '';
      let stdoutAll = '';              // 真实全量（用于落盘判断 + 写盘）
      let stderrAll = '';
      let stdoutActual = 0;            // 真实输出字节数（不受缓冲上限影响）
      let stderrActual = 0;
      let timedOut = false;
      let aborted = false;

      const child = spawn('bash', ['-c', command], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // 超时定时器
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000);
      }, timeout);

      // abort 中断（SIGTERM → 3s → SIGKILL）
      const onAbort = () => {
        if (child.killed) return;
        aborted = true;
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000);
      };
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      // stdout：全量累加（落盘用），预览缓冲截断（返回用）
      child.stdout.on('data', (data) => {
        const str = data.toString();
        stdoutAll += str;
        stdoutActual += Buffer.byteLength(str);
        if (Buffer.byteLength(stdoutBuf) < MAX_OUTPUT) {
          const remaining = MAX_OUTPUT - Buffer.byteLength(stdoutBuf);
          stdoutBuf += str.slice(0, remaining);
        }
      });

      child.stderr.on('data', (data) => {
        const str = data.toString();
        stderrAll += str;
        stderrActual += Buffer.byteLength(str);
        if (Buffer.byteLength(stderrBuf) < MAX_OUTPUT) {
          const remaining = MAX_OUTPUT - Buffer.byteLength(stderrBuf);
          stderrBuf += str.slice(0, remaining);
        }
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }

        const totalActual = stdoutActual + stderrActual;
        const overflowed = totalActual >= PERSIST_THRESHOLD;

        // 超阈值 → 整份落盘，可回读
        let persistNote = '';
        let savedPath = null;
        if (overflowed) {
          savedPath = persistOutput(command, stdoutAll, stderrAll, exitCode);
          if (savedPath) {
            const totalKB = Math.round(totalActual / 1024);
            persistNote = `\n[Output truncated (${totalKB}KB total). Full output saved to: ${savedPath} — use the Read tool to view it.]`;
          }
        }

        if (aborted) {
          resolve(`Exit code null (aborted)\n${stdoutBuf}${stderrBuf}${persistNote}`);
          return;
        }

        if (timedOut) {
          resolve(`Exit code null (timed out after ${timeout}ms)\n${stdoutBuf}${stderrBuf}${persistNote}`);
          return;
        }

        if (exitCode === 0) {
          resolve(`${stdoutBuf}${persistNote}`);
        } else {
          resolve(`Exit code ${exitCode}\n${stderrBuf}${stdoutBuf}${persistNote}`);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
        resolve(`Exit code null\nFailed to execute command: ${err.message}`);
      });
    });
  }
};

/**
 * 落盘完整输出到临时文件，返回文件路径。失败返回 null。
 */
function persistOutput(command, stdout, stderr, exitCode) {
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    const stamp = Date.now();
    const rand = crypto.randomBytes(3).toString('hex');
    const filePath = path.join(PERSIST_DIR, `bash-${stamp}-${rand}.txt`);
    const banner = [
      `# Command: ${command}`,
      `# Exit code: ${exitCode}`,
      `# Saved: ${new Date(stamp).toISOString()}`,
      '#' + '-'.repeat(60),
      ''
    ].join('\n');
    const body = stderr ? `${banner}=== STDERR ===\n${stderr}\n\n=== STDOUT ===\n${stdout}`
                        : `${banner}${stdout}`;
    fs.writeFileSync(filePath, body, 'utf-8');
    return filePath;
  } catch (e) {
    console.warn(`[Bash] 落盘失败: ${e.message}`);
    return null;
  }
}