# SSE 聚合方案设计

> 解决「前端常驻 SSE 长连接占满浏览器 HTTP/1.1 连接池 → 刷新转圈 + 上翻加载失败」问题。
>
> 状态:调研 + 方案,待评审。日期:2026-08-01。

## 0. 概览

> 先看这一节,后面是证据与细节。

**一句话**:前端到 gateway 的常驻 SSE 从「每个 running agent 一条」收敛为「全程 1 条」,解除浏览器 HTTP/1.1 的 6 连接上限。

### 现状

```
7 个 running agent ─┐  useAgentSubscriptions 对每个 agent 开 1 条 SSE → /rooms/chat-elf-00x/subscribe
群聊面板 ──────────┘  → /rooms/<rid>/subscribe
```

gateway 跑 HTTP/1.1,浏览器对单站点最多 **6 条并发连接**。`lsof` 实测 Chrome 到 8080 恒为 **6 条 ESTABLISHED**——SSE 长连接占满池子且不释放,导致:
- 刷新转圈:新资源请求挤不进;
- 上翻 `GET /history?before=` `Failed to fetch`。

(另:上翻接口之前还撞上 `chat_history.js` `const` 误赋值的 500 bug,已单独修复。)

### 方案:聚合 SSE

```
前端 ──(1 条 fetch-SSE)──► gateway POST /subscribe
          后端枚举所有 running 私聊房 + 群聊房,动态跟随 agent 启停/群聊变动
          每条事件注入 {roomId, roomType} 后写进同一连接
          前端按 roomId 路由到各自 store,UI 只渲染当前激活房
```

- **切房/切 agent 不动连接**:纯前端换渲染目标,与私聊现有「切 tab 不断流式」一致。
- **不串房**:每条事件显式带 `{roomId, roomType}`,前端按它路由。
- **顺带修两个现状缺口**:订阅鉴权留占位(现状 `/subscribe` 无鉴权,单用户先不收窄,多用户化再上 uid 过滤)、notice 进 per-room 队列切房才显示积压。

**例子** —— 你在 elf-001,后台 elf-003 流式回复:
```
后端推 {event:"token", data:{roomId:"chat-elf-003", roomType:"chat", content:"你好"}}
  → 写进 elf-003 store(静默,不显示)
切到 elf-003 → 看到"你好"已在渲染
```
notice 同理:elf-003 后台报 3 条"压缩失败" → 静默入 elf-003 队列;切过去才依次弹出再消失。

### 范围

只聚合 **前端 ↔ gateway** 这一段。gateway ↔ agent(每个 agent 一条 `/events`)是 node 服务端到服务端、不同端口,**不受浏览器 6 连接限制,不动**。

### 对比

| | 现状 | 聚合后 |
|---|---|---|
| 常驻 SSE 数 | 7+(随 agent 数涨) | 1 |
| 连接池 | 占满,刷新/上翻卡死 | 充裕,全部通畅 |
| 切房 | 私聊不重建 / 群聊重建 | 一律不重建 |
| 私聊重连上翻 | (现状重连会丢) | merge 保留,不丢 |
| 群聊上翻 | 无(一次性 50 条) | 顺手补上(后端已就绪) |
| notice | 全局 toast 串房 | 按房积压,切房才显示 |
| 订阅鉴权 | 无 | 单用户占位(多用户化再收窄) |

---

## 1. 背景与问题

### 1.1 现象

- 前端刷新页面**一直转圈**、加载不出来。
- 私聊上翻加载历史(`GET /rooms/chat-<id>/history?before=...`)**发不出去**,`frontend.log` 报 `加载更多历史失败: Failed to fetch`。

### 1.2 根因(已实测确认)

gateway 是 node `http` 模块起的 **HTTP/1.1** 服务(`curl -w "%{http_version}"` 实测 = `1.1`)。
浏览器对**单个 origin(scheme+host+port)同时最多 6 条 TCP 连接**(Chrome `kMaxSocketsPerGroup=6`,localhost 不豁免)。

前端 `useAgentSubscriptions`(`frontend/src/hooks/useAgentSubscriptions.js:73-84`)对每个 `status==='running'` 的 agent 各开**一条常驻 fetch-SSE 长连接**到 `/rooms/chat-<id>/subscribe`。当前 7 个 running agent → 7 条长连接 > 6 上限。

