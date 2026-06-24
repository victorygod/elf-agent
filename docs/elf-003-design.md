# elf-003 设计文档：创建 Agent 的 Agent

## 一、目标

elf-003 是一个专门用来创建其他 Agent 的 Agent。用户通过对话描述需求，elf-003 生成完整可运行的 Agent 目录结构，新 Agent 立刻出现在 Elf 平台侧栏中可用。

不需要可视化拖拽编辑器。创建 Agent 的门槛从"手写代码"降低为"对话描述 + shared/ 封装"。

## 二、当前创建 Agent 的痛点

现在创建一个新 Agent 需要手动完成以下工作：

1. 在 `agents/` 下新建目录
2. 编写 `index.js` —— 加载配置、初始化模型、注册工具、启动服务器（~30行，但每个 Agent 都重复）
3. 编写 `agent.js` —— LLM 调用循环、工具调用分发、流式响应（~100行，几乎完全相同）
4. 编写 `config.js` —— 配置加载逻辑（~40行，几乎完全相同）
5. 编写 `message_manager.js` —— 上下文管理、记忆压缩（~150行，大部分相同）
6. 编写 `config/config.json` —— Agent 身份和参数
7. 编写 `config/api_key.json` —— 模型连接信息
8. 编写 `config/system_prompt.md` —— 系统提示词
9. 编写 `config/config-ui.json` —— 配置面板 UI 描述（可选）
10. 编写 `server.js`、`tools/registry.js` —— 纯 re-export（完全相同）

其中 2-5 是**每个 Agent 都重复的框架代码**，6-9 是**声明式配置**，10 是**纯模板**。真正定义 Agent 个性的是 7（system prompt）和 3（如果有自定义推理逻辑）。

## 三、设计思路：先封装，再创建

### 3.1 第一步：shared/ 模块化

在 elf-003 能自动创建 Agent 之前，先把每个 Agent 重复写的框架代码抽到 shared/：

```
shared/
├── agent/
│   ├── server.js        ← 已有，HTTP 服务器
│   ├── llm_model.js     ← 已有，LLM 调用
│   ├── mock_model.js    ← 已有，测试用
│   ├── agent_loop.js    ← 新建：标准 Agent 循环（从 elf-001/agent.js 抽取）
│   ├── message_manager.js ← 新建：标准上下文管理（从 elf-001/message_manager.js 抽取）
│   ├── config_loader.js ← 新建：标准配置加载（从 elf-001/config.js 抽取）
│   └── tools/
│       ├── registry.js  ← 已有
│       ├── index.js     ← 已有
│       ├── Read.js      ← 已有
│       ├── Write.js     ← 已有
│       ├── Edit.js      ← 已有
│       ├── Bash.js      ← 已有
│       └── Glob.js      ← 已有
└── logger.js            ← 已有
```

抽取后，新 Agent 的 `index.js` 简化为：

```js
import { createAgent } from '../../shared/agent/index.js';

createAgent({
  tools: ['Read'],  // 声明需要哪些工具
  // 其他所有配置从 config/ 目录自动加载
});
```

`agent.js`、`config.js`、`message_manager.js` 不再需要。如果 Agent 需要自定义推理逻辑（比如 elf-002 的工具状态事件），可以通过钩子/选项扩展，不必重写整个循环。

### 3.2 第二步：elf-003 创建 Agent

有了 shared/ 封装后，elf-003 需要生成的文件大幅减少：

| 文件 | 是否必须 | 说明 |
|------|---------|------|
| `index.js` | 是 | 调用 `createAgent()`，指定工具列表。可从模板生成 |
| `config/config.json` | 是 | Agent 身份（agentId、name、port） |
| `config/api_key.json` | 是 | 模型连接信息 |
| `config/system_prompt.md` | 是 | **Agent 的核心——定义它的行为和能力** |
| `config/prefix_prompt.md` | 否 | 前缀提示词，默认为空 |
| `config/suffix_prompt.md` | 否 | 后缀提示词，默认为空 |
| `config/config-ui.json` | 否 | 配置面板 UI 描述，可从模板生成 |
| `config/avatar.png` | 否 | 头像，可用默认头像 |
| `agent.js` | 否 | 仅当需要自定义推理逻辑时 |
| `server.js` | 否 | createAgent() 内部处理 |
| `tools/registry.js` | 否 | createAgent() 内部处理 |
| `message_manager.js` | 否 | 使用 shared/ 默认实现 |
| `config.js` | 否 | 使用 shared/ 默认实现 |

elf-003 的核心任务是**生成 system_prompt.md、config.json、index.js**——定义新 Agent 是谁、能做什么、用什么模型。

## 四、elf-003 的能力

### 4.1 elf-003 自身需要的工具

elf-003 需要的工具与普通 Agent 不同——它操作的是文件系统中的 Agent 目录结构：

| 工具 | 功能 |
|------|------|
| **CreateAgentDir** | 在 `agents/` 下创建新目录及基础文件结构 |
| **WriteConfig** | 写入 `config.json`、`api_key.json` |
| **WritePrompt** | 写入 `system_prompt.md`、`prefix_prompt.md`、`suffix_prompt.md` |
| **WriteAgentCode** | 写入 `index.js`（基于 createAgent 模板），必要时写自定义 `agent.js` |
| **ReadExistingAgent** | 读取已有 Agent 的配置和 prompt，作为参考模板 |
| **ListAvailableTools** | 列出 shared/agent/tools/ 中所有可用工具及描述 |
| **RestartGateway** | 触发 gateway 重新扫描 Agent 目录（或调用 rediscover API） |

