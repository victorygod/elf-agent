# 设计：前端 subscribe 常驻（选项 1b）

> 日期：2026-07-21
> 目标：解决"前端 ↔ gateway 的 `/agents/:id/subscribe` SSE 随 agent tab 切换断裂，断裂窗口内的异步事件（async compact 完成等）被 gateway 丢弃，导致切回 tab 才从 loadHistory 看到更新"的问题。
> 范围决策：
> - **流式对话连接不变**：每 agent 一条 `/agents/:id/subscribe` 仍保留（流式 token/snapshot 等机制 OK，不动）。
> - **仅改 lifecycle**：subscribe 从"ChatPanel active 时建、卸载时断"提升到"agent running 时常驻、app 级持有、切 tab 不断"。
> - **buffer/ack 后置**：本轮不加服务端 buffer；切 tab 不断即解决主诉（subs 在场不丢 async 事件）。网络瞬断导致重连窗口丢事件，留待后续 buffer 方案。
> - **snapshot 机制不动**：snapshot 是"重连全量对齐"的干净机制，今天日志里的覆盖/loading 重建根因是 eventLog 未回写、compact_start 重复等独立 bug，不在本轮。
> 关联：`compact-bubble-update-bugs-2026-07-21.md`（诊断清单）。

---

## 0. 现状拓扑（核对过代码）

**事件产生端（agent 进程内）**两类出线：
- reasoning `yield` → `/chat` HTTP 响应流内的流式事件：`status`/`token`/`tool_call`/`tool_result`/`compact_start`/流内 `compact` 等。
- mm `_eventSink` → `/events` SSE（独立于 /chat 生命周期）：仅 async 后台压缩完成的 `compact`/`compact_error`。

**gateway 中转**：到每个 agent 两条上游连接——
- `/chat` 代理流（发消息时建、流结束 streamEnded）
- `/events` 长连（agent 启动后常驻、自动重连）

转发到前端：`proxyChat`/`ctx.broadcastChunk` 把 /chat 流内事件写给 `ctx.subscribers`；`_onAgentEvent`(process_manager) 把 /events 的 async 事件写给 `subscribedClients.get(agentId)`（模块级）。两类下游汇入**前端那条 `/agents/:id/subscribe`** 连接——它在 `subscribeToStream` 时既注册到 `ctx.subscribers`（活跃流时）又注册到 `subscribedClients`（恒注册）。

**前端消费**：`useChat`（绑在 `ChatPanel` 上）在 ChatPanel active 时 `startPolling()` 建 `/agents/:id/subscribe` fetch-SSE，`_handleSSEEvent` 处理所有事件名（snapshot/token/tool_call/.../compact/...）。ChatPanel 切 tab 卸载 → `useChat` cleanup → `subscribeControllerRef.abort()` 断连接 → gateway `subscribedClients` 删该 res。

**丢事件链**：切 tab → subscribe 断 → 这期间 async compact 完成 → `_onAgentEvent` subs=0 → 丢（仅落磁盘 `updateCompactRecord`）。切回 → loadHistory 从磁盘读（磁盘是 summary）→ 看到更新。这正是主诉。

---

## 1. 目标拓扑

**唯一变化**：`/agents/:id/subscribe` 的生命周期从"ChatPanel 挂载级"提升到"agent running 级"，app 级常驻、切 tab/切 agent 不断。

其余不变：仍每 agent 一条 subscribe、gateway `subscribedClients` 仍 per-agent、流式对话通路、snapshot 全量重建、agent /events、agent /chat 代理——**全部不动**。

---

## 2. 实现方案 III（选定）

抽 app 级"subscribe 常驻"hook，ChatPanel 瘦身留 UI/交互。

### 2.1 抽出事件分发器（store 级，纯）

`_handleSSEEvent` 本质是**纯 store 操作**（`patchChat`/`getChat` = `useAgentStore` 的 setState/getState 按 agentId）+ token 用 `requestAnimationFrame` 做 batching。唯一非 store 的是 token 的 raf batching（性能合并，非 UI 副作用）。

把 `_handleSSEEvent` 提到 `frontend/src/stores/agentStore.js`（或新建 `frontend/src/stores/sseDispatcher.js`），签名改为 `handleSSEEvent(agentId, event, data)`。raf batching 用模块级 `Map<agentId, {rafId, pendingContent}>` 替代 useChat 的 ref（等价、agent 级隔离）。

> 作用：让事件处理不依赖任何 React 组件实例。subscribe 常驻在哪都调它写 store。

### 2.2 新建 app 级常驻订阅 hook

`frontend/src/hooks/useAgentSubscriptions.js`（app 级，在 `App.jsx` 调一次）：
- 订阅 `useAgentStore` 的 agents 列表 + 状态。
- 维护模块级 `Map<agentId, AbortController>`：agent status 变 `running` 且无连接 → 建 subscribe（`api.subscribe(agentId, { onEvent: (e,d)=>handleSSEEvent(agentId,e,d), signal })`）；agent status 变非 running → abort + 删。
- 重连：复用 useChat 现有 catch→2s 重试逻辑（fetch-SSE 无自动重连，需自建）。
- 切 tab / 切 agent / ChatPanel 卸载：**不触发**任何 subscribe 断连。

