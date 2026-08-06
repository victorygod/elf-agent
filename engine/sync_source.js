/**
 * sync_source —— 消息同步的完整能力（进度记录 + 对齐算法 + 拉取 + 投递）
 *
 * 原先散在两处：
 *   - default_agent.js 的 _ensureSync/_advanceCursor/_alignSeq/_seedCursor/_fillGap（私聊，因 runContext.dataDir=null 而"假死"）
 *   - room_agent.js 同名 5 个（Room，活路径）
 * 两者逻辑近乎逐行相同，仅 sync 源 URL 与"收到消息后怎么消费/去重"不同。本文件合一为一份对齐算法，
 * 把"消费 + 去重"通过 onGapMessage 回调交给调用方（私聊用 addUserMessage 不去重；Room 用 _processedSeqs
 * seq 去重 + push buffer + mention 追踪）。
 *
 * 设计要点：
 *   - SyncSource 不内置任何去重，去重全在 onGapMessage 回调内（消费语义随之）。
 *   - cursor 推进统一在 fillGap 循环结束后 advance(toSeq)（等价于原先逐条推进，但更简单）。
 *   - align 的四分支骨架（seed / 回退 / 连续 / 空洞）唯一一份。
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { internalAuthHeaders } from '../shared/internal_auth.js';

// ============================================================
// SyncCursor —— 同步进度记录（从 sync_cursor.js 迁入，零改动）
// ============================================================

const cursorLogger = createLogger('sync-cursor');

/**
 * 记录 agent 已处理的最新 gateway 历史消息 seq（递增序号）。
 * 重启时用作游标，从 gateway 拉取缺失的消息回放。
 * 运行时用于 gap 检测：seq !== lastSeq + 1 → 丢消息 → sync。
 *
 * 文件：<dataDir>/sync_cursor.json
 * schema: { lastSeq: number, lastTs: string }
 */
export class SyncCursor {
  /**
   * @param {string} dataDir - agent 数据目录
   */
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'sync_cursor.json');
    this._cursor = null;
    this._load();
  }

  /**
   * 获取当前 cursor（最后已处理的消息 seq）。null 表示首次启动。
   * @returns {number|null}
   */
  get() {
    if (!this._cursor) return null;
    // 兼容老字段名 lastId（字符串）和 新字段名 lastSeq（数字）
    return this._cursor.lastSeq ?? (this._cursor.lastId ? parseInt(this._cursor.lastId, 10) || null : null);
  }

  /**
   * 推进 cursor 到指定 seq。
   * @param {number} seq
   */
  advance(seq) {
    this._cursor = { lastSeq: seq, lastTs: new Date().toISOString() };
    this._save();
  }

  /**
   * 是否有已有 cursor（非首次启动）
   */
  hasCursor() {
    return !!(this._cursor && (this._cursor.lastSeq != null || this._cursor.lastId));
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this._cursor = JSON.parse(raw);
      }
    } catch (err) {
      this._cursor = null;
      cursorLogger.warn(`读取 sync_cursor 失败: ${err.message}`);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this._cursor, null, 2), 'utf-8');
    } catch (err) {
      // 非致命：写盘失败不影响核心功能，cursor 下次重启时会重试
      cursorLogger.warn(`保存 sync_cursor 失败: ${err.message}`);
    }
  }
}

// ============================================================
// SyncSource —— 对齐算法 + 拉取 + 投递
// ============================================================

/**
 * 消息同步源。持有 SyncCursor，提供 align(seq) 入口：
 *   seq != null → 对齐 cursor（seed / 回退 / 连续 / 空洞四分支），有空洞则从 sync 源拉取，
 *   逐条调 onGapMessage(msg, ctx) 让调用方消费（含去重），循环结束推进 cursor 到 toSeq。
 *
 * onGapMessage 回调契约：
 *   - 签名：(msg, ctx) => void | Promise<void>，ctx = { fromSeq, toSeq }
 *   - 回调内自行决定消费方式 + 去重（私聊：addUserMessage 不去重；Room：_processedSeqs seq 去重 + buffer）
 *   - SyncSource 已做范围过滤（msg.seq ∈ [fromSeq, toSeq]），回调内不必重复判断范围
 *   - 支持 async 回调（内部 await）
 *
 * @param {object} params
 * @param {string} params.dataDir - SyncCursor 落盘目录；为 null/undefined 则不建 cursor（align 全程短路为空操作）
 * @param {string} params.syncSourceUrl - sync 源 base URL（私聊 gatewayUrl + /agents/:id/sync-history；
 *        Room roomBusUrl + /sync-history/:agentId，拼接时再加 /:agentId）；缺省则不发拉取请求
 * @param {string} [params.agentId] - 用于拼接 Room sync URL 的 agentId 段（私聊不需要，因为 syncSourceUrl 已含 full path）
 * @param {function} [params.onGapMessage] - 收到补洞消息的回调
 * @param {boolean} [params.urlIncludesAgentId=false] - syncSourceUrl 是否已含 /:agentId 段。
 *        私聊 syncSourceUrl = `${gw}/agents/:id/sync-history` 已含 → true；Room syncSourceUrl = `${roomBusUrl}/sync-history` 未含 → false（需拼 /:agentId）
 * @param {object} [params.logger] - 可选日志对象（Room 传 _roomLogger，私聊用默认）
 */
