# Gateway/Room ↔ Agent/User 交互接口

> 当前实际接口清单（A/B 阶段已完成、C 阶段部分完成）。端口：Gateway=8080，私聊 agent=config.json 静态端口（8081/8082/8083），群聊副本=run.json 动态端口（如 65003/65005）。

## 一、Gateway 端口 8080 的路由

### 1. User → Gateway（私聊 `/agents/*`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/agents` | 列所有 agent + 状态 |
| POST | `/agents/rediscover` | 重扫 agents/ + 探活 |
| GET | `/agents/:id` | 单 agent 详情 |
| POST | `/agents/:id/start` · `stop` | 启/停私聊 agent |
| POST | `/agents/:id/abort` | 中断当前对话 |
| POST | `/agents/:id/chat` | 私聊对话（SSE 流式） |
| GET | `/agents/:id/subscribe` | 重连 SSE 流 |
| GET | `/agents/:id/sync-history` | 私聊缺失消息同步（seq 游标） |
| GET | `/agents/:id/history` | 聊天记录分页 |
| DELETE | `/agents/:id/history` | 清私聊记录 |
| DELETE | `/agents/:id/memory` | 清私聊记忆 |
| GET | `/agents/:id/checkpoints` | rewind 快照列表 |
| POST | `/agents/:id/rewind` | 回退到快照 |
| GET | `/agents/:id/config` · `config-ui` | 读配置 |
| PUT | `/agents/:id/config` | 改配置 |
| POST | `/agents/:id/avatar` · `user-avatar` | 头像上传 |
| GET | `/available-tools` · `/skills/*` | 工具/skill 管理 |
| GET · PUT | `/settings` | 全局设置（用户名/头像/uid） |
| PUT | `/settings/sidebar-order` | 侧栏排序 |
| POST | `/settings/avatar` | 用户头像文件 |
| POST | `/api/log` | 前端日志上报 |

### 2. User → Gateway（群聊 `/rooms/*`）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/rooms` | 建群 |
| GET | `/rooms` · `:rid` | 群列表 / 群详情（含成员运行态） |
| DELETE | `/rooms/:rid` | 解散群 |
| POST | `/rooms/:rid/members` | 加成员 |
| DELETE | `/rooms/:rid/members/:agentId` | 移除成员 |
| GET | `/rooms/:rid/history` | 群历史分页 |
| GET | `/rooms/:rid/sync-history/:agentId` | 副本缺失消息同步（seq 游标） |
| DELETE | `/rooms/:rid/history` | 清群记录 |
| POST | `/rooms/:rid/clear-memory` | 清各成员本群记忆 |
| POST | `/rooms/:rid/clear-all` | 清记录+记忆合一 |
| GET | `/rooms/:rid/subscribe` | **前端 SSE 订阅**（snapshot/speak/member_status） |
| POST | `/rooms/:rid/say` | **统一发言入口**（用户 + agent，见下） |
| POST | `/rooms/:rid/start-all` · `stop-all` | 启/停房间所有副本 |

### 3. 统一发言入口 POST /rooms/:rid/say

用户和 agent 共用一条接口，靠 `X-Speaker-Id` header 决定身份：

```
POST /rooms/:rid/say
  Headers: X-Speaker-Id: <user | agentId>
  Body: { content }
```

- `X-Speaker-Id` 缺失 / `'user'` → 用户发言，speakerUid = gateway.json 的 userUid
- `X-Speaker-Id` 是房间的成员 agentId → agent 发言，speakerUid = agentId
- 其它值 → 400 未知身份

**ID/Name 分离原则**：全链路只传 uid 作唯一标识，name 一律由 gateway 现查现改写。
- 落盘层（group-history.jsonl）：`speaker`=uid、`speakerUid`=uid、content 里 `@`=uid
- 发送层：SSE/observe 给消费方的 content `@`=name、speaker=name（前端/agent 收到的就是成品的 name 版）
- 前端 `/say` 带固定 `X-Speaker-Id: user`；agent Speak 工具带 `X-Speaker-Id: <memberName(=agentId)>`

