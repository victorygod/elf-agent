# Agent 分层重构 —— 阶段三：万物皆 Room 设计方案

> 日期：2026-07-24
> 前置：`agent-layering-design.md`（阶段一+二已落地）、`room-as-agent-architecture.md`
> 状态：设计方案，待评审

---

## 一、设计目标与原因

| 目标 | 原因 |
|---|---|
| 统一私聊和群聊为 Room | 当前两套逻辑代码重复、维护成本高 |
| 一个 Agent 进程服务多个 Room | 同一 Agent 的多 Room 实例集中在一个进程，调度与隔离关系内聚，架构清晰 |
| 场景差异收敛到插件 | 推理引擎不变，差异只在调度策略和输出渠道 |
| 输出能力由插件注册 | Agent 核心引擎不绑定任何对外能力，全部由插件注入 |
| 工具支持 run-level 注入 | 每个请求可携带不同工具集，实现"请求级工具定制" |
| 保持现有私聊体验不变 | 流式输出、abort、rewind 是私聊核心体验 |
| 不造新功能 | 没有"离开房间"等需求，不额外添加 |

---

## 二、核心概念

**万物皆 Room。** Room 是系统的基本坐标。

```
私聊 = 2 人 Room（user + 1 agent）
群聊 = 多人 Room（user + n agents）
```

两者地位一致，唯一区别在场景插件：

| 维度 | 私聊 Room | 群聊 Room |
|---|---|---|
| 成员数 | 2 | ≥2 |
| 消息调度 | buffer 累积，空闲即 flush | buffer 累积，mention 命中 flush |
| 输出方式 | SSE 流式（逐 token 推前端） | Speak 工具（一句话广播） |
| 对外工具 | 无 | Speak |
| 使用的插件 | PrivateChatPlugin | RoomPlugin |

---

## 三、架构全景

