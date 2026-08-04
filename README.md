# Elf

A lightweight AI Agent platform. Agents think; the Gateway connects.

All Agents share one process (the **agent-server**), driven by a shared engine (`engine/`). The Gateway (`gateway/`) discovers and manages Agents and routes all chat through a unified Room model. A React UI (`frontend/`) is served by the Gateway — open your browser and go.

[中文文档](README_CN.md) · [MIT License](LICENSE)

## Features

- **Multi-Agent** — each Agent is a directory with its own config, system prompt, and tools; add one via the Web UI
- **Shared agent-server** — one Node.js process hosts all Agents on a single port
- **All chat is a Room** — private chat and group chat share the same Room model
- **ScenePlugin architecture** — `PrivateChatPlugin` / `RoomPlugin` own the buffer, message parsing, and reasoning gates
- **Unified flush loop** — buffer → mergeForReason → addUser → reasoning → postReason, same loop for all chat
- **Aggregated SSE** — all room events aggregated into one SSE connection, no browser connection limit issues
- **OpenAI-compatible models** — any `/chat/completions` endpoint, or mock mode without an API
- **Claude-Code-style tools** — Read, Write, Edit, Bash, Glob, Grep, Agent (subagent), Skill, Speak (group chat), Skip (observe), SetObserveConfig
- **Agent Loop** — LLM → parse → run tools → LLM, until text reply; bounded by `maxIterations`
- **Memory compaction** — async/blocking with frontend-visualized compression bubbles
- **Skills** — progressive-disclosure skills from `~/.elf/skills`, invokeable via the Skill tool
- **Group chat** — multi-Agent rooms, speak via the Speak tool
- **Observation strategy** — agents passively observe with keyword detection and timed flush triggers
- **Hot reload** — config and prompt file changes take effect without restart
- **Persistence & rewind** — append-only history + checkpoint snapshots; rewind to any prior checkpoint
- **Web UI** — React + Vite: sidebar, streaming bubbles, tool-call badges, diff rendering, config drawer, room chat, skill manager, rewind menu, avatars
- **File change detection** — automatic diff injection between reasoning turns
- **PromptAssembly** — 3-point injection (system, user wrap, trailing)
- **Zero heavy deps** — only `express` + `gpt-tokenizer`, uses built-in `fetch`

## Architecture

```
┌──────────┐  POST /subscribe    ┌──────────┐  HTTP  ┌──────────────────────┐
│  Web UI  │ ◄── aggregated ───► │ Gateway  │ ◄─────►│   Agent-server       │
│  React   │     SSE (1 conn)    │  :8080   │        │   :8180 (--serve-all)│
└──────────┘                     └──────────┘        │   hosts agents/*     │
                                    │                └──────────────────────┘
                                    │                        ▲
                                    │ /rooms/:rid/say        │ /observe (agentId+roomId)
                                    ▼                        │
                               ┌──────────┐                 │
                               │ RoomBus  │ (broadcast +     │
                               │          │  history)        │
                               └──────────┘                 │
                                                             │
                                    Private chat = Room      │
                                    chat-<agentId> ──────────┘
```

All chat is a Room. The Gateway owns the Room bus; the agent-server hosts room instances that receive `/observe` pushes and respond via the unified flush loop.

## Project Layout

