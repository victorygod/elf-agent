# Elf — 轻量级 AI Agent 平台

## 需求与设计文档

---

## 1. 项目概述

Elf 是一个极简的 AI Agent 平台，由两个严格分离的子系统组成：

- **Agent** — 基于 LLM 的轻量级 AI Agent，以独立进程运行，维持自己的服务循环
- **Gateway** — Web Server，提供用户与 Agent 的交互接口（流式对话）及 Agent 进程管理

核心理念：**Agent 只负责"思考"，Gateway 只负责"连接"**。

一个 Agent 对应一个对话上下文，用户通过 Gateway 与 Agent 进行 1:1 对话。

---

## 2. 需求

### 2.1 Agent

| # | 需求 | 优先级 |
|---|------|--------|
| A1 | 实现 Agent Loop（Reasoning 层）：LLM 返回 → 工具调用检测 → 工具执行 → 结果追加 → 重复（最多 N 轮） | P0 |
| A2 | 支持唯一个工具：`read_file`，读取本地文件内容 | P0 |
| A3 | System Prompt 可配置 | P0 |
| A4 | 以独立 Node.js 进程运行，监听 HTTP 端口，等待 Gateway 请求 | P0 |
| A5 | 支持流式输出（SSE），逐 token 将 LLM 响应推送给 Gateway | P0 |
| A6 | 配置热加载：配置文件修改后，Agent 无需重启即生效 | P1 |
| A7 | 维护对话历史，支持基于 token 阈值的 LLM 自压缩记忆管理 | P0 |
| A8 | 实现响应决策层（Intuitive 层）：接收外界输入，判定是否触发 Reasoning，与 Agent Loop 解耦 | P0 |
| A9 | 请求串行化：同一 Agent 同时只处理一个请求，后续请求排队 | P0 |

### 2.2 Gateway

| # | 需求 | 优先级 |
|---|------|--------|
| G1 | 提供聊天接口，将用户消息转发给 Agent，以 SSE 流式返回 Agent 响应 | P0 |
| G2 | 提供 Agent 进程管理：启动、停止、重启、列表、状态查询 | P0 |
| G3 | 修改配置文件后自动生效（fs.watch 热加载） | P1 |
| G4 | 提供配置读写 API（api_key、model、system_prompt、memoryTokenLimit 等） | P0 |
| G5 | 纯 API 服务（REST + SSE），不含前端页面 | P0 |
| G6 | 进程容错：检测 Agent 进程崩溃并支持手动重启；Gateway 重启后恢复与存活 Agent 的连接 | P0 |

### 2.3 通用

| # | 需求 | 优先级 |
|---|------|--------|
| C1 | 零外部重型依赖，运行时仅依赖 `express` | P0 |
| C2 | 所有配置通过文件系统管理，修改即生效 | P0 |

---

## 3. 架构设计

### 3.1 整体架构与通信

```
用户 ──POST /agents/:id/chat──► Gateway ──POST /chat──► Agent
     ◄─── SSE stream ────────── Gateway ◄── SSE stream ──

┌─────────────────────────────────┐
│          Gateway (:8080)        │
│                                 │
│   REST API                      │
│   ├── /agents        (CRUD)     │
│   ├── /agents/:id    (管理)     │
│   └── /agents/:id/chat (对话)   │
│                                 │
└────────────┬────────────────────┘
             │ HTTP / SSE
     ┌───────┼────────┐
     ▼       ▼        ▼
 ┌──────┐ ┌──────┐ ┌──────┐
 │Agent │ │Agent │ │Agent │
 │ :8081│ │ :8082│ │ :8083│
 └──────┘ └──────┘ └──────┘
```

全程 HTTP + SSE。Gateway 做路由透传和进程管理，不解析 SSE 内容。

### 3.2 进程模型

```
Gateway (主进程, :8080)
  ├── child_process.fork() → Agent 进程 1 (port 8081)
  ├── child_process.fork() → Agent 进程 2 (port 8082)
  └── child_process.fork() → Agent 进程 N (port 808N)
```

