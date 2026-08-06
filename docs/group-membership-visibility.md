# 群成员制可见性（后续实现）

## 状态

**设计文档，未实现。** 列入后续迭代；实现前需与私聊实例用户自治（`docs/current_promblem.md` 第 7 条）一并回归。

## 1. 现状与问题

当前群聊对**所有注册用户可见**：

- `GET /rooms`（`gateway/room_routes.js`）返回全部群，不区分请求者是否成员；
- `GET /rooms/:rid`、`/rooms/:rid/subscribe`、`/rooms/:rid/history`、`/rooms/:rid/say` 均只校验"登录"（admin 额外管建群/成员管理/解散），**不校验群成员身份**；
- 前端 `Sidebar` 群聊区段列出所有群（`useRoomStore.loadRooms`）。

问题：任何注册用户都能看到/进入/发言于任何群，无法表达"这个群是某几个用户 + 某几个 agent 的私密会话空间"。

## 2. 目标

- 群 = 成员制会话空间：成员 = 若干注册用户（uid）+ 若干 agent（agentId）。
- **只有群成员用户**能看到该群（列表）、进入（subscribe/history）、发言（say）。
- agent 成员不变（仍是成员的一部分）；群对 agent 的可见性维持现状（Speak 回调仍走内部服务 token）。
- 管理员默认对所有群可见（可进入/管理），与"超级管理员完全控制"语义一致。

## 3. 数据模型

### 3.1 room.json 增加用户成员

现 `profiles/rooms/<rid>/room.json` 存 `{ name, members: [agentId...], createdAt, ... }`。

增加用户成员字段（向后兼容：老群无该字段 = 仅管理员可见，或默认全员可见——实现时定）：

```jsonc
{
  "name": "群名",
  "members": ["elf-001", "elf-018"],        // agent 成员（不变）
  "userMembers": ["u_17aa7451947e"],        // 用户成员（新）
  "createdBy": "u_17aa7451947e",            // 建群者（新，可选）
  "createdAt": "..."
}
```

### 3.2 语义

- `userMembers` 为空数组且无 `createdBy` 的老群：迁移策略二选一（实现时定）：
  1. 视为"仅管理员可见"（收紧，符合成员制）；
  2. 视为"全员可见"（宽松，老数据不破坏）。
- 建群时 `createdBy` = 当前用户 uid，`userMembers` 至少含建群者自己（admin 建群也可加自己）。

## 4. 接口改动

| 端点 | 改动 |
|---|---|
| `GET /rooms` | 只返回当前用户是成员的群（admin 返回全部） |
| `GET /rooms/:rid` | 非成员 → 403（admin 放行） |
| `GET /rooms/:rid/subscribe` | 非成员 → 403（admin 放行） |
| `GET /rooms/:rid/history` | 非成员 → 403（admin 放行） |
| `POST /rooms/:rid/say` | 非成员用户 → 403（admin 放行）；agent 发言（内部 token）维持现状 |
| `POST /rooms` | 建群请求体加 `userMembers?: [uid]`（可选，默认只含自己）；仅 admin 或开放给所有用户建群（实现时定） |
| `POST /rooms/:rid/members` | 加成员请求体区分 `{ agentId }` 与 `{ userUid }`（或拆两个端点），仅 admin |
| 新增 `DELETE /rooms/:rid/user-members/:uid` | 移除用户成员，仅 admin |
| `GET /rooms/:rid` 返回 | 附带 `userMembers` 供前端渲染/判断 |

## 5. 服务端校验点

- 新增 helper：`isRoomUserMember(room, uid)` + `requireRoomMember` 中间件（`req.user.role === 'admin'` 直接放行）。
- 挂在所有 `checkRoomExists` 之后的群路由（`room_routes.js` 群分支），**私聊房 chat-<uid>-<id> 不涉及**（私聊已有房主校验）。

## 6. 前端改动

- `useRoomStore.loadRooms` 直接消费后端过滤后的列表（无需前端过滤）。
- `Sidebar` 群聊区段：非成员看不到（后端已过滤），无需额外处理。
- 群配置面板（`RoomConfigDrawer`）：加"用户成员"管理（admin），列表 + 添加/移除。
- `CreateRoomModal`：可选加"邀请用户"选择器（多用户目录 `getUserDirectory` 已有）。

## 7. 联动影响

- `RoomManager._rosterForRewrite`：群消息 uid→name 改写已走用户目录，不依赖成员制，无需改。
- 聚合 SSE（`aggregated_stream._currentRooms`）：目前所有群都订阅；成员制后**只订阅当前用户是成员的群**（否则非成员也会收到他人群的 snapshot/事件）。
- 私聊实例用户自治（`docs/current_promblem.md` 第 7 条）与本文档无冲突：私聊用户自治是"用户-单 agent"维度，群成员制是"群维度"。

## 8. 测试

- 新增/扩展 `test/room_routes.test.js`：
  - 非成员 `GET /rooms/:rid` → 403；
  - 成员/管理员 → 200；
  - `GET /rooms` 按成员过滤；
  - 非成员 `say` → 403；
  - 加/移除用户成员后可见性即时变化。
- 聚合 SSE 订阅过滤单测（`aggregated_stream` 的 `_currentRooms` 注入 userMembers 判断）。

## 9. 待定项

- 老群迁移策略（仅管理员 vs 全员可见）；
- 是否开放所有用户建群（现仅 admin）；
- 用户成员上限、建群邀请交互细节。
