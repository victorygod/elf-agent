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

  // 自动选中第一个 running agent
  useEffect(() => {
    if (agents.length > 0 && !activeAgentId) {
      const running = agents.find(a => a.status === 'running');
      const first = agents[0];
      if (running) selectAgent(running.agentId);
      else if (first) selectAgent(first.agentId);
    }
  }, [agents, activeAgentId, selectAgent]);

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