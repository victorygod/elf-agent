<div align="center">

# 🧝 Elf

轻量级 AI Agent 平台。

Agent 负责「思考」，Gateway 负责「连接」。每个 Agent 以独立 Node.js 进程运行，拥有专属配置、System Prompt 与对话上下文。

[English](README.md) · [MIT License](LICENSE)

</div>

## 特性

- **多 Agent** — 每个 Agent 独立进程，目录自包含（代码 + 配置 + 数据）
- **流式对话** — 基于 SSE 逐 token 推送
- **工具调用** — 支持 LLM Function Calling（内置 `read_file`，可扩展）
- **记忆压缩** — Token 超限时自动摘要历史
- **热加载** — 修改配置即生效，无需重启
- **进程管理** — 启动 / 停止 / 重启 / 崩溃恢复
- **双持久化** — `context.json`（LLM 上下文）+ `history.jsonl`（只追加日志）
- **Web UI** — 微信风格聊天界面 + 配置面板
- **Mock 模式** — 内置 MockModel，无需 LLM API 即可测试
- **零重型依赖** — 运行时仅依赖 `express`

## 架构

```
┌──────────┐    HTTP + SSE    ┌──────────┐    HTTP + SSE    ┌──────────┐
│  Web UI  │ ◄──────────────► │ Gateway  │ ◄──────────────► │  Agent   │
│          │    REST API      │  :8080   │                  │  :8081   │
└──────────┘                  └──────────┘                  └──────────┘
                                  │
                                  │          ◄──────────────► ┌──────────┐
                                  │          /chat, /config   │  Agent   │
                                  └────────────────────────── │  :8082   │
                                                              └──────────┘
```

## 快速开始

**环境要求：** Node.js 18+

```bash
git clone https://github.com/your-username/elf.git
cd elf
npm install
```

配置 LLM 凭据：

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
npm start    # 启动  → http://localhost:8080
npm stop     # 停止
npm test     # 测试
```

## 添加新 Agent

```bash
cp -r agents/elf-001 agents/elf-003
# 编辑 agents/elf-003/config/{config.json, api_key.json, system_prompt.md}
# 修改 config.json 中的 agentId、name、port
# 清理：rm agents/elf-003/data/*
# 重启 Gateway 即自动发现
```

## API

```bash
# 聊天（SSE 流式）
curl -N http://localhost:8080/agents/elf-001/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "你好"}'

# 进程管理
curl -X POST http://localhost:8080/agents/elf-001/start
curl -X POST http://localhost:8080/agents/elf-001/stop
curl -X POST http://localhost:8080/agents/elf-001/restart
curl http://localhost:8080/agents/elf-001/status

# 配置
curl http://localhost:8080/agents/elf-001/config
curl -X PUT http://localhost:8080/agents/elf-001/config/system_prompt \
  -H "Content-Type: application/json" \
  -d '{"content": "你是一个有用的助手"}'
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