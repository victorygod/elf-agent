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

  execute: async (args) => {
    const command = args.command;
    const timeout = Math.min(args.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutLen = 0;
      let stderrLen = 0;
      let timedOut = false;

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

        // 截断标记
        if (stdoutLen > MAX_OUTPUT) {
          stdout += `[truncated: ${stdoutLen - MAX_OUTPUT} bytes omitted]`;
        }
        if (stderrLen > MAX_OUTPUT) {
          stderr += `[truncated: ${stderrLen - MAX_OUTPUT} bytes omitted]`;
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
        resolve(`Exit code null\nFailed to execute command: ${err.message}`);
      });
    });
  }
};
