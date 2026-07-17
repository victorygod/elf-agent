# CC TodoWrite 工具实现（2.1.209）

> 逆向本机 `claude.exe` v2.1.209（Mach-O 64-bit arm64，bun 编译产物，明文字符串）还原 `TodoWrite` 工具的注册、schema、执行逻辑与配套提醒机制。
> 证据来源：`node fs.readFileSync("bin/claude.exe").indexOf(needle)` 切片上下文；关键函数体原文已在各节内引用。
> 日期：2026-07-17

---

## 0. 符号速查

| 符号 | 含义 | 证据 |
|---|---|---|
| `XU` | `"TodoWrite"` 工具名常量 | `var XU="TodoWrite"` |
| `bot()` | 单条 todo 的 zod schema `{ content, status, activeForm }` | `inputSchema` 内 `todos: bot()` |
| `K2y()` | inputSchema `{ todos: Todo[] }` | `K2y=be(()=>v.strictObject({todos:bot()...}))` |
| `Y2y()` | outputSchema `{ oldTodos, newTodos }` | `Y2y=be(()=>v.object({oldTodos:bot()...,newTodos:bot()...}))` |
| `GOd` | 短描述（`description()` 返回） | `async description(){return GOd}` |
| `WOd(model)` | 长系统提示（`prompt()` 返回） | `async prompt({model:e}){return WOd(e)}` |
| `zOd` | 工具实例（`Li({...})` 产物） | `zOd=Li({name:XU,...})` |
| `Gnn` | 提醒阈值常量集 | `Gnn={TURNS_SINCE_WRITE:10,TURNS_BETWEEN_REMINDERS:10}` |
| `SIo` | "Brief" 工具名常量（提醒抑制门） | `SIo=(...).BRIEF_TOOL_NAME` |
| `Py_` | 统计「距上次 TodoWrite / 上次提醒的轮数」 | 函数体见 §5 |
| `Oy_` | 生成 `todo_reminder` 附件 | 函数体见 §5 |

---

## 一、工具注册（`zOd = Li({...})`）

```js
var XU = "TodoWrite";

zOd = Li({
  name: XU,
  searchHint: "manage the session task checklist",
  maxResultSizeChars: 1e5,
  strict: true,

  async description() { return GOd },
  async prompt({ model: e }) { return WOd(e) },
  get inputSchema() { return K2y() },
  get outputSchema() { return Y2y() },
  userFacingName() { return "" },
  shouldDefer: true,

  isEnabled() { return !NH() && !CX() },
  toAutoClassifierInput(e) { return `${e.todos.length} items` },

  async checkPermissions(e) { return { behavior: "allow", updatedInput: e } },
  renderToolUseMessage() { return null },

  async call({ todos: e }, t) { /* 见 §4 */ },
  mapToolResultToToolResultBlockParam(e, t) { /* 见 §4 */ }
});
```

字段含义：

- **`shouldDefer: true`**：工具 schema 按需加载（deferred tools 机制，配合 `ToolSearch`/`select:<name>`）。不会默认随 system prompt 全量下发，命中 searchHint 或显式 select 时才注入 schema。
- **`strict: true`**：inputSchema 用 `v.strictObject`，多余字段会校验失败。
- **`checkPermissions` 恒 `allow`**：TodoWrite 不走权限弹窗。
- **`renderToolUseMessage() => null`**：tool_use 调用块在对话流里不渲染成明文，由前端单独渲染成 todo 面板。
- **`isEnabled() = !NH() && !CX()`**：在 remote/cowork（`NH()`）与 vellum_ash 模式（`CX()`）下禁用，改由 Task* 系接管。
- **`searchHint: "manage the session task checklist"`**：ToolSearch 关键词。
- **超时**：与 `Read/Write/Edit/TaskCreate/...` 同属 `KNy` 集合，统一默认 `1e4`（10s）超时。

---

## 二、短描述 `GOd`

```
Create and update a task list for the current session. The list is rendered to the user as your working plan.

- Each todo has `content`, `status` ("pending" | "in_progress" | "completed"), and `activeForm` (present-tense label shown while in progress).
- Send the full list each call; it replaces the previous one.
- Keep one item `in_progress` at a time and mark it `completed` when done.
```