export class SyncSource {
  constructor({ dataDir, syncSourceUrl, agentId, onGapMessage, urlIncludesAgentId = false, logger = null } = {}) {
    this._cursor = dataDir ? new SyncCursor(dataDir) : null;
    this._syncSourceUrl = syncSourceUrl || null;
    this._agentId = agentId || null;
    this._onGapMessage = onGapMessage || null;
    this._urlIncludesAgentId = urlIncludesAgentId;
    this._logger = logger;
  }

  /** 暴露 SyncCursor 给调用方（兼容旧测试的 _syncCursor 访问） */
  get cursor() {
    return this._cursor;
  }

  /**
   * 仅 seed cursor（不补洞）。供 start.js 启动时调用：从 sync 源取 latestSeq 置位 cursor，
   * 实际消息留给后续 /observe 实时推送。对齐原 syncMissingHistory 的只 seed 语义。
   */
  async seed() {
    if (!this._cursor) return;
    await this._seed();
  }

  /** 当前 cursor 值（null=未建 / 首次启动） */
  getCursor() {
    return this._cursor?.get() ?? null;
  }

  /** 推进 cursor（含 Number/isNaN 防护，对齐原 _advanceCursor） */
  advance(seq) {
    if (seq == null || !this._cursor) return;
    const n = Number(seq);
    if (!isNaN(n)) this._cursor.advance(n);
  }

  /**
   * 对齐 seq：保证 cursor 存在（seed）且 seq 连续；不连续则填洞。
   * @param {number} seq - 当前收到的消息 seq
   */
  async align(seq) {
    if (seq == null) return;
    if (!this._cursor) return;   // 无 dataDir → 假死，短路（私聊现状）

    let cursor = this._cursor.get();

    // 种子：首次启动，置 cursor
    if (cursor == null) {
      await this._seed();
      cursor = this._cursor.get() ?? seq - 1;
    }

    // 清空历史后 seq 重置（回退）→ 重置 cursor
    if (seq < cursor) {
      this._logger?.info?.(`seq 回退 ${cursor}→${seq}，重置 cursor`);
      this._cursor.advance(seq - 1);
      return;
    }

    // 连续，无需补
    if (seq === cursor + 1) return;

    // 有空洞：从 sync 源拉取 cursor+1..seq-1 的缺失消息
    await this._fillGap(cursor + 1, seq - 1);
  }

  /** 拼接完整 sync URL。私聊 urlIncludesAgentId=true 直接用；Room 拼上 /:agentId */
  _buildSyncUrl(query) {
    if (!this._syncSourceUrl) return null;
    if (this._urlIncludesAgentId) return `${this._syncSourceUrl}?${query}`;
    if (!this._agentId) return null;
    return `${this._syncSourceUrl}/${this._agentId}?${query}`;
  }

  async _seed() {
    const url = this._buildSyncUrl('seed=true');
    if (!url || !this._cursor) return;
    try {
      const resp = await fetch(url, { headers: { ...internalAuthHeaders() } });
      if (resp.ok) {
        const { latestSeq } = await resp.json();
        if (latestSeq != null) this._cursor.advance(latestSeq);
      }
    } catch (err) { cursorLogger.warn(`_seed 拉取失败（非致命）: ${err.message}`); }
  }

  /**
   * 拉取 fromSeq..toSeq 的缺失消息，逐条调 onGapMessage（已做范围过滤），循环结束推进 cursor 到 toSeq。
   */
  async _fillGap(fromSeq, toSeq) {
    if (fromSeq > toSeq) return;
    const url = this._buildSyncUrl(`afterSeq=${fromSeq - 1}`);
    if (!url) return;

    this._logger?.info?.(`填充空洞 seq ${fromSeq}→${toSeq}`);
    try {
      const resp = await fetch(url, { headers: { ...internalAuthHeaders() } });
      if (!resp.ok) return;
      const { messages } = await resp.json();
      if (!messages?.length) {
        this._logger?.info?.(`无缺失消息 seq ${fromSeq}→${toSeq}`);
        return;
      }

      for (const msg of messages) {
        // 范围过滤：sync 源可能返回超出 fromSeq..toSeq 的消息（如 afterSeq=N 返回所有 seq>N）
        if (msg.seq < fromSeq || msg.seq > toSeq) continue;
        // 调用方消费 + 去重（回调内决定是否真处理）
        if (this._onGapMessage) {
          await this._onGapMessage(msg, { fromSeq, toSeq });
        }
      }

      // 循环结束推进 cursor 到 toSeq（避免下次重复拉取）。对齐 RoomAgent 原批量推进语义。
      if (toSeq >= (this._cursor.get() ?? 0)) {
        this._cursor.advance(toSeq);
      }
    } catch (err) {
      this._logger?.warn?.(`填充空洞失败: ${err.message}`);
    }
  }
}