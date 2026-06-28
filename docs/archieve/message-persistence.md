# 消息持久化设计文档

---

## 1. 背景

当前 MessageManager 只在内存中维护对话历史，Agent 重启后上下文丢失。前端同样没有加载历史消息的能力。

本次改造将消息拆分为两类，分别持久化：

| | Context（上下文） | History（聊天记录） |
|---|---|---|
| **用途** | 给 LLM 提供上下文窗口 | 给前端展示聊天记录 |
| **包含角色** | system / user / assistant / tool 全角色 | 仅 user / assistant |
| **压缩** | 超过 token 阈值时压缩为摘要 | 永远不压缩，只追加 |
| **timestamp** | 不需要 | 需要 |
| **tool_calls** | 需要 | 不记录 |
| **存储格式** | JSON 文件（全量读写，与内存状态一致） | JSONL 文件（追加写入） |
| **存储路径** | `agents/{agentId}/data/context.json` | `agents/{agentId}/data/history.jsonl` |

---

## 2. 存储格式

### 2.1 context.json

与 MessageManager 内存中的 `messages` 数组完全一致，全量读写。

```json
[
  { "role": "user", "content": "帮我看看 /tmp/test.txt" },
  { "role": "assistant", "content": null, "tool_calls": [{ "id": "call_abc", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"/tmp/test.txt\"}" } }] },
  { "role": "tool", "tool_call_id": "call_abc", "content": "file content..." },
  { "role": "assistant", "content": "这个文件的内容是..." }
]
```

- 启动时：从文件加载到 `this.messages`
- 追加消息时：`this.messages.push(msg)` + 全量写回文件
- 记忆压缩时：`this.messages = [压缩结果]` + 全量写回文件
- 清空时：`this.messages = []` + 写回空数组 `[]`

**为什么用 JSON 而非 JSONL**：context 需要压缩和替换，操作后整体状态重建，JSON 全量写回更简单，天然保证文件和内存一致。追加频率不高（每轮对话写 2-3 次），IO 开销可接受。

### 2.2 history.jsonl

每行一条 JSON 记录，追加写入，永远不删除不修改。

