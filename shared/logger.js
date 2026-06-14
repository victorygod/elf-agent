/**
 * 统一日志模块
 * 同时输出到控制台和日志文件
 * Gateway 日志: logs/gateway.log
 * Agent 日志: logs/agent-{agentId}.log
 * 前端日志: logs/frontend.log
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');

// 确保日志目录存在
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  // 目录已存在或无法创建，忽略
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
      try {
        fs.appendFileSync(this.logFile, line + '\n');
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