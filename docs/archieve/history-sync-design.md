# 群聊消息历史同步方案

## Context

### 问题

群聊 room 副本进程死亡后重启，死亡期间到达的所有消息永久丢失。根因有两层：

1. **送达不可靠**：`RoomManager.broadcastObserve` 是 fire-and-forget，进程不在时 POST 失败，无重试、无重放队列
2. **内存不持久**：`RoomAgent._buffer` 是纯内存数组，即使消息送达了，进程重启后也全丢 —— buffer 里囤的非 @ 消息从不写入 `context.json`

实际案例：elf-001 的 room 副本进程莫名死亡，重启后 context.json 里只有自己发言的记录，elf-003 说的一切都不存在。

```
04:21:14  副本启动 → port 59479
04:21:42  elf-001 Speak 回复(被@)
          ← 进程在此时间窗口死亡，日志空白 27 分钟
04:22:36  用户 @长夜月 → /observe 发往 59479 → 进程不在 → fetch 失败
04:23:25  elf-003 长篇 Speak → member-said → broadcastObserve → 59479 → 失败
04:48:38  gateway 重拉副本 → port 60614 → context.json 里无 elf-003 发言 → 下次被@时说"长夜月说了什么？"
```

### 为什么只做群聊

私聊 agent 的 `MessageManager` 是 eager persistence：每条 user/assistant/tool 消息立即 `fs.writeFileSync` 到 `context.json`。进程死亡后重启，`context.json` 磁盘仍在，消息不丢。

而群聊的问题是 buffer 囤积的非 @ 消息根本没写盘。私聊的 `history.jsonl` 仅是前端的显示层历史，跟 agent 内部记忆已是两份独立存储。所以本方案聚焦群聊。

### 预期效果

- room 副本重启后，自动从 gateway 同步缺失消息
- 缺失消息通过 `RoomAgent.receive()` 正常处理（进 buffer，被 @ 则触发 reasoning）
- 已处理过的消息不重复处理（基于 cursor 去重）
- 同步在 `app.listen()` 之前完成，无并发竞态

---

## 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│ Gateway                                                      │
│   group-history.jsonl ─── canonical source of truth          │
│   GET /rooms/:rid/sync-history/:agentId ─── new endpoint     │
└─────────────────────┬────────────────────────────────────────┘
                      │ agent calls on startup (before listen)
                      ▼
┌──────────────────────────────────────────────────────────────┐
│ Agent (start.js)                                             │
│   1. Agent.fromConfigDir() → RoomAgent 升级                   │
│   2. agent.syncMissingHistory()                               │
│      └─ GET sync-history → 每条 msg → RoomAgent.receive()    │
│   3. createAgentServer() → app.listen()                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 一、Cursor 机制

### 设计

新增文件 `sync_cursor.json`，与 `context.json` 同目录：

**群聊路径**：`rooms/<rid>/data/<agentId>/sync_cursor.json`
**私聊路径**（预留）：`agents/<id>/data/sync_cursor.json`

```json
{
  "lastId": "rmsg_1784348605713_b2f6",
  "lastTs": "2026-07-18T04:23:25.714Z"
}
```

### 更新时机

cursor 在 **buffer flush 时** 更新（即消息被写入 context.json 的时刻），而非收到消息时。这样：

- 如果 agent 在积攒 buffer 期间崩溃，未 flush 的消息的 cursor 不会前进 → 重启后 replay ✅
- cursor 跳步不逐条 —— flush 一次性 join 多条 buffer 消息为一条 user message，cursor 跳到这批里最大的 `historyId`
- 已 flush 的不会重复 —— cursor 已前进过 ✅

### 首次启动种子

新副本首次启动无 cursor 文件 → 调 `GET /rooms/:rid/sync-history/:agentId?seed=true`

不 replay 全部历史（可能几百条），而是只取 `latestId` 作为 cursor 起点：
- **含义**："我承认我也是这些对话历史的一部分，之前一切都已算作已知"
- 后续新消息才会触发同步

这种策略可行，因为首次启动时，这个 room 副本确实刚刚被创建——在此之前的历史它参与过（如果是重加入），但 context.json 是最新构建的。

---

## 二、Gateway 同步端点

### `GET /rooms/:rid/sync-history/:agentId`

**文件**：`gateway/room_routes.js`

