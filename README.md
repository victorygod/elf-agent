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
engine/        Shared engine: start.js, agent.js, build_agent.js, message_manager.js,
               models/, tools/, skills/, subagents/, prompt/, plugins/, server.js
shared/        Cross-cutting utils: logger, tokenizer, profiles_paths,
               agent_probe, turn-stream-contract
agents/<id>/   Per-Agent: config/ (config.json, api_key.json, prompts, avatars),
               create_agent.js (assembly), index.js (entry), optional message_manager.js
gateway/       HTTP gateway: server.js, process_manager.js, room_bus.js, room_routes.js,
               private_room_stream.js, snapshot.js, config_store.js, config-ui.js,
               skill_store.js, agent_scaffold.js, agent_template/
frontend/      React + Vite UI, built to frontend/dist/ and served by the Gateway
profiles/      Runtime data (see below); override root with ELF_PROFILES_ROOT
test/          node:test suites — run serially (see npm test)
```

Runtime data layout under `profiles/`:

```
agents/<id>/memory/     Private-chat memory (context, tool results, checkpoints, sync cursor)
agents/<id>/rooms/<rid>/ Per-room private memory for that agent
rooms/<rid>/            Room config + history + replica run state
rooms/chat-<id>/        Private-chat room (history only)
logs/                   Log files
```

## Quick Start

Requires Node.js 18+.

```bash
npm install      # also installs frontend deps via postinstall
```

Put LLM credentials in each Agent's `api_key.json` (any OpenAI-compatible endpoint):

```bash
# agents/elf-001/config/api_key.json
{
  "base_url": "https://api.openai.com/v1",
  "auth_token": "sk-your-api-key",
  "model": "gpt-4o"
}
```

```bash
npm start              # build frontend + start Gateway → http://localhost:8080
npm stop               # stop Gateway + Agents + room replicas, free ports
npm restart            # stop then start
npm run dev:frontend   # Vite dev server for the UI
npm test               # run the test suites (serial)
```

Agents are not auto-started. Start one from the Web UI or `POST /agents/:id/start`.

## Agent Config (`config.json`)

```jsonc
{
  "agentId": "elf-002",
  "name": "Coding Agent",
  "port": 8082,
  "provider": "llm",                       // or "mock"
  "systemPrompt": { "type": "path", "content": "system_prompt.md" },
  "prefix_prompt": { "type": "path", "content": "prefix_prompt.md" },  // LLM-only, not stored
  "suffix_prompt": { "type": "path", "content": "suffix_prompt.md" },  // LLM-only, not stored
  "compactPrompt": { "type": "path", "content": "compact_prompt.md" },
  "compactMode": "async",                  // or "blocking"
  "memoryTokenLimit": 400000,
  "maxIterations": 0,                      // 0 = unlimited
  "interaction": { "strategy": "observe" },
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "Skill"],
  "subagents": ["Explore", "general-purpose"],
  "skills": true,
  "_ui": { "name": { "label": "Agent name", "hint": "Shown in the UI" } }
}
```

Path-typed fields (`{ "type": "path", "content": "<file>" }`) are loaded from the config directory and hot-reloaded. `_ui` annotates fields for the config drawer.

## Add a New Agent

From the UI, or via the scaffold endpoint (creates a blank Agent from `gateway/agent_template/`):

```bash
curl -X POST http://localhost:8080/agents -H "Content-Type: application/json" -d '{"name":"My Agent"}'
curl -X POST http://localhost:8080/agents/rediscover
```

Or manually:

```bash
cp -r agents/elf-001 agents/elf-018
# Edit agents/elf-018/config/{config.json, api_key.json, system_prompt.md}:
#   unique agentId + name, a free port, chosen tools/limits
# Clean memory: rm -rf profiles/agents/elf-018
# Then restart the Gateway or POST /agents/rediscover
```

## API

Agents and process control:

```bash
curl http://localhost:8080/agents                        # list
curl -X POST http://localhost:8080/agents/rediscover      # rescan filesystem
curl http://localhost:8080/available-tools
curl -X POST http://localhost:8080/agents/elf-001/start
curl -X POST http://localhost:8080/agents/elf-001/stop
curl http://localhost:8080/agents/elf-001/config
curl -X PUT http://localhost:8080/agents/elf-001/config -H "Content-Type: application/json" \
  -d '{"name":"New Name"}'
```

Chat is delivered through the Rooms API. A private chat has id `chat-<agentId>`:

```bash
# Stream room events
curl -N http://localhost:8080/rooms/chat-elf-001/subscribe

# Send a message (X-Speaker-Id: user or agentId)
curl -N -X POST http://localhost:8080/rooms/chat-elf-001/say \
  -H "Content-Type: application/json" -H "X-Speaker-Id: user" \
  -d '{"message":"Hello"}'

# History, memory, rewind
curl "http://localhost:8080/rooms/chat-elf-001/history?limit=30"
curl -X DELETE http://localhost:8080/rooms/chat-elf-001/history
curl -X DELETE http://localhost:8080/rooms/chat-elf-001/memory
curl http://localhost:8080/rooms/chat-elf-001/checkpoints
curl -X POST http://localhost:8080/rooms/chat-elf-001/rewind -H "Content-Type: application/json" -d '{}'
```

Group rooms:

```bash
curl -X POST http://localhost:8080/rooms -H "Content-Type: application/json" \
  -d '{"name":"Team","members":["elf-001","elf-002"]}'
curl http://localhost:8080/rooms
curl -X POST http://localhost:8080/rooms/<rid>/members -H "Content-Type: application/json" -d '{"agentId":"elf-005"}'
curl -X POST http://localhost:8080/rooms/<rid>/start-all
curl -X POST http://localhost:8080/rooms/<rid>/abort
```

Skills and settings:

```bash
curl http://localhost:8080/skills
curl -X POST http://localhost:8080/skills/install -H "Content-Type: application/json" -d '{"sourcePath":"./my-skill"}'
curl http://localhost:8080/settings
```

## License

[MIT](LICENSE). Per [LEGAL.md](LEGAL.md), Chinese comments in the source are the governing version.