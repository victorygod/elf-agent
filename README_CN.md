# Elf

轻量级 AI Agent 平台。Agent 负责「思考」，Gateway 负责「连接」。

每个 Agent 以独立 detached Node.js 进程运行，由共享引擎 `engine/` 驱动，独享配置、System Prompt 与对话状态。Gateway(`gateway/`)是薄 HTTP/SSE 层，负责发现并管理 Agent 进程、转发对话。Gateway 同时托管 React 前端(`frontend/`)。

[English](README.md) · [MIT License](LICENSE)

## 特性

- **多 Agent** — 每个 Agent 是独立 detached 进程，目录自包含（配置 + 数据）；拷贝目录或经脚手架 API 即可接入新 Agent
- **共享引擎** — 所有 Agent 共用 `engine/`：Agent Loop、模型客户端、工具注册表、消息管理器、提示词装配器、skills、子 agent。差异由各 `agents/<id>/create_agent.js` 贡献
- **OpenAI 兼容模型** — `LLMModel` 用内置 `fetch` 调任意 `/chat/completions` 端点；`MockModel`（`provider: "mock"`）无需 API 即可运行
- **Claude Code 风格工具** — `Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep`，以及 `Agent`（子 agent）、`Skill`、`Speak`；按 `config.json` 注册，在 `engine/tools/index.js` 加 export 即可扩展
- **流式对话** — 基于 SSE 逐 token 推送，并交织工具调用 / 状态事件
- **Agent Loop** — 调 LLM → 解析 → 执行工具 → 再调 LLM，直至得到文本回复；由 `maxIterations` 约束（0 = 无限）
- **记忆压缩** — 估算 token 超过 `memoryTokenLimit` 时自动摘要；支持 `async`/`blocking` 模式、微压缩、单工具结果限制与预算窗口
- **Skills** — 从 `~/.elf/skills` 加载渐进式披露的 skill，经 `Skill` 工具暴露给模型
- **子 Agent** — `Agent` 工具拉起独立子 agent（如 `Explore`、`general-purpose`），零上下文，按 `config.subagents` 启用
- **群聊房间** — 多 Agent 房间，成员经 `Speak` 工具发言；每个成员以 `--mode room` 副本运行，独享该群记忆
- **观察策略** — `observe` 交互模式：Agent 在窗口时间内静候后再回应
- **热加载** — 配置 / 提示词文件变更即生效，无需重启（私聊模式，基于 `fs.watch`）
- **进程管理** — 发现 / 启动 / 停止 / 中断 / 探活 / 崩溃恢复；Agent 为 detached 进程，Gateway 重启不影响；群聊副本自动恢复
- **持久化与回退** — 只追加 `history.jsonl` + 快照化上下文；可回退到历史检查点
- **Web UI** — React + Vite：侧边栏、流式气泡、工具调用标记、编辑差异渲染、配置抽屉、群聊、skill 管理、回退菜单、头像
- **零重型依赖** — 后端运行时仅 `express` + `gpt-tokenizer`，使用 Node.js 内置 `fetch`

## 架构

```
┌──────────┐  HTTP + SSE  ┌──────────┐  HTTP + SSE  ┌────────────────┐
│  Web UI  │ ◄──────────► │ Gateway  │ ◄──────────► │  Agent (8081+) │
│  React   │   REST API   │  :8080   │              │  detached 进程 │
└──────────┘              └──────────┘              └────────────────┘
                               │                          ▲
                               │ /rooms/:rid/say          │ /observe（副本）
                               ▼                          │
                          ┌─────────┐   spawn --mode room  │
                          │ RoomBus │ ─────────────────────┘
                          └─────────┘
```

私聊建模为 id 为 `chat-<agentId>` 的 Room；群聊为多 Agent 成员的 Room。Gateway 持有 Room 总线（广播、历史、副本注册表）；副本经它发言并接收 `/observe` 推送。

引擎流：`Config → Model（LLMModel/MockModel）→ ToolManager → MessageManager → Agent Loop`。

## 目录结构

```
engine/        共享引擎：start.js、agent.js、build_agent.js、message_manager.js、
               models/、tools/、skills/、subagents/、prompt/、plugins/、server.js
shared/        横切工具：logger、tokenizer、profiles_paths、agent_probe、turn-stream-contract
agents/<id>/   单个 Agent：config/（config.json、api_key.json、提示词、头像）、
               create_agent.js（装配）、index.js（入口），可选 message_manager.js
gateway/       HTTP 网关：server.js、process_manager.js、room_bus.js、room_routes.js、
               private_room_stream.js、snapshot.js、config_store.js、config-ui.js、
               skill_store.js、agent_scaffold.js、agent_template/
frontend/      React + Vite 界面，构建到 frontend/dist/，由 Gateway 提供服务
profiles/      运行时数据（见下）；根目录可用 ELF_PROFILES_ROOT 覆盖
test/          node:test 测试套件 —— 串行执行（见 npm test）
```

`profiles/` 运行时数据布局：

```
agents/<id>/memory/      私聊记忆（context、工具结果、检查点、同步游标）
agents/<id>/rooms/<rid>/ 该 agent 在各群的私有记忆
rooms/<rid>/             群配置 + 历史 + 副本运行状态
rooms/chat-<id>/         私聊房（仅历史）
logs/                    日志文件
```

