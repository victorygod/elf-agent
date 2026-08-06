# 多用户账户登陆与权限管理设计

## 目标

1. gateway 支持多用户注册/登录，身份验证用请求头 token
2. 私聊历史、agent 私聊记忆按用户隔离
3. 群聊所有用户共享同一份历史
4. 同用户多设备同时在线，消息广播到所有设备
5. 权限分级：超级管理员（完全控制） vs 访客（只读配置 + 自控实例启停）

---

## 鉴权方案

- **协议**：JWT（JSON Web Token，无状态，API-friendly）
- **密码**：bcrypt 加密存储
- **token 有效期**：access_token 7 天 + refresh_token 30 天（业界常规做法）
- **传输**：每次请求 `Authorization: Bearer <token>` 头
- **用户存储**：`profiles/users/<uid>/user.json`

```
profiles/users/<uid>/
  user.json          # { uid, username, passwordHash, userName, userAvatar, role, sidebarOrder, createdAt }
  avatar.<ext>       # 用户头像文件
```

### 两类调用方：用户 JWT + 内部服务凭证

gateway 的调用方有两类，鉴权方式不同：

| 调用方 | 端点 | 凭证 |
|--------|------|------|
| 浏览器（用户） | 全部 | 用户 JWT |
| agent-server（机器） | `GET /rooms/:rid/sync-history/:agentId`（PrivateChatPlugin 同步）、`POST /rooms/:rid/say`（Speak 工具，X-Speaker-Id=agentId）、`POST /rooms/:rid/notice` | 内部服务 token |

内部服务 token：gateway 启动时生成随机串（或落 `gateway.json` 持久），spawn agent-server 时经 env `ELF_INTERNAL_TOKEN` 传入。鉴权中间件收到 `Authorization: Bearer <token>` 时：
1. 等于内部 token → `req.service = true`（机器身份，仅限上述 agent 回调端点）
2. 否则按用户 JWT 验证 → `req.user = { uid, role, ... }`
3. 都失败 → 401

路由层再做细判：如 `/say` 当 `X-Speaker-Id` 为 agentId 时要求 `req.service`，为 user 时要求 `req.user` 且 uid 与身份一致。

### 免鉴权路径

`<img>` 标签无法带 Authorization 头，以下路径保持公开：
- 前端静态资源（`frontend/dist`）
- agent 头像（`/agents/:id/config/avatar.webp` 等静态文件）
- 用户头像（`/profiles/users/<uid>/avatar.<ext>` 或现有 `/uploads/*`）

头像非敏感数据，公开风险可接受（业界惯例：头像 CDN 也多公开）。

### 鉴权中间件的覆盖方式

在 `express.json()` 之后立即挂全局中间件，**其下所有路由自动被保护**，包括 plugin-loader 动态注册的 agent 专属路由（`agents/{id}/ui/api.js`）。白名单（`/auth/*`、静态资源、uploads）在中间件内跳过。

---

## 权限模型

### 角色定义

| 角色 | 能力 |
|------|------|
| **超级管理员** | 拥有当前全部功能：任意修改 config、全局启停 agent、清记忆、管理 skill、上传头像等 |
| **访客** | ① config 面板只读 ② 启动/停止自己与某 agent 的私聊实例 ③ 清空自己与某 agent 的私聊记忆 ④ 群聊发言 |

### 配置只读范围

访客打开 config 面板时，所有表单控件均 disabled，仅能查看。保存/提交按钮隐藏或不可点击。具体包括：
- 系统提示词
- 模型配置（base_url、auth_token、model name）
- 工具开关
- 各类 agent 专属配置项

### 实例模型：三层架构

单用户时代，"agent 实例" = agent 的私聊（因为只有 1 个用户）。多用户后需要拆成三层：

