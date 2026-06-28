# 切换 Agent 导致对话内容翻倍 Bug 分析

**日期**：2026-06-28
**状态**：🔍 方案待实施（纯前端改动，不影响后端）
**涉及文件**：`frontend/src/hooks/useChat.js`、`frontend/src/components/ChatPanel.jsx`、`frontend/src/stores/agentStore.js`

> 与 `streaming-bug-analysis.md`（已修复的"流式不实时更新"引用不可变性问题）**不是同一个 bug**，本文档针对的是"内容翻倍"。

## 现象

用户发了一条消息，Agent 正在流式回复中，用户切到别的 Agent 页面再切回来 —— 这一轮的**用户消息和 Agent 回复历史被复制成两份**（user × 2 + assistant × 2）。

## 后端是否受影响

**不受影响。后端状态是健全的，本 bug 完全是前端问题。** 依据：

- `gateway/chat_proxy.js:` 每次 `POST /chat` 只创建一个 `StreamContext` 并 `streamContexts.set(id, ctx)`；`subscribe` 复用同一个 ctx，只读地把自己加进 `ctx.subscribers`（`:277`），**不新建流、不写历史**。
- `flushRoundToHistory` 写入 jsonl 时有 `if (assistantContent || assistantToolCalls.length > 0)` 守门，且写后清空（`:91-98`），同一 ctx 内幂等。
- `proxyChat` 末尾 `done` 只广播一次（`:380`），不会双写 jsonl。

后端 jsonl 里这一轮只有单份 user + 单份 assistant，`loadHistory` 读出来的源头是干净的。**翻倍发生在前端 store 的状态合并阶段，不是后端数据**。

> 因此修复**不应触碰后端**。涉及 SSE 协议、`StreamContext`、jsonl 持久化的改动一律不在本方案内。

## 前端根因（简化版）

> 用户原文转述：当 user 说了一句话，agent 正在回复中，用户切到别的 agent 页面然后再切换回来，用户说的话和 agent 的回复历史被复制成两份。

1. **发消息时 `chat.streaming` 从未被设为 true。** `useChat.send()` 只 `patchChat({ activeTurn: newTurn })`（`useChat.js:328`），全代码没有任何一处 `patchChat({ streaming: true })`。`streaming` 字段只在连接关闭时被设成 `false`（`useChat.js:390`）。

2. **原始 `/chat` 的 SSE 流在组件卸载时没有被 abort。** `send()` 调 `api.chat(agentId, message, { onEvent })`（`useChat.js:331`）**没有传 `signal`**，组件卸载（切走 agent）也没人 abort 它。这条流在浏览器里继续 fire `_handleSSEEvent`，继续给同一个 `activeTurn` patch token，直到自己跑到 `done`/`idle`。

3. **真正的卸载来自 `key={activeAgentId}`，不是 `return null`。** `App.jsx:85` 是 `<ChatPanel key={activeAgentId} agentId={activeAgentId} />`。切到别的 agent 时 `activeAgentId` 变化 → React 销毁当前 ChatPanel 实例；切回来时是**全新 mount 的实例**，所有 `useRef`（`reconnectedRef`、`initDoneRef`）重置为初始值。
   - ⚠️ 更正：早期分析误把卸载归因到 `ChatPanel.jsx:309` 的 `if (!isActive) return null`。那只是"当帧不渲染"，`isActive` 的 true/false 切换本身不造成 unmount；真正的 remount 是 `key` 变化驱动的。两者后果（ref 重置）相同，但来源不同，修复方案的守门点也要落在后者。

4. **切回后重连 effect 触发第二条 SSE 流。** 全新实例 mount，重连 effect（`ChatPanel.jsx:190`）跑：`isActive=true`（`selectAgent` 把该 chat 的 `_isActive` 置 true）、`agent.streaming=true`（后端 `activeStreams>0`，A 这一轮还在回复）、`reconnectedRef.current=false` → 触发 `startPolling()` → `api.subscribe(A, { onEvent: _handleSSEEvent })`。
   - 与此同时，旧实例虽已 unmount，但 `send()` 闭包里的 `api.chat()` fetch reader **没有 signal、无人 abort**（`cleanup` 只 abort `subscribeControllerRef`），它注册的 `_handleSSEEvent` 回调作为闭包继续存活在 JS 运行时，仍在往 store 的 chat A 写 token/事件，直到自己跑到 `done`/`idle`。
   - 结果：**两条 SSE 数据源同时写同一个 chat 对象** —— 一条是全新实例的 `/subscribe` 流（先收到 `snapshot`，再收后续广播），一条是旧实例闭包持有的 `/chat` 流。后端 `broadcastChunk` 把同一批 chunk 同时发给 `primaryRes` 和新 subscriber，前端两路各自调 `_handleSSEEvent` 写同一份 store → **同一批事件被处理两次**。

