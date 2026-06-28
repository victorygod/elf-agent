# Elf Agent 重构文档

## 一、问题清单

### 1.1 核心问题：三个文件高度重复

`agent.js`、`config.js`、`message_manager.js` 三个文件在 elf-001 和 elf-002 之间几乎完全复制粘贴（~560 行 × 2），真正的差异不到 30 行：

| 文件 | elf-001 | elf-002 | 差异 |
|------|---------|---------|------|
| `agent.js` (~240行) | Read 的 status 事件 | Read/Write/Bash 的 status 事件 + Bash description | ~12 行 |
| `config.js` (~130行) | 加载 3 个 prompt 文件 | 只加载 system prompt | ~15 行 |
| `message_manager.js` (~190行) | 支持 prefix/suffix 注入 | 不支持 | ~8 行 |

每新增一个 Agent 都要复制 ~680 行几乎相同的代码。

### 1.2 `setXxxLogFileName` 全局状态耦合

每个模块都有独立的 `logFileName` 变量和 `setXxxLogFileName()` 函数，`index.js` 里逐个调用设置：

```js
setConfigLogFileName(logFileName);
setAgentLogFileName(logFileName);
setServerLogFileName(logFileName);
setMessageManagerLogFileName(logFileName);
```

每新增一个模块就要加一对 set 函数，是隐式全局状态而非正规依赖注入。

### 1.3 `index.js` 启动编排重复

两个 Agent 的 `index.js`（~120 行 × 2）启动顺序完全相同，唯一差异：

- 工具注册列表不同
- MessageManager 构造参数不同（有无 prefix/suffix）
- 热加载 updateConfig 传参不同

### 1.4 工具的 status 事件和 tool_call 摘要硬编码在 agent.js 里

```js
if (toolName === 'Read') {
  yield { event: 'status', data: { state: 'reading_file', ... } };
}
// elf-002 还多了：
if (toolName === 'Bash') {
  entry.description = '执行命令';  // tool_call 事件的硬编码摘要
}
```

Agent 循环不应该知道每个工具的名字和对应的 UI 状态/摘要文本。这是工具自身的元数据，应通过声明式字段（`statusEvent` / `callSummary`）附加在工具定义上。详细设计见 [tool-refactor.md](./tool-refactor.md)。

### 1.5 config.js / message_manager.js 差异用代码复制处理

elf-002 不用 prefix/suffix，所以复制了一份去掉相关代码的 `config.js` 和 `message_manager.js`。正确做法是让 shared 版本统一支持（空字符串 = 不启用），通过配置选项控制。

### 1.6 agents 目录下的 tools/ 目录无意义

elf-001 和 elf-002 各有一个 `tools/` 目录，里面只有 re-export：

| 文件 | 内容 |
|------|------|
| `tools/registry.js` | `export { ToolRegistry } from '../../shared/...'` |
| `tools/read_file.js` | `export { readFileTool } from '../../shared/...'` |

这些 re-export 完全多余。Agent 的 `index.js` 可以直接从 `shared/agent/tools/index.js` 导入工具和 `ToolRegistry`。

另外 `shared/agent/tools/` 里存在两个 Read 工具：

- `Read.js` — 新版，cat -n 格式，带 read_state 追踪，elf-002 使用
- `read_file.js` — 旧版，`[lines:X-Y of Z]` 格式，elf-001 使用

应统一为一个。

---

## 二、逐文件分析

### 2.1 `agents/*/tools/` 目录

**现状**：每个 Agent 下有个 `tools/` 目录，内容全是 re-export shared 版本。elf-001 注册 `readFileTool`（旧版），elf-002 通过 `shared/agent/tools/index.js` 注册 `Read, Write, Edit, Bash, Glob`（新版）。

**问题**：
1. re-export 层完全多余——Agent 的 `index.js` 完全可以直接 `from '../../shared/agent/tools/index.js'` 导入
2. 两个 Read 工具并存（`Read.js` 和 `read_file.js`），elf-001 用的旧版，elf-002 用的新版，应统一
3. `read_state.js` 是 Read/Write/Edit 三个工具共享的文件读取追踪状态，elf-001 的旧版 `read_file.js` 没有使用它

