<div align="center">

# 🧝 Elf

**轻量级 AI Agent 平台**

一个极简的多 Agent 管理与对话平台，Agent 负责「思考」，Gateway 负责「连接」。

[English](#english) · [中文](#中文)

---

</div>

<a id="中文"></a>

## ✨ 特性

- 🤖 **多 Agent 架构** — 每个 Agent 以独立 Node.js 进程运行，拥有专属配置、System Prompt 与对话上下文
- 🌊 **流式对话** — 基于 SSE（Server-Sent Events）逐 token 推送 LLM 响应，实时流畅
- 🔧 **工具调用** — 支持 LLM Function Calling（内置 `read_file` 工具，可扩展）
- 🧠 **记忆管理** — 基于 Token 阈值的自动记忆压缩：上下文超限时自动调用 LLM 摘要历史
- 🔥 **配置热加载** — 修改配置文件即生效，无需重启 Agent（`fs.watch`）
- ⚙️ **进程管理** — Gateway 管理 Agent 进程全生命周期：启动、停止、重启、崩溃检测与恢复
- 💾 **双模型持久化** — `context.json`（LLM 上下文，读写）+ `history.jsonl`（聊天记录，只追加）
- 🖥️ **内置 Web UI** — 微信风格聊天界面，支持 Agent 列表、配置面板、头像定制
- 🧪 **Mock 模式** — 内置 MockModel，无需真实 LLM API 即可测试
- 🪶 **零重型依赖** — 运行时仅依赖 `express`

## 🏗️ 架构

```
┌──────────┐     HTTP + SSE      ┌──────────┐     HTTP + SSE     ┌──────────┐
│          │  ◄──────────────►   │          │  ◄──────────────►  │          │
│  Web UI  │                    │ Gateway  │                   │  Agent   │
│          │    REST API         │  :8080   │   /chat (SSE)     │  :8081   │
└──────────┘                    │          │   /config /status  └──────────┘
                                │          │
                                │          │  ◄──────────────►  ┌──────────┐
                                │          │   /chat (SSE)      │  Agent   │
                                └──────────┘   /config /status  │  :8082   │
                                                        └──────────┘
```

**核心理念：Agent 只负责"思考"，Gateway 只负责"连接"。**

- Agent 与 Gateway 通过 HTTP + SSE 通信（而非 IPC），Agent 进程可在 Gateway 崩溃后存活并被重新发现
- Gateway 不解析 SSE 内容，透明转发字节流
- 每个 Agent 同时只处理一个请求，后续请求排队

## 📁 项目结构

```
elf/
├── gateway/                  # Gateway — Web 服务器 & 进程管理
│   ├── index.js              #   入口：加载配置 → 发现 Agent → 探测 → 启动 HTTP
│   ├── server.js             #   Express 路由、SSE 代理、配置 API、头像上传、历史记录
│   ├── process_manager.js    #   Agent 生命周期：fork / kill / restart / probe / recover
│   ├── config.js             #   加载 gateway.json
│   ├── chat_history.js       #   ChatHistory 类（JSONL 持久化）
│   └── config-ui.js          #   自动生成配置表单 HTML
│
├── agents/                   # 每个子目录 = 一个独立的 Agent
│   ├── elf-001/              #   通用助手
│   │   ├── index.js          #     入口
│   │   ├── agent.js          #     Agent 核心：Intuitive 层 + Reasoning 层（Agent Loop）
│   │   ├── server.js         #     HTTP 服务：/chat, /config, /status, /clear + 请求队列
│   │   ├── message_manager.js#     对话历史 + 记忆压缩 + context.json 持久化
│   │   ├── config.js         #     配置加载
│   │   ├── config/           #     配置文件目录
│   │   │   ├── config.json   #       Agent 配置（端口、模型、记忆阈值等）
│   │   │   ├── api_key.json  #       模型凭据（已 gitignore）
│   │   │   └── system_prompt.md #    系统提示词
│   │   ├── data/             #     运行时数据
│   │   │   ├── context.json  #       LLM 上下文（压缩后）
│   │   │   └── history.jsonl #       聊天记录（只追加）
│   │   └── tools/            #     工具
│   │       ├── registry.js   #       工具注册表
│   │       └── read_file.js  #       read_file 工具实现
│   └── elf-002/              #   代码审查专家（同结构）
│
├── shared/                   # 共享模块
│   ├── agent/
│   │   ├── llm_model.js      #   LLMModel：OpenAI 兼容流式 API 客户端（fetch 实现）
│   │   └── mock_model.js     #   MockModel：测试替身
│   └── logger.js             #   统一日志（console + 文件）
│
├── frontend/                 # Web UI
│   ├── index.html            #   主页面（侧边栏 + 聊天区 + 配置面板）
│   ├── app.js                #   前端逻辑：SSE 处理、聊天、Agent 控制、配置保存
│   ├── style.css             #   微信风格 CSS，响应式
│   └── default-config-ui.html#   配置表单模板
│
├── test/                     # 测试
│   ├── agent.test.js         #   单元 + 集成测试
│   ├── gateway.test.js       #   Gateway 测试
│   └── integration.test.js   #   端到端测试
│
├── scripts/
│   └── cleanup.sh            #   清理进程脚本
│
├── docs/                     # 设计文档
│   ├── design.md             #   完整系统设计
│   ├── api.md                #   API 参考
│   ├── agent-engineering.md  #   Agent 工程规范
│   ├── gateway-engineering.md#   Gateway 工程规范
│   └── message-persistence.md#   消息持久化设计
│
├── gateway.json              # Gateway 配置
└── package.json
```

## 🚀 快速开始

### 环境要求

- Node.js 18+

### 安装

```bash
git clone https://github.com/your-username/elf.git
cd elf
npm install
```

### 配置

为你的 Agent 设置 LLM API 凭据（以 OpenAI 兼容 API 为例）：

```bash
# 编辑 Agent 的 API Key 配置
vim agents/elf-001/config/api_key.json
```

`api_key.json` 格式：

```json
{
  "base_url": "https://api.openai.com/v1",
  "auth_token": "sk-your-api-key",
  "model": "gpt-4o"
}
```

### 启动

```bash
npm start
```

启动后访问 [http://localhost:8080](http://localhost:8080) 打开 Web UI。

### 停止

```bash
npm stop
```

### 重启

```bash
npm restart
```

## 🛠️ 使用

### Web UI

打开浏览器访问 `http://localhost:8080`，即可看到微信风格的聊天界面：

- 左侧边栏：Agent 列表与切换
- 中间区域：聊天对话（SSE 流式输出）
- 右侧面板：Agent 配置编辑（模型、System Prompt、记忆阈值等）

### API 调用

**聊天对话（流式 SSE）：**

```bash
curl -N http://localhost:8080/agents/elf-001/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "你好，请介绍一下你自己"}'
```

**Agent 进程管理：**

```bash
# 启动 Agent
curl -X POST http://localhost:8080/agents/elf-001/start

# 停止 Agent
curl -X POST http://localhost:8080/agents/elf-001/stop

# 重启 Agent
curl -X POST http://localhost:8080/agents/elf-001/restart

# 查询 Agent 状态
curl http://localhost:8080/agents/elf-001/status

# 列出所有 Agent
curl http://localhost:8080/agents
```

**读取/修改 Agent 配置：**

```bash
# 获取配置
curl http://localhost:8080/agents/elf-001/config

# 更新 System Prompt
curl -X PUT http://localhost:8080/agents/elf-001/config/system_prompt \
  -H "Content-Type: application/json" \
  -d '{"content": "你是一个 helpful 助手"}'
```

### 添加新 Agent

1. 复制现有 Agent 目录：

```bash
cp -r agents/elf-001 agents/elf-003
```

2. 修改 `agents/elf-003/config/config.json`，设置新的 `agentId`、`name`、`port`

3. 编辑 `agents/elf-003/config/system_prompt.md`，定义 Agent 人设

4. 配置 `agents/elf-003/config/api_key.json`，填入模型凭据

5. 清除遗留数据：

```bash
rm agents/elf-003/data/context.json agents/elf-003/data/history.jsonl
```

6. 重启 Gateway，新 Agent 自动被发现

### 单独运行 Agent（调试）

```bash
node agents/elf-001/index.js
```

## 🧪 测试

```bash
npm test
```

测试套件包含：

- **Agent 测试** — 配置加载、MockModel、工具注册、消息管理、Agent Loop、HTTP 接口
- **Gateway 测试** — 配置加载、进程管理、HTTP API
- **集成测试** — Gateway + Agent 协作、热加载、崩溃恢复

## 📖 文档

| 文档 | 说明 |
|------|------|
| [设计文档](docs/design.md) | 系统架构、需求、双层 Agent 设计 |
| [API 参考](docs/api.md) | 完整 REST API 与 SSE 事件格式 |
| [Agent 工程规范](docs/agent-engineering.md) | Agent 模块职责与伪代码 |
| [Gateway 工程规范](docs/gateway-engineering.md) | Gateway 路由、SSE 代理与错误处理 |
| [消息持久化](docs/message-persistence.md) | context.json + history.jsonl 设计 |

## 🔑 核心设计

### 双层 Agent 架构

```
用户消息
   │
   ▼
┌─────────────────┐
│  Intuitive 层   │  ← 响应决策：决定是否触发深度推理
└────────┬────────┘
         │ 触发
         ▼
┌─────────────────┐
│  Reasoning 层   │  ← Agent Loop：LLM → 工具调用 → 执行 → 追加 → 重复（最多 N 轮）
└─────────────────┘
```

### 记忆管理

当对话上下文 Token 数超过 `memoryTokenLimit` 阈值时，Agent 自动调用 LLM 总结历史消息，压缩后的摘要替代原始历史，保持上下文在可控范围内。

### 进程容错

- Gateway 通过 `GET /status` 探测存活 Agent
- Agent 崩溃后可手动重启
- Gateway 重启后自动恢复与存活 Agent 的连接

## 📄 License

MIT

---

<a id="english"></a>

## ✨ Features

- 🤖 **Multi-Agent Architecture** — Each Agent runs as an independent Node.js process with its own config, system prompt, and conversation context
- 🌊 **Streaming Chat** — SSE-based real-time token-by-token response from LLM
- 🔧 **Tool Use** — LLM Function Calling support (built-in `read_file` tool, extensible)
- 🧠 **Memory Management** — Automatic token-threshold-based memory compaction via LLM summarization
- 🔥 **Hot Config Reload** — Configuration changes take effect without restarting Agent (`fs.watch`)
- ⚙️ **Process Management** — Gateway manages full Agent lifecycle: fork, kill, restart, crash detection, recovery
- 💾 **Dual Persistence** — `context.json` (LLM context, read/write) + `history.jsonl` (chat log, append-only)
- 🖥️ **Built-in Web UI** — WeChat-style chat interface with agent list, config panel, and avatar support
- 🧪 **Mock Mode** — Built-in MockModel for testing without real LLM API calls
- 🪶 **Zero Heavy Dependencies** — Only runtime dependency: `express`

## 🚀 Quick Start

### Prerequisites

- Node.js 18+

### Install

```bash
git clone https://github.com/your-username/elf.git
cd elf
npm install
```

### Configure

Set up LLM API credentials for your Agent (OpenAI-compatible API):

```bash
vim agents/elf-001/config/api_key.json
```

`api_key.json` format:

```json
{
  "base_url": "https://api.openai.com/v1",
  "auth_token": "sk-your-api-key",
  "model": "gpt-4o"
}
```

### Run

```bash
npm start
```

Open [http://localhost:8080](http://localhost:8080) for the Web UI.

### Stop

```bash
npm stop
```

### Test

```bash
npm test
```

### Add a New Agent

1. Copy an existing agent directory: `cp -r agents/elf-001 agents/elf-003`
2. Update `config.json` with new `agentId`, `name`, `port`
3. Edit `system_prompt.md` to define the agent's persona
4. Configure `api_key.json` with model credentials
5. Clean up old data: `rm agents/elf-003/data/context.json agents/elf-003/data/history.jsonl`
6. Restart Gateway — new Agent is auto-discovered

## 📄 License

MIT