# Agent、Gateway、前端接口分析

> 日期：2026-07-19
> 说明：梳理当前代码中三端之间的所有交互接口、数据流格式和职责边界。

---

## 一、总览：三端职责

```
┌──────────────┐       HTTP        ┌──────────────┐       HTTP        ┌──────────────┐
│   前端        │ ◄──────────────► │  Gateway     │ ◄──────────────► │  Agent        │
│ (React)      │    JSON / SSE     │  (Express)   │    JSON / SSE     │  (子进程)      │
│              │                   │              │                   │              │
│ useChat      │                   │ server.js    │                   │ server.js    │
│ useRoomChat  │                   │ room_routes  │                   │ room_agent   │
│ agentStore   │                   │ chat_proxy   │                   │ default agent│
│ roomStore    │                   │ process_mgr  │                   │              │
└──────────────┘                   └──────────────┘                   └──────────────┘
                                      │
                                      │ 本地调用
                                      ▼
                                 ┌──────────────┐
                                 │ RoomManager   │
                                 │ (room_bus.js) │
                                 │ Broadcast     │
                                 │ History       │
                                 │ Spawn/Stop    │
                                 └──────────────┘
```

---

## 二、接口目录

| 编号 | 方向 | 方法 | 路径 | 协议 |
|---|---|---|---|---|
| ① | 前端→Gateway | POST | `/agents/:id/chat` | SSE 流 |
| ② | 前端→Gateway | GET | `/agents/:id/subscribe` | SSE 流 |
| ③ | 前端→Gateway | POST | `/rooms/:rid/say` | JSON |
| ④ | 前端→Gateway | GET | `/rooms/:rid/subscribe` | SSE 流 |
| ⑤ | Gateway→Agent | POST | Agent `:port/chat` | SSE 流 |
| ⑥ | Gateway→Agent | POST | Agent `:port/observe` | JSON |
| ⑦ | Agent→Gateway | POST | `/rooms/:rid/say` | JSON |
| ⑧ | Agent→Gateway | GET | `/rooms/:rid/sync-history/:agentId` | JSON |
| ⑨ | Agent→Gateway | GET | `/rooms/:rid` | JSON |

---

## 三、每种接口的详细说明

### ① 前端→Gateway：私聊 `POST /agents/:id/chat`

**入口**：`gateway/server.js` 第 190 行

**调用方**: 前端 `useChat.send()` → `api.chat()`

```js
// 前端 (frontend/src/api/index.js)
fetch(`${API_BASE}/agents/${agentId}/chat`, {
  method: 'POST',
  body: JSON.stringify({ message: "你好" }),
})
```

**Gateway 处理流程**（`server.js:190-241`）：
1. 检查 Agent 是否在运行（否则回 202 离线排队）
2. 检查是否有活跃流（有则回 422 拒绝）
3. 打 rewind 快照（`snapshotBeforeSend`）
4. 写 user 消息到私聊 `history.jsonl`
5. 返回 SSE 响应头（`text/event-stream`）
6. `proxyChat()` 代理到 Agent 的 `/chat`

**SSE 事件流**（回给前端的）：

| 事件 | 数据 | 含义 |
|---|---|---|
| `snapshot` | `{streaming, turns, activeTurn, hasMore}` | 页面刷新重连时的状态快照 |
| `token` | `{content: string}` | 流式文本 |
| `tool_call` | `{tool_calls: [{name, args, description}]}` | 工具调用 |
| `tool_result` | `{status, message?}` | 工具执行结果 |
| `compact_start` | `{compactId, attempt}` | 开始记忆压缩 |
| `compact` | `{compactId, tokenEstimate}` | 压缩成功 |
| `compact_error` | `{compactId, error, final?}` | 压缩失败 |
| `compact_abort` | `{compactId}` | 压缩被中断 |
| `done` | `{}` | 回复结束 |
| `error` | `{message}` | 错误 |
| `aborted` | `{}` | 用户中断 |

---

### ② 前端→Gateway：私聊订阅 `GET /agents/:id/subscribe`

**入口**：`gateway/server.js` 第 244 行

**作用**：页面刷新后恢复 SSE 流（不发送新消息，只收已有流的回放 + 后续实时事件）。

