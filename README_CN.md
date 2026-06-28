<div align="center">

# 🧝 Elf

轻量级 AI Agent 平台。

Agent 负责「思考」，Gateway 负责「连接」。每个 Agent 以独立 Node.js 进程运行，由共享内核 `shared/agent/` 驱动，拥有专属配置、System Prompt 与对话上下文——Agent 只需贡献自己独有的部分。

[English](README.md) · [MIT License](LICENSE)

</div>

## 特性

- **多 Agent** — 每个 Agent 是独立 detached 进程，目录自包含（配置 + 数据）；拷贝配置目录即可接入新 Agent
- **共享内核** — 所有 Agent 共用一个引擎 `shared/agent/`：Agent Loop、模型客户端、工具注册表、消息管理器。Agent 只需通过 `agentClass` / `messageManagerClass` 覆盖差异部分
- **Claude Code 风格工具** — 内置 `Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep`；通过 `config.json` 的 `tools` 数组按需注册，在 `tools/index.js` 加 export 即可扩展
- **流式对话** — 基于 SSE 逐 token 推送，并交织工具调用 / 状态事件
- **Agent Loop** — 经典循环：调 LLM → 解析 → 执行工具 → 再调 LLM → … 直至得到文本回复；由 `maxIterations` 约束（0 = 无限迭代）
- **记忆压缩** — 估算 token 超过 `memoryTokenLimit` 时自动摘要历史；elf-002 在循环内（每轮 LLM 调用前）压缩，长任务中途也能约束上下文
- **前缀 / 后缀提示词** — 仅对 LLM 在最新用户消息前后拼接提示词，不写入记忆（elf-001）
- **热加载** — 配置 / 提示词文件变更即生效，无需重启（基于 `fs.watch`）
- **进程管理** — 发现 / 启动 / 停止 / 中断 / 重启 / 崩溃恢复；Agent 为 detached 进程，Gateway 重启不影响其运行
- **双持久化** — `data/context.json`（LLM 上下文）+ `data/history.jsonl`（只追加聊天日志，分页查询）
- **Web UI** — React + Vite 聊天界面：侧边栏、流式气泡、工具调用标记、配置抽屉、编辑差异渲染
- **Mock 模式** — 内置 `MockModel`（`provider: "mock"`），无需 LLM API 即可测试
- **零重型依赖** — 后端运行时仅依赖 `express`，使用 Node.js 内置 `fetch`

## 架构

```
┌──────────┐    HTTP + SSE    ┌──────────┐    HTTP + SSE    ┌──────────┐
│  Web UI  │ ◄──────────────► │ Gateway  │ ◄──────────────► │  Agent   │
│ React    │    REST API      │  :8080   │                  │  :8081   │
└──────────┘                  └──────────┘                  └──────────┘
                                  │ detached 进程
                                  │          ◄──────────────► ┌──────────┐
                                  │          /chat, /config   │  Agent   │
                                  └────────────────────────── │  :8082   │
                                                              └──────────┘

Agent (shared/agent/)：Config → Model(LLMModel/MockModel) → ToolRegistry → MessageManager → Agent Loop
```

## 目录结构

```
shared/agent/      # 共享引擎：start.js、default_agent.js、llm_model.js、
                   #   mock_model.js、message_manager.js、config_loader.js、server.js、tools/
agents/<id>/       # 单个 Agent：config/（config.json、api_key.json、提示词、头像）+ data/
                   #   可选覆盖：agent.js、message_manager.js
gateway/           # HTTP 网关：server.js、process_manager.js、chat_proxy.js、
                   #   chat_history.js、config_store.js、config-ui.js、avatar.js
frontend/          # React + Vite 界面（构建到 frontend/dist/，由 Gateway 提供服务）
test/              # node:test 测试套件（shared、agent、gateway、config-store、integration）
```

## 快速开始

**环境要求：** Node.js 18+

```bash
git clone https://github.com/your-username/elf.git
cd elf
npm install      # postinstall 会一并安装前端依赖
```

配置 LLM 凭据（每个 Agent 一个文件）：

```bash
vim agents/elf-001/config/api_key.json
```

```json
{
  "base_url": "https://api.openai.com/v1",
  "auth_token": "sk-your-api-key",
  "model": "gpt-4o"
}
```

运行：

```bash
npm start              # 构建前端 + 启动 Gateway  → http://localhost:8080
npm stop               # 停止 Gateway + Agent（释放端口）
npm restart            # 停止后重新启动
npm test               # 运行测试套件
npm run dev:frontend   # 前端 Vite 开发服务器
```

## Agent 配置 (`config.json`)

```jsonc
{
  "agentId": "elf-002",
  "name": "Coding Agent",
  "port": 8082,
  "provider": "llm",            // 或 "mock"
  "systemPrompt": { "type": "path", "content": "system_prompt.md" },
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  "memoryTokenLimit": 40000,    // 超过此阈值触发记忆压缩
  "maxIterations": 0,           // 0 = Agent Loop 无限迭代
  "agentClass": "agent",        // 可选：覆盖默认 Agent
  "messageManagerClass": "message_manager"  // 可选：覆盖 MessageManager
}
```

`{ "type": "path", "content": "<文件>" }` 类型的字段会从配置目录自动加载并热更新；
`_ui` 字段用于配置抽屉的界面标注。

## 添加新 Agent

```bash
cp -r agents/elf-001 agents/elf-003
# 编辑 agents/elf-003/config/{config.json, api_key.json, system_prompt.md}
#   - 唯一的 agentId + name，空闲端口
#   - 选择 tools、memoryTokenLimit、maxIterations
# 清理：rm -rf agents/elf-003/data/*
# 之后重启 Gateway 或 POST /agents/rediscover 即自动发现
```

## API

```bash
# 列出 / 发现 Agent
curl http://localhost:8080/agents
curl -X POST http://localhost:8080/agents/rediscover
curl http://localhost:8080/available-tools

# 聊天（SSE 流式）
curl -N http://localhost:8080/agents/elf-001/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "你好"}'

# 进程管理
curl -X POST http://localhost:8080/agents/elf-001/start
curl -X POST http://localhost:8080/agents/elf-001/stop
curl -X POST http://localhost:8080/agents/elf-001/restart
curl -X POST http://localhost:8080/agents/elf-001/abort
curl http://localhost:8080/agents/elf-001/status

# 历史记录（分页）& 记忆
curl http://localhost:8080/agents/elf-001/history?limit=30
curl -X DELETE http://localhost:8080/agents/elf-001/history
curl -X DELETE http://localhost:8080/agents/elf-001/memory

# 配置
curl http://localhost:8080/agents/elf-001/config
curl http://localhost:8080/agents/elf-001/config-ui
curl -X PUT http://localhost:8080/agents/elf-001/config \
  -H "Content-Type: application/json" \
  -d '{"systemPrompt": "你是一个有用的助手"}'
```

## 文档

| 文档 | 说明 |
|------|------|
| [design.md](docs/design.md) | 系统架构与需求 |
| [api.md](docs/api.md) | REST API 与 SSE 事件参考 |
| [agent-engineering.md](docs/agent-engineering.md) | Agent 模块规范 |
| [gateway-engineering.md](docs/gateway-engineering.md) | Gateway 模块规范 |
| [message-persistence.md](docs/message-persistence.md) | 持久化设计 |

## 许可证

[MIT](LICENSE)