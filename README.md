# Elf

A lightweight AI Agent platform. Agents think; the Gateway connects.

Each Agent runs as an independent detached Node.js process, driven by a shared engine (`engine/`) and carrying its own config, system prompt, and conversation state. The Gateway (`gateway/`) is a thin HTTP/SSE layer that discovers and manages Agent processes and routes chat. A React UI (`frontend/`) is served by the Gateway.

[中文文档](README_CN.md) · [MIT License](LICENSE)

## Features

- **Multi-Agent** — each Agent is a detached, directory-self-contained process (config + data); add one by copying a config folder or via the scaffold API
- **Shared engine** — one `engine/` powers every Agent: Agent Loop, model client, tool registry, message manager, prompt assembler, skills, subagents. Agents contribute only what differs via `agents/<id>/create_agent.js`
- **OpenAI-compatible models** — `LLMModel` calls any `/chat/completions` endpoint with native `fetch`; `MockModel` (`provider: "mock"`) runs without an API
- **Claude-Code-style tools** — `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, plus `Agent` (subagent), `Skill`, and `Speak`; registered per-Agent from `config.json`, extendable by exporting from `engine/tools/index.js`
- **Streaming chat** — SSE token streaming with tool-call and status events interleaved
- **Agent Loop** — LLM → parse → run tools → LLM, until a text reply; bounded by `maxIterations` (0 = unlimited)
- **Memory compaction** — summarize history after the token estimate exceeds `memoryTokenLimit`; supports `async`/`blocking` modes, micro-compaction, per-tool result limits, and a budget window
- **Skills** — progressive-disclosure skills loaded from `~/.elf/skills`, surfaced to the model via the `Skill` tool
- **Subagents** — the `Agent` tool spawns an isolated sub-agent (e.g. `Explore`, `general-purpose`) with a fresh context, enabled per-Agent via `config.subagents`
- **Rooms (group chat)** — multi-Agent rooms where members speak via the `Speak` tool; each member runs as a `--mode room` replica with its own per-room memory
- **Observation strategy** — an `observe` interaction mode where an Agent waits within a window before responding
- **Hot reload** — config and prompt file changes take effect without restart (private-chat mode) via `fs.watch`
- **Process management** — discover / start / stop / abort / probe / crash recovery; Agents are detached and survive Gateway restarts; room replicas are auto-restored
- **Persistence & rewind** — append-only `history.jsonl` plus checkpointed context; rewind to a prior checkpoint
- **Web UI** — React + Vite: sidebar, streaming bubbles, tool-call badges, edit-diff rendering, config drawer, room chat, skill manager, rewind menu, avatars
- **Zero heavy deps** — backend runtime is `express` + `gpt-tokenizer`, using Node.js built-in `fetch`

## Architecture

```
┌──────────┐  HTTP + SSE  ┌──────────┐  HTTP + SSE  ┌────────────────┐
│  Web UI  │ ◄──────────► │ Gateway  │ ◄──────────► │  Agent (8081+) │
│  React   │   REST API   │  :8080   │              │  detached proc │
└──────────┘              └──────────┘              └────────────────┘
                               │                          ▲
                               │ /rooms/:rid/say          │ /observe (replica)
                               ▼                          │
                          ┌─────────┐   spawn --mode room  │
                          │ RoomBus │ ─────────────────────┘
                          └─────────┘
