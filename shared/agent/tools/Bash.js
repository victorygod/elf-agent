/**
 * Bash 工具
 * 执行 shell 命令，超时+输出截断
 * 与 Claude Code Bash 工具对齐
 */

import { spawn } from 'child_process';

const DEFAULT_TIMEOUT = 120000;  // 2 分钟
const MAX_TIMEOUT = 600000;      // 10 分钟
const MAX_OUTPUT = 100 * 1024;   // 100KB

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
      let stdout = '';
      let stderr = '';
      let stdoutLen = 0;
      let stderrLen = 0;
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
        // 3 秒后强杀
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 3000);
      }, timeout);

      // abort 中断：signal 触发时杀子进程（对齐 CC execa signal kill，复用 SIGTERM→SIGKILL 模式）
      const onAbort = () => {
        if (child.killed) return;
        aborted = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 3000);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      // stdout
      child.stdout.on('data', (data) => {
        const str = data.toString();
        if (stdoutLen < MAX_OUTPUT) {
          const remaining = MAX_OUTPUT - stdoutLen;
          stdout += str.slice(0, remaining);
          stdoutLen += str.length;
        }
      });

      // stderr
      child.stderr.on('data', (data) => {
        const str = data.toString();
        if (stderrLen < MAX_OUTPUT) {
          const remaining = MAX_OUTPUT - stderrLen;
          stderr += str.slice(0, remaining);
          stderrLen += str.length;
        }
      });

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);

        // 截断标记
        if (stdoutLen > MAX_OUTPUT) {
          stdout += `[truncated: ${stdoutLen - MAX_OUTPUT} bytes omitted]`;
        }
        if (stderrLen > MAX_OUTPUT) {
          stderr += `[truncated: ${stderrLen - MAX_OUTPUT} bytes omitted]`;
        }

        if (aborted) {
          resolve(`Exit code null (aborted)\n${stdout}${stderr}`);
          return;
        }

        if (timedOut) {
          const result = `Exit code null (timed out after ${timeout}ms)\n${stdout}${stderr}`;
          resolve(result);
          return;
        }

        if (exitCode === 0) {
          resolve(stdout);
        } else {
          resolve(`Exit code ${exitCode}\n${stderr}${stdout}`);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(`Exit code null\nFailed to execute command: ${err.message}`);
      });
    });
  }
};
