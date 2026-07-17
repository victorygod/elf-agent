import { useState } from 'react';
import useAgentStore from '../stores/agentStore.js';
import { useRoomStore } from '../stores/roomStore.js';
import styles from './CreateRoomModal.module.css';

/**
 * 建群弹窗：输入群名 + 从既存 agent 多选初始成员 → createRoom → 自动选中。
 */
export default function CreateRoomModal({ onClose }) {
  const agents = useAgentStore(s => s.agents);
  const createRoom = useRoomStore(s => s.createRoom);
  const selectRoom = useRoomStore(s => s.selectRoom);
  const loadRooms = useRoomStore(s => s.loadRooms);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const toggle = (id) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };

  const handleCreate = async () => {
    if (selected.size === 0) { setErr('至少选一个成员'); return; }
    setBusy(true); setErr('');
    try {
      const room = await createRoom(name || `群${Date.now() % 1000}`, [...selected]);
      await loadRooms();
      selectRoom(room.roomId);
      onClose();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>新建群聊</h3>
          <button onClick={onClose}>×</button>
        </div>
        <div className={styles.body}>
          <input
            className={styles.nameInput}
            placeholder="群名（可选）"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <div className={styles.sectionTitle}>选择成员</div>
          <div className={styles.agentList}>
            {agents.map(a => (
              <label key={a.agentId} className={`${styles.agentItem} ${selected.has(a.agentId) ? styles.checked : ''}`}>
                <input type="checkbox" checked={selected.has(a.agentId)} onChange={() => toggle(a.agentId)} />
                <span>{a.name}</span>
                <span className={styles.idHint}>({a.agentId})</span>
              </label>
            ))}
          </div>
        </div>
        {err && <div className={styles.err}>{err}</div>}
        <div className={styles.footer}>
          <button onClick={onClose}>取消</button>
          <button className={styles.createBtn} onClick={handleCreate} disabled={busy || selected.size === 0}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}