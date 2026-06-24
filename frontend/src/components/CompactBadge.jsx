import React from 'react';
import styles from './CompactBadge.module.css';

export default function CompactBadge({ type, tokenEstimate, error }) {
  if (type === 'loading') {
    return <div className={`${styles.badge} ${styles.loading}`}>⏳ 记忆压缩中...</div>;
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