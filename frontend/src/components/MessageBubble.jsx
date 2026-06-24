import React, { useCallback } from 'react';
import Avatar from './Avatar';
import ToolCallBadge from './ToolCallBadge';
import CompactBadge from './CompactBadge';
import { formatTime } from '../utils/format';
import MarkdownContent from './MarkdownContent';
import styles from './MessageBubble.module.css';

const MessageBubble = React.memo(function MessageBubble({ msg, agentId, agentAvatar, userAvatar, isStreaming, onToggleTime, showTime, inAssistantGroup }) {
  const handleBubbleClick = useCallback(() => {
    // 有文本选中时不触发 toggleTime，避免重渲染导致选中丢失
    if (window.getSelection()?.toString()) return;
    if (msg.role !== 'system' && onToggleTime) {
      onToggleTime(msg.id);
    }
  }, [msg.id, msg.role, onToggleTime]);

  if (msg.role === 'system') {
    return (
      <div className={`${styles.message} ${styles.system}`} data-msg-id={msg.id}>
        <div className={styles.bubble}>{msg.content}</div>
      </div>
    );
  }

  const isUser = msg.role === 'user';
  // assistant 组内的消息不单独渲染 avatar（由组统一渲染）
  const showAvatar = !inAssistantGroup;
  const avatarSrc = isUser ? userAvatar : agentAvatar;
  const avatarFallback = isUser ? 'U' : (agentId?.charAt(0).toUpperCase() || 'A');
  const avatarBg = isUser ? '#07c160' : '#4a90d9';

  return (
    <div className={`${styles.message} ${isUser ? styles.user : styles.assistant} ${inAssistantGroup ? styles.inGroup : ''}`} data-msg-id={msg.id}>
      {showAvatar && (
        <div className={`${styles.avatar}`}>
          <Avatar agentId={agentId} avatar={avatarSrc} fallback={avatarFallback} bgColor={avatarBg} />
        </div>
      )}
      <div className={`${styles.body} ${showTime ? styles.showTime : ''}`}>
        {msg.ts && <div className={styles.time}>{formatTime(msg.ts)}</div>}
        <div className={styles.bubble} onClick={handleBubbleClick}>
          {msg.toolCalls?.map((tc, i) => <ToolCallBadge key={i} toolCall={tc} />)}
          {isUser ? (
            msg.content
          ) : (
            <MarkdownContent content={msg.content} />
          )}
          {/* compactLoading 与 compactSummary/compactError 互斥：完成状态优先 */}
          {msg.compactLoading && msg.compactSummary == null && !msg.compactError && <CompactBadge type="loading" />}
          {msg.compactSummary != null && <CompactBadge type="success" tokenEstimate={msg.compactSummary} />}
          {msg.compactError && <CompactBadge type="error" error={msg.compactError} />}
          {isStreaming && <span className={styles.cursor}>▍</span>}
        </div>
      </div>
    </div>
  );
});

export default MessageBubble;