5. **关键修正（据用户线索）：切回时根本不会开第二条 SSE 流。** 用户报告"切换到另一个 agent 再切回来，另一个 agent 没有发请求、也不会推送消息"——这正是判定生死的事实。重连 effect(`ChatPanel.jsx:197`)入口 `if (!agent.streaming) return;` 若为真就 `return`，**不发 subscribe**。而：
   - **`agent.streaming` 取自陈旧的 `agents` 数组**。`selectAgent`(`agentStore.js:114`)切回 A 时 `agent = get().agents.find(...)` 直接用内存里**现有**的 agents，**不重新 `GET /agents`**；只有 A 非 running 时才 `refreshAgents`(`:115-124`)。A 正在流式回复时仍处于 running，不会刷新。
   - `agent.streaming` 字段值是**上一次** `loadAgents`/`refreshAgents` 落盘的 `activeStreams>0` 快照(`server.js:46`)。发消息瞬间前端不会主动刷新 agents（`send` 不调 refreshAgents），所以切回时 `agent.streaming` 极可能是**陈旧的 false**（上次落盘时 A 尚未流式）。
   - → 重连 effect `!agent.streaming` 命中 → **不 subscribe、无请求、无推送**。✅ 与用户观察一致。
   - **因此"双流 double-process"假设被推翻**：切回时只有旧 `/chat` 闭包这一条数据源在写 store，不存在 subscribe 第二条流。前面第 5-7 段基于"双流"的推演作废。

6. **真正的翻倍来源：初始化 effect 的 `loadHistory` 把已落盘的 user 读进 `turns`，与仍存活的 `activeTurn` 同框。** 切回全新实例后，唯一能动 store 的是初始化 effect(`ChatPanel.jsx:167`)：
   ```
   if (!historyLoaded && !agent.streaming) {   // :171
     loadHistory(agentId);
   }
   ```
   `agent.streaming` 陈旧为 false（上段），若此时 `historyLoaded` 也是 false，则 `true && true` 命中 → **`loadHistory(A)` 执行**。

   `loadHistory`(`agentStore.js:140`)→ `getRecent(A)` 全盘读 jsonl。而 `server.js:152` 在 **`/chat` 发消息瞬间就把 `user:'hi'` `appendFileSync` 落盘**（`chat_history.js:72`），assistant 在流未结束时还没 `flushRoundToHistory` → jsonl 此时 = `[user:'hi']` → `historyToTurns`(`agentStore.js:21`)建出 **`turns=[{user:'hi', bubbles:[]}]`**（只含 user，见 `:24-26` user 分支）。

   store 变为：`{ turns:[{user:'hi', bubbles:[]}], activeTurn:T1(旧闭包仍在写,含 user:'hi'+部分助理内容), historyLoaded:true }`。

7. **结构翻倍就在渲染层发生（已确证）。** `ChatPanel` 渲染(`:319-344`):
   ```
   turns.map(turn => <TurnView .../> )   // 渲染 turns[0] = {user:'hi'}  ← 第一份 user + 空 assistant
   activeTurn && <TurnView turn={activeTurn} .../>  // 渲染 T1 = {user:'hi', 旧闭包的流式内容} ← 第二份 user + assistant
   ```
   → **user 'hi' 渲染两份；assistant 内容由 activeTurn 出一份**。旧 `/chat` 闭包继续把后续 token 写进 `activeTurn` 的 bubble，assistant 实时增长。最终这一轮在界面上呈现"两条 user 消息 + assistant 回复"，正是用户报告的"对话被复制两份"。**全程无第二条 SSE 流、无订阅、无推送**，只有一个 `GET /agents/:id/history`。

