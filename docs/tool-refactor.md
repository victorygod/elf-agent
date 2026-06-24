# Tool 元数据增强方案

> 配套 [agent-refactor.md](./agent-refactor.md) 的独立改造方案，聚焦工具定义的声明式元数据设计。

## 一、问题分析

### 1.1 当前工具定义过于单薄

现有的工具定义只包含执行所需的最小信息：

```js
// 当前工具定义（以 Read.js 为例）
export const Read = {
  name: 'Read',
  description: '读取文件内容',
  parameters: { ... },
  execute: async (args) => { ... },
};
```

工具执行结果的**处理策略、UI 事件、执行约束、错误分类**全部硬编码在 `agent.js` 的 `reasoning()` 循环中：

```js
// agent.js 中硬编码的工具特定逻辑
if (toolName === 'Read') {
  yield { event: 'status', data: { state: 'reading_file', ... } };
}
if (toolName === 'Bash') {
  yield { event: 'status', data: { state: 'executing_command', ... } };
}
if (toolName === 'Write') {
  yield { event: 'status', data: { state: 'writing_file', ... } };
}
```

### 1.2 四个具体问题

**问题 A：工具 status 事件在 agent.js 里硬编码**

每新增一个工具就必须修改 `agent.js`。Agent 循环不应该知道每个工具的名字和对应的 UI 状态。

**问题 B：所有工具的执行结果被"一刀切"处理**

不同工具返回的结果有完全不同的特征：

| 工具 | 输出量 | 是否幂等 | 错误敏感性 |
|------|--------|----------|-----------|
| `Read` | 可能巨大（几千行） | 是（只读） | 低 |
| `Glob` | 通常很小 | 是（只读） | 低 |
| `Bash` | 可能巨大 | 否（有副作用） | 高（err exit ≠ 异常） |
| `Write/Edit` | 很小 | 否（有副作用） | 中 |

但 agent.js 对它们一视同仁——结果原样存入历史，无截断、无摘要、无缓存。

**问题 C：没有工具结果的后处理钩子**

`toolRegistry.execute(toolName, toolArgs)` 返回什么，`addToolResult()` 就存什么。没有：
- 结果截断策略（Read 读到 2000 行，是否应该截断为摘要给 LLM？）
- 结果格式化（Bash JSON 输出要不要美化？）
- 结果缓存（同一文件连续 Read 两次，能否复用？）

**问题 D：串行执行并行 tool_calls**

OpenAI 支持一次返回多个 tool_calls（如同时调用 Glob + Read），但当前代码逐个串行执行。

---

## 二、改造目标

1. **Agent 循环通用化**——`agent.js` 不再出现任何工具名，所有差异由工具的声明式元数据表达
2. **工具自我描述**——每个工具定义自己的 UI 事件、结果策略、执行约束
3. **结果处理管线化**——所有工具走同一套后处理管线，但参数来自工具元数据
4. **并行透明化**——Agent 循环不需要知道哪些工具可并行，由元数据驱动

---

## 三、设计方案：增强的工具元数据模型

### 3.1 核心定义

```js
// shared/agent/tools/Read.js
export const Read = {
  // —— 基础信息 ——
  name: 'Read',
  description: '读取文件内容',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '文件路径' },
    },
    required: ['file_path'],
  },

  // —— 1. UI 状态事件：agent.js 自动读取并发射，替代硬编码 if/else ——
  statusEvent: {
    state: 'reading_file',
    detail: (args) => `正在读取 ${args.file_path}`,
  },

  // —— 1.5 工具调用摘要：tool_call 事件中前端 ToolCallBadge 展示的描述文本 ——
  callSummary: (args) => args.file_path || '',

  // —— 2. 结果处理策略：工具返回后由 agent 循环的通用管线执行 ——
  // （后续扩展，本次不实施）
  resultPolicy: {
    maxLength: 5000,       // 结果超过此长度自动截断（0 或 null = 不截断）
    truncation: 'head',    // 'head' | 'tail'（将来可扩展 'summary'）
    cacheable: true,       // 相同 args 的结果可缓存复用
    sensitive: false,      // 结果是否含敏感信息（不在日志中打印）
  },

  // —— 3. 执行约束 ——（后续扩展，本次不实施）
  execution: {
    parallelizable: true,  // 多个调用可同时执行（只读工具一般为 true）
    idempotent: true,      // 幂等，可安全重试
    confirmBeforeRun: false, // 执行前需用户确认（危险的 Bash 操作）
  },

  // —— 4. 错误分类 ——（后续扩展，本次不实施）
  errorPolicy: {
    expectedErrors: ['NOT_FOUND', 'PERMISSION_DENIED'], // "预期错误"，不视为异常
    fatalErrors: [],        // 致命错误，应中断 agent loop
  },

  // —— 5. 执行函数 ——
  execute: async (args) => { ... },
};
```

**`callSummary` vs `statusEvent.detail` 的区别**：

