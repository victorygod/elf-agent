/**
 * UsageRecorder —— 单 agent 的用量记录落盘器(engine 进程侧)
 *
 * 职责单一:每条用量 record append 写 profiles/usage/<agentId>.jsonl。真值在磁盘,
 * gateway 侧 UsageStore 读时聚合 + LRU 缓存(mtime 失效)。不缓存内存真值、不订阅广播
 * (SSE 推送由 agent 层 emit usage 事件完成,不经本模块)。
 *
 * append-only,对齐 chat_history.js 范式;同一 agent 的 agent loop 串行,appendFileSync
 * 安全。crash 不丢数据(每次 append 即持久)。usage.jsonl 不进 snapshot/rewind 范围。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { usageDir } from '../shared/profiles_paths.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('usage-recorder', 'gateway.log');

export class UsageRecorder {
  /**
   * @param {object} params
   * @param {string} params.agentId - 归属 agent(必填,决定文件名与聚合维度)
   */
  constructor({ agentId } = {}) {
    if (!agentId) throw new Error('UsageRecorder 需要 agentId');
    this.agentId = agentId;
  }

  _filePath() {
    return path.join(usageDir(), `${this.agentId}.jsonl`);
  }

  /**
   * 记一笔用量。调用方负责提供 model/phase/loop/iteration/usage 数字;
   * id/ts/agentId 由本方法补齐。context_tokens 由调用方传入(agent 收尾时的 estimateTokens 快照)。
   * @param {object} partial - 见 docs token-monitoring-design.md §3.4 schema
   * @returns {object} 完整 record(已落盘)
   */
  record(partial) {
    const rec = {
      id: `u_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
      ts: Date.now(),
      agentId: this.agentId,
      userId: partial.userId ?? null,
      roomId: partial.roomId ?? null,
      phase: partial.phase ?? 'turn',
      loop: partial.loop ?? null,
      iteration: partial.iteration ?? null,
      model: partial.model ?? null,
      prompt_tokens: partial.prompt_tokens ?? 0,
      completion_tokens: partial.completion_tokens ?? 0,
      total_tokens: partial.total_tokens ?? 0,
      cached_tokens: partial.cached_tokens ?? 0,
      reasoning_tokens: partial.reasoning_tokens ?? 0,
      cache_creation_tokens: partial.cache_creation_tokens ?? 0,
      context_tokens: partial.context_tokens ?? null,
      source: partial.source ?? 'estimate',
      aborted: partial.aborted ?? false,
    };
    try {
      const fp = this._filePath();
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.appendFileSync(fp, JSON.stringify(rec) + '\n', 'utf-8');
    } catch (err) {
      logger.error(`写 usage.jsonl 失败 (${this.agentId}): ${err.message}`);
    }
    return rec;
  }
}