实测证据:`lsof -iTCP:8080 -sTCP:ESTABLISHED | grep Chrome | wc -l` 恒为 **6**,正好是上限被占满、第 7 条建不上的直接证据。

**SSE 长连接独占连接且永不释放**,6 条把池子锁死后,后续任何请求(刷新时动态资源、上翻的 `history?before=`)只能排队 → 永远排不上 → 转圈 / `Failed to fetch`。

> 附带:之前 `gateway/chat_history.js:245` 的 `const records` 误赋值导致上翻 500,是**另一个独立 bug**,已修(`const`→`let`)。两者叠加才使上翻完全不可用。

### 1.3 目标

前端到 gateway 的常驻 SSE 全部收敛为 **1 条**,彻底解除连接池占用,刷新与上翻恢复正常,且保留现有"切 tab 不断流式、靠 snapshot 对齐"的运行模型。

---

## 2. 现状 SSE 架构

### 2.1 两条前端 SSE 入口(全局仅此两处)

| # | 类型 | 前端入口 | 后端路由 | 传输 | 生命周期 |
|---|---|---|---|---|---|
| 1 | 私聊 | `useAgentSubscriptions.js:34` → `api/index.js:143-184` | `GET /rooms/chat-<id>/subscribe` | **fetch + getReader**(fetch-SSE,带 AbortController,自解析 `event:`/`data:`) | App 顶层常驻,每个 running agent 一条,切 tab 不断,2s 重连 |
| 2 | 群聊 | `useRoomChat.js:27` | `GET /rooms/<rid>/subscribe` | 原生 `EventSource`(浏览器自重连) | 随 `RoomChatPanel` 挂载,切房断旧连新 |

后端是**同一条路由** `GET /rooms/:rid/subscribe`(`gateway/room_routes.js:201`),按 `rid.startsWith('chat-')` 分流:
- 私聊 → `subscribePrivateRoom`(`private_room_stream.js:69`,TurnStreamServer 单例 + 模块级 `_sseSubs:Map<roomId, Set<res>>`)。
- 群聊 → `RoomManager.getBroadcaster(rid).add(res, snapshot)`(`room_bus.js` RoomBroadcaster,per-room)。

### 2.2 私聊 SSE 事件全集(`sseDispatcher.js:136-351` handleSSEEvent)

13 种,按 agentId(来自订阅 URL)路由写 `agentStore`:

| 事件 | 用途 | data 关键字段 |
|---|---|---|
| `snapshot` | 订阅/重连全量重建 | `{turns, activeTurn, streaming, hasMore}` |
| `token` | 流式文本增量(高频,rAF 批合并) | `{content}` |
| `tool_call` | 工具调用 | `{tool_calls}` |
| `tool_result` | 工具结果 | `{...}` |
| `status` | 状态(前端空 case 忽略) | — |
| `compact_start` | 记忆压缩开始 | `{compactId, attempt}` |
| `compact` | 压缩完成 | `{compactId, tokenEstimate}` |
| `compact_error` | 压缩失败 | `{compactId, attempt, final}` |
| `compact_abort` | 压缩中止 | `{compactId}` |
| `done` | 回合结束(activeTurn 转 turns) | — |
| `aborted` | 中断收尾 + toast | — |
| `error` | 错误收尾 | — |
| `notice` | 居中瞬态 toast(LLM 重试/失败) | `{kind, text?, ...}` |

### 2.3 群聊 SSE 事件全集(`useRoomChat.js:30-62`)

4 种,按 roomId(来自 `useRoomChat(roomId)` 闭包)写 `roomStore`:

| 事件 | 用途 | data 关键字段 |
|---|---|---|
| `snapshot` | 订阅时全量 | `{messages:[], members:[]}` |
| `speak` | 整块消息(非流式) | `{speaker, speakerUid, content, ts, id, seq}` |
| `member_status` | 成员在线状态 | `{agentId, status}` |
| `notice` | 居中 toast | `{...}` |

### 2.4 事件同构性

- **同名同义**:`snapshot`(但 data shape 不同:私聊 turns/activeTurn vs 群聊 messages/members)、`notice`(同构)。
- **仅私聊**:`token/tool_call/tool_result/compact_*/done/aborted/error/status`(流式回合)。
- **仅群聊**:`speak/member_status`(整块消息、成员状态)。
- 两套事件**几乎不重叠**,合并风险主要落在 `snapshot` 的 shape 归并与路由字段。

