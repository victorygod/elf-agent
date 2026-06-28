# Loop 并发改造设计文档

> 把 elf 主 agent loop 的 tool 执行从**串行**改成 **CC 式带闸门并发**(只读工具并发、写工具串行)。
> 这是 loop 基础设施工程,**范围最小:只做工具并发,不抽 runLoop**(runLoop 抽离归 subAgent 工程,那时主子共用才需要)。
> 参考 Claude Code v2.1.77 bundle(位置见 memory `cc-cli-bundle-path`)。

---

## 一、设计目标

1. 同一批 `tool_calls`(一次 LLM 响应返回的)里,**只读工具并发执行**,写工具串行,单 tool_call / 全写时退化成现在的串行行为(**零回归**)。
2. 并发能力挂在**工具**上(`isConcurrencySafe` 字段),不是挂在 agent 类型上——所有 agent 走基类 reasoning 即获得并发。
3. 保持流式事件顺序:**执行并发,yield 串行**(前端不乱序)。
4. 范围最小:**直接改 reasoning 的 tool 执行段**,不抽 runLoop、不改 compaction 注入方式(那两项归 subAgent 工程)。

---

## 二、现状(已核实)

- `shared/agent/default_agent.js` `Agent.reasoning()` 是 async generator。
- **tool 执行串行**:`for (const tc of toolCallsResult)`(line 334)→ `await this.toolRegistry.execute(toolName, toolArgs)`(line 356)→ `addToolResult(tc.id, result)`(line 357),一个接一个。
- 6 个工具(`Read/Write/Edit/Bash/Glob/Grep`)**均无 `isConcurrencySafe` 字段**。
- `ToolRegistry`(registry.js):`{name, description, parameters, execute}` + 可选 `statusEvent`/`callSummary`,简单 Map。
- 流式事件:`status`/`tool_result` 目前是每个工具执行后顺序 yield(line 323–351 区域);`token` 来自 LLM 流式、在工具执行之前。
- 所有 agent 已走基类 reasoning(elf-002 副本已删)。

---

## 三、CC 机制(已从 bundle 核实)

CC 主 loop **不是串行**,是带并发闸门的并行。`isConcurrencySafe` 是工具字段,队列逻辑 `processQueue`(bundle offset ~9049709):

```js
canExecuteTool(A){
  let executing = this.tools.filter(t => t.status === "executing");
  return executing.length === 0 || (A && executing.every(t => t.isConcurrencySafe));
}
async processQueue(){
  for(let A of this.tools){
    if(A.status !== "queued") continue;
    if(this.canExecuteTool(A.isConcurrencySafe)) await this.executeTool(A);  // 可并行就并发
    else if(!A.isConcurrencySafe) break;                                      // 不安全就停下等
  }
}
```

