import React, { useCallback, useState, useEffect, useRef } from 'react';
import Avatar from './Avatar';
import useAgentStore from '../stores/agentStore';
import { useRoomStore } from '../stores/roomStore';
import * as api from '../api/index';
import CreateRoomModal from './CreateRoomModal';
import styles from './Sidebar.module.css';

/**
 * 按 order 数组给 items 排序：order 中靠前的在前，
 * 未出现在 order 里的（新增 agent/room）按原数组相对顺序补到末尾。
 * @template T
 * @param {T[]} items
 * @param {string[]} order
 * @param {(item: T) => string} keyOf
 * @returns {T[]}
 */
function orderedBy(items, order, keyOf) {
  if (!order || order.length === 0) return items;
  const pos = new Map();
  order.forEach((k, i) => pos.set(k, i));
  const indexed = items.map(it => ({ it, p: pos.has(keyOf(it)) ? pos.get(keyOf(it)) : Infinity }));
  // 稳定排序：未在 order 中的保持原相对顺序（同 Infinity 时按原索引）
  return indexed
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => (a.p - b.p) || (a.i - b.i))
    .map(x => x.it);
}

/**
 * 把 from 处的元素移到 to 处（splice 重排），返回新数组
 */
function moveTo(arr, from, to) {
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export default function Sidebar({ onSelect }) {
  const agents = useAgentStore(s => s.agents);
  const activeAgentId = useAgentStore(s => s.activeAgentId);
  const selectAgent = useAgentStore(s => s.selectAgent);
  const refreshAgents = useAgentStore(s => s.refreshAgents);

  const rooms = useRoomStore(s => s.rooms);
  const activeRoomId = useRoomStore(s => s.activeRoomId);
  const selectRoom = useRoomStore(s => s.selectRoom);
  const clearActiveRoom = useRoomStore(s => s.clearActiveRoom);
  const userName = useRoomStore(s => s.userName);
  const userAvatarStore = useRoomStore(s => s.userAvatar);
  const loadUserName = useRoomStore(s => s.loadUserName);
  const sidebarOrder = useRoomStore(s => s.sidebarOrder);
  const setSidebarOrder = useRoomStore(s => s.setSidebarOrder);

  const [spinning, setSpinning] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsName, setSettingsName] = useState('');
  // 新选的头像 File（未上传），preview 为本地 dataURL 用于预览
  const [pendingAvatarFile, setPendingAvatarFile] = useState(null);
  const [settingsAvatarPreview, setSettingsAvatarPreview] = useState(null);
  // 标记用户是否点了"移除头像"（清空既有头像）
  const [avatarRemoved, setAvatarRemoved] = useState(false);

  useEffect(() => { loadUserName(); }, [loadUserName]);

  const openSettings = () => {
    setSettingsName(userName || '');
    setPendingAvatarFile(null);
    setSettingsAvatarPreview(null);
    setAvatarRemoved(false);
    setShowSettings(true);
  };

  // 派生排序后的列表
  const orderedRooms = orderedBy(rooms, sidebarOrder.rooms, r => r.roomId);
  const orderedAgents = orderedBy(agents, sidebarOrder.agents, a => a.agentId);

  // ===== 拖拽排序（区段内）=====
  const dragSourceRef = useRef({ section: null, key: null });
  const [dragOver, setDragOver] = useState({ section: null, key: null });
  const [dragging, setDragging] = useState({ section: null, key: null });

  const handleDragStart = useCallback((section, key) => (e) => {
    dragSourceRef.current = { section, key };
    setDragging({ section, key });
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', key); } catch { /* ignore */ }
  }, []);

  const handleDragOver = useCallback((section, key) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const src = dragSourceRef.current;
    if (src.section !== section) return;
    setDragOver(prev => (prev.section === section && prev.key === key ? prev : { section, key }));
  }, []);

  const handleDragLeave = useCallback(() => {
    // 由 drop/dragEnd 清理
  }, []);

  const commitReorder = useCallback((section, fromKey, toKey) => {
    const list = section === 'rooms' ? orderedRooms : orderedAgents;
    const keyOf = section === 'rooms' ? (r => r.roomId) : (a => a.agentId);
    const fromIdx = list.findIndex(x => keyOf(x) === fromKey);
    const toIdx = list.findIndex(x => keyOf(x) === toKey);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const newOrder = moveTo(list, fromIdx, toIdx).map(keyOf);
    const nextSidebarOrder = {
      ...sidebarOrder,
      [section]: newOrder,
    };
    setSidebarOrder(nextSidebarOrder);
  }, [orderedRooms, orderedAgents, sidebarOrder, setSidebarOrder]);

  const handleDrop = useCallback((section, key) => (e) => {
    e.preventDefault();
    const src = dragSourceRef.current;
    setDragOver({ section: null, key: null });
    if (!src.key || src.section !== section) return;
    commitReorder(section, src.key, key);
    dragSourceRef.current = { section: null, key: null };
  }, [commitReorder]);

  const handleDragEnd = useCallback(() => {
    dragSourceRef.current = { section: null, key: null };
    setDragOver({ section: null, key: null });
    setDragging({ section: null, key: null });
  }, []);

  const itemDragProps = useCallback((section, key) => ({
    draggable: true,
    onDragStart: handleDragStart(section, key),
    onDragOver: handleDragOver(section, key),
    onDragLeave: handleDragLeave,
    onDrop: handleDrop(section, key),
    onDragEnd: handleDragEnd,
  }), [handleDragStart, handleDragOver, handleDragLeave, handleDrop, handleDragEnd]);

  const isDragOver = (section, key) => dragOver.section === section && dragOver.key === key;
  const isDragging = (section, key) => dragging.section === section && dragging.key === key;

  // ===== 设置弹窗操作 =====
  const handleSaveSettings = useCallback(async () => {
    const name = settingsName.trim();
    if (!name) return;
    try {
      // 计算要保存的 userAvatar 字段值：
      // - 新选了图 → 先上传拿文件名
      // - 点了移除 → null
      // - 未改动 → 保留现有（不传该字段，后端原样保留）
      let userAvatarValue;
      let userAvatarUndefined = false;
      if (pendingAvatarFile) {
        const reader = new FileReader();
        const base64 = await new Promise((resolve, reject) => {
          reader.onload = (ev) => resolve(ev.target.result);
          reader.onerror = reject;
          reader.readAsDataURL(pendingAvatarFile);
        });
        const uploadRes = await api.uploadUserAvatar(base64, pendingAvatarFile.type);
        userAvatarValue = uploadRes.userAvatar;
      } else if (avatarRemoved) {
        userAvatarValue = null;
      } else {
        userAvatarUndefined = true; // 保留既有，不传
      }

      const payload = { userName: name };
      if (!userAvatarUndefined) payload.userAvatar = userAvatarValue;

      const result = await api.putSettings(payload);

      // 用 setState 触发 Zustand 重渲染
      useRoomStore.setState({
        userName: result.userName,
        userAvatar: result.userAvatar,
      });
      setShowSettings(false);
    } catch (e) {
      alert('保存失败: ' + e.message);
    }
  }, [settingsName, pendingAvatarFile, avatarRemoved]);

  const handleAvatarInputChange = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      alert('图片大小不能超过 2MB');
      return;
    }
    setPendingAvatarFile(file);
    setAvatarRemoved(false);
    // 本地预览
    const reader = new FileReader();
    reader.onload = (ev) => {
      setSettingsAvatarPreview(ev.target.result);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleRemoveAvatar = useCallback(() => {
    setPendingAvatarFile(null);
    setSettingsAvatarPreview(null);
    setAvatarRemoved(true);
  }, []);

  const handleRefresh = useCallback(async () => {
    setSpinning(true);
    await refreshAgents();
    setTimeout(() => setSpinning(false), 600);
  }, [refreshAgents]);

  const handleSelectAgent = useCallback((agentId) => {
    clearActiveRoom();
    selectAgent(agentId);
    onSelect?.();
  }, [selectAgent, clearActiveRoom, onSelect]);

  const handleSelectRoom = useCallback((roomId) => {
    useAgentStore.setState({ activeAgentId: null });
    selectRoom(roomId);
    if (typeof window !== 'undefined') {
      const hash = `room_${roomId}`;
      if (window.location.hash.replace(/^#\/?/, '') !== hash) {
        window.location.hash = hash;
      }
    }
    onSelect?.();
  }, [selectRoom, onSelect]);

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h1>Elf</h1>
          <button
            className={`${styles.btnIconSm} ${spinning ? styles.spinning : ''}`}
            onClick={handleRefresh}
            title="刷新状态"
          >↻</button>
          <button className={styles.btnIconSm} onClick={openSettings} title="全局设置">⚙</button>
        </div>
        <div className={styles.subtitle}>{userName ? `你好，${userName}` : 'AI Agent 平台'}</div>
      </div>

      {/* 全局设置弹窗 */}
      {showSettings && (
        <div className={styles.nameEditModal}>
          <div className={styles.nameEditBox}>
            <div className={styles.nameEditTitle}>全局设置</div>
            <div className={styles.settingAvatarRow}>
              <div
                className={styles.settingAvatarPreview}
                onClick={() => document.getElementById('sidebarAvatarInput')?.click()}
              >
                {settingsAvatarPreview
                  ? <img src={settingsAvatarPreview} alt="头像" />
                  : (userAvatarStore && !avatarRemoved
                    ? <img src={`/uploads/${userAvatarStore}?v=${Date.now()}`} alt="头像" />
                    : <span className={styles.placeholder}>点击<br/>上传</span>)}
              </div>
              <input
                type="file"
                id="sidebarAvatarInput"
                accept="image/png,image/jpeg,image/gif,image/webp"
                style={{ display: 'none' }}
                onChange={handleAvatarInputChange}
              />
              {(settingsAvatarPreview || (userAvatarStore && !avatarRemoved)) && (
                <button className={styles.removeAvatarBtn} onClick={handleRemoveAvatar}>移除头像</button>
              )}
            </div>
            <label className={styles.settingLabel}>用户名</label>
            <input
              className={styles.nameEditInput}
              value={settingsName}
              onChange={e => setSettingsName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveSettings(); }}
              placeholder="你的名字"
              autoFocus
            />
            <div className={styles.nameEditActions}>
              <button onClick={() => setShowSettings(false)}>取消</button>
              <button className={styles.nameEditSave} onClick={handleSaveSettings}>保存</button>
            </div>
          </div>
        </div>
      )}

      <div className={styles.list}>
        {/* 群聊区段 */}
        <div className={styles.sectionHeader}>
          <span>群聊</span>
          <button className={styles.btnIconSm} onClick={() => setShowCreate(true)} title="新建群聊">+</button>
        </div>
        {rooms.length === 0 && <div className={styles.emptyHint}>还没有群,点 + 建一个</div>}
        {orderedRooms.map(room => (
          <div
            key={room.roomId}
            className={`${styles.item} ${room.roomId === activeRoomId ? styles.active : ''} ${isDragOver('rooms', room.roomId) ? styles.dragOver : ''} ${isDragging('rooms', room.roomId) ? styles.dragging : ''}`}
            onClick={() => handleSelectRoom(room.roomId)}
            {...itemDragProps('rooms', room.roomId)}
          >
            <div className={styles.avatar}>
              <div className={styles.groupAvatar}>群</div>
            </div>
            <div className={styles.info}>
              <div className={styles.name}>{room.name}</div>
              <div className={styles.path}>{room.members.length} 人</div>
            </div>
          </div>
        ))}

        {/* 私聊区段 */}
        <div className={styles.sectionHeader}><span>私聊</span></div>
        {orderedAgents.map(agent => (
          <div
            key={agent.agentId}
            className={`${styles.item} ${agent.agentId === activeAgentId ? styles.active : ''} ${isDragOver('agents', agent.agentId) ? styles.dragOver : ''} ${isDragging('agents', agent.agentId) ? styles.dragging : ''}`}
            onClick={() => handleSelectAgent(agent.agentId)}
            {...itemDragProps('agents', agent.agentId)}
          >
            <div className={styles.avatar}>
              <Avatar
                agentId={agent.agentId}
                avatar={agent.avatar}
                bgColor="#07c160"
                fallback={(agent.name || agent.agentId).charAt(0).toUpperCase()}
              />
            </div>
            <div className={styles.info}>
              <div className={styles.name}>{agent.name || agent.agentId}</div>
              <div className={styles.path}>{agent.path || ('agents/' + agent.agentId)}</div>
              <div className={`${styles.status} ${styles[agent.status]}`}>
                <span className={styles.statusDot} />
                <span className={styles.statusText}>
                  {agent.status === 'running' ? '运行中' : agent.status === 'error' ? '错误' : '已停止'}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {showCreate && <CreateRoomModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}