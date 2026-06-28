import React, { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
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
      {bubble.content && (
        <MarkdownContent content={isStreaming ? bubble.content + ' ▍' : bubble.content} />
      )}
      {bubble.toolCalls?.map((tc, i) => <ToolCallBadge key={i} toolCall={tc} />)}
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

  const prevActiveTurnIdRef = useRef(null);
  // 用户是否主动上滑离开底部 — 置 true 后停止自动滚底，直到用户滚回底部附近
  const userScrolledAwayRef = useRef(false);

  // 首次加载历史 + 恢复草稿/滚动（仅当 isActive 变为 true 时执行一次）
  // ★ activeTurn 在途时不 loadHistory —— 发消息瞬间 user 已落盘 jsonl，
  //   此时 loadHistory 会把这条 user 读进 turns，与 activeTurn 同框渲染导致对话翻倍。
  //   用前端实时维护的 activeTurn 判据，而非陈旧的后端 agent.streaming。
  const initDoneRef = useRef(false);
  useEffect(() => {
    if (!isActive || !agent) return;
    if (initDoneRef.current) return;

    if (!historyLoaded && !activeTurn) {
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
  }, [isActive, agent, historyLoaded, _savedScrollTop, draft, loadHistory, activeTurn]);

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
  // ★ 用 useLayoutEffect：卸载时其 cleanup 在 DOM 移除/ ref 置 null 之前同步执行，
  //    此刻 inputRef.current 仍指向 textarea，能读到未发送的草稿。
  //    若用 useEffect，cleanup 跑在 ref 已被 React 置 null 之后，草稿永远存不进去。
  useLayoutEffect(() => {
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

  // 检测是否在底部附近
  const isNearBottom = useCallback((threshold = 100) => {
    const el = messagesElRef.current;
    if (!el) return false;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= threshold;
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
    // 记录用户是否主动离开底部：向上滚超过阈值视为离开，滚回底部附近则清除
    userScrolledAwayRef.current = !isNearBottom();
  }, [agentId, isNearBottom]);

  // 消息变更时自动滚底
  useEffect(() => {
    if (isActive && !historyLoaded) return;

    const currentActiveTurnId = activeTurn?.id;

    // activeTurn 首次出现（用户发送消息），强制滚动并清除「离开底部」标记
    if (currentActiveTurnId && currentActiveTurnId !== prevActiveTurnIdRef.current) {
      prevActiveTurnIdRef.current = currentActiveTurnId;
      userScrolledAwayRef.current = false;
      scrollToBottom();
      return;
    }

    // 用户主动上滑离开底部后，不再自动滚底（流式中与回复完毕均适用）
    if (userScrolledAwayRef.current) return;

    // 流式输出中，只在底部附近时跟随
    if (isStreaming) {
      if (!isNearBottom()) return;
      scrollToBottom();
      return;
    }

    // 不在流式输出时（首次加载历史），滚动到底部
    scrollToBottom();
  }, [isActive, turns.length, activeTurn, scrollToBottom, historyLoaded, isNearBottom, isStreaming]);

  // 自动聚焦输入框：切换到 agent 页面时（即使刷新恢复历史），以及回复结束回复输入框可用时
  // ★ 尽量晚一点触发：streaming 结束 → isStreaming false 一刻；或切到此页。
  //    排除历史仍在加载与回复进行中（textarea disabled）。
  useEffect(() => {
    if (!isActive || !agent) return;
    if (!historyLoaded) return;
    if (isStreaming) return;
    if (!inputRef.current) return;
    // 聚焦时光标落末尾，便于继续编辑草稿
    const el = inputRef.current;
    el.focus();
    const len = el.value.length;
    try { el.setSelectionRange(len, len); } catch { /* number input 不支持，忽略 */ }
  }, [isActive, agent, historyLoaded, isStreaming]);

  const toggleTime = useCallback((msgId) => {
    setShowTimes(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }, []);

  // ★ 历史输入导航（类 CLI 体验）
  //   仅在 textarea 第一行按 ↑ 回溯上一条历史，最后一行按 ↓ 前进到下一条；
  //   多行编辑时上下键仍正常换行。
  //   历史来源：turns 与 activeTurn.userMessage 内的用户输入文纯文本（已提交，按时间正序），
  //   导航按「由新到旧」回溯。刷新 / 翻页加载后该列表自动完整。
  const historyNavRef = useRef({ index: -1, draft: '' });

  const getUserInputs = useCallback(() => {
    const chat = useAgentStore.getState().chats.get(agentId);
    if (!chat) return [];
    const inputs = [];
    for (const t of chat.turns) {
      if (t.userMessage?.content) inputs.push(t.userMessage.content);
    }
    if (chat.activeTurn?.userMessage?.content) {
      inputs.push(chat.activeTurn.userMessage.content);
    }
    return inputs;
  }, [agentId]);

  const getCaretLine = (el) => {
    // 用「光标前的换行数」判断行号：第 1 行 = 第一行，最后一行 = 行数
    const value = el.value.slice(0, el.selectionStart);
    const line = value.split('\n').length;
    return { line, total: el.value.split('\n').length };
  };

  const handleSend = useCallback(() => {
    if (isStreaming) return; // 回复中不允许发送
    const text = inputRef.current?.value?.trim();
    if (!text) return;
    inputRef.current.value = '';
    inputRef.current.style.height = 'auto';
    historyNavRef.current = { index: -1, draft: '' };
    send(text);
  }, [send, isStreaming]);

  const isComposingRef = useRef(false);

  const handleKeyDown = useCallback((e) => {
    if (isStreaming) return; // 回复中禁止 Enter

    // ★ 历史输入导航：第一行 ↑ 回溯上一条，最后一行 ↓ 前进下一条
    if (!isComposingRef.current && inputRef.current) {
      const el = inputRef.current;
      const { line, total } = getCaretLine(el);

      if (e.key === 'ArrowUp' && line === 1) {
        const inputs = getUserInputs();
        if (inputs.length > 0) {
          e.preventDefault();
          const nav = historyNavRef.current;
          if (nav.index === -1) {
            // 首次回溯：暂存当前草稿
            nav.draft = el.value;
            nav.index = inputs.length - 1;
          } else {
            nav.index = Math.max(0, nav.index - 1);
          }
          el.value = inputs[nav.index];
          const end = el.value.length;
          el.setSelectionRange(end, end);
          autoResize();
        }
        return;
      }

      if (e.key === 'ArrowDown' && line === total) {
        const inputs = getUserInputs();
        const nav = historyNavRef.current;
        if (nav.index === -1 || inputs.length === 0) {
          // 不在历史导航中或在最后一行，保持默认行为
        } else {
          e.preventDefault();
          const newIndex = nav.index + 1;
          if (newIndex >= inputs.length) {
            // 回到草稿缓冲
            nav.index = -1;
            el.value = nav.draft;
          } else {
            nav.index = newIndex;
            el.value = inputs[newIndex];
          }
          const end = el.value.length;
          el.setSelectionRange(end, end);
          autoResize();
        }
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, isStreaming, getUserInputs, autoResize]);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  // ★ 回复途中（abort 按钮出现）按 ESC 触发中止
  //   回复期间 textarea 处于 disabled，无法接收 keydown，因此用 window 级监听。
  //   回调里实时读 store 的 activeTurn + _isActive，空闲时不拦截 ESC。
  const abortRef = useRef(abort);
  abortRef.current = abort;
  useEffect(() => {
    const onGlobalKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      // 只在当前页面真正回复途中拦截
      const chat = useAgentStore.getState().chats.get(agentId);
      if (!chat?.activeTurn) return;
      if (!chat._isActive) return;
      e.preventDefault();
      e.stopPropagation();
      abortRef.current();
    };
    window.addEventListener('keydown', onGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', onGlobalKeyDown, true);
  }, [agentId]);

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
