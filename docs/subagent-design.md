# subAgent 设计文档

> 参考 Claude Code (cli.js v2.1.77) 的 subagent 机制,落地到 elf。
> 设计原则:按 elf 实际取舍,**与 CC 的所有差异显式记录**(见 §四),不严格照搬。
> 本期范围:实现 `Explore` 和 `general-purpose` 两个 subagent 类型。
> **前置依赖**:Loop 并发改造(`docs/loop-concurrency-design.md`)完成后开展——subagent 复用其 `runLoop` 内核。

---

## 一、CC subagent 机制(已从 bundle 核实)

> CC bundle 位置见 memory `cc-cli-bundle-path`(v2.1.77 cli.js)。核实具体点时去该 bundle 核对,不凭记忆。

### 1.1 subagent 是什么

subagent 不是新程序,而是**主 agent 复用同一套 agentic loop,只换一份"配置外衣"**。配置对象(CC 形态,elf 落地有取舍,见 §四):

```js
{
  agentType,                 // 唯一标识 / 选择 key
  whenToUse,                 // 触发描述,贴进主 prompt 让模型知道何时用
  tools / disallowedTools,   // 工具白名单 / 黑名单
  model,                     // "haiku" | "inherit" | 具体模型
  getSystemPrompt(),         // 子 agent 的 system prompt
  permissionMode,            // 权限模式 (bubble 等) —— elf 不实现
  source,                    // "built-in" | "file" —— elf 只 built-in
  criticalSystemReminder_EXPERIMENTAL  // 兜底只读提醒
}
```

主 agent 调一次 `Agent` 工具 = 用 `subagent_type` 选一套配置 → 主进程内拉起一个新的、独立的 agent loop 实例 → 跑完把最终文本作为 tool_result 返回。

### 1.2 Agent 工具(启动 subAgent 作为 tool)

CC 的 `Agent` 是注册在工具表里的一个工具。输入 schema(CC 形态,elf 落地有取舍):

```js
{
  description,            // 3-5 词
  prompt,                 // 子 agent 的任务(零上下文,需 briefing)
  subagent_type,          // 选哪套配置(string, optional)
  model,                  // CC: "sonnet"|"opus"|"haiku" override —— elf 本期不做(见 §四差异2)
  run_in_background       // 是否后台 (本期不做)
}
```

> elf 本期 **Agent 工具不暴露 `model` 参数**:elf 当前每 agent 单模型(api_key.json 的 `model` 字段),无多模型映射,model override 无意义。subagent 一律 inherit 主 agent 模型。见 §四差异2。

### 1.3 关键机制(逐条核实证据)

#### (A) 零上下文
非 fork 分支:子 agent 初始 messages **只有一条 user 消息**,不继承主对话历史。主 agent 必须在 `prompt` 参数里把背景讲清楚(briefing)。

#### (B) 同一套 loop 内核,不另起进程
子 agent 跑和主 agent **同一个 loop 内核**(CC 里是 `sv(...)`),在主进程内创建新实例,**不另起进程**。映射到 elf:复用本工程抽出的 `runLoop` 内核(§2.0/§五步骤1),用轻量、无副作用实例(不开 HTTP server、不写主 agent context.json)。

#### (C) 工具集过滤(黑名单/白名单二选一)
- 有 `disallowedTools` → 从全量工具 filter 掉黑名单
- 有 `tools: ["*"]` → 全开
- 有显式 `tools` 列表 → 白名单

Explore 用黑名单,**关键含 Agent 自身 → 子 agent 不能再调 Agent → 禁止嵌套**。

#### (D) 模型解析(本期简化:全 inherit)
CC 是三层覆盖(调用参数 > agent 定义 > inherit 主模型)。**elf 本期不实现 model override**——elf 当前每 agent 单模型(无多模型映射/别名),subagent 一律 **inherit 主 agent 模型**。Explore 的"快"靠并发(只读工具并行)+ 短系统提示,不靠模型差异。未来有多模型需求再加 model 机制(见 §四差异2)。

#### (E) 结果回流
子 agent 流的最后一条 assistant 文本 → 作为 tool_result 返回主 loop。中间工具调用噪声隔离在子 loop,不进主上下文。

#### (F) 并发(由并发工程提供,非 subAgent 专属)
并发是 loop 内核 + 工具属性的通用机制(见 `docs/loop-concurrency-design.md` §三)。subAgent 不写特殊并发逻辑:
- **工具执行层**:子 agent 内部只读工具并发(共用 runLoop 的 processQueue)
- **Agent 工具层**:`Agent` 工具自身 `isConcurrencySafe=true` → 主 loop 一批可同时拉起多个 subagent(本工程交付,见 §3.2)

