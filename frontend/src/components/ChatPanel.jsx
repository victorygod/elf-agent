import React, { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import Avatar from './Avatar';
import ToolCallBadge from './ToolCallBadge';
import CompactBadge from './CompactBadge';
import MarkdownContent from './MarkdownContent';
import EmptyState from './EmptyState';
import RewindMenu from './RewindMenu';
import RewindFileChoice from './RewindFileChoice';
import ToastStack from './Toast';
import useChat from '../hooks/useChat';
import useAgentStore from '../stores/agentStore';
import { useRoomStore } from '../stores/roomStore';
import { chatKey } from '../stores/authStore';
import styles from './ChatPanel.module.css';

/**
 * Toast 通知：顶部居中竖排（共享组件，多条各 3s 显示 + 0.4s 淡出，互不干扰）
 */
function PrivateToast() {
  const toasts = useAgentStore(s => s.toastList);
  const removeToast = useAgentStore(s => s.removeToast);
  return <ToastStack toasts={toasts} remove={removeToast} styles={styles} />;
}

/**
 * 渲染一个 assistant bubble（Turn 内的一条记录）
 */
const LOOP_LABELS = { outline: '大纲', render: '渲染' };

function AssistantBubble({ bubble, isStreaming, isLastInTurn, onToggleTime, showTime, currentLoop }) {
  const [expanded, setExpanded] = useState(false);
  const handleBubbleClick = useCallback(() => {
    if (window.getSelection()?.toString()) return;
    if (onToggleTime) onToggleTime(bubble.id);
  }, [bubble.id, onToggleTime]);

  // 非 render loop（main/reviewer）折叠为一行，展开看完整
  const loop = bubble._loop || (bubble.toolCalls?.length ? currentLoop : null);
  if (loop && loop !== 'render') {
    const label = LOOP_LABELS[loop] || loop;
    const summary = bubble.toolCalls?.length
      ? bubble.toolCalls.map((tc) => tc.name || tc.function?.name).join(', ')
      : (bubble.content || '').slice(0, 60) || '执行中…';
    return (
      <div className={styles.bubble} style={{ opacity: 0.55 }}>
        <div onClick={() => setExpanded(v => !v)} style={{ cursor: 'pointer', fontSize: '12px', color: '#888', display: 'flex', alignItems: 'center' }}>
          <span style={{ marginRight: '4px' }}>{expanded ? '▼' : '▶'}</span>
          <strong style={{ marginRight: '4px' }}>{label}</strong>
          <span>{summary}</span>
        </div>
        {expanded && (
          <div style={{ marginTop: '4px', padding: '8px', background: '#f5f5f5', borderRadius: '4px', fontSize: '13px' }}>
            {bubble.toolCalls?.map((tc, i) => <ToolCallBadge key={i} toolCall={tc} />)}
            {bubble.content && <MarkdownContent content={bubble.content} />}
          </div>
        )}
      </div>
    );
  }

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
        <CompactBadge type="loading" attempt={bubble.compactAttempt} />
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
const TurnView = React.memo(function TurnView({ turn, agentId, agent, isStreamingActiveTurn, showTimes, toggleTime, userAvatar, userUid, currentLoop }) {
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
            <Avatar kind="user" uid={userUid} avatar={userAvatar} fallback="U" bgColor="#07c160" />
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
                    currentLoop={currentLoop}
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
  const turns = useAgentStore(useCallback(state => state.chats.get(chatKey(agentId))?.turns ?? [], [agentId]));
  const activeTurn = useAgentStore(useCallback(state => state.chats.get(chatKey(agentId))?.activeTurn ?? null, [agentId]));
  const streaming = useAgentStore(useCallback(state => state.chats.get(chatKey(agentId))?.streaming ?? false, [agentId]));
  const historyLoaded = useAgentStore(useCallback(state => state.chats.get(chatKey(agentId))?.historyLoaded ?? false, [agentId]));
  const draft = useAgentStore(useCallback(state => state.chats.get(chatKey(agentId))?.draft ?? '', [agentId]));
  const _savedScrollTop = useAgentStore(useCallback(state => state.chats.get(chatKey(agentId))?._savedScrollTop ?? 0, [agentId]));
  const isActive = useAgentStore(useCallback(state => state.chats.get(chatKey(agentId))?._isActive ?? false, [agentId]));
  const currentLoop = useAgentStore(useCallback(state => state.chats.get(chatKey(agentId))?._currentLoop ?? null, [agentId]));
  const noticeQueue = useAgentStore(useCallback(state => state.chats.get(chatKey(agentId))?.noticeQueue ?? [], [agentId]));
  const pendingRestorePrompt = useAgentStore(useCallback(state => state.chats.get(chatKey(agentId))?.pendingRestorePrompt ?? null, [agentId]));

  const agent = useAgentStore(useCallback(state => state.getAgent(agentId), [agentId]));
  const loadHistory = useAgentStore(s => s.loadHistory);
  const userAvatar = useRoomStore(s => s.userAvatar);
  const userUid = useRoomStore(s => s.userUid);

  const { send, abort, rewind, listCheckpoints } = useChat(agentId);

  const messagesElRef = useRef(null);
  const inputRef = useRef(null);
  const [showTimes, setShowTimes] = useState(new Set());

  // ===== Rewind 菜单状态 =====
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindCheckpoints, setRewindCheckpoints] = useState([]);
  const lastEscAtRef = useRef(0);
  const DOUBLE_ESC_WINDOW = 400;

  const isRunning = agent?.status === 'running';
  // ★ streaming = activeTurn 存在时正在回复，禁止发送新消息
  const isStreaming = activeTurn !== null;
  const hasContent = turns.length > 0 || activeTurn;

  // ★ canOpenRewind：能否开 rewind 菜单的唯一谓词（双击 Esc 与回退按钮共享）
  //   输入框是非受控 textarea，值变化不触重渲染，故用 inputEmpty state 同步
  //   （在 autoResize / 回填 / 清草稿处调 syncInputEmpty 更新）。
  const [inputEmpty, setInputEmpty] = useState(true);
  const syncInputEmpty = useCallback(() => {
    setInputEmpty((inputRef.current?.value.trim() ?? '') === '');
  }, []);
  const canOpenRewind = !isStreaming && inputEmpty;

  const prevActiveTurnIdRef = useRef(null);
  // 用户是否主动上滑离开底部 — 置 true 后停止自动滚底，直到用户滚回底部附近
  const userScrolledAwayRef = useRef(false);

  // 首次加载历史 + 恢复草稿/滚动（仅当 isActive 变为 true 时执行一次）
  // ★ 历史加载 single source：agent running 时由常驻 SSE snapshot 提供（snapshot 设 historyLoaded=true），
  //   本组件不再调 loadHistory——避免 REST 路径与 SSE snapshot 竞态覆盖导致的 user 翻倍/历史错乱。
  //   仅 agent 未运行（无 SSE）时 force 拉一次磁盘历史兜底。
  // notice 按房:激活房把积压的 notice promote 到全局 toastList 显示,清该房 queue。
  //   未激活房 notice 安静积压,切回时本 effect 触发——切房显积压(§4.8)。
  useEffect(() => {
    if (!isActive || !noticeQueue.length) return;
    for (const n of noticeQueue) useAgentStore.getState().showToast(n);
    useAgentStore.getState()._patchChat(agentId, { noticeQueue: [] });
  }, [isActive, noticeQueue, agentId]);

  const initDoneRef = useRef(false);
  useEffect(() => {
    if (!isActive || !agent) return;
    if (initDoneRef.current) return;

    const stopped = agent.status !== 'running';
    if (!historyLoaded && stopped) {
      loadHistory(agentId, { force: true });
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

  // ★ SSE 订阅已上移到 app 级 useAgentSubscriptions（常驻、切 tab 不断），
  //    ChatPanel 不再管理 subscribe 生命周期。本组件只消费 agentStore 里的 turns/activeTurn。

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
    syncInputEmpty();   // 输入框值变化时同步 inputEmpty（驱动回退按钮显隐）
  }, [syncInputEmpty]);

  // elf-018 abort 回填:gateway 已 rewindTo(latest) 删除本轮 user 并经 abortRewind 事件把 restoredPrompt 传来;
  //   一次性消费 → 写 inputRef(对齐 handleRewind 直接写非受控 textarea 的模式)→ 清字段防重放。
  //   ★须在 autoResize 声明之后(依赖数组渲染期即读 autoResize,否则 TDZ)。
  useEffect(() => {
    if (pendingRestorePrompt == null) return;
    if (inputRef.current) {
      inputRef.current.value = pendingRestorePrompt;
      inputRef.current.focus();
      autoResize();
    }
    useAgentStore.getState().updateChatField(agentId, { pendingRestorePrompt: null });
  }, [pendingRestorePrompt, autoResize, agentId]);

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
    const chat = useAgentStore.getState().chats.get(chatKey(agentId));
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
    syncInputEmpty();
    historyNavRef.current = { index: -1, draft: '' };
    send(text);
  }, [send, isStreaming, syncInputEmpty]);

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

  // ===== Rewind 菜单打开/回退 =====
  const [rewindSelected, setRewindSelected] = useState(0);
  // 二段式：list=选 checkpoint；choose=选中"带文件改动"的 cp 后，二选一回退范围（对话+文件 / 只对话）
  const [rewindPhase, setRewindPhase] = useState('list');
  const [rewindModeSelected, setRewindModeSelected] = useState(0);   // 0=对话+文件，1=只对话
  const [pendingCp, setPendingCp] = useState(null);                  // choose 阶段待回退的 {id,prompt}
  const openRewindMenu = useCallback(async () => {
    const cps = await listCheckpoints();
    setRewindCheckpoints(cps);
    setRewindSelected(Math.max(0, cps.length - 1));   // 默认聚焦最近一项（列表最下）
    setRewindPhase('list');
    setRewindOpen(true);
  }, [listCheckpoints]);

  const handleRewind = useCallback(async (checkpointId, restoreFiles = true) => {
    setRewindOpen(false);
    setRewindPhase('list');
    const result = await rewind(checkpointId, restoreFiles);
    if (result?.ok && result.restoredPrompt != null) {
      // 截断后被丢弃的 user prompt 回填输入框（对标 CC "还原进输入框"）
      if (inputRef.current) {
        inputRef.current.value = result.restoredPrompt;
        inputRef.current.focus();
        autoResize();   // 同步高度 + inputEmpty
      }
    }
  }, [rewind, autoResize]);

  // 选中一个 checkpoint：hasFileChanges → 进 choose 二选一；否则直接回退（无文件可动）
  const chooseOrRewind = useCallback((cp) => {
    if (!cp?.id) return;
    if (cp.hasFileChanges) {
      setPendingCp({ id: cp.id, prompt: cp.prompt });
      setRewindModeSelected(0);
      setRewindPhase('choose');
    } else {
      handleRewind(cp.id, true);
    }
  }, [handleRewind]);

  // ★ window 级键盘监听——唯一监听，避免多 window capture 监听冲突
  //   菜单打开时：路由 Arrow/Enter/Esc 给菜单
  //   菜单关闭时：Esc 三分流（①中断 ②清草稿 ③双击开菜单）
  const abortRef = useRef(abort);
  abortRef.current = abort;
  const openRewindMenuRef = useRef(openRewindMenu);
  openRewindMenuRef.current = openRewindMenu;
  const handleRewindRef = useRef(handleRewind);
  handleRewindRef.current = handleRewind;
  const checkpointsCountRef = useRef(0);
  checkpointsCountRef.current = rewindCheckpoints.length;
  const rewindCheckpointsRef = useRef(rewindCheckpoints);
  rewindCheckpointsRef.current = rewindCheckpoints;
  const selectedRef = useRef(rewindSelected);
  selectedRef.current = rewindSelected;
  const chooseOrRewindRef = useRef(chooseOrRewind);
  chooseOrRewindRef.current = chooseOrRewind;
  const rewindPhaseRef = useRef(rewindPhase);
  rewindPhaseRef.current = rewindPhase;
  const rewindModeSelectedRef = useRef(rewindModeSelected);
  rewindModeSelectedRef.current = rewindModeSelected;
  const pendingCpRef = useRef(pendingCp);
  pendingCpRef.current = pendingCp;
  useEffect(() => {
    const onGlobalKeyDown = (e) => {
      const chat = useAgentStore.getState().chats.get(chatKey(agentId));

      // —— 菜单打开时：所有导航键归菜单消费（必须 stopPropagation，否则 Enter 会冒泡到 textarea 触发 handleSend，把回填的 prompt 自动发出去）——
      if (rewindOpen) {
        // choose 阶段：↑↓ 在"对话+文件 / 只对话"二选一，Enter 确认（restoreFiles = 选中项===0），Esc 返回 list
        if (rewindPhaseRef.current === 'choose') {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRewindPhase('list'); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setRewindModeSelected(i => Math.max(i - 1, 0)); return; }
          if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setRewindModeSelected(i => Math.min(i + 1, 1)); return; }
          if (e.key === 'Enter') {
            e.preventDefault(); e.stopPropagation();
            const cp = pendingCpRef.current;
            if (cp?.id) handleRewindRef.current(cp.id, rewindModeSelectedRef.current === 0);
            return;
          }
          return;
        }
        // list 阶段
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setRewindOpen(false);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setRewindSelected(i => Math.max(i - 1, 0));   // 往更旧
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setRewindSelected(i => Math.min(i + 1, Math.max(0, checkpointsCountRef.current - 1)));   // 往最近
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();   // ★ 关键：阻止 Enter 冒泡到 textarea 的 handleSend
          if (checkpointsCountRef.current > 0) {
            const cp = rewindCheckpointsRef.current[selectedRef.current];
            chooseOrRewindRef.current(cp);   // 有文件改动 → choose 二选一；否则直接回退
          }
          return;
        }
        return; // 菜单开着时其他键不进三分流
      }

      // —— 菜单关闭时：Esc 三分流 ——
      if (e.key !== 'Escape') return;

      // 分流①：回复途中 → 中断
      if (chat?.activeTurn && chat._isActive) {
        e.preventDefault();
        e.stopPropagation();
        abortRef.current();
        return;
      }
      // 分流②：输入框有字 → 清草稿
      const input = inputRef.current?.value ?? '';
      if (input.trim() !== '') {
        e.preventDefault();
        if (inputRef.current) {
          inputRef.current.value = '';
          autoResize();   // 同步 inputEmpty（autoResize 内含 syncInputEmpty）
        }
        return;
      }
      // 分流③：输入框空 + 空闲 → 双击开菜单
      const now = Date.now();
      if (now - lastEscAtRef.current < DOUBLE_ESC_WINDOW) {
        e.preventDefault();
        lastEscAtRef.current = 0;
        openRewindMenuRef.current();
      }
      lastEscAtRef.current = now;
    };
    window.addEventListener('keydown', onGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', onGlobalKeyDown, true);
  }, [agentId, rewindOpen, autoResize]);

  if (!isActive) return null;
  if (!agent) return <div className={styles.panel} style={{ display: 'flex', padding: 16, color: '#666' }}>Agent 未就绪</div>;

  return (
    <div className={styles.panel} style={{ display: isActive ? 'flex' : 'none' }}>
      <PrivateToast />
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
                userAvatar={userAvatar}
                userUid={userUid}
                currentLoop={null}
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
                userAvatar={userAvatar}
                userUid={userUid}
                currentLoop={currentLoop}
              />
            )}
          </>
        )}
      </div>
      <div className={styles.inputArea}>
        <div className={styles.inputWrapper}>
          {rewindOpen && rewindPhase === 'list' && (
            <RewindMenu
              checkpoints={rewindCheckpoints}
              selectedIndex={rewindSelected}
              onSelect={setRewindSelected}
              onConfirm={(idx) => {
                const i = (typeof idx === 'number') ? idx : rewindSelected;
                chooseOrRewind(rewindCheckpoints[i]);   // 有文件改动 → choose 二选一；否则直接回退
              }}
              onClose={() => setRewindOpen(false)}
            />
          )}
          {rewindOpen && rewindPhase === 'choose' && (
            <RewindFileChoice
              prompt={pendingCp?.prompt}
              selected={rewindModeSelected}
              onSelect={setRewindModeSelected}
              onConfirm={(restoreFiles) => handleRewind(pendingCp?.id, restoreFiles)}
              onBack={() => setRewindPhase('list')}
              onClose={() => setRewindOpen(false)}
            />
          )}
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
            <>
              {/* 回退按钮：显隐与双击 Esc 开菜单时机严格一致（canOpenRewind）；菜单已开时点击=toggle 关闭 */}
              {canOpenRewind && (
                <button
                  className={styles.rewindBtn}
                  onClick={() => (rewindOpen ? setRewindOpen(false) : openRewindMenu())}
                  title="回退到上一个状态（双击 Esc）"
                >⟲</button>
              )}
              <button
                className={styles.sendBtn}
                onClick={handleSend}
                disabled={!isRunning}
                title="发送"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
