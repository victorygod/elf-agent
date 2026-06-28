/**
 * 统一日志模块
 * 同时输出到控制台和日志文件
 * Gateway 日志: logs/gateway.log
 * Agent 日志: logs/agent-{agentId}.log
 * 前端日志: logs/frontend.log
 *
 * 日志滚动: 单文件达到 MAX_SIZE 后按 .1 .2 ... 滚动，最多保留 MAX_FILES 份历史。
 * 滚动检查在完整一行写入文件之后进行，保证每个文件中每一行都是完整日志。
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');

// 单文件大小上限：10MB
const MAX_SIZE = 10 * 1024 * 1024;
// 保留的历史份数（不含当前文件）
const MAX_FILES = 5;

// 确保日志目录存在
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  // 目录已存在或无法创建，忽略
}

// 进程内按文件路径缓存当前写入字节数，避免每条日志都 statSync。
// 同一进程多个 Logger 实例写同一文件时（如 gateway 各模块共用 gateway.log）共享此缓存。
const sizeCache = new Map();

function getCurrentSize(logFile) {
  const cached = sizeCache.get(logFile);
  if (cached != null) return cached;
  let size = 0;
  try {
    size = fs.statSync(logFile).size;
  } catch (e) {
    // 文件不存在，视为 0
    size = 0;
  }
  sizeCache.set(logFile, size);
  return size;
}

/**
 * 滚动日志文件：
 *   删除 logFile.{MAX_FILES}
 *   logFile.{n} -> logFile.{n+1}  (从高到低，避免覆盖)
 *   logFile -> logFile.1
 * 重置 sizeCache，下一次写入会自动创建新的当前文件。
 */
function rotate(logFile) {
  // 删除最旧的历史文件
  const oldest = `${logFile}.${MAX_FILES}`;
  try {
    fs.unlinkSync(oldest);
  } catch (e) {
    // 不存在则忽略
  }
  // 从高到低依次重命名，避免覆盖尚未移动的历史文件
  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const src = `${logFile}.${i}`;
    const dst = `${logFile}.${i + 1}`;
    try {
      fs.renameSync(src, dst);
    } catch (e) {
      // 源文件不存在则跳过
    }
  }
  // 当前文件重命名为 .1
  try {
    fs.renameSync(logFile, `${logFile}.1`);
  } catch (e) {
    // 当前文件不存在则忽略
  }
  // 新的当前文件尚未创建，下次 appendFileSync 会自动创建；缓存置 0
  sizeCache.set(logFile, 0);
}

class Logger {
  constructor(module, logFile) {
    this.module = module;
    this.logFile = logFile || null;
  }

  _format(level, msg) {
    const ts = new Date().toISOString();
    return `[${ts}] [${level}] [${this.module}] ${msg}`;
  }

  _write(level, msg) {
    const line = this._format(level, msg);
    // 控制台输出
    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }
    // 文件输出
    if (this.logFile) {
      const data = line + '\n';
      try {
        // 先完整写入这一行，再检查大小
        fs.appendFileSync(this.logFile, data);
        const size = getCurrentSize(this.logFile) + Buffer.byteLength(data);
        sizeCache.set(this.logFile, size);
        if (size >= MAX_SIZE) {
          rotate(this.logFile);
        }
      } catch (e) {
        // 写入失败时忽略，避免日志系统自身导致崩溃
      }
    }
  }

  info(msg) { this._write('INFO', msg); }
  warn(msg) { this._write('WARN', msg); }
  error(msg) { this._write('ERROR', msg); }
}

/**
 * 创建日志器
 * @param {string} module - 模块名
 * @param {string} [fileName] - 日志文件名（如 'gateway.log', 'agent-elf-001.log'）
 *                              不传则仅输出到控制台
 */
export function createLogger(module, fileName) {
  const logFile = fileName ? path.join(LOG_DIR, fileName) : null;
  return new Logger(module, logFile);
}