### 1.4 内置 agent type 全景(本期只用前两个)

| agentType | model(本期) | 工具 | 角色 |
|---|---|---|---|
| **Explore** | inherit 主模型 | 黑名单去写操作(只读) | 找文件/搜代码/回答代码库问题 |
| **general-purpose** | inherit 主模型 | `["*"]` 全开 | 兜底通用,能改文件 |
| Plan / statusline-setup / fork / teammate / custom 等 | — | — | 本期不做 |

---

## 二、elf 现状(已核实)

- 所有 agent 已走基类 `Agent.reasoning()`(elf-002 副本已删,见 `docs/compact-redesign.md` §六)。
- loop **并发改造前是串行**(待并发工程完成,见 `docs/loop-concurrency-design.md`)。
- 工具:6 个 — `Read / Write / Edit / Bash / Glob / Grep`(即将加 `isConcurrencySafe`)。
- 会话状态:`MessageManager`(in-memory `messages` + 持久化 `context.json`)。loop 每轮调 `getMessagesForLLM()`(纯拼接 `[system, ...messages]`,无 summary 注入)/ `addAssistantToolCalls` / `addToolResult`。子 agent **继承父 agent MM 类** new 临时实例(临时 dataDir、跑完清),见 §3.4。压缩细节见 `docs/compact-redesign.md`。
- LLM:`llm_model.js`,原生 fetch OpenAI-compatible,支持流式 `chatStream`。
- **现状无任何 subagent / fork / background task / nested agent**。
- 进程模型:gateway 用 ProcessManager 把每个 agent 拉成独立进程;agent server 串行排队请求。本期 subagent 在**进程内**跑,不动这个。

### 2.0 前置依赖 + 本工程产出

**前置(并发工程提供)**:
- `isConcurrencySafe` + processQueue——子 agent 内部工具并发;Agent 工具自身 `isConcurrencySafe=true` 并发
- execute 加 signal——子 agent 工具中断

**本工程产出(runLoop 抽离)**:
- 并发工程**不抽 runLoop**(只改 reasoning tool 执行段,见并发文档 §5.6)。**runLoop 抽离归本工程**:把 reasoning loop 核心抽成 `runLoop({model, tools, messageManager, maxIterations, signal, stream, onIterationStart, onLoopEnd})`,供主/子 agent 共用。
- `onIterationStart`/`onLoopEnd` 钩子:主 agent 注入主 MM 的 compactIfNeeded(循环内 + 循环后兜底);子 agent 注入其临时 MM(继承父 agent MM 类)的 compactIfNeeded。compaction 不进 runLoop 内核,经钩子注入(对齐 compact 文档时机)。
- 子 agent 调 `runLoop({stream:false})` 跑完取 finalText。

→ **本工程在并发工程完成后开展**。runLoop 抽离是本工程第一步(主子共用 loop 才需要)。

---

## 三、elf subAgent 设计

### 3.1 总体架构

```
主 agent loop (并发工程完成后的 CC 式 processQueue)
  └─ 工具表(ToolRegistry)新增 Agent 工具, isConcurrencySafe=true
     └─ Agent.execute({subagent_type, prompt})
        ├─ registry[subagent_type] 取配置(Explore / general-purpose)
        ├─ 解析 tools: 全集 minus disallowedTools (Explore) | 全集 (general-purpose)
        ├─ 构造子 agent 临时 MessageManager(继承父 agent MM 类):
        │    临时 dataDir(os.tmpdir 下,跑完清)
        │    systemPrompt = 配置.getSystemPrompt() + criticalReminder
        │    config = 父 agent config(继承压缩配置 compactSystemPrompt/compactPrompt/阈值)
        │    messages = [{role:'user', content: prompt}]   ← 零上下文
        │    不开 server / 不污染主 agent data/
        ├─ 跑子 agent runLoop(stream:false, 钩子注入 subMM.compactIfNeeded)
        ├─ 取子 agent 最终 assistant 文本 → 作为 tool_result 返回主 loop
        └─ fs.rmSync(临时 dataDir)  ← 清临时目录(L1 tool-results + context.json)
```

### 3.2 Agent 工具定义

新增文件:`shared/agent/tools/Agent.js`