**结论**：`agents/*/tools/` 目录没有存在的意义，应删除。Agent 直接从 `shared/agent/tools/index.js` 导入所需工具。旧版 `read_file.js` 应删除，统一使用 `Read.js`。

重构后的 Agent 工具引入方式：

```js
// index.js 直接从 shared 导入
import { ToolRegistry } from '../../shared/agent/tools/registry.js';
import { Read, Write, Edit, Bash, Glob } from '../../shared/agent/tools/index.js';

const toolRegistry = new ToolRegistry();
toolRegistry.register(Read);
// 按需注册...
```

### 2.2 `shared/agent/server.js`

**现状**：提供 `createAgentServer(agent, config)` 工厂函数，创建 Express 应用，暴露 6 个 HTTP 端点（`/chat`、`/abort`、`/config`、`/status`、`/shutdown`、`/clear`）。包含请求队列逻辑——Agent 正忙时新消息合并到 `pendingMessage`，响应广播给所有等待的 res。

**结论**：设计合理，是纯 HTTP 适配层，不含 Agent 业务逻辑。两个 Agent 都直接 re-export，零重复。不需要改动。

### 2.3 `shared/agent/llm_model.js`

**现状**：封装 OpenAI 兼容的 `/chat/completions` API 调用，支持流式（`chat()` 返回 AsyncIterable）和非流式（`chatComplete()` 返回完整字符串）。

关键设计：
- `extraParams` 透传：config 里除 `provider/base_url/auth_token/model` 外其余字段原样透传到请求 body，支持 `enable_thinking` 等扩展参数
- 双超时：连接 120s + 请求 120s，流式传输中每收到数据重置请求超时
- 外部 abort signal 合并：`AbortSignal.any([internal, external])`
- SSE 解析处理 tool_calls 增量拼接

**问题与改造**：

1. **命名改为 `chatStream()` / `chat()`**——`chat()` 是流式，`chatComplete()` 是非流式，名字体现不出区别。改为 `chatStream()`（流式，返回 AsyncIterable）和 `chat()`（非流式，返回完整字符串），调用方一眼区分。agent.js 和 message_manager 中的调用同步更新。

2. **超时硬编码**——默认 120s 写在文件头部常量，config 里无对应字段。保留在文件头部即可，当前不需要可配置化。

3. **两个方法保持独立**——`chatStream()` 和 `chat()` 有约 25 行重复代码（headers 构建、超时控制、fetch 调用、错误处理），但两者语义不同（流式 SSE 解析 vs 一次性 JSON 响应），错误处理细节也不同。保持各自独立实现，不互相调用，避免非流式请求走流式模式带来的不必要复杂度。

### 2.4 配置加载：`config.js`

**现状**：elf-001 和 elf-002 各有一份 `config.js`（~130 行），核心逻辑完全相同（读取 config.json + api_key.json + prompt 文件），差异仅在 prompt 文件加载：

- elf-001：用 `PROMPT_FILE_FIELDS` 数组遍历加载 3 个 prompt 文件（system、prefix、suffix）
- elf-002：只加载 `systemPromptPath`，硬编码单个 if 判断

但实际上 elf-002 的 config.json 里**有** `prefixPromptPath` 和 `suffixPromptPath` 字段，文件也存在（只是空文件）。elf-002 不支持 prefix/suffix 不是因为不需要，而是复制代码时砍掉了加载逻辑。

**核心问题**：当前通过字段名约定（`xxxPath` → 读文件 → 存为 `xxx`）来标记哪些字段是文件路径。这个约定是隐式的，config.js 里硬编码了要加载哪些字段，新增字段就要改代码。无法抽到 shared/——因为每个 Agent 可能有不同的路径字段，shared 版本不可能预知所有字段名。

**改造目的**：将 config.js 抽离到 shared/，消除 Agent 间的代码复制。为此需要把路径字段的发现逻辑从硬编码改为数据驱动，让 Config 加载器不需要知道有哪些字段，遍历 config.json 遇到 `type: "path"` 就自动读文件。