另一段（版本中存在第二段近似描述，疑为不同入口的复用）：

```
Update the todo list for the current session. To be used proactively and often
to track progress and pending tasks. Make sure that at least one task is
in_progress at all times. Always provide both content (imperative) and
activeForm (present continuous) for each task.
```

---

## 三、inputSchema / outputSchema

```js
K2y = be(() => v.strictObject({
  todos: bot().describe("The updated todo list")
}))
// bot() 内含每项：
//   { content: string, status: "pending"|"in_progress"|"completed", activeForm: string }

Y2y = be(() => v.object({
  oldTodos: bot().describe("The todo list before the update"),
  newTodos: bot().describe("The todo list after the update")
}))
```

要点：
- inputSchema 是 **`strictObject`**：多余字段 / 缺字段都会校验失败（zod `safeParse` → 失败时回 `UIt(name, error)`，不执行 `call`）。
- outputSchema 不是 strict（`v.object`，仅描述结构，供 UI diff/telemetry）。

---

## 四、核心执行 `call` 与 `mapToolResultToToolResultBlockParam`

```js
async call({ todos: e }, t) {
  let r = t.getAppState(),
      n = t.agentId ?? kt(),          // 当前 agent ID（无则取 sessionId）
      o = r.todos[n] ?? [],           // 旧列表（供 outputSchema.oldTodos）
      s = e.every((a) => a.status === "completed") ? [] : e;  // 全 completed → 折叠成 []
  return t.setAppState((a) => ({
    ...a,
    todos: { ...a.todos, [n]: s }     // 按 agentId 分桶整体替换
  })), { data: { oldTodos: o, newTodos: e } };
}
```

```js
mapToolResultToToolResultBlockParam(e, t) {
  return {
    tool_use_id: t,
    type: "tool_result",
    content: "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable"
  }
}
```

实现要点：

1. **全量替换，非增量**：每次调用发送完整列表，整列覆盖上一份（`Send the full list each call; it replaces the previous one.`）。没有「append/update by id」语义。
2. **按 agent 分桶**：`appState.todos` 形如 `{ [agentId]: TodoItem[] }`。主 agent 与各 subagent 各维护独立清单，互不覆盖。`agentId` 缺省回退到 `kt()`（sessionId 派生）。
3. **全 completed 折叠**：若新列表所有项都是 `completed`，实际写入的 `s = []`（UI 清空）；但 `outputSchema.newTodos` 仍返回原 `e`（保留历史，供 UI/telemetry）。
4. **纯内存，不落盘**：仅写 `appState`，随 session 生灭，无持久化。
5. **回写模型的 tool_result 是固定文案**：不含新旧列表明细。模型侧的 todo 状态由它自己发的 `tool_use` input 维护，不依赖 tool_result 反馈。
6. **无副作用**：不读写文件、不触发网络。唯一外溢是 telemetry（`toAutoClassifierInput → "${len} items"`）。

`agentId` 解析（`kt()`）：

```js
function kt() {
  return HO()?.sessionId ?? Pt.sessionId
}
```

---

## 五、配套提醒：`todo_reminder` 附件

TodoWrite 本身不主动催更，催更由独立的「提醒生成器」按轮数阈值注入背景附件完成。

### 5.1 统计轮数 `Py_`

```js
function Py_(e) {
  let t = -1, r = -1, n = 0, o = 0;
  for (let i = e.length - 1; i >= 0; i--) {
    let s = e[i];
    if (s?.type === "assistant") {
      if (wIo(s)) continue;                       // 跳过非真实 assistant 轮
      // 最近一次「包含 TodoWrite tool_use 的 assistant 消息」
      if (t === -1 && Array.isArray(s.message?.content) &&
          s.message.content.some(a => a.type === "tool_use" && a.name === "TodoWrite")) t = i;
      if (t === -1) n++;                          // 累计距上次 TodoWrite 的轮数
    } else if (r === -1 && s?.type === "attachment" && s.attachment.type === "todo_reminder") {
      r = i;                                      // 最近一次 todo_reminder 附件
    }
    if (t !== -1 && r !== -1) break;
  }
  return { turnsSinceLastTodoWrite: n, turnsSinceLastReminder: o };
}
```