| 参数 | 类型 | 说明 |
|------|------|------|
| `after` | string | 游标，返回该 ID **之后**的消息 |
| `seed` | string | `"true"` 时仅返回 `latestId`，不返回 messages |
| `limit` | number | 每批条数，默认 100，最大 200 |

**实现**：复用 `RoomHistory.getRecent(limit, null, afterId)`

**响应**：
```json
{
  "messages": [
    {
      "id": "rmsg_xxx",
      "speaker": "elf-003",
      "content": "消息文本",
      "event": "speak",
      "ts": "2026-07-18T04:23:25.714Z",
      "speakerUid": "elf-003"
    }
  ],
  "hasMore": false,
  "latestId": "rmsg_yyy"
}
```

- `hasMore`：是否有更多消息（分页用）
- `latestId`：文件中最新的消息 ID（cursor 种子用）
- 返回全部消息包括 self-message，由 RoomAgent 的自消息过滤丢弃

### 私聊（预留）

`GET /agents/:id/sync-history`（通过 `gateway/server.js`），使用 `ChatHistory.getRecent`，当前不启用（私聊不需要）。

---

## 三、新增文件：`shared/agent/sync_cursor.js`

```javascript
import fs from 'fs';
import path from 'path';

export class SyncCursor {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'sync_cursor.json');
    this._cursor = null;  // { lastId: string, lastTs: string }
    this._load();
  }

  get() { return this._cursor ? this._cursor.lastId : null; }

  advance(id) {
    this._cursor = { lastId: id, lastTs: new Date().toISOString() };
    this._save();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this._cursor = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch (e) { this._cursor = null; }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this._cursor, null, 2), 'utf-8');
    } catch (e) { /* 非致命 */ }
  }
}
```

---

## 四、RoomAgent 改动

**文件**：`shared/agent/room_agent.js`

### 4.1 状态字段

```javascript
// 新增字段（惰性初始化，因为 setPrototypeOf 不跑构造器）
this._syncCursor = null;       // SyncCursor 实例
this._maxBufferedHistoryId = null; // buffer 中最新的 historyId
```

在 `_ensureBufferState()` 或新增的 `_ensureSyncState()` 中惰性初始化。

### 4.2 receive() 中加入 cursor 追踪

```javascript
// 在 _normalizePayload 之后，_buffer.push 之后，加入：
this._applyHistoryId(payload);

// 方法定义：
_applyHistoryId(payload) {
  if (payload?.historyId) {
    this._maxBufferedHistoryId = this._maxBufferedHistoryId
      ? (payload.historyId > this._maxBufferedHistoryId ? payload.historyId : this._maxBufferedHistoryId)
      : payload.historyId;
  }
}
```

在 buffer flush 时（`addUserMessage(merged)` 之后）：
```javascript
if (this._maxBufferedHistoryId && this._syncCursor) {
  this._syncCursor.advance(this._maxBufferedHistoryId);
  this._maxBufferedHistoryId = null;
}
```

### 4.3 syncMissingHistory() 方法

```javascript
async syncMissingHistory() {
  const rc = this.runContext;
  if (!rc || rc.mode !== 'room' || !rc.roomBusUrl) return;

  this._ensureBufferState();
  if (!this._syncCursor) return;

  const cursor = this._syncCursor.get();
  const syncUrl = `${rc.roomBusUrl}/sync-history/${rc.agentId}`;

  // 首次启动：只种子 cursor，不 replay
  if (!cursor) {
    const resp = await fetch(`${syncUrl}?seed=true`);
    if (resp.ok) {
      const { latestId } = await resp.json();
      if (latestId) this._syncCursor.advance(latestId);
    }
    return;
  }

  // 回放缺失消息
  const resp = await fetch(`${syncUrl}?after=${cursor}`);
  if (!resp.ok) return;
  const { messages } = await resp.json();
  if (!messages || messages.length === 0) return;

  for (const msg of messages) {
    const payload = {
      from: msg.speaker,
      content: msg.content,
      mentions: [],     // RoomAgent.receive 会自己算：_normalizePayload → _refreshRoster
      role: 'chat',
      historyId: msg.id,
    };
    for await (const _evt of this.receive(payload)) {
      // swallow — 同步回放的事件不上报前端
    }
  }
}
```