**改造方案：`type: "path"` 声明式标记**

config.json 中需要读文件内容的字段，用 `{"type": "path", "content": "文件名"}` 声明：

```json
{
  "agentId": "elf-001",
  "name": "Fengyue",
  "port": 8081,
  "avatar": "avatar.png",
  "userAvatar": "user_avatar.webp",
  "provider": "llm",
  "systemPrompt": { "type": "path", "content": "system_prompt.md" },
  "prefix_prompt": { "type": "path", "content": "prefix_prompt.md" },
  "suffix_prompt": { "type": "path", "content": "suffix_prompt.md" },
  "memoryTokenLimit": 500,
  "maxIterations": 0,
  "_ui": { ... }
}
```

**Config 加载逻辑**（统一到 `shared/agent/config_loader.js`）：

```js
// 遍历 config.json 的每个字段
for (const [key, value] of Object.entries(raw)) {
  if (value && typeof value === 'object' && value.type === 'path') {
    // type: "path" → 读文件内容
    const filePath = path.join(configDir, value.content);
    try {
      raw[key] = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      raw[key] = ''; // 文件不存在返回空字符串
    }
  }
}
// api_key.json 单独固定加载
const apiKeyData = readApiKey(configDir);
raw.model = { provider: raw.provider || 'llm', ...apiKeyData };
```

**优势**：

- Agent 想加新文件字段只需在 config.json 里写 `{"type": "path", "content": "xxx.md"}`，Config 自动发现和加载
- 不需要 `PROMPT_FILE_FIELDS` 硬编码，不需要字段名约定
- elf-002 不需要 prefix/suffix 时，直接不写这两个字段即可
- Config 加载逻辑完全通用，可抽到 shared/

**api_key.json 特殊处理**：不属于 config.json 里的路径字段，作为独立固定文件加载。逻辑不变——读取 `api_key.json`，合并到 `raw.model` 中。

**写入逻辑**（`writeAgentConfig`）：

保存时遇到字符串值且原 config.json 中对应字段是 `{type: "path"}`，将内容写回文件，config.json 中保留路径声明不变。遇到非路径字段，直接合并写入 config.json。

**前端影响**：

Config API 返回给前端的是 resolved 后的配置（路径字段已替换为文件内容字符串），前端无感知 `type: "path"`。保存时前端提交的也是纯内容字符串，后端根据原 config.json 中的 `type: "path"` 判断写文件还是写 config.json。

### 2.5 消息管理：`message_manager.js`

**现状**：管理对话历史（`messages` 数组）和记忆压缩。elf-001 和 elf-002 各有一份（~190 行 × 2），功能几乎相同，唯一差异是 elf-001 的 `getMessagesForLLM()` 支持 prefix/suffix 注入（~8 行）。

**当前功能**：

| 方法 | 功能 |
|------|------|
| `addUserMessage / addAssistantMessage / addAssistantToolCalls / addToolResult` | 追加消息，同步写 context.json |
| `getMessagesForLLM()` | 构建 LLM 请求消息数组（system + 历史 + prefix/suffix 注入） |
| `estimateTokens()` | 估算 token 数（字符数 / 4，极粗糙） |
| `compactIfNeeded(llmModel)` | token 超限时调 LLM 做摘要压缩，把历史替换成两条 |
| `clear()` | 清空消息和 context.json |
| `updateConfig(config)` | 热更新 systemPrompt / memoryTokenLimit / prefix/suffix |

**演进方向：上下文工程的核心模块**

当前实现很简陋——`getMessagesForLLM()` 粗暴地 system + 全部历史，压缩是一次性全压成两条摘要。但 message_manager 是上下文工程的核心，将来每个 Agent 可能需要不同的上下文策略：

- **tool 结果裁剪**——旧消息中 tool 返回的几千字内容可以截断或摘要
- **压缩保留策略**——最近 N 条消息必须保留、system prompt 中的关键指令保留、tool 调用对保留（不能只留 assistant 丢了 tool 上下文）
- **消息窗口**——不是 token 限制触发压缩，而是只发送最近 N 条消息
- **分层压缩**——最近消息完整保留，中间消息摘要，早期消息只保留关键信息
- **特定消息权重**——某些消息（如注入的知识）不应被压缩