## 二、Agent 副本端口（run.json 动态端口）端点

### 4. Gateway → Agent（群聊副本）

| 方法 | 路径 | 用途 | 调用方 |
|---|---|---|---|
| POST | `/observe` | **群消息推送** `{from,content,mentions,seq}` | `processRoomMessage` → `notifyAll` → `_broadcastToAgents` |
| POST | `/clear` | 清成员本群记忆 | `clear-memory` 路由 / 删盘兜底 |
| POST | `/shutdown` | 停副本 | `stopReplica` |
| POST | `/abort` | 中断当前 reasoning | （备用） |
| POST | `/reload` | 从 context.json 重新载 messages | rewind 后同步 |
| GET | `/status` | 探活 + runKey/mode/pid | `ensureReplicasAlive` / `probePort` |

### 5. Gateway → Agent（私聊，config.json 静态端口）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/chat` | 私聊对话转发（SSE 透传） |
| POST | `/abort` · `/clear` · `/reload` · `/shutdown` | 私聊控制 |
| GET | `/status` · `/config` | 探活 / 读配置 |
| GET | `/events` | SSE 长连接，收后台压缩等异步事件 |

## 三、消息流（核心闭环）

```
用户发言:
  User ──POST /rooms/:rid/say (X-Speaker-Id: user)──→ Gateway
    processRoomMessage(roomId, speakerUid, content):
      落盘: history.add(speaker=uid, content @=uid)
      发送: notifyAll →
        ├─ SSE 'speak' {speaker:name, speakerUid, content:name版} → 前端订阅者
        └─ POST /observe {from:uid, content:name版, mentions:uid[]} → 各副本 agent 端口
              agent 累积 buffer → 被@则 reasoning
              └─ 调 Speak → POST /rooms/:rid/say (X-Speaker-Id: agentId) → Gateway
                    processRoomMessage() → notifyAll → ……（循环，允许死循环）
```

**三类接口**：
- **入群消息入口**（User/Agent → Gateway）：统一 `/say`（`X-Speaker-Id` 区分身份）
- **下发前端**（Gateway → 前端）：`/rooms/:rid/subscribe`（SSE）
- **推送 agent**（Gateway → Agent）：`/observe`

## 四、统一订阅模型（已完成）

`processRoomMessage` 内 `RoomBroadcaster.notifyAll(event, data)` 统一通知：
- SSE 订阅者（前端）：`res.write()`
- Agent 订阅者（副本）：fire-and-forget `POST /observe`，失败触发 `onAgentOffline`

副本生命周期由 `RoomManager` 自动同步订阅：
- `spawnReplica` 成功 → `broadcaster.subscribeAgent(agentId, port)`
- `stopReplica` → `broadcaster.unsubscribeAgent(agentId)`
- `ensureReplicasAlive` re-discover 存活 → 同步订阅

调用方（`/say` 路由）无需感知消息如何下发。

## 五、ID/Name 分离（C 阶段完成）

**原则：uid 作唯一标识（落盘、过滤、去重、路由），name 作显示首选（gateway 现查现改写，不固化）。**

落盘层（group-history.jsonl）：
- `speaker` = uid、`speakerUid` = uid
- `content` 里的 `@` 统一存 uid（用户输入 `@name` 也归一成 `@uid` 落盘）

发送层（gateway 发给前端/agent 前，统一改写 uid→name）：
- `RoomManager.rewriteMentions(content, members, user, 'name')` —— content 里 `@uid` 改成 `@name`
- `RoomManager._speakerName(uid, ...)` —— uid 改成 name
- 4 个发送环节都用 `_renderMessageForSend` 渲染：SSE speak 事件、`/observe` body、`GET /history`、`GET /sync-history`、`GET /subscribe` snapshot

消费层简化：
- 前端不再做 id→name 改写（gateway 已改写），按 `speakerUid` 查 memberMap 取 avatar，`speaker`(name) 直接显示
- agent `/observe` 的 `from`=uid（自消息过滤 `from === memberName(uid)` 靠 uid，name 改名不影响过滤），`_parse` 用 `_agentNames` 映射 uid→name 拼前缀