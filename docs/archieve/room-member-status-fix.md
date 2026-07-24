# 群聊成员在线状态修复方案

> 问题：侧栏群聊成员的在线状态用的是私聊 `agent.status`（agent 进程状态），而非群聊
> 副本的运行状态（`RoomManager` 维护的 `MEMBER_STATUS`）。群聊副本启动/停止时，侧栏
> 状态不更新。
> 状态：方案待评审。

---

## 0. 现状链路追踪

### 0.1 侧栏渲染群聊内容

**侧栏群聊成员渲染**（`Sidebar.jsx:300-314`）目前**不显示**每个成员——只显示群名和人数。群聊成员列表在**聊天面板**里显示（`RoomChat` 组件，非侧栏）。

但侧栏里的 agent 条目（`agent.status === 'running' ? '运行中' : '已停止'`）显示的是
**私聊 agent 进程状态**（来自 `ProcessManager.probeAgent` 的端口探活）。群聊副本不占用
agent 自身端口（副本有独立端口），所以群聊副本的在线状态不反映在 agent.status 上。

### 0.2 `listRooms` vs `getRoom` 的成员数据差异

**`RoomManager.listRooms()`**（`room_bus.js:640-651`）：
```js
// 返回 members 为纯 agentId 字符串数组（无状态字段）
result.push({ roomId, name, members: cfg.members, createdAt: cfg.createdAt });
```

**`RoomManager.getRoom()`**（`room_bus.js:628-637`）：
```js
// 返回 members 为对象数组，含 status / port / name / avatar
const members = cfg.members.map(agentId => {
  const m = room.members.get(agentId);
  return { agentId, name: ..., avatar: ..., status: m?.status || MEMBER_STATUS.OFFLINE, port: m?.port || null };
});
return { roomId, name, members, createdAt };
```

`listRooms` 读的是磁盘 `config.json`（静态数据，只有 `members: [agentId, ...]` 字符串数组）。
`getRoom` 读的是内存 `room.members` Map（运行时数据，包含 `status / port / pid`）。

### 0.3 SSE 成员状态变更通道

`broadcastObserve` 失败时标 offline（`room_bus.js:808`），但**没有专门推给前端的 SSE 事件**来通知成员状态变更。当前状态变更检测在 `ensureReplicasAlive` 里做，也没有专推前端。

---

## 1. 方案

### 1.1 `listRooms` 返回成员的在线状态

**修改 `RoomManager.listRooms()`**，使其返回的 `members` 格式与 `getRoom()` 一致。
每次列表请求时读一次 `room.members` Map（已在内存中），返回 `{agentId, name, status}` 对象数组。

```js
// room_bus.js listRooms() 改为：
listRooms() {
  if (!fs.existsSync(this.roomsDir)) return [];
  const ids = fs.readdirSync(this.roomsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  const result = [];
  for (const roomId of ids) {
    const cfg = new RoomConfig(this.roomsDir, roomId).read();
    if (!cfg) continue;
    const room = this._ensureRoom(roomId);
    // ★ 改：members 返回含 status 的对象数组，对齐 getRoom 格式
    const members = cfg.members.map(agentId => {
      const m = room.members.get(agentId);
      return {
        agentId,
        name: this._readAgentName(agentId),
        avatar: this._readAgentAvatar(agentId),
        status: m?.status || MEMBER_STATUS.OFFLINE,
      };
    });
    result.push({ roomId, name: cfg.name, members, createdAt: cfg.createdAt });
  }
  return result;
}
```

### 1.2 前端侧栏区分群聊状态标签文案

侧栏群聊条目目前只显示"X 人"，不显示每个成员的单独状态。如果需要像私聊那样显示"在线 / 离线"：

- 群聊列表不支持展开成员 → **不需要改侧栏**
- 如果未来需要，可在群聊条目的副标题（`styles.path`）里显示"3/5 在线"之类

**结论：侧栏不改**。前端聊天面板已从 `roomChats.members` 读成员状态（`roomStore.loadRoomMembers` → `api.getRoom`），
这个接口 `getRoom` 本身已经正确返回成员状态，所以聊天面板的成员状态显示是正确的。

### 1.3 SSE 推送成员状态变更

**当前缺失**：成员副本 offline/online 时没有推给前端，前端需要**定期轮询** `loadRoomMembers` 或**刷页面**才能看到状态变化。

**加入 SSE 事件 `room_member_status`**：
当 `RoomManager` 中某成员的 `status` 变更时（`ensureReplicasAlive` 的重拉/死掉），
通过 `RoomBroadcaster` 把这个事件广播给房间的所有 SSE subscribe 连接，前端 `roomStore.updateMemberStatus` 处理。

`RoomManager._onMemberStatusChange(roomId, agentId, newStatus)` 钩子：
```js
// 在 ensureReplicasAlive() 中状态变更时调
// 在 broadcastObserve() 失败标 offline 时调
// 在 startReplica() 成功启动后调
this._onMemberStatusChange(roomId, agentId, status);
```

`_onMemberStatusChange` 实现：
```js
_onMemberStatusChange(roomId, agentId, status) {
  const room = this._ensureRoom(roomId);
  room.broadcaster.broadcast({
    event: 'room_member_status',
    data: { roomId, agentId, status },
  });
}
```

前端 `roomStore` 已在 SSE subscribe 的 onEvent 里处理 `room_member_status`（需要用
`updateMemberStatus`），这一步只是补上后端推送。

### 1.4 前端 roomStore 已有能力

`roomStore.js:145` 已有 `updateMemberStatus(roomId, agentId, status)` 方法，只需后端 SSE 推对应事件。

但当前 frontend 订阅组 SSE 事件的 `onEvent` 回调中是否注册了 `room_member_status` → `updateMemberStatus`？需确认。

---

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `gateway/room_bus.js` | `listRooms()` 返回成员含 `status` 字段；`ensureReplicasAlive` 和 `broadcastObserve` 中状态变更时调 `_onMemberStatusChange` 推送 SSE；新增 `_onMemberStatusChange` 方法 |
| 前端 `roomStore.js` 或 ChatPanel | 确认 SSE `room_member_status` 事件已映射到 `updateMemberStatus` |
| `gateway/server.js` | **不动**（`/agents` 路由返回的是私聊 agent 进程状态，群聊成员状态由 `/rooms` 独立返回） |

---

## 3. 排优先级

1. **`listRooms` 补状态字段** —— 前端 GET /rooms 后 `room.members[].status` 就对了
2. **SSE 推送** —— 副本状态变更时自动推到前端，不再需要轮询