8. **`historyLoaded` 为何在切回时是 false —— 这是翻倍的触发闸门，也是唯一需要确认的支点。** grep 确认 `historyLoaded` 写入点仅四个：懒创建 `false`(`:101`)、`loadHistory` 成功 `true`(`:152`)、`clearHistory` `false`(`:216`)、snapshot `true`(`useChat.js:102`)。**`selectAgent` 切走/切回都不碰它**(`:81-126` 只动 `_isActive`)。所以切回时的值 = 上一次该 chat 交互结束时的值。翻倍发生在 `historyLoaded === false`——唯一成立的典型路径：
   - 用户**进入 A 后 agent 处于流式中**(例如页面刷新重连、或上一轮尚未结束)，进入 A 实例时初始化 effect `:171` 因 `agent.streaming=true`(那次是新鲜值)而**跳过 loadHistory**，`historyLoaded` 保持 `false`；
   - 用户又发新消息(后端此时已允许，因为上一轮可能已结束)或正处于上一轮流式中；
   - 立即切到 B 再切回 A：`historyLoaded` 仍是 `false`，而切回时 `agent.streaming` 因 `selectAgent` 不刷新而**陈旧为 false** → `:171` 命中 → `loadHistory` → 翻倍。
   - 另一朴素路径：A 首次被选中并 `selectAgent` auto-start 后，用户赶在初始化 effect 第一次判定之前/或 `historyLoaded` 尚未置 true 的窗口内发消息并发起流式，随后切走切回。
   - **无论哪条，闸门都是 `historyLoaded===false && agent.streaming(陈旧)===false` 同时成立。** 这也是为什么只在"切走再切回"复现、而一直停留在 A 不会：停留时 `historyLoaded` 早已 true，`loadHistory` 不会再跑。

   一句话（最终修正）：`agent.streaming` 陈旧为 false 使重连 effect 不 subscribe（无第二流、无推送）；但同一陈旧值让初始化 effect 的 `!historyLoaded && !agent.streaming` 命中 `loadHistory`，把发消息瞬间已落盘的 user 读进 `turns`，与旧 `/chat` 闭包仍在维护的 `activeTurn` 同框渲染 → user 双份、assistant 一份并在增长。**翻倍是单流 + loadHistory 时序竞态，不是双流。**

## 修复方案

对症下药。翻倍机制是 **`activeTurn` 存活期间 `loadHistory` 把已落盘的 user 重复读进 `turns`** —— 根因是初始化 effect 用**陈旧的 `agent.streaming`** 做守门，而它在该场景下是 false，放行了 loadHistory。守门应当用**前端权威的 `activeTurn`**（"这一轮在途"的唯一可靠信号），而不是可能陈旧的后端 `agent.streaming`。

### 1.（核心）初始化 effect 守门改用 `activeTurn`

`ChatPanel.jsx:171`：
```js
// 修复前
if (!historyLoaded && !agent.streaming) {
  loadHistory(agentId);
}
// 修复后：用前端在途信号 activeTurn 替代陈旧的后端 agent.streaming
if (!historyLoaded && !activeTurn) {
  loadHistory(agentId);
}
```

**为什么有效（静态推演）**：切回时 `activeTurn=T1`(在途)为非 null → `!activeTurn`=false → **不 loadHistory** → `turns` 不会被塞入已落盘的 user → **不翻倍**。新实例只渲染 `activeTurn` 一份(user+assistant)，由旧闭包继续驱动。流结束 `done`→`finalizeActiveTurn`→`turns=[T1]`、`activeTurn=null`，单份收尾。✅
- `activeTurn` 是 zustand 前端状态，被旧 `/chat` 闭包实时维护，**不会像 `agent.streaming` 那样陈旧**。
- `activeTurn` 已是组件 selector(`:139`)，无新增依赖。

### 2.（兜底）`loadHistory` 入口加 `activeTurn` 守卫

`agentStore.js:140` `loadHistory`，以及 `_patchChat`/直接 set turns 的入口，在写 `turns` 前若 `chat.activeTurn` 非空则跳过 / 或清掉 activeTurn。防止未来其它路径（滚顶分页 `loadMoreHistory`、或 `idle` 一旦被启用）在 activeTurn 在途时触发 loadHistory 再现同类问题：
```js
loadHistory: async (agentId) => {
  const chats = new Map(get().chats);
  const chat = chats.get(agentId);
  if (!chat) return;
  // ★ activeTurn 在途时不 loadHistory，避免把已落盘的在途消息重复读进 turns
  if (chat.activeTurn) return;
  ...原逻辑
}
```
（仅 `loadHistory` 需要；`loadMoreHistory` 是向前翻页、读取更早的消息、不影响在途轮，可视情况不加。）

### 3.（可选）顺带修正 `agent.streaming` 陈旧问题

`selectAgent` 切回时若 A 处于 running，可 `await refreshAgents()` 拿到新鲜 `agent.streaming`，使重连 effect 在"真·后端在流式且前端流已断（刷新）"场景正确 subscribe。**但本 bug 的修复不依赖此点**（方案 1 用 `activeTurn` 彻底绕开了 `agent.streaming`）；此为独立改进，避免其它依赖 `agent.streaming` 的判断出错。

