/**
 * useRoomChat — 群聊发言 hook(事件订阅已由 useAggregatedSubscription 聚合接管)。
 *
 * 群聊 SSE 事件(snapshot/speak/member_status/notice)经聚合 SSE 到达,
 * 由 roomStore.roomDispatch 处理(见 stores/roomStore.js)。本 hook 只保留发言动作。
 */
import { useCallback } from 'react';
import { sendRoomMessage } from '../api/index.js';

export function useRoomChat(roomId) {
  /** 发送群消息(用户发言) */
  const send = useCallback(async (message) => {
    if (!roomId || !message.trim()) return;
    await sendRoomMessage(roomId, message);
    // 自己的消息由聚合 SSE speak 事件回显(经 group-history 广播),不本地乐观追加,避免重复。
  }, [roomId]);

  return { send };
}