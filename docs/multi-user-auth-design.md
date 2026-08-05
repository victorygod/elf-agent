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

### 关键发现：当前 private 模式有 dataDir bug

`engine/server.js:124` 当前代码：

```javascript
const dataDir = mode === 'private' ? agentMemory(agentId) : agentRoomState(agentId, roomId);
```

私聊模式使用全局固定的 `profiles/agents/<id>/memory/`，不区分 roomId。所以用户A和用户B的私聊上下文会互相覆盖。需要改为 per-roomId 的 `agentRoomState(agentId, roomId)`。

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
2. 新建 `gateway/auth.js`：注册/登录/me 路由 + JWT 签发
3. 新建 `gateway/auth_middleware.js`：requireAuth、requireRole 中间件
4. 修改 `gateway/server.js`：挂载 auth + 保护路由
5. 修改 `gateway/room_routes.js`：roomId 含 userId + 权限校验
6. 修改 `gateway/config.js`：去除全局用户设置
7. 修改 `gateway/aggregated_stream.js`：per-user 房间列表
8. 新建前端登录页覆盖层 `LoginPage.jsx`
9. 修改前端 API 层：auth header、login/register
10. 修改前端 main.jsx/App.jsx：启动时 auth 检查
11. 修改 Sidebar 设置：per-user 保存
12. 新增测试 `test/auth.test.js`
13. 修改 `test/gateway.test.js`：适配 auth（`ELF_SKIP_AUTH=1`）

---

## 边界情况

- **同一个用户不同设备发消息冲突**：SSE 聚合同一 room → 自己消息也广播，前端 sseDispatcher 按 roomId 分发，store 直接追加，前端正常显示"自己"的发言
- **访客无权操作返回什么**：HTTP 403 Forbidden，body `{ "error": "权限不足" }`
- **超级管理员降级**：无此设计，第一个注册的永久是超级管理员
- **用户注销账号**：暂不支持，一期不做
- **JWT 泄露**：安全级别同业界通用方案（HTTPS + 定期轮换），一期不额外加固