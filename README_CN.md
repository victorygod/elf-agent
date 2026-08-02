# Elf

轻量级 AI Agent 平台。Agent 负责「思考」，Gateway 负责「连接」。

每个 Agent 以独立 detached Node.js 进程运行，由共享引擎 `engine/` 驱动，独享配置、System Prompt 与对话状态。Gateway (`gateway/`) 是薄 HTTP/SSE 层，负责发现并管理 Agent 进程、转发对话。Gateway 同时托管 React 前端 (`frontend/`)。

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
elf/
├── engine/                 # 共享引擎
│   ├── start.js            # Agent 入口（startAgent）
│   ├── agent.js            # Agent 类 + runContext
│   ├── build_agent.js      # 根据配置装配 Agent
│   ├── message_manager.js  # 对话历史、记忆压缩
│   ├── server.js           # 每 Agent 的 HTTP 服务
│   ├── config_loader.js    # 加载 config.json + api_key.json
│   ├── run_context.js      # 运行时身份（mode、port、room…）
│   ├── models/             # LLMModel、MockModel
│   ├── tools/              # Read, Write, Edit, Bash, Glob, Grep 等
│   ├── skills/             # Skill 加载器与解析器
│   ├── subagents/          # 子 Agent 注册表
│   ├── prompt/             # 提示词装配器 + 注入器
│   └── plugins/            # RoomPlugin, PrivateChatPlugin, ScenePlugin
├── shared/                 # 跨模块工具
│   ├── logger.js
│   ├── tokenizer.js
│   ├── profiles_paths.js
│   ├── agent_probe.js
│   └── turn-stream-contract.js
├── agents/<id>/            # 每个 Agent 独立目录
│   ├── config/
│   │   ├── config.json              # Agent 配置与提示词路径
│   │   ├── api_key.json             # LLM 凭据（3 个字段）
│   │   ├── config-ui.json           # 配置面板布局
│   │   ├── system_prompt.md         # 系统提示词
│   │   ├── prefix_prompt.md         # 前缀提示词（仅 LLM，不入记忆）
│   │   ├── suffix_prompt.md         # 后缀提示词（仅 LLM，不入记忆）
│   │   ├── compact_prompt.md        # 记忆压缩提示词
│   │   ├── compact_system_prompt.md # 压缩系统提示词
│   │   └── avatar.webp / user_avatar.webp
│   ├── create_agent.js      # 装配函数（由 engine 调用）
│   ├── index.js             # 开发入口：调用 startAgent(configDir)
│   └── message_manager.js   #（可选）自定义消息管理器
├── gateway/                 # HTTP 网关
│   ├── index.js             # 入口：扫描 Agent、启动 Express
│   ├── server.js            # REST + SSE 路由，服务前端
│   ├── process_manager.js   # Agent 进程生命周期管理
│   ├── room_bus.js          # 群聊管理器
│   ├── room_routes.js       # /rooms/* 路由
│   ├── private_room_stream.js
│   ├── config.js            # gateway.json 加载/保存
│   ├── config_store.js      # Agent 配置读写
│   ├── config-ui.js         # 配置面板布局解析
│   ├── avatar.js            # 头像上传
│   ├── chat_history.js      # 对话历史管理
│   ├── snapshot.js          # 快照与回退
│   ├── agent_scaffold.js    # 从模板创建新 Agent
│   ├── agent_template/      # 空白 Agent 模板
│   └── skill_store.js       # ~/.elf/skills 管理
├── frontend/                # React + Vite 前端
│   ├── src/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   ├── api/index.js     # 所有 fetch 请求
│   │   ├── components/      # UI 组件
│   │   ├── hooks/           # 自定义 Hooks
│   │   ├── stores/          # Zustand 状态管理
│   │   └── utils/
│   └── vite.config.js
├── profiles/                # 运行时数据（可用 ELF_PROFILES_ROOT 覆盖根目录）
│   ├── agents/<id>/memory/      # 私聊记忆
│   ├── agents/<id>/rooms/<rid>/ # 各群私有记忆
│   ├── rooms/<rid>/             # 群配置 + 历史
│   └── logs/                    # 日志文件
├── uploads/                 # 用户头像上传
├── test/                    # node:test 测试套件（串行执行）
├── docs/                    # 设计文档
├── support_model_list.md    # 支持的模型列表
├── gateway.json             # 网关配置
├── package.json
├── README.md
└── LEGAL.md
```

## 快速开始

环境要求 **Node.js 18+**。

```bash
# 1. 安装依赖（postinstall 会一并安装前端依赖）
npm install