```
┌──────────────────────────────────────────────────┐
│                 Gateway 进程                      │
│                                                  │
│  ┌─────────────┐   ┌──────────────────────────┐  │
│  │ProcessManager│   │      RoomManager         │  │
│  │管理Agent进程  │   │  管理所有Room生命周期     │  │
│  └──────┬──────┘   └──────────┬───────────────┘  │
│         │                    │                   │
│  ┌──────▼────────────────────▼───────────────┐   │
│  │            server.js                       │   │
│  │  /rooms/:rid/say       → 统一消息入口       │   │
│  │  /rooms/:rid/subscribe  → SSE 订阅          │   │
│  │  /rooms/:rid/history   → 历史分页           │   │
│  │  /agents/:id/*         → 进程管理            │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  历史：rooms/<roomId>/history.jsonl              │
│  广播：RoomBroadcaster（per-room SSE，私聊 token 流 + 群聊广播共用）│
└──────────────────────────────────────────────────┘
          │                   │
          │ 确保进程运行       │ 路由消息（POST /observe）
          │                   │
          ▼                   ▼
┌──────────────────────────────────────────────────┐
│         Agent 进程（每个 elf-00x 一个）            │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │          AgentServer                         │  │
│  │  rooms: Map<roomId, RoomState>              │  │
│  │  每个 RoomState 包含：                       │  │
│  │    ├── runContext {roomId, agentId, mode}   │  │
│  │    ├── Agent 实例                            │  │
│  │    ├── MessageManager（data/<roomId>/）       │  │
│  │    ├── ToolManager（基础工具 + 插件工具）      │  │
│  │    ├── 场景插件（输出层，内部持有调度 buffer）  │  │
│  │    ├── SyncSource（per-room cursor）         │  │
│  │    └── AbortController（per-room）           │  │
│  └──────────┬─────────────────────────────────┘  │
│  ┌──────────▼─────────────────────────────────┐  │
│  │   共享（只读）：Config、Model、create_agent.js│  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### RoomState：按 roomId 索引的运行时状态包

RoomState 只是"按 roomId 索引的内存对象集合"，**没有任何生命周期管理**：

- 消息到来 → 按 roomId 查找 → 有则使用 → 无则创建
- 创建：读 `data/<roomId>/context.json` → new MessageManager → new Agent → 注入场景插件
- 进程退出：随进程释放，磁盘文件保留
- 无"创建/销毁 Room"显式操作，无休眠/唤醒

### 并发模型

事务以 **roomId（session）为隔离边界**：

- 同一 room 内 reasoning **串行**：调度 buffer 保证一条消息处理完（含流式输出/Speak 完成）才处理下一条；busy 时累积，空闲才 flush
- 不同 room 之间 reasoning **完全并发**：互不阻塞，共享 Config/Model 只读、共享 LLM client（速率受 provider 侧约束）
- AbortController per-room，abort 只影响本 room，不波及其它 room

---

## 四、场景插件 = 输出层

阶段三核心：**Agent 核心引擎只有推理能力，对外输出能力全部由场景插件定义。**

每个 room 恰好一个 `ScenePlugin`，是本 room 行为的**主权 owner**：持 buffer 状态机、接管输出接线、给推理 gate 返回权威值。

### ScenePlugin 基类（上升自现 RoomMiddleware 的 buffer 机器）

把当前 RoomMiddleware 的通用调度能力上升为基类，私聊/群聊只 override 差异点：

| 能力 | 基类 ScenePlugin | PrivateChatPlugin | RoomPlugin |
|---|---|---|---|
| `flushLoop` | 共享 do-while：merge→addUser→reasoning→postReason，while `shouldFlush()` | 复用 | 复用 |
| `preReceive` 骨架 | filter→parse→(replying?pending:buffer)→`{action:'buffer', flushNow:shouldFlush()}` | 复用 | 复用 |
| `accept(payload)` | abstract → `{text, flushTrigger}` 或 drop | text=content,flushTrigger 恒 true | text=`name: content`,flushTrigger=mentionedMe |
| `shouldFlush()` | abstract | `!_replying`（空闲即 flush） | `_bufferHasMention` |
| `mergeForReason` / `postReason` | 共享（drain pending） | 复用 | 复用 |
| `wireOutput()` | abstract | emit 转发到 gateway room SSE | 注册 Speak + reasoning 门控 |
| reasoning gate | 默认 no-op（`shouldBreakAfterTools`→null 继续，`onAssistantContent`→null 即 break） | no-op | 重置 Speak 计数 / 含 Speak break / 纯文本注入 reminder |

**统一关键**：删掉现 `action:'private'` 特判分支，私聊和群聊都走 `action:'buffer'` + `flushLoop`，差异只在 `flushNow = shouldFlush()`（私聊空闲即 true，群聊 mention 命中才 true）。

### 私聊 / 群聊插件职责

- **PrivateChatPlugin**：调度继承基类（`accept` 不做 roster/seq/self-filter，text=content，flushTrigger=true，`shouldFlush=!_replying`）；`wireOutput` 接管 emit token 经 agent→gateway 长连接转发到常驻 room SSE（替代现 `/chat` 闭包写 res）；sync URL 从 `/agents/:id/sync-history` 改 `/rooms/:rid/sync-history`；reasoning gate 全 no-op。
- **RoomPlugin**：即现 RoomMiddleware 改名，删掉已上升基类的 buffer/flushLoop/merge/postReason，只留群聊专属——`accept`（parse 前缀 + mention + roster + seq 去重 + 自消息过滤）、`_consumeGapMessage`/`syncMissingHistory`、`wireOutput`（注册 Speak + 启用 reasoning 门控：`preReason` 重置计数、`shouldBreakAfterTools` 含 Speak break、`onAssistantContent` Speak 门控）、`_ensureRoomPrompt` 人设前缀注入。

### scene 与 middleware 的边界

`_sceneMiddleware` 改名为 `_scene`——ScenePlugin 不是 middleware，是场景本身。`this.middlewares` 链保留，承载与场景无关的横切逻辑（skill lister 注入、compact 事件回调、请求级临时 middleware）。两者同走 `_dispatchGate`：

- **ScenePlugin**：per-room 单一、有状态、主权（buffer/abort/输出孤儿 owner，不可投票）
- **middleware 链**：per-agent 0..N、无状态、组合（`shouldBreakAfterTools`/`onAssistantContent` 的返回值 OR/first-wins 归并，scene 出权威值、middleware 出 null 放行）

强制依赖：`receive()` 收到 `role === 'chat'` 且 `_scene` 为空 → throw，不进推理。每个 room 必有恰好一个 ScenePlugin。

---

## 五、工具归属

工具按生命期分三段，各归其主，**不全部 run-level**：

| 工具类 | 例子 | 生命期 | 注入者 | 时机 |
|---|---|---|---|---|
| 基础能力工具 | Read/Bash/Grep/Write | per-agent（room 内稳定） | ToolManager 初始化（config 驱动） | RoomState 建时 |
| 场景输出工具 | Speak | per-room（群聊常驻） | ScenePlugin `wireOutput` | RoomState 建时 |
| 请求差异工具 | function calling 动态工具、工具链、沙箱敏感工具 | per-request | `receive(opts.tools)` | 每请求 |

原则：**输出能力由场景插件管，基础能力归 ToolManager，请求差异才 run-level**。ScenePlugin 只管 Speak 出口（私聊无）和对 `opts.tools` 的裁剪门控，不接管基础工具注入——"agent 能干啥"与场景无关。

### run-level 注入语义

```js
agent.receive(payload, {
  emit,
  tools: [CustomToolA, CustomToolB],  // 本次请求差异工具
  middleware: [customMiddleware]       // 本次请求临时横切 middleware
})
```

- 请求开始：`tools` 临时**追加**到本 room ToolManager（同名时 run-level **覆盖**静态工具）；`middleware` 并入本请求管线
- ScenePlugin 可对 `opts.tools` 做裁剪门控（如群聊强制保留 Speak、私聊拒绝危险工具）
- 请求结束：自动注销临时工具与 middleware，不影响其它请求/其它 room
- 按需设 `opts.disableTools: ['Bash']` 做负向过滤，满足"此请求不给某基础工具"——无需把基础工具全转 run-level
- 用途：Function Calling 动态工具、工作流编排工具链、敏感工具按上下文沙箱

---

## 六、Agent 输入方式：统一 receive，插件差异化

私聊和群聊都通过 `receive(payload)` 接收，差异在插件。

**私聊路径**：
```
POST /rooms/:rid/say → Gateway 写 history → POST /observe → agent.receive(payload)
  → PrivateChatPlugin.preReceive: syncSource 对齐 + 入 buffer
  → 空闲 → flush → addUserMessage → reasoning()
  → LLM 流式 emit token → 经 gateway 转发到 room SSE → 前端
