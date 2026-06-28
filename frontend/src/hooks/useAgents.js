import { useEffect, useCallback } from 'react';
import * as api from '../api/index.js';
import useAgentStore from '../stores/agentStore';

/**
 * useAgents — Agent 列表加载与刷新
 */
export default function useAgents() {
  const loadAgents = useAgentStore(s => s.loadAgents);
  const refreshAgents = useAgentStore(s => s.refreshAgents);
  const selectAgent = useAgentStore(s => s.selectAgent);
  const agents = useAgentStore(s => s.agents);
  const activeAgentId = useAgentStore(s => s.activeAgentId);

  // 初始化加载
  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // 自动选中:URL hash 优先(running/第一个 兜底),刷新后保留在当前 agent
  useEffect(() => {
    if (agents.length === 0 || activeAgentId) return;

    const fromHash = typeof window !== 'undefined'
      ? window.location.hash.replace(/^#\/?/, '')
      : '';
    const hashAgent = fromHash && agents.find(a => a.agentId === fromHash);

    if (hashAgent) {
      selectAgent(hashAgent.agentId);
    } else {
      const running = agents.find(a => a.status === 'running');
      const first = agents[0];
      if (running) selectAgent(running.agentId);
      else if (first) selectAgent(first.agentId);
    }
  }, [agents, activeAgentId, selectAgent]);

  // 浏览器前进/后退:hash 变化时同步选中对应 agent
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = () => {
      const id = window.location.hash.replace(/^#\/?/, '');
      if (!id) return;
      // 仅当与当前不同时切换,避免重复触发 auto-start
      if (id !== useAgentStore.getState().activeAgentId) {
        selectAgent(id);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [selectAgent]);

  const handleRefresh = useCallback(async () => {
    await refreshAgents();
  }, [refreshAgents]);

  return {
    agents,
    activeAgentId,
    refreshAgents: handleRefresh,
    selectAgent,
  };
}