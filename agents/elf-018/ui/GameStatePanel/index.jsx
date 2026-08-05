/**
 * 游戏状态标签卡（elf-018 DM 用）
 *
 * 原位置：frontend/src/components/GameStatePanel.jsx
 * 迁移至：agents/elf-018/ui/GameStatePanel/index.jsx
 *
 * 通过 @spa 别名引用主 SPA 的 API 与 store。
 * Phase 3 后将逐步改为 bridge-only 模式。
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '@spa/api/index.js';
import useAgentStore from '@spa/stores/agentStore.js';

const preStyle = { whiteSpace: 'pre-wrap', margin: 0, fontSize: '13px', lineHeight: '1.5' };

export default function GameStatePanel({ agentId }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const streaming = useAgentStore(useCallback(s => s.chats.get(agentId)?.streaming ?? false, [agentId]));
  const prevStreamingRef = useRef(false);

  const load = () => {
    setLoading(true);
    api.getGameState(agentId).then(setState).catch(() => setState(null)).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [agentId]);

  useEffect(() => {
    if (prevStreamingRef.current && !streaming) load();
    prevStreamingRef.current = streaming;
  }, [streaming]);

  if (loading) return <div style={{ padding: '16px', color: '#999' }}>加载中…</div>;
  if (!state) return <div style={{ padding: '16px', color: '#999' }}>暂无游戏状态数据</div>;

  const blockStyle = { maxHeight: '200px', overflowY: 'auto', border: '1px solid #e0e0e0', borderRadius: '6px', padding: '8px 12px', marginBottom: '8px' };
  const titleStyle = { fontSize: '13px', color: '#666', margin: '0 0 6px 0' };
  const itemStyle = { fontSize: '13px', marginBottom: '2px', cursor: 'pointer', lineHeight: '1.4' };

  const CollapsibleItem = ({ item }) => {
    const [open, setOpen] = useState(false);
    const body = (item.content || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    return (
      <div>
        <div style={itemStyle} onClick={() => setOpen(v => !v)}>
          <span style={{ marginRight: '4px' }}>{open ? '▼' : '▶'}</span>
          <strong>{item.name}</strong> — {item.description}
        </div>
        {open && body && (
          <div style={{ padding: '6px 8px', marginLeft: '16px', background: '#f9f9f9', borderRadius: '4px', marginBottom: '4px' }}>
            <pre style={preStyle}>{body}</pre>
          </div>
        )}
      </div>
    );
  };

  const renderBlock = (title, items) => (
    <div style={blockStyle}>
      <p style={titleStyle}>{title}（{items.length}）</p>
      {items.length === 0 ? <span style={{ color: '#ccc' }}>—</span> : items.map((it, i) => <CollapsibleItem key={i} item={it} />)}
    </div>
  );

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '13px', color: '#999' }}>当前游戏世界状态</span>
        {loading && <span style={{ fontSize: '12px', color: '#aaa' }}>刷新中…</span>}
      </div>

      {state.protagonist && (
        <div style={{ border: '1px solid #d0d0d0', borderRadius: '6px', padding: '8px 12px', marginBottom: '8px' }}>
          <p style={{ ...titleStyle, margin: '0 0 4px 0' }}>主角：{state.protagonist.name}</p>
          <div style={{ display: 'flex', gap: '6px', margin: '6px 0 8px 0' }}>
            <input
              style={{ flex: 1, padding: '4px 8px', fontSize: '13px', border: '1px solid #d0d0d0', borderRadius: '4px' }}
              placeholder="改名…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              style={{ padding: '4px 10px', fontSize: '13px', cursor: newName.trim() ? 'pointer' : 'not-allowed', opacity: newName.trim() ? 1 : 0.5, border: '1px solid #d0d0d0', borderRadius: '4px', background: '#fff' }}
              disabled={!newName.trim() || renaming}
              onClick={async () => {
                setRenaming(true);
                try { await api.renameProtagonist(agentId, newName.trim()); setNewName(''); await load(); } finally { setRenaming(false); }
              }}
            >{renaming ? '…' : '改名'}</button>
          </div>
          <pre style={preStyle}>{(state.protagonist.content || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim()}</pre>
        </div>
      )}

      {renderBlock('角色', state.characters)}
      {renderBlock('地点', state.locations)}
      {renderBlock('任务', state.quests)}
      {renderBlock('物品图鉴', state.items)}
      {renderBlock('技能图鉴', state.skills)}

      <div style={blockStyle}>
        <p style={titleStyle}>Metadata</p>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '12px', margin: 0 }}>{state.metadata}</pre>
      </div>
    </div>
  );
}