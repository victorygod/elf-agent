/**
 * 聊天记录持久化模块
 * 数据以 JSONL 格式追加写入 agents/{agentId}/data/history.jsonl
 * 只记录 user / assistant 消息，不含 tool / system，不做压缩
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('chat-history', 'gateway.log');

export class ChatHistory {
  /**
   * @param {string} agentsDir - agents 根目录路径
   */
  constructor(agentsDir) {
    this.agentsDir = agentsDir;
  }

  /**
   * 生成消息 ID：msg_{timestamp}_{random4hex}
   */
  _generateId() {
    const ts = Date.now();
    const rand = crypto.randomBytes(2).toString('hex');
    return `msg_${ts}_${rand}`;
  }

  /**
   * 获取 history.jsonl 文件路径，确保目录存在
   */
  _getFilePath(agentId) {
    const dataDir = path.join(this.agentsDir, agentId, 'data');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      logger.error(`创建数据目录失败: ${err.message}`);
    }
    return path.join(dataDir, 'history.jsonl');
  }

  /**
   * 追加一条聊天记录
   * @param {string} agentId
   * @param {string} role - 'user' 或 'assistant'
   * @param {string} content
   * @param {Array} [toolCalls] - 工具调用信息 [{ name: string, args: { key: string } }]
   * @returns {{ id: string, role: string, content: string, ts: string, toolCalls?: Array }}
   */
  addMessage(agentId, role, content, toolCalls) {
    const id = this._generateId();
    const record = {
      id,
      role,
      content,
      ts: new Date().toISOString()
    };
    // 只在有工具调用时才存储 toolCalls 字段
    if (toolCalls && toolCalls.length > 0) {
      record.toolCalls = toolCalls;
    }

    const filePath = this._getFilePath(agentId);
    try {
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      logger.error(`写入 history.jsonl 失败 (${agentId}): ${err.message}`);
    }

    return record;
  }

  /**
   * 分页获取聊天记录
   * @param {string} agentId
   * @param {number} [limit=30] - 返回条数
   * @param {string} [beforeId] - 游标：返回此 id 之前的消息
   * @returns {{ messages: Array, hasMore: boolean }}
   */
  getRecent(agentId, limit = 30, beforeId) {
    const filePath = this._getFilePath(agentId);

    // 文件不存在则返回空
    if (!fs.existsSync(filePath)) {
      return { messages: [], hasMore: false };
    }

    let allRecords;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      allRecords = raw.split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line); }
          catch (e) { return null; }
        })
        .filter(Boolean);
    } catch (err) {
      logger.error(`读取 history.jsonl 失败 (${agentId}): ${err.message}`);
      return { messages: [], hasMore: false };
    }

    // 如果指定了 beforeId，找到该 id 的位置，取其之前的记录
    let records = allRecords;
    if (beforeId) {
      const idx = allRecords.findIndex(r => r.id === beforeId);
      if (idx > 0) {
        records = allRecords.slice(0, idx);
      } else if (idx === 0) {
        // beforeId 是第一条，之前没有更多
        return { messages: [], hasMore: false };
      } else {
        // beforeId 找不到，忽略游标，返回最新的
        records = allRecords;
      }
    }

    // 取最新的 limit 条，返回时正序排列（最旧在前）
    const total = records.length;
    const start = Math.max(0, total - limit);
    const messages = records.slice(start);
    const hasMore = start > 0;

    return { messages, hasMore };
  }

  /**
   * 清空指定 Agent 的聊天记录
   * @param {string} agentId
   */
  clear(agentId) {
    const filePath = this._getFilePath(agentId);
    try {
      if (fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', 'utf-8');
        logger.info(`已清空 Agent ${agentId} 的聊天记录`);
      }
    } catch (err) {
      logger.error(`清空 history.jsonl 失败 (${agentId}): ${err.message}`);
      throw err;
    }
  }
}