**Gateway 处理**：`chat_proxy.js:subscribeToStream()`
- 从 `streamContexts` 读取当前活跃流上下文
- 返回 snapshot 事件 → 将前端作为 subscriber 加入 ctx.subscribers

---

### ③ 前端→Gateway：群聊发言 `POST /rooms/:rid/say`

**入口**：`gateway/room_routes.js` 第 182 行（这是现有**统一发言入口**）

**调用方**：
- 用户：`useRoomChat.send()` → `api.sendRoomMessage()`，头部 `X-Speaker-Id: user`
- Agent：Speak 工具调用，头部 `X-Speaker-Id: agentId`

```js
// 前端 (frontend/src/api/index.js:390)
fetch(`${API_BASE}/rooms/${roomId}/say`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': 'user' },
  body: JSON.stringify({ content: message }),
})
```

**Gateway 处理**：
1. 校验 `X-Speaker-Id` 身份合法性（user 或成员 agentId）
2. 调 `roomManager.processRoomMessage()`
3. 内部：写 `group-history.jsonl`（uid 落盘）→ `notifyAll()` 推 SSE + POST agent observe

**响应**：`{ status: 'ok', id: 'rmsg_xxx' }`

---

### ④ 前端→Gateway：群聊订阅 `GET /rooms/:rid/subscribe`

**入口**：`gateway/room_routes.js` 第 153 行

**作用**：前端 EventSource 连接，订阅群消息事件。

**SSE 事件**：

| 事件 | 数据 | 含义 |
|---|---|---|
| `snapshot` | `{roomId, members, messages}` | 房间快照（成员 + 最近 50 条历史） |
| `speak` | `{speaker, speakerUid, content, ts, id, seq}` | 新消息（name 版） |
| `member_status` | `{agentId, status}` | 成员在线状态变更 |
| `error` | `{message}` | 错误 |

**注意**：群聊只用这 4 种事件，没有 token/tool_call 等流式事件——群聊是"整块发言"模型。

---

### ⑤ Gateway→Agent：私聊 `POST agent:port/chat`

**入口**：`shared/agent/server.js` 第 110 行

**调用方**：Gateway `chat_proxy.js:proxyChat()`

**请求体**：
```json
{ "message": "用户消息", "seq": 42 }
```

**Agent 处理**：
1. 入请求队列（`enqueueRequest`/`processRequest`）
2. 调 `agent.receive()` → `Agent.receive()` 入口
   - 私聊 Agent：直接 `addUserMessage(message)` → `reasoning()`
   - RoomAgent：cover 了 receive，会先 route 到 `super.receive()`
3. 流式 yield SSE 事件（token/tool_call/tool_result/compact/compact_error/compact_start/done）
4. 可合并输入：空闲时多个请求会被合并为一条 `pendingMessage`

---

### ⑥ Gateway→Agent：观察消息 `POST agent:port/observe`

**入口**：`shared/agent/server.js` 第 273 行（仅 room 模式注册）

**调用方**：Gateway `RoomBroadcaster._broadcastToAgents()` → fire-and-forget

**请求体**：
```json
{
  "from": "userUid 或 agentId",  // uid 版，agent 自消息过滤靠这个
  "content": "@elf-002 你好",      // name 版（@ 已改写为 name）
  "mentions": ["elf-002"],         // uid 列表
  "role": "chat",
  "seq": 42
}
```

**Agent 处理**（独立于 /chat 的队列）：
1. 独立 observe 队列（`observeProcessing`/`pendingObserve`）
2. 调 `agent.receive(payload)` → `RoomAgent.receive()`
3. RoomAgent.receive 逻辑：
   - 自消息过滤（from 是否自己）
   - `_refreshRoster()` 刷新群成员
   - `_alignSeq()` seq 对齐 + `_fillGap()` 补空洞
   - 解析到 buffer
   - 被 @ → `_doFlush()` → reasoning → Speak 工具
   - reasoning 中来的消息 → 进 `_pendingBuffer`，结束后再 flush
4. SSE 事件完全吞掉（群聊消息不流式回前端，`for await (const _ of ...) { /* swallow */ }`）

