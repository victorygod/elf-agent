import React, { useCallback } from 'react';
import Avatar from './Avatar';
import useAgentStore from '../stores/agentStore';
import styles from './Sidebar.module.css';

export default function Sidebar({ onSelect }) {
  const agents = useAgentStore(s => s.agents);
  const activeAgentId = useAgentStore(s => s.activeAgentId);
  const selectAgent = useAgentStore(s => s.selectAgent);
  const refreshAgents = useAgentStore(s => s.refreshAgents);

  const [spinning, setSpinning] = React.useState(false);

  const handleRefresh = useCallback(async () => {
    setSpinning(true);
    await refreshAgents();
    setTimeout(() => setSpinning(false), 600);
  }, [refreshAgents]);

  const handleSelect = useCallback((agentId) => {
    selectAgent(agentId);
    onSelect?.();
  }, [selectAgent, onSelect]);

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
        </div>
        <div className={styles.subtitle}>AI Agent 平台</div>
      </div>
      <div className={styles.list}>
        {agents.map(agent => (
          <div
            key={agent.agentId}
            className={`${styles.item} ${agent.agentId === activeAgentId ? styles.active : ''}`}
            onClick={() => handleSelect(agent.agentId)}
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
    </div>
  );
}