import React from 'react';
import styles from './EmptyState.module.css';

export default function EmptyState({ agentName }) {
  return (
    <div className={styles.container}>
      <div className={styles.text}>开始和 {agentName} 对话</div>
    </div>
  );
}