```

**群聊路径**：
```
POST /rooms/:rid/say → Gateway 写 history + 广播 → POST /observe → agent.receive(payload)
  → RoomPlugin.preReceive: 过滤/缓冲/mention 检测
  → mention 命中 → flushLoop → mergeForReason → reasoning()
  → LLM 输出纯文本 → RoomPlugin.onAssistantContent → Speak 门控
  → Speak.execute() → POST /rooms/:rid/say 广播
```

**消息调度统一为 buffer 模式**：

| 场景 | flush 条件 |
|---|---|
| 私聊 | 不 busy（不在 reasoning 中）立即 flush。等价于前端已有行为：发一条后屏蔽输入，等回复完再发 |
| 群聊 | mention 命中时 flush |

---

## 七、Agent 输出方式

### 私聊：SSE 流式输出

1. 前端 POST `/rooms/:rid/say` 发消息（HTTP）
2. Gateway 写 history.jsonl + POST `/observe` 到 agent 进程
3. 前端已有常驻 `/rooms/:rid/subscribe` SSE 连接
4. Agent推理 emit 的 token 经由 agent→gateway 通道（复用 events 长连接发 token 事件）转发到 gateway，由 RoomBroadcaster fan-out 到该 room 的 SSE 订阅
5. 前端从常驻 subscribe SSE 接收流式 token
6. reason 结束：Gateway 把完整 assistant 消息落 history.jsonl

> 改造点：私聊流式从现状"`/chat` 请求内同流 SSE + emit 写当前 res"改为"常驻 room SSE + token 经 gateway 转发"。agent 侧不再保留对接前端的 `eventsClients` 集合。

### 群聊：Speak 广播

Agent 等 LLM 输出完整文本后，通过 Speak 工具调用 `/rooms/:rid/say` 广播到房间；前端经同一 subscribe SSE 接收。

---

## 八、数据存储

### 历史消息 —— gateway 侧

所有 Room 历史统一存 `rooms/<roomId>/history.jsonl`，私聊和群聊**保持各自 schema**，不强行统一。

| | 私聊 | 群聊 |
|---|---|---|
| 存储路径 | `rooms/<roomId>/history.jsonl` | `rooms/<roomId>/history.jsonl` |
| Schema | `{id, seq, role, content, toolCalls, ts}` | `{id, seq, roomId, speaker, speakerUid, content, mentions, event, ts}` |
| 历史类 | ChatHistory | RoomHistory |
| 广播方式 | RoomBroadcaster SSE（流式 token） | RoomBroadcaster SSE + POST /observe |

- gateway 对外提供统一 `/rooms/:rid/history`，内部按 room 类型选历史类
- **现有历史数据（`chat/<agentId>/`、`rooms/<roomId>/group-history.jsonl`）清理，不做迁移**

### 工作记忆 —— agent 侧

```
Agent 进程 data/:
  ├── chat-<agentId>/        ← 私聊 room（roomId = chat-<agentId>）
  │   ├── context.json       ← MessageManager 持久化
  │   └── sync_cursor.json
  └── <room-xxx>/
      ├── context.json
      └── sync_cursor.json