**关键设计决策**：
- `mentions` 传空数组 —— 因为 `RoomAgent.receive()` 会先调 `_refreshRoster()` 再调 `_normalizePayload(payload)`，而 `_normalizePayload` 读的是 `payload.mentions`。这里需要改：让 `_normalizePayload` 或者 receive 中，在 `mentions` 为空时自行计算。更简洁的方案是 reference：sync 回的 `msg.speaker` 就是 speaker，无需 gateway 侧预解析 mentions。agent 侧在 sync 时额外调 roster 拿成员列表，本地 parseMentions。
- 或者更简单：**在 gateway sync 端点返回的每个 message 中就带上 `mentions`**（因为 gateway 已经有 roster 信息）。这样 agent 侧零改动。

### 4.4 方案修正：Gateway 侧解析 mentions

`RoomManager.parseMentions` 是静态方法，gateway sync 端点可以调用它。

在 `gateway/room_routes.js` sync 路由中：
```javascript
// 获取成员列表用于 parseMentions
const room = roomManager.getRoom(rid);
const membersWithNames = room.members.map(m => ({ agentId: m.agentId, name: m.name }));
for (const m of messages) {
  m.mentions = RoomManager.parseMentions(m.content, membersWithNames);
}
```

这样 agent 侧的 `RoomAgent.receive()` 完全不需要改 — `_normalizePayload` 直接拿到 `mentions` 数组。

---

## 五、start.js 改动

**文件**：`shared/agent/start.js`

在 RoomAgent 升级之后、server 创建之前插入同步：

```javascript
// 群聊模式：升级 RoomAgent + 注册 Speak
if (runContext.mode === 'room') {
  Object.setPrototypeOf(agent, RoomAgent.prototype);
  agent.toolRegistry.register(Speak);

  // 同步缺失消息
  try {
    await agent.syncMissingHistory();
  } catch (err) {
    logger.warn(`历史同步失败 (非致命): ${err.message}`);
  }
}

// 启动 HTTP 服务
const app = createAgentServer(agent, agent.config);
const server = app.listen(port, ...);
```

同步在 `app.listen()` 之前 → 零并发竞态。

---

## 六、gateway 重启的竞态处理

gateway 和 room 副本可能同时重启。此时 `roomBusUrl` 指向的 gateway 可能还没就绪。

`syncMissingHistory` 中对 `fetch(syncUrl)` 加指数退避重试：

```javascript
// 重试逻辑（伪代码）
const maxRetries = 5;
const baseDelay = 1000;
for (let attempt = 0; attempt < maxRetries; attempt++) {
  try {
    const resp = await fetch(syncUrl, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) break;
  } catch (err) {
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
}
```

但更干净的做法：**把重试放到 `start.js` 调用处**，失败只是 `logger.warn`，agent 继续运行（只是这次启动少了上下文）。下次被 @ 时的 buffer 可能不完整，但不影响核心功能。

---

## 七、实现步骤

| 步骤 | 文件 | 改动 |
|------|------|------|
| 1 | `shared/agent/sync_cursor.js` | **新建** SyncCursor 类 |
| 2 | `gateway/room_routes.js` | **新增** `GET /rooms/:rid/sync-history/:agentId` |
| 3 | `shared/agent/room_agent.js` | **新增** `_syncCursor`、`_maxBufferedHistoryId`、`_applyHistoryId()`、`syncMissingHistory()`；在 buffer flush 时 `advance` cursor |
| 4 | `shared/agent/start.js` | RoomAgent 升级后调用 `agent.syncMissingHistory()` |
| 5 | `gateway/room_routes.js` | `member-said` 和 `send` 路由中传 `historyId`（rec.id）给 `broadcastObserve` |
| 6 | `gateway/room_bus.js` | `broadcastObserve` 接收并转发 `historyId` 参数 |
| 7 | `shared/agent/server.js` | `/observe` 提取 `historyId` 并透传进 payload |

---

## 八、验证

1. **正常流程**：建群 → 发几条消息 → 杀 elf-001 副本 → 再发 → 重拉 → 检查 context.json 包含缺失消息、被 @ 的正确回复
2. **Gateway 重启**：全停 → 重启 gateway → subscribe room → 确认 agent 同步后 context 完整
3. **自消息过滤**：确认同步带回的 agent 自己的历史发言被正确丢弃
4. **Cursor 持久化**：分批同步中途模拟重启 → cursor 位置正确
5. **单元测试**：`test/sync_cursor.test.js`、扩展 `test/room_routes.test.js`、扩展 `test/room_agent.test.js`