# 2. 启动网关（先构建前端，然后启动 Gateway）
npm start

# 3. 浏览器打开
# → http://localhost:8080
```

`npm start` 会构建 React 前端到 `frontend/dist/`，然后在 **8080 端口**启动 Gateway。前端页面由 Gateway 直接托管。

### 配置 LLM API 密钥

每个 Agent 都需要自己的 `api_key.json` 来连接 LLM 服务。有两种配置方式：

**方式一 — 直接编辑文件：**

```bash
# agents/elf-001/config/api_key.json
{
  "base_url": "https://api.openai.com/v1",
  "auth_token": "sk-your-api-key-here",
  "model": "gpt-4o"
}
```

`model` 字段支持任意 OpenAI 兼容的模型名。参考 [support_model_list.md](support_model_list.md) 查看已测试的模型（Qwen、OpenAI、Gemini、DeepSeek、Anthropic 等）。

**方式二 — 在 Web UI 中配置：**

1. 打开 http://localhost:8080，点击某个 Agent
2. 点击右上角的 **⚙️ 配置** 按钮
3. 切换到 **「模型配置」** 选项卡
4. 填写 `API Base URL`、`Auth Token`、`模型名称`（即 model 字段）
5. 保存 — 修改会直接写入 `api_key.json`

配置完成后，必须**手动启动 Agent**（在界面点击"启动"，或发送 `POST /agents/:id/start`）。Agent 在 `npm start` 后**不会自动启动**。

### 无 LLM 运行（Mock 模式）

将 `config.json` 中的 `provider` 设为 `"mock"`，Agent 会在本地响应，无需调用任何 API：

```json
{
  "provider": "mock"
}
```

或在启动前设置环境变量 `ELF_FORCE_MOCK_MODEL=1`，强制所有 Agent 进入 Mock 模式。

## 常用命令

```bash
npm start              # 构建前端 + 启动 Gateway → http://localhost:8080
npm stop               # 停止 Gateway + 所有 Agent + 群聊副本，释放端口
npm restart            # 先 stop 再 start
npm run dev:frontend   # 前端 Vite 开发服务器（热更新，localhost:5173）
npm run build:frontend # 构建前端到 frontend/dist/
npm test               # 运行测试套件（串行执行）
```

## 网关配置（`gateway.json`）

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `port` | HTTP 端口 | `8080` |
| `userName` | 界面显示的用户名 | `"user"` |
| `userAvatar` | 用户头像文件名（位于 `uploads/`） | `null` |
| `sidebarOrder` | 侧栏手动排序 `{rooms:[], agents:[]}` | `{}` |

## Agent 配置（`config.json`）

```jsonc
{
  "agentId": "elf-002",
  "name": "编程助手",
  "port": 8082,
  "provider": "llm",                       // 或 "mock"
  "systemPrompt": { "type": "path", "content": "system_prompt.md" },
  "prefix_prompt": { "type": "path", "content": "prefix_prompt.md" },
  "suffix_prompt": { "type": "path", "content": "suffix_prompt.md" },
  "compactPrompt": { "type": "path", "content": "compact_prompt.md" },
  "compactMode": "async",                  // 或 "blocking"
  "memoryTokenLimit": 40000,
  "maxIterations": 0,                      // 0 = 无限循环
  "interaction": { "strategy": "observe" },
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "Skill"],
  "subagents": ["Explore", "general-purpose"],
  "skills": true,
  "_ui": { "name": { "label": "Agent 名称", "hint": "界面显示名" } }
}
```

- `{ "type": "path", "content": "文件名" }` 类型的字段从配置目录加载，并支持**热更新**（修改文件后自动生效，无需重启）
- `_ui` 字段用于在 Web UI 的配置抽屉中标注界面布局

## 添加新 Agent

**通过 Web UI：** 点击侧栏的 "+" 按钮。

**通过 API（从模板创建）：**

```bash
curl -X POST http://localhost:8080/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"我的新Agent"}'
```

**手动创建：**

```bash
cp -r agents/elf-001 agents/elf-018
# 编辑 agents/elf-018/config/{config.json, api_key.json, system_prompt.md}
#   → 唯一的 agentId + name，空闲端口，所需的工具/限额
# 清理记忆（可选）：rm -rf profiles/agents/elf-018
# 触发重新发现：
curl -X POST http://localhost:8080/agents/rediscover
```

## API 参考

### Agent 管理

```bash
curl http://localhost:8080/agents                        # 列出所有 Agent
curl -X POST http://localhost:8080/agents/rediscover      # 重新扫描文件系统
curl http://localhost:8080/available-tools                # 可用工具列表
curl http://localhost:8080/agents/:id                     # Agent 详情
curl -X POST http://localhost:8080/agents/:id/start       # 启动 Agent
curl -X POST http://localhost:8080/agents/:id/stop        # 停止 Agent
```

### 配置管理

```bash
curl http://localhost:8080/agents/:id/config              # 读取配置
curl -X PUT http://localhost:8080/agents/:id/config \     # 更新配置（写入 config.json + api_key.json）
  -H "Content-Type: application/json" \
  -d '{"name":"新名字"}'
