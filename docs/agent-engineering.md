# Agent 工程设计文档

---

## 1. 模块职责

```
agents/elf-001/
├── index.js               # 入口：启动 Agent HTTP 服务
├── agent.js               # Intuitive + Reasoning 核心
├── server.js              # Express HTTP 服务（接收 Gateway 请求）
├── models/
│   ├── llm_model.js       # LLM 调用（OpenAI 兼容接口）
│   └── mock_model.js       # Mock LLM（测试用，跳过真实 API 调用）
├── tools/
│   ├── registry.js        # 工具注册表
│   └── read_file.js       # read_file 工具实现
├── message_manager.js     # 对话历史管理 + 记忆压缩
├── config.js              # 配置加载 + 热加载
└── config/                # 运行时配置（可热更新）
    ├── config.json        # 主配置
    └── system_prompt.md   # System Prompt
```

### 1.1 index.js — 入口

职责：启动流程编排。

```
启动流程:
  1. 解析命令行参数 (--config 指定配置目录路径，默认相对于自身)
  2. 加载 config/ 目录下的配置
  3. 初始化 Agent 实例
  4. 启动 HTTP 服务，监听 config.json 中指定的端口
  5. 输出启动日志（端口、agentId）
```

Standalone 模式：始终启用 `fs.watch` 监听 `config/` 目录变化，实现热加载。与 Gateway 的 `/config/reload` 机制共存，两者都触发配置重载，重载是幂等的无副作用。

### 1.2 agent.js — Intuitive + Reasoning 核心

职责：Agent 的核心逻辑，包含两层架构。

#### Intuitive（直觉层）

```js
class Agent {
  // 外界调用入口（由 server.js 的 /chat handler 调用）
  async receive(message): AsyncIterable<{event, data}> {
    // 当前策略：直接触发 Reasoning
    // 未来扩展点：此处可加入消息囤积、条件触发等逻辑
    // 例如群聊中只响应 @、关键词触发、定时批量处理等
    return this.reasoning.run(message)
  }
}
```

Intuitive 层当前是简单的 pass-through——收到消息即触发推理。它存在的意义是提供一个**明确的扩展点**：未来需要消息囤积、条件触发等策略时，只改 `receive()` 方法，Reasoning 层完全不变。

**与请求队列的关系**：server.js 的请求队列（§1.3）保证了同一时间只有一个请求进入 `receive()`，因此 Intuitive 不需要自己处理并发。如果未来取消请求串行化（如 per-session 并发），Intuitive 层需要引入自己的并发控制。

#### Reasoning（推理层 / Agent Loop）

```
class Reasoning {
  // messages: 来自 Intuitive 的消息（当前为单条字符串）
  // 返回 AsyncIterable<SSEEvent>，由 server.js 遍历并写入 HTTP 响应
  async *run(messages): AsyncIterable<{event: string, data: object}> {
    // 1. 将消息追加到 MessageManager 历史
    // 2. Agent Loop:
    //    a. 构建 LLM 请求（system prompt + 历史 + tools 定义）
    //    b. 调用 LLM（流式）
    //    c. 解析响应:
    //       - 纯文本 → 流式输出 token 事件，结束循环
    //       - 工具调用 → 执行工具，追加结果到历史，回到 a
    //       - 达到 maxIterations → 流式输出已有内容，结束
    //    d. 每轮结束后检测 token 估算值，超阈值则触发记忆压缩
    // 3. 输出 done 事件
  }
}
```

### 1.3 server.js — HTTP 服务

职责：暴露 HTTP 接口，接收 Gateway 请求。

**路由表**：

| Method | Path | 处理函数 | 说明 |
|--------|------|---------|------|
| POST | `/chat` | `handleChat` | 接收消息，SSE 流式返回响应 |
| GET | `/config` | `handleGetConfig` | 返回当前运行时配置 |
| GET | `/status` | `handleStatus` | 返回 `{ status: "ok" }` |

