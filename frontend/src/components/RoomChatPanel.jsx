import { useState, useRef, useEffect, useCallback } from 'react';
import Avatar from './Avatar';
import { useRoomStore } from '../stores/roomStore.js';
import useAgentStore from '../stores/agentStore.js';
import { useRoomChat } from '../hooks/useRoomChat.js';
import MarkdownContent from './MarkdownContent';
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

/** 收集成员名(用于@高亮):各 agent 的 id 和 display name + 用户名(userName) */
function collectMemberNames(members, userName) {
  const names = [];
  for (const m of members || []) {
    names.push(m.agentId);
    // display name 不同于 agentId 时也收录,使 @显示名 同样能高亮
    if (m.name && m.name !== m.agentId) names.push(m.name);
  }
  if (userName) names.push(userName);
  names.push('user'); // 兼容历史记录里 speaker='user'
  return names;
}

/**
 * 构建 id → display name 的替换映射（仅当 name 存在且与 id 不同时收录）。
 * 含 agent 成员的 agentId → name，以及 'user' → userName。
 * 用于上下文渲染：把正文里出现的成员 id 统一显示成名字。
 */
function buildIdToNameMap(members, userName) {
  const map = new Map();
  for (const m of members || []) {
    if (m.name && m.name !== m.agentId) map.set(m.agentId, m.name);
  }
  if (userName && userName !== 'user') map.set('user', userName);
  return map;
}

/**
 * 把正文里出现的成员 id（agentId / 'user'）替换成对应 display name。
 * 按 id 长度降序替换，避免短 id 误命中长 id 的子串。
 * 不替换 Markdown 链接语法 [...]() 内的 id（简单规避，不全面）。
 */
function replaceIdsWithNames(content, idToName) {
  if (!content || idToName.size === 0) return content || '';
  const entries = [...idToName.entries()].sort((a, b) => b[0].length - a[0].length);
  let result = content;
  for (const [id, name] of entries) {
    // 转义正则元字符（agentId 一般是 [a-z0-9-]，稳妥起见仍 escape）
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(safe, 'g'), name);
  }
  return result;
}

/**
 * 发送前改写消息里的 @<成员id> 为 @<display name>：
 * 用户若写了 @agentId 且该 id 在群成员里、且有 display name，则替换为 @name；
 * @user / @<userName> 统一归一到 @userName（供其他 agent 在上下文里看到一致的用户名）。
 * 最长匹配优先：成员候选按 id/name 长度降序，每处 @ 取最先命中。
 *
 * 后端 parseMentions 同时认 id 和 name，故改写到 name 不影响路由与 @命中。
 */
function rewriteMentionsOnSend(text, members, userName) {
  if (!text) return text;
  // 候选：把已知成员的 id 与 user 标识都映射到目标 display name
  const candidates = [];
  const push = (value, target) => {
    if (value) candidates.push({ value, target });
  };
  for (const m of members || []) {
    if (m.name && m.name !== m.agentId) push(m.agentId, m.name);
    push(m.name, m.name);
    push(m.agentId, m.name || m.agentId);
  }
  const un = userName || 'user';
  push('user', un);
  if (un) push(un, un);
  // 去重 + 按长度降序（最长优先），同长度保持稳定
  const seen = new Set();
  const deduped = candidates.filter(c => {
    const k = c.value;
    if (seen.has(k)) return false; seen.add(k); return true;
  }).sort((a, b) => b.value.length - a.value.length);

  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '@') {
      const after = text.slice(i + 1);
      let hit = null;
      for (const c of deduped) {
        if (after.startsWith(c.value)) { hit = c; break; }
      }
      if (hit) {
        result += `@${hit.target}`;
        i += 1 + hit.value.length;
        continue;
      }
    }
    result += text[i];
    i++;
  }
  return result;
}

/**
 * 群聊面板：多发言人气泡（整块消息）+ 成员状态条 + 发送框。
 * 与私聊 ChatPanel 平行：整块非流式、无工具徽章/rewind（内心活动不外露）。
 */
export default function RoomChatPanel({ roomId }) {
  const chat = useRoomStore(s => s.roomChats.get(roomId));
  const userName = useRoomStore(s => s.userName);
  const userAvatar = useRoomStore(s => s.userAvatar);
  const { send } = useRoomChat(roomId);
  const [input, setInput] = useState('');
  const listRef = useRef(null);

  const messages = chat?.messages || [];
  const members = chat?.members || [];

  /** 点击 @mention 跳转到指定 Agent 私聊 */
  const handleMentionClick = useCallback((name) => {
    // name 可能是 agentId 也可能是 display name，查找匹配的 agentId
    const member = (members || []).find(m => m.agentId === name || m.name === name);
    if (!member) return;
    // 清群聊选中 → 选中该 agent 私聊
    useRoomStore.getState().clearActiveRoom();
    useAgentStore.getState().selectAgent(member.agentId);
  }, [members]);

  // 新消息滚到底
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text) return;
    // 发送前把 @agentId / @user 改写为 @display name，使其他 agent 看到的上下文一致
    const out = rewriteMentionsOnSend(text, members, userName);
    setInput('');
    try {
      await send(out);
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
  // 构建 agentId → 成员信息的快速查找
  const memberMap = {};
  members.forEach(m => { memberMap[m.agentId] = m; });

  /** 解析发言者：返回 { name, avatar } */
  const resolveSpeaker = (speaker) => {
    if (speaker === userName || speaker === 'user') {
      return { name: userName || 'user', avatar: null, isUser: true };
    }
    const m = memberMap[speaker];
    if (m) return { name: m.name || m.agentId, avatar: m.avatar, isUser: false };
    return { name: speaker, avatar: null, isUser: false };
  };

  const onCompositionEnd = () => { isComposingRef.current = false; };

  return (
    <div className={styles.container}>
      {/* 消息列表 */}
      <div className={styles.messageList} ref={listRef}>
        {messages.length === 0 && (
          <div className={styles.empty}>群里还没有消息。发一条试试（@某成员 让它回复）。</div>
        )}
        {messages.map((m, i) => {
          const speakerInfo = resolveSpeaker(m.speaker);
          const isUser = speakerInfo.isUser;
          // 上下文渲染：把正文里出现的成员 id 统一替换成 display name，再 @高亮
          const idToName = buildIdToNameMap(members, userName);
          const display = replaceIdsWithNames(m.content, idToName);
          const highlighted = highlightMentions(display, collectMemberNames(members, userName));
          if (isUser) {
            return (
              <div key={m.id || i} className={styles.userMessage}>
                <div className={styles.userAvatar}>
                  <Avatar kind="user" avatar={userAvatar} fallback={(userName || 'U').charAt(0).toUpperCase()} bgColor="#07c160" />
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
                <Avatar kind="agent" agentId={m.speaker} avatar={speakerInfo.avatar} bgColor="#4a90d9" fallback={speakerInfo.name.charAt(0).toUpperCase()} />
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
        <button className={styles.sendBtn} onClick={handleSend} disabled={!input.trim()}>发送</button>
      </div>
    </div>
  );
}