### 2.3 ChatPanel / useChat 瘦身

- `useChat` 删掉 `startPolling`/`cleanup`/`subscribeControllerRef`/`_handleSSEEvent`（这些进 2.1/2.2）。
- `useChat` 保留 `send`/`abort`/`rewind`/`listCheckpoints`：这些是动作（POST `/chat` 发消息、POST `/abort` 等），每次请求新建独立 /chat 流，本就独立于 subscribe，留 ChatPanel 或提 app 级均可。倾向留 ChatPanel（它们绑在 ChatPanel 的输入/按钮交互最自然）。
- ChatPanel 删掉那个 `useEffect([isActive, agentId], startPolling)` 块；从 `useAgentSubscriptions` 已经在后台收事件写 store，ChatPanel 只负责渲染 `agentStore` 里的 turns/activeTurn + 交互。

### 2.4 切 tab 恢复模型（确认点）

切 tab：ChatPanel 卸载（UI 不渲染），`agentStore` 里该 agent 的 activeTurn/turns 仍由常驻 subscribe 实时更新。切回：ChatPanel `key={agentId}` 重新挂载，从 `agentStore` 读当前状态（被常驻 subscribe 维护着）继续渲染——**无需 loadHistory 重建**（因为没断、store 是最新的）。

> 注意：现 ChatPanel init effect 有"切回时 `historyLoaded:false` 触发 loadHistory"的逻辑（agentStore.js:116-121 那段，为修切片 tab 丢事件而加）。subscribe 常驻后，切回不需要 loadHistory（store 已最新）。那段切回 loadHistory 逻辑可**移除或降级为"首次 historyLoaded 时才 load"**，避免常驻 subscribe 写着 store、loadHistory 又用磁盘快照覆盖一次造成抖动。这是 2.4 要小心处理的耦合点。

---

## 3. 落点清单

| 文件 | 改动 |
|---|---|
| `frontend/src/stores/agentStore.js`（或新建 sseDispatcher） | 接收 `_handleSSEEvent(agentId, event, data)`，token raf batching 改模块级 Map |
| `frontend/src/hooks/useAgentSubscriptions.js` | 新建：app 级按 agent running 状态建/断 subscribe，重连逻辑 |
| `frontend/src/App.jsx` | 顶层调 `useAgentSubscriptions()` 一次 |
| `frontend/src/hooks/useChat.js` | 删 subscribe/_handleSSEEvent/startPolling/cleanup；留 send/abort/rewind/listCheckpoints |
| `frontend/src/components/ChatPanel.jsx` | 删 startPolling/cleanup 的 useEffect；切回不再强制 loadHistory（调整 init effect） |
| `frontend/src/stores/agentStore.js` | `selectAgent` 切回时的 `historyLoaded:false` 重置逻辑配合 2.4 调整 |
| gateway / agent 端 | **零改动** |

---

## 4. 风险与前提

1. **后台 tab 节流**：浏览器对后台 tab 的 fetch 流可能节流（事件仍推但处理变慢/堆积 buffer）。非丢、是延迟，可接受。需确认不会因节流导致 gateway 误判断连（不会，fetch 流断才有 close 事件）。
2. **fetch-SSE 无自动重连**：EventSource 有自动重连、fetch 没有。`useAgentSubscriptions` 必须自己实现重连（catch → 延迟重建），且重连窗口仍会丢 async 事件（buffer 后置的已知接受范围）。
3. **多 agent 并发连接数**：常驻后每个 running agent 一条 subscribe 常连。单用户本地场景可接受；确认部署非多用户共享 gateway（多用户要 per-user 隔离，本轮不涉及）。
4. **切回 loadHistory 与常驻写 store 抖动**（2.4）：最易引新 bug 的点。落地时 ChatPanel init 要区分"首次未 historyLoaded → load 一次"和"只是切回（subscribe 一直在线）→ 不 load"。
5. **agent 重启**：agent 重启时 gateway 端 ctx/streamContext 重建、snapshot 会重发。常驻 subscribe 仍在场，收 snapshot 重建 turns。这跟现状刷新行为一致，应能复用。需实测确认 agent 重启路径下常驻 subscribe 不漏。

---

## 5. 不做（明确划界）

- 不加服务端 buffer / ack / 增量补发（buffer 后置，留选项 3）。
- 不动 snapshot / buildSnapshot / buildBubblesFromContext 机制。
- 不动 gateway `subscribedClients`/`_onAgentEvent`/`proxyChat`（仍 per-agent，零改）。
- 不动 agent 端 `/chat` `/events` 出线。
- 不动流式对话通路（token/tool_call 等仍走 subscribe，机制不变，只 lifecycle 不随 tab）。
- 不并入群聊 `/rooms/:rid/subscribe`（另一套，本轮不涉及）。

---

## 6. 验证

