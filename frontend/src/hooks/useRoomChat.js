/**
 * useRoomChat — 群聊 SSE 订阅 hook
 *
 * 订阅 /rooms/:rid/subscribe（EventSource），处理事件：
 *   - snapshot: 初始化 messages + members
 *   - speak:     追加一条整块消息（speaker + content）
 *   - member_status: 更新成员在线状态
 *   - error:    错误提示
 *
 * 与私聊 useChat 不同：群聊只整块消息（非流式 token），无 tool_call/badge/rewind。
 * 卸载时关 EventSource 避泄漏；群切换时断旧连新。
 */
import { useEffect, useRef, useCallback } from 'react';
import { roomSubscribeUrl, sendRoomMessage } from '../api/index.js';
import { useRoomStore } from '../stores/roomStore.js';

export function useRoomChat(roomId) {
  const esRef = useRef(null);
  const appendMessage = useRoomStore(s => s.appendMessage);
  const updateMemberStatus = useRoomStore(s => s.updateMemberStatus);
  const initFromSnapshot = useRoomStore(s => s.initFromSnapshot);

  useEffect(() => {
    if (!roomId) return;
    // 建立 SSE 连接
    const url = roomSubscribeUrl(roomId);
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('snapshot', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        initFromSnapshot(roomId, { messages: data.messages || [], members: data.members || [] });
      } catch (e) { /* ignore */ }
    });

    es.addEventListener('speak', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        appendMessage(roomId, { speaker: data.speaker, content: data.content, ts: data.ts, id: data.id });
      } catch (e) { /* ignore */ }
    });

    es.addEventListener('member_status', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        updateMemberStatus(roomId, data.agentId, data.status);
      } catch (e) { /* ignore */ }
    });

    es.onerror = () => {
      // EventSource 自动重连；这里仅记录，不手动处理
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [roomId, appendMessage, updateMemberStatus, initFromSnapshot]);

  /** 发送群消息（用户发言） */
  const send = useCallback(async (message) => {
    if (!roomId || !message.trim()) return;
    await sendRoomMessage(roomId, message);
    // 自己的消息由 SSE speak 事件回显（经 group-history 广播），不本地乐观追加，避免重复。
  }, [roomId]);

  return { send };
}