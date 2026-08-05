/**
 * SaveManager — elf-018 存档管理面板
 *
 * 显示在配置抽屉中，提供存档与读档功能。
 * 存档保存在 profiles/agents/<id>/memory/savings/ 下，清空聊天与记忆不会清理此目录。
 */

import React, { useState, useEffect, useCallback } from 'react';
import useAgentStore from '@spa/stores/agentStore.js';

const btnBase = { padding: '3px 10px', fontSize: '12px', cursor: 'pointer', border: '1px solid #d0d0d0', borderRadius: '4px', background: '#fff' };
const inputS = { width: '100%', padding: '5px 8px', fontSize: '13px', border: '1px solid #d0d0d0', borderRadius: '4px', boxSizing: 'border-box' };

export default function SaveManager({ agentId, bridge }) {
  const [saves, setSaves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await bridge.call('GET', '/saves');
      setSaves(data.saves || []);
    } catch (e) {
      setMsg({ type: 'error', text: '加载存档列表失败: ' + e.message });
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSave = async (force) => {
    if (!saveName.trim() || saving) return;
    setSaving(true);
    setMsg(null);
    try {
      const body = { name: saveName.trim() };
      if (force) body.force = true;
      await bridge.call('POST', '/save', body);
      setMsg({ type: 'ok', text: '已存档: ' + saveName.trim() });
      setSaveName('');
      refresh();
    } catch (e) {
      if (/409/.test(e.message) && !force) {
        setSaving(false);
        if (confirm('存档「' + saveName.trim() + '」已存在，是否覆盖？')) {
          return handleSave(true);
        }
        return;
      }
      setMsg({ type: 'error', text: '存档失败: ' + e.message });
    } finally {
      setSaving(false);
    }
  };

  const handleLoad = async (name) => {
    if (!confirm('确定加载存档「' + name + '」？当前未保存的进度将丢失。')) return;
    setMsg(null);
    try {
      await bridge.call('POST', '/load-save', { name });
      // 刷新 store：清空当前 chat 态，强制从 API 重拉历史
      const store = useAgentStore.getState();
      store._patchChat(agentId, { turns: [], activeTurn: null, historyLoaded: false });
      await store.loadHistory(agentId, { force: true });
      setMsg({ type: 'ok', text: '已加载存档: ' + name });
    } catch (e) {
      setMsg({ type: 'error', text: '读档失败: ' + e.message });
    }
  };

  const handleDelete = async (name) => {
    if (!confirm('确定删除存档「' + name + '」？此操作不可恢复。')) return;
    setMsg(null);
    try {
      await bridge.call('DELETE', '/save/' + encodeURIComponent(name));
      setMsg({ type: 'ok', text: '已删除存档: ' + name });
      refresh();
    } catch (e) {
      setMsg({ type: 'error', text: '删除失败: ' + e.message });
    }
  };

  const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid #eee' };

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ fontSize: '13px', color: '#999', marginBottom: '12px' }}>
        存档保存在独立目录，清空聊天与记忆后不会丢失。可用于开启多局游戏。
      </div>

      {/* 新建存档 */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        <input
          style={{ ...inputS, width: '0', flex: '1' }}
          value={saveName}
          onChange={e => setSaveName(e.target.value)}
          placeholder="存档名…"
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
        />
        <button
          style={{ ...btnBase, background: '#52c41a', color: '#fff', borderColor: '#52c41a', flexShrink: 0, whiteSpace: 'nowrap', opacity: saveName.trim() && !saving && !bridge.streaming ? 1 : 0.5 }}
          disabled={!saveName.trim() || saving || bridge.streaming}
          onClick={handleSave}
        >{saving ? '存档中…' : (bridge.streaming ? '回复中' : '保存')}</button>
      </div>

      {/* 消息 */}
      {msg && (
        <div style={{
          padding: '6px 10px', marginBottom: '8px', borderRadius: '4px', fontSize: '13px',
          background: msg.type === 'error' ? '#fff1f0' : '#f6ffed',
          color: msg.type === 'error' ? '#cf1322' : '#389e0d',
        }}>
          {msg.text}
        </div>
      )}

      {/* 存档列表 */}
      <div style={{ fontSize: '13px', color: '#666', marginBottom: '6px' }}>已有存档</div>
      {loading && <div style={{ color: '#999', fontSize: '13px' }}>加载中…</div>}
      {!loading && saves.length === 0 && <div style={{ color: '#ccc', fontSize: '13px' }}>暂无存档</div>}
      {saves.map(s => (
        <div key={s.name} style={rowStyle}>
          <span style={{ fontWeight: 600, fontSize: '13px', minWidth: '80px' }}>{s.name}</span>
          <span style={{ fontSize: '11px', color: '#999', whiteSpace: 'nowrap' }}>
            round-{s.round}
          </span>
          <span style={{ flex: 1 }} />
          <button
            style={{ ...btnBase, borderColor: '#409eff', color: '#409eff', opacity: bridge.streaming ? 0.5 : 1 }}
            disabled={bridge.streaming}
            onClick={() => handleLoad(s.name)}
          >加载</button>
          <button
            style={{ ...btnBase, color: '#cf1322', borderColor: '#cf1322' }}
            onClick={() => handleDelete(s.name)}
          >删除</button>
        </div>
      ))}
    </div>
  );
}