这些策略每个 Agent 可能不同——聊天 Agent 保留最近 20 条，代码 Agent 保留所有 tool 调用对。

**改造方案：先合并为单类，将来按需抽基类**

当前两个 MessageManager 差异仅 ~22 行（prefix/suffix 注入 + 压缩 prompt 措辞），用继承体系解决这个量级的差异过早。先用单个 `MessageManager` 类统一，prefix/suffix 通过构造参数控制（空字符串 = 不注入）。等真正出现第二种上下文策略时再抽 `BaseMessageManager` 基类（YAGNI）。

**`compactIfNeeded` 改为 async generator（方案 A1）**

当前记忆压缩的职责分裂在两处：

- **agent.js**：判断是否需要压缩（`estimateTokens() > memoryTokenLimit`）、发射 `compact_start` 事件、创建 AbortController、调 `compactIfNeeded`、发射 `compact` / `compact_error` 事件、处理 abort
- **message_manager.js**：冗余再判断一次 `estimateTokens() <= memoryTokenLimit`、构建压缩 messages、调 LLM、替换历史、持久化

问题：触发条件暴露在 agent.js，message_manager 冗余判断，将来换压缩策略 agent.js 也得跟着改。

**改造**：`compactIfNeeded` 变为 `async *generator`，将触发判断、执行压缩、发射成功事件内聚到 message_manager；异常不 catch，抛给 agent 处理（abort 和 error 是 agent loop 的退出逻辑，不应下沉到 message_manager）。

```js
// message_manager — 管压缩的业务逻辑 + 正常路径事件，异常抛出
async *compactIfNeeded(llmModel, options = {}) {
  if (this.estimateTokens() <= this.memoryTokenLimit) return;

  yield { event: 'compact_start', data: {} };

  const compressMessages = [
    ...this.getMessagesForLLM(),
    { role: 'user', content: '请简要总结以上对话的关键信息和待办事项，保留重要细节。' }
  ];

  const summary = await llmModel.chat(compressMessages, options);

  this.messages = [
    { role: 'user', content: '请简要总结以上对话的关键信息和待办事项，保留重要细节。' },
    { role: 'assistant', content: summary }
  ];
  this._save();
  yield { event: 'compact', data: { tokenEstimate: this.estimateTokens() } };
  // 不 catch — AbortError 和其他异常抛给 agent
}
```

```js
// agent.js — 管失败和中断，3 行搞定压缩段
this._abortController = new AbortController();
try {
  yield* this.messageManager.compactIfNeeded(this.model, { signal: this._abortController.signal });
  this._abortController = null;
} catch (err) {
  this._abortController = null;
  if (err.name === 'AbortError' || this._aborted) {
    yield { event: 'aborted', data: {} };
    yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
    return;
  }
  yield { event: 'compact_error', data: { error: err.message || '记忆压缩失败' } };
}
```

**职责划分**：

| 职责 | 位置 | 说明 |
|------|------|------|
| 触发条件 `estimateTokens() > limit` | message_manager | 内聚到 compactIfNeeded 内部 |
| 构建压缩 messages / 调 LLM / 替换历史 / 持久化 | message_manager | 本来就在这里 |
| `compact_start` / `compact` 事件 | message_manager | 正常路径事件随 generator yield |
| abort 控制（创建 AbortController / catch AbortError） | agent | agent loop 的退出逻辑 |
| `aborted` / `compact_error` 事件 | agent | 失败和中断是 agent 的职责 |
| `done` 事件 | agent | 退出 agent loop 的标志 |

**效果**：agent.js 压缩段从 ~20 行缩到 ~8 行，触发条件不再泄漏，将来换压缩策略只改 message_manager。

**关于 `compact_start` 事件**：`compact_start` 在 generator 内部、调 LLM 之前 yield，前端收到时压缩已经决定要发生。当前前端对 `compact_start` 没有特殊交互需求（压缩过程无用户操作窗口），保留它的意义是 UI 展示"正在压缩"状态，功能正常。

