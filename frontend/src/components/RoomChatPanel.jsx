import { useState, useRef, useEffect, useCallback } from 'react';
import Avatar from './Avatar';
import { useRoomStore } from '../stores/roomStore.js';
import useAgentStore from '../stores/agentStore.js';
import { useRoomChat } from '../hooks/useRoomChat.js';
import MarkdownContent from './MarkdownContent';
import ToastStack from './Toast';
import styles from './RoomChatPanel.module.css';

/**
 * 把消息文本里的 @name 包成 markdown 链接 [@name](#mention-name)，
 * 经 react-markdown 渲染成 <a class=mention>@name</a> 实现蓝字高亮。
 * 最长匹配(对齐 wolf public/app.js):名字按长度降序,最先 startsWith 命中即最长。
 */
function highlightMentions(content, memberNames) {
  if (!content || !memberNames?.length) return content || '';
  const names = [...new Set(memberNames)].filter(Boolean).sort((a, b) => b.length - a.length);
  let result = '';
  let i = 0;
  while (i < content.length) {
    if (content[i] === '@') {
      const after = content.slice(i + 1);
      let matched = false;
      for (const name of names) {
        if (after.startsWith(name)) {
          result += `[@${name}](#mention-${encodeURIComponent(name)})`;
          i += 1 + name.length;
          matched = true;
          break;
        }
      }
      if (!matched) { result += '@'; i++; }
    } else {
      // 转义 markdown 特殊字符避免破坏(简单处理,不全面)
      result += content[i];
      i++;
    }
  }
  return result;
}

/** 收集成员名(用于@高亮):各 agent 的 id 和 display name + 全部注册用户显示名 */
function collectMemberNames(members, users, userName, messages) {
  const names = [];
  for (const m of members || []) {
    names.push(m.agentId);
    // display name 不同于 agentId 时也收录,使 @显示名 同样能高亮
    if (m.name && m.name !== m.agentId) names.push(m.name);
  }
  // 多用户：所有注册用户的名都可 @ 高亮（含自己）
  for (const u of users || []) {
    if (u?.name) names.push(u.name);
  }
  if (userName) names.push(userName);
  names.push('user'); // 兼容历史记录里 speaker='user'
  // v3：移除成员后其历史发言/被 @ 的名字仍要能高亮 → 从历史消息里补录 speaker 名。
  //   历史里 content 的 @ 已是 name 版（gateway 改写），这里只补 speaker 显示名。
  for (const m of messages || []) {
    if (m.speaker && !names.includes(m.speaker)) names.push(m.speaker);
  }
  return names;
}

/**
 * 群聊面板：多发言人气泡（整块消息）+ 成员状态条 + 发送框。
 * 与私聊 ChatPanel 平行：整块非流式、无工具徽章/rewind（内心活动不外露）。
 *
 * gateway 已统一渲染：speaker/speakerUid 分离（speaker=name 显示用，speakerUid=uid 查 avatar），
 * content 里 @id 已改写成 @name。前端不再做 id→name 改写，只做 @name 蓝字高亮。
 */
