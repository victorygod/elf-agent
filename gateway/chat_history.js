/**
 * 聊天记录持久化模块
 * 数据以 JSONL 格式追加写入 chat/{agentId}/data/history.jsonl（阶段二迁实例级，与 mm dataDir 同层）。
 *   老路径 agents/{agentId}/data/history.jsonl 由 start.js migrateDataDir 首启搬到 chat 路径。
 *   未传 chatDir 时回退 agentsDir（开发直跑兼容）。
 * 只记录 user / assistant 消息，不含 tool / system，不做压缩
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('chat-history', 'gateway.log');

export class ChatHistory {
  /**
   * @param {string} chatDir - chat 实例根目录（chat/<agentId>/data 所在），缺省回退 agentsDir 旧行为
   * @param {string} [agentsDir] - 回退用（开发直跑老路径）
   * @param {object} [opts] - v3 room 模式：{ roomMode:true, roomsDir } → history 写 rooms/<roomId>/history.jsonl
   */
  constructor(chatDir, agentsDir, opts = {}) {
    this.chatDir = chatDir || null;
    this.agentsDir = agentsDir || chatDir || null;
    this._seqMap = new Map(); // agentId → nextSeq
    this.roomMode = opts.roomMode === true;
    this.roomsDir = opts.roomsDir || null;
  }

  /** key(agentId 或 roomId) → history.jsonl 所在目录。
   *  旧私聊：chat/<key>/data；v3 room：rooms/<key>（history 与 room 同层，不套 data/）。 */
  _dataDir(key) {
    if (this.roomMode && this.roomsDir) return path.join(this.roomsDir, key);
    const base = this.chatDir || this.agentsDir;
    return path.join(base, key, 'data');
  }

  _generateId() {
    const ts = Date.now();
    const rand = crypto.randomBytes(2).toString('hex');
    return `msg_${ts}_${rand}`;
  }

  /** 获取 history.jsonl 文件路径，确保目录存在 */
  _getFilePath(agentId) {
    const dataDir = this._dataDir(agentId);
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      logger.error(`创建数据目录失败: ${err.message}`);
    }
    return path.join(dataDir, 'history.jsonl');
  }

  /** 从文件最后一条恢复 seq */
  _loadLastSeq(agentId) {
    try {
      const fp = path.join(this._dataDir(agentId), 'history.jsonl');
      if (!fs.existsSync(fp)) return 0;
      const raw = fs.readFileSync(fp, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return 0;
      const last = JSON.parse(lines[lines.length - 1]);
      return last.seq ?? 0;
    } catch (err) {
      return 0;
    }
  }

  /** 读取全部记录（内部用） */
  _readAll(agentId) {
    const fp = path.join(this._dataDir(agentId), 'history.jsonl');
    if (!fs.existsSync(fp)) return [];
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      return raw.split('\n')
        .filter(line => line.trim())
        .map(line => { try { return JSON.parse(line); } catch (e) { return null; } })
        .filter(Boolean);
    } catch (err) {
      return [];
    }
  }

  /** 返回指定 seq 之后的全部消息 */
  getAfterSeq(agentId, seq = 0) {
    const all = this._readAll(agentId);
    const messages = seq > 0 ? all.filter(m => (m.seq ?? 0) > seq && m.role === 'user') : [];
    const lastMsg = all.length > 0 ? all[all.length - 1] : null;
    return { messages, latestSeq: lastMsg?.seq ?? 0 };
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
    // isMeta 消息不写入 history（不是用户真正说的，不需要持久化到展示层）
    if (extraFields?.isMeta) return null;

    // 分配 seq：从缓存取，缓存没有则从文件恢复
    if (!this._seqMap.has(agentId)) {
      this._seqMap.set(agentId, this._loadLastSeq(agentId) + 1);
    }
    const seq = this._seqMap.get(agentId);
    this._seqMap.set(agentId, seq + 1);

    // 若 extraFields 显式提供 id（压缩记录用 compactId 作记录 id，使流式/落盘气泡身份统一），
    // 则沿用；否则自动生成。compactId 作 id 后，前端按 compactId 跨 turn 定位气泡时，
    // 流式建的气泡与 loadHistory 读出的气泡 id 完全一致。
    const id = extraFields?.id || this._generateId();
    const record = {
      id,
      seq,
      role,
      content,
      ts: new Date().toISOString()
    };
    // 只在有工具调用时才存储 toolCalls 字段
    if (toolCalls && toolCalls.length > 0) {
      record.toolCalls = toolCalls;
    }
    // 合并附加字段（compactSummary / compactError 等）。
    // 注意：extraFields.id 会被 Object.assign 再次写入，但值与上面 id 相同，无害。
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
   * 就地更新压缩记录的状态字段（按 compactId 定位，不 append 新记录）。
   *
   * compact_start 时已 addMessage 写入一条 { compactLoading, compactId } 记录；
   * 后续 compact/compact_error/compact abort 到达时，按 compactId 找到这条记录，
   * 改写它的状态字段（compactSummary/compactError 等），整文件写回。
   *
   * 设计目的：让 history.jsonl 里一个压缩任务始终只有一条记录，与前端"一个气泡就地更新"
   * 完全同源，刷新/流式无 diff。代价是每次压缩完成要读+写整个 history.jsonl——压缩是低频
   * 操作（记忆满才触发），且 agent 单实例访问自己的 jsonl，无并发，开销可接受。
   *
   * @param {string} agentId
   * @param {string} compactId - 要更新的压缩记录 id
   * @param {object} patch - 要合并进记录的字段（compactSummary / compactError / final / compactAttempt 等）
   * @returns {boolean} 是否成功更新（找不到 compactId 对应记录则 false）
   */
  updateCompactRecord(agentId, compactId, patch) {
    if (!compactId) return false;
    const filePath = this._getFilePath(agentId);
    if (!fs.existsSync(filePath)) return false;

    let lines;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      lines = raw.split('\n');
    } catch (err) {
      logger.error(`读取 history.jsonl 失败 (${agentId}): ${err.message}`);
      return false;
    }

    let updated = false;
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.compactId === compactId) {
          // 状态转换：去掉 loading 标志，合并终态字段
          delete rec.compactLoading;
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) delete rec[k];
            else rec[k] = v;
          }
          updated = true;
          out.push(JSON.stringify(rec));
        } else {
          out.push(line);
        }
      } catch (e) {
        // 解析失败的行原样保留
        out.push(line);
      }
    }

    if (!updated) {
      logger.warn(`updateCompactRecord 未命中 compactId (${agentId}): ${compactId}`);
      return false;
    }

    try {
      fs.writeFileSync(filePath, out.join('\n') + '\n', 'utf-8');
    } catch (err) {
      logger.error(`写入 history.jsonl 失败 (${agentId}): ${err.message}`);
      return false;
    }
    return true;
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

    // 压缩记录已在写入时按 compactId 就地更新（updateCompactRecord），
    // 每个压缩任务在 history 里只有一条记录，无需读取时合并。
    const records = allRecords;

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