**请求队列**（串行化）：

```js
// server.js 内部维护一个请求队列
const requestQueue = [];
let isProcessing = false;

async function enqueue(req, res) {
  requestQueue.push({ req, res });
  if (!isProcessing) {
    processNext();
  }
}

async function processNext() {
  if (requestQueue.length === 0) return;
  isProcessing = true;
  const { req, res } = requestQueue.shift();
  try {
    // Intuitive.receive() 返回 AsyncIterable<SSEEvent>，逐个写入响应
    const stream = agent.receive(req.body.message);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    for await (const event of stream) {
      res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }
    res.end();
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    res.end();
  } finally {
    isProcessing = false;
    processNext();
  }
}
```

### 1.4 models/llm_model.js — LLM 调用

职责：封装 OpenAI 兼容的 `/chat/completions` API 调用，支持流式输出。

```js
class LLMModel {
  constructor(config)  // config.model: { baseUrl, apiKey, model }

  // 流式调用 LLM，返回 AsyncIterable<chunk>
  // chunk 格式: { type: 'token', content: '...' } | { type: 'tool_call', ... }
  async *chat(messages, tools, options): AsyncIterable<chunk>

  // 非流式调用（用于记忆压缩等内部调用）
  async chatComplete(messages, options): string
}
```

使用 Node.js 内置 `fetch`，不引入 SDK。

**流式解析**：读取 SSE 流，逐行解析 `data: {...}`，提取 `delta.content` 或 `delta.tool_calls`。

### 1.5 models/mock_model.js — Mock LLM

职责：替代 LLMModel 跳过真实 API 调用，用于测试。参考 wolf 的 mock_model 设计。

```js
class MockModel {
  constructor(options = {})

  // 与 LLMModel 完全相同的接口签名
  async *chat(messages, tools, options): AsyncIterable<chunk>
  async chatComplete(messages, options): string

  // 预设行为
  presetResponses = {}     // 匹配模式 → 预设回复
  callHistory = []         // 调用记录，用于断言

  // 配置方法
  setResponse(key, response)   // 设置预设回复
  setResponses(map)            // 批量设置
  clear()                      // 清空预设和历史
}
```

**切换机制**：通过 `config.json` 中的 `model.provider` 字段：

```json
{
  "model": {
    "provider": "llm",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-xxx",
    "model": "gpt-4o"
  }
}
```

```json
{
  "model": {
    "provider": "mock"
  }
}
```

- `"provider": "llm"` → 使用 LLMModel
- `"provider": "mock"` → 使用 MockModel

**MockModel 的流式行为**：`chat()` 方法也返回 AsyncIterable，将预设内容逐字符 yield，模拟流式输出效果。

**MockModel 的工具调用**：如果预设回复中包含 `tool_calls` 字段，按 LLM 返回的相同格式输出，Agent Loop 正常处理工具调用链。

### 1.6 tools/ — 工具系统

#### registry.js

```js
class ToolRegistry {
  tools = new Map()   // name → tool definition

  register(tool)       // 注册工具
  get(name)            // 获取工具
  getAll()             // 获取所有工具（用于 LLM tools 参数）
  execute(name, args)  // 执行工具
}
```

工具定义格式（OpenAI function calling 兼容）：

```js
{
  name: 'read_file',
  description: '读取本地文件的内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' }
    },
    required: ['path']
  },
  execute: async (args) => {
    // 读取文件内容并返回
  }
}
```

#### read_file.js

唯一工具。读取指定路径的文件内容，返回字符串。

安全约束：
- 不限制路径（v1 简单实现，后续可加白名单）
- 大文件截断：超过 10000 字符时截断并附加 `[文件过长，已截断]`
- 读取失败时返回错误信息字符串（不抛异常），如 `[读取失败: ENOENT, path=/xxx]`

### 1.7 message_manager.js — 对话历史 + 记忆压缩