### 2.6 Agent 核心文件：`agent.js`

**现状**：elf-001 和 elf-002 各有一份 `agent.js`（~240 行 × 2），差异仅 ~12 行——elf-002 多了 Write/Bash 的 status 事件和 Bash 的 description 字段。

**当前结构**：

```
receive(message) → reasoning(message) → while(LLM循环) → done
```

receive 直接透传到 reasoning，没有实际逻辑。reasoning 是经典的 agent loop：调 LLM → 有 tool_calls 就执行工具 → 再调 LLM → 直到得到文本回复 → 压缩记忆。

**设计理念**：Agent 核心是 intuitive——结合环境输入和自身状态作出反应。reasoning（LLM 循环）只是 Agent 的一种能力，不是全部。工具调用是对环境的影响，不一定是 LLM 决策的结果。不是所有 Agent 都遵循 agent loop 范式。

**当前行动**：

1. **消灭 elf-001 / elf-002 的差异**——将工具 status 事件和 tool_call 摘要移到工具定义上（`statusEvent` / `callSummary` 字段），agent.js 自动读取并发射，不再硬编码工具名
2. **receive 和 reasoning 分开**——receive 决定"做什么"，reasoning 决定"怎么推理"。当前 receive 透传，但结构上保留扩展点
3. **DefaultAgent 放到 shared**——作为 shared 提供的一种实现，config.json 的 `agentClass` 字段引用它。需要自定义推理逻辑的 Agent 在自己目录下放类文件

```js
// shared/agent/agents/default_agent.js
class DefaultAgent {
  constructor({ config, model, toolRegistry, messageManager }) { ... }

  async *receive(message) {
    // intuitive 层：当前透传，将来可扩展
    yield* this.reasoning(message);
  }

  async *reasoning(message) {
    // 经典 agent loop
  }
}
```

**不动的部分**：定时触发、事件推送、多入口、intuitive 层的具体逻辑——这些都是后话，现在不设计。

**工具定义增强**（配合 agent.js 差异消除，详细设计见 [tool-refactor.md](./tool-refactor.md)）：

当前工具定义只有 `name / description / parameters / execute` 四个字段，所有工具差异逻辑（UI 状态事件、结果处理策略等）硬编码在 agent.js 中。增强为声明式元数据，agent.js 自动读取，不再按工具名 if/else。

**本次重构添加的元数据字段**：

```js
// shared/agent/tools/Read.js — 改造后
export const Read = {
  name: 'Read',
  description: '...',
  parameters: { ... },
  statusEvent: {
    state: 'reading_file',
    detail: (args) => `正在读取 ${args.file_path || ''}`,
  },
  callSummary: (args) => args.file_path || '',   // tool_call 事件的摘要
  execute: async (args) => { ... },
};

// shared/agent/tools/Bash.js — 改造后
export const Bash = {
  name: 'Bash',
  description: '...',
  parameters: { ... },
  statusEvent: {
    state: 'executing_command',
    detail: (args) => `正在执行：${(args.description || args.command || '').substring(0, 50)}`,
  },
  callSummary: (args) => args.description || args.command?.substring(0, 50) || '',
  execute: async (args) => { ... },
};
```

- **`statusEvent`**：替换 agent.js 中按工具名硬编码的 status 事件。agent 循环自动读取 `tool.statusEvent` 并 yield 事件，不存在则不发。
- **`callSummary`**：替换 agent.js 中 `toolCallsSummary` 的硬编码逻辑。当前 elf-002 对 Bash 单独加 `entry.description = '执行命令'`，这是给前端 ToolCallBadge 用的展示文本。改造为 `callSummary(args)` 函数，从工具参数中提取最具描述性的信息。Bash 的 `args.description`（LLM 传入的自然语言描述）优先，回退到 `args.command`。

两个元数据字段都是可选的，缺失时 agent 循环跳过对应逻辑，向后兼容。

**后续扩展（本次不做，预留）**：