- Gateway 通过 `child_process.fork()` 启动 Agent 子进程，通过 HTTP 通信
- Agent 可独立启动（方便调试），Gateway 通过端口发现接入
- Gateway fork Agent 的入口为 `agents/{agentId}/index.js`
- Agent 目录由开发者手动创建在 `agents/` 下，Gateway 只管理进程生命周期，不创建或删除目录
- 端口分配：每个 Agent 的 `config.json` 中指定端口

**选择 HTTP 而非 IPC**：Gateway 崩溃后 Agent 不亡（OS 托管子进程），重启后 `GET /status` 探活即恢复；IPC 通道断开不可恢复，反而需要额外发现机制。HTTP 一套机制同时覆盖正常通信和容错。

### 3.3 目录结构

```
elf/
├── package.json
├── docs/
│   └── design.md                # 本文档
├── gateway/                     # Gateway — Web Server
│   ├── index.js                 # 入口
│   ├── server.js                # Express 路由与中间件
│   ├── process_manager.js       # Agent 进程管理（fork/kill/restart/recover）
│   └── config.js                # Gateway 配置读写
├── agents/                      # 每个 Agent 一个独立目录（代码+配置 自包含）
│   └── elf-001/                 # Agent: elf-001
│       ├── index.js             # 入口：启动 Agent 服务
│       ├── agent.js             # Intuitive + Reasoning 核心
│       ├── server.js            # HTTP 服务（接收 Gateway 请求）
│       ├── models/
│       │   └── llm_model.js     # LLM 调用（OpenAI 兼容接口）
│       ├── tools/
│       │   ├── registry.js      # 工具注册表
│       │   └── read_file.js     # read_file 工具实现
│       ├── message_manager.js   # 对话历史管理 + 记忆压缩
│       ├── config.js            # 配置加载 + 热加载逻辑
│       └── config/              # 运行时配置目录（可热更新，与代码分离）
│           ├── config.json      # 主配置（引用子文件路径）
│           └── system_prompt.md # System Prompt
├── shared/                      # 可选：Agent 间共享的工具代码
│   └── logger.js                # 统一日志（Agent 可引用，也可自备）
├── gateway.json                 # Gateway 全局配置
└── logs/
```

### 3.4 Agent 双层架构：Intuitive 与 Reasoning

```
┌───────────────────────────────────────────────┐
│  Intuitive（直觉层）                           │
│                                               │
│  1. 接收外界输入                               │
│  2. 判断是否需要触发 Reasoning                  │
│  3. 触发时，将消息交付给 Reasoning              │
│                                               │
│  当前策略：收到消息即触发（pass-through）        │
│  未来可扩展：@触发、关键词触发、定时触发、      │
│             消息囤积批量处理等                  │
├───────────────────────────────────────────────┤
│  Reasoning（推理层 / Agent Loop）              │
│                                               │
│  收到 Intuitive 交付的消息后：                  │
│  LLM 调用 → 工具调用 → LLM 调用 → ... → 回复   │
└───────────────────────────────────────────────┘
```

```
外界消息到达
    │
    ▼
Intuitive: 判定是否触发推理
    │           │
   触发       不触发 → 返回（当前无此场景，预留扩展点）
    │
    ▼
交付给 Reasoning

──── Reasoning 内部 ────

消息追加到历史
    │
    ▼
┌─→ LLM 调用（流式）
│       │
│       ▼
│   解析响应 ── 纯文本 ──→ 流式输出，结束
│       │
│     工具调用 → 执行 → 结果追加到历史
│       │
└───────┘  （最多 maxIterations 轮，默认 5）
```

两层解耦的意义：触发策略（何时响应、响应什么消息批次）的任何变化只影响 Intuitive，Reasoning 的思考逻辑完全不变。

### 3.5 请求串行化

Agent 同时可能收到多个 HTTP 请求。Agent 在 HTTP 层维护请求队列，串行处理：

```
POST /chat (req-1) ──► ┌────────────┐
POST /chat (req-2) ──► │ Request    │ ──► 逐个处理 ──► Intuitive → Reasoning ──► SSE 响应
POST /chat (req-3) ──► │ Queue      │
                       └────────────┘
```

