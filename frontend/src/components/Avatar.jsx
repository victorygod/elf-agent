import React from 'react';
import useAgentStore from '../stores/agentStore';

/**
 * 头像组件。
 * - kind="agent"（默认）：avatar 为文件名，从 /agents/<agentId>/config/ 加载
 * - kind="user"：avatar 为文件名，从 /uploads/ 加载（全局用户头像）
 * avatar 也可是 base64 dataURL，此时直接内联使用。
 */
export default function Avatar({ agentId, avatar, fallback, bgColor, size, kind = 'agent' }) {
  const avatarBuster = useAgentStore(s => s._avatarBuster);
  const s = size != null ? `${size}px` : '100%';
  const fontSize = size != null ? `${Math.round(size * 0.45)}px` : undefined;

  if (avatar) {
    let src;
    if (avatar.startsWith('data:')) {
      src = avatar;
    } else if (kind === 'user') {
      src = `/uploads/${avatar}?v=${avatarBuster || 0}`;
    } else {
      src = `/agents/${agentId}/config/${avatar}?v=${avatarBuster || 0}`;
    }
    return (
      <img
        src={src}
        alt={agentId || 'avatar'}
        style={{ width: s, height: s, objectFit: 'cover', borderRadius: '6px' }}
      />
    );
  }
  return (
    <span style={{
      width: s, height: s, borderRadius: '6px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: bgColor || '#07c160',
      color: '#fff',
      fontSize,
    }}>
      {fallback}
    </span>
  );
}