import React, { useEffect } from 'react';
import useAgentStore from '../stores/agentStore';
import styles from './UsageBadge.module.css';

/**
 * 用量标识:显示该 agent 累计消耗 token + 当前 context 占用 token。
 *   - cumulative:选 agent / done 后由 loadUsage 全量拉取(磁盘真值);SSE usage 不累加(防双倍)。
 *   - context:SSE usage 事件实时更新(单次调用收尾的 estimateTokens 快照)。
 *   - 加载中不占位(cumulative 未知时返回 null),避免标题卡闪空。
 *
 * @param {{ agentId: string, compact?: boolean }} props
 */
function fmt(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1000) return String(v);
  if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0) + 'k';
  return (v / 1_000_000).toFixed(1) + 'M';
}

export default function UsageBadge({ agentId, compact = false }) {
  const usage = useAgentStore(s => s.usage.get(agentId));

  // 首次挂载:若累计未拉,拉一次基线。dep 仅 [agentId] —— usage 变只重渲染不重跑。
  useEffect(() => {
    const u = useAgentStore.getState().usage.get(agentId);
    if (!u || u.cumulative == null) useAgentStore.getState().loadUsage(agentId);
  }, [agentId]);

  if (!usage || usage.cumulative == null) return null;
  return (
    <span
      className={`${styles.badge} ${compact ? styles.compact : ''}`}
      title={`累计 token 消耗 / 当前 context 占用`}
    >
      <span className={styles.total}>⚡{fmt(usage.cumulative)}</span>
      <span className={styles.sep}>·</span>
      <span className={styles.ctx}>ctx {fmt(usage.context)}</span>
    </span>
  );
}