```js
{
  name: "Agent",
  description: "启动一个子 agent 执行任务。子 agent 有独立上下文(看不到当前对话),需在 prompt 里说明任务背景。可选 subagent_type: Explore(只读检索) / general-purpose(通用,可改文件)。",
  parameters: {
    type: "object",
    properties: {
      subagent_type: { type: "string", enum: ["Explore", "general-purpose"], description: "子 agent 类型" },
      prompt:        { type: "string", description: "给子 agent 的完整任务描述(零上下文,需 briefing)" },
      description:   { type: "string", description: "3-5 词任务摘要" }
      // model 参数本期不暴露:subagent 一律 inherit 主 agent 模型(见 §四差异2)
    },
    required: ["subagent_type", "prompt"]
  },
  isConcurrencySafe: true,   // ★ 多个 subagent 可并行(并发工程已就绪 isConcurrencySafe 机制)
  async execute(args) { ... }
}
```

### 3.3 subAgent 配置注册表

新增文件:`shared/agent/subagents/registry.js`(或挂到现有 ToolRegistry 同级)

```js
const subagentDefinitions = {
  "Explore": {
    agentType: "Explore",
    whenToUse: "只读检索 agent:按 pattern 找文件、搜代码关键词、回答代码库问题。快、广撒网。靠只读工具并发(并发工程提供),不靠模型差异。",
    disallowedTools: ["Agent", "Edit", "Write"],   // ★ 含 Agent 自身 → 禁止嵌套
    // model: 本期不设,inherit 主 agent 模型(见 §四差异2)
    getSystemPrompt: () => EXPLORE_SYSTEM_PROMPT,
    criticalSystemReminder: "CRITICAL: 这是只读任务。你不能编辑/写/删文件。"
  },
  "general-purpose": {
    agentType: "general-purpose",
    whenToUse: "通用 agent:研究复杂问题、多步执行、可改文件。工具全开,继承主模型。",
    tools: ["*"],
    // model: inherit 主 agent 模型
    getSystemPrompt: () => GENERAL_PURPOSE_SYSTEM_PROMPT,
    criticalSystemReminder: null
  }
};
```

> Explore 的 `disallowedTools` 是 elf 工具名空间:去掉 `Agent / Edit / Write`,保留 `Read / Grep / Glob / Bash`(Bash 需在 prompt 里限制只读)。是否把 Bash 也剔出 Explore 待定——CC 的 Explore 保留只读 Bash。见 §3.6。

### 3.4 子 agent:零对话上下文 + 引擎部件复用(依赖并发工程 runLoop)

子 agent **对话上下文零继承**:不继承父 agent 的对话历史,仅由父 agent 创建时给定的一条 `prompt`(任务目标)作为唯一 user 消息(§1.3 A 零上下文)。这与"引擎部件复用"是两回事,必须分清:

- **对话上下文**:零继承。子 agent `messages = [{role:'user', content: prompt}]`,看不到父 agent 历史。
- **引擎部件复用**:子 agent 跑 loop 需要 model / MM 类 / config 这些引擎件,从主 agent 取(继承主 agent 的 model、同类 MM、Config 实例)。这是"用主 agent 的引擎跑子任务",**不是"继承父对话"**。

子 agent 调并发工程的 `runLoop`,`stream:false`(关流式,跑完返回 finalText)。引擎部件:复用主 agent 的 **model 实例**(本期不做 model override)+ **同类 MessageManager**(new 一个临时实例,继承父压缩策略)+ **Config 实例**(读压缩配置/阈值)。临时 MM 用**临时 dataDir**(隔离、跑完清),messages + tool-results 都落临时目录、不污染主 agent,跑完整体删。

```js
const subTools = filterTools(allTools, def);   // Explore 去黑名单
// 临时 dataDir:子 agent 的 L1 tool-results / context.json 都落这里,跑完整体删,不碰主 agent
const subDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-subagent-'));
const subMM = new ParentMMClass({              // 复用主 agent 同类 MM(引擎件,非上下文)
  systemPrompt: def.getSystemPrompt() + (def.criticalSystemReminder ?? ''),
  dataDir: subDataDir,                         // 临时目录:L1 tool-results + context.json 都落此
  config: parentConfig,                        // 复用主 agent Config(读压缩配置/阈值)
});
subMM.addUserMessage(prompt);                  // 零上下文:只一条 user(任务目标)

const result = await runLoopToCompletion({
  model: parentModel,                          // 复用主 agent model 实例(inherit,本期不做 override)
  tools: subTools,
  messageManager: subMM,                       // 临时 MM(同类,继承压缩策略)
  maxIterations: parentMaxIterations,          // 继承父 agent maxIterations(如 elf-002=0 无限)
  stream: false,                               // 关流式:不 yield 事件,跑完返回 finalText
  // runLoop 钩子注入 subMM 的 compactIfNeeded(循环内 + 循环后),与主 agent 同构
});
// 跑完清临时目录(L1 持久化的 tool-results + context.json 一起删,不残留)
fs.rmSync(subDataDir, { recursive: true, force: true });
return result.finalText;                       // → Agent tool 的 tool_result
```

