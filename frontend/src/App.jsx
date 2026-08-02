import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import ConfigDrawer from './components/ConfigDrawer';
import RoomChatPanel from './components/RoomChatPanel';
import RoomConfigDrawer from './components/RoomConfigDrawer';
import useAgentStore from './stores/agentStore';
import { useRoomStore } from './stores/roomStore';
import useAgents from './hooks/useAgents';
import { useAggregatedSubscription } from './hooks/useAggregatedSubscription';
import styles from './App.module.css';

export default function App() {
  const { agents } = useAgents(); // initializes loading
  useAggregatedSubscription(); // app 级聚合 SSE(全程 1 条,解 6 连接上限;见 docs/sse-aggregation-design.md)
  const activeAgentId = useAgentStore(s => s.activeAgentId);
  const configDrawerOpen = useAgentStore(s => s.configDrawerOpen);
  const configAgentId = useAgentStore(s => s.configAgentId);
  const openConfig = useAgentStore(s => s.openConfig);
  const closeConfig = useAgentStore(s => s.closeConfig);
  const refreshAgents = useAgentStore(s => s.refreshAgents);

  const activeRoomId = useRoomStore(s => s.activeRoomId);
  const rooms = useRoomStore(s => s.rooms);
  const loadRooms = useRoomStore(s => s.loadRooms);

  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const [sidebarVisible, setSidebarVisible] = useState(true);

  // 移动端检测（覆盖 resize + orientation）
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // 初始加载
  useEffect(() => {
    if (agents.length > 0 && !activeAgentId) {
      // auto-select handled by useAgents hook
    }
  }, [agents, activeAgentId]);

  // 加载群列表
  useEffect(() => { loadRooms(); }, [loadRooms]);

  const [roomConfigOpen, setRoomConfigOpen] = useState(false);

  const handleOpenConfig = useCallback(() => {
    if (activeAgentId) {
      openConfig(activeAgentId);
    } else if (activeRoomId) {
      setRoomConfigOpen(true);
    }
  }, [activeAgentId, activeRoomId, openConfig]);

  const handleCloseConfig = useCallback(() => {
    closeConfig();
    setRoomConfigOpen(false);
  }, [closeConfig]);

  const handleBackToList = useCallback(() => {
    setSidebarVisible(true);
  }, []);

  const handleAgentSelect = useCallback(() => {
    if (isMobile) {
      setSidebarVisible(false);
    }
  }, [isMobile]);

  // 当选中会话（agent 或 room）变化时隐藏移动端 sidebar
  useEffect(() => {
    if (isMobile && (activeAgentId || activeRoomId)) {
      setSidebarVisible(false);
    }
  }, [activeAgentId, activeRoomId, isMobile]);

  const agent = activeAgentId ? agents.find(a => a.agentId === activeAgentId) : null;
  const activeRoom = activeRoomId ? rooms.find(r => r.roomId === activeRoomId) : null;
  const hasSession = !!(activeAgentId || activeRoomId);
  const sessionTitle = activeRoom ? activeRoom.name : (agent?.name || activeAgentId || 'Elf');

  return (
    <div className={styles.body}>
      {/* 左侧边栏 */}
      <div className={`${styles.sidebarWrap} ${!sidebarVisible && isMobile ? styles.sidebarHidden : ''}`}>
        <Sidebar onSelect={handleAgentSelect} />
      </div>

      {/* 右侧主区域 */}
      <div className={`${styles.main} ${!sidebarVisible && isMobile ? styles.mainActive : ''}`}>
        {/* 顶栏 */}
        <div className={`${styles.topBar} ${!hasSession ? styles.hidden : ''}`}>
          {isMobile && (
            <button className={styles.backBtn} onClick={handleBackToList}>{'<'}</button>
          )}
          <div className={styles.title}>{sessionTitle}</div>
          <div className={styles.actions}>
            <button className={styles.configBtn} onClick={handleOpenConfig} title="配置" />
          </div>
        </div>

        {/* 聊天区域：私聊/群聊互斥渲染（同时有 activeAgentId+activeRoomId 时群聊优先,防双面板） */}
        <div className={styles.chatArea}>
          {activeRoomId ? <RoomChatPanel key={activeRoomId} roomId={activeRoomId} />
            : activeAgentId ? <ChatPanel key={activeAgentId} agentId={activeAgentId} /> : null}
        </div>
      </div>

      {/* 配置面板：私聊 ConfigDrawer / 群聊 RoomConfigDrawer */}
      {configDrawerOpen && (
        <>
          <div className={styles.overlay} onClick={handleCloseConfig} />
          <ConfigDrawer onClose={handleCloseConfig} />
        </>
      )}
      {roomConfigOpen && activeRoomId && (
        <>
          <div className={styles.overlay} onClick={handleCloseConfig} />
          <RoomConfigDrawer roomId={activeRoomId} onClose={handleCloseConfig} />
        </>
      )}
    </div>
  );
}