### 不需要的改动（澄清）

- **不需要** `send` 置 `chat.streaming=true` 之类（那是为"堵 subscribe 双流"设计的，而本 bug 根本无双流）。
- **不需要** `startPolling` 加 streaming 守卫（切回时根本没走 subscribe）。
- 前面对"双流 double-process"的修复方案已随根因修正一并作废。

## 方案有效性推演（纯静态）

代入方案 1（`:171` 守门 `!historyLoaded && !activeTurn`）+ 方案 2（`loadHistory` 入口 `if (chat.activeTurn) return`），重走翻倍场景：

切回瞬间 store(旧 `/chat` 闭包仍在写)：`{ turns:[], activeTurn:T1(在途), historyLoaded:false, ... }`。

1. **新实例重连 effect**：`agent.streaming` 陈旧 false → `!agent.streaming` 命中 `return` → **不 subscribe**（与现状一致，无请求、无推送）。
2. **初始化 effect**(`:167`)：`!historyLoaded(false) && !activeTurn(T1 存活→非 null→!activeTurn=false)` = `true && false` = **false** → **不 loadHistory**。✅ 方案 1 命中。
3. **store 不变**：`turns=[]`、`activeTurn=T1`。新实例只渲染 `<TurnView turn={activeTurn}/>` 一份（user + 旧闭包流式 assistant）。✅ **不翻倍**。
4. **旧闭包继续推进**：token 写进 `activeTurn`，流式正常可见（新实例订阅同一 store）。
5. **收尾**：旧闭包 `done` → `finalizeActiveTurn`(`useChat.js:64`)：`if (!chat.activeTurn) return`(有,放行) → `turns:[...chat.turns=[], {T1, sealed}], activeTurn:null`。→ `turns=[T1]`、`activeTurn=null`，单份。✅
6. **收尾后**：此时 `activeTurn=null`，但 `initDoneRef` 已是 true（`:186` 在首次 effect 末尾置位），初始化 effect 不会重跑 → 不会再补一次 loadHistory。`turns=[T1]` 即终态。✅（唯一的副作用：若该 chat 此前还有**更早的历史**、且 `historyLoaded` 一直是 false，则那段历史不会显示——但这是既有行为，非本 bug 引入，且翻倍场景下该 chat 本就只有这一轮在途。）

**结论：方案 1+2 在静态推演下消除翻倍，且不引入流式中断、收尾卡死或第二流。** 后端零改动。

### 边界与风险

- **`historyLoaded` 残留 false 的轻微代价**：方案 1 用 `activeTurn` 守门后，若某 chat 进入时 `activeTurn` 在途且 `historyLoaded` 从未被置 true，则它更早的历史在该轮结束前不会显示。判断：可接受——此类 chat 正是"中途切回的在途轮"，本就只有这一轮；流结束后若需补历史，可由 `done` 后的路径补充（当前代码 `idle` 是死分支不会自动补，属既有行为，不在本 bug 范围）。
- **`agent.streaming` 陈旧是独立隐患**：本方案用 `activeTurn` 绕开了它，但重连 effect(`:197`)、初始化 effect 的滚动/其它逻辑仍依赖 `agent.streaming`。页面刷新恢复（前端流真断、后端在流式）依赖 `agent.streaming` 为 true 才 subscribe——若此时它也陈旧 false，刷新后不会自动 subscribe 重连。**这是独立 bug，建议方案 3 单独修**（`selectAgent`/挂载时 `refreshAgents`），不混入本修复。
- **方案 2 的兜底**：防止滚顶 `loadMoreHistory` 之外将来若启用 `idle`、或其它新路径在 activeTurn 在途时调 `loadHistory` 再现翻倍。

## 改动清单

| 文件 | 改动 | 性质 |
|---|---|---|
| `frontend/src/components/ChatPanel.jsx` | `:171` 守门从 `!agent.streaming` 改为 `!activeTurn` | 核心 |
| `frontend/src/stores/agentStore.js` | `loadHistory` 入口加 `if (chat.activeTurn) return;` | 兜底 |
| `frontend/src/stores/agentStore.js`（可选） | `selectAgent` 切回 running agent 时 `refreshAgents()` 修 `agent.streaming` 陈旧 | 独立改进，非本 bug 必需 |

后端零改动。`useChat.js` 无改动。

