<div align="center">

# 🧝 Elf

A lightweight AI Agent platform.

Agent thinks, Gateway connects. Each Agent runs as an independent Node.js process with its own config, system prompt, and conversation context.

[中文文档](README_CN.md) · [MIT License](LICENSE)

</div>

## Features

- **Multi-Agent** — Each Agent is an independent process, self-contained (code + config + data)
- **Streaming Chat** — SSE-based real-time token streaming
- **Tool Use** — LLM Function Calling support (built-in `read_file`, extensible)
- **Memory Compaction** — Auto-summarize conversation history when token limit exceeded
- **Hot Reload** — Config changes take effect without restart (`fs.watch`)
- **Process Management** — Start / stop / restart / crash recovery via Gateway
- **Dual Persistence** — `context.json` (LLM context) + `history.jsonl` (append-only log)
- **Web UI** — WeChat-style chat interface with config panel
- **Mock Mode** — Built-in `MockModel` for testing without LLM API
- **Zero Heavy Deps** — Only runtime dependency: `express`

## Architecture

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

## Quick Start

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/your-username/elf.git
cd elf
npm install
```

Configure LLM credentials:

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
npm start    # Start  → http://localhost:8080
npm stop     # Stop
npm test     # Test
```

## Add a New Agent

```bash
cp -r agents/elf-001 agents/elf-003
# Edit agents/elf-003/config/{config.json, api_key.json, system_prompt.md}
# Update agentId, name, port in config.json
# Clean: rm agents/elf-003/data/*
# Restart Gateway — auto-discovered
```

## API

```bash
# Chat (SSE streaming)
curl -N http://localhost:8080/agents/elf-001/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'

# Process management
curl -X POST http://localhost:8080/agents/elf-001/start
curl -X POST http://localhost:8080/agents/elf-001/stop
curl -X POST http://localhost:8080/agents/elf-001/restart
curl http://localhost:8080/agents/elf-001/status

# Config
curl http://localhost:8080/agents/elf-001/config
curl -X PUT http://localhost:8080/agents/elf-001/config/system_prompt \
  -H "Content-Type: application/json" \
  -d '{"content": "You are a helpful assistant."}'
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