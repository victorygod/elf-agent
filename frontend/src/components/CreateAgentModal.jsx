import { useState } from 'react';
import useAgentStore from '../stores/agentStore.js';
import * as api from '../api/index';
import styles from './CreateRoomModal.module.css';

/**
 * 新建 Agent 弹窗：仅输入名字（必填）→ 后端从模板克隆一个白板 agent → 刷新列表 → 自动选中进入私聊。
 * 复用 CreateRoomModal 的样式（overlay/modal/header/body/footer/nameInput/err/createBtn）。
 */
export default function CreateAgentModal({ onClose }) {
  const selectAgent = useAgentStore(s => s.selectAgent);
  const refreshAgents = useAgentStore(s => s.refreshAgents);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setErr('请输入名字'); return; }
    setBusy(true); setErr('');
    try {
      const { agentId } = await api.createAgent(trimmed);
      await refreshAgents();
      await selectAgent(agentId);
      onClose();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>新建 Agent</h3>
          <button onClick={onClose}>×</button>
        </div>
        <div className={styles.body}>
          <input
            className={styles.nameInput}
            placeholder="给 TA 起个名字（必填）"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
            autoFocus
          />
        </div>
        {err && <div className={styles.err}>{err}</div>}
        <div className={styles.footer}>
          <button onClick={onClose}>取消</button>
          <button className={styles.createBtn} onClick={handleCreate} disabled={busy || !name.trim()}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}