```

Private chat is modeled as a Room whose id is `chat-<agentId>`; group chat is a Room with multiple Agent members. The Gateway owns the Room bus (broadcasting, history, replica registry); replicas call back into it to speak and receive `/observe` pushes.

Engine flow: `Config → Model (LLMModel/MockModel) → ToolManager → MessageManager → Agent Loop`.

## Project Layout

```
elf/
├── engine/                 # Shared engine
│   ├── start.js            # Agent entry point (startAgent)
│   ├── agent.js            # Agent class + runContext
│   ├── build_agent.js      # Agent assembly from config
│   ├── message_manager.js  # Chat history, memory compaction
│   ├── server.js           # Per-Agent HTTP service
│   ├── config_loader.js    # Config + api_key.json loader
│   ├── run_context.js      # Runtime identity (mode, port, room…)
│   ├── models/             # LLMModel, MockModel
│   ├── tools/              # Read, Write, Edit, Bash, Glob, Grep, …
│   ├── skills/             # Skill loader & parser
│   ├── subagents/          # Subagent registry
│   ├── prompt/             # Prompt assembler + injectors
│   └── plugins/            # RoomPlugin, PrivateChatPlugin, ScenePlugin
├── shared/                 # Cross-cutting utils
│   ├── logger.js
│   ├── tokenizer.js
│   ├── profiles_paths.js
│   ├── agent_probe.js
│   └── turn-stream-contract.js
├── agents/<id>/            # Per-Agent directory
│   ├── config/
│   │   ├── config.json          # Agent settings & prompt paths
│   │   ├── api_key.json         # LLM credentials (3 fields)
│   │   ├── config-ui.json       # Config drawer layout
│   │   ├── system_prompt.md     # System prompt
│   │   ├── prefix_prompt.md     # Prefix prompt (LLM only)
│   │   ├── suffix_prompt.md     # Suffix prompt (LLM only)
│   │   ├── compact_prompt.md    # Memory compaction prompt
│   │   ├── compact_system_prompt.md
│   │   └── avatar.webp / user_avatar.webp
│   ├── create_agent.js      # Assembly function (called by engine)
│   ├── index.js             # Dev entry: calls startAgent(configDir)
│   └── message_manager.js   # (optional) per-Agent MM override
├── gateway/                 # HTTP Gateway
│   ├── index.js             # Main entry: discovers agents, starts Express
│   ├── server.js            # REST + SSE routes, serves frontend/
│   ├── process_manager.js   # Agent process lifecycle (start/stop/probe)
│   ├── room_bus.js          # Group chat manager
│   ├── room_routes.js       # /rooms/* API
│   ├── private_room_stream.js
│   ├── config.js            # gateway.json loader/saver
│   ├── config_store.js      # Agent config read/write (config.json + api_key.json)
│   ├── config-ui.js         # Config UI layout resolver
│   ├── avatar.js            # Avatar upload handler
│   ├── chat_history.js      # Chat history manager
│   ├── snapshot.js          # Checkpoint/rewind
│   ├── agent_scaffold.js    # Create new Agent from template
│   ├── agent_template/      # Blank Agent template
│   └── skill_store.js       # ~/.elf/skills manager
├── frontend/                # React + Vite UI
│   ├── src/
│   │   ├── App.jsx            # Root component
│   │   ├── main.jsx
│   │   ├── api/index.js       # All fetch calls
│   │   ├── components/        # UI components
│   │   ├── hooks/             # Custom hooks
│   │   ├── stores/            # Zustand stores
│   │   └── utils/
│   └── vite.config.js
├── profiles/                # Runtime data (override with ELF_PROFILES_ROOT)
│   ├── agents/<id>/memory/     # Private-chat memory
│   ├── agents/<id>/rooms/<rid>/ # Per-room private memory
│   ├── rooms/<rid>/            # Room config + history
│   └── logs/
├── uploads/                 # User avatar uploads
├── test/                    # node:test suites (run serially)
├── docs/                    # Design docs
├── support_model_list.md    # Supported model names
├── gateway.json             # Gateway config (port, userName, sidebarOrder)
├── package.json
├── README.md
└── LEGAL.md
```

## Quick Start

Requires **Node.js 18+**.

```bash
# 1. Install dependencies (also installs frontend deps via postinstall)
npm install

# 2. Start the Gateway (builds frontend first, then launches the server)
npm start