### 4.2 elf-003 的 system prompt 要点

elf-003 需要足够的知识来创建合理的新 Agent：

- 了解 Agent 目录结构（`agents/{id}/` 下的文件组织）
- 了解 shared/ 提供的 `createAgent()` API 和可用工具列表
- 了解 `config.json` 的字段含义和约束（agentId 唯一、port 不冲突等）
- 了解 `config-ui.json` 的格式
- 能根据用户描述生成合适的 system prompt
- 能根据用户需求选择合适的工具集
- 能分配不冲突的端口号

### 4.3 对话创建流程示例

```
用户：帮我创建一个翻译 Agent，能读写文件，用 deepseek-chat 模型

elf-003：好的，我来创建翻译 Agent。
  1. 创建 agents/translator/ 目录
  2. 生成 config.json（agentId: translator, port: 8083, name: 翻译助手）
  3. 生成 api_key.json（model: deepseek-chat，复用现有 base_url 和 token）
  4. 生成 system_prompt.md（定义翻译能力和行为准则）
  5. 生成 index.js（注册 Read、Write 工具）
  6. 通知 gateway 重新扫描

  Agent "翻译助手" 已创建并启动，你现在可以在侧栏看到它。
  需要我调整它的系统提示词或添加更多工具吗？
```

```
用户：我想让它保留术语表，翻译时前后文连贯

elf-003：我来更新它的 system_prompt.md，加入术语表管理和上下文连贯的指令。

  [更新 system_prompt.md]

  更新完成。它会在翻译时：
  - 自动维护术语对照表
  - 保留最近 6 轮上下文确保连贯性

  需要调整上下文窗口大小吗？默认是 500 token。
```

```
用户：我想参考 elf-001 的配置来创建一个类似的

elf-003：让我看看 elf-001 的配置……
  [读取 elf-001 的 config.json 和 system_prompt.md]

  elf-001（Fengyue）是一个通用聊天 Agent，使用 Read 工具，
  有 prefix/suffix prompt，记忆限制 500 token。

  你想基于它创建什么类型的 Agent？继承哪些配置？
```

## 五、待讨论的问题

### 5.1 shared/ 封装的边界

shared/ 的 `createAgent()` 需要覆盖当前 elf-001 和 elf-002 的所有差异点：

| 差异 | elf-001 | elf-002 | createAgent() 如何处理 |
|------|---------|---------|----------------------|
| 工具集 | Read | Read, Write, Edit, Bash, Glob | 参数声明 `tools: [...]` |
| prefix/suffix prompt | 支持 | 不使用 | 参数 `usePrefixSuffix: true/false` 或自动检测 |
| 自定义 agent 事件 | 无 | Write/Bash 的 status 事件 | 钩子 `onToolCall?.()` 或工具声明时配置 |
| config.js 加载逻辑 | 读取 prefix/suffix | 只读取 system | 统一加载，空文件即不启用 |

还有没有其他差异？需要彻底对比 elf-001 和 elf-002 的代码来确认 `createAgent()` 的 API 设计。

### 5.2 自定义推理逻辑

某些 Agent 可能需要自定义 `agent.js` 中的推理逻辑（比如多步推理、条件分支、自定义 SSE 事件）。`createAgent()` 提供的默认循环不够用时：

- **方案 A**：钩子系统——默认循环中预留 `beforeToolCall`、`afterToolCall`、`onReasoning` 等钩子，Agent 通过配置注入自定义行为
- **方案 B**：允许覆盖——Agent 可以提供自己的 `agent.js`，不使用 `createAgent()` 的默认循环
- **方案 C**：策略模式——`createAgent()` 接受 `strategy` 参数，内置几种常见推理策略（单轮、多轮、带条件等），自定义策略通过注册扩展

需要根据实际需求决定。初期可以先用方案 B（允许覆盖），后续抽象出模式后再升级。

### 5.3 端口分配

每个 Agent 需要唯一的端口号。当前 elf-001 用 8081，elf-002 用 8082。elf-003 自己也需要一个端口。

自动分配端口的策略：
- 扫描 `agents/*/config/config.json` 找到已占用的端口
- 从 8081 开始递增，找到第一个空闲端口
- 或者由 gateway 提供端口分配 API

### 5.4 创建后的生命周期

elf-003 创建新 Agent 后：
1. 写入文件 → 文件系统就绪
2. 调用 `POST /agents/rediscover` → gateway 发现新 Agent
3. 调用 `POST /agents/:id/start` → 启动新 Agent
4. 用户在侧栏看到新 Agent → 开始对话

步骤 2-3 可以在 elf-003 的工具中自动完成，用户无需手动操作。

### 5.5 elf-003 的权限和安全

elf-003 可以在 `agents/` 下创建目录和文件——这是一个强权限。需要考虑：
- 是否限制只能创建在 `agents/` 下
- 是否需要用户确认后才能真正写入（先预览，再确认）
- 防止覆盖已有 Agent 的配置（除非用户明确要求修改）
- 创建的 Agent 继承 elf-003 的模型配置还是使用独立配置

### 5.6 已有 Agent 的修改

elf-003 除了创建新 Agent，是否也应该能修改已有 Agent？比如：
- "帮 elf-001 添加一个 Write 工具"
- "修改翻译 Agent 的 system prompt，加入术语表管理策略"

这需要 elf-003 能读取和修改已有 Agent 的文件，比纯创建更复杂但非常有用。