curl http://localhost:8080/agents/:id/config-ui           # 配置面板布局 + 数据
```

### 私聊（Rooms）

私聊是一个 id 为 `chat-<agentId>` 的 Room。

```bash
# 订阅 SSE 事件流
curl -N http://localhost:8080/rooms/chat-:id/subscribe

# 发送消息
curl -N -X POST http://localhost:8080/rooms/chat-:id/say \
  -H "Content-Type: application/json" \
  -H "X-Speaker-Id: user" \
  -d '{"content":"你好"}'

# 查看历史
curl "http://localhost:8080/rooms/chat-:id/history?limit=30"

# 清空历史 / 记忆
curl -X DELETE http://localhost:8080/rooms/chat-:id/history
curl -X DELETE http://localhost:8080/rooms/chat-:id/memory

# 回退到指定快照
curl http://localhost:8080/rooms/chat-:id/checkpoints
curl -X POST http://localhost:8080/rooms/chat-:id/rewind \
  -H "Content-Type: application/json" -d '{}'
```

### 群聊房间

```bash
curl -X POST http://localhost:8080/rooms \
  -H "Content-Type: application/json" \
  -d '{"name":"团队","members":["elf-001","elf-002"]}'

curl -X POST http://localhost:8080/rooms/:rid/members \
  -H "Content-Type: application/json" \
  -d '{"agentId":"elf-005"}'

curl -X POST http://localhost:8080/rooms/:rid/start-all   # 启动所有成员
curl -X POST http://localhost:8080/rooms/:rid/abort        # 中断所有成员
```

### Skills

```bash
curl http://localhost:8080/skills
curl -X POST http://localhost:8080/skills/install \
  -H "Content-Type: application/json" \
  -d '{"sourcePath":"./my-skill"}'
```

### 全局设置

```bash
curl http://localhost:8080/settings                       # 读取设置
curl -X PUT http://localhost:8080/settings \               # 更新设置（userName, userAvatar, userUid）
  -H "Content-Type: application/json" \
  -d '{"userName":"Wolf"}'
```

## 许可证

[MIT](LICENSE)。根据 [LEGAL.md](LEGAL.md)，源码中文注释为官方版本，一切冲突以中文为准。