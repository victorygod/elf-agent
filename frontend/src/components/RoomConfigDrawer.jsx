import { useState, useEffect } from 'react';
import Avatar from './Avatar';
import ConfirmModal from './ConfirmModal';
import { useRoomStore } from '../stores/roomStore.js';
import useAgentStore from '../stores/agentStore.js';
import styles from './RoomConfigDrawer.module.css';

/**
 * 群管理抽屉：加退既存 agent 成员、解散群、清空聊天记录、清空成员记忆。
 * 与私聊 ConfigDrawer 平行（私聊编辑 agent 配置，群聊管理成员）。
 * 成员在线状态用 roomChats 中副本状态（room_bus 的 MEMBER_STATUS），非全局 agentStore。
 */
export default function RoomConfigDrawer({ roomId, onClose }) {
  const rooms = useRoomStore(s => s.rooms);
  const agents = useAgentStore(s => s.agents);
  const addMember = useRoomStore(s => s.addMember);
  const removeMember = useRoomStore(s => s.removeMember);
  const deleteRoom = useRoomStore(s => s.deleteRoom);
  const clearAll = useRoomStore(s => s.clearAll);
  const loadRoomMembers = useRoomStore(s => s.loadRoomMembers);
  // 房间成员的副本在线状态（带 status/port 的对象数组，非 agentId 字符串）
  const memberStatuses = useRoomStore(s => s.roomChats.get(roomId)?.members) || [];
  const room = rooms.find(r => r.roomId === roomId);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  // 待确认操作（替代原生 confirm，避免被浏览器屏蔽导致按钮无响应）
  // null | { kind: 'remove'|'delete'|'clear', agentId?, title, message, tone, confirmText }
  const [confirm, setConfirm] = useState(null);

  // 打开抽屉时加载最新成员状态
  useEffect(() => { loadRoomMembers(roomId); }, [roomId, loadRoomMembers]);

  if (!room) return null;

  const memberIds = new Set(room.members);
  const candidates = agents.filter(a => !memberIds.has(a.agentId));

  // 构建 agentId → { name, avatar, status, port } 查找表（优先用 room 副本状态）
  const memberMap = {};
  for (const m of memberStatuses) { memberMap[m.agentId] = m; }

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2000); };

  const handleAdd = async (agentId) => {
    setBusy(true);
    try {
      await addMember(roomId, agentId);
      showToast(`已加入 ${agentId}`);
    } catch (e) { showToast(e.message); }
    setBusy(false);
  };

  const handleRemove = async (agentId) => {
    setBusy(true);
    try {
      await removeMember(roomId, agentId);
      showToast(`已移除 ${agentId}`);
    } catch (e) { showToast(e.message); }
    setBusy(false);
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await deleteRoom(roomId);
      onClose();
    } catch (e) { showToast(e.message); }
    setBusy(false);
  };

  const handleClearAll = async () => {
    setBusy(true);
    try { await clearAll(roomId); showToast('聊天记录与成员记忆已清空'); } catch (e) { showToast(e.message); }
    setBusy(false);
  };

  return (
    <div className={styles.drawer}>
      <div className={styles.header}>
        <h3>{room.name}</h3>
        <button className={styles.closeBtn} onClick={onClose}>×</button>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>成员（{room.members.length}）</div>
        <div className={styles.memberList}>
          {room.members.map(id => {
            const m = memberMap[id];
            const a = agents.find(x => x.agentId === id);
            // 优先取 room 副本状态（room_bus），回退全局 agent 状态（agent 没入群时）
            const status = m?.status ?? a?.status;
            const isRunning = status === 'running';
            const statusTitle = status === 'running' ? '在线'
              : status === 'offline' ? '离线'
              : status === 'starting' ? '启动中'
              : status === 'stopped' ? '已停止' : status || '离线';
            return (
              <div key={id} className={styles.memberItem}>
                <div className={styles.memberLeft}>
                  <Avatar
                    agentId={id}
                    avatar={a?.avatar || null}
                    bgColor="#4a90d9"
                    fallback={(a?.name || id || 'A').charAt(0).toUpperCase()}
                    size={28}
                  />
                  <span className={styles.memberName}>{a?.name || id}</span>
                  <span className={`${styles.statusDot} ${isRunning ? styles.online : styles.offline}`} title={statusTitle} />
                </div>
                <button className={styles.removeBtn} onClick={() => setConfirm({
                  kind: 'remove', agentId: id,
                  title: '移除成员',
                  message: `移除成员 ${id}?`,
                  tone: 'warning', confirmText: '移除',
                })} disabled={busy}>移除</button>
              </div>
            );
          })}
        </div>
        <button className={styles.addBtn} onClick={() => setAdding(!adding)} disabled={busy}>
          {adding ? '收起' : '+ 添加成员'}
        </button>
        {adding && (
          <div className={styles.candidateList}>
            {candidates.length === 0 && <div className={styles.hint}>所有 agent 都已在群里</div>}
            {candidates.map(a => (
              <div key={a.agentId} className={styles.candidateItem}>
                <span>{a.name} <span className={styles.hint}>({a.agentId})</span></span>
                <button onClick={() => handleAdd(a.agentId)} disabled={busy}>加入</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>数据管理</div>
        <button className={styles.dangerBtn} onClick={() => setConfirm({
          kind: 'clear',
          title: '清空数据',
          message: '清空本群的聊天记录 + 所有成员在本群的记忆?不影响各自私聊记忆。',
          tone: 'danger', confirmText: '清空',
        })} disabled={busy}>清空聊天记录与成员记忆</button>
      </div>

      <div className={styles.section}>
        <button className={styles.deleteBtn} onClick={() => setConfirm({
          kind: 'delete',
          title: '解散群',
          message: `解散群「${room.name}」?此操作不可恢复,所有成员记忆将删除。`,
          tone: 'danger', confirmText: '解散',
        })} disabled={busy}>解散群</button>
      </div>

      {toast && <div className={styles.toast}>{toast}</div>}

      <ConfirmModal
        open={!!confirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmText={confirm?.confirmText}
        tone={confirm?.tone}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (!c) return;
          if (c.kind === 'remove') handleRemove(c.agentId);
          else if (c.kind === 'delete') handleDelete();
          else if (c.kind === 'clear') handleClearAll();
        }}
      />
    </div>
  );
}