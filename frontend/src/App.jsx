import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import ConfigDrawer from './components/ConfigDrawer';
import useAgentStore from './stores/agentStore';
import useAgents from './hooks/useAgents';
import styles from './App.module.css';

export default function App() {
  const { agents } = useAgents(); // initializes loading
  const activeAgentId = useAgentStore(s => s.activeAgentId);
  const configDrawerOpen = useAgentStore(s => s.configDrawerOpen);
  const configAgentId = useAgentStore(s => s.configAgentId);
  const openConfig = useAgentStore(s => s.openConfig);
  const closeConfig = useAgentStore(s => s.closeConfig);
  const refreshAgents = useAgentStore(s => s.refreshAgents);

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

  const handleOpenConfig = useCallback(() => {
    if (activeAgentId) openConfig(activeAgentId);
  }, [activeAgentId, openConfig]);

  const handleCloseConfig = useCallback(() => {
    closeConfig();
  }, [closeConfig]);

  const handleBackToList = useCallback(() => {
    setSidebarVisible(true);
  }, []);

  const handleAgentSelect = useCallback(() => {
    if (isMobile) {
      setSidebarVisible(false);
    }
  }, [isMobile]);

  // 当 ActiveAgentId 变化（包括内部 select 触发）时隐藏移动端 sidebar
  useEffect(() => {
    if (isMobile && activeAgentId) {
      setSidebarVisible(false);
    }
  }, [activeAgentId, isMobile]);

  const agent = activeAgentId ? agents.find(a => a.agentId === activeAgentId) : null;

  return (
    <div className={styles.body}>
      {/* 左侧边栏 */}
      <div className={`${styles.sidebarWrap} ${!sidebarVisible && isMobile ? styles.sidebarHidden : ''}`}>
        <Sidebar onSelect={handleAgentSelect} />
      </div>

      {/* 右侧主区域 */}
      <div className={`${styles.main} ${!sidebarVisible && isMobile ? styles.mainActive : ''}`}>
        {/* 顶栏 */}
        <div className={`${styles.topBar} ${!activeAgentId ? styles.hidden : ''}`}>
          {isMobile && (
            <button className={styles.backBtn} onClick={handleBackToList}>{'<'}</button>
          )}
          <div className={styles.title}>{agent?.name || activeAgentId || 'Elf'}</div>
          <div className={styles.actions}>
            <button className={styles.configBtn} onClick={handleOpenConfig} title="配置" />
          </div>
        </div>

        {/* 聊天区域 */}
        <div className={styles.chatArea}>
          {activeAgentId && <ChatPanel key={activeAgentId} agentId={activeAgentId} />}
        </div>
      </div>

      {/* 配置面板 */}
      {configDrawerOpen && (
        <>
          <div className={styles.overlay} onClick={handleCloseConfig} />
          <ConfigDrawer onClose={handleCloseConfig} />
        </>
      )}
    </div>
  );
}