- 主诉复现：elf-003 压缩触发后切 tab、再切回——气泡已实时更新（常驻 subscribe 在场收到 compact 事件，无需切回 loadHistory）。
- 保留旧行为：发消息流式 token、tool_call 渲染、snapshot 恢复（刷新页面）、rewind 等均不回归。
- agent 停止：subscribe 清理、无泄漏。
- 净增：常驻 subscribe 条数 = running agent 数，关注 2/3 风险点。

---

## 7. 与已诊断 bug 清单的关系

`compact-bubble-update-bugs-2026-07-21.md` 里的 4 条：
- Bug 1（`_onAgentEvent` 未回写 eventLog）：本轮**不修**（独立后端 bug，已单独修过一轮 diag+待复测）。
- Bug 2/3（compactId 找不到/重复气泡）：本轮不修；但 subscribe 常驻后**切 tab 不再丢 compact 事件**，可减少触发面。
- 本设计 1b 只解决"切 tab 断连丢 async 事件"。Bug 清单里的根因（重复 compact_start / eventLog 未回写）要各自独立修，不在本设计范畴。

---

## 8. 落地结果（2026-07-21 已完成）

按方案 III 落地，前端 build 过、后端 421 测试零回归（gateway/agent 端零改）。

**新增**
- `frontend/src/stores/sseDispatcher.js`：`handleSSEEvent(agentId, event, data)` + `finalizeActiveTurn(agentId)`，纯 store 操作；token rAF batching 用模块级 `Map<agentId,{rafId,pendingContent,pendingUpdate}>` 替代原 useChat 的 ref（agent 级隔离）。来源：原 useChat 顶部三个纯函数（`_findBubbleByCompactId`/`_applyCompactResult`/`_formatCompactError`）+ `_handleSSEEvent`。
- `frontend/src/hooks/useAgentSubscriptions.js`：app 级常驻订阅。按 agent `status===running` 在 `_subs` Map 建立/断开 subscribe，fetch-SSE 失败/断开 `RECONNECT_DELAY=2s` 自动重连。切 tab / ChatPanel 卸载不断。模块级 `_subs` 跨 hook 重渲染常驻。

**改动**
- `frontend/src/hooks/useChat.js`：593 行 → ~108 行。删 `_handleSSEEvent`/`flushRaf`/`finalizeActiveTurn`/`startPolling`/`cleanup`/`patchChat`/`getChat` 及 raf refs（迁 sseDispatcher）。留 `send`/`abort`/`rewind`/`listCheckpoints`。`send` 的 onEvent 改调 `handleSSEEvent(agentId,event,data)`。
- `frontend/src/App.jsx`：顶层调 `useAgentSubscriptions()` 一次。
- `frontend/src/components/ChatPanel.jsx`：删 startPolling/cleanup 的 useEffect + `subStartedRef`；`useChat` 解构少 `startPolling`/`cleanup`。
- `frontend/src/stores/agentStore.js selectAgent`：切回**不再强制 `historyLoaded:false`**——常驻 subscribe 在场持续更新 store，切回无需 loadHistory 重建（消除磁盘快照覆盖实时 store 的抖动）。首次未 load 的仍由 ChatPanel init effect 触发一次。

**gateway / agent 端零改**，snapshot 机制零改。

## 9. 已知残余 + 修复（落地中暴露，非 1b 设计意图）

1. **rewind 不加载（1b 引入的回归，已修）**：原 rewind 靠 `startPolling()` 重连 subscribe → 服务端新建连接推 snapshot。删 startPolling 后常驻 subscribe 不重建、snapshot 不来。修：rewind 成功后 `finalizeActiveTurn(agentId)` 清在途 + `loadHistory(agentId)` 从回退后磁盘权威源重建 store。
2. **rewind 回退到错步（既有 bug，与本设计无关，已修）**：`RewindMenu` 点击项时 `onSelect(i); onConfirm()` 用了尚未生效的旧 `selectedIndex` state 取 id。修：点击时 `onConfirm(i)` 直接传被点 index，不经 selectedIndex 中转；ChatPanel onConfirm 接 index 取 id。Enter（↑↓选完再 Enter）路径本就经 `selectedRef.current`（setState 后已渲染同步）无此问题，未动。
3. **残留小风险（未修，低）**：删 useChat 时 `send` 开头的 `flushRaf()`、`abort` 里的 `flushRaf()` 也一并删了——理论上可能丢失极少量残余 batched token。受 `handleSSEEvent` 的 rAF flush 兜底（下个 token 触发 flush / finalize 时 flush），实践中风险极低。若复现 token 少字可回退这两处 flushRaf。

## 10. 验证

- 主诉（已确认修复）：elf-003 后台压缩触发后切 tab、再切回——气泡已实时更新，无需等 loadHistory（常驻 subscribe 在场收到 compact 事件）。
- rewind（已确认修复）：回退历史正确加载、点击回退到所选那一步。
- 后端 421 测试全绿（gateway/agent 零改）。
- 待清：`sseDispatcher.js`/`gateway/chat_proxy.js buildSnapshot`/`gateway/process_manager.js _onAgentEvent` 里的 `[DIAG]` 临时插桩，验证 Bug 1 修复后统一移除。