tool-refactor.md 还设计了 `resultPolicy`（结果截断/缓存策略）、`execution`（并行/幂等/确认约束）、`errorPolicy`（预期错误/致命错误分类）三个元数据维度。这些能力当前没有消费者，暂不实现。等 message_manager 的上下文工程能力演进（tool 结果裁剪、分层压缩）后再按需启用。

**agent.js 通用工具执行管线**（替换当前硬编码）：

```js
for (const tc of toolCallsResult) {
  const toolName = tc.function.name;
  let toolArgs = {};
  try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
  const tool = this.toolRegistry.getTool(toolName);

  // 1. 发射 status 事件（从工具元数据读取，不再硬编码）
  if (tool?.statusEvent) {
    yield {
      event: 'status',
      data: {
        state: tool.statusEvent.state,
        detail: tool.statusEvent.detail?.(toolArgs) || '',
      },
    };
  }

  // 2. 执行工具
  const result = await this.toolRegistry.execute(toolName, toolArgs);
  this.messageManager.addToolResult(tc.id, result);

  // 3. tool_result 事件（保持现有错误分类逻辑）
  const isError = typeof result === 'string' && (
    result.startsWith('Error:') || result.startsWith('Exit code') ||
    result.startsWith('Permission denied') || result.startsWith('File does not exist') ||
    (result.match && result.match(/is a directory\.?\s*$/))
  );
  yield { event: 'tool_result', data: { status: isError ? 'error' : 'success', message: isError ? result : undefined } };

  if (this._aborted) { /* abort 处理 */ }
}
```

`toolCallsSummary` 的构建也改为数据驱动：

```js
const toolCallsSummary = toolCallsResult.map(tc => {
  const toolName = tc.function.name;
  let toolArgs = {};
  try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
  const tool = this.toolRegistry.getTool(toolName);
  const entry = { name: toolName, args: toolArgs };
  if (tool?.callSummary) {
    entry.description = tool.callSummary(toolArgs);
  }
  return entry;
});
```

**abort 检查提取工具函数**：

当前 `reasoning()` 中 abort 检查出现 4 次（LLM 流式调用 catch、LLM 流正常结束后、工具执行后、压缩前），每次都是相同的模式：检查 `_aborted` → 保留已生成内容 → yield aborted + done → return。提取为工具函数减少重复：

```js
_checkAborted(fullContent) {
  if (!this._aborted) return false;
  if (fullContent) this.messageManager.addAssistantMessage(fullContent);
  return true;
}

// 使用处变为 3 行
if (this._checkAborted(fullContent)) {
  yield { event: 'aborted', data: {} };
  yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
  return;
}
```

4 处 abort 逻辑集中为 1 处定义 + 4 次 3 行调用，净减约 12 行，且后续修改 abort 行为只需改一处。

**LLM 调用段不封装为 generator 的决定**：

考虑过将 agent.js 中 LLM 调用段（`for await` 消费 `model.chatStream()` + 累积 fullContent + 处理 tool_calls + abort/错误处理）封装为 `async *generator`，与 `compactIfNeeded` 的改造保持一致。经分析后**决定不做**，理由：

1. **返回值决定控制流**——LLM 调用的返回值（`fullContent` 和 `toolCallsResult`）直接决定 agent loop 的下一轮是执行工具还是结束循环。generator 需要 return 这两个值，调用方需要 `const result = yield* _callLLM()` 来获取。而 `compactIfNeeded` 不需要返回值——它只发事件，不影响循环控制流。

2. **异常处理的归属不同**——LLM 调用的错误（API 超时、网络断开）终止整个 agent loop（yield error + done + return），这是 agent 的退出逻辑，不应该下沉。如果 generator 内部 throw 自定义异常对象（`{ type: 'abort', fullContent }`），调用方要按 type 分支处理，引入隐式异常协议，反而不如当前的 try/catch 直观。

3. **封装目的不同**——`compactIfNeeded` 封装为 generator 是为了将触发条件和压缩策略从 agent 内聚到 message_manager，将来换策略只改 MM。而 LLM 调用段的所有逻辑（AbortController 管理、token yield、tool_calls 收集、错误处理）本身就是 agent loop 的核心编排逻辑，天然属于 agent 职责。封装只是搬位置，没有内聚收益。