| 层级 | 谁控制 | 含义 |
|------|--------|------|
| **共享 agent-server 进程** | 超级管理员启停 | 承载所有 agent 的进程（端口 8180），停了谁也聊不了 |
| **agent 全局可用性** | 超级管理员 | 该 agent 是否对全平台开放 |
| **用户级私聊 room** | 各用户自控 | `chat-<uid>-<agentId>` 是否对该用户激活 |

当前代码的结构：

```
ProcessManager.agents = Map<agentId, { status }>    ← 全局 agent 状态
startAgent(elf-018) → status = 'running'            ← 所有人能用私聊
/say 检查：pm.getAgentStatus(agentId) === 'running'   ← 全局检查
```

多用户后需要变成：

```
ServerManager.server = { status, port }               ← 共享进程（超级管理员管）
AgentRegistry.agents = Map<agentId, { enabled }>       ← 全局 agent 开关（超级管理员管）
UserRoomRegistry: Map<uid, Map<agentId, { enabled }>>  ← 用户级私聊 room（各人管自己的）
/say 检查：agent 全局 enabled + 自己 room enabled       ← 两级检查
```

### 实例启停流程

**超级管理员启动 agent** `POST /agents/:id/start`：
1. 确保共享 agent-server 在跑（懒起，同现在）
2. 标该 agent 全局 `enabled = true`
3. 所有用户可看到该 agent，可启用自己的私聊 room

**访客启动 agent**（同 API `POST /agents/:id/start`）：
1. 后端校验该 agent 已全局启用（否则 403）
2. 标记 `chat-<uid>-<agentId>` 对该用户激活
3. 后续该用户的 `/say` 到该 room 正常工作

**访客停止 agent** `POST /agents/:id/stop`：
1. 标记 `chat-<uid>-<agentId>` 对该用户停用
2. 发 abort 中断在飞推理
3. 后续 `/say` 到该 room 返回 503（不影响其他用户）

**超级管理员停止 agent** `POST /agents/:id/stop`：
1. 标该 agent 全局 `enabled = false`
2. 对所有用户的该 agent 私聊 room 发 abort
3. 所有用户 `/say` 到该 agent 的私聊 room 返回 503

### 超级管理员账号产生

第一个注册的用户自动成为超级管理员。后续注册均为访客。

---

## 数据隔离方案

### 私聊 roomId 格式变更

| 当前 | 多用户后 |
|------|----------|
| `chat-<agentId>` | `chat-<userId>-<agentId>` |

不同用户与同一 agent 对话 → 不同 roomId → 不同存储路径 → 不同 SSE 广播器，天然隔离。

### 关键发现：当前 private 模式有 dataDir bug（2026-08-06 复查仍存在）

`engine/server.js` 当前代码：

```javascript
const dataDir = mode === 'private' ? agentMemory(agentId) : agentRoomState(agentId, roomId);
```

私聊模式使用全局固定的 `profiles/agents/<id>/memory/`，不区分 roomId。所以用户A和用户B的私聊上下文会互相覆盖。需要改为：私聊房（chat- 前缀）也走 `agentRoomState(agentId, roomId)`。

**联动修改点**（dataDir 改了，这些读旧路径的地方都要跟上）：
- `gateway/snapshot.js`：rewind 快照/恢复目前读写 `agentMemory(id)`，要改为按 roomId 定位到 `agentRoomState(agentId, roomId)`
- `gateway/room_routes.js` 的 `DELETE /rooms/:rid/memory` 未运行兜底分支：目前清 `agentMemory(agentId)/context.json`，要改为清对应 room 目录
- elf-018 专属路由（`agents/elf-018/ui/api.js`）里读 `agentMemory(id)` 的 game-state/lore 逻辑：elf-018 的 lore 在 `memory/runtime/lore/`，属于**人设数据还是私聊记忆**需要界定——若 lore 是 DM 游戏的运行时产物（随对话演化），它应随 room 隔离；若是固定人设模板，留在 memory/。初步判断：runtime/lore 是对话演化产物 → 随 room 走

### roomId 中 `chat-<id>` 的硬编码点清单（全部要改为感知 userId）