> **引擎部件复用(非上下文继承)**:子 agent 用主 agent 的 model + 同类 MM + Config。MM 类决定压缩策略(elf-002 子 agent → elf-002 MM 的 CC 增强 L4+L1/L2;elf-001 子 agent → 基类 naive L4),与主 agent 一致。长任务子 agent 也受压缩保护。对齐 CC(CC 子 agent 复用主 loop 同套 autocompact/microcompact)。
>
> **临时 dataDir 隔离**:子 agent 的 L1 tool-results、context.json 全落临时目录(`os.tmpdir()` 下),不碰主 agent 的 `data/`。跑完 `fs.rmSync` 整体清,无残留、无污染。messages 不持久化到主 agent(临时目录跑完即删,等同不持久化)。
>
> **关流式**:子 agent 不 yield 事件(已核实 CC `subagentStream:false`,§四差异5),结果作 finalText 回流主 loop。无"并发执行 + 流式 yield 交错"问题。
>
> **引擎部件怎么拿到(落地时定)**:Agent 工具 execute 当前签名 `(args)`,取不到主 agent 的 model/MM类/Config。落地时机制二选一:① ToolRegistry.execute 透传 agent 上下文(所有工具收到,仅 Agent 用);② Agent 工具注册时闭包绑定主 agent 引用。此为落地实现细节,不阻塞设计。
>
> **子 agent maxIterations(继承父,**§四差异12)**:子 agent **继承父 agent maxIterations**(如 elf-002 子 agent=0 无限)。CC subagent 可有 `maxTurns`(general-purpose 默认不设=无限,可覆盖);elf 取简单策略——子 agent 不独立设上限,跟随父。落地时 `runLoop` 传父 maxIterations。

### 3.5 Explore 的 Bash 处理(待定)

CC 的 Explore 保留 Bash,但 prompt 强约束只读(ls/git status/git log/git diff/find/grep/cat/head/tail),禁止 mkdir/touch/rm/cp/mv/git commit 等。

elf 选项:
- **(A) Explore 保留 Bash,prompt 里强约束只读**(照搬 CC,推荐)
- (B) Explore 直接 disallow Bash,只用 Read/Grep/Glob(更激进,可能不够用)

倾向 A。Bash 的 `isConcurrencySafe` 由并发工程定(本期一律 false 串行,见并发文档 §5.1/§四差异5)。后续可细化只读判定。

### 3.6 Explore 的 system prompt(照搬 CC 思路)

要点:
- 反复强调 READ-ONLY,列出禁止事项(不创建/修改/删除/移动文件,不写 /tmp,不用重定向 > >> |,不跑 mkdir/touch/rm/git add/commit/npm install 等)
- 工作方式:Glob/Grep 找、Read 读、Bash 只做只读命令
- **并行调用工具**(快,依赖并发工程)
- 返回**绝对路径**
- 报告直接以文本返回,不创建文件
- thoroughness 由调用方在 prompt 里指定(quick/medium/very thorough)

general-purpose 的 system prompt:通用助手,可改文件,briefing 充分。

---

## 四、与 CC 的差异(已核实 bundle,随实现 review 更新)

> CC bundle 核实见 memory `cc-cli-bundle-path`(v2.1.77)。已核实:`subagentStream:false`(子 agent 关流式)、exec 用 abortSignal+signal kill 子进程、子 agent 结果取 lastAssistantText 回流。

