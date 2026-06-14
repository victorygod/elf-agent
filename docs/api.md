# Elf 接口文档

---

## 1. Gateway 对外 REST API

Base URL: `http://localhost:8080`

### 1.1 列出所有 Agent

```
GET /agents
```

**响应**：

```json
[
  {
    "agentId": "elf-001",
    "port": 8081,
    "status": "running",
    "pid": 12345
  },
  {
    "agentId": "code-reviewer",
    "port": 8082,
    "status": "stopped",
    "pid": null
  }
]
```

| 字段 | 类型 | 说明 |
|------|------|------|
| agentId | string | Agent 目录名 |
| port | number | 监听端口 |
| status | string | `running` / `stopped` / `error` |
| pid | number\|null | 进程 ID，stopped/error 时为 null |

---

### 1.2 获取单个 Agent 详情

```
GET /agents/:id
```

**响应**：

```json
{
  "agentId": "elf-001",
  "port": 8081,
  "status": "running",
  "pid": 12345
}
```

**错误**：

| 状态码 | 说明 |
|--------|------|
| 404 | Agent 目录不存在 |

---

### 1.3 启动 Agent

```
POST /agents/:id/start
```

**响应**：

```json
{
  "agentId": "elf-001",
  "status": "running",
  "pid": 12345
}
```

**错误**：

| 状态码 | 说明 |
|--------|------|
| 404 | Agent 目录不存在 |
| 409 | Agent 已在运行 |
| 500 | 启动失败（端口被占用等） |

---

### 1.4 停止 Agent

```
POST /agents/:id/stop
```

**响应**：

```json
{
  "agentId": "elf-001",
  "status": "stopped"
}
```

**错误**：

| 状态码 | 说明 |
|--------|------|
| 404 | Agent 目录不存在 |
| 409 | Agent 已停止 |

---

### 1.5 重启 Agent

```
POST /agents/:id/restart
```

**响应**：

```json
{
  "agentId": "elf-001",
  "status": "running",
  "pid": 12346
}
```

**错误**：

| 状态码 | 说明 |
|--------|------|
| 404 | Agent 目录不存在 |
| 500 | 启动失败 |

---

### 1.6 与 Agent 对话

```
POST /agents/:id/chat
Content-Type: application/json

{
  "message": "帮我看看 /tmp/test.txt 的内容"
}
```

**响应**：SSE 流，Content-Type: `text/event-stream`

```
event: status
data: {"state": "reading_file", "detail": "正在读取 /tmp/test.txt"}

event: token
data: {"content": "这个文件"}

event: token
data: {"content": "包含了..."}

event: done
data: {"usage": {"prompt_tokens": 100, "completion_tokens": 50}}
```

**错误**：

| 状态码 | 说明 |
|--------|------|
| 404 | Agent 目录不存在 |
| 503 | Agent 未运行 |

SSE 流中的错误：

```
event: error
data: {"message": "LLM API error: rate limit exceeded"}
```

---

### 1.7 获取 Agent 配置

```
GET /agents/:id/config
```

**响应**：返回合并后的运行时配置（path 字段已替换为文件内容）

```json
{
  "agentId": "elf-001",
  "port": 8081,
  "model": {
    "provider": "llm",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-***",
    "model": "gpt-4o"
  },
  "systemPrompt": "You are a helpful assistant...",
  "memoryTokenLimit": 8000,
  "maxIterations": 5
}
```

**错误**：

| 状态码 | 说明 |
|--------|------|
| 404 | Agent 目录不存在 |

---

### 1.8 更新 Agent 配置

```
PUT /agents/:id/config
Content-Type: application/json

{
  "memoryTokenLimit": 12000,
  "systemPrompt": "You are now a strict code reviewer."
}
```

支持部分更新：未传字段保持原值。

- 若更新中包含 `systemPrompt`（字符串），写入 `config/system_prompt.md`，`config.json` 中 `systemPromptPath` 保持指向它
- 其他字段直接更新 `config.json`
- 写入文件后，Agent 的 `fs.watch` 自动检测变化并重载配置

**响应**：

```json
{
  "status": "ok"
}
```

**错误**：

| 状态码 | 说明 |
|--------|------|
| 404 | Agent 目录不存在 |

---

## 2. Gateway ↔ Agent HTTP 协议

Gateway 与 Agent 之间通过 HTTP 通信，Agent 监听独立端口。

### 2.1 聊天

```
POST /chat
Content-Type: application/json

{
  "message": "帮我看看 /tmp/test.txt 的内容"
}
```

**响应**：SSE 流，Content-Type: `text/event-stream`

事件格式与 §1.6 完全相同。

### 2.2 获取配置

```
GET /config
```

**响应**：返回 Agent 当前内存中的运行时配置（JSON）。

### 2.3 心跳检查

```
GET /status
```

**响应**：

```json
{
  "status": "ok",
  "agentId": "elf-001"
}
```

Gateway 用此端点探测 Agent 是否存活。

---

## 3. SSE 事件格式

所有 SSE 事件遵循标准 Server-Sent Events 规范：`event: <type>\ndata: <json>\n\n`

### 3.1 事件类型

| event | data 字段 | 说明 |
|-------|----------|------|
| `token` | `content: string` | LLM 输出片段，逐 token 推送 |
| `status` | `state: string`, `detail?: string` | Agent 状态通知（工具执行、记忆压缩等） |
| `done` | `usage: { prompt_tokens, completion_tokens }` | 对话完成 |
| `error` | `message: string` | 错误 |

### 3.2 status 事件的 state 值

| state | 说明 |
|-------|------|
| `thinking` | Agent 正在思考（LLM 推理中） |
| `reading_file` | Agent 正在读取文件 |
| `compacting_memory` | Agent 正在压缩记忆 |
| `tool_call` | Agent 正在执行工具（通用） |

### 3.3 完整示例

```
event: status
data: {"state": "thinking"}

event: token
data: {"content": "我"}

event: token
data: {"content": "来看看"}

event: token
data: {"content": "这个文件"}

event: status
data: {"state": "reading_file", "detail": "正在读取 /tmp/test.txt"}

event: token
data: {"content": "这个文件的内容是..."}

event: done
data: {"usage": {"prompt_tokens": 150, "completion_tokens": 30}}
```

---

## 4. 错误码汇总

### 4.1 Gateway API 错误

| 状态码 | 场景 |
|--------|------|
| 400 | 请求体格式错误 |
| 404 | Agent 不存在（agents/ 下无对应目录） |
| 409 | 状态冲突（如 Agent 已运行时调用 start） |
| 500 | 内部错误（如 fork 失败） |
| 503 | Agent 不可用（未运行、进程无响应） |

### 4.2 SSE 流内错误

SSE 流中的错误通过 `event: error` 事件传递，不中断 HTTP 连接（直到发送完 error 事件后关闭流）。

常见错误消息：

| message | 说明 |
|---------|------|
| `Agent unavailable` | Agent 进程不可达 |
| `LLM API error: ...` | LLM API 调用失败 |
| `Tool execution error: ...` | 工具执行失败 |
| `Max iterations reached` | 达到最大迭代次数，强制中断 |
| `Request timeout` | 请求超时 |