export default function RoomChatPanel({ roomId }) {
  const chat = useRoomStore(s => s.roomChats.get(roomId));
  const userName = useRoomStore(s => s.userName);
  const userUid = useRoomStore(s => s.userUid);
  const userAvatar = useRoomStore(s => s.userAvatar);
  const { send } = useRoomChat(roomId);
  const [input, setInput] = useState('');
  const listRef = useRef(null);

  const messages = chat?.messages || [];
  const members = chat?.members || [];
  const users = chat?.users || [];   // 多用户：{uid,name,avatar} 目录（loadRoomMembers 载入）
  const noticeQueue = chat?.noticeQueue || [];

  // 用户是否主动上滑离开底部 — 置 true 后新消息不自动滚底,直到用户滚回底部附近
  const userScrolledAwayRef = useRef(false);

  // 检测是否在底部附近(阈值 120px,对齐私聊 ChatPanel 的体感)
  const isNearBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return true;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= 120;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    // 上翻到顶 → 加载更早历史(与私聊 ChatPanel.handleScroll 同构,锚定滚动位置)
    if (listRef.current && listRef.current.scrollTop <= 50) {
      const prevHeight = listRef.current.scrollHeight;
      useRoomStore.getState().loadMoreHistory(roomId).then((res) => {
        if (res && listRef.current) {
          requestAnimationFrame(() => {
            listRef.current.scrollTop = listRef.current.scrollHeight - prevHeight;
          });
        }
      });
    }
    // 用户向上滚离开底部后停止自动滚底;滚回底部附近则恢复跟随
    userScrolledAwayRef.current = !isNearBottom();
  }, [roomId, isNearBottom]);

  // notice 按房:本面板挂载即激活(互斥渲染),把该房积压 notice promote 到 roomToastList 显示,清 queue。
  useEffect(() => {
    if (!noticeQueue.length) return;
    for (const n of noticeQueue) useRoomStore.getState().showRoomToast(n);
    useRoomStore.getState()._patchChat(roomId, { noticeQueue: [] });
  }, [noticeQueue, roomId]);

  /** 点击 @mention 跳转到指定 Agent 私聊 */
  const handleMentionClick = useCallback((name) => {
    // name 可能是 agentId 也可能是 display name，查找匹配的 agentId
    const member = (members || []).find(m => m.agentId === name || m.name === name);
    if (!member) return;
    // 清群聊选中 → 选中该 agent 私聊
    useRoomStore.getState().clearActiveRoom();
    useAgentStore.getState().selectAgent(member.agentId);
  }, [members]);

  // 新消息滚到底:仅当用户停留在底部附近时跟随;用户主动上滑翻历史时不打扰
  useEffect(() => {
    if (userScrolledAwayRef.current) return;
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  // 切换房间时复位「离开底部」标记,新房间首次进入直接滚到底(不被上一房间的上滑状态带偏)
  useEffect(() => {
    userScrolledAwayRef.current = false;
    scrollToBottom();
  }, [roomId, scrollToBottom]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    // 自己发消息视为重新关注底部:清除「离开底部」标记,消息回来时自动滚到底
    userScrolledAwayRef.current = false;
    try {
      await send(text);
    } catch (e) {
      setInput(text); // 失败回填原始输入
    }
  };

  const isComposingRef = useRef(false);

  const onKeyDown = (e) => {
    // IME 合成中(中文输入法选词)回车不发送,对齐私聊 ChatPanel
    if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      handleSend();
    }
  };

  const onCompositionStart = () => { isComposingRef.current = true; };
  // 构建 uid → 成员信息的快速查找（speakerUid 即 agentId）
  const memberMap = {};
  members.forEach(m => { memberMap[m.agentId] = m; });

  /** 解析发言者：speaker=name（显示），speakerUid=uid（查 avatar）。
   *  多用户：返回 { name, avatar, kind, uid }，kind ∈ 'self'|'user'|'agent' ——
   *  自己右侧，其他注册用户左侧用户样式，agent 左侧成员样式。 */
  const resolveSpeaker = (msg) => {
    const uid = msg.speakerUid;
    // 自己（右侧）：uid 匹配 / 历史无 uid 且 speaker='user'
    if (uid === userUid || (!uid && (msg.speaker === userName || msg.speaker === 'user'))) {
      return { name: msg.speaker || userName || 'user', avatar: userAvatar, kind: 'self', uid: userUid };
    }
    // 其他注册用户（左侧用户样式）
    const u = users.find(x => x.uid === uid);
    if (u) {
      return { name: u.name, avatar: u.avatar, kind: 'user', uid };
    }
    // 成员：按 uid 查 memberMap；兼容老消息（无 speakerUid）按 name/agentId 匹配
    const m = memberMap[uid] || members.find(m => m.agentId === uid || m.name === msg.speaker);
    if (m) return { name: m.name || m.agentId, avatar: m.avatar, kind: 'agent', uid: m.agentId };
    // 已被移除的成员：name 兜底 uid/agentId，避免 undefined.charAt 白屏
    const name = msg.speaker || uid || 'agent';
    return { name, avatar: null, kind: 'agent', uid: uid || null };
  };

  const onCompositionEnd = () => { isComposingRef.current = false; };

  // 群聊居中通知（多条竖排，LLM 重试/失败），复用共享 ToastStack
  const roomToastList = useRoomStore(s => s.roomToastList);
  const removeRoomToast = useRoomStore(s => s.removeRoomToast);

  return (
    <div className={styles.container}>
      <ToastStack toasts={roomToastList} remove={removeRoomToast} styles={styles} />
      {/* 消息列表 */}
      <div className={styles.messageList} ref={listRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className={styles.empty}>群里还没有消息。发一条试试（@某成员 让它回复）。</div>
        )}
        {messages.map((m, i) => {
          const speakerInfo = resolveSpeaker(m);
          // content 已是 name 版（gateway 改写），只做 @name 蓝字高亮
          const highlighted = highlightMentions(m.content, collectMemberNames(members, users, userName, messages));
          if (speakerInfo.kind === 'self') {
            return (
              <div key={m.id || i} className={styles.userMessage}>
                <div className={styles.userAvatar}>
                  <Avatar kind="user" uid={userUid} avatar={userAvatar} fallback={(userName || 'U').charAt(0).toUpperCase()} bgColor="#07c160" />
                </div>
                <div className={styles.userBody}>
                  <div className={styles.userBubble}>
                    <MarkdownContent content={highlighted} onMentionClick={handleMentionClick} />
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div key={m.id || i} className={styles.assistantGroup}>
              <div className={styles.avatar}>
                {speakerInfo.kind === 'user' ? (
                  <Avatar kind="user" uid={speakerInfo.uid} avatar={speakerInfo.avatar} bgColor="#4a90d9" fallback={speakerInfo.name.charAt(0).toUpperCase()} />
                ) : (
                  <Avatar kind="agent" agentId={speakerInfo.uid} avatar={speakerInfo.avatar} bgColor="#4a90d9" fallback={speakerInfo.name.charAt(0).toUpperCase()} />
                )}
              </div>
              <div className={styles.assistantCol}>
                <div className={styles.speakerName}>{speakerInfo.name}</div>
                <div className={styles.groupBody}>
                  <div className={styles.content}>
                    <MarkdownContent content={highlighted} onMentionClick={handleMentionClick} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 发送框 */}
      <div className={styles.inputBar}>
        <textarea
          className={styles.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          placeholder="发消息…（@elf-001 让它回复）"
          rows={1}
        />
        <button className={styles.sendBtn} type="button" aria-label="发送" onClick={handleSend} disabled={!input.trim()}></button>
      </div>
    </div>
  );
}