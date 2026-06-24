import React, { useRef, useEffect, useCallback, useState } from 'react';
import Avatar from './Avatar';
import ToolCallBadge from './ToolCallBadge';
import CompactBadge from './CompactBadge';
import MarkdownContent from './MarkdownContent';
import EmptyState from './EmptyState';
import useChat from '../hooks/useChat';
import useAgentStore from '../stores/agentStore';
import styles from './ChatPanel.module.css';

/**
 * Toast 通知：顶部居中，1s 后淡出
 */
function Toast() {
  const message = useAgentStore(s => s.toastMessage);
  const toastKey = useAgentStore(s => s._toastKey);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!message) { setFading(false); return; }
    setFading(false);
    const t1 = setTimeout(() => setFading(true), 700);
    return () => clearTimeout(t1);
  }, [message, toastKey]);

  useEffect(() => {
    if (!fading) return;
    const t = setTimeout(() => useAgentStore.getState().showToast(null), 300);
    return () => clearTimeout(t);
  }, [fading]);

  if (!message) return null;
  return <div className={`${styles.toast} ${fading ? styles.toastFade : ''}`}>{message}</div>;
}

/**
 * 渲染一个 assistant bubble（Turn 内的一条记录）
 */
function AssistantBubble({ bubble, isStreaming, isLastInTurn, onToggleTime, showTime }) {
  const handleBubbleClick = useCallback(() => {
    if (window.getSelection()?.toString()) return;
    if (onToggleTime) onToggleTime(bubble.id);
  }, [bubble.id, onToggleTime]);

  return (
    <div className={styles.bubble} onClick={handleBubbleClick}>
      {bubble.typing && !bubble.content && (!bubble.toolCalls || bubble.toolCalls.length === 0) && (
        <div className={styles.dots}>
          <span /><span /><span />
        </div>
      )}
      {bubble.toolCalls?.map((tc, i) => <ToolCallBadge key={i} toolCall={tc} />)}
      {bubble.content && (
        <MarkdownContent content={isStreaming ? bubble.content + ' ▍' : bubble.content} />
      )}
      {bubble.compactLoading && bubble.compactSummary == null && !bubble.compactError && (
        <CompactBadge type="loading" />
      )}
      {bubble.compactSummary != null && (
        <CompactBadge type="success" tokenEstimate={bubble.compactSummary} />
      )}
      {bubble.compactError && bubble.compactError === '记忆压缩已终止' && (
        <CompactBadge type="abort" />
      )}
      {bubble.compactError && bubble.compactError !== '记忆压缩已终止' && (
        <CompactBadge type="error" error={bubble.compactError} />
      )}
    </div>
  );
}

/**
 * 渲染一个 Turn（用户消息 + Agent 回复气泡组）
 * React.memo：已完成的 turn（isStreamingActiveTurn=false）不会因 activeTurn 变化而重渲染
 */