| 字段 | 语义 | 用途 | 时机 |
|------|------|------|------|
| `statusEvent.detail` | 进度描述 | 前端 status 事件，展示"正在做什么" | 工具执行前 |
| `callSummary` | 身份摘要 | 前端 tool_call 事件，ToolCallBadge 展示的标签 | LLM 返回 tool_calls 时 |

以 Bash 为例：`statusEvent.detail` = `"正在执行：ls -la src/"`，`callSummary` = `"列出源码目录内容"`（来自 `args.description`）。

### 3.2 各工具元数据参考

**本次实施**的字段：`statusEvent` + `callSummary`。后续扩展字段（`resultPolicy` / `execution` / `errorPolicy`）标注为将来启用。

```js
// Bash.js — 本次实施
{
  statusEvent: {
    state: 'executing_command',
    detail: (args) => `正在执行：${(args.description || args.command || '').substring(0, 50)}`,
  },
  callSummary: (args) => args.description || args.command?.substring(0, 50) || '',
  // 后续扩展：
  resultPolicy: { maxLength: 30000, truncation: 'tail', cacheable: false, sensitive: false },
  execution: { parallelizable: false, idempotent: false, confirmBeforeRun: true },
  errorPolicy: { expectedErrors: [], fatalErrors: [] },
}

// Write.js — 本次实施
{
  statusEvent: {
    state: 'writing_file',
    detail: (args) => `正在写入 ${args.file_path}`,
  },
  callSummary: (args) => args.file_path || '',
  // 后续扩展：
  resultPolicy: { maxLength: null, truncation: 'tail', cacheable: false, sensitive: false },
  execution: { parallelizable: false, idempotent: false, confirmBeforeRun: false },
  errorPolicy: { expectedErrors: [], fatalErrors: [] },
}

// Edit.js — 本次实施
{
  statusEvent: {
    state: 'editing_file',
    detail: (args) => `正在编辑 ${args.file_path}`,
  },
  callSummary: (args) => args.file_path || '',
}

// Glob.js — 本次实施
{
  statusEvent: {
    state: 'searching_files',
    detail: (args) => `正在搜索 ${args.pattern}`,
  },
  callSummary: (args) => args.pattern || '',
}
```

---

## 四、Agent 循环的通用化改造

### 4.1 工具执行管线（替换当前硬编码）

```js
// agent.js reasoning() 中 —— 完全通用的工具执行循环
for (const tc of toolCallsResult) {
  const toolName = tc.function.name;
  const toolArgs = JSON.parse(tc.function.arguments);
  const tool = this.toolRegistry.getTool(toolName);
  if (!tool) {
    yield { event: 'tool_error', data: { message: `工具 ${toolName} 不存在` } };
    continue;
  }

  // —— 步骤 1：发射状态事件 ——
  const se = tool.statusEvent;
  if (se) {
    yield {
      event: 'status',
      data: {
        state: se.state,
        detail: se.detail?.(toolArgs) || '',
      },
    };
  }

  // —— 步骤 2：执行（考虑并行） ——
  const result = await this.toolRegistry.execute(toolName, toolArgs);

  // —— 步骤 3：结果后处理 ——（后续扩展，本次不实施）
  // const processedResult = applyResultPolicy(result, tool.resultPolicy);

  // —— 步骤 4：检查预期错误 ——（后续扩展，本次不实施）
  // const finalResult = checkExpectedErrors(processedResult, tool.errorPolicy);

  // —— 步骤 5：保存到历史 ——
  this.messageManager.addToolResult(tc.id, result);

  yield { event: 'tool_result', data: { tool: toolName, status: 'success' } };
}
```

`callSummary` 在构建 `tool_call` 事件时使用（与 `statusEvent` 不同时机）：

```js
const toolCallsSummary = toolCallsResult.map(tc => {
  const toolName = tc.function.name;
  const toolArgs = JSON.parse(tc.function.arguments);
  const tool = this.toolRegistry.getTool(toolName);
  const entry = { name: toolName, args: toolArgs };
  if (tool?.callSummary) {
    entry.description = tool.callSummary(toolArgs);
  }
  return entry;
});
yield { event: 'tool_call', data: { tool_calls: toolCallsSummary } };
```

### 4.2 并行执行优化

利用 `execution.parallelizable` 元数据，对并行 tool_calls 做批量执行：

```js
// 按是否可并行分组执行
const { parallelGroup, serialGroup } = partitionToolCalls(toolCallsResult, tools);

// 可并行的同时执行
const parallelResults = await Promise.all(
  parallelGroup.map(tc => executeSingleTool(tc))
);

// 不可并行的逐个执行
const serialResults = [];
for (const tc of serialGroup) {
  serialResults.push(await executeSingleTool(tc));
}
```

**设计考量**：现实场景中大多数情况下 LLM 一次只返回一个 tool_call。并行是优化而非核心功能优先级可以降低，但数据结构上预留了扩展点。

