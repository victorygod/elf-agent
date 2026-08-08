/**
 * UsageStore —— gateway 进程侧的用量聚合读取(只读)
 *
 * 源:profiles/usage/<agentId>.jsonl(engine 进程 UsageRecorder 写)。本模块只读不写。
 * 读时聚合(不物化 rollup):扫文件 → 按 (from,to,bucket,groupBy) group。
 *   - bucket=day|hour:时间桶(按 tz)。groupBy=model|agent:第二维切片。
 *   - 单 agent 视图(agentSummary)默认按 model 切;全局 summary 默认按 agent 切。
 * 缓存:按查询 key 存结果 + 各文件 mtime 快照;mtime 变(新用量写入)即失效重算。
 *   数据量小(单 agent 日均几千条),全扫毫秒级;缓存不过度(限额 64)。
 *
 * 边界:usage.jsonl 不进 snapshot/rewind(token 是已发生事实,rewind 不回退用量)。
 *       中断记录(aborted:true)同样计入总账。
 */
import fs from 'fs';
import path from 'path';
import { usageDir } from '../shared/profiles_paths.js';

/** 把 ts 按时区格式化为桶键:day → 'YYYY-MM-DD';hour → 'YYYY-MM-DD HH'。 */
function bucketKey(ts, tz, bucket) {
  const opts = { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' };
  if (bucket === 'hour') { opts.hour = '2-digit'; opts.hour12 = false; }
  const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(new Date(ts));
  const g = (t) => parts.find(p => p.type === t)?.value || '';
  let key = `${g('year')}-${g('month')}-${g('day')}`;
  if (bucket === 'hour') key += ` ${g('hour')}`;
  return key;
}

export class UsageStore {
  constructor() {
    this._cache = new Map();   // key → { v, mtimes }
  }

  /** 各 usage 文件 mtime 快照(缓存失效判定)。agentId 给定则只看该文件。 */
  _mtimes(agentId) {
    const dir = usageDir();
    const m = {};
    if (!fs.existsSync(dir)) return m;
    const files = agentId ? [`${agentId}.jsonl`] : fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const fp = path.join(dir, f);
      if (fs.existsSync(fp)) m[f] = fs.statSync(fp).mtimeMs;
    }
    return m;
  }

  /** mtime 失效的缓存包装:命中且 mtime 未变则复用,否则重算。 */
  _cached(key, agentId, compute) {
    const cur = this._mtimes(agentId);
    const ent = this._cache.get(key);
    if (ent && JSON.stringify(ent.mtimes) === JSON.stringify(cur)) return ent.v;
    const v = compute();
    this._cache.set(key, { v, mtimes: cur });
    if (this._cache.size > 64) this._cache.delete(this._cache.keys().next().value);   // LRU 粗比拟
    return v;
  }

  /** 读全部用量记录。agentId 给定则只读该 agent 文件。坏行跳过不抛(不吞错:落盘格式由 recorder 保证)。 */
  _readAll(agentId) {
    const dir = usageDir();
    const out = [];
    if (!fs.existsSync(dir)) return out;
    const files = agentId ? [`${agentId}.jsonl`] : fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const fp = path.join(dir, f);
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* 坏行:忽略单行,不阻断聚合 */ }
      }
    }
    return out;
  }

  /** 全局聚合(admin dashboard)。groupBy 默认 agent。 */
  summary({ from, to, tz = 'UTC', bucket = 'day', groupBy = 'agent' } = {}) {
    const key = `g|${from}|${to}|${tz}|${bucket}|${groupBy}`;
    return this._cached(key, null, () => this._compute(null, { from, to, tz, bucket, groupBy }));
  }

  /** 单 agent 聚合(agent config 模型配置 tab + 标题卡基线)。groupBy 默认 model。 */
  agentSummary(agentId, { from, to, tz = 'UTC', bucket = 'day', groupBy = 'model' } = {}) {
    const key = `a:${agentId}|${from}|${to}|${tz}|${bucket}|${groupBy}`;
    return this._cached(key, agentId, () => this._compute(agentId, { from, to, tz, bucket, groupBy }));
  }

  _compute(agentId, { from, to, tz, bucket, groupBy }) {
    const records = this._readAll(agentId);
    const inRange = (dayStr) => (!from || dayStr >= from) && (!to || dayStr <= to);   // YYYY-MM-DD 字典序可比

    let total = 0, prompt = 0, completion = 0;
    const bySource = {};
    const bucketMap = {};
    const groupMap = {};
    const bucketGroupMap = {};   // 时间桶 → { groupKey → total }(二维:时间 × groupBy)

    for (const r of records) {
      const day = bucketKey(r.ts, tz, 'day');
      if (!inRange(day)) continue;
      const t = r.total_tokens || 0;
      total += t;
      prompt += r.prompt_tokens || 0;
      completion += r.completion_tokens || 0;
      if (r.source) bySource[r.source] = (bySource[r.source] || 0) + t;

      const b = bucketKey(r.ts, tz, bucket);
      const be = bucketMap[b] || (bucketMap[b] = { bucket: b, total: 0, prompt: 0, completion: 0 });
      be.total += t; be.prompt += r.prompt_tokens || 0; be.completion += r.completion_tokens || 0;

      const k = groupBy === 'agent' ? (r.agentId || 'unknown') : (r.model || 'unknown');
      groupMap[k] = (groupMap[k] || 0) + t;
      // 时间桶 × groupBy 二维分布(供柱状按 group 堆叠:时间 × agent/模型)。
      (bucketGroupMap[b] ??= {})[k] = (bucketGroupMap[b][k] || 0) + t;
    }

    const byBucket = Object.values(bucketMap).sort((a, b) => a.bucket.localeCompare(b.bucket));
    const byGroup = Object.entries(groupMap)
      .map(([k, v]) => ({ key: k, total: v, share: total ? v / total : 0 }))
      .sort((a, b) => b.total - a.total);
    const peak = byBucket.reduce((mx, x) => (!mx || x.total > mx.total) ? x : mx, null);

    // 时间桶 × groupBy 二维:group 全集 + 各桶内按 group 的分布(供柱状按 group 堆叠着色)。
    const bgroupSet = new Set();
    for (const bk of Object.keys(bucketGroupMap)) for (const g of Object.keys(bucketGroupMap[bk])) bgroupSet.add(g);
    const groups = [...bgroupSet].sort();
    const byBucketGroup = {
      groups,
      buckets: Object.keys(bucketGroupMap).sort((a, b) => a.localeCompare(b)).map(bk => ({
        bucket: bk,
        groups: groups.map(g => ({ key: g, total: bucketGroupMap[bk][g] || 0 })),
      })),
    };

    return {
      range: { from: from || null, to: to || null, tz, bucket, groupBy },
      kpi: {
        total, prompt, completion, bySource,
        peakBucket: peak ? peak.bucket : null,
        peakBucketTotal: peak ? peak.total : 0,
      },
      byBucket,
      byGroup,
      byBucketGroup,
    };
  }
}