## 快速开始

环境要求 Node.js 18+。

```bash
npm install      # postinstall 会一并安装前端依赖
```

在每个 Agent 的 `api_key.json` 中填入 LLM 凭据（任意 OpenAI 兼容端点）：

```bash
# agents/elf-001/config/api_key.json
{
  "base_url": "https://api.openai.com/v1",
  "auth_token": "sk-your-api-key",
  "model": "gpt-4o"
}
```

```bash
npm start              # 构建前端 + 启动 Gateway → http://localhost:8080
npm stop               # 停止 Gateway + Agent + 群聊副本，释放端口
npm restart            # 停止后重新启动
npm run dev:frontend   # 前端 Vite 开发服务器
npm test               # 运行测试套件（串行）
```

Agent 不会自动启动。请在 Web UI 或 `POST /agents/:id/start` 启动。

## Agent 配置 (`config.json`)

```jsonc
{
  "agentId": "elf-002",
  "name": "Coding Agent",
  "port": 8082,
  "provider": "llm",                       // 或 "mock"
  "systemPrompt": { "type": "path", "content": "system_prompt.md" },
  "prefix_prompt": { "type": "path", "content": "prefix_prompt.md" },  // 仅 LLM，不入记忆
  "suffix_prompt": { "type": "path", "content": "suffix_prompt.md" },  // 仅 LLM，不入记忆
  "compactPrompt": { "type": "path", "content": "compact_prompt.md" },
  "compactMode": "async",                  // 或 "blocking"
  "memoryTokenLimit": 400000,
  "maxIterations": 0,                      // 0 = 无限迭代
  "interaction": { "strategy": "observe" },
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "Skill"],
  "subagents": ["Explore", "general-purpose"],
  "skills": true,
  "_ui": { "name": { "label": "Agent 名称", "hint": "界面显示名" } }
}
```

`{ "type": "path", "content": "<文件>" }` 类型字段从配置目录加载并热更新；`_ui` 字段用于配置抽屉的界面标注。

## 添加新 Agent

经 UI，或经脚手架端点（从 `gateway/agent_template/` 创建白板 Agent）：

```bash
curl -X POST http://localhost:8080/agents -H "Content-Type: application/json" -d '{"name":"My Agent"}'
curl -X POST http://localhost:8080/agents/rediscover
```

或手动：

```bash
cp -r agents/elf-001 agents/elf-018
# 编辑 agents/elf-018/config/{config.json, api_key.json, system_prompt.md}:
#   唯一的 agentId + name、空闲端口、所需工具/限额
# 清理记忆：rm -rf profiles/agents/elf-018
# 之后重启 Gateway 或 POST /agents/rediscover
```

## API

Agent 与进程控制：

```bash
curl http://localhost:8080/agents                        # 列表
curl -X POST http://localhost:8080/agents/rediscover      # 重新扫描文件系统
curl http://localhost:8080/available-tools
curl -X POST http://localhost:8080/agents/elf-001/start
curl -X POST http://localhost:8080/agents/elf-001/stop
curl http://localhost:8080/agents/elf-001/config
curl -X PUT http://localhost:8080/agents/elf-001/config -H "Content-Type: application/json" \
  -d '{"name":"新名字"}'
```

对话经 Rooms API 投递。私聊房 id 为 `chat-<agentId>`：

```bash
# 订阅房间事件流
curl -N http://localhost:8080/rooms/chat-elf-001/subscribe

# 发言（X-Speaker-Id: user 或 agentId）
curl -N -X POST http://localhost:8080/rooms/chat-elf-001/say \
  -H "Content-Type: application/json" -H "X-Speaker-Id: user" \
  -d '{"message":"你好"}'

# 历史、记忆、回退
curl "http://localhost:8080/rooms/chat-elf-001/history?limit=30"
curl -X DELETE http://localhost:8080/rooms/chat-elf-001/history
curl -X DELETE http://localhost:8080/rooms/chat-elf-001/memory
curl http://localhost:8080/rooms/chat-elf-001/checkpoints
curl -X POST http://localhost:8080/rooms/chat-elf-001/rewind -H "Content-Type: application/json" -d '{}'
```

群聊房间：

```bash
curl -X POST http://localhost:8080/rooms -H "Content-Type: application/json" \
  -d '{"name":"Team","members":["elf-001","elf-002"]}'
curl http://localhost:8080/rooms
curl -X POST http://localhost:8080/rooms/<rid>/members -H "Content-Type: application/json" -d '{"agentId":"elf-005"}'
curl -X POST http://localhost:8080/rooms/<rid>/start-all
curl -X POST http://localhost:8080/rooms/<rid>/abort
```

Skills 与设置：

```bash
curl http://localhost:8080/skills
curl -X POST http://localhost:8080/skills/install -H "Content-Type: application/json" -d '{"sourcePath":"./my-skill"}'
curl http://localhost:8080/settings
```

## 许可证

[MIT](LICENSE)。根据 [LEGAL.md](LEGAL.md)，源码中文注释为官方版本，一切冲突以中文为准。