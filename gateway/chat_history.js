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
   * @param {Array} [toolCalls] - 工具调用信息 [{ name, args, status?, message? }]
   * @param {object} [extraFields] - 附加字段（如 compactSummary, compactError）
   * @returns {{ id: string, role: string, content: string, ts: string, toolCalls?: Array }}
   */
  addMessage(agentId, role, content, toolCalls, extraFields) {
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
    // 合并附加字段（compactSummary / compactError 等）
    if (extraFields && Object.keys(extraFields).length > 0) {
      Object.assign(record, extraFields);
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
   * 合并相邻的 compactLoading + compactSummary/compactError 记录
   * compact_start 事件写入 { compactLoading: true }，compact/compact_error 事件
   * 又写入一条独立记录。读取时将它们合并为一条，避免前端同时显示两条消息。
   */
  _mergeCompactRecords(records) {
    if (!records || records.length === 0) return records;
    const result = [];
    let i = 0;
    while (i < records.length) {
      const rec = records[i];
      // 如果当前记录是 compactLoading，检查下一条是否是 compactSummary/compactError
      if (rec.compactLoading && i + 1 < records.length) {
        const next = records[i + 1];
        if (next.compactSummary !== undefined || next.compactError !== undefined) {
          // 合并：保留 compactSummary/compactError，去掉 compactLoading
          const merged = { ...next };
          // 保留 id/ts 用下一条（完成时间更准确）
          result.push(merged);
          i += 2;
          continue;
        }
      }
      result.push(rec);
      i++;
    }
    return result;
  }

  /**
   * 分页获取聊天记录
   * @param {string} agentId
   * @param {number} [limit=30] - 返回条数
   * @param {string} [beforeId] - 游标：返回此 id 之前的消息
   * @param {string} [afterId] - 游标：返回此 id 之后的消息（增量查询）
   * @returns {{ messages: Array, hasMore: boolean }}
   */
  getRecent(agentId, limit = 30, beforeId, afterId) {
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

    // 后处理：合并相邻的 compactLoading + compactSummary/compactError
    // compact_start 写入 { compactLoading: true }，compact/compact_error 又写入一条独立记录，
    // 需要合并为一条，否则前端会显示两条消息（⏳ 和 ✅ 同时出现）
    let records = this._mergeCompactRecords(allRecords);

    // afterId：返回 afterId 之后的所有消息（增量查询）
    if (afterId) {
      const idx = records.findIndex(r => r.id === afterId);
      if (idx >= 0 && idx < records.length - 1) {
        records = records.slice(idx + 1);
      } else {
        return { messages: [], hasMore: false };
      }
      return { messages: records, hasMore: false };
    }

    // beforeId：向前翻页
    if (beforeId) {
      const idx = records.findIndex(r => r.id === beforeId);
      if (idx > 0) {
        records = records.slice(0, idx);
      } else if (idx === 0) {
        return { messages: [], hasMore: false };
      } else {
        // idx === -1：游标在历史中找不到（前端传入了合成 id / 已删消息 id / 错游标）。
        // 不能静默降级为"返回最新 limit 条"——那会和首页重复,导致上滚整页翻倍。
        // 直接返回空,让前端 hasMore=false 停止翻页。
        logger.warn(`beforeId 未命中历史 (${agentId}): ${beforeId}`);
        return { messages: [], hasMore: false };
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