异常兜底：消息数组为空时有 `Cannot destructure property 'turnsSinceLastTodoWrite' from null or undefined value` 错误串。

### 5.2 生成提醒 `Oy_`

```js
async function Oy_(e, t) {
  if (!t.options.tools.some(o => pl(o, XU))) return [];       // 未注册 TodoWrite → 不催
  if (SIo && t.options.tools.some(o => pl(o, S Io))) return []; // 存在 "Brief" 替代工具 → 不催
  if (!e || e.length === 0) return [];
  if (bVs() === "off") return [];                              // 用户关了提醒
  let { turnsSinceLastTodoWrite: r, turnsSinceLastReminder: n } = Py_(e);
  if (r >= Gnn.TURNS_SINCE_WRITE && n >= Gnn.TURNS_BETWEEN_REMINDERS) {
    let o = t.agentId ?? kt(),
        s = t.getAppState().todos[o] ?? [];
    return [{ type: "todo_reminder", content: s, itemCount: s.length }];
  }
  return [];
}
```

阈值常量：

```js
Gnn = { TURNS_SINCE_WRITE: 10, TURNS_BETWEEN_REMINDERS: 10 }
```

即：**距上次 TodoWrite 调用 ≥ 10 轮** 且 **距上次 todo_reminder 注入 ≥ 10 轮**，才再注入一次提醒。

### 5.3 提醒渲染

`todo_reminder` 附件以 `isMeta: true` 的背景消息注入（非用户可见消息，低权重）：

```js
case "todo_reminder": {
  if (CX()) return [];
  let r = e.content.map((o, i) => `${i+1}. [${o.status}] ${o.content}`).join("\n");
  let n = "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from using the TodoWrite tool to track progress. If it has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n";
  if (r.length > 0) n += "\nHere are the existing contents of your todo list:\n[" + r + "]";
  return Of([Br({ content: n, isMeta: true })]);
}
```

特性：
- `isMeta: true`：作为背景 attachment 注入，模型「可忽略」语义（与 system-reminder 同级别低权重）。
- 携带当前 todo 明细（`status` + `content`），让模型在丢失上下文后能接续。
- `CX()` 为真时（vellum_ash）不注入。

---

## 六、长系统提示 `WOd(model)`

`WOd` 生成完整工具说明，核心约束（摘自二进制原文）：

1. **三态状态机**：`pending → in_progress → completed`
   - pending：未开始
   - in_progress：进行中（**同时只能有一个**）
   - completed：已完成
2. **双命名**：每项必须同时给
   - `content`：祈使句（"Run tests"）
   - `activeForm`：进行时（"Running tests"），in_progress 期间 spinner 显示
3. **实时更新**：完成即标 completed，不批处理；遇到阻塞保持 `in_progress` 并新建「描述待解问题」的任务。
4. **完成判定**：只有**完全**做完才能标 completed。测试失败 / 实现不完整 / 未解决错误 / 找不到依赖时严禁 completed。
5. **任务拆分**：复杂任务拆成可管理的子步骤，命名清晰、可操作。
6. 另带 4 个 few-shot `<example>`，演示**何时不用** todo list（单步任务、纯问答、单条命令、单文件加注释）。

约束回放（原文片段）：

```
## Task States and Management
1. Task States: pending / in_progress (limit ONE) / completed
2. Task Management: Update in real-time; mark complete IMMEDIATELY; Exactly ONE in_progress;
   Complete current before starting new; Remove no-longer-relevant from the list entirely.
3. Task Completion Requirements: ONLY mark completed when FULLY accomplished;
   if blocked keep in_progress + create new task; Never completed if tests failing / partial / unresolved errors / missing deps.
4. Task Breakdown: specific actionable items; two forms content + activeForm.
```

---

## 七、与 Task* 系的关系

CC 内部存在**两套并行**任务管理系统：