---

### ⑦ Agent→Gateway：Agent 发言 `POST /rooms/:rid/say`

**入口**：`shared/agent/tools/Speak.js`（Speak 工具的 execute 方法）

**调用方**：Agent 进程内部 `toolRegistry.execute('Speak', {message})`

```js
// Speak.js:49-55
await fetch(`${rc.roomBusUrl}/say`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': rc.memberName },
  body: JSON.stringify({ content: message }),
})
```

**说明**：Speak 工具调的是 Gateway 的 `/say` 路由，走的是「统一发言入口」。`memberName` 即 agentId，Gateway 校验其为房间合法成员。

---

### ⑧ Agent→Gateway：同步历史 `GET /rooms/:rid/sync-history/:agentId`

**入口**：`gateway/room_routes.js` 第 104 行

**调用方**：Agent `RoomAgent._seedCursor()`、`RoomAgent._fillGap()`

**用途**：Agent 首次启动或发现 seq 空洞时，从 Gateway 拉取缺失的消息。

**参数**：
- `seed=true` → 返回 `{messages: [], latestSeq: N}` 仅取最新 seq 用于初始化游标
- `afterSeq=N` → 返回 `{messages, latestSeq}` seq > N 的所有消息

**响应**（非 seed 模式）：
```json
{
  "messages": [
    {
      "id": "rmsg_xxx", "seq": 42, "speaker": "user",
      "content": "@elf-002 你好", "mentions": ["elf-002"],
      "event": "speak", "ts": "..."
    }
  ],
  "latestSeq": 42
}
```

---

### ⑨ Agent→Gateway：群详情 `GET /rooms/:rid`

**入口**：`gateway/room_routes.js` 第 46 行

**调用方**：Agent `RoomAgent._refreshRoster()`

**用途**：获取房间当前成员列表、在线状态、用户信息，用于构建 `_agentNames` 映射和前缀。

**响应**：
```json
{
  "roomId": "room_xxx",
  "name": "开发讨论",
  "members": [
    { "agentId": "elf-001", "name": "Star", "status": "running", "avatar": null }
  ],
  "createdAt": "...",
  "userName": "user", "userUid": "default_userid"
}
```

---

## 四、两种消息模型对比

| 维度 | 私聊 (`/chat`) | 群聊 (`/observe` + `/say`) |
|---|---|---|
| **消息格式** | `{message: string}` | `{from, content, mentions, role, seq}` |
| **回复方式** | SSE 流式（token/tool_call/...） | Speak 工具整块发言 |
| **Agent receive** | `Agent.receive()` 基类 | `RoomAgent.receive()` 子类 |
| **队列** | 单一的 `isProcessing`/`pendingMessage` | 独立 `observeProcessing`/`pendingObserve` |
| **消息合并** | 空闲合并（同队列） | 被 @ 时 pendingBuffer 累积 |
| **回前端** | token 流直达前端 | speak 事件经 Gateway broadcast |
| **自消息过滤** | 无（只有用户→Agent） | 有（Agent→Agent 时防回声） |

---

## 五、关键流程：群聊消息流转

```
用户写 "你好 @elf-002"
  │
  ▼ 前端 POST /rooms/:rid/say (X-Speaker-Id: user)
  │
  ▼ Gateway roomManager.processRoomMessage()
  │
  ├─ 1. 写 group-history（uid 版：speakerUid=userUid, content @=uid）
  ├─ 2. broadcast('speak', {speakerUid, speakerName, contentNames, ts, id, seq, mentions})
  │      │
  │      ├─ SSE → 前端（name 版：speaker=userName, content @=name）
  │      │
  │      └─ POST /observe → 所有 agent 副本（from=uid, content=name 版）
  │
  ▼ Agent 收到 /observe
  │
  ├─ 自消息过滤（自己说的？跳过）
  ├─ _refreshRoster()
  ├─ _alignSeq(42) → _fillGap() 补空洞
  ├─ _parse → displayName = "user", text = "user: 你好 @elf-002", mentionedMe = true
  ├─ push buffer → flush
  │
  ▼ RoomAgent.reasoning()
  │
  ├─ LLM 决定调用 Speak("你好 @user，有什么可以帮你的？")
  │
  ▼ Speak.execute 调用 POST /rooms/:rid/say (X-Speaker-Id: elf-002)
  │
  ▼ Gateway 重新从 processRoomMessage 走一轮
  │
  ├─ 写历史
  ├─ SSE speak → 前端（显示 elf-002 的回复）
  └─ POST /observe → 所有 agent（elf-002 自消息过滤跳过，其他 agent 收到）
```