### 2.5 私聊数据流(完整链路)

```
Agent /events (data._roomId = chat-<id>)
  └─ gateway connectAgentEvents(agent_events.js)  ← 每 agent 一条,见 §3
       └─ process_manager._onAgentEvent (process_manager.js:390)
            └─ handlePrivateAgentEvent (private_room_stream.js:93)
                 ├─ _broadcast(roomId, chunk) → 该 room 的常驻 /subscribe 订阅者
                 └─ _server.handleEvent(落盘 history + 内存态)
前端 /subscribe 建立:
  subscribePrivateRoom(69) → buildSnapshot(30 条+hasMore) → 发 snapshot → 注册 _sseSubs
  ⚠ _stripRoomId(32-36) 广播前删掉 data._roomId(因 per-room 连接无需再带)
```

---

## 3. gateway ↔ agent 的 SSE 是否有同样限制?

**结论:没有,无需聚合。**

- `agent_events.js:connectAgentEvents` 对每个 running agent 建一条 fetch-SSE 到 `http://127.0.0.1:<port>/events`,5s 重连。
- 这是 **node(gateway)作为客户端 → node(agent)服务端**,服务端到服务端,**不在浏览器进程内,不受浏览器 6 连接限制约束**。
- 且每个 agent **端口不同 = 不同 origin**,即便 node undici 有 per-host socket 上限,每 origin 仅 1 条 `/events` 连接,远低于任何上限。
- 实测:`agent-elf-007` 端口 8087 的 `/events` 因本机 Spring 应用抢占 IPv4 8087 一直 404 重连刷屏——这是**端口冲突的独立运维问题**,不是连接数问题。

> 聚合只发生在 **前端 ↔ gateway** 这一段;gateway ↔ agent 维持现状(每 agent 一条 /events)。

---

## 4. 聚合方案设计

### 4.1 总体思路

新增一条**聚合订阅端点**,前端整个生命周期只连 1 条 fetch-SSE。后端把"所有 running 私聊房 + 群聊房"的事件**统一打标后**写入这条连接;前端按事件里的 `roomId`/`roomType` 分发到对应 store。

```
前端 ──(1 条 fetch-SSE)──> gateway /subscribe (聚合端点)
                                   │
        ┌──────────────────────────┼───────────────────────────┐
        │ 私聊房(chat-*)事件       │ 群聊房事件                │
        │ ← _sseSubs / TurnStream  │ ← RoomBroadcaster          │
        └──────────────────────────┴───────────────────────────┘
```

### 4.2 端点与订阅范围(1 条常驻,切房只换渲染)

**核心模型:聚合订阅一开始就订「当前用户的所有私聊房 + 所有群聊房」,之后切房/切 agent 纯前端换渲染目标,连接全程不动。**

- `POST /subscribe`(单用户,暂不收鉴权,留占位)。
  - 返回:`text/event-stream`,先逐房补发 `snapshot`(带 `roomType`),再持续推所有订阅房的增量事件。
- **后端枚举订阅范围**(单用户 = 全部),前端无需声明房间:
  - 私聊房:所有 running agent 的 `chat-*` 房。
  - 群聊房:所有群聊房。
- **动态跟随生命周期(关键)**:聚合订阅集合**不是静态的**——后端监听 agent 启停 + 群聊创建/成员变动,把新增房加入集合并**补发该房 snapshot**;停止/删除的房移除。否则新启动的 agent / 新建群聊**收不到事件**(现状 `useAgentSubscriptions:73-84` 是监听 `agents` 变化即时建订阅,聚合后这层动态逻辑要后端 `AggregatedBroadcaster` 接管,见 §6)。
- **切房不重建连接**:前端 `onEvent` 按 `roomId` 路由进对应 store,UI 只渲染当前激活房。私聊切 tab、群聊切房都只是前端状态切换,不碰 SSE 连接,与私聊现有"切 tab 不断流式"一致。
- **不做前端动态 add/drop room**(二期可选):当前房数有限,全量订阅 + 按房路由开销可接受。注意这跟上面"后端动态跟随生命周期"是两回事——后者是后端**必须**做的,前者是前端按需开合房间,暂不实现。

### 4.3 事件 payload 规范(强约束)