| 维度 | `TodoWrite` | `TaskCreate` / `TaskUpdate` / `TaskList`（`C$` / `ij` / `HPe`） |
|---|---|---|
| 存储 | 内存 `appState.todos[agentId]` | 持久化任务存储（`RJ($V())`） |
| 标识 | 无 ID，全量替换 | 有 ID/uuid，按 id 增量更新 |
| 依赖 | 无 | `blocks` / `blockedBy` 依赖图 |
| 归属 | 隐式按 agent 分桶 | 显式 `owner` 字段 |
| 提醒 | `todo_reminder`（`Oy_`） | `task_reminder`（`My_`） |
| 启用条件 | `!NH() && !CX()` | `NH()`（remote/cowork）优先 |

两者提醒逻辑近乎对称（`Oy_` vs `My_`、`Py_` vs `Ly_`），唯一差别：

- **todo** 取 `t.getAppState().todos[agentId] ?? []`
- **task** 取 `await RJ($V())`（任务存储全集）

关键：`Oy_`（todo reminder）第一道门是「工具列表里有 TodoWrite (= XU) 才催」；`My_`（task reminder）门是「有 TaskUpdate (= ij) 才催」。两者**互斥抑制**——`Oy_` 里 `if (SIo && tools.some(pl(o, SIo))) return [];` 表明存在 "Brief" 替代工具时会抑制 todo reminder（功能开关门）。实际运行中 TodoWrite 启用时走 todo reminder，Task* 启用时走 task reminder。

Task* 的 `TaskUpdate` 提示中明确要求（原文）：

```
- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if: Tests are failing / Implementation is partial /
  You encountered unresolved errors / You couldn't find necessary files or dependencies
```

与 TodoWrite 的约束一致（同源设计哲学）。

---

## 八、elf 接入参考要点

若 elf 要复刻 TodoWrite：

1. **工具定义**：`shouldDefer:true`（schema 按需注入）、`strict:true`、`checkPermissions` 恒 allow、`renderToolUseMessage` 返回 null（前端单独渲染面板）、固定 tool_result 文案。
2. **存储模型**：`{ [agentId]: TodoItem[] }` 按 agent 分桶，纯内存，全量替换语义；**全 completed 折叠为空数组** 这条要保留（影响 UI 清空时序）。
3. **schema**：`strictObject({ todos })`；每项 `{ content, status, activeForm }`。
4. **提醒**：独立于工具调用，按 `turnsSinceLastTodoWrite >= 10 && turnsSinceLastReminder >= 10` 注入 `isMeta:true` 背景 attachment，**携带当前明细**。注意 elf 若无服务端轮数概念，需自行定义「一轮」口径（每 user turn / 每 assistant turn）。
5. **互斥**：与 Task* 系提醒二选一，通过「工具是否注册」路由，避免双催。
6. **agent 分桶**：subagent 场景务必 `agentId ?? mainAgentId`，否则多 agent 会互相覆盖清单。

---

## 九、证据索引（offset → 内容）

| offset | 内容 |
|---|---|
| 223581056 | `zOd=Li({name:XU,...call({...})})` 完整工具定义 |
| 225636612 | `Py_` 统计轮数 + `Oy_` 生成提醒 |
| 225642882 | `Gnn={TURNS_SINCE_WRITE:10,TURNS_BETWEEN_REMINDERS:10}` |
| 225942921 | `case "todo_reminder"` 提醒渲染 + 固定文案 |
| 67107440 附近 | 工具名枚举串 `... TodoWrite ... TaskCreate ...` |
| 199147184 / 205287184 | 静态工具白名单（含 TodoWrite，用于 schema 预加载/超时分类） |
| 216680269 | `var XU="TodoWrite"` |
| 67321155 | `GOd` 短描述原文 |
| 223631762 附近 | `WOd` 长提示「Task States and Management」段 |
| 119532692 | 提醒文案 `The TodoWrite tool hasn't been used recently...` |
| 223512062 | `KNy=new Set([...,"TodoWrite",...])` 超时集合 |

> 核实方法（同 [[cc-cli-bundle-path]]）：`node -e 'const b=require("fs").readFileSync(".../claude.exe"); console.log(b.indexOf(Buffer.from("needle")))'` 取 offset，再 `b.slice(start, off+n).toString("utf8").replace(/\x00/g," ")` 看上下文。注意字符串间被大量 NUL/宽度字节隔开，关注可读片段。
