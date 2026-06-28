<div align="center">

# 🧝 Elf

A lightweight AI Agent platform.

Agent thinks, Gateway connects. Each Agent runs as an independent Node.js process powered by a shared core (`shared/agent/`) and its own config, system prompt, and conversation context — to which it contributes only what's unique.

[中文文档](README_CN.md) · [MIT License](LICENSE)

</div>

## Features

- **Multi-Agent** — Each Agent is an independent detached process, directory-self-contained (config + data); plug in a new one by copying a config folder
- **Shared Core** — All Agents share one engine (`shared/agent/`): Agent Loop, model client, tool registry, message manager. Agents override only what differs via `agentClass` / `messageManagerClass`
- **Claude-Code-style Tools** — Built-in `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`; register per-Agent via `config.json` `tools` array, extendable by adding an export to `tools/index.js`
- **Streaming Chat** — SSE-based real-time token streaming, with tool-call / status events interleaved
- **Agent Loop** — Classic loop: LLM → parse → run tools → LLM → … until a text reply; bounded by `maxIterations` (0 = unlimited)
- **Memory Compaction** — Auto-summarize conversation history when the token estimate exceeds `memoryTokenLimit`; elf-002 compresses inside the loop (before each LLM call) to bound context mid-task
- **Prefix / Suffix Prompts** — Inject prompts around the latest user message for the LLM only, never written to memory (elf-001)
- **Hot Reload** — Config / prompt file changes take effect without restart via `fs.watch`
- **Process Management** — Discover / start / stop / abort / restart / crash recovery via Gateway; Agents are detached so they survive Gateway restarts
- **Dual Persistence** — `data/context.json` (LLM context) + `data/history.jsonl` (append-only chat log, paginated)
- **Web UI** — React + Vite chat interface: sidebar, streaming bubbles, tool-call badges, config drawer, edit-diff rendering
- **Mock Mode** — Built-in `MockModel` (`provider: "mock"`) for testing without an LLM API
- **Zero Heavy Deps** — Backend runtime dependency is just `express`; uses Node.js built-in `fetch`

## Architecture

```
┌──────────┐    HTTP + SSE    ┌──────────┐    HTTP + SSE    ┌──────────┐
│  Web UI  │ ◄──────────────► │ Gateway  │ ◄──────────────► │  Agent   │
│ React    │    REST API      │  :8080   │                  │  :8081   │
└──────────┘                  └──────────┘                  └──────────┘
                                  │ detached process
                                  │          ◄──────────────► ┌──────────┐
                                  │          /chat, /config   │  Agent   │
                                  └────────────────────────── │  :8082   │
                                                              └──────────┘

Agent (shared/agent/): Config → Model(LLMModel/MockModel) → ToolRegistry → MessageManager → Agent Loop
```

## Project Layout

```
shared/agent/      # Shared engine: start.js, default_agent.js, llm_model.js,
                   #   mock_model.js, message_manager.js, config_loader.js, server.js, tools/
agents/<id>/       # Per-Agent: config/ (config.json, api_key.json, prompts, avatars) + data/
                   #   Optional overrides: agent.js, message_manager.js
gateway/           # HTTP gateway: server.js, process_manager.js, chat_proxy.js,
                   #   chat_history.js, config_store.js, config-ui.js, avatar.js
frontend/          # React + Vite UI (built to frontend/dist/, served by Gateway)
test/              # node:test suites (shared, agent, gateway, config-store, integration)
```

## Quick Start

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/your-username/elf.git
cd elf
npm install      # also installs frontend deps via postinstall
```

Configure LLM credentials (one file per Agent):

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

Run:

```bash
npm start     # Build frontend + start Gateway  → http://localhost:8080
npm stop      # Stop Gateway + Agents (free ports)
npm restart   # Stop then start
npm test      # Run the test suites
npm run dev:frontend   # Vite dev server for the UI
```

## Agent Config (`config.json`)

```jsonc
{
  "agentId": "elf-002",
  "name": "Coding Agent",
  "port": 8082,
  "provider": "llm",            // or "mock"
  "systemPrompt": { "type": "path", "content": "system_prompt.md" },
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  "memoryTokenLimit": 40000,    // trigger compaction above this
  "maxIterations": 0,           // 0 = unlimited Agent Loop
  "agentClass": "agent",        // optional: override default Agent
  "messageManagerClass": "message_manager"  // optional: override MessageManager
}
```

Path-typed fields (`{ "type": "path", "content": "<file>" }`) are auto-loaded from
the config directory and hot-reloaded; `_ui` annotates fields for the config drawer.

## Add a New Agent

```bash
cp -r agents/elf-001 agents/elf-003
# Edit agents/elf-003/config/{config.json, api_key.json, system_prompt.md}
#   - unique agentId + name, a free port
#   - choose tools, memoryTokenLimit, maxIterations
# Clean: rm -rf agents/elf-003/data/*
# Then either restart Gateway or POST /agents/rediscover — auto-discovered
```

## API

```bash
# List / discover agents
curl http://localhost:8080/agents
curl -X POST http://localhost:8080/agents/rediscover
curl http://localhost:8080/available-tools

# Chat (SSE streaming)
curl -N http://localhost:8080/agents/elf-001/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'

# Process management
curl -X POST http://localhost:8080/agents/elf-001/start
curl -X POST http://localhost:8080/agents/elf-001/stop
curl -X POST http://localhost:8080/agents/elf-001/restart
curl -X POST http://localhost:8080/agents/elf-001/abort
curl http://localhost:8080/agents/elf-001/status

# History (paginated) & memory
curl http://localhost:8080/agents/elf-001/history?limit=30
curl -X DELETE http://localhost:8080/agents/elf-001/history
curl -X DELETE http://localhost:8080/agents/elf-001/memory

# Config
curl http://localhost:8080/agents/elf-001/config
curl http://localhost:8080/agents/elf-001/config-ui
curl -X PUT http://localhost:8080/agents/elf-001/config \
  -H "Content-Type: application/json" \
  -d '{"systemPrompt": "You are a helpful assistant."}'
```

## Docs

| Doc | Description |
|-----|-------------|
| [design.md](docs/design.md) | System architecture & requirements |
| [api.md](docs/api.md) | REST API & SSE event reference |
| [agent-engineering.md](docs/agent-engineering.md) | Agent module spec |
| [gateway-engineering.md](docs/gateway-engineering.md) | Gateway module spec |
| [message-persistence.md](docs/message-persistence.md) | Persistence design |

## License

[MIT](LICENSE)