**所有聚合事件 data 必须显式带 `roomId` + `roomType`**,前端据此路由:

```jsonc
{
  "roomId": "chat-elf-001",      // 或群聊 rid
  "roomType": "chat",            // "chat"(私聊) | "room"(群聊)
  ...原事件 payload
}
```

- **注入点统一(旧 + 聚合共用一条路径)**:私聊 `_broadcast`(`private_room_stream.js:19`)和群聊 `broadcast`/`notifyAll`(`room_bus.js:101/123`)在**序列化 chunk 前**注入 `{roomId, roomType}`;私聊侧取消 `_stripRoomId`(`private_room_stream.js:32`)改为注入 `roomType:'chat'`。旧 per-room 端点前端多收这两个字段无害,聚合端点靠它们路由。
- `snapshot`:端点拼 chunk 时带 `{roomId, roomType}`(私聊 `roomType:'chat'`,群聊 `roomType:'room'`),shape 维持各自原样(§4.5)。

### 4.4 前端统一接入

新增 `useAggregatedSubscription`(App 顶层调一次,替代 `useAgentSubscriptions`;`useRoomChat` 不再自建 EventSource,只保留纯前端切房状态 + 抽出的事件处理函数):

```
onEvent(event, data) {
  const { roomId, roomType } = data;
  if (roomType === 'chat' || roomId?.startsWith('chat-')) {
    handleSSEEvent(stripChatPrefix(roomId), event, data);  // 复用 sseDispatcher(13 事件,零改动)
  } else {
    roomDispatch(roomId, event, data);                      // 复用 useRoomChat 的 4 事件处理
  }
}
```

`sseDispatcher.js` 与 `useRoomChat.js` 的事件处理逻辑**互不重叠**(除 snapshot/notice),只需把"agentId/roomId 来源"从闭包改成 event data 字段。snapshot 在两边各自走原 rebuild(`rebuildFromSnapshot` / `initFromSnapshot`),按 `roomType` 分支。

### 4.5 snapshot shape 不强行归并

私聊 `{turns, activeTurn, streaming, hasMore}` 与 群聊 `{messages, members}` 差异大,强行合并成一个 schema 代价高且无收益。

- 聚合流里私聊 snapshot = `{roomId, roomType:'chat', turns, activeTurn, streaming, hasMore}`。
- 群聊 snapshot = `{roomId, roomType:'room', messages, members}`。
- 前端 dispatcher 按 `roomType` 选 `rebuildFromSnapshot` 或 `initFromSnapshot`。事件名都叫 `snapshot` 不冲突,因为路由先按 roomType 分流。

### 4.6 传输层:统一到 fetch-SSE

- 沿用 `api/index.js:143-184` 的 fetch-SSE 骨架(带 AbortController、自解析)。
- **群聊放弃 `EventSource`**:无法主动 abort、不能 POST body、切房需重建连接。统一到 fetch-SSE 后,切群聊房纯前端换渲染目标,连接不动(见 §4.2)。
- 重连策略沿用私聊现有 2s 退避 + 后续 snapshot 全量对齐。

### 4.7 重连与对齐

- 重连后后端按当前订阅集合**逐房补发 snapshot**完成对齐(私聊 `buildSnapshot`,群聊 `buildSnapshotData()`)。
- **整列替换 + 稳定 key,闪烁很小**:私聊 `turns.map(key=turn.id)`、群聊 `messages.map(key=m.id)`,React 按已有 id 复用 DOM,snapshot 整列只增减变化条目,不重建整列 DOM。
- **私聊重连保持上翻(merge,不回退)**:snapshot 替换前前端按 `turn.id` 去重 merge——已上翻的 olderTurns(snapshot 不含)保留,snapshot 新窗口 prepend,按 `seq` 排序;`activeTurn` 由 snapshot 直接覆盖(流式中重连时 optimistic `local_` id 被后端真实版替代,内容不丢)。**不丢上翻历史**。改动在 `rebuildFromSnapshot` 调用处加一步 merge(turn.id 稳定、seq 可序)。
- 群聊重连:整列替换 `messages` + `members`,无本地增量、稳定 key,基本无损。
- 顺带补上现有群聊缺口:`useRoomChat.js` 注释(line 8-9)提到 EventSource 重连会丢历史窗口事件;聚合后群聊也走 snapshot 对齐,缺口消失。

