# Elf 前端架构文档

## 架构概览

前端采用 ES Module 模块化架构，每个 Agent 拥有独立的 `AgentChat` 实例（DOM 子树 + 状态），切换 Agent 时仅做 CSS `display` 切换，不销毁重建 DOM。

```
frontend/
  index.html          — 壳 HTML（侧边栏 + 容器 + 全局模板）
  style.css           — 样式（含 .agent-chat / .agent-hidden 等隔离规则）
  app.js              — App 类：初始化 + Agent 选择协调
  utils.js            — 纯函数：formatTime, escapeHtml, renderAvatar, EventBus 等
  api.js              — 所有后端 fetch 调用集中层
  sidebar.js          — Sidebar 类：Agent 列表渲染 + 事件
  agent-chat.js       — AgentChat 类：per-agent 聊天、流式、输入、历史
  config-panel.js     — ConfigPanel 类：配置面板（iframe + 保存）
```

## 核心设计决策

### 1. Per-Agent 聊天隔离

每个 `AgentChat` 实例拥有独立的 DOM（`.agent-chat`）和状态（`history`, `streaming`, `abortController`, `draft`, `pollingTimer`）。

- **切换方式**：`show()` 移除 `.agent-hidden` 类，`hide()` 添加 `.agent-hidden` 类（`display: none`）
- **DOM 保留**：切换时不销毁 DOM，滚动位置和输入草稿自动保存/恢复
- **流式隔离**：Agent A 的 SSE 回调只写 Agent A 的 DOM，即使页面显示 Agent B。不需要 `streamingAgentId` 守卫
- **草稿保留**：每个 AgentChat 实例持有 `this.draft`，`hide()` 保存 `inputEl.value`，`show()` 恢复

### 2. pendingMessages — 中断后继续发送（设计决策）

**行为**：当用户在 Agent 回复期间连续发送多条消息，后续消息进入 `pendingMessages` 队列。当前回复完成后（`done` 事件），队列中的消息会自动合并发送。

**关键设计**：**中断（abort）也会触发 `_finishStreaming()`，待发消息同样会被发送。** 这是预期行为，不是 bug。

**理由**：
- 用户点击"停止"是想停止当前的回复，不一定想取消已排队的消息
- pendingMessages 机制本质上是一个消息队列，队列中的消息属于用户已确认的输入
- 如果需要"停止当前 + 清空队列"，应该提供单独的"清空待发"操作，而不是改变 abort 的语义

### 3. 历史加载策略

- **首次加载**：`selectAgent()` 中 `if (!chat._historyLoaded) await chat.loadHistory()`
- **切换回来**：`chat.restoreScroll()` 恢复滚动位置，不重新拉取
- **配置保存后**：`_onConfigSaved()` 中 `await chat.loadHistory()` 再 `addSystemMessage()`（顺序关键，反过来系统消息会被 renderHistory 清空）
- **流式重连**：页面刷新后如果 `agent.streaming === true`，启动 `startHistoryPolling()` 轮询

### 4. SSE 生命周期

```
AgentChat._doSend(message)
  → new AbortController()
  → api.chat(agentId, message, { onEvent, signal })
  → SSE 事件回调只操作 this.* （per-instance 隔离）

AgentChat.abortRequest()
  → POST /agents/:id/abort（通知服务端停止生成）
  → 服务端发送 'aborted' 事件 → _finishStreaming()
  → 注意：不调用 abortController.abort()，让服务端优雅关闭 SSE 流

AgentChat.destroy()
  → abortController?.abort()（强制关闭 SSE 连接）
  → stopHistoryPolling()
  → el.remove()
```

**切换 Agent 时不调用 abort**：后台 SSE 流继续接收，数据写入 `this.history`，DOM 更新在 hidden 元素上（不可见但保留）。切换回来时 `restoreScroll()` 恢复位置。如果切换回来时仍在流式，`startHistoryPolling()` 恢复轮询显示。

### 5. 页面刷新后流式重连

用户刷新页面时所有 AgentChat 实例销毁，但 Agent 进程仍在运行。`selectAgent()` 检测 `agent.streaming === true` 时启动 `startHistoryPolling()`：
- 每 1.5s 拉取历史和 Agent 状态
- 如果消息数量变化，重新渲染
- 如果 Agent 不再 streaming，做最终一次历史拉取后停止轮询

### 6. Compact（上下文压缩）流式展示

SSE 事件序列：`compact_start` → `compact`（成功）/ `compact_error`（失败）

前端处理：
- `compact_start`：在最后一条 assistant 消息下方插入"⏳ 正在压缩上下文..."标记
- `compact`：更新为"✅ 上下文已自动压缩" + 摘要
- `compact_error`：更新为"❌ 上下文压缩失败" + 错误信息
- 历史记录中 compact/compact_error 消息通过 `preprocessMessages` 关联到前一条 assistant 消息，渲染在气泡内部

### 7. 配置面板

配置面板使用 iframe 加载 `/agents/:id/config-ui`，通过 `window.parent.refreshAgents()` 与主页面通信。保存时：
1. `ConfigPanel.save()` → `collectConfig()` 从 iframe DOM 收集字段
2. `PUT /agents/:id/config` 写入配置
3. `emit('saved')` → `App._onConfigSaved()` → 刷新 agent 列表 + 重载历史 + 添加系统消息

### 8. 移动端适配

- `isMobileView()` 检测 `window.innerWidth <= 768`
- 切换 Agent 时隐藏侧边栏、显示主聊天区
- 输入框 `padding-bottom` 加 `env(safe-area-inset-bottom)` 适配刘海屏
- 返回按钮通过 `window.goBackToList()` 全局函数桥接

## Bug 修复记录

| Bug | 描述 | 修复 |
|-----|------|------|
| 配置保存消息被清空 | `_onConfigSaved` 中 `addSystemMessage` 在 `loadHistory` 前调用，被 `renderHistory` 覆盖 | 调换顺序：先 `loadHistory` 再 `addSystemMessage` |
| loadHistory 双重调用 | `show()` 中 fire-and-forget `loadHistory()` + `selectAgent()` 中 `await chat.loadHistory()` | `show()` 不再触发 `loadHistory`，由 `selectAgent()` 统一控制 |
| agents 引用过期 | `AgentChat` 构造时接收 `agents` 数组引用，`_refreshAgents()` 替换整个数组后引用失效 | 改为 `() => this.agents` getter 回调 |
| refreshAgents 名称不匹配 | iframe 调用 `window.parent.refreshAgents()` 但 app.js 注册的是 `window.refreshAgentList` | 添加 `window.refreshAgents` 别名 |
| 滚动位置恢复竞态 | `_restoreScroll()` 可能在 `loadHistory` 完成前覆盖滚动到底部 | `restoreScroll()` 只在 `_historyLoaded === true` 时恢复 |
| addSystemMessage 竞态 | `selectAgent()` 中 `addSystemMessage` 在 `loadHistory` 完成前被调用 | 统一历史加载流程，确保 `loadHistory` 完成后再添加系统消息 |