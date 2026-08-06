import { useEffect, useCallback } from 'react';
import * as api from '../api/index.js';
import useAgentStore from '../stores/agentStore';
import { useRoomStore } from '../stores/roomStore';

const ROOM_HASH_PREFIX = 'room_';

function parseRoomHash(hash) {
  if (hash.startsWith(ROOM_HASH_PREFIX)) {
    const roomId = hash.slice(ROOM_HASH_PREFIX.length);
    return roomId ? roomId : null;
  }
  return null;
}

/**
 * useAgents — Agent 列表加载与刷新
 * @param {boolean} [enabled=true] - 多用户：登录后才拉列表（未登录 /agents 401）
 */
export default function useAgents(enabled = true) {
  const loadAgents = useAgentStore(s => s.loadAgents);
  const refreshAgents = useAgentStore(s => s.refreshAgents);
  const selectAgent = useAgentStore(s => s.selectAgent);
  const agents = useAgentStore(s => s.agents);
  const activeAgentId = useAgentStore(s => s.activeAgentId);

  const rooms = useRoomStore(s => s.rooms);
  const activeRoomId = useRoomStore(s => s.activeRoomId);
  const selectRoom = useRoomStore(s => s.selectRoom);
  const clearActiveRoom = useRoomStore(s => s.clearActiveRoom);

  // 初始化加载（登录后）
  useEffect(() => {
    if (enabled) loadAgents();
  }, [enabled, loadAgents]);

  // 自动选中:仅恢复 URL hash 指定的 agent/room(刷新保持在当前页面)。
  // 不再兜底选 running/第一个 —— 首屏无 hash 时不自动选中/启动。
  // 注意:若用户正看着群聊(activeRoomId 非空),不要自动抢回私聊选中。
  useEffect(() => {
    if (activeAgentId || activeRoomId) return; // 已有会话，不抢

    const fromHash = typeof window !== 'undefined'
      ? window.location.hash.replace(/^#\/?/, '')
      : '';

    // 群聊 hash: room_<roomId>
    const roomIdFromHash = parseRoomHash(fromHash);
    if (roomIdFromHash && rooms.some(r => r.roomId === roomIdFromHash)) {
      selectRoom(roomIdFromHash);
      return;
    }

    // 私聊 hash: 直接是 agentId
    if (fromHash) {
      const hashAgent = agents.find(a => a.agentId === fromHash);
      if (hashAgent) {
        selectAgent(hashAgent.agentId);
      }
    }
  }, [agents, rooms, activeAgentId, activeRoomId, selectAgent, selectRoom]);

  // 浏览器前进/后退:hash 变化时同步选中
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = () => {
      const raw = window.location.hash.replace(/^#\/?/, '');
      if (!raw) return;

      // 群聊 hash
      const roomIdFromHash = parseRoomHash(raw);
      if (roomIdFromHash) {
        if (activeRoomId !== roomIdFromHash) {
          clearActiveRoom();
          selectRoom(roomIdFromHash);
        }
        return;
      }

      // 私聊 hash
      if (raw !== useAgentStore.getState().activeAgentId) {
        selectAgent(raw);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [selectAgent, selectRoom, clearActiveRoom, activeRoomId]);

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