```jsonl
{"id":"msg_1718352000_a3f2","role":"user","content":"帮我看看 /tmp/test.txt","ts":"2026-06-14T09:00:00.000Z"}
{"id":"msg_1718352001_b7e1","role":"assistant","content":"这个文件的内容是...","ts":"2026-06-14T09:00:02.500Z"}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识，格式 `msg_{timestamp}_{rand}`，用于游标分页 |
| role | string | `user` 或 `assistant` |
| content | string | 消息文本内容 |
| ts | string | ISO 8601 时间戳 |

**为什么用 JSONL 而非 JSON**：聊天记录只追加不修改，JSONL 天然支持 append（`fs.appendFileSync` 一行搞定），不需要读-改-写，不存在并发写冲突风险。

---

## 3. 模块改造

### 3.1 MessageManager（改造）

**文件**：`agents/elf-001/message_manager.js`（两个 agent 共用同一份代码）

**改动点**：

- 构造函数新增 `dataDir` 参数，计算 `context.json` 路径
- 构造时从文件加载 `this.messages`（文件不存在则初始化为空数组）
- `addUserMessage` / `addAssistantMessage` / `addAssistantToolCalls` / `addToolResult`：追加后调用 `_save()` 全量写回
- `compactIfNeeded`：压缩后调用 `_save()` 全量写回
- `clear`：清空后调用 `_save()`
- 新增私有方法 `_save()` 和 `_load()`

**不改动的部分**：

- `getMessagesForLLM()` — 仍从内存读取
- `estimateTokens()` — 不变
- 压缩逻辑本身 — 不变

### 3.2 ChatHistory（新增）

**文件**：`gateway/chat_history.js`

**归属**：ChatHistory 属于 Gateway 而非 Agent。理由：聊天记录是用户和 Agent 之间的对话展示层概念，不是 Agent 内部推理的一部分。Gateway 是聊天的入口，它知道用户发了什么、Agent 回复了什么，由它写 history 合情合理。Agent 不需要感知 ChatHistory 的存在。

**数据存储**：`agents/{agentId}/data/history.jsonl`——数据跟 Agent 走，一个 Agent 一份记录，但逻辑在 Gateway。

```js
class ChatHistory {
  constructor(agentsDir)       // 传入 agents 根目录，按 agentId 定位 data/history.jsonl
  addMessage(agentId, role, content)   // 追加一条记录，返回 { id, role, content, ts }
  getRecent(agentId, limit, beforeId)  // 分页查询：返回最新 N 条，beforeId 游标分页
}
```

**`addMessage`**：

1. 生成 id：`msg_{Date.now()}_{随机4位hex}`
2. 构造记录：`{ id, role, content, ts: new Date().toISOString() }`
3. 确保 `agents/{agentId}/data/` 目录存在
4. `fs.appendFileSync(historyFile, JSON.stringify(record) + '\n')`
5. 返回该记录

**`getRecent(agentId, limit, beforeId)`**：

1. 读取 `agents/{agentId}/data/history.jsonl`，逐行 parse
2. 如果指定了 `beforeId`，找到该 id 的位置，取其之前的记录
3. 否则取最新的 limit 条
4. 返回 `{ messages: [按时间正序], hasMore: boolean }`

### 3.3 agent.js（改动：无）

**不需要改动**。ChatHistory 的写入逻辑在 Gateway 侧，Agent 内部只管 MessageManager（推理上下文），不感知聊天记录。

### 3.4 server.js — Agent 端（改动：无）

**不需要改动**。`/history` 路由由 Gateway 直接提供，不需要 Agent 暴露此端点。

### 3.5 server.js — Gateway 端（改造）

**新增路由**：

| Method | Path | 说明 |
|--------|------|------|
| GET | `/agents/:id/history?limit=30&before=msg_xxx` | 获取聊天记录 |

直接调用 `chatHistory.getRecent(agentId, limit, beforeId)`，不需要向 Agent 发请求——数据在 Gateway 本地文件系统上，Gateway 自己读写。

同时在 `POST /agents/:id/chat` 的 SSE 透传逻辑中，拦截关键事件写入 history：

- 用户请求到达时：`chatHistory.addMessage(agentId, 'user', req.body.message)`
- SSE 流收到 `done` 事件后：需要收集完整 assistant 回复，一次性写入 `chatHistory.addMessage(agentId, 'assistant', fullContent)`

**收集 assistant 完整回复的方式**：在 Gateway 透传 SSE 流时，监听 `token` 事件拼接 content，收到 `done` 时写入 history。

### 3.6 frontend/app.js（改造）

**改动点**：

- `selectAgent()` 时调用 `GET /agents/{id}/history?limit=30`，用返回的 messages 初始化 `chatHistories[agentId]`
- 渲染聊天历史时，时间正序展示
- 聊天区域上滑到顶部时，用最早消息的 id 作为 `before` 参数再请求 30 条，插入顶部
- SSE 实时消息仍然追加到底部（不需要再从 history 重新拉取）

### 3.7 index.js — Gateway 入口（改造）

**改动点**：

- 初始化 `ChatHistory` 实例，传入 `agentsDir`
- 将 `chatHistory` 传入 `createGatewayApp(pm, chatHistory)` 供路由使用

### 3.8 index.js — Agent 入口（改造）

**改动点**：

- 目录 `agents/{agentId}/data/` 不存在时自动创建
- 使 MessageManager 接收 `dataDir` 参数用于 context.json 读写

---

## 4. 文件结构变化

```
agents/elf-001/
├── data/                    ← 新增目录（由 MessageManager 初始化时自动创建）
│   └── context.json         ← 新增：LLM 上下文持久化（由 MessageManager 读写）
│   └── history.jsonl        ← 新增：聊天记录持久化（由 Gateway ChatHistory 写入）
├── agent.js                 ← 不改动
├── message_manager.js       ← 改造：context.json 读写
├── server.js                ← 不改动
├── index.js                 ← 改造：初始化 dataDir，传给 MessageManager
└── ...
```

```
gateway/
├── chat_history.js          ← 新增：ChatHistory 模块
├── server.js                ← 改造：新增 /agents/:id/history 路由 + chat SSE 拦截写 history
├── index.js                 ← 改造：初始化 ChatHistory，传入 createGatewayApp
└── ...
```

```
frontend/
├── app.js                   ← 改造：加载历史 + 上拉分页
└── ...
```

---

## 5. 数据流总览

```
用户发消息 "你好"
  │
  │ [Gateway] POST /agents/:id/chat 到达
  │
  ├─→ chatHistory.addMessage(agentId, 'user', '你好')   ← Gateway 写 history.jsonl
  │     └─→ fs.appendFileSync(agents/{id}/data/history.jsonl, ...)
  │
  └─→ Gateway 转发请求到 Agent: POST http://localhost:{port}/chat
       │
       └─→ [Agent] agent.receive("你好")
             │
             ├─→ messageManager.addUserMessage("你好")
             │     ├─→ this.messages.push({ role: "user", content: "你好" })
             │     └─→ fs.writeFileSync(context.json, JSON.stringify(this.messages))
             │
             ├─→ LLM 调用 → SSE 流式输出
             │
             └─→ [Gateway] 透传 SSE 流给前端
                   │
                   ├─→ token 事件: 转发给前端 + 拼接 fullContent
                   └─→ done 事件:
                         ├─→ chatHistory.addMessage(agentId, 'assistant', fullContent)  ← Gateway 写 history
                         └─→ 转发 done 事件给前端