### 4.8 notice 按房隔离 + 切房显示积压(已定)

**现状**:`notice` 附在对应房的 SSE 流里推(私聊经 agent /events → private_room_stream 广播;群聊经 `POST /rooms/:rid/notice` → RoomBroadcaster.broadcast),但前端收到后调**全局** `showToast`,会跨房串扰,且切走该房时 notice 直接漏掉。

**目标**:notice 归属到产生它的房,切到该房才显示,积压不丢。

- **后端**:notice 事件在聚合流里照常带 `{roomId, roomType}`(§4.3 规范),无需特殊处理。
- **前端 store**:新增 per-room 的 notice 队列。聚合 dispatcher 收到 `notice` 时按 `roomId` push 到该房队列,**不直接弹全局 toast**。
  - `agentStore` 的 chat 对象增加 `noticeQueue: []`(私聊)。
  - `roomStore` 的 room 对象增加 `noticeQueue: []`(群聊)。
- **渲染**:只渲染**当前激活房**的 `noticeQueue`——逐条(或合并)显示 toast,每条照常 3s 淡出,全部显示后清空队列。未激活房的 notice 安静积压在各自 store。
- **切房行为**:切到某房瞬间,若该房 `noticeQueue` 非空,立即把积压的 notice 按序展示完再消失——正是你要的"切到那个房间才把积压的 notice 显示出来再消失"。
- **不只 notice**:`aborted` 事件里 `sseDispatcher.js:318` 的 `showToast('已停止生成')` 也是全局 toast,同样改为入该房队列(否则在 A 房触发 aborted 会在 B 房弹 toast)。其余 `error/compact_*` 不弹 toast,无需处理。
- **丢弃策略**(可选):为避免长期不切的房无界积压,给队列加上限(如最近 20 条)或带 ts 超时清理。

### 4.9 顺带补群聊上翻加载(已定)

**现状缺失**:`RoomChatPanel` 只有滚到底,无滚到顶加载;群聊 history 一次性拿最新 50 条(`room_routes.js` /history 群聊分支),消息多了看不到更早的。

**后端已就绪**:`room_bus.getRecent(limit, beforeId, afterId)` 已支持 `beforeId` 向前翻 + `hasMore`,与私聊 `chat_history.getRecent` 对齐;前端 api 层 `getRoomHistory(roomId, limit, beforeId)`(`api/index.js:386`)也已存在;`roomStore` 预留了 `loadingHistory` 字段(roomStore.js:173)。**只差 store 补 hasMore + RoomChatPanel 接 scroll 监听**。

**改动**:
- `roomStore` chat 对象补 `hasMore: false` 字段(与私聊对齐)。
- `RoomChatPanel` 加 scroll 顶监听 + `loadMore`:- `scrollTop <= 阈值` → `getRoomHistory(roomId, limit, messages[0].id)`(`api/index.js:386`)→ prepend 到 messages、更新 hasMore。
- snapshot 时设 `hasMore`(initFromSnapshot 接收 hasMore,或订阅响应里带)。
- 这与私聊 `ChatPanel.handleScroll`/`loadMoreHistory` 同构,可基本复用思路。

**为什么不单独立项**:聚合本来就要动 `useRoomChat`/`RoomChatPanel`(去 EventSource、接聚合 dispatcher),顺手把上翻补上,避免二改。

---

## 5. 数据隔离分析(能否做到不串)

**能。隔离由 `roomId`/`roomType` 显式路由保证,不依赖连接归属:**

1. **后端注入、不删除**:聚合 broadcaster 对每条事件强制注入 `roomId`+`roomType`,私聊侧取消 `_stripRoomId` 的删除行为。事件不会"裸奔"无归属。
2. **前端按 roomId 严格分发**:`onEvent` 第一步取 `roomId`,只写进 `agentStore.chats.get(agentId)` 或 `roomStore.rooms.get(roomId)` 对应槽位,A 房事件不可能落进 B 房 store。
3. **snapshot 按 roomType 走不同 rebuild**:私聊 turns/activeTurn 与群聊 messages/members 用不同函数解析,shape 混淆不可能发生。
4. **鉴权边界(已定:当前单用户,不做 uid 隔离)**:代码现状是**单用户系统**(`gateway/config.js` 只有一个 `userUid='default_userid'`;`x-speaker-id` 只区分 user/agent 发言身份,非多用户认证;群聊 `members` 是 agent 成员)。故聚合方案**当前不做 uid 隔离、不改 roomId 命名**:
   - `AggregatedBroadcaster` 直接订阅「所有 running 私聊房 + 所有群聊房」(单用户下等价于该用户全部房)。
   - roomId 维持 `chat-<agentId>`,**不涉及 `profiles/rooms/` 历史目录迁移**,也不动 `_roomId` 各消费点。
   - 鉴权留简单占位(本地绑定/简单 token),等真多用户化时再上 uid 归属 + 收窄。
   - 现状 `/subscribe` 无鉴权(他人知道 agentId 即可订阅)这个口,留待多用户化一并堵。