这保证对话历史和记忆压缩不并发冲突。SSE 天然支持等待，排队对用户无感。

未来如果引入多会话并发，请求队列可改为 per-session 串行（不同 session 并行，同一 session 串行），但 v1 保持简单，全局串行。

### 3.6 接口

#### Agent 暴露的 HTTP 接口

| Method | Path | 说明 |
|--------|------|------|
| POST | `/chat` | 发送消息，SSE 流式返回 Agent 响应 |
| GET | `/config` | 获取当前配置 |
| GET | `/status` | 联通性检查 |

#### Gateway 暴露给用户的接口

| Method | Path | 说明 |
|--------|------|------|
| GET | `/agents` | 列出所有 Agent 及状态 |
| GET | `/agents/:id` | 获取单个 Agent 详情 |
| POST | `/agents/:id/start` | 启动 Agent 进程 |
| POST | `/agents/:id/stop` | 停止 Agent 进程 |
| POST | `/agents/:id/restart` | 重启 Agent 进程 |
| POST | `/agents/:id/chat` | 与 Agent 对话（SSE 流式） |
| GET | `/agents/:id/config` | 获取 Agent 配置 |
| PUT | `/agents/:id/config` | 更新 Agent 配置（写文件 + 触发热加载） |

Agent 目录由开发者手动创建在 `agents/` 下。Gateway 只管理已有 Agent 的进程生命周期（启动/停止/重启），不负责创建或删除 Agent 目录。

#### SSE 事件格式（Agent → Gateway → 用户）

```
event: token       data: {"content": "Hello"}
event: status      data: {"state": "reading_file", "detail": "正在读取 /tmp/test.txt"}
event: done        data: {"usage": {"prompt_tokens": 100, "completion_tokens": 50}}
event: error       data: {"message": "API error"}
```

- `token`：LLM 输出片段，逐 token 流式推送
- `status`：状态通知（读文件、记忆压缩等），不暴露工具调用细节
- `done`：对话完成，含 token 用量
- `error`：错误

### 3.7 配置管理

每个 Agent 的全部代码和配置在 `agents/{agentId}/` 下，自包含可独立分发。可热更新的运行时配置放在 `config/` 子目录，与代码分离：

```
agents/elf-001/
├── index.js, agent.js, server.js, ...   # Agent 代码（不热更新）
└── config/                              # 运行时配置（可热更新）
    ├── config.json                      # 主配置，引用子文件
    └── system_prompt.md                 # System Prompt
```

`config.json` 示例：

```json
{
  "agentId": "elf-001",
  "port": 8081,
  "model": {
    "provider": "llm",
    "base_url": "https://api.openai.com/v1",
    "auth_token": "sk-xxx",
    "model": "gpt-4o"
  },
  "systemPromptPath": "system_prompt.md",
  "memoryTokenLimit": 8000,
  "maxIterations": 5
}
```

- `model.provider`：`"llm"` 使用真实 API，`"mock"` 使用 MockLLM（测试用，跳过 API 调用）
- `systemPromptPath` 等路径字段相对于 `config.json` 所在目录（即 `agents/{agentId}/config/`）
- 短配置（如 `maxIterations`）内联在 `config.json`；长内容（如 system prompt）独立为子文件
- Agent 加载时读取 `config.json`，遇 path 字段则读取对应文件，合并为运行时配置

`gateway.json` 示例：

```json
{
  "port": 8080
}
```

**热加载**：
1. 配置文件变更后（通过 `PUT /agents/:id/config` API 或手动编辑），Agent 的 `fs.watch` 监听到变化，自动重新加载
2. 无论文件从哪条路径修改，热加载都生效，无需额外通知

### 3.8 记忆管理

采用 **LLM 自压缩**：上下文过长时让 LLM 总结历史，保留摘要。

**Token 估算**：`message.content.length / 4` 近似，中文偏保守但作为阈值触发器足够。