# 3. Open browser
# → http://localhost:8080
```

That's it — `npm start` builds the React frontend into `frontend/dist/` and starts the Gateway on **port 8080**. The Web UI is served directly by the Gateway.

### Configure LLM API Keys

Each Agent needs its own `api_key.json` to connect to an LLM provider. There are two ways to configure this:

**Option A — Edit the file directly:**

```bash
# agents/elf-001/config/api_key.json
{
  "base_url": "https://api.openai.com/v1",
  "auth_token": "sk-your-api-key-here",
  "model": "gpt-4o"
}
```

The `model` field accepts any OpenAI-compatible model name. See [support_model_list.md](support_model_list.md) for tested models (huggingface/Qwen, OpenAI, Gemini, DeepSeek, Anthropic, etc.).

**Option B — Use the Web UI:**

1. Open http://localhost:8080 and click on an Agent
2. Click the **⚙️ Config** button (top-right)
3. Switch to the **"模型配置"** (Model Config) tab
4. Fill in `API Base URL`, `Auth Token`, and `Model Name`
5. Save — the change is written directly to `api_key.json`

After configuring, you must **start the Agent** (click "Start" in the UI, or `POST /agents/:id/start`). Agents do **not** auto-start after `npm start`.

### Run without an LLM (Mock mode)

Set `provider` to `"mock"` in `config.json` — the Agent will respond locally without any API calls:

```json
{
  "provider": "mock"
}
```

Or set the environment variable `ELF_FORCE_MOCK_MODEL=1` before starting to force mock mode for all Agents.

## Scripts

```bash
npm start              # Build frontend + start Gateway → http://localhost:8080
npm stop               # Stop Gateway + all Agents + room replicas, free ports
npm restart            # stop then start
npm run dev:frontend   # Vite dev server for frontend (HMR at localhost:5173)
npm run build:frontend # Build frontend to frontend/dist/
npm test               # Run test suites (serial, requires cleanup first)
```

## Gateway Config (`gateway.json`)

| Field | Description | Default |
|-------|-------------|---------|
| `port` | HTTP port | `8080` |
| `userName` | Display name in UI | `"user"` |
| `userAvatar` | User avatar filename (in `uploads/`) | `null` |
| `sidebarOrder` | Manual sidebar ordering `{rooms:[], agents:[]}` | `{}` |

## Agent Config (`config.json`)

```jsonc
{
  "agentId": "elf-002",
  "name": "Coding Agent",
  "port": 8082,
  "provider": "llm",                       // or "mock"
  "systemPrompt": { "type": "path", "content": "system_prompt.md" },
  "prefix_prompt": { "type": "path", "content": "prefix_prompt.md" },
  "suffix_prompt": { "type": "path", "content": "suffix_prompt.md" },
  "compactPrompt": { "type": "path", "content": "compact_prompt.md" },
  "compactMode": "async",                  // or "blocking"
  "memoryTokenLimit": 40000,
  "maxIterations": 0,                      // 0 = unlimited
  "interaction": { "strategy": "observe" },
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "Skill"],
  "subagents": ["Explore", "general-purpose"],
  "skills": true,
  "_ui": { "name": { "label": "Agent Name", "hint": "Shown in the UI" } }
}
```

- Fields with `{ "type": "path", "content": "filename" }` are loaded from the config directory and **hot-reloaded** on file change.
- `_ui` fields annotate the config drawer layout in the Web UI.

## Add a New Agent

**Via the Web UI:** click the "+" button in the sidebar.

**Via API (scaffold from template):**

```bash
curl -X POST http://localhost:8080/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"My New Agent"}'
```

**Manually:**

```bash
cp -r agents/elf-001 agents/elf-018
# Edit agents/elf-018/config/{config.json, api_key.json, system_prompt.md}
#   → unique agentId + name, a free port, desired tools/limits
# Clean memory (optional): rm -rf profiles/agents/elf-018
# Trigger discovery:
curl -X POST http://localhost:8080/agents/rediscover
```

## API Reference

### Agent Management

```bash
curl http://localhost:8080/agents                        # List all agents
curl -X POST http://localhost:8080/agents/rediscover      # Re-scan filesystem
curl http://localhost:8080/available-tools                # Available tool names
curl http://localhost:8080/agents/:id                     # Agent details
curl -X POST http://localhost:8080/agents/:id/start       # Start an agent
curl -X POST http://localhost:8080/agents/:id/stop        # Stop an agent
```

### Configuration

```bash
curl http://localhost:8080/agents/:id/config              # Read config
curl -X PUT http://localhost:8080/agents/:id/config \     # Update config (writes config.json + api_key.json)
  -H "Content-Type: application/json" \
  -d '{"name":"New Name"}'
curl http://localhost:8080/agents/:id/config-ui           # Config UI layout + data
```

### Private Chat (Rooms)

Private chat is a Room with id `chat-<agentId>`.

```bash
# Subscribe to SSE event stream
curl -N http://localhost:8080/rooms/chat-:id/subscribe

# Send a message
curl -N -X POST http://localhost:8080/rooms/chat-:id/say \
  -H "Content-Type: application/json" \
  -H "X-Speaker-Id: user" \
  -d '{"content":"Hello"}'

# History
curl "http://localhost:8080/rooms/chat-:id/history?limit=30"

# Clear history / memory
curl -X DELETE http://localhost:8080/rooms/chat-:id/history
curl -X DELETE http://localhost:8080/rooms/chat-:id/memory

# Rewind (rollback to a checkpoint)
curl http://localhost:8080/rooms/chat-:id/checkpoints
curl -X POST http://localhost:8080/rooms/chat-:id/rewind \
  -H "Content-Type: application/json" -d '{}'
```

### Group Rooms

```bash
curl -X POST http://localhost:8080/rooms \
  -H "Content-Type: application/json" \
  -d '{"name":"Team","members":["elf-001","elf-002"]}'

curl -X POST http://localhost:8080/rooms/:rid/members \
  -H "Content-Type: application/json" \
  -d '{"agentId":"elf-005"}'

curl -X POST http://localhost:8080/rooms/:rid/start-all   # Start all members
curl -X POST http://localhost:8080/rooms/:rid/abort        # Abort all members
```

### Skills

```bash
curl http://localhost:8080/skills
curl -X POST http://localhost:8080/skills/install \
  -H "Content-Type: application/json" \
  -d '{"sourcePath":"./my-skill"}'
```

### Settings

```bash
curl http://localhost:8080/settings                       # Read
curl -X PUT http://localhost:8080/settings \               # Update (userName, userAvatar, userUid)
  -H "Content-Type: application/json" \
  -d '{"userName":"Wolf"}'
```

## License

[MIT](LICENSE). Per [LEGAL.md](LEGAL.md), Chinese comments in the source are the governing version.