5. **并发/顺序**:SSE 单连接内事件按到达顺序处理,同一房的事件天然保序;不同房事件交错不影响各自 store 一致性(各 store 独立)。

`notice` 是唯一跨房同构事件,但已定按房隔离入 per-room 队列、不再全局 toast(见 §4.8),不构成串扰。

---

## 6. 实施改动清单

### 后端

| 文件 | 改动 |
|---|---|
| `gateway/room_routes.js` | 新增 `POST /subscribe`;旧 `GET /rooms/:rid/subscribe` 保留(过渡期/调试)。动态 add/drop room 端点为二期,暂不做 |
| **新增** `gateway/aggregated_stream.js` | `AggregatedBroadcaster`(单用户,不做 uid 隔离):writeHead 后遍历每房发 snapshot chunk(带 roomType)+ `registerSubscriber`,事件由各 broadcaster 注入 `{roomId, roomType}` 后照常推送。**动态订阅**:监听 process_manager 的 agent 启停 + roomManager 的群聊创建/成员变动,新增房即时加进推送集合并补发该房 snapshot,停止/删除的房移除。维护 `res → sub 句柄` 反向索引,`res.on('close')` 主动全清 |
| `gateway/private_room_stream.js` | 取消 `_stripRoomId` 改为注入 `{roomId, roomType:'chat'}`;暴露 `registerPrivateSubscriber(roomId, res)`(只注册到 `_sseSubs`,不 writeHead)+ `removePrivateSubscriber` |
| `gateway/room_bus.js` | `RoomBroadcaster` 拆出 `buildSnapshotData()`(返 data 不 write)+ `registerSubscriber(res)`(只 push)+ `removeSubscriber(sub)`;`broadcast`/`notifyAll` 序列化前注入 `{roomId, roomType:'room'}`。旧 `subscribeSSE` 保留,内部调三步 |

### 前端

| 文件 | 改动 |
|---|---|
| **新增** `frontend/src/hooks/useAggregatedSubscription.js` | App 顶层调一次,fetch-SSE 连 `/subscribe`,onEvent 按 `roomType` 分发到 sseDispatcher / roomDispatch;2s 重连 |
| `frontend/src/api/index.js` | 新增 `subscribeAggregate({onEvent, signal})`,复用 143-184 的 fetch-SSE 解析骨架。`addRoom`/`dropRoom` 为二期,暂不加 |
| `frontend/src/hooks/useAgentSubscriptions.js` | 删除(或保留空壳),私聊订阅由聚合订阅接管 |
| `frontend/src/hooks/useRoomChat.js` | 去掉 `EventSource`;事件处理逻辑抽出为纯 `roomDispatch(roomId, event, data)` 供聚合 dispatcher 复用。切房纯前端换激活 roomId,不动 SSE |
| `frontend/src/components/RoomChatPanel.jsx` | 加 scroll 顶监听 + `loadMore`(滚到顶 → `getRoomHistory(roomId,{before})` prepend、更新 hasMore),与私聊 `ChatPanel.handleScroll` 同构(§4.9) |
| `frontend/src/stores/roomStore.js` | chat 对象补 `hasMore` 字段;`initFromSnapshot` 接收并写入 hasMore;新增 `loadMoreHistory(roomId)` 与私聊对齐 |
| `frontend/src/stores/sseDispatcher.js` | `handleSSEEvent` 入参的 agentId 改由调用方从 `data.roomId` 解析(逻辑零改动,只是 agentId 来源改了) |
| `frontend/src/App.jsx` | `useAgentSubscriptions` → `useAggregatedSubscription` |

