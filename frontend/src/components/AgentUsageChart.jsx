import React, { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import * as api from '../api/index.js';
import styles from './Dashboard.module.css';

/**
 * 单 agent 用量图(挂在 ConfigDrawer 模型配置 tab 下)。
 *   ⚠️ 初版发挥设计,后续按需求迭代。
 *   - 默认最近 7 天,groupBy=model(看该 agent 各模型消耗)。
 *   - 柱状:时间桶(天/小时)× 模型 堆叠;KPI:区间累计。
 */
const COLORS = ['#4a90d9', '#07c160', '#fa8c16', '#722ed1', '#13c2c2', '#eb2f96', '#52c41a', '#f5222d'];

function dateStr(d) { return d.toISOString().slice(0, 10); }
function tz() { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }

function fmtNum(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1000) return String(v);
  if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0) + 'k';
  return (v / 1_000_000).toFixed(2) + 'M';
}

export default function AgentUsageChart({ agentId }) {
  const [bucket, setBucket] = useState('day');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const end = new Date();
    const start = new Date(Date.now() - 6 * 86400000);
    try {
      const s = await api.getAgentUsage(agentId, {
        from: dateStr(start), to: dateStr(end), tz: tz(), bucket, groupBy: 'model',
      });
      setData(s);
    } catch (e) {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [agentId, bucket]);

  useEffect(() => { load(); }, [load]);

  const bbg = data?.byBucketGroup || { groups: [], buckets: [] };
  const barData = bbg.buckets.map(b => {
    const row = { bucket: b.bucket };
    for (const g of b.groups) row[g.key] = g.total;
    return row;
  });
  const kpi = data?.kpi || {};

  return (
    <div style={{ marginTop: 16 }}>
      <div className={styles.controls}>
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>用量统计(最近 7 天)</span>
          {['day', 'hour'].map(b => (
            <button key={b} className={`${styles.btn} ${bucket === b ? styles.btnActive : ''}`} onClick={() => setBucket(b)}>
              {b === 'day' ? '按天' : '按小时'}
            </button>
          ))}
          <button className={styles.btn} onClick={load} title="刷新">↻</button>
        </div>
      </div>

      <div className={styles.kpiRow}>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>区间累计</div>
          <div className={styles.kpiValue}>{fmtNum(kpi.total)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>输入 prompt</div>
          <div className={styles.kpiValue}>{fmtNum(kpi.prompt)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>输出 completion</div>
          <div className={styles.kpiValue}>{fmtNum(kpi.completion)}</div>
        </div>
      </div>

      <div className={styles.chartBox} style={{ marginTop: 8 }}>
        <div className={styles.chartTitle}>按{bucket === 'day' ? '天' : '小时'}消耗(堆叠按模型)</div>
        {!loading && barData.length === 0 ? (
          <div className={styles.empty}>区间内无用量数据</div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={barData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <XAxis dataKey="bucket" tick={{ fontSize: 11 }} interval={0} angle={bucket === 'hour' ? -30 : 0} textAnchor={bucket === 'hour' ? 'end' : 'middle'} height={bucket === 'hour' ? 50 : 30} />
              <YAxis tick={{ fontSize: 11 }} width={48} tickFormatter={fmtNum} />
              <Tooltip formatter={(v, n) => [fmtNum(v), n]} contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {bbg.groups.map((g, i) => (
                <Bar key={g} dataKey={g} stackId="a" fill={COLORS[i % COLORS.length]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}