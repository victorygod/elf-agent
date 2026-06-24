import React from 'react';
import styles from './ToolCallBadge.module.css';

export default function ToolCallBadge({ toolCall }) {
  const { name, args, status, description } = toolCall;

  let statusClass = '';
  if (status === 'executing') {
    statusClass = styles.executing;
  } else if (status === 'success') {
    statusClass = styles.success;
  } else if (status === 'error') {
    statusClass = styles.error;
  }

  return (
    <div className={`${styles.badge} ${statusClass}`}>
      <div className={styles.header}>
        <span className={styles.name}>[工具] {name}</span>
        {status === 'error' && <span className={styles.errorLabel}>✕ 失败</span>}
        {status === 'success' && <span className={styles.successDot} title="执行成功" />}
        {status === 'executing' && <span className={styles.executingLabel}>● 执行中</span>}
      </div>
      {args && Object.keys(args).length > 0 && (
        <div className={styles.args}>
          {Object.entries(args).map(([key, val]) => {
            const raw = String(val);
            const displayVal = raw.length > 20 ? '…' + raw.slice(-20) : raw;
            return (
              <div key={key} className={styles.arg} title={raw}>
                {key}: {displayVal}
              </div>
            );
          })}
        </div>
      )}
      {status === 'error' && toolCall.message && (
        <div className={styles.errorMsg}>{toolCall.message}</div>
      )}
    </div>
  );
}
