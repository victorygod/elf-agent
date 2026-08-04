# Elf

轻量级 AI Agent 平台。Agent 负责「思考」，Gateway 负责「连接」。

所有 Agent 共享一个进程（**agent-server**），由共享引擎 `engine/` 驱动。Gateway (`gateway/`) 是薄 HTTP/SSE 层，发现并管理 Agent，通过统一的 Room 模型转发对话。Gateway 同时托管 React 前端 (`frontend/`)——打开浏览器即可使用。

[English](README.md) · [MIT License](LICENSE)

## 特性

- **多 Agent** — 每个 Agent 独立目录（配置 + 提示词 + 工具），Web UI 一键新增
- **共享 agent-server** — 一个 Node.js 进程承载所有 Agent，单端口通信
- **一切对话都是 Room** — 私聊与群聊共用同一 Room 模型
- **ScenePlugin 架构** — `PrivateChatPlugin` / `RoomPlugin` 持有 buffer 状态机与推理门控
- **统一 flush 循环** — buffer → mergeForReason → addUser → reasoning → postReason，所有对话共用
- **聚合 SSE** — 所有房间事件聚合到一条 SSE 连接，无浏览器连接上限问题
- **OpenAI 兼容模型** — 任意 `/chat/completions` 端点，或 Mock 模式免 API 运行
- **Claude Code 风格工具** — Read、Write、Edit、Bash、Glob、Grep、Agent（子 agent）、Skill、Speak（群聊）、Skip（观测式放弃）、SetObserveConfig（设关注词）
- **Agent Loop** — 调 LLM → 解析 → 执行工具 → 再调 LLM，直至文本回复
- **记忆压缩** — async/blocking 双模式，前端可视化压缩气泡
- **Skills** — 从 `~/.elf/skills` 加载的渐进式披露 skill，通过 Skill 工具调用
- **群聊** — 多 Agent 房间，通过 Speak 工具发言
- **观测策略** — Agent 可被动观测群聊，关键词 + 定时触发自主响应
- **热加载** — 配置 / 提示词文件变更即时生效，无需重启
- **持久化与回退** — 只追加历史 + 快照检查点；可回退到任意历史轮次
- **Web UI** — React + Vite：侧栏、流式气泡、工具调用标记、差异渲染、配置面板、群聊、skill 管理、回退、头像
- **文件变更检测** — 自动检测轮间文件变更并注入 diff
- **PromptAssembly** — 三点位注入系统（system、user 包装、末尾追加）
- **零重型依赖** — 仅 `express` + `gpt-tokenizer`，使用内置 `fetch`

## 架构

```
┌──────────┐  POST /subscribe    ┌──────────┐  HTTP  ┌──────────────────────┐
│  Web UI  │ ◄── 聚合 SSE ─────► │ Gateway  │ ◄─────►│   Agent-server       │
│  React   │     (单连接)        │  :8080   │        │   :8180 (--serve-all)│
└──────────┘                     └──────────┘        │   承载 agents/*      │
                                    │                └──────────────────────┘
                                    │                        ▲
                                    │ /rooms/:rid/say        │ /observe (agentId+roomId)
                                    ▼                        │
                               ┌──────────┐                 │
                               │ RoomBus  │ (广播 +          │
                               │          │  历史)           │
                               └──────────┘                 │
                                                             │
                                    私聊 = Room              │
                                    chat-<agentId> ──────────┘
```

一切对话都是 Room。Gateway 持有 Room 总线；agent-server 内的房间实例接收 `/observe` 推送，经统一 flush 循环响应。

## 目录结构