规则:
- 同时执行中的工具,只要都是 `isConcurrencySafe` 就可再加一个并发
- 遇到非并发安全工具(写操作)就 break,等它完成
- `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 上限,默认 10

CC 工具标志(全景,仅参考):
| 工具 | isConcurrencySafe |
|---|---|
| Read / Grep / Glob / WebFetch | true |
| Edit / Write / Bash(非只读) / NotebookEdit | false |
| Agent(subAgent 启动器) | true ← 多 subagent 可并行 |

→ **并发不是某 agent 专属,是 loop 通用机制**:Explore 之所以"快"只是它工具集全是只读 → 自然全程可并发;主 agent / general-purpose 同样,本批都是只读工具就并发,遇到写工具才串行。落地是同一个 processQueue,**不为任何 agent 类型写特殊并发分支**。

---

## 四、与 CC 的差异(显式记录)

| # | 点 | CC | elf | 理由 |
|---|---|---|---|---|
| 1 | 起步状态 | 主 loop 已并发 | 串行,本期改并发 | elf 历史串行,本次追赶 |
| 2 | 流式事件 yield | CC 事件驱动架构,非 async generator | **执行并发、yield 串行**(elf 自定) | elf reasoning 是 async generator 边执行边 yield;CC 是事件驱动架构不同,elf 不照搬,自定"yield 串行"保守安全(避免前端乱序)。已核实 CC 架构不同,不硬对齐 |
| 3 | Agent 工具并发 | `isConcurrencySafe=true`(多 subagent 并行) | **本期不做**(Agent 工具尚未存在) | 本工程只做工具执行并发;Agent 工具并发交 subAgent 工程那时它才存在 |
| 4 | webfetch/NotebookEdit | 有 | elf 工具集 6 个(无这俩) | elf 工具空间不同,见 §五工具表 |
| 5 | Bash 只读判定 | `isConcurrencySafe(A){ return this.isReadOnly(A) }`(只读命令才并发) | Bash 一律 false(串行) | elf 本期不做只读命令判定,简化;后续可细化 |
| 6 | Bash 中断 | execa `signal` 参数,abort 自动 kill 子进程 | Bash.execute 接 signal,abort 时 `child.kill(SIGTERM→3s→SIGKILL)`(复用现有 timeout kill 模式) | 已核实 CC 靠 execa signal;elf 用原生 child_process,手动 kill,机制对齐(abort→SIGTERM→SIGKILL) |
| 7 | 工具中断(signal 传递) | 工具 execute 接 abortSignal | elf 工具 execute **本期加 signal 参数** | elf 现有 execute 只接 args,无 signal;为支持并发中断,改为 `execute(args, signal)`。各工具按需检查 signal(Read/Glob/Grep 可中途检查;Bash 用 kill 子进程;Edit/Write 一般很快,落 best-effort) |

> 已核实(CCV2.1.77 bundle):CC 子 agent 关流式(`subagentStream:false`)、exec 用 abortSignal+signal kill 子进程、子 agent 结果取 lastAssistantText 回流。elf 子 agent 流式与之对齐(见 subAgent 文档)。

---

## 五、改动清单

### 5.1 给 6 个工具加 `isConcurrencySafe`(elf-002 工具空间)

| 工具 | isConcurrencySafe | 理由 |
|---|---|---|
| Read | true | 只读 |
| Glob | true | 只读 |
| Grep | true | 只读 |
| Bash | false | 有状态、可能写;本期不做只读判定 |
| Edit | false | 写 |
| Write | false | 写 |

工具定义对象加字段:`{ name, description, parameters, execute, isConcurrencySafe }`。同时 execute 签名加 signal 参数(§5.5)。ToolRegistry/6 个工具文件改。

### 5.2 tool 执行段改并发 processQueue

当前(line 334 附近):顺序 `for` 每个 tool_call → `await execute` → `addToolResult`。

**执行顺序(对齐 CC processQueue 语义)**:同一批 tool_calls 里,**先并发执行所有 `isConcurrencySafe=true` 的工具(上限 10);遇到 `isConcurrencySafe=false` 的写工具,串行逐个执行(写工具之间也串行)**。即:安全的并发跑、不安全的排队一个一个来。混合批次里,只读工具并发 + 写工具串行,不交叉并发。

改为:
1. 收集本批 `toolCallsResult`,按 tool_call 原顺序保留索引
2. 按上述语义执行:只读工具 Promise 并发发起(上限 10)、写工具串行 await 逐个
3. 全部结果 collect
4. 按 **tool_call 原顺序**串行 `addToolResult` + 补 yield 事件(**执行并发,yield 串行**,见 §5.4)

并发上限(env 可配):
```
MAX_TOOL_USE_CONCURRENCY = env.MAX_TOOL_USE_CONCURRENCY ?? 10
```

> 零回归保证:单 tool_call / 全是写工具时,行为与现在串行等价(只读批次才并行)。

### 5.3 中断设计(abort 立刻中断所有并发工具 + Promise)

**目标**:用户 abort 时,立刻中断所有正在并发执行的工具,不再收结果、loop 退出。

**机制**:
- 工具 `execute` 签名改为 `execute(args, signal)`(§5.5),主 loop 把 `AbortController.signal` 传给每个并发工具。
- abort 触发 → signal aborted → 各工具自行检查(signal.aborted 抛出/返回);**Bash 用 `child.kill(SIGTERM→3s→SIGKILL)`** 杀子进程(对齐 CC execa signal kill,见 §四差异6)。
- 主 loop 不再 await 剩余 Promise,直接走 abort 流程(yield aborted/done return)。后台未完成的 Promise 结果丢弃、不 addToolResult。
- JS Promise 不可强制取消,故"立刻中断"靠:① signal 通知工具停(Bash kill 子进程;Read/Glob/Grep 检查 signal 抛出);② 主 loop 不等剩余 Promise。

> best-effort 承认:Edit/Write 等快工具若已执行落盘,abort 不能回滚(同 CC)。Bash 子进程靠 kill 中断(对齐 CC)。

### 5.4 流式事件顺序(执行并发、yield 串行)

真实代码:`status` 事件在**执行前** yield(表示"开始执行"),`tool_result` 在**执行后** yield。并发改造后时序:
1. **并发执行前**:按 tool_call 原顺序批量 yield 各工具 `status` 事件(或随其进入并发时发)
2. **并发执行**:只读工具 Promise 并发、写工具串行
3. **执行后**:按 tool_call 原顺序串行 `addToolResult` + yield `tool_result`
4. `token` 事件来自 LLM 流式、在工具执行之前,不受影响

简言之:**status 先发、执行并发、tool_result 按序串行补发**。避免前端事件乱序。

### 5.5 工具 execute 签名加 signal

现有 `execute(args)` → 改为 `execute(args, signal)`。各工具按中断需求实现:
- **Bash**:signal abort 时 `child.kill(SIGTERM)`,3s 后 `SIGKILL`(复用现有 timeout kill 模式,§四差异6)
- **Read/Glob/Grep**:可在中途检查 `signal.aborted` 抛出(只读工具一般快,best-effort)
- **Edit/Write**:很快,best-effort(不强制检查)

ToolRegistry.execute 透传 signal:`execute(name, args, signal)`。

### 5.6 不抽 runLoop(归 subAgent 工程)

本工程**不抽 runLoop 内核**。runLoop 抽离 + compaction 钩子注入重构(`onIterationStart`/`onLoopEnd`)是 subAgent 工程的前置(那时主子 agent 共用 loop 才需要),归 subAgent 工程做。本工程并发逻辑直接在基类 `reasoning` 的 tool 执行段实现,范围最小、回归风险低。

> 见 subAgent 文档 §3.4/§2.0(runLoop 抽离作为 subAgent 前置)。

---

## 六、落地步骤

1. **加 `isConcurrencySafe`**:6 个工具加字段(Read/Glob/Grep=true,Bash/Edit/Write=false)。
2. **execute 加 signal 参数**:ToolRegistry.execute(name,args,signal) 透传;Bash 实现 abort→kill(对齐 CC,§5.5/§四差异6);Read/Glob/Grep best-effort 检查;Edit/Write best-effort。
3. **改 reasoning tool 执行段为并发**:**直接改** `default_agent.js` reasoning 的 tool 执行段(不抽 runLoop,§5.6):CC processQueue 语义(只读并发、写串行、上限 10,§5.2);abort 立刻中断(§5.3);「执行并发、yield 串行」(§5.4)。验证串行场景零回归。
4. **测试**:全是写工具/单 tool_call 串行退化;多只读工具并发;混合(只读并发 + 写串行);事件顺序不乱;abort 中断并发工具(Bash 子进程被 kill)。

---

## 七、不做(本期范围外)

- Agent 工具及其并发(交 subAgent 工程,本工程完成时 Agent 工具尚不存在)。
- Bash 只读命令判定细化(Bash 一律 false 串行)。
- subAgent 本身(依赖本工程完成,见 `docs/subagent-design.md`)。
- 改变串行场景行为(必须零回归)。
