import React from 'react';

export default function Avatar({ agentId, avatar, fallback, bgColor }) {
  if (avatar) {
    return (
      <img
        src={`/agents/${agentId}/config/${avatar}`}
        alt={agentId}
        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '6px' }}
      />
    );
  }
  return (
    <span style={{
      width: '100%', height: '100%', borderRadius: '6px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: bgColor || '#07c160',
      color: '#fff',
    }}>
      {fallback}
    </span>
  );
}