```js
class MessageManager {
  messages = []           // 对话历史：[{ role, content }, ...]
  config                  // { memoryTokenLimit, systemPrompt }

  constructor(config)

  // 追加用户消息
  addUserMessage(content)

  // 追加助手消息
  addAssistantMessage(content)

  // 追加工具调用结果
  addToolResult(toolCallId, content)

  // 获取发送给 LLM 的完整消息列表（含 system prompt）
  getMessagesForLLM()

  // 估算当前消息列表的 token 数（content.length / 4）
  estimateTokens()

  // 记忆压缩：超过阈值时，调用 LLM 总结历史
  async compactIfNeeded(llmModel)
}
```

**compactIfNeeded 流程**：

```
if estimateTokens() > memoryTokenLimit:
  1. 构建压缩请求消息: [...this.messages, { role: 'user', content: '请简要总结...' }]
  2. 调用 llmModel.chatComplete(compressMessages) → 得到摘要
  3. 截断历史: this.messages = [
       { role: 'system', content: systemPrompt },
       { role: 'user', content: '请简要总结以上对话的关键信息和待办事项，保留重要细节。' },
       { role: 'assistant', content: 摘要 }
     ]
```

### 1.8 config.js — 配置加载 + 热加载

```js
class Config {
  data = {}            // 合并后的运行时配置
  configDir            // config/ 目录路径

  constructor(configDir)

  // 加载配置：读取 config.json，遇到 path 字段则读取对应文件
  load()

  // 获取配置项
  get(key)

  // 获取完整的 LLM/Model 配置
  getModelConfig()
}
```

**热加载机制**：index.js 中始终启用 `fs.watch(configDir, () => config.load())`，配置文件变更后自动重载。无论文件从哪条路径修改（API、手动编辑、外部工具），热加载都生效。

---

## 2. 请求处理完整流程

```
Gateway → POST /chat { message: "hello" }
    │
    ▼
server.js: 请求入队，串行取出
    │
    ▼
agent.js: Intuitive.receive("hello")
    │  → 当前策略：直接交付给 Reasoning
    ▼
agent.js: Reasoning.run("hello")
    │  → messageManager.addUserMessage("hello")
    │  → 构建 LLM 请求 (system_prompt + 历史 + tools)
    │  → LLM 调用 (流式)
    ▼
LLM 返回:
  ├── 纯文本 → yield token 事件 → done 事件
  └── 工具调用 → tools.registry.execute(name, args)
                  → yield status 事件 → 追加结果到历史
                  → 再次 LLM 调用 → ...
    │
  (循环最多 maxIterations 轮)
    │
    ▼
compactIfNeeded(): 估算 token，超阈值则压缩
    │
    ▼
SSE 流结束，返回给 Gateway
```

---

## 3. 启动流程伪代码

```js
async function main() {
  // 1. 解析命令行参数
  const configDir = parseArgs().config || './config';

  // 2. 加载配置
  const config = new Config(path.resolve(__dirname, configDir));
  config.load();

  // 3. 初始化模型
  const modelConfig = config.getModelConfig();
  const model = modelConfig.provider === 'mock'
    ? new MockModel()
    : new LLMModel(modelConfig);

  // 4. 初始化工具注册表
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(readFileTool);

  // 5. 初始化 MessageManager
  const messageManager = new MessageManager({
    systemPrompt: config.get('systemPrompt'),
    memoryTokenLimit: config.get('memoryTokenLimit')
  });

  // 6. 初始化 Agent
  const agent = new Agent({ config, model, toolRegistry, messageManager });

  // 7. 启动 HTTP 服务
  const port = config.get('port');
  createServer(agent).listen(port, () => {
    console.log(`Agent ${config.get('agentId')} listening on port ${port}`);
  });

  // 8. 监听配置文件变化（始终启用）
  fs.watch(configDir, () => config.load());
}
```