---

## 六、事件通道（events bridge）

```
Agent 后台压缩完成
  │
  ▼ Agent._pushEvent('compact', {compactId, tokenEstimate})
  │
  ▼ Agent GET /events SSE → Gateway connectAgentEvents()
  │
  ▼ ProcessManager._onAgentEvent()
  │
  ├─ 广播给 subscribedClients（前端 subscribe 连接）
  └─ 更新 chatHistory.updateCompactRecord()
  │
  ▼ 前端 useChat._handleSSEEvent('compact', data)
  → 气泡状态更新（loading → 完成/失败）
```

**事件类型**：
| 事件 | 含义 | 说明 |
|---|---|---|
| `compact` | 记忆压缩成功 | Agent 后台异步完成压缩 |
| `compact_error` | 记忆压缩失败 | 含错误信息和 final 标记 |
| `compact_abort` | 压缩被中断 | 用户中断推理时触发 |

---

## 七、现存的分裂——私聊 vs 群聊

当前代码中最明显的两套体系：

### 7.1 历史存储

| 系统 | 文件 | 存储位置 | Schema |
|---|---|---|---|
| 私聊 | `gateway/chat_history.js` | `agents/<id>/data/history.jsonl` | `{id,role,content,ts,toolCalls?}` |
| 群聊 | `gateway/room_bus.js` RoomHistory | `rooms/<rid>/group-history.jsonl` | `{id,seq,roomId,speaker,content,event,ts,speakerUid?}` |

### 7.2 Agent 消息接收

| 场景 | 接口 | receive 入口 | 行为 |
|---|---|---|---|
| 私聊 | POST /chat | `Agent.receive(message)` | 直接 `addUserMessage` → reasoning |
| 群聊 | POST /observe | `RoomAgent.receive(payload)` | buffer → mention 检测 → flush → reasoning |

### 7.3 前端

| 场景 | Hook | 订阅方式 | 消息模型 |
|---|---|---|---|
| 私聊 | `useChat` | `GET /agents/:id/subscribe` | SSE token 流式 |
| 群聊 | `useRoomChat` | `EventSource /rooms/:rid/subscribe` | speak 事件整块 |

### 7.4 Gateway 路由

| 场景 | 路径 | 实现位置 |
|---|---|---|
| 私聊 | `/agents/:id/*` | `gateway/server.js` |
| 群聊 | `/rooms/:rid/*` | `gateway/room_routes.js` |

---

## 八、关键差异总结表

| 能力 | 私聊路径 | 群聊路径 |
|---|---|---|
| **用户发言** | `POST /agents/:id/chat` → `proxyChat()` → Agent `/chat` | `POST /rooms/:rid/say` → `processRoomMessage()` → 写历史 + 广播 |
| **用户发言回前端** | SSE token/tool_call 流直达（经 Gateway 透传） | SSE `speak` 事件经 `RoomBroadcaster` 广播 |
| **Agent 接收消息** | `/chat` 队列，直接 user→assistant 推理 | `/observe` 独立队列，buffer+mention+flush 状态机 |
| **Agent 发言** | SSE 流式 token 回前端 | Speak 工具 → `POST /rooms/:rid/say` → 广播 |
| **Agent 进程独立性** | 一个 Agent 一个进程，只能有一个私聊上下文 | 一个 Room 的每个成员一个进程，Agent 可同时属于多 Room |
| **个性化** | 基类 `Agent` | 子类 `RoomAgent`（覆盖 receive，追加 buffer/seq 逻辑） |
| **记忆压缩** | 有（`chat_history` 带 _mergeCompactRecords） | 有（`MessageManager` 基类提供，但群聊不做 _mergeCompactRecords） |