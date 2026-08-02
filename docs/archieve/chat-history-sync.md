# 消息同步统一模型

## 核心原则

Gateway 是消息的唯一真实来源。所有消息先写 history（持久化），再转发 agent。Agent 通过"我收到的最新一条 ID"跟 gateway 对比，发现空洞就补。

---

## 消息生命周期

```
每一步都有落盘
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. 用户在前端输入 → POST gateway                             │
│    gateway 立即写 history（持久化），消息从此不会丢           │
├─────────────────────────────────────────────────────────────┤
│ 2. gateway → agent                                          │
│    每次请求 body 带 latestId（当前 history 最新记录 ID）      │
├─────────────────────────────────────────────────────────────┤
│ 3. agent receive                                            │
│    normalize → 进 buffer → gap 检测（latestId vs _lastSeqId）│
│    → _shouldFlush? 决定是否触发 reasoning                    │
│    → flush 时 addUserMessage → advanceCursor                │
├─────────────────────────────────────────────────────────────┤
│ 4. agent 重启                                               │
│    cursor 恢复 _lastSeqId → sync 补缺失 → replay            │
└─────────────────────────────────────────────────────────────┘
```

---

## 私聊与群聊的统一

两者共用同一个 receive 管道，唯一的差异是 flush 条件：

```
receive(payload)
  │
  ├─ normalize → {text, historyId, latestId, mentionedMe}
  ├─ _buffer.push(text)
  ├─ 更新 _maxHistoryId
  ├─ gap 检测: latestId > _cursor.get() → syncMissingHistory()
  │
  └─ _shouldFlush() ?
       ├─ 私聊: buffer.length > 0 && !_replying → 立刻 flush
       └─ 群聊: _bufferHasMention && !_replying → 被 @ 才 flush
              │
           是 → flush
              _buffer.join('\n') → addUserMessage → advanceCursor → reasoning
```

行为完全不改：

| | 私聊 | 群聊 |
|---|---|---|
| 收到消息后 | 立刻回复（buffer 有 1 条就 flush） | 攒着，被 @ 了才把 buffer 全吐出来 |
| 回复期间来的消息 | 排队在 server 队列，等回复完再进 receive | 进 buffer + 等回复完再判 @ |
| 前端回复中禁止输入 | 保留 422 guard | 无影响 |

---

## 两种丢失场景

| 场景 | 检测方式 |
|------|---------|
| agent 离线 / 崩溃重启 | cursor 恢复 → GET /sync-history?after=<cursor> → replay |
| 运行时网络丢包 | 下一条消息的 latestId > cursor → 立刻触发 sync |

---

## 私聊离线排队

```
POST /agents/:id/chat
  agent 不在线 → 写 history.jsonl → 202 {"status":"queued"}
  agent 在线且空闲 → 正常 proxyChat
  agent 在线但回复中 → 422 "正在回复中"（不变）
```

---

## gateway 端点

| 端点 | 用途 |
|------|------|
| `GET /rooms/:rid/sync-history/:agentId?after=&seed=` | 群聊 sync |
| `GET /agents/:id/sync-history?after=&seed=` | 私聊 sync |

---

## cursor 文件

同一个 `SyncCursor` 类，存两处：

| | 路径 | 对应 history |
|---|---|---|
| 群聊 | `rooms/<rid>/data/<agentId>/sync_cursor.json` | group-history.jsonl |
| 私聊 | `agents/<id>/data/sync_cursor.json` | history.jsonl |

字段 `lastSeqId`（兼容老文件 `lastId`）。

只在 flush 后推进。

---

## 示例：群聊 gap 检测

```
rmsg_001  wolfgod: @大黑塔              → elf-001 收到, cursor=001
rmsg_002  elf-001 Speak: 来了            → 自消息过滤
rmsg_003  长夜月: 说一下                 → /observe 丢包
rmsg_004  wolfgod: @大黑塔 (latestId=004) → 004 > cursor(001) → sync
  GET /sync-history?after=001 → 002,003,004
  replay → 002 过滤, 003 进 buffer, 004 @ → flush ✅
```

---

## 文件改动清单

### gateway 侧

| 文件 | 改动 |
|------|------|
| `gateway/room_bus.js` | broadcastObserve body 加 `latestId` |
| `gateway/server.js` | 私聊 503→202 + 写 history；新增 `GET /agents/:id/sync-history` |
| `gateway/process_manager.js` | spawn 私聊 agent 传 `--gateway-port` |

### agent 侧

| 文件 | 改动 |
|------|------|
| `shared/agent/default_agent.js` | `receive` 改造为 buffer 模式；`_shouldFlush` 返回 `buffer.length > 0`；新增 `syncPrivateHistory` |
| `shared/agent/room_agent.js` | `_shouldFlush` 返回 `_bufferHasMention`；`_lastSeqId` + gap 检测；继承 buffer 父类逻辑 |
| `shared/agent/start.js` | `--gateway-port`；私聊/群聊统一调 sync |
| `shared/agent/server.js` | /observe 透传 `latestId` |
| `shared/agent/sync_cursor.js` | `lastId` → `lastSeqId`（兼容老文件） |