| 位置 | 现状 | 改法 |
|------|------|------|
| `gateway/room_routes.js` `privateAgentId(rid)` | `rid.slice('chat-'.length)` | 剥掉 `chat-<uid>-` 前缀取 agentId（uid 生成规则保证不含 `-`） |
| `engine/server.js` `resolveAgentId(rid)` 兜底 | 同上 | 同上（正常路径 observe body 显式带 agentId，兜底也要对） |
| `gateway/process_manager.js` `stopAgent` | abort `chat-${id}` | 遍历该 agent 所有用户房 abort（或只 abort 全局，用户房随消息自然 503） |
| `gateway/process_manager.js` `_makeDisconnectHandler` | `forceFinishPrivateTurn('chat-'+id)` | 遍历所有活跃私聊房（TurnStreamServer 暴露 room 列表） |
| `gateway/aggregated_stream.js` `_currentRooms()` | `chat-${a.agentId}` | per-user：`chat-${userId}-${a.agentId}` |
| `frontend/src/api/index.js` 多处 | `chat-${agentId}` | 拼接当前登录 uid |
| `gateway/private_room_stream.js` `isPrivateRoom` | `startsWith('chat-')` | 不变（新格式仍以 chat- 开头） |

### 存储布局

```
profiles/
  users/<uid>/                    # 用户的个人数据
    user.json
    avatar.<ext>
    rooms/
      chat-<agentId>/             # 该用户私聊历史
        history.jsonl
  agents/<id>/
    memory/                       # agent 通用人设/全局数据（不变，非私聊记忆）
    rooms/
      chat-<uid>-<agentId>/       # 该 agent 对该用户的私聊记忆 ← 修复后的位置
        context.json
        tool-results/
      room_<ts>_<rand>/           # 群聊记忆（不变）
  rooms/
    chat-<uid>-<agentId>/         # 私聊历史（gateway 侧）
      history.jsonl
    room_<ts>_<rand>/             # 群聊 room + history，所有用户共享（不变）
  logs/
```

> 核心变化：`profiles/agents/<id>/memory/` 不再作为私聊记忆目录。每个私聊 room `chat-<uid>-<id>` 使用 `agentRoomState(agentId, roomId)`，与群聊 room 共用同一套存储机制，路径在 `profiles/agents/<id>/rooms/<roomId>/` 下。`memory/` 只保留 agent 通用数据（人设包等，不区分用户）。

### 群聊

群聊 roomId 不变（`room_<ts>_<rand>`），所有用户默认能看见所有群、共享同一份历史。群聊中发言标识 `from=userUid` 区分是谁说的。

**群聊的多用户身份解析（重要改动）**：当前 `RoomManager._rosterForRewrite()` 从 `gateway.json` 读单一全局 user（uid + userName），用于历史消息渲染（uid→name 改写）和 @ 解析。多用户后群里说话的是任意注册用户，需改为：