```
每轮 LLM 调用后:
  estimatedTokens(messages) > memoryTokenLimit ?
    │
    ▼ 是：触发压缩

压缩流程:
  1. 插入 user 消息："请简要总结以上对话的关键信息，保留重要细节。"
  2. 调用 LLM 生成总结
  3. 截断历史为: [system_prompt, 压缩请求, 压缩摘要]
  4. 后续对话追加在摘要之后
```

system prompt 始终完整保留，不受压缩影响。配置项：`memoryTokenLimit`（默认 8000）。

### 3.9 进程容错

| 场景 | 检测 | 恢复 |
|------|------|------|
| Agent 崩溃，Gateway 存活 | `child_process` exit 事件 | 标记 `stopped`，手动重启。对话历史丢失 |
| Gateway 崩溃，Agent 存活 | 重启后端口探测 | 扫描 `agents/` 目录，`GET /status` 探活，自动恢复映射。历史不受影响 |
| 两者都崩溃 | 同上 | 存活 Agent 恢复连接。不存活的标记 stopped，需手动启动。所有历史丢失 |

对话历史仅存 Agent 内存，不持久化。Agent 崩溃 = 历史丢失。

**Gateway 启动流程**：
1. 加载 `gateway.json`
2. 扫描 `agents/` 目录，发现所有 Agent
3. 默认启动第一个 Agent，其余标记为 `stopped`
4. 对每个 agentId：读 `config.json` → `GET /status` 探活 → 存活则接入，否则按需 fork `agents/{agentId}/index.js`
5. 注册子进程 exit 监听
6. 启动 HTTP 服务

---

## 4. 接口协议示例

### 4.1 聊天

```
POST /agents/elf-001/chat
{ "message": "帮我看看 /tmp/test.txt 的内容" }

→ SSE 流:
  event: status    data: {"state": "reading_file", "detail": "正在读取 /tmp/test.txt"}
  event: token     data: {"content": "这个文件"}
  event: token     data: {"content": "包含了..."}
  event: done      data: {"usage": {"prompt_tokens": 100, "completion_tokens": 50}}
```

### 4.2 Agent 管理

```
GET /agents
→ 200 [{ "agentId": "elf-001", "port": 8081, "status": "running", "pid": 12345 }, ...]

GET /agents/elf-001
→ 200 { "agentId": "elf-001", "port": 8081, "status": "running", "pid": 12345 }

POST /agents/elf-001/start
→ 200 { "agentId": "elf-001", "status": "running", "pid": 12345 }

POST /agents/elf-001/stop
→ 200 { "agentId": "elf-001", "status": "stopped" }

POST /agents/elf-001/restart
→ 200 { "agentId": "elf-001", "status": "running", "pid": 12346 }
```

### 4.3 配置读写

```
GET /agents/elf-001/config
→ 200 { "agentId": "elf-001", "port": 8081, "model": {...}, "systemPromptPath": "system_prompt.md", "memoryTokenLimit": 8000, "maxIterations": 5 }

PUT /agents/elf-001/config
{ "memoryTokenLimit": 12000, "systemPrompt": "You are now a strict code reviewer." }
→ 200 { "status": "ok" }
```

部分更新：未传字段保持原值，写入文件后自动触发 Agent 热加载。

---

## 5. 依赖

| 包 | 用途 | 范围 |
|----|------|------|
| express | HTTP 服务 + 路由 | gateway + agent |

LLM 调用使用 Node.js 内置 `fetch`（Node 18+），不引入 SDK。

---

## 6. 启动方式

```bash
# 启动 Gateway（扫描 agents/ 目录，管理 Agent 进程）
node gateway/index.js

# 单独启动 Agent（调试用，standalone 模式）
node agents/elf-001/index.js

# 启动/重启 Agent
curl -X POST http://localhost:8080/agents/elf-001/start
curl -X POST http://localhost:8080/agents/elf-001/restart

# 对话
curl -X POST http://localhost:8080/agents/elf-001/chat \
  -H "Content-Type: application/json" \
  -d '{ "message": "Hello!" }'
```