4. **mock/LLM 切换不受影响**——无论是否封装，model 的接口（`chatStream()` / `chat()`）不变，MockModel 和 LLMModel 的切换在 index.js 构造时完成，与 agent loop 内部代码无关。MockModel 的 `chatStream()` 也是流式（逐字符 yield），接口契约一致。

5. **abort 状态管理语义不自然**——`_abortController` 在 agent 的 `abort()` 方法中被引用（用户中断时调 agent.abort()），是 agent 的全局状态而非 LLM 调用的内部状态。放入 generator 语义不够自然。且 LLM 流结束后检查 abort 需要调 `this.messageManager.addAssistantMessage(fullContent)`，generator 隐式依赖了 messageManager。

| 维度 | compactIfNeeded generator | LLM 调用 generator |
|------|--------------------------|-------------------|
| 封装目的 | 将触发条件+压缩策略内聚到 MM | 搬位置，无内聚收益 |
| 边界条件 | ✅ 更清晰（触发+执行内聚） | ⚠️ 引入 throw 自定义对象协议 |
| 代码量 | ~20 行 → ~8 行 | ~40 行 → ~30 行（generator ~25 行 + 调用处 ~5 行），净减少少 |
| 对 mock 切换的影响 | 无 | 无 |
| 将来扩展性 | ✅ 换压缩策略只改 MM | ❌ 控制流变化仍需改 generator |

### 2.7 启动编排：`index.js`

**现状**：Agent 启动入口，~120 行，做 9 件事：解析参数 → 加载配置 → 设置日志 → 初始化模型 → 初始化工具 → 初始化 MessageManager → 初始化 Agent → 启动 HTTP 服务 → 热加载监听。elf-001 和 elf-002 几乎完全相同，差异仅在工具注册列表和 MessageManager 构造参数（有无 prefix/suffix）。

**问题**：

1. **9 步启动编排每个 Agent 重复一遍**——如果 `createAgent()` 封装了这些步骤，新建 Agent 只需声明工具和配置
2. **`setXxxLogFileName` 逐个调用**——4 次 set 调用是模块级 `let logFileName` 变量导致的隐式耦合，应改为依赖注入
3. **热加载逻辑重复**——两个 Agent 的 `fs.watch` 代码块几乎相同，差异只在 `messageManager.updateConfig()` 参数
4. **端口错误处理重复**——`server.on('error', ...)` 每个 Agent 都写一遍，应收进 `createAgentServer()`

**改造方向**：

**核心洞察**：`index.js` 当前做的事——创建组件、传给 `createAgentServer()`、启动——本质上不是编排，只是对象创建和依赖关联。这些对象（Model、MessageManager、Agent）的创建没有昂贵的初始化过程（无连接池、无预分配、无异步），放哪执行都一样。

进一步拆解：

- **启动 HTTP 服务**——`server.js` 已经做了
- **工具注册**——应从 `config.json` 读取工具列表，不需要代码硬编码
- **模型 / MessageManager / Agent 创建**——从配置自动创建，不需要手动编排
- **配置热更新**——当前在 `index.js` 里手动 `fs.watch` + 逐个调 `updateConfig`。应改为 Config 自身负责监听变化，自动通知依赖组件更新

**最终目标**：Agent 目录下只需要 `config/` 目录（大多数 Agent），不需要 `index.js`、`agent.js`、`config.js`、`message_manager.js`、`server.js`、`tools/`。Agent 的个性完全由配置定义——工具列表、提示词、模型、记忆策略、Agent 类、MessageManager 类。所有公共代码在 `shared/` 里，Agent 之间零代码复制。

**典型 Agent 目录结构**（使用默认实现）：

```
agents/elf-001/
  config/
    config.json          ← 声明工具、模型、提示词路径、agentClass、messageManagerClass 等
    api_key.json         ← 模型连接信息
    system_prompt.md     ← 提示词
    ...
  data/                  ← 运行时数据（context.json、history.jsonl）
```

**需要自定义逻辑的 Agent 目录结构**（如 elf-003）：

