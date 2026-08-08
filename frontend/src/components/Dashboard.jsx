import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import * as api from '../api/index.js';
import styles from './Dashboard.module.css';

/**
 * 全局 Token 用量看板(admin,从全局设置入口进)。
 *   ⚠️ 初版发挥设计,后续按需求迭代。
 *   - 时间范围:预设(今日/7天/30天)+ 自定义起止;两图共用。
 *   - 时间桶 bucket=day|hour;第二维 groupBy=agent|model。
 *   - 柱状图:按时间桶(可堆叠 prompt/completion);环形图:按 groupBy 维度占比。
 *   - KPI:总量/prompt/completion/峰值桶 + bySource(诚实标注估算占比)。
 */
const PRESETS = [
  { key: 'today', label: '今日', days: 1 },
  { key: '7d', label: '最近 7 天', days: 7 },
  { key: '30d', label: '最近 30 天', days: 30 },
];

const COLORS = ['#4a90d9', '#07c160', '#fa8c16', '#722ed1', '#13c2c2', '#eb2f96', '#52c41a', '#f5222d', '#2f54eb', '#a0d911'];

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

function pct(share) { return (share * 100).toFixed(1) + '%'; }

export default function Dashboard() {
  const [range, setRange] = useState('7d');
  const [bucket, setBucket] = useState('day');
  const [groupBy, setGroupBy] = useState('agent');
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    let f, t;
    if (custom && from && to) {
      f = from; t = to;
    } else {
      const days = PRESETS.find(p => p.key === range)?.days || 7;
      const end = new Date();
      const start = new Date(Date.now() - (days - 1) * 86400000);
      f = dateStr(start); t = dateStr(end);
    }
    try {
      const s = await api.getUsageSummary({ from: f, to: t, tz: tz(), bucket, groupBy });
      setData(s);
    } catch (e) {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [range, bucket, groupBy, custom, from, to]);

  useEffect(() => { load(); }, [load]);

  const kpi = data?.kpi || {};
  const byBucket = data?.byBucket || [];
  const byGroup = data?.byGroup || [];

  // 柱状数据:时间桶 × groupBy 维度堆叠(按 agent 或模型着色),满足"分时间 × (agent/模型)"二维。
  const bbg = data?.byBucketGroup || { groups: [], buckets: [] };
  const barData = bbg.buckets.map(b => {
    const row = { bucket: b.bucket };
    for (const g of b.groups) row[g.key] = g.total;
    return row;
  });

  // 环形数据
  const pieData = byGroup.map(g => ({ name: g.key, value: g.total, share: g.share }));

  const estimateShare = (() => {
    const src = kpi.bySource || {};
    const est = (src.estimate || 0) + (src.mock || 0);
    return kpi.total ? est / kpi.total : 0;
  })();

  return (
    <div className={styles.dashboard}>
      {/* 控件栏 */}
      <div className={styles.controls}>
        <div className={styles.controlGroup}>
          {!custom ? (
            PRESETS.map(p => (
              <button
                key={p.key}
                className={`${styles.btn} ${range === p.key ? styles.btnActive : ''}`}
                onClick={() => setRange(p.key)}
              >{p.label}</button>
            ))
          ) : (
            <>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={styles.dateInput} />
              <span className={styles.sep}>~</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} className={styles.dateInput} />
            </>
          )}
          <button
            className={`${styles.btn} ${custom ? styles.btnActive : ''}`}
            onClick={() => setCustom(c => !c)}
            title="自定义时间范围"
          >⚙</button>
        </div>
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>粒度</span>
          {['day', 'hour'].map(b => (
            <button
              key={b}
              className={`${styles.btn} ${bucket === b ? styles.btnActive : ''}`}
              onClick={() => setBucket(b)}
            >{b === 'day' ? '按天' : '按小时'}</button>
          ))}
          <span className={styles.controlLabel} style={{ marginLeft: 12 }}>维度</span>
          {['agent', 'model'].map(g => (
            <button
              key={g}
              className={`${styles.btn} ${groupBy === g ? styles.btnActive : ''}`}
              onClick={() => setGroupBy(g)}
            >{g === 'agent' ? '按 Agent' : '按模型'}</button>
          ))}
          <button className={styles.btn} onClick={load} title="刷新">↻</button>
        </div>
      </div>

      {/* KPI */}
      <div className={styles.kpiRow}>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>区间总量</div>
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
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>峰值{bucket === 'day' ? '日' : '时'}</div>
          <div className={styles.kpiValue}>{fmtNum(kpi.peakBucketTotal)}</div>
          <div className={styles.kpiSub}>{kpi.peakBucket || '—'}</div>
        </div>
      </div>

      {estimateShare > 0 && (
        <div className={styles.sourceHint}>
          其中约 {pct(estimateShare)} 为 tokenizer 估算值(provider 未返回精确用量),其余为 provider 真实用量。
        </div>
      )}

      {loading && <div className={styles.loading}>加载中…</div>}

      {/* 图表区 */}
      <div className={styles.charts}>
        <div className={styles.chartBox}>
          <div className={styles.chartTitle}>按{bucket === 'day' ? '天' : '小时'}消耗(堆叠按{groupBy === 'agent' ? 'Agent' : '模型'})</div>
          {!loading && barData.length === 0 ? (
            <div className={styles.empty}>区间内无用量数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={barData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <XAxis dataKey="bucket" tick={{ fontSize: 11 }} interval={0} angle={bucket === 'hour' ? -30 : 0} textAnchor={bucket === 'hour' ? 'end' : 'middle'} height={bucket === 'hour' ? 50 : 30} />
                <YAxis tick={{ fontSize: 11 }} width={48} tickFormatter={fmtNum} />
                <Tooltip formatter={(v, n) => [fmtNum(v), n]} labelFormatter={(l) => `时间桶: ${l}`} contentStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {bbg.groups.map((g, i) => (
                  <Bar key={g} dataKey={g} stackId="a" fill={COLORS[i % COLORS.length]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className={styles.chartBox}>
          <div className={styles.chartTitle}>按{groupBy === 'agent' ? 'Agent' : '模型'}占比</div>
          {!loading && pieData.length === 0 ? (
            <div className={styles.empty}>区间内无用量数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                >
                  {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [fmtNum(v), n]} contentStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* 明细表:groupBy 各项 */}
      {pieData.length > 0 && (
        <div className={styles.detailTable}>
          <div className={styles.chartTitle}>明细(按{groupBy === 'agent' ? 'Agent' : '模型'})</div>
          <table className={styles.table}>
            <thead>
              <tr><th>{groupBy === 'agent' ? 'Agent' : '模型'}</th><th>消耗</th><th>占比</th></tr>
            </thead>
            <tbody>
              {pieData.map((g, i) => (
                <tr key={g.name}>
                  <td><span className={styles.dot} style={{ background: COLORS[i % COLORS.length] }} />{g.name}</td>
                  <td>{fmtNum(g.value)}</td>
                  <td>{pct(g.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}