| # | 点 | CC | elf | 理由 |
|---|---|---|---|---|
| 1 | 配置对象字段 | 含 `permissionMode`/`source` 等 | elf **不实现 permissionMode**;`source` 只 `built-in`(无文件来源 custom agent) | elf 无权限系统、本期无文件来源 agent |
| 2 | model override | 三层覆盖(调用参数/agent定义/inherit),haiku/sonnet/opus 别名 | **本期不做 model override**,subagent 一律 inherit 主 agent 模型 | elf 当前每 agent 单模型(api_key.json 的 `model`),无多模型映射/别名,model override 无意义;未来有多模型再加 |
| 3 | loop 起步 | 主 loop 已并发 | 串行起步,由并发工程改并发 | elf 历史;subAgent 依赖并发工程成果 |
| 4 | 流式事件 yield | CC 事件驱动架构 | **执行并发、yield 串行**(elf 自定) | 见并发文档 §四差异2;CC 架构不同,elf 自定保守安全 |
| 5 | 子 agent 流式 | **关流式**(`subagentStream:false`,已核实) | **关流式**(stream:false,跑完返回 finalText,主 loop 转发) | 已核实 CC 也关流式,elf 对齐;用户不需要子 agent 进度 |
| 6 | 工具集 | 含 WebFetch/NotebookEdit/ExitPlanMode 等 | elf 6 个(Read/Write/Edit/Bash/Glob/Grep),无 ExitPlanMode | elf 工具空间;Explore 黑名单用 elf 工具名 |
| 7 | Bash | `isConcurrencySafe` 按只读判定 | 一律 false 串行(本期) | 见并发文档 §四差异5 |
| 8 | Agent 工具并发 | `isConcurrencySafe=true` | 同(本工程交付,依赖并发工程 isConcurrencySafe 机制) | 一致 |
| 9 | 子 agent 压缩 | 复用主 loop 同套 autocompact/microcompact(子 agent 也压缩) | **子 agent 继承父 agent MM 类**(临时 dataDir、跑完清),走父 compactIfNeeded:elf-002 子 agent = CC 增强 L4+L1/L2;elf-001 子 agent = naive L4。**与父一致、长任务子 agent 也受保护** | 已核实 CC 子 agent 默认带 autocompact(`deps??A4q()`);elf 对齐"子 agent 也压缩"。子 agent 临时 dataDir 隔离,不污染主 agent;见 §3.4 |
| 10 | 主子 agent 压缩策略 | CC 单套(无主子差异) | elf **主子一致**(子继承父 MM 类) | elf 有 naive/CC增强分层,子 agent 继承父那层,主子一致;CC 单套无此问题。这是 elf 特有取舍 |
| 11 | compaction 与 loop 内核 | CC compaction 在 loop 内 | elf **compaction 不进 runLoop 内核**,主/子 agent 都经 onIterationStart/onLoopEnd 钩子注入各自 MM 的 compactIfNeeded | runLoop 抽离归本工程(§2.0);主子都用钩子注入,统一机制 |
| 12 | 子 agent 轮数上限(maxTurns) | subagent 定义可有 `maxTurns`(general-purpose 不设=默认无限,implicit fork=200,side_question=1,调用方可覆盖) | **子 agent 继承父 maxIterations**(如 elf-002 子 agent=0 无限;不独立设上限) | 已核实 CC maxTurns 可选可覆盖;elf 取简单策略——子 agent 跟随父,见 §3.4 |
| 13 | baseDir / hooks / permissionMode | CC subagent 定义含 `baseDir`/`hooks`/`permissionMode` 等 | elf **不实现**(无 baseDir 概念、无 hooks 系统、无权限) | elf 工具空间/架构不同;属特有取舍,本期不做 |

---

## 五、落地步骤(并发工程完成后)

1. **抽 runLoop 内核**(本工程产出,§2.0):`shared/agent/agent_loop.js`,把 `reasoning()` 核心抽成 `runLoop({model, tools, messageManager, maxIterations, signal, stream, onIterationStart, onLoopEnd})`,compaction 经钩子注入。主 agent `reasoning()` 改包一层(传主 MM 钩子 + 持久化)。先保证主 agent 行为不变(零回归)。
2. **subAgent 配置**:`shared/agent/subagents/registry.js` + Explore/general-purpose 定义 + system prompt(无 model 字段,inherit)。
3. **Agent 工具**:`shared/agent/tools/Agent.js`,`isConcurrencySafe=true`,execute 里查 registry + 构造子 agent 临时 MM(继承父 agent MM 类、临时 dataDir、继承父压缩配置)+ 跑 runLoop(`stream:false`,钩子注入 subMM.compactIfNeeded,继承父 maxIterations) + 返回 finalText + 跑完 `fs.rmSync` 临时 dataDir。
4. **Explore disallowedTools 验证**:确认子 agent 拿不到 Agent/Edit/Write(嵌套阻断)。
5. **测试**:单 Explore / 单 general-purpose / 多 Explore 并行 / Explore 内尝试调 Agent 应失败;子 agent 长任务触发压缩(继承父策略);临时 dataDir 跑完清、不污染主 agent data/。

---

## 六、不做(本期范围外)

- `run_in_background` / 后台 subagent(CC 有)
- Plan / statusline-setup 等其他类型
- fork(继承主上下文)
- Agent Teams / teammate
- 文件来源的 custom agent(`.claude/agents/*.md`)
- permissionMode(elf 无权限系统)
- model override / 多模型映射(elf 当前单模型,subagent 一律 inherit;见 §四差异2)
- 主 loop 并发改造本身(归并发工程,见 `docs/loop-concurrency-design.md`)