const TurnView = React.memo(function TurnView({ turn, agentId, agent, isStreamingActiveTurn, showTimes, toggleTime }) {
  const { userMessage, assistantBubbles } = turn;
  const userShowTime = userMessage && showTimes.has(userMessage.id);
  const assistantShowTime = assistantBubbles[0] && showTimes.has(assistantBubbles[0].id);

  const handleUserBubbleClick = useCallback(() => {
    if (window.getSelection()?.toString()) return;
    if (userMessage && toggleTime) toggleTime(userMessage.id);
  }, [userMessage, toggleTime]);

  return (
    <>
      {/* 用户消息 */}
      {userMessage && (
        <div className={styles.userMessage}>
          <div className={styles.userAvatar}>
            <Avatar agentId={agentId} avatar={agent.userAvatar} fallback="U" bgColor="#07c160" />
          </div>
          <div className={`${styles.userBody} ${userShowTime ? styles.showTime : ''}`}>
            {userMessage.ts && (
              <div className={styles.time}>
                {new Date(userMessage.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
            <div className={styles.userBubble} onClick={handleUserBubbleClick}>{userMessage.content}</div>
          </div>
        </div>
      )}
      {/* Agent 回复气泡组 */}
      {assistantBubbles.length > 0 && (
        <div className={styles.assistantGroup}>
          <div className={styles.avatar}>
            <Avatar agentId={agentId} avatar={agent.avatar} fallback={agentId?.charAt(0).toUpperCase() || 'A'} bgColor="#4a90d9" />
          </div>
          <div className={`${styles.assistantCol} ${assistantShowTime ? styles.showTime : ''}`}>
            {assistantBubbles[0]?.ts && (
              <div className={styles.time}>
                {new Date(assistantBubbles[0].ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
            <div className={styles.groupBody}>
              {assistantBubbles.map((bubble, bi) => (
                <React.Fragment key={bubble.id || bi}>
                  {bi > 0 && <div className={styles.sectionDivider} />}
                  <AssistantBubble
                    bubble={bubble}
                    isStreaming={isStreamingActiveTurn && bi === assistantBubbles.length - 1 && !bubble.sealed}
                    isLastInTurn={bi === assistantBubbles.length - 1}
                    onToggleTime={toggleTime}
                    showTime={showTimes.has(bubble.id)}
                  />
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
});

export default function ChatPanel({ agentId }) {
  const turns = useAgentStore(useCallback(state => state.chats.get(agentId)?.turns ?? [], [agentId]));
  const activeTurn = useAgentStore(useCallback(state => state.chats.get(agentId)?.activeTurn ?? null, [agentId]));
  const streaming = useAgentStore(useCallback(state => state.chats.get(agentId)?.streaming ?? false, [agentId]));
  const historyLoaded = useAgentStore(useCallback(state => state.chats.get(agentId)?.historyLoaded ?? false, [agentId]));
  const draft = useAgentStore(useCallback(state => state.chats.get(agentId)?.draft ?? '', [agentId]));
  const _savedScrollTop = useAgentStore(useCallback(state => state.chats.get(agentId)?._savedScrollTop ?? 0, [agentId]));
  const isActive = useAgentStore(useCallback(state => state.chats.get(agentId)?._isActive ?? false, [agentId]));

  const agent = useAgentStore(useCallback(state => state.getAgent(agentId), [agentId]));
  const loadHistory = useAgentStore(s => s.loadHistory);

  const { send, abort, startPolling, cleanup } = useChat(agentId);

  const messagesElRef = useRef(null);
  const inputRef = useRef(null);
  const [showTimes, setShowTimes] = useState(new Set());

  const isRunning = agent?.status === 'running';
  // ★ streaming = activeTurn 存在时正在回复，禁止发送新消息
  const isStreaming = activeTurn !== null;
  const hasContent = turns.length > 0 || activeTurn;

  // 首次加载历史 + 恢复草稿/滚动（仅当 isActive 变为 true 时执行一次）
  // ★ agent 正在 streaming 时不 loadHistory — subscribe 的 snapshot 会提供 turns
  const initDoneRef = useRef(false);
  useEffect(() => {
    if (!isActive || !agent) return;
    if (initDoneRef.current) return;

    if (!historyLoaded && !agent.streaming) {
      loadHistory(agentId);
    }

    requestAnimationFrame(() => {
      if (messagesElRef.current && _savedScrollTop) {
        messagesElRef.current.scrollTop = _savedScrollTop;
      }
    });

    if (inputRef.current && draft) {
      inputRef.current.value = draft;
      autoResize();
    }

    initDoneRef.current = true;
  }, [isActive, agent, historyLoaded, _savedScrollTop, draft, loadHistory]);

  // 页面刷新后重连流式 SSE
  // ★ 用 ref guard 确保只 connect 一次，不因 deps 变化重复 abort + reconnect
  const reconnectedRef = useRef(false);
  useEffect(() => {
    if (!isActive || !agent) return;
    if (reconnectedRef.current) return;
    if (!agent.streaming) return;

    reconnectedRef.current = true;
    startPolling();

    return () => {
      cleanup();
      reconnectedRef.current = false;
    };
  }, [isActive, agent?.streaming, startPolling, cleanup]);

  // 保存草稿和滚动位置（卸载或切换 agent 时）
  useEffect(() => {
    return () => {
      if (inputRef.current) {
        useAgentStore.getState().updateChatField(agentId, {
          draft: inputRef.current.value,
          _savedScrollTop: messagesElRef.current?.scrollTop || 0,
        });
      }
    };
  }, [agentId]);

  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = messagesElRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    if (messagesElRef.current && messagesElRef.current.scrollTop <= 50) {
      const prevScrollHeight = messagesElRef.current.scrollHeight;
      useAgentStore.getState().loadMoreHistory(agentId).then((res) => {
        if (res && messagesElRef.current) {
          requestAnimationFrame(() => {
            messagesElRef.current.scrollTop = messagesElRef.current.scrollHeight - prevScrollHeight;
          });
        }
      });
    }
  }, [agentId]);

  // 消息变更时自动滚底
  useEffect(() => {
    if (isActive && !historyLoaded) return;
    scrollToBottom();
  }, [isActive, turns.length, activeTurn, scrollToBottom, historyLoaded]);

  const toggleTime = useCallback((msgId) => {
    setShowTimes(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }, []);

  const handleSend = useCallback(() => {
    if (isStreaming) return; // 回复中不允许发送
    const text = inputRef.current?.value?.trim();
    if (!text) return;
    inputRef.current.value = '';
    inputRef.current.style.height = 'auto';
    send(text);
  }, [send, isStreaming]);

  const isComposingRef = useRef(false);

  const handleKeyDown = useCallback((e) => {
    if (isStreaming) return; // 回复中禁止 Enter
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, isStreaming]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  if (!isActive) return null;
  if (!agent) return <div className={styles.panel} style={{ display: 'flex', padding: 16, color: '#666' }}>Agent 未就绪</div>;

  return (
    <div className={styles.panel} style={{ display: isActive ? 'flex' : 'none' }}>
      <Toast />
      <div className={styles.messages} ref={messagesElRef} onScroll={handleScroll}>
        {!hasContent && !isStreaming ? (
          <EmptyState agentName={agent.name || agentId} />
        ) : (
          <>
            {/* 已完成的回合 */}
            {turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                agentId={agentId}
                agent={agent}
                isStreamingActiveTurn={false}
                showTimes={showTimes}
                toggleTime={toggleTime}
              />
            ))}
            {/* 当前流式回合 */}
            {activeTurn && (
              <TurnView
                turn={activeTurn}
                agentId={agentId}
                agent={agent}
                isStreamingActiveTurn={isStreaming}
                showTimes={showTimes}
                toggleTime={toggleTime}
              />
            )}
          </>
        )}
      </div>
      <div className={styles.inputArea}>
        <div className={styles.inputWrapper}>
          <textarea
            ref={inputRef}
            className={styles.textarea}
            placeholder={isStreaming ? 'Agent 正在回复中...' : '输入消息...'}
            rows={1}
            disabled={isStreaming}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onInput={autoResize}
          />
          {isStreaming ? (
            <button className={styles.stopBtn} onClick={abort} title="停止生成">■</button>
          ) : (
            <button
              className={styles.sendBtn}
              onClick={handleSend}
              disabled={!isRunning}
              title="发送"
            />
          )}
        </div>
      </div>
    </div>
  );
}