```

每个 roomId 对应独立 `data/<roomId>/`。context.json 进程内加载到 MessageManager，随进程退出释放，文件保留磁盘。

### Rewind（仅私聊）

同时操作三处：

1. **history.jsonl**（gateway 侧）：`snapshot.rewindTo()` 从 checkpoint 覆盖回写
2. **context.json**（agent 侧）：gateway POST `/reload/:roomId` → `messageManager.reloadFromDisk()` 重载内存
3. **tool-results/**（agent 侧）：随 checkpoint 覆盖回写；`/reload` 同步清理旧工具结果

```
前端 rewind → gateway: snapshot.rewindTo()（改写 history.jsonl + context.json + tool-results）
           → gateway: POST /reload/:roomId
           → agent: reloadFromDisk() + 清理 tool-results
```

---

## 九、接口设计

### Gateway 对外接口

| 接口 | 用途 | 变化 |
|---|---|---|
| `GET /rooms` | 列出所有 Room | 不变 |
| `POST /rooms` | 创建 Room | 不变 |
| `GET /rooms/:rid` | Room 详情 | 不变 |
| `DELETE /rooms/:rid` | 解散 Room | 不变 |
| `POST /rooms/:rid/say` | 发言（统一入口） | **私聊也走这里** |
| `GET /rooms/:rid/subscribe` | SSE 订阅 | 不变（私聊也用，接收流式 token） |
| `GET /rooms/:rid/history` | 历史分页 | 不变 |
| `POST /rooms/:rid/members` | 加成员 | 不变 |
| `DELETE /rooms/:rid/members/:id` | 移除成员 | 只更新成员列表，不影响 RoomState |
| `GET /agents` | 列出 Agent 定义 | 不变 |
| `POST /agents/:id/start` | 启动 Agent 进程 | 不变 |
| `POST /agents/:id/stop` | 停止 Agent 进程 | 不变 |

私聊 roomId = `chat-<agentId>`，不再走 `/agents/:id/chat`。

### Agent 进程内部接口

| 接口 | 用途 |
|---|---|
| `POST /observe` | 接收消息（私聊 + 群聊统一入口） |
| `POST /abort/:roomId` | 中断本 room 推理（私聊中断流式） |
| `GET /events/:roomId` | 本 room 后台异步事件（compact 等）+ token 转发 |
| `POST /reload/:roomId` | rewind 后重载 context.json + 清理 tool-results |

不再有对接前端的 `/chat` 流式端点；SSE 订阅统一在 gateway `/rooms/:rid/subscribe`。

---

## 十、隔离性

| 维度 | 方式 |
|---|---|
| 事务边界 | roomId（session）；同 room 串行、跨 room 完全并发 |
| Agent 实例 | 每个 room 一个独立 Agent |
| MessageManager | 每个 room 独立 `data/<roomId>/context.json` |
| ToolManager | 每个 room 独立；run-level 工具请求级临时覆盖 |
| 调度 buffer | 由场景插件持有，per-room |
| SyncSource | 每个 room 独立 cursor |
| AbortController | 每个 room 独立 |
| 历史文件 | 每个 room 独立 history.jsonl |
| room SSE 订阅 | gateway 侧 RoomBroadcaster 按 room 隔离 |
| Config / Model | 跨 room 只读共享 |

---

## 十一、现有功能对应关系

| 现有功能 | 阶段三对应 | 变化 |
|---|---|---|
| `/agents/:id/chat`（私聊入口） | `/rooms/:rid/say` | 前端用 roomId |
| `/agents/:id/subscribe`（私聊 SSE） | `/rooms/:rid/subscribe` | URL 改 roomId |
| `/agents/:id/events` | gateway 转发 + agent `/events/:roomId` | 按 room 隔离，兼载 token 转发 |
| `/agents/:id/abort` | `/abort/:roomId` | 按 room 隔离 |
| `/agents/:id/rewind` | `snapshot.rewindTo` + `/reload/:roomId` | 三处重建 |
| `RoomManager.spawnReplica`（spawn 进程） | 确保进程存在 + POST /observe | 不再 spawn 新进程，复用已有 agent 进程 |
| `ChatHistory` / `RoomHistory` | 各自 schema，统一路径 | 现有数据清理不迁移 |
| `chat_proxy.js`（私聊 SSE 透传） | 流式经 RoomBroadcaster | 职责并入 RoomBroadcaster |
| `agent_events.js` | gateway 长连接 + 按 room 路由 | 兼载 token 转发 |
| agent 闭包 `eventsClients` / 队列 | RoomState per-room buffer + gateway room SSE | 自闭包变量提升为 per-room 状态 |

---

## 十二、实施步骤

1. **AgentServer 改造**：`Map<roomId, RoomState>`；调度 buffer、AbortController 全部 per-room隔离
2. **并发改造**：跨 room reasoning 并发，同 room 串行（buffer）
3. **输出层插件化**：PrivateChatPlugin（流式 + sync + 空闲 flush）、RoomPlugin（Speak + buffer + mention flush）；强制插件依赖
4. **run-level 工具注入**：`receive()` 支持 `options.tools`，请求级动态注册
5. **私聊流式改造**：emit token 经 gateway 转发到常驻 `/rooms/:rid/subscribe` SSE
6. **统一消息入口**：所有消息走 `/rooms/:rid/say`，私聊 roomId = `chat-<agentId>`
7. **room 副本合并**：RoomManager 不再 spawn 进程，调已有 agent 进程 `/observe`
8. **历史清理与统一路径**：清理现有 `chat/`、`group-history.jsonl`，统一到 `rooms/<roomId>/history.jsonl`
9. **前端路由切换**：私聊从 `/agents/:id/chat` 切到 `/rooms/:rid/say` + `subscribe`

---

## 十三、不做的东西

- 不做"离开房间"功能
- 不做通用 `createAgent` 工厂
- 不做 LangGraph / checkpoint
- 不做 RoomState 显式生命周期（创建/销毁/休眠端点）
- 不做空闲超时自动销毁
- 不做 CPU 核心级隔离
- Config / Model 只读共享，不复制

---

## 十四、风险与注意事项

| 问题 | 说明 | 等级 |
|---|---|---|
| **跨 room 并发共享 LLM** | 多 room 并发 reasoning 共用同一 LLM client，速率/并发受 provider 侧约束，可能互相限流 | 中 |
| **私聊流式改造** | emit 落点从 `/chat` 请求内 res 改为 gateway 常驻 room SSE；需保证 token 不丢、abort 仍生效、前端重连不乱序 | 高 |
| **run-level 工具覆盖语义** | 同名工具被基础工具和 run-level 工具同时注册时，run-level 覆盖基础工具；需明确覆盖生效范围与清理时机 | 中 |
| **syncSource URL 前缀** | PrivateChatPlugin 中 sync URL 硬编码 `/agents/` 前缀，统一入口后改为 `/rooms/` | 中 |
| **回调重复注册** | callbacks 数组无幂等保护，热重载可能导致 handler 重复 | 低 |

---

## 十五、实现状态

> 更新：2026-07-24。engine 插件层 + gateway 收口 + 前端统一已落地，`npm test` 465/465（含真实进程集成测）+ `build:frontend` 通过。本节对照前文设计，标注"已做 / 偏离 / 待做"。

### 已实现

| 设计点 | 落点 | 状态 |
|---|---|---|
| §三 RoomState（无生命周期，懒建） | `engine/room_state.js::createRoomState` + `engine/server.js` `rooms: Map<roomId,RoomState>` | ✅ `/observe` 带 roomId 懒建，进程退出随释 |
| §三 并发（同房串行/跨房并发） | `engine/server.js` per-room observe 队列 + 每房独立 Agent/AbortController | ✅ |
| §四 ScenePlugin 基类（buffer 机器上升） | `engine/scene_plugin.js`（flushLoop/preReceive 骨架/merge/postReason/shouldFlush abstract） | ✅ |
| §四 私聊/群聊插件 | `private_chat_plugin.js`（空闲 flush）、`room_plugin.js`（mention flush+Speak 门控） | ✅；`_sceneMiddleware`→`_scene` 单一主权 |
| §四 scene/middleware 边界 | `default_agent.js _mw = [...middlewares, _scene?]`，同走 `_dispatchGate` | ✅ |
| 工具三段归属（§五） | 基础 ToolManager 初始化 / Speak `wireOutput` / run-level `receive({tools})` | ✅ run-level 含 disableTools 负向过滤 + 裁剪门控 |
| 私聊统一入口（§六/九） | `POST /rooms/chat-<id>/say` fire-and-forget | ✅ |
| 私聊流式（§七） | `private_room_stream.js`：token 经 agent `/events`→`_onAgentEvent` 按 `_roomId`→subscribe SSE；`done` 落 history | ✅ |
| 群聊 Speak 广播（§七） | `room_bus.RoomBroadcaster.notifyAll`→POST 各成员 `/observe`；agent Speak 回调 `/rooms/:rid/say` | ✅ |
| RoomManager 不 spawn（§十一） | `ensureAgentPresent`=`pm.startAgent`+`subscribeAgent`，复用已运行进程 | ✅；无 pm 时回退 spawnReplica（仅旧测试用） |
| 历史统一路径（§八） | 私聊/群聊均 `rooms/<rid>/history.jsonl`；`ChatHistory` roomMode + `RoomHistory` 改文件名 | ✅ |
| rewind（§八）四处重建 | `snapshot.js`：context+tool-results+memory history+**room-history**（私聊房历史）；`/rooms/chat-<id>/rewind`+`/reload/:roomId` | ✅ |

### 实现取舍（偏离设计，已记）

1. **`/events` 单端点 + event data 带 `_roomId` 路由**，非设计 §九 的 `GET /events/:roomId`。理由：gateway 已对每 agent 进程持一条 `agent_events` 长连（`connectAgentEvents`），单端点+`_roomId` 标记少 N 倍连接、复用现成链；群聊仅推 compact 无前端订阅者，per-room 连接无收益。`_onAgentEvent` 按 `_roomId.startsWith('chat-')` 分流到私聊流 / 群聊忽略。
2. **engine `/chat` 保留为 agent.test 单测接口**（无生产调用者，前端/gateway 不引用）。设计 §九"不再有对接前端的 /chat"在 gateway 层已兑现；engine 层接口仅为测试 SSE 推理行为保留。
3. **私聊记忆（context/tool-results）仍在 `chat/<agentId>/data/`**（`ELF_DATA_DIR`），未迁 `rooms/`。理由：engine 默认房 dataDir 经 env 注入，迁移收益低、风险高；`rooms/chat-<id>/history.jsonl` 只承担"对外历史"，记忆本体留 chat/。rewind 快照同时覆盖两处。
4. **停止成员不动共享 agent 进程**：`stopReplica` 在 pm 模式仅 `unsubscribeAgent`+退订本房广播，绝不 `httpShutdown`（该进程服务其它房/私聊）。设计未明示，此处显式约定。

### 并发与重连兜底（已实）

- **并发风险：不存在**。`agent /events` 是 `pump` 顺序消费（`onEvent` 同步后才递归），`handlePrivateAgentEvent` 全程同步无 await，Node 单线程 → 同房事件按产出顺序排进同一 subscribe SSE，多房事件带 `_roomId` 隔离路由。
- **订阅者断开重连丢事件：已堵**。token/tool/done → `done` 落 assistant history；**compact_start/compact/compact_error → `compact_start` 写一条 `{compactId,compactLoading}` 记录，后续 `updateCompactRecord(roomId,compactId,patch)` 就地改同一条**（按 `compactId` 锚定，与旧 `chat_proxy` 同语义，**不新增一条**）。重连 idle snapshot 从磁盘 `historyToTurns` 重建压缩气泡。`test/private_room_stream.test.js` 锁定此场景。

### 待做 / 已知缺口

- **`aborted`/`error` 终态**：`done` 落了 assistant 内容，但"被中断"的精确展示如要磁盘还原，需补一条终态标记记录（目前纯靠在线事件 + done 内容）。低优先。
- **subscribe 重连 2s 窗口内的实时 token**：靠重连后 snapshot 全量对齐（streaming=true 用 eventLog 重建 activeTurn），不在重连窗口缓冲事件。极端高频 + 恰好断连可能少末尾 token，重连对齐兜底。
- **旧 `chat/` 历史数据**：旧 `chat/<id>/data/history.jsonl`（agentId 键私聊历史）已删；`context.json`/`tool-results`/`checkpoints` 保留（agent 工作记忆根，未迁移）。

### 测试覆盖

- 单元 453 + 集成 10 + private_room_stream 2 = 465 全绿。
- 集成测（真实 mock-model 进程）：私聊 `/rooms/chat-<id>/say` 流式 token+done、群聊建群复用 pm 进程不 spawn + @mention 写历史、rewind 四处重建、离线 503、多 Agent 独立。
- 新增针对性测：`room_state.test.js`（多房路由/并发/abort）、`run_level_tools.test.js`（run-level 覆盖/disable）、`private_room_stream.test.js`（compact 落盘+重连兜底）。