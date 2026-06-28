# Elf 前端架构

## 技术栈

React 18 + Vite + Zustand 4 + CSS Modules

## 项目结构

```
frontend/
  index.html                  # 仅含 <div id="root">
  vite.config.js
  src/
    main.jsx                  # 入口：挂载 React 根组件
    App.jsx                   # 顶层布局：Sidebar + ChatPanel + ConfigDrawer
    App.module.css
    global.css                # 全局样式 + CSS 变量
    stores/
      agentStore.js           # Zustand 全局状态
    api/
      index.js                # 后端 HTTP 调用（fetch 集中层）
    hooks/
      useChat.js              # SSE 流式聊天核心
      useAgents.js            # Agent 列表加载
      useConfig.js            # 配置读取/保存/启停
    components/
      Sidebar.jsx             # 左侧 Agent 列表
      ChatPanel.jsx           # 单个 Agent 聊天面板
      MessageBubble.jsx       # 单条消息气泡
      TypingIndicator.jsx     # 打字动画
      CompactBadge.jsx        # 记忆压缩标记
      ToolCallBadge.jsx       # 工具调用标记
      ConfigDrawer.jsx        # 右侧配置抽屉
      ConfigField.jsx         # 配置字段渲染
      EmptyState.jsx          # 空聊天占位
      Avatar.jsx              # 头像
```

## 全局状态（Zustand Store）

一个 store 管理全部状态，避免 props 层层传递。

**agents** — Agent 列表数组（agentId, name, status, avatar, streaming 等）
**activeAgentId** — 当前选中的 Agent ID
**chats** — `Map<agentId, ChatState>`，每个聊天独立

ChatState 结构：

```ts
{
  turns: Turn[],              // 已完成的对话回合
  activeTurn: Turn | null,    // 当前流式中的回合
  hasMore: boolean,           // 是否有更多历史
  historyLoaded: boolean,     // 是否完成首次加载
  streaming: boolean,         // 是否正在流式接收
  draft: string,              // 输入框草稿
  _isActive: boolean,         // 当前是否被选中
  _savedScrollTop: number,    // 切换前保存的滚动位置
}
```

Turn 模型（纯前端结构，不在 history.jsonl 中）：

```ts
Turn {
  id: string
  userMessage: { id, content, ts }
  assistantBubbles: Bubble[]  // Agent 回复气泡组
}

Bubble {
  id: string
  content: string
  toolCalls?: { name, args, status, message? }[]
  sealed: boolean             // true=已结束，新事件会创建新 bubble
  compactLoading?: boolean
  compactSummary?: string
  compactError?: string
  ts?: string
}
```

**不在 store 中的状态**：subscribeControllerRef（useRef）、rAF id（useRef）、pendingContentRef（useRef）、pendingUpdateRef（useRef）。

## 组件树

```
App
├── Sidebar                  # 左侧列表
│   └── Avatar               # 每个 Agent 头像
└── ChatPanel                # 聊天面板（按 activeAgentId 渲染对应的 chat）
    ├── Toast                # 顶部通知
    ├── EmptyState           # 无消息占位
    ├── TurnView (React.memo) # 已完成/流式回合（isStreamingActiveTurn 区分）
    │   ├── userMessage      # 用户气泡
    │   └── assistantBubbles[]
    │       ├── ToolCallBadge
    │       ├── MarkdownContent
    │       └── CompactBadge
    └── InputArea
        ├── textarea         # 非受控组件
        ├── sendBtn / stopBtn
        └── TypingIndicator
```

## SSE 流式数据流

```
用户发送 → send()
  → 创建 activeTurn（含 userMessage，assistantBubbles=[]）
  → api.chat() → POST /agents/:id/chat → Gateway → Agent
  → SSE 事件流返回

SSE 事件处理（_handleSSEEvent）:
  token        → rAF batching 累积到 pendingContentRef，每帧 flush 一次
  tool_call    → 追加 toolCall 到当前 bubble
  tool_result  → 更新 toolCall 状态，seal 当前 bubble
  compact_start → seal 前一个 bubble，新建 compactLoading bubble
  compact      → 更新为 compactSummary
  compact_error→ 更新为 compactError
  done         → finalizeActiveTurn（seal 所有 bubble，移入 turns）
  aborted      → finalizeActiveTurn + toast
  error        → finalizeActiveTurn + toast
  snapshot     → 替换 turns + activeTurn（页面刷新后重连用）
  idle         → 加载最终历史

rAF batching 细节：
  - token 内容累积到 pendingContentRef
  - 每帧 flushRaf 创建新对象引用 push 到 store
  - 渲染频率锁定 60fps
```

## 发送与排队

- 前端同步发送，不做前端 pending。Agent 回复中 → 后端返回 422，前端 toast 提示"Agent 正在回复中"。
- Gateway 用 `activeStreams` Map 追踪每个 agent 的活跃 SSE 连接数，>0 时拒绝新请求。
- Agent 层的 `enqueueRequest` 作为安全兜底保留。

## 页面刷新重连

`ChatPanel` useEffect 检测 `agent.streaming === true` 时调用 `startPolling()`：

1. 发起 GET /agents/:id/subscribe
2. 服务端返回 `event: snapshot`（含 turns + activeTurn + streaming 状态）
3. 后续实时 event 流正常接收
4. subscribe 关闭后设 `streaming: false`

## 历史加载

- 首次：`loadHistory(agentId)` → GET /agents/:id/history?limit=30
- 加载更多：滚动到顶部触发 `loadMoreHistory`，带 `before` 参数
- 增量：刷新后 subscribe 的 snapshot 直接替换本地状态

## 配置面板

- 去掉 iframe，改为 JSON 描述驱动渲染
- GET /agents/:id/config-ui 返回 `{ layout, config }`
- layout 来自 config-ui.json（或 null=默认布局）
- ConfigDrawer 根据 layout 渲染选项卡 + ConfigField 组件
- 保存时从 React state 收集表单数据 → PUT /agents/:id/config

## 已解决的问题

| 问题 | 修复 |
|------|------|
| 流式回复 rAF batching 中 mutate 对象引用导致 UI 不更新 | 所有 SSE handler 改为创建新对象引用，flushRaf 中 map 新 bubbles |
| 刷新后 SSE 流断线 | subscribe + snapshot 机制 |
| 前端不能同时发送多条消息 | 同步发送 + 后端 422 拒绝 |