import React from 'react';
import Avatar from './Avatar';
import styles from './TypingIndicator.module.css';

export default function TypingIndicator({ agentId, agentAvatar }) {
  const fallback = agentId?.charAt(0).toUpperCase() || 'A';
  return (
    <div className={styles.message}>
      <div className={styles.avatar}>
        <Avatar agentId={agentId} avatar={agentAvatar} fallback={fallback} bgColor="#4a90d9" />
      </div>
      <div className={styles.body}>
        <div className={styles.bubble}>
          <div className={styles.dots}>
            <span /><span /><span />
          </div>
        </div>
      </div>
    </div>
  );
}