记忆压缩（Agent 内部，Gateway 无感知）
  │
  └─→ messageManager.compactIfNeeded(llmModel)
        ├─→ LLM 生成摘要
        ├─→ this.messages = [摘要消息]
        └─→ fs.writeFileSync(context.json, JSON.stringify(this.messages))
             // history.jsonl 不受影响
```

---

## 6. API 新增

### 6.1 Gateway 端（新增）

```
GET /agents/:id/history?limit=30&before=msg_xxx
```

**参数**：

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| limit | number | 30 | 返回消息条数 |
| before | string | 无 | 游标分页：返回此 id 之前的消息 |

**响应**：

```json
{
  "messages": [
    { "id": "msg_1718352000_a3f2", "role": "user", "content": "你好", "ts": "2026-06-14T09:00:00.000Z" },
    { "id": "msg_1718352001_b7e1", "role": "assistant", "content": "你好！有什么...?", "ts": "2026-06-14T09:00:01.500Z" }
  ],
  "hasMore": true
}
```

- `messages` 按时间**正序**排列（最旧在前）
- 不指定 `before`：返回最新的 limit 条
- 指定 `before`：返回该 id 之前的 limit 条
- Gateway 直接读取本地文件，**不向 Agent 发请求**

**错误**：

| 状态码 | 说明 |
|--------|------|
| 404 | Agent 不存在 |

注意：此接口不要求 Agent 处于 running 状态——历史记录是本地文件，即使 Agent 未启动也能查看。

---

## 7. 前端交互

### 7.1 加载聊天历史

- 用户切换 Agent 时，调用 `GET /agents/{id}/history?limit=30`
- 返回的 messages 按时间正序渲染到聊天区域
- 同时记录最早一条消息的 id，用于上拉加载

### 7.2 上拉加载更多

- 聊天区域滚动到顶部时，用最早消息的 id 作为 `before` 参数请求
- `GET /agents/{id}/history?limit=30&before=最早消息id`
- 返回的 messages 插入到聊天区域顶部
- `hasMore: false` 时不再触发加载

### 7.3 新消息

- SSE 实时推送的 token 仍然直接追加到聊天区域底部
- 不需要从 history 重新拉取刚发送的消息