- RoomManager 持有用户目录（uid → userName 的查询能力，数据源 = profiles/users/*/user.json）
- `_speakerName(uid)` / `rewriteMentions` 的 user 候选从"单个全局 user"改为"全部注册用户"
- 落盘格式不变（speaker/speakerUid 存 uid，渲染时按当时名字改写），老历史中新 uid 解析不到时回退显示 uid 本身
- `GET /rooms/:rid` 返回的 `userName/userUid` 改为返回**当前请求者**（req.user）的身份

---

## 多设备同步

天然支持，无需额外代码：

1. 用户 A 在设备 1、2 各建 1 条 SSE 连到 `/subscribe`（各自带单独 token）
2. 两条连接都注册到 `chat-userA-elf-001` 的 RoomBroadcaster
3. 设备 1 发消息 → 网关写 history → POST /observe agent → agent 推理 → 事件广播
4. RoomBroadcaster.notifyAll() → 两个设备同时收到

---

## 实现步骤（不涉及代码，仅顺序）

1. 安装 bcrypt、jsonwebtoken 依赖
2. 新建 `gateway/auth.js`：用户存储（profiles/users/）+ 注册/登录/me 路由 + JWT 签发 + 内部服务 token
3. 新建 `gateway/auth_middleware.js`：全局鉴权中间件（白名单：/auth/*、静态资源、uploads）+ requireRole 辅助
4. 修改 `gateway/server.js`：挂 auth 路由 + 全局中间件（覆盖 plugin-loader 注册的路由）
5. 修改 `gateway/room_routes.js`：roomId 感知 userId + 私聊归属校验 + /say 用户身份取自 req.user
6. 修改 `gateway/room_bus.js`：用户目录解析（uid→name），替代 gateway.json 单 user
7. 修改 `engine/server.js`：私聊 dataDir 改 agentRoomState + resolveAgentId 解析新格式
8. 修改 `gateway/snapshot.js`：rewind 快照按 roomId 定位数据目录
9. 修改 `gateway/process_manager.js`：stopAgent/disconnect 兜底遍历用户房
10. 修改 `gateway/aggregated_stream.js`：attach 带 userId，per-user 房间列表
11. 修改 `gateway/config.js`：去除全局 userName/userUid/userAvatar（保留 port、agentServerPort 等）
12. 新建前端登录页覆盖层 `LoginPage.jsx`
13. 修改前端 API 层：auth header、login/register、roomId 拼接 uid、401 跳登录
14. 修改前端 main.jsx/App.jsx：启动时 auth 检查
15. 修改 Sidebar 设置：per-user 保存 + config 面板按角色只读
16. 新增测试 `test/auth.test.js`
17. 修改 `test/gateway.test.js`：适配 auth（`ELF_SKIP_AUTH=1`）

---

## 复查结论（2026-08-06，项目有较大改动后）

方案**依然可行**，近期改动不影响主方向，但需纳入以下几点：

1. **plugin-loader 机制**（新增）：elf-018 的 game-state/styles 等路由已从 server.js 收到 `agents/elf-018/ui/api.js`，由 plugin-loader 动态注册。全局鉴权中间件在它之前挂上即可自动覆盖，无需逐个改 agent api.js。
2. **server-to-server 调用必须放行**：PrivateChatPlugin 的 sync-history、Speak 工具的 /say、群聊 /notice 都是 agent-server 回调 gateway，需要内部服务 token，不能一刀切要用户 JWT。
3. **头像等静态资源免鉴权**：`<img>` 标签发不了 Authorization 头。
4. **群聊单 user 解析要多用户化**：RoomManager 目前从 gateway.json 读唯一 user 做 uid→name 渲染，要改为查用户目录。
5. **私聊 dataDir bug 仍在**（engine/server.js）：私聊上下文全局共享，必须随本次一并修。
6. **turn-stream aborted 语义已变**（2026-08-06）：aborted 时调 history.rewindToLastUser 截断落盘——与多用户无冲突，但注意私聊 history 操作全部按 roomId 定位即可天然兼容。

---

## 边界情况

- **同一个用户不同设备发消息冲突**：SSE 聚合同一 room → 自己消息也广播，前端 sseDispatcher 按 roomId 分发，store 直接追加，前端正常显示"自己"的发言
- **访客无权操作返回什么**：HTTP 403 Forbidden，body `{ "error": "权限不足" }`
- **超级管理员降级**：无此设计，第一个注册的永久是超级管理员
- **用户注销账号**：暂不支持，一期不做
- **JWT 泄露**：安全级别同业界通用方案（HTTPS + 定期轮换），一期不额外加固
- **存量数据处理**：遵循项目"不做向后兼容"原则，不做自动迁移。改造后旧的 `profiles/rooms/chat-<id>/`（无 uid）变成孤儿目录，新私聊从空白开始；如需保留 wolfgod 现有聊天，手动把目录改名为 `chat-<uid>-<id>` 即可（uid = 第一个注册的管理员）