```
elf/
├── engine/                 # Shared engine
│   ├── start.js            # Entry: startAgent / startAgentServer (--serve-all)
│   ├── agent.js            # Agent class + Agent Loop
│   ├── build_agent.js      # Agent assembly from config
│   ├── message_manager.js  # Chat history, memory compaction
│   ├── server.js           # HTTP service (multi-agent, room-aware)
│   ├── config_loader.js    # Config + api_key.json loader
│   ├── run_context.js      # Runtime identity (mode, port, room…)
│   ├── sync_source.js      # Message sync (SyncCursor + align algorithm)
│   ├── harness.js          # Middleware dispatch, abort
│   ├── models/             # LLMModel, MockModel
│   ├── tools/              # Read, Write, Edit, Bash, Glob, Grep, Agent, Skill, Speak, Skip, SetObserveConfig
│   ├── skills/             # Skill loader, parser, registry, lister
│   ├── subagents/          # Subagent registry
│   ├── prompt/             # PromptAssembler (3-point injection)
│   └── plugins/            # ScenePlugin, PrivateChatPlugin, RoomPlugin
├── shared/                 # Cross-cutting utils
│   ├── logger.js           # File + console, log rotation, per-agent routing
│   ├── tokenizer.js        # gpt-tokenizer wrapper
│   ├── profiles_paths.js   # Unified profiles/ path resolution
│   ├── agent_probe.js      # Port probing
│   └── turn-stream-contract.js
├── agents/<id>/            # Per-Agent directory
│   ├── config/
│   │   ├── config.json            # Agent settings & prompt paths
│   │   ├── api_key.json           # LLM credentials
│   │   ├── config-ui.json         # Config drawer layout
│   │   ├── system_prompt.md       # System prompt
│   │   ├── prefix_prompt.md       # Prefix (LLM only)
│   │   ├── suffix_prompt.md       # Suffix (LLM only)
│   │   ├── compact_prompt.md      # Compaction prompt
│   │   ├── compact_system_prompt.md
│   │   ├── loop_*_prompt.md       # Multi-loop prompts (DNDAgent)
│   │   ├── seeds/                 # Seed docs (DNDAgent)
│   │   └── avatar.webp
│   ├── create_agent.js            # Assembly function
│   ├── index.js                   # Dev entry
│   ├── agent.js                   # Custom Agent class override
│   └── message_manager.js         # Optional MM subclass
├── gateway/                 # HTTP Gateway
│   ├── index.js             # Main entry
│   ├── server.js            # REST + SSE routes, serves frontend/
│   ├── process_manager.js   # Process lifecycle (shared agent-server)
│   ├── room_bus.js          # RoomManager, RoomBroadcaster, RoomConfig, RoomHistory
│   ├── room_routes.js       # /rooms/* API
│   ├── private_room_stream.js  # Private SSE streaming
│   ├── turn-stream-server.js   # Multi-bubble streaming
│   ├── aggregated_stream.js    # Aggregated SSE broadcaster
│   ├── config.js            # gateway.json loader
│   ├── config_store.js      # Agent config read/write
│   ├── config-ui.js         # Config UI layout resolver
│   ├── avatar.js            # Avatar upload
│   ├── chat_history.js      # Chat history (JSONL)
│   ├── snapshot.js          # Checkpoint/rewind
│   ├── agent_scaffold.js    # Create new Agent from template
│   ├── agent_events.js      # /events SSE management
│   └── agent_template/      # Blank Agent template
├── frontend/                # React + Vite UI
│   ├── src/
│   │   ├── App.jsx
│   │   ├── api/index.js     # All fetch calls
│   │   ├── components/      # UI components
│   │   ├── hooks/           # useChat, useAgents, useRoomChat…
│   │   ├── stores/          # Zustand stores
│   │   └── utils/
│   └── vite.config.js
├── profiles/                # Runtime data
│   ├── agents/<id>/memory/     # Private chat memory
│   ├── agents/<id>/rooms/<rid>/ # Per-room memory
│   ├── rooms/<rid>/            # Room config + history
│   └── logs/
├── test/                    # node:test suites
├── docs/                    # Design docs
├── gateway.json             # Gateway config
├── package.json
├── README.md
├── README_CN.md
└── LEGAL.md
```

## Quick Start

Requires **Node.js 18+**.

```bash
# 1. Install dependencies (also installs frontend deps via postinstall)
npm install

# 2. Start the Gateway (builds frontend first, then launches the server)
npm start

# 3. Open browser → http://localhost:8080
```

That's it. The React UI is served directly by the Gateway on port **8080**. All Agent management (start, stop, configure, chat) is done through the Web UI.

### Configure LLM API Keys

Each Agent needs an API key to connect to an LLM. Open the browser, click an Agent in the sidebar, then click the **⚙️ Config** button → **"模型配置"** tab to fill in:

- **API Base URL** — e.g. `https://api.openai.com/v1`
- **Auth Token** — your API key
- **Model Name** — e.g. `gpt-4o`

After configuring, click **Start** to launch the Agent.

### Run without an LLM (Mock mode)

Set `"provider": "mock"` in the Agent's `config.json`, or set the environment variable:

```bash
ELF_FORCE_MOCK_MODEL=1 npm start
```

## Scripts

```bash
npm start              # Build frontend + start Gateway
npm stop               # Stop Gateway + agent-server + room replicas
npm restart            # stop then start
npm run dev:frontend   # Vite dev server (HMR at localhost:5173)
npm run build:frontend # Build frontend to frontend/dist/
npm test               # Run test suites (serial)
```

`npm stop` runs a cleanup script that kills the Gateway, the shared agent-server, and any leftover agent processes — use it to clean up after stopping.

## Add a New Agent

Open the Web UI and click the **"+"** button in the sidebar. Fill in the name and a new Agent is created from the template. Then configure its API key and system prompt in the config drawer.

Or to copy an existing Agent manually:

```bash
cp -r agents/elf-001 agents/elf-018
# Edit agents/elf-018/config/config.json → unique agentId + name
# Edit api_key.json → unique credentials
# Then click ⟳ Rediscover in the UI, or restart the Gateway
```

## Configure via the Web UI

All Agent settings are editable from the **⚙️ Config** drawer in the browser:

- **Basic** tab — Agent name, avatar
- **Model Config** tab — API base URL, auth token, model name
- **System Prompt** tab — system prompt, prefix, suffix, compaction prompts
- **Tools** tab — enable/disable tools, toggle skills and file change detection

The Gateway itself is configured via `gateway.json` at the project root:

```jsonc
{
  "port": 8080,                // HTTP port
  "agentServerPort": 8180,     // Agent-server port (all agents)
  "userName": "user",          // Your display name
  "userAvatar": null,          // Avatar filename in uploads/
  "userUid": "default_userid", // Stable identity (name can change)
  "sidebarOrder": {}           // Sidebar ordering
}
```

## License

[MIT](LICENSE). Per [LEGAL.md](LEGAL.md), Chinese comments in the source are the governing version.