```
agents/elf-003/
  config/
    config.json          ← agentClass: "CreatorAgent"
    api_key.json
    system_prompt.md
  creator_agent.js       ← 自定义 Agent 类（仅当需要自定义推理逻辑时）
```

**启动方式**：从 `node agents/elf-001/index.js` 变为 `node shared/agent/start.js --config agents/elf-001/config`。`start.js` 根据 config.json 自动创建所有组件并启动服务。

**类加载机制**：config.json 中用字符串声明类名（如 `"agentClass": "DefaultAgent"`），`start.js` 启动时按以下顺序查找实现：
1. Agent 目录下的同名 `.js` 文件（`agents/elf-003/creator_agent.js`）
2. shared 里的默认实现（`shared/agent/agents/default_agent.js`）

大多数 Agent 只用默认实现，不需要任何 `.js` 文件。需要自定义逻辑的 Agent 在自己目录下放一个类文件即可。

**config.json 声明多态的字段**：

```json
{
  "agentId": "elf-001",
  "tools": ["Read"],
  "agentClass": "DefaultAgent",
  "messageManagerClass": "DefaultMessageManager",
  "systemPrompt": { "type": "path", "content": "system_prompt.md" },
  ...
}
```

Agent 的自定义推理逻辑如何设计（DefaultAgent 的钩子机制、CreatorAgent 的具体需求），留待 agent.js 讨论时确定。

---

## 三、与 tool-refactor.md 的关系

[tool-refactor.md](./tool-refactor.md) 是本文档的配套方案，聚焦工具定义的声明式元数据设计。两份文档的分工：

| 关注点 | 本文档（agent-refactor.md） | tool-refactor.md |
|--------|--------------------------|-------------------|
| 问题 1.4 的解决方案 | 2.6 节：`statusEvent` + `callSummary` 移到工具定义，agent.js 通用管线 | 3.1 节：完整的四维元数据模型 |
| 本次实施范围 | `statusEvent` + `callSummary`，消灭 agent.js 的硬编码 if/else | 同步实施 `statusEvent`，`resultPolicy` / `execution` / `errorPolicy` 列为后续扩展 |
| 结果截断 / 缓存 / 并行 | 不在本次重构范围 | 方案已设计，标注为后续扩展 |
| 与 MM 的协作 | 2.5 节演进方向中提到"tool 结果裁剪" | 5.1 节明确了边界：上游截断（agent 管线），不在 MM 中截断 |

**决策对齐**：

1. **`statusEvent` 和 `callSummary`**：本文档 2.6 节定义的字段，与 tool-refactor.md 3.1 节一致。`callSummary` 是本文档新增的，tool-refactor.md 的 `statusEvent.detail` 功能与之重叠但语义不同——`statusEvent` 是进度事件（"正在读取 xxx"），`callSummary` 是身份标签（前端 ToolCallBadge 展示的摘要文本）。

2. **`resultPolicy` / `execution` / `errorPolicy`**：tool-refactor.md 设计了完整方案，但本次重构 **不做**。原因：当前没有消费者——resultPolicy 的截断/缓存需要 agent 管线代码配合，errorPolicy 的 fatalErrors 需要 agent 全局错误处理机制配合，execution 的并行执行需要 Promise.all 改造。这些在 DefaultAgent 统一后再按需启用，避免过度设计。

3. **结果截断边界**：tool-refactor.md 5.1 节推荐方案 A（上游截断，在 agent 执行管线中处理，截断后存入历史）。与本文档 2.5 节 message_manager 的演进方向（"tool 结果裁剪"）不矛盾——当前 MM 的 `addToolResult()` 直接存储原始结果，启用 resultPolicy 后在 agent 管线中截断再传入 MM。将来如果需要按上下文窗口动态调整截断策略，那是 MM 的 `getMessagesForLLM()` 的职责（分层压缩），与静态截断互补。

4. **语义摘要 `truncation: 'summary'`**：tool-refactor.md 7.1 节结论：不做。语义摘要由 message_manager 的分层压缩能力负责，不属于工具元数据范畴。