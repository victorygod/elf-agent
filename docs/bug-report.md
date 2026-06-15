# 前端 Bug 报告

> 生成日期：2026-06-16
> 范围：`frontend/` 目录全部 9 个文件 + 后端 avatar 路由验证

---

## ~~Bug 1（严重）：`done` 事件导致 `_finishStreaming` 二次调用，摧毁嵌套流~~ ✅ 已修复

**文件：** `frontend/agent-chat.js:367,386,423-424`

**修复方案：** 把 `pendingMessages` 的处理从 `_finishStreaming()` 移到 `_doSend()` 的 try-catch 之后，使用 `await` 保证串行。`_finishStreaming` 只负责清理当前流的 UI 状态，不再触发新的流。

**变更：**
- `_finishStreaming()`：删除第 364-368 行（pending 消息处理）
- `_doSend()`：在第 399 行后（try-catch 之后）加上 `await this._doSend(merged)` 逻辑

**修复后的时序：**
```
_doSend(A) → SSE done → _finishStreaming() 只清理 → await _doSend(B) ← 全新调用栈
```

---

## ~~Bug 2（中高）：`_showCompactStart` 向 history 插入 `compact` 记录，污染流式追加~~ ✅ 已修复

**修正认识：** compact（压缩）是 Agent 内部记忆行为，与聊天内容无关。不应写入 `this.history`。

**修复方案：**
- `_showCompactStart()`：不再操作 `this.history`，只插入 DOM 提示
- `_updateCompactSuccess/Error()`：去掉 history 写入，只更新 DOM
- compact badge 改为小字提示，不再占用大块空间
- 清理 `renderCompactBadge`、`preprocessMessages` 等死代码

---

## ~~Bug 3（中高）：配置保存后 "配置已保存" 消息从未展示~~ ✅ 已修复

**文件：** `frontend/config-panel.js:86-87`

**修复方案：** 在调用 `close()` 之前先用局部变量 `savedAgentId` 保存 `this.currentAgentId`，`emit` 时用这个变量，避免 `close()` 将 `currentAgentId` 置 null 后事件携带 null。

**变更：**
```js
const savedAgentId = this.currentAgentId;
this.close();
this.emit('saved', savedAgentId);
```

---

## Bug 4（中）：History 轮询结束时 compact 错误标记被渲染抹除

**文件：** `frontend/agent-chat.js:361-362,476,481`

**状态：** Bug 2 修复后连带解决（compact 不再写 history，轮询路径下 #compactBadge 不存在）。

---

## Bug 5（低）：移动端横竖屏切换布局错乱

**文件：** `frontend/app.js:233-237`

**结论：不是 bug，无需修复。**

横屏切回竖屏后，回到的是 agent 列表视图（sidebar 可见），点一下 agent 即可回到聊天。
`selectAgent` 和 `goBackToList` 各自入口已正确处理 class。

---

## Bug 6（低）：无消息时自动启动 Agent 后，状态未刷新

**结论：不是 bug。** 异步启动是合理设计，不阻塞 UI。启动完成会自动刷新状态。

---

## Bug 7（低）：History 轮询期间排队的消息被丢弃 ✅ 已修复

**触发条件：** 页面刷新后 AI 仍在回复，用户在此期间发了一条消息。

**根因：** `_finishStreaming()` 移到 `_doSend()` 尾部后，`startHistoryPolling()` 路径中 `_finishStreaming()` 不处理 `pendingMessages`。

**修复方案：** 在轮询结束、拉取最终历史之后，加上处理 `pendingMessages` 的逻辑。

---

## 最终状态

| 优先级 | Bug | 状态 |
|--------|-----|------|
| P0 | Bug 1 — 流式嵌套崩溃 | ✅ 已修复 |
| P1 | Bug 2 — compact 污染 history | ✅ 已修复 |
| P1 | Bug 3 — 配置保存无反馈 | ✅ 已修复 |
| P2 | Bug 4 — compact 错误被抹除 | ✅ Bug 2 连带解决 |
| P2 | Bug 5 — 移动端横竖屏切换 | ❌ 非 bug，不修 |
| P3 | Bug 6 — 自动启动无同步反馈 | ❌ 非 bug，不修 |
| 新 | Bug 7 — 轮询期间排队消息丢弃 | ✅ 已修复 |