### 4.3 结果后处理函数

```js
function applyResultPolicy(result, policy) {
  if (!policy || !policy.maxLength) return result;
  
  if (result.length <= policy.maxLength) return result;
  
  switch (policy.truncation) {
    case 'head':
      return result.substring(0, policy.maxLength) + '\n...(truncated)';
    case 'tail':
      return '...(truncated)\n' + result.substring(result.length - policy.maxLength);
    default:
      return result.substring(0, policy.maxLength) + '\n...(truncated)';
  }
}
```

---

## 五、与 MessageManager 的协作

### 5.1 职责边界

关键问题：**结果截断/处理是工具执行管线的事，还是 MessageManager 构建消息时的事？**

**方案 A：上游控制（在 agent.js 执行管线中处理）**

```
tool execute → 管线处理 → addToolResult(处理后的结果) → 存到历史
```

**方案 B：下游控制（在 messageManager.getMessagesForLLM() 中处理）**

```
tool execute → addToolResult(原始结果) → 存到历史
                                     → getMessagesForLLM() 时按策略截断
```

**推荐方案 A**，理由：
1. 截断后的信息已经丢失了，没必要保留在历史中
2. 缓存也是在原始结果上做的，截断不影响缓存
3. 但需要保留一个"保留原始结果用于下次紧凑"的窗口——如果下一轮 LLM 需要更多上下文，理想情况下可以从缓存恢复而不是从截断结果中猜

### 5.2 缓存协作

`resultPolicy.cacheable = true` 的工具，结果可以按 args 摘要缓存：

```js
// agent.js 管线中的缓存逻辑
const cacheKey = tool.cacheable ? hash(toolName, toolArgs) : null;
let result;
if (cacheKey && this._resultCache.has(cacheKey)) {
  result = this._resultCache.get(cacheKey);
  yield { event: 'status', data: { state: tool.statusEvent.state, detail: '结果已缓存' } };
} else {
  result = await this.toolRegistry.execute(toolName, toolArgs);
  if (cacheKey) this._resultCache.set(cacheKey, result);
}
```

---

## 六、向后兼容与迁移路径

### 6.1 兼容性

元数据字段全部可选，不存在的字段按默认行为处理：

| 缺失字段 | 默认行为 |
|---------|---------|
| 无 `statusEvent` | agent.js 不发 status 事件（即旧工具无变化） |
| 无 `callSummary` | tool_call 事件中不含 description 字段（前端 ToolCallBadge 不显示摘要） |
| 无 `resultPolicy` | 不截断，不过滤 |
| 无 `execution` | 不可并行，非幂等，无需确认 |
| 无 `errorPolicy` | 所有错误视为异常 |

### 6.2 迁移步骤

1. **第一步：给现有工具添加本次实施的元数据**
   - Read、Write、Edit、Bash、Glob 添加 `statusEvent` 和 `callSummary`
   - 同时删除 `agent.js` 中的硬编码 status 事件和 `toolCallsSummary` 中的 if/else

2. **第二步：在 agent.js 中加入通用管线**
   - 读取工具元数据，自动发射 status 事件
   - 读取 `callSummary`，数据驱动构建 `toolCallsSummary`
   - 合并 elf-001 和 elf-002 的 agent.js 为 DefaultAgent

3. **第三步（后续）：选择性启用扩展能力**
   - 添加 `resultPolicy`、`execution`、`errorPolicy` 元数据
   - 在 agent.js 管线中加入结果后处理逻辑（截断、缓存）
   - Read、Glob 启用并行执行（`execution.parallelizable`）
   - Read 启用结果截断（`resultPolicy.maxLength`）
   - Bash 保持串行

---

## 七、未解决的问题（讨论结论）

### 7.1 结果摘要模式

~~`truncation: 'summary'`——调 LLM 对工具输出做语义摘要。~~

**结论：不做。** 这次工具改造只保留 `head/tail` 机械截断。语义摘要是 messageManager 的责任——它知道当前上下文的 token 余量，在消息构建阶段按需对旧的大结果做 lazy 摘要更合理。放到将来 messageManager 的分层压缩能力中一并设计。

### 7.2 工具元数据覆盖

~~Agent 级别的 config 覆盖工具默认策略。~~

**结论：不做。** 需要定制行为的工具，直接在 shared 里写一个新工具或继承扩展。config.json 改 `tools` 列表即可引用新工具。

### 7.3 错误恢复策略

~~`errorPolicy.fatalErrors` 指示哪些框架级错误应中断 agent loop。~~

**结论：暂不做。** `fatalErrors` 的语义需要 agent.js 的全局 error handling 机制配合（中断循环、向上抛出），当前简单的 agent loop 不需要。本次重构只实施 `statusEvent` 和 `callSummary` 两个字段，`resultPolicy` / `errorPolicy` / `execution` 列为将来扩展。