## 影响范围

- **后端**：无影响。SSE 协议、`StreamContext`、jsonl 持久化、`subscribe` 快照语义全部不变。jsonl 数据源单份（本就不重复）。
- **前端状态**：不引入新字段；仅把一处守门的判据从（陈旧的）`agent.streaming` 换成（权威的）`activeTurn`，并在 `loadHistory` 加同向守卫。
- **行为变化**：切回在途轮时**不再 loadHistory**，避免把已落盘 user 读进 `turns` 与 `activeTurn` 同框 → 不再翻倍。流式由旧 `/chat` 闭包继续驱动，新实例读同一 store 可见，不停顿。
- **不触碰**：`chat.streaming` 死字段、`startPolling`、`subscribe` 路径、重连 effect 主逻辑。
- **`agent.streaming` 双字段澄清（已 grep 确认）**：`ChatPanel.jsx:140` 读前端 `chat.streaming`(死字段,取值未用)；`:169/:193/:202` 读后端 `agent.streaming`(`activeStreams>0`)。本方案不动这两个字段行为。

### 需回归验证的场景

1. ✅ 主路径：发消息→流式→完成，单轮单份（不变）。
2. ✅ Bug 场景：发消息→流式中→切别的 agent→切回，**内容单份**（修复目标）；且切回瞬间无 subscribe 请求、无推送（与用户观察一致）。
3. ✅ 页面刷新：流式中刷新→`subscribe` 恢复，内容单份（不能回归）。
4. ✅ 一直停留在 A 直到流结束：`turns=[T1]` 单份收尾（不能因守门改动而卡住 historyLoaded）。
5. ⚠️ 边界：进入一个有更早历史、且此刻无 activeTurn 的 chat → `loadHistory` 正常加载历史（守门 `!activeTurn` 放行），不能回归。
6. ⚠️ 边界：滚顶 `loadMoreHistory` 不受影响（向前翻页，独立路径）。

## 待确认的支点

本版根因（单流 + loadHistory 竞态）依赖一个尚需用代码进一步坐实的支点：**切回时 `historyLoaded === false`**。已 grep 确认写入点仅懒创建/loadHistory/clearHistory/snapshot 四处，且 `selectAgent` 不碰它；故切回时的值 = 上次交互结束的值。`historyLoaded===false` 的最自然触发路径（见根因第 8 段）：进入 A 时 A 已在流式 → 初始化 effect 因（当时新鲜的）`agent.streaming=true` 跳过 loadHistory → `historyLoaded` 留 false → 切走再切回（此时 `agent.streaming` 陈旧为 false）→ 命中翻倍。

仍需在代码中确认的：
1. 进入 A 时"`agent.streaming` 新鲜为 true"的具体入口——是页面刷新后重连场景，还是上一轮未结束就发新消息。这决定 `historyLoaded` 残留 false 是否真的是该 bug 的稳定前缀，还是另有写入路径未发现。
2. 方案 1 用 `activeTurn` 守门后，是否会遮蔽"切回一个**已结束但 historyLoaded 仍 false** 的 chat 时应加载历史"的正常需求——若 `turns` 已为空且无 activeTurn，守门放行 loadHistory，正常；需确认不存在"有 activeTurn 残留但流已结束"的脏态（`done`→finalize 会把 activeTurn 置 null，正常路径无残留；异常中断路径另议）。

这两点不影响"方案 1+2 消除翻倍"的有效性（有效性只依赖"`activeTurn` 在途时不 loadHistory"），只影响对**触发频率/完整复现路径**的描述精度。

## 可选后续（更彻底，非本方案必需）

本方案用 `activeTurn` 守门堵住 loadHistory 竞态，但**未解决 `agent.streaming` 陈旧**这个更底层隐患——它会让"页面刷新后前端流真断、后端仍在流式"的重连场景也可能失效（重连 effect `:197` 依赖 `agent.streaming=true` 才 subscribe）。独立改进：

- `selectAgent` / ChatPanel 挂载时 `await refreshAgents()` 拿新鲜 `agent.streaming`，使重连 effect 在该场景正确 subscribe。
- 或彻底放弃用 `agent.streaming`（后端快照）做前端流式判断，改为前端自维护的"是否持有活跃 SSE 接收者"标志（即前几版讨论的 `chat.streaming` 真实化，但需配 `send`/finalize 正确置位 + 旧 chat 流 abort，逻辑更重）。
- 两者均独立于本 bug，建议单独 PR。本 bug 仅需方案 1+2。
