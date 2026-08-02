# 方案：LLM 请求失败重试 — 居中提示气泡（私聊 + 群聊）

> 对应 `docs/temp-analysis-conclusions.md` 第 7 条。设计文档，尚未实现。

## 0. 背景与诉求

temp 第 7 条：LLM 请求失败重试在后端是静默的（`engine/models/llm.js` 的 `withRetry` 重试 3 次，不发任何事件），前端看不到「正在重试」。用户诉求：

1. **私聊 + 群聊都要**冒泡重试提示。
2. agent 的 LLM 请求失败、后端重试时，前端**居中瞬态气泡**显示 `agent名(id) LLM 请求失败，重试第 N 次`（3 次失败后显示最终失败 + 错误）。
3. 现有瞬态气泡太短（私聊 `ChatPanel.jsx` 的 `Toast` 700ms+300ms≈1s），要更长（3s 显示 + 0.4s 淡出）。

**现状核实**：私聊只有最终失败弹一次（`sseDispatcher.js:322` `error`→`showToast('错误:…')`），中间重试全程不显示；群聊连最终 `error` 都被 `_onAgentEvent` 丢掉。`CompactBadge` 是**记忆压缩**的持久徽章，别类，不并入。

## 1. 封装策略（前后端各自收敛）

- **后端**：封装 `sendNotice(ctx, { kind, agentId, attempt?, error?, maxRetries? })`，内部按 `runContext.mode` 分流（私聊 `emit`、群聊 `fetch(roomBusUrl)`）。收敛「参数拼装 + 分流 if」，每个发起点不各写一遍。**只管发结构化字段，不管编文案**（文字在前端拼）。
- **前端**：抽共享 `Toast` 组件 + `useToast` hook（计时/淡出只写一次）+ store action `showToast(scope, fields)`，私聊群聊共用。收到字段后拼文字。`CompactBadge` 那类持久徽章不并入。
- **事件名**：统一 `notice`，`kind` 区分 `retry`/`error`/`info`，私聊群聊同字段集。

## 2. 两条既有通道（不新开主通道）

- **私聊**：`reasoning` 的 `emit`（`engine/agent.js:321`）经 `engine/server.js:190` 盖 `_roomId='chat-'` → `_onAgentEvent`（`process_manager.js:392`）命中 `chat-` → `handlePrivateAgentEvent`（`private_room_stream.js:93`）逐字转发到私聊 SSE。→ 后端零新增通道。
- **群聊**：`emit` 的 `_roomId='room_xxx'` 在 `_onAgentEvent:396` 被丢，群聊走 agent 直推 `roomBusUrl`（`Speak` 工具 `engine/tools/Speak.js:64` 同款）→ 新加 1 个路由。

## 3. 改动清单（4 端 + 1 工具函数）

**1. `engine/models/llm.js`** — `withRetry(fn, onRetry)` 加可选钩子：可重试失败、`backoff` 前调 `onRetry?.({ attempt: attempt+1, maxRetries, error })`。`chatStream`(`:143`)、`chat`(`:271`) 透传 `options.onRetry`。只钩出现有重试点，不加重试逻辑。

**2. 新增 `engine/notice.js`**（后端封装核心）— 导出 `sendNotice(ctx, fields)`：
- `fields = { kind: 'retry'|'error'|'info', agentId, memberName?, attempt?, error?, maxRetries? }`。
- 内部：`runContext.mode==='room'` → `fetch(POST ${rc.roomBusUrl}/notice, { 'X-Speaker-Id': memberName, body })`；否则（私聊/单 agent）→ `ctx.emit({ event: 'notice', data: fields })`。`catch{}` 吞失败，不影响主流程。

**3. `engine/agent.js`** — reasoning 调 `chatStream` 处(`:318`)接 `onRetry` → `sendNotice(this, { kind:'retry', agentId:this.id, memberName:this.runContext?.memberName, attempt, maxRetries, error })`；最终失败处（现有外层 catch `emitError`，`:169-174` 附近）→ `sendNotice(this, { kind:'error', agentId, attempt:maxRetries, error, maxRetries })`。

**4. `gateway/room_routes.js`** — 新增 `POST /rooms/:rid/notice`：读 body，调 `roomManager.getBroadcaster(rid).broadcast('notice', body)`（`bc.broadcast` SSE-only，`room_bus.js:101`）。群聊最终失败的同一条 `notice` 经此路下发。

**5. 前端封装 + 接线**：
- 新增 `/components/Toast.jsx`（共享）+ `/hooks/useToast.js`：`useToast(scope)` 读 store 的 `toastFields`+`toastKey`，**3s 显示 + 0.4s 淡出**，文案在组件里按 `fields` 拼。私聊/群聊挂载各自容器（私聊 `ChatPanel` 已有 `<Toast/>` 替换之，群聊 `RoomChatPanel` 新挂）。
- `agentStore` / `roomStore` 各暴露 `showToast(fields)`（写字段 + key 自增），统一签名。
- `frontend/src/stores/sseDispatcher.js` `case 'error'`(`:322`) 改为调 `showToast({kind:'error', error:data.message})`（带 agent 复用），删旧字符串 `showToast('错误:…')`；加 `case 'notice'`。
- `frontend/src/hooks/useRoomChat.js` 监听 `notice` → `roomStore.showToast(data)`。

## 4. 气泡规格

- **字段集**（后端 `notice` 载荷，前端按之拼文案）：
  - `{ kind:'retry', agentId, memberName, attempt, maxRetries, error }` → `重试中`
  - `{ kind:'error', agentId, memberName, maxRetries, error }` → `重试耗尽`
- **文案**：重试中 `{name}(id) LLM 请求失败，重试第 {attempt} 次`；耗尽 `{name}(id) LLM 请求失败，已重试 {maxRetries} 次仍失败：{error}`。名字群聊后端带 `memberName`，私聊前端用本地 agent 名兜底。
- **时长**：3s 显示 + 0.4s 淡出，私聊群聊统一（替代现 700+300ms）。
- **样式**：复用 `.toast`，警示色微调（`rgba(255,236,200,.95)` / `#8a5a00`）。
- 多次重试 key 自增重置计时并刷新文案。

## 5. 明确不动

`_onAgentEvent` 分流逻辑、`process_manager.js`、`private_room_stream.js`（逐字转发已够）、`/events` 通道、`agentStore` 现有 action 签名只新增不破坏。`CompactBadge` 独立不动。

## 6. 验证（实现后）

- **单测**：`withRetry` mock fetch 前 2 次 5xx → `onRetry` 调 2 次（attempt=2/3）；`sendNotice` 私聊分支调 `emit`、群聊分支 `fetch(roomBusUrl)` 各一次；新路由 → `broadcast('notice',…)` 断言；`showToast` 字段与 key 自增。全量串行 `node --test --test-concurrency=1 test/*.test.js`。
- **前端**：`npm run build`（vite）通过。
- **端到端**：临时把 agent 的 `base_url` 指 5xx 端点，发消息：私聊群聊均见居中「…LLM 请求失败，重试第 2 次…第 3 次…已重试 3 次仍失败：…」，停留 ~3s 淡出；恢复 base_url 后无气泡。

## 7. 取舍

- **后端封装 `sendNotice`**：收敛分流+参数拼装，调用点变薄；只发字段不编文案。
- **事件名统一 `notice`**（取代 `llm_retry`/`error` 两事件）：前端一套字段渲染，少一个事件类型。
- **固定时长 3s**：重试通常数秒内完成，3s 够看到 2~3 次 + 最终失败。
- **`attempt` 语义**：「即将重试的序号」，对齐「重试第 N 次」（N≥2）。