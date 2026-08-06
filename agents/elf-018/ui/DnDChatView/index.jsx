/**
 * DnDChatView — elf-018 聊天区自定义布局
 *
 * 无对话时 → 显示 GameSetupPanel（初始设定页）
 * 有对话时 → 左：聊天面板，右：游戏状态面板（含 state.md + lore 列表 + 改名）
 *
 * ChatPanel 通过 @spa 别名从主 SPA 引入。
 *
 * 面板刷新与聊天区解耦：右侧 SidePanel 用 React.memo 隔离 token 高频更新；
 * loadState 只在「文件可能变化的边沿」触发——整轮结束（activeTurn 有→null）或写类
 * 工具（Write/Edit/WriteOutline/EditOutline）执行完成，不再每帧拉取 game-state。
 * 详见 docs/elf-018-panel-refresh-decouple.md。
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import ChatPanel from '@spa/components/ChatPanel';
import GameSetupPanel from './GameSetupPanel';
import styles from './index.module.css';

/** 写 lore 文件的工具：完成后可能改 lore，触发面板刷新。Roll 等非写工具不入此列。 */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'WriteOutline', 'EditOutline']);

/** 取工具名（兼容 flat name / function.name 两种格式，对齐 ChatPanel 的取法）。 */
function toolNameOf(tc) {
  return tc.name || (tc.function && tc.function.name) || '';
}

/** 折叠条目：name — description，点击展开全文 */
function CollapsibleItem({ item }) {
  const [open, setOpen] = useState(false);
  const body = (item.content || '')
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .trim();
  if (!item.name && !body) return null;
  return (
    <div className={styles.collapsible}>
      <div className={styles.itemRow} onClick={() => setOpen(v => !v)}>
        <span className={styles.chevron}>{open ? '▼' : '▶'}</span>
        {item.name && <strong className={styles.itemName}>{item.name}</strong>}
        {item.description && <span className={styles.itemDesc}> — {item.description}</span>}
      </div>
      {open && body && (
        <pre className={styles.itemBody}>{body}</pre>
      )}
    </div>
  );
}

/** 分类区块：带标题 + 条目列表 + 滚动 */
function LoreBlock({ title, items }) {
  if (!items || items.length === 0) return null;
  return (
    <div className={styles.loreBlock}>
      <p className={styles.blockTitle}>{title}（{items.length}）</p>
      {items.map((it, i) => <CollapsibleItem key={i} item={it} />)}
    </div>
  );
}

/**
 * 右侧游戏状态面板。React.memo 隔离：props 仅 state/loading（流式期间引用稳定），
 * 故左侧 token 高频更新（带动父 DnDChatView 重渲染）时，本子树跳过 reconcile。
 */
const SidePanel = React.memo(function SidePanel({ state, loading }) {
  if (loading) return <div className={styles.loading}>加载中…</div>;
  if (!state) return <div className={styles.loading}>暂无游戏状态数据</div>;
  return (
    <>
      {/* 主角 */}
      {state.protagonist && (
        <div className={styles.protagonistBox}>
          <p className={styles.blockTitle}>主角：{state.protagonist.name}</p>
          <pre className={styles.protagonistBody}>
            {(state.protagonist.content || '')
              .replace(/^---\n[\s\S]*?\n---\n?/, '')
              .trim()}
          </pre>
        </div>
      )}

      {/* lore 列表 */}
      <LoreBlock title="角色" items={state.characters} />
      <LoreBlock title="地点" items={state.locations} />
      <LoreBlock title="任务" items={state.quests} />
      <LoreBlock title="物品" items={state.items} />
      <LoreBlock title="技能" items={state.skills} />

      {/* state.md 故事态 */}
      {state.state && (
        <div className={styles.loreBlock}>
          <p className={styles.blockTitle}>故事态</p>
          <CollapsibleItem item={state.state} />
        </div>
      )}

      {/* metadata */}
      <div className={styles.loreBlock}>
        <p className={styles.blockTitle}>Metadata</p>
        <pre className={styles.metadataBody}>{state.metadata}</pre>
      </div>
    </>
  );
});

export default function DnDChatView({ bridge }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);

  // bridge 用 ref 持有，避免 loadState 依赖 bridge。bridge 流式时每帧重建，
  //   若 loadState 依赖它 → loadState 每帧新引用 → mount-effect 每帧重跑 →
  //   每帧 GET /game-state（旧 bug）。用 ref 后 loadState 引用恒定。
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  // silent=true：边沿刷新时静默更新——不闪「加载中…」、不覆盖现有内容。
  const loadState = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    bridgeRef.current.call('GET', '/game-state')
      .then(setState)
      .catch(() => { if (!silent) setState(null); })
      .finally(() => { if (!silent) setLoading(false); });
  }, []);

  // 初始加载（mount 一次；loadState 引用稳定，effect 不再每帧重跑）
  useEffect(() => { loadState(); }, [loadState]);

  // —— 文件可能变化的边沿 → 静默刷新面板 ——
  //   ① activeTurn 有→null：整轮结束（done / abort 收尾），刷一次。
  //   ② 写类工具 executing→完成：lore 可能刚被写，刷一次。token 流不改 lore，故不触发。
  //   每个 token 帧此 effect 会重跑（activeTurn 引用每帧变），但体只做遍历比较、不发请求；
  //   仅在边沿成立时静默 loadState，并用 toolCall id 去重防多帧重复触发。
  const activeTurn = bridge.activeTurn;
  const prevActiveTurnRef = useRef(activeTurn);
  const firedToolCallIdsRef = useRef(new Set());
  useEffect(() => {
    const prev = prevActiveTurnRef.current;
    const cur = activeTurn;

    if (prev && !cur) {
      // 信号①：整轮结束
      loadState(true);
      firedToolCallIdsRef.current = new Set(); // 下一轮重新计数
    } else if (cur) {
      // 信号②：扫描写类工具完成边沿
      for (const b of (cur.assistantBubbles || [])) {
        for (const tc of (b.toolCalls || [])) {
          if (tc.id && WRITE_TOOLS.has(toolNameOf(tc)) &&
              tc.status && tc.status !== 'executing' &&
              !firedToolCallIdsRef.current.has(tc.id)) {
            firedToolCallIdsRef.current.add(tc.id);
            loadState(true);
          }
        }
      }
    }
    prevActiveTurnRef.current = cur;
  }, [activeTurn, loadState]);

  const hasHistory = bridge.turns.length > 0 || bridge.activeTurn;

  // —— 无对话 → 初始设定页 ——
  //   onCommitted：开始游戏 commit 成功后立刻静默刷一次面板。commit 把 setup 临时目录固化进
  //   正式 runtime/lore，此时 activeTurn 还没出现、写工具也还没跑，两条刷新边沿都不触发，
  //   面板会一直停在 commit 前的旧 state，直到整轮结束才更新。此处补一个 commit 边沿强制加载。
  if (!hasHistory) {
    return (
      <div className={styles.layout}>
        <GameSetupPanel bridge={bridge} onCommitted={() => loadState(true)} />
      </div>
    );
  }

  // —— 有对话 → 聊天 + 面板 ——
  return (
    <div className={styles.layout}>
      {/* 左：聊天 */}
      <div className={styles.chatArea}>
        <ChatPanel agentId={bridge.agentId} />
      </div>

      {/* 右：游戏状态面板（memo 隔离 token 高频更新） */}
      <div className={styles.sidePanel}>
        <SidePanel state={state} loading={loading} />
      </div>
    </div>
  );
}
