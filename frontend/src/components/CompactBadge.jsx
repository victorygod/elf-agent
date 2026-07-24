import React from 'react';
import styles from './CompactBadge.module.css';

/**
 * 压缩状态徽章
 * @param {string} type - loading | success | abort | error
 * @param {number} [tokenEstimate] - 成功时的 token 估算
 * @param {string} [error] - 失败原因（已含"第N次"/"已禁用"文案，由 useChat._formatCompactError 拼好）
 * @param {number} [attempt] - 当前尝试次数（>1 时 loading 显示"重试第N次"）
 */
export default function CompactBadge({ type, tokenEstimate, error, attempt }) {
  if (type === 'loading') {
    const retry = attempt && attempt > 1 ? `（第 ${attempt} 次重试）` : '';
    return <div className={`${styles.badge} ${styles.loading}`}>⏳ 记忆压缩中{retry}...</div>;
  }
  if (type === 'success') {
    const tokenInfo = tokenEstimate != null ? ` (≈${tokenEstimate} tokens)` : '';
    return <div className={`${styles.badge} ${styles.success}`}>✅ 记忆已压缩{tokenInfo}</div>;
  }
  if (type === 'abort') {
    return <div className={`${styles.badge} ${styles.abort}`}>⊘ 记忆压缩已终止</div>;
  }
  if (type === 'error') {
    return <div className={`${styles.badge} ${styles.error}`}>❌ {error || '记忆压缩失败'}</div>;
  }
  return null;
}