### 不动

- `gateway/agent_events.js`、`process_manager.js` 的 agent /events 连接(gateway↔agent 不聚合,见 §3)。
- `sseDispatcher.js` 的 13 个 case 逻辑、`turn-stream-server.js`、`chat_history.js`(const 已修)。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 聚合端点单点:这条连接断了,所有房同时丢事件 | 沿用 2s 重连 + snapshot 全量对齐;断连窗口 ≤2s,影响等同当前"所有 SSE 同时断" |
| 聚合响应体体积:多房 snapshot 一次性下发较大 | snapshot 只在订阅/重连时发,且各房 30 条上限;可分帧逐房发,前端按 roomId 增量处理 |
| 聚合 res 跨多 broadcaster 持有,close 漏清泄漏 | 各 broadcaster 的 `_broadcast`/`broadcast` 已自带 `writable` 检查清死 res(兜底,不崩);聚合层额外维护反向索引 `res→sub`,close 主动全清(§6) |
| 私聊重连需 merge 保留 olderTurns | 按 `turn.id` 去重 + 按 `seq` 排序 prepend;`activeTurn` 由 snapshot 直接覆盖(optimistic local_ id 被真实版替代,内容不丢)。数据已具备,逻辑中等,风险低(§4.7) |
| 多用户化时鉴权空缺 | 当前单用户不做 uid 隔离(§5.4);现状 `/subscribe` 无鉴权的口留待多用户化一并堵 |
| 改动面跨前后端,需同步发布 | 旧 `GET /rooms/:rid/subscribe` 保留,前端可灰度切换;后端先上聚合端点,前端再切,可回滚到旧入口 |

### 回滚

保留旧 `GET /rooms/:rid/subscribe` 与 `useAgentSubscriptions`/`useRoomChat` 旧代码(注释而非删除),出问题直接前端切回旧入口,后端聚合端点闲置。**完全可回滚到当前状态**(含已修的 const bug)。

---

## 8. 已定决策(本轮确认收集)

1. ✅ **当前单用户,不做 uid 隔离**:`AggregatedBroadcaster` 订阅所有 running 私聊 + 所有群聊;roomId 维持 `chat-<agentId>`,不改名、不迁移(见 §5.4)。
2. ✅ **鉴权留占位**:聚合端点先不收窄,多用户化时再上 uid 过滤;现状 `/subscribe` 无鉴权的口留待那时堵。
3. ✅ **切房/切 agent 不动 SSE 连接**,前端只换渲染目标;不做动态 add/drop room,全量订阅(见 §4.2)。
4. ✅ **notice 按房隔离**:入 per-room 队列,只渲染激活房,切房才把积压的 notice 显示完再消失(见 §4.8)。
5. ✅ **私聊重连保持上翻**:snapshot 按 `turn.id` 去重 merge 保留 olderTurns,不回退(见 §4.7)。
6. ✅ **顺带补群聊上翻**:借聚合改动 `RoomChatPanel` 之机加上翻加载,后端已就绪、store 补 `hasMore`(见 §4.9)。

## 9. 仍待实施时定的小项

- notice 队列上限/超时丢弃策略(§4.8 可选)。
- 私聊 `notice` 字段是否够支撑「积压逐条展示」(attempt/maxRetries/error 已有,基本够)。
- 群聊上翻:snapshot 响应里 `hasMore` 怎么传到 initFromSnapshot(走聚合流的 snapshot data 还是单独字段)。
- 二期:动态 add/drop room(群聊数变多时再上)。

---

## 附:关键文件索引

- 前端私聊 SSE:`frontend/src/hooks/useAgentSubscriptions.js`、`frontend/src/api/index.js:143-184`、`frontend/src/stores/sseDispatcher.js`
- 前端群聊 SSE:`frontend/src/hooks/useRoomChat.js`、`frontend/src/components/RoomChatPanel.jsx:72`
- 后端统一路由:`gateway/room_routes.js:200-285`
- 后端私聊流:`gateway/private_room_stream.js`、`gateway/turn-stream-server.js`
- 后端群聊流:`gateway/room_bus.js`(RoomBroadcaster 40-197)
- gateway↔agent:`gateway/agent_events.js`、`gateway/process_manager.js:390-400`
- 事件契约工具:`shared/turn-stream-contract.js`