```
elf/
├── engine/                 # 共享引擎
│   ├── start.js            # 入口：startAgent / startAgentServer (--serve-all)
│   ├── agent.js            # Agent 类 + Agent Loop
│   ├── build_agent.js      # 从配置装配 Agent
│   ├── message_manager.js  # 对话历史、记忆压缩
│   ├── server.js           # HTTP 服务（多 Agent、房间感知）
│   ├── config_loader.js    # 配置加载器
│   ├── run_context.js      # 运行时身份（mode、port、room…）
│   ├── sync_source.js      # 消息同步（SyncCursor + 对齐算法）
│   ├── harness.js          # Middleware 调度、abort
│   ├── models/             # LLMModel、MockModel
│   ├── tools/              # Read, Write, Edit, Bash, Glob, Grep, Agent, Skill, Speak, Skip, SetObserveConfig
│   ├── skills/             # Skill 加载器、解析器、注册表、清单器
│   ├── subagents/          # 子 Agent 注册表
│   ├── prompt/             # PromptAssembler（三点位注入）
│   └── plugins/            # ScenePlugin, PrivateChatPlugin, RoomPlugin
├── shared/                 # 跨模块工具
│   ├── logger.js           # 日志（文件 + 控制台 + 日志滚动 + per-agent 路由）
│   ├── tokenizer.js        # gpt-tokenizer 封装
│   ├── profiles_paths.js   # 统一 profiles/ 路径解析
│   ├── agent_probe.js      # 端口探活
│   └── turn-stream-contract.js
├── agents/<id>/            # 每个 Agent 独立目录
│   ├── config/
│   │   ├── config.json              # Agent 配置与提示词路径
│   │   ├── api_key.json             # LLM 凭据
│   │   ├── config-ui.json           # 配置面板布局
│   │   ├── system_prompt.md         # 系统提示词
│   │   ├── prefix_prompt.md         # 前缀（仅 LLM）
│   │   ├── suffix_prompt.md         # 后缀（仅 LLM）
│   │   ├── compact_prompt.md        # 压缩提示词
│   │   ├── compact_system_prompt.md
│   │   ├── loop_*_prompt.md         # 多循环提示词（DNDAgent）
│   │   ├── seeds/                   # 运行时文档种子（DNDAgent）
│   │   └── avatar.webp
│   ├── create_agent.js      # 装配函数
│   ├── index.js             # 开发入口
│   ├── agent.js             # 自定义 Agent 类覆写
│   └── message_manager.js   # 可选 MM 子类
├── gateway/                 # HTTP 网关
│   ├── index.js             # 入口
│   ├── server.js            # REST + SSE 路由，服务前端
│   ├── process_manager.js   # 进程生命周期（共享 agent-server）
│   ├── room_bus.js          # RoomManager, RoomBroadcaster, RoomConfig, RoomHistory
│   ├── room_routes.js       # /rooms/* API
│   ├── private_room_stream.js  # 私聊 SSE 流式
│   ├── turn-stream-server.js   # 多气泡流式
│   ├── aggregated_stream.js    # 聚合 SSE 广播器
│   ├── config.js            # gateway.json 加载
│   ├── config_store.js      # Agent 配置读写
│   ├── config-ui.js         # 配置面板布局解析
│   ├── avatar.js            # 头像上传
│   ├── chat_history.js      # 聊天记录（JSONL）
│   ├── snapshot.js          # 快照与回退
│   ├── agent_scaffold.js    # 从模板创建新 Agent
│   ├── agent_events.js      # /events SSE 管理
│   └── agent_template/      # 空白 Agent 模板
├── frontend/                # React + Vite 前端
│   ├── src/
│   │   ├── App.jsx
│   │   ├── api/index.js     # 所有 fetch 请求
│   │   ├── components/      # UI 组件
│   │   ├── hooks/           # useChat, useAgents, useRoomChat…
│   │   ├── stores/          # Zustand 状态管理
│   │   └── utils/
│   └── vite.config.js
├── profiles/                # 运行时数据
│   ├── agents/<id>/memory/      # 私聊记忆
│   ├── agents/<id>/rooms/<rid>/ # 各群私有记忆
│   ├── rooms/<rid>/             # 群配置 + 历史
│   └── logs/
├── test/                    # node:test 测试套件
├── docs/                    # 设计文档
├── gateway.json             # 网关配置
├── package.json
├── README.md
├── README_CN.md
└── LEGAL.md
```

## 快速开始

环境要求 **Node.js 18+**。

```bash
# 1. 安装依赖（postinstall 会自动安装前端依赖）
npm install

# 2. 构建前端 + 启动 Gateway
npm start

# 3. 浏览器打开 → http://localhost:8080
```

前端页面由 Gateway 直接托管。所有 Agent 管理（启动、停止、配置、对话）均在 Web UI 内完成。

### 配置 LLM API 密钥

每个 Agent 都需要连接 LLM 服务。打开浏览器，点击侧栏的 Agent → 右上角 **⚙️ 配置** → **「模型配置」** 选项卡填写：

- **API Base URL** — 如 `https://api.openai.com/v1`
- **Auth Token** — 你的 API 密钥
- **模型名称** — 如 `gpt-4o`

配置完成后点击界面上的 **启动** 按钮即可运行 Agent。

### 无 LLM 运行（Mock 模式）

在 `config.json` 中设置 `"provider": "mock"`，或使用环境变量：

```bash
ELF_FORCE_MOCK_MODEL=1 npm start
```

## 常用命令

```bash
npm start              # 构建前端 + 启动 Gateway
npm stop               # 停止 Gateway + agent-server + 所有 Agent（运行 cleanup 脚本）
npm restart            # 先 stop 再 start
npm run dev:frontend   # Vite 前端热更新开发（localhost:5173）
npm run build:frontend # 构建前端到 frontend/dist/
npm test               # 运行测试套件（串行执行）
```

`npm stop` 会执行 cleanup 脚本，清理 Gateway、共享 agent-server 以及所有残留进程——关闭服务后用它清理即可。

## 添加新 Agent

打开 Web UI，点击侧栏底部的 **"+"** 按钮。输入名称即可从模板创建新 Agent。创建后在配置面板中填写 API 密钥和系统提示词即可使用。

手动复制现有 Agent：

```bash
cp -r agents/elf-001 agents/elf-018
# 编辑 agents/elf-018/config/config.json → 修改 agentId + name 为唯一值
# 编辑 api_key.json → 填写 API 凭据
# 在 UI 中点击 ⟳ 重新发现，或重启 Gateway
```

## Web UI 配置

所有 Agent 设置均可从浏览器中的 **⚙️ 配置** 面板编辑：

- **基础信息** — Agent 名称、头像
- **模型配置** — API 地址、Token、模型名
- **系统提示词** — system prompt、前缀、后缀、压缩提示词
- **工具** — 启用/禁用工具、skill、文件变更检测

Gateway 本身的配置在项目根目录的 `gateway.json`：

```jsonc
{
  "port": 8080,                // HTTP 端口
  "agentServerPort": 8180,     // Agent-server 端口（所有 Agent 共享）
  "userName": "user",          // 显示名
  "userAvatar": null,          // 头像文件名（位于 uploads/）
  "userUid": "default_userid", // 稳定身份（改名不影响历史归属）
  "sidebarOrder": {}           // 侧栏排序
}
```

## License

[MIT](LICENSE)。根据 [LEGAL.md](LEGAL.md)，源码中文注释为官方版本，一切冲突以中文为准。