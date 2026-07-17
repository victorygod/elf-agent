# Rewind（双击 Esc 回退）设计文档

> 参考 Claude Code（cli.js v2.1.77 + 官方文档 code.claude.com/docs）的 rewind / checkpoint 机制，落地到 elf 全量 Agent。
> 设计原则：对标 CC 的 rewind 行为（每条用户消息前打 checkpoint，回退到该点、prompt 回填输入框），实现采用适配 elf 双数据源（gateway jsonl + agent context.json）的「整文件替换」方案。
> 本期范围：给所有 Agent（共用 `shared/agent/` 基类的 elf-001 / elf-002 / 未来 Agent）统一加上"回退到上一个状态"的能力，触发方式对标 CC 的双击 Esc。

---

## 一、CC rewind 机制（已从官方文档 + 源码核实）

### 1.1 触发：单次 Esc vs 双击 Esc

CC 的 Esc 行为**由「输入框是否有未发送文本」分流**，而非纯靠时序窗口：

| 快捷键 | 行为 | 备注 |
|---|---|---|
| `Esc`（单次） | **中断当前回复**。停掉当前响应或工具调用，"已生成的内容保留"。对应 `chat:cancel` action（`Chat` keybinding context）。 | elf 已有 `/abort`，等价于这个 |
| `Esc + Esc`（双击） | ① 输入框有文本 → 清空草稿并存入输入历史（`Up` 可召回）；② **输入框为空 → 打开 rewind 菜单** | rewind 菜单也可用 `/rewind` 打开（`/undo` 是别名） |

关于"时序窗口"：官方交互文档只写 `Esc + Esc`（双击），**未公开毫秒级阈值**。CC 别的双击快捷键有显式窗口（`Ctrl+L`/`Cmd+K` 2 秒内双击跑 `/clear`；`Ctrl+X Ctrl+K` 3 秒内双击确认停止 subagent）。rewind 未写明窗口 → **本文档不臆造具体毫秒数**，落地时给一个可配置常量（默认见 §4.5）。

> ⚠️ 未从文档核实项（落地需以源码为准）：
> 1. 双击 Esc 的具体毫秒窗口；
> 2. rewind 是否能在流式输出中途触发（文档把 rewind 描述为"空输入框"动作，推测需先单次 Esc 中断）；
> 3. 双击检测是否为可重绑定的 keybinding action，还是硬编码在输入处理里。

### 1.2 rewind 做了什么：checkpoint + 截断，不是 pop N 轮

**核心：每次用户 prompt 都建一个 checkpoint，rewind = 把对话截断回某个 checkpoint。** 不是"回退 N 轮"。

- **粒度是「每个用户 prompt」**：rewind 菜单列出本会话每个 prompt，选中一个 = 回到那一刻。
- **截断语义**：官方 prompt-caching 文档原文 "`/rewind` truncates your conversation back to an earlier turn"。
- 回退后，**被回退的那条用户 prompt 会被还原进输入框**作为草稿，方便改写重发。

### 1.3 三轴解耦：对话 / 代码 可独立回退（关键设计点）

CC 在每个 checkpoint 提供 **5 个动作**，体现"对话状态"和"文件系统状态"是两条独立轴：

1. **Restore code and conversation** — 文件 + 对话都回退到该点
2. **Restore conversation** — 只回退对话，保留当前文件
3. **Restore code** — 只回退文件（撤销 Claude 的文件编辑），保留对话
4. **Summarize from here** — 从该消息往后压缩成 AI 摘要，早的消息原样保留
5. **Summarize up to here** — 该消息之前压缩成摘要，晚的消息原样保留

> 设计精髓：**对话轴和文件轴可独立回退**。"只回退对话但保留代码改动"是真实场景——用户想换个思路重新提问，但不丢已经写好的代码。

### 1.4 文件快照的边界（必须知道的硬限制）

- 文件快照是**在 Claude 用文件编辑工具(Edit/Write 家族)改文件之前**抓的,回退时重放快照恢复。
- **快照与 git 无关**:"Checkpoints are local to your session, separate from git",是"本地 undo",git 是"永久历史"。
- **Bash 改的文件：文档原文 "Checkpointing does not track files modified by bash commands"。** 注意这句话的精确含义见 §1.5 源码核实——它不是"Bash 改的文件 rewind 一律不动"，而是分两类：**Bash 独立改的非追踪文件**（rewind 不碰）vs **Bash 改了被 Edit 追踪过的文件**（rewind 会无提示覆盖回快照，Bash 改动静默丢失）。别被文档措辞误导。
- **远程副作用不可回退**:数据库、API、部署等远端操作无法 checkpoint。

### 1.5 CC 文件快照机制（源码核实）

> 以下从 CC `cli.js` v2.1.77 实读核实,用于精确理解 §1.4 的 Bash 边界。关键函数符号(经 minify,名字不可读但逻辑清晰):`ex8`(建备份)、`n66`(写前钩子登记 tracked)、`Au8`(当前文件 vs 快照内容比对)、`DZY`(restore 写回)、`cz()`(总开关 `fileCheckpointingEnabled`,可被 `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` 关闭)。

**核心认知:文件 rewind 基于"文件内容快照覆盖",不是"撤销工具调用记录"。** 两者区别决定了 Bash 污染的处理:

- **checkpoint 存的是内容快照**:`{ trackedFileBackups: { 文件路径 -> 文件某版本内容快照(读出来写进 file-history 目录) } }`。不关心改它的是 Edit 还是 Bash——**只看"这一刻磁盘上文件长什么样",抄一份**。
- **追踪名单 `trackedFiles` 只由 Edit/Write 写前钩子(`n66`)登记**。Bash 工具不调这个钩子 → Bash 的改动不进名单。
- **restore = 强制覆盖**(`DZY`):对每个 tracked 文件把快照内容写回磁盘。比较器 `Au8` 仅用于"要不要新建快照"省备份,**不用于阻止覆盖**——rewind 说写回就写回,不检测也不警告外部改动。

由此,Edit 追踪过、又被 Bash 改过的文件,rewind 时**被强制覆盖回 Edit 前快照,Bash 改动丢失且无提示**——这是 CC 文档没明说、源码里真实存在的坑。详见 §4.8 的行为表与 elf 的改进建议。

### 1.6 持久化与跨重启

- 会话持续写入 `~/.claude/projects/` 下的 **plaintext JSONL**，每条 message/tool_use/result 都写 → 这是 rewind/resume/fork 的基础。
- checkpoint **跨会话持久**，`--resume`/`--continue` 重开后还能用。
- checkpoint 自动 30 天清理（可配）。
- v2.1.191 起，rewind 菜单甚至能回到 `/clear` 之前的会话。
- `/rewind` 也可走 fork 路径（`/branch` / `--fork-session` 同源）——保留原会话另存为新 session。

### 1.7 与 compact 的关系

- rewind 截断到的"前缀"恰好是**之前已缓存的前缀**，下次请求命中暖缓存（cache-friendly）。
- compact 是**用摘要替换历史**，建新缓存前缀。
- 官方把 rewind 当 compact 的替代：走错路想放弃 → `/rewind` 回退，而非 compact。

---

## 二、elf 现状（要改动的点）

### 2.1 当前架构（与 CC 的关键差异）

| 维度 | CC | elf |
|---|---|---|
| 形态 | 单进程 TUI | **HTTP/SSE 服务**：前端 → gateway → agent 子进程 |
| 消息存储 | `~/.claude/projects/*.jsonl` 持续追加 | `data/context.json`，每次 `_save()` 全量覆写（`message_manager.js:186`） |
| 中断 | 单次 Esc → `chat:cancel` | `POST /abort` → `agent.abort()`（已有） |
| 清空 | `/clear` | `POST /clear` → `messageManager.clear()`（已有，全清） |
| 工具副作用 | 文件编辑工具改真实文件系统 | **elf 工具多读真实文件系统**（`shared/agent/tools/Bash.js`、`Edit.js`、`Write.js` 见 §2.3） |
| 请求并发 | —— | server.js 有 `enqueueRequest` 串行队列 + 消息合并（`server.js:34`） |

### 2.2 message_manager 现状（`shared/agent/message_manager.js`）

- `messages: []` 单一数组，4 种 add 方法：`addUserMessage` / `addAssistantMessage` / `addAssistantToolCalls` / `addToolResult`。
- 每次 add 都 `_save()`（全量写 `context.json`）。
- **没有任何 checkpoint / 历史快照概念** —— 这是本设计要加的核心。
- `compactIfNeeded` 会把 `messages` 整个替换成**单条摘要 user 消息**（`SUMMARY_PREAMBLE` + LLM 回复，`isCompactSummary:true`，见 `message_manager.js:117`）—— compact 与 rewind 的互斥见 A.6。

### 2.3 工具副作用现状（决定文件轴能不能做）

elf 的工具实现对文件轴的可行性有直接影响，落地前需逐个核实：

- `Edit.js` / `Write.js` —— 若直接写真实文件系统，则**有文件副作用**，文件轴回退需要快照能力。
- `Bash.js` —— 即使经工具执行，CC 的边界经验告诉我们 **Bash 改文件不可靠回退**，elf 同理应声明不追踪。
- `Read.js` / `Glob.js` / `Grep.js` —— 纯读，无副作用，无需快照。

> **本期建议**：MVP 先做**对话轴**回退（§4），文件轴作为 P1。原因：
> 1. 对话轴是 CC rewind 的主路径，价值最高、实现可控；
> 2. 文件轴需要给 Edit/Write 加 before-snapshot，工作量与风险都大，且 elf 工具是否都操作真实 FS 需先核实；
> 3. Bash 改文件本就不可回退，文件轴覆盖率有上限，先不强上。

---

## 三、目标

1. **所有共用 `shared/agent/` 基类的 Agent** 都具备 rewind 能力，无需逐个改 Agent 类。
2. 前端双击 Esc（输入框为空时）触发 rewind 菜单，对标 CC 交互。
3. 支持 **Restore conversation**（对话轴回退）—— MVP。
4. 文件轴（Restore code）作为 P1，预留接口。
5. checkpoint 落盘，刷新/重启后仍可回到历史点。

---

## 四、设计

### 4.5 前端：双击 Esc 检测 + rewind 菜单（UI）

`useChat.js` 已有 `abort()`（`useChat.js:360`），新增 `rewind(checkpointId)` 与 `listCheckpoints()`。rewind UI 全部嵌在现有 `ChatPanel`，不新建页面。

> **前端真实状态对齐（核验当前代码后）**：
> - 处理中状态不叫 `isProcessing`，叫 **`isStreaming = (activeTurn !== null)`**（`ChatPanel.jsx:157`，来自 store）。
> - 输入框是**非受控 textarea**，用 `inputRef.current.value` 读值（无 `inputValue` state）。
> - 回复中 textarea `disabled={isStreaming}`，**不接收 keydown**；ESC 中断现由 **window 级全局监听**承担（`ChatPanel.jsx:420`，仅 `activeTurn && _isActive` 时拦截→abort）。
>
> 故本设计的 ESC 三分流**并入这个现有 window 级监听**，不另起 handler（否则两监听抢同一 ESC 事件）。

#### 触发：双击 Esc 三分流（并入现有 window 级 ESC 监听）

```
// ChatPanel.jsx 现有 window keydown 监听（:420）扩展：
onGlobalKeyDown(Esc):
  const chat = useAgentStore.getState().chats.get(agentId);
  // 分流①：回复途中 → 中断（沿用现有分支）
  if (chat?.activeTurn && chat._isActive) { e.preventDefault(); abortRef.current(); return; }
  // 以下为空闲态（非 streaming）新增分支：
  const input = inputRef.current?.value ?? '';
  // 分流②：输入框有字 → 清草稿（对标 CC Esc×2 情况①）
  if (input.trim() !== '') { inputRef.current.value = ''; autoResize(); return; }
  // 分流③：输入框空 → 400ms 内第二击开菜单（canOpenRewind 此时恒真）
  const now = Date.now();
  if (now - lastEscAtRef.current < DOUBLE_ESC_WINDOW) { openRewindMenu(); }
  lastEscAtRef.current = now;
```

> `canOpenRewind = !isStreaming && (inputRef.current?.value.trim() === '')` 是「能否开 rewind 菜单」的**唯一谓词**，用 elf 真实状态定义。双击 Esc 与移动端回退按钮共享（见「移动端入口」）。注意：分流③进入时 `canOpenRewind` 已恒真（`activeTurn` 已 null、输入已空），谓词主要约束按钮显隐，不是分流③的进件条件。

- `DOUBLE_ESC_WINDOW`：可配常量（默认 **400ms**，CC 未公开阈值，取体感顺滑值）。

#### 交互流：总是先开菜单（已定）

双击 Esc **总是先打开 rewind 菜单**，选中一项后再回退——不做"双击直接回退最近一轮"，避免误回退（与 CC 菜单路径一致）。

```
双击 Esc(空输入框 + 非 processing)
  └─ GET /checkpoints → 打开浮层菜单
      └─ 键盘 ↑↓ 选中一项 + Enter
          └─ POST /rewind { checkpointId }
              ├─ 后端整文件替换回退、删该点之后的快照包
              ├─ 返回 { restoredPrompt }
              └─ 前端：关菜单 → restoredPrompt 回填输入框 → re-subscribe 刷 turns
```

> 上述 `/checkpoints`、`/rewind` 是简写；A 方案实际 URL 为经 gateway 的 `GET /agents/:id/checkpoints`、`POST /agents/:id/rewind`（见 A.9）。UI 流程本身不变。

#### 布局：输入框上方浮层（已定）

菜单浮在输入框正上方，**列表反向**——最近的 checkpoint 排在最下、贴近输入框（"回退最近一轮"是高频，焦点默认停在这一项）。上方留出对话区，对话区内容在回退后被 snapshot 刷新。

```
┌─ 对话区(回退后被 re-subscribe 的 snapshot 刷新) ─────┐
│  existing messages...                           │
│                                                 │
├─────────────────────────────────────────────────┤
│ ┌── Rewind to ───────────────────────────────┐ │
│ │  #3  14:02  “加个登录页面”                  │ │  ← 默认焦点(最近)
│ │  #2  14:00  “搭建项目骨架”                  │ │
│ │  #1  13:58  “初始化项目”                    │ │
│ └─── Esc 关闭 · ↑↓ 选择 · Enter 回退 ────────┘ │
├─────────────────────────────────────────────────┤
│ [ 想换个思路重新提问...                  ] 👤    │  ← 输入框(restorPrompt 回填到这里)
└─────────────────────────────────────────────────┘
```

#### 菜单项数据与渲染

- 数据源：`GET /checkpoints` → `[{ id, index, label, createdAt }]`，`label` = prompt 前 40 字。
- 每行：序号 `#index` + 时间 + prompt 摘要（`label`）。
- 单击 / Enter 选中 → 触发回退。

#### 键盘操作

| 键 | 行为 |
|---|---|
| `↑` / `↓` | 在 checkpoint 项间移动焦点 |
| `Enter` | 回退到选中项 |
| `Esc` | 关闭菜单（单次，不触发二次分流——菜单打开时 Esc 只关菜单） |

#### 回退后状态流转

1. 关闭 rewind 菜单。
2. 回退请求返回的 `restoredPrompt` **回填进输入框**（对标 CC"还原进输入框"），用户可改写后重发。
3. `re-GET /agents/:id/subscribe` 取 snapshot 刷新对话区——A 方案已把 jsonl 整份换回快照态，故 `snapshot.turns` 即快照视图，被回退轮次消失（`useChat.js:85` `case 'snapshot'` 原样复用）。
4. checkpoint 列表更新（该点之后的快照包删除）。

#### 边界态

- **菜单空（无 checkpoint）**：刚开始的会话还没打过 checkpoint。双击 Esc 弹出浮层显示"暂无可回退状态"，仅有 Esc 关闭，无列表项。
- **streaming 中双击 Esc**：现有 window 监听拦下第一击直接 `abort`（复用现有中断，`ChatPanel.jsx:420`），不进菜单流程；中断完成（`activeTurn` 归 null、输入框空）后再双击才走分流③开菜单。
- **文件轴 P1 未上线前**：菜单文案明确"仅回退对话"，不承诺回退代码改动（见 §4.8）。

#### 移动端入口（已定）

elf 是响应式 web（`max-width:768px` 断点 + viewport meta，已有手机适配），但无键盘 → 双击 Esc 在手机端不可达。**移动端入口 = 输入框旁加「⟲回退」按钮**，点击打开同一个 `<RewindMenu>` 浮层。两个入口共享菜单组件，桌面另保留双击 Esc 快捷键。

```
┌────────────────────────────────────┐
│  对话区...                          │
├────────────────────────────────────┤
│ [ 想换个思路重新提问... ] [⟲] [➤]    │
│                         回退  发送   │
└────────────────────────────────────┘
点 [⟲] → GET /checkpoints → 开 RewindMenu 浮层（同桌面）
```

落地要点：
- **显隐与双击 Esc 严格一致**（核心约束）：抽取一个谓词 `canOpenRewind = !isStreaming && (inputRef.current?.value.trim() === '')`（用 elf 真实状态，见 §4.5 触发段）。双击 Esc 第三分流进入时它恒真，回退按钮用同一谓词决定显隐——**两入口任何时刻要么都可开菜单、要么都不可**，杜绝"按钮亮着点了没用"或"该能回退时按钮没了"的割裂。
- **按钮只显不灰**（已定）：不可用时不灰显而是**严格隐藏**,只负责开菜单、不兼职中断。三个不可用态一律隐藏：
  - streaming 中（`activeTurn !== null`）→ 隐藏（用户先点现有「■停止」按钮 / 双击 Esc 中断）
  - 输入框有字 → 隐藏
  - 会话初始无 checkpoint → 形态：按钮可见(符合 `canOpenRewind`)，点击开出**空菜单**("暂无可回退状态")，与双击 Esc 空态行为一致（口径：能开菜单 ≠ 有可回退项；空态在菜单内表达，而非藏按钮）。
- 按钮点击 = 调 `openRewindMenu()`，与双击 Esc 共用同一打开路径，菜单行为完全一致。
- 菜单浮层在 `768px` 以下可上移为底部抽屉式更易触达（实现细节，非强约束）。
- 列表项增触屏交互：点击选中 + 显式「回退到此」确认按钮（移动端无 Enter 键，不能靠键盘确认）。

### 4.8 文件轴(P1,预留接口)

> 本节机制已从 CC 源码核实（`cli.js` v2.1.77），见 §1.5「CC 文件快照机制（源码核实）」。
> 关键认知:**文件 rewind 是基于「文件内容快照覆盖」,不是「撤销工具调用记录」**。这个区别决定了 Bash 污染的处理方式。

#### CC 的真实机制(源码级)

CC 每个 checkpoint 存的是 `{ trackedFileBackups: { 文件路径 -> 该文件某版本的内容快照 } }`。它不关心文件是被 Edit/Write 改的还是 Bash 改的——**只看"这一刻磁盘上文件长什么样",抄一份**(备份函数 `ex8`:`readFileSync` → 写进 `file-history` 目录)。

追踪名单 `trackedFiles` 是**绑在 Edit/Write 这类文件编辑工具的"写前钩子"**上的(函数 `n66`)。Bash 工具**不调这个钩子**,所以 Bash 的改动不进追踪名单。restore 时(`DZY` + 比较器 `Au8`),对每个 tracked 文件,**直接把快照内容覆盖写回磁盘,不检测也不警告是否被外部改过**。

由此推出 Bash 污染的真实行为(文档"Checkpointing does not track files modified by bash commands"容易被误解,实际更精确):

| 情况 | rewind 文件轴结果 |
|---|---|
| Edit 改 `foo.js`,Bash 没动 | `foo.js` 精确回退到 Edit 前 ✓ |
| Edit 改 `foo.js`,**Bash 又改了它** | `foo.js` 被**强制覆盖回 Edit 前快照**,**Bash 的改动静默丢失,无提示** ⚠️ |
| Edit 改 `foo.js`,Bash 删了它 | restore 检测到文件缺失,写回快照 → 文件复活成 Edit 前 |
| Bash 写了 Edit 从没碰过的新文件 | 不在 tracked 名单 → rewind **完全不碰**,文件留在磁盘 ⚠️ |
| Bash `rm` 了 Edit 没碰过的文件 | 不追踪 → rewind 不恢复,文件真没了 |

> 设计教训:CC 文件 rewind **只保证被追踪工具改过的文件回退到快照**,对 Bash 的污染**既不追踪也不保护**。CC 官方态度——文件 checkpoint 是"local undo",**Bash 介入后的安全回退是 git 的活,不是 checkpoint 的活**(设置项原文就叫 "Rewind code (checkpoints)",与 git 永久历史区分)。

#### 工作目录:不引入(已定决策)

文件轴边界**只看"工具写过的文件名单"(`trackedFiles`),不引入工作目录 (cwd) 概念**。理由:

- CC 源码实读证实:`trackedFiles` 由 Edit/Write 写前钩子登记,**CC 本身不做 cwd 边界判定**——它不扫项目树,只快照工具碰过的文件。elf 照搬此机制即可。
- elf 当前架构本就**没有 cwd 绑定**(agent 子进程 cwd = 裸 `process.cwd()`,Edit/Write 收绝对路径,Bash 继承 `process.env`)。若按"快照 cwd 子树"思路落地,须新增 cwd 配置、边界判定、symlink 越界、cwd 漂移等一整套工程(详见下方"已否决命题"),与"照搬 CC"原则相悖。
- **代价(已知且接受)**:模型若让 Edit/Write 写一个项目目录外的绝对路径,elf 会照 CC 一样快照、回退时照覆盖。MVP/P1 不拦这类越界写,后续可按需加路径黑名单轻量拦截,但不构成 cwd 体系。

> **已否决命题(记录备查,不在本期范围)**:若改采"快照仅限 cwd 子树"严格方案,会牵出五层问题——① cwd 谁定义(配置绑 / 会话动态 / 沿用裸 cwd);② "内"如何判定(`path.relative` + realpath 防 `..`/symlink 越界);③ symlink 指向 cwd 外的越界覆盖;④ elf 独有的 cwd 漂移(会话中途 Bash `cd`);⑤ 是否拦 cwd 外越界写。本期一概不做,采用上文的"名单"策略绕开。

#### elf 落地(P1)

checkpoint 结构里预留 `fileSnapshotId` 字段(MVP 始终 null)。P1 实现:

1. `Edit.js` / `Write.js` 执行前(写前钩子),把目标文件当前内容存进 `data/file_snapshots/<id>`(对标 CC `ex8`)。
2. checkpoint 记录"该点对应的 `trackedFileBackups`"(文件路径 → 快照本体路径 + version)。
3. `rewind` 增加 `restoreCode: true` 选项 → 对每个 tracked 文件**把快照内容强制写回磁盘**(对标 CC `DZY`,不检测外部改动)。

#### elf 必须比 CC 做得更明确的地方(边界声明)

照搬 CC"覆盖式回退"语义,但 elf 是 HTTP 服务、用户感知更弱,**必须把边界写进 UI 提示**,不能像 CC 那样靠用户自己懂 git:

1. **"Bash 改了被追踪文件后,rewind 会无提示覆盖它"** —— 这是 CC 源码的真实行为、文档没明说的坑。elf 在 P1 实现时,**要么在 restore 前对 tracked 文件做一次"当前内容 vs 快照"比对(沿用 CC 的 `Au8` 思路),若发现被外部改过则弹窗确认后再覆盖**;要么至少在 rewind 菜单文案标明"将覆盖被追踪文件的当前内容"。**推荐前者**——这是 elf 可以比 CC 做得更好的点。
2. **Bash 独立改/删的非追踪文件**:rewind 不碰,UI 不承诺恢复(照搬 CC)。
3. **远程副作用**(DB/API/部署):不可回退,UI 提示(照搬 CC)。
4. P1 上线前,UI 文案统一用"仅回退对话,Bash/远程改动不在范围内"措辞,避免误解（MVP 阶段根本不做文件轴回退,见 §三目标 3/4）。

---

## 八、参考

- CC 官方文档（验证来源）：
  - Checkpointing：https://code.claude.com/docs/en/checkpointing.md
  - Interactive mode（Esc / Esc-Esc 表）：https://code.claude.com/docs/en/interactive-mode.md
  - How Claude Code works：https://code.claude.com/docs/en/how-claude-code-works.md
  - Prompt caching（rewind 截断 + 缓存友好）：https://code.claude.com/docs/en/prompt-caching.md
  - Sessions（resume/fork/`/rewind` 同源）：https://code.claude.com/docs/en/sessions.md
  - Keybindings（`MessageSelector` context、`chat:cancel`）：https://code.claude.com/docs/en/keybindings.md
  - Changelog（`/rewind`、`/undo` 别名、v2.1.191 `/clear` 前会话可回退）：https://code.claude.com/docs/en/changelog.md
- CC 源码核实（§1.5、§4.8 的 Bash 边界来源）：`/Users/wolf/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js` v2.1.77，关键符号 `ex8` / `n66` / `Au8` / `DZY` / `cz()` / `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`。证实文件 rewind = 内容快照强制覆盖，非工具调用撤销；Bash 改了被追踪文件会被无提示覆盖。
- elf 相关代码（实现落点）：
  - `gateway/server.js` —— 主改动：`snapshotBeforeSend` + `POST /agents/:id/rewind` + `GET /agents/:id/checkpoints`
  - `shared/agent/message_manager.js` —— 新增被动 `reloadFromDisk()`
  - `shared/agent/server.js` —— 新增被动 `POST /reload`
  - `gateway/chat_proxy.js` —— `buildSnapshot` 的 turns 源（jsonl）、compact 段写入
  - `frontend/src/hooks/useChat.js:270`（aborted）、`:360`（abort）—— 双击 Esc 参考

---

---

# 实现方案：整文件替换回退

## A.0 改造方案总览

**改造方案**：每次用户发消息前，gateway 把当前 `data/` 下的会话状态文件（`context.json` + `history.jsonl` + `tool-results/`）整份拷贝成一个快照包存到 `data/checkpoints/<id>/`，元信息记该条 prompt；回退时把选中的快照包整份覆盖回 `data/`，删掉其后所有快照包，再让 agent reload 内存、前端 re-subscribe 刷新。

落地要点：
- **责任方在 gateway**，不在 agent。agent 只新增一个被动 `/reload` 端点，没有任何 rewind 逻辑。
- **快照 = 文件副本**，不是内存数组——无需处理就地 mutate 污染、锚点对齐、compact 段不可拆等边界。
- **MVP 只回退对话三件套**（context.json + history.jsonl + tool-results/），工作目录被工具改过的文件不纳入（文件轴 P1，同 §4.8）。
- **触发与 UI 不变**（双击 Esc / 回退按钮 / `canOpenRewind`，见 §4.5）。

## A.1 行为定义（已与 CC 源码核对一致）

回退行为 = Claude Code 的 rewind，源码核对（`cli.js` v2.1.77）：

| 行为 | CC 源码证据 |
|---|---|
| 每条 user message 一个 checkpoint，存的"该 prompt **之前**"的状态 | rewind 确认 UI 文案 "restore the conversation **to the point before** you sent this message"（`:11062199`） |
| 菜单用该条 user message（+ timestamp）作为可选项展示 | UI 列出 `userMessage` 本身（同上） |
| 回退后把这条 prompt 回填输入框 | rewind 回调 `oV6` 中 `iA(Nr(t4))` 即 `setInputValue(还原文本)` |

判定：**elf 的 MVP 回退行为 = CC rewind，完全一致**。

## A.2 状态来源核实：elf 全部持久态 = `data/` 目录文件

核实（无额外隐藏运行态文件）：

| 文件 | 作用 | 回退是否需覆盖 |
|---|---|---|
| `data/context.json` | agent LLM 上下文（= MM.messages） | ✅ 必须 |
| `data/history.jsonl` | 前端展示源（`buildSnapshot.turns` 从它来，`chat_proxy.js:229`） | ✅ 必须 |
| `data/tool-results/*.txt` | elf-002 超长 tool result 落盘（`message_manager.js:48`） | ✅ 必须（否则回退后占位符悬空） |
| `data/checkpoints/<id>/` | 快照包本身（新增，见 A.3） | 管理见 A.5 |
| 工作目录被工具改过的文件 | Edit/Write 产物 | ❌ MVP 不纳入（文件轴 P1，同 §4.8） |

内存运行态核实（`agents/elf-002/message_manager.js`）：
- 阈值类（`budgetWindow`/`perToolLimit`/`previewLength`）从 config 派生 → reload 重算，不需恢复。
- 累计类（`_compactFailCount`/`_compactDisabled`/StreamContext activeUser）是快照**之后**产生的 → 回退本就该丢弃，不是"要恢复"的对象。

结论：**无"快照时刻内存态需精确还原"的字段**——文件换回 + agent reload，内存自然回到与快照一致。前端 turns 不缓存（`messagesToTurns` 每次从 jsonl 投影，`chat_proxy.js:125`），重 subscribe 即对齐。

## A.3 快照包结构（整文件替换的基础）

snapshot 不再只存 MM.messages 内存副本，而是存一份完整状态副本：

```
data/checkpoints/<checkpointId>/
  meta.json          # { id, createdAt, prompt, restoredPrompt }  prompt=该用户消息（菜单标题+回填输入框）
  context.json       # 快照时刻 context.json 整份（说话前）
  history.jsonl      # 快照时刻 history.jsonl 整份（说话前）
  tool-results/      # 快照时刻 data/tool-results/ 整份副本（elf-002；仅复制存在的）
```

- `prompt` 字段 = 触发该 checkpoint 的那条 user message 全文（菜单展示截断、回填用全文）。
- **MVP 不含 `file-snapshots/`**（工作目录文件不回退，见 §4.8 P1）。
- 快照存"说话前"状态，由 gateway 在写 user 进 jsonl **之前**抓取（见 A.4 时机）。

## A.4 checkpoint 存的时机与责任方

**时机**（对齐 CC "before you sent this message"）：用户发消息时，gateway 在 `proxyChat` 写 user 进 `history.jsonl` **之前**，抓一个快照。

**责任方**：gateway。理由：
- 快照要抓 `history.jsonl`（gateway 管的）+ `context.json`/`tool-results/`（agent 写的文件）。文件都在 `data/`，gateway 可直接读，不需 agent 配合。
- 不让 agent 抓：agent 不知道 jsonl，且 agent 未运行时也要能回退。
- 故 checkpoint 创建/回退**全在 gateway**，agent 只被动被 reload，没有任何 rewind 端点。

快照抓取（在 `gateway/server.js` 的 `/agents/:id/chat` handler 里，写 jsonl 前）：
```js
// 伪码：发送消息时打 checkpoint（说话前）
async function snapshotBeforeSend(agentId, prompt) {
  const cpId = `cp_${Date.now()}_${rand4()}`;
  const dir = path.join(agentsDir, agentId, 'data', 'checkpoints', cpId);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(ctxFile, path.join(dir, 'context.json'));          // 整份拷
  fs.copyFileSync(jsonlFile, path.join(dir, 'history.jsonl'));       // 整份拷
  copyDir(toolResultsDir, path.join(dir, 'tool-results'));           // 整份拷（若存在）
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id: cpId, createdAt: new Date().toISOString(), prompt,
    restoredPrompt: prompt,   // 回退时回填输入框
  }));
  return cpId;
  // 注：拷贝 timing 必须在写 user 进 jsonl 前，保证快照是"说话前"
}
```

## A.5 回退动作：整文件替换

回退 = 把快照包里的文件整份覆盖回 `data/`，再让 agent reload、前端 re-subscribe。

```
前端 POST /agents/:id/rewind { checkpointId }
  └─ gateway server.js（新增 /agents/:id/rewind handler）
      ├─ 0. 守卫：streaming 中（activeStreams 有该 id）→ 409，要求先 abort
      ├─ 1. 读 meta.json → 取 restoredPrompt
      ├─ 2. 整份覆盖：
      │     cp/context.json   → data/context.json
      │     cp/history.jsonl  → data/history.jsonl
      │     cp/tool-results/  → data/tool-results/   （先清空目标目录再拷入，保证删掉快照后的产物）
      ├─ 3. checkpoint 列表：删掉该 checkpoint **之后**的所有快照包
      │     （保留该点及之前；该点本身保留还是删，见下"清单管理"）
      ├─ 4. agent 运行中 → POST agent /reload（新增轻端点，热重载 messages 从文件）
      │     ─ ⊙ /reload = messageManager.reloadFromDisk()：从 context.json 重新 _load messages，
      │       并重置进程内运行累计态（回退 = 丢弃该点之后的运行态，等价回到构造态）。
      │       elf-002 须重置断路器 _compactFailCount=0 / _compactDisabled=false
      │       （阈值 perToolLimit/budgetWindow 等来自 config，无需动）。
      │       ─ idle 保证：步骤 0 的 streaming 守卫已保证此刻不在 reasoning，
      │         故 _abortController/_aborted 为 null/false，无残留。
      │     ─ agent 未运行 → 跳过（文件已是快照态，下次启动自然加载）
      └─ 5. 返回 { restoredPrompt } → 前端回填输入框 + re-subscribe 刷 turns
```

**清单管理**：
- checkpoint 元数据用 `data/checkpoints/` 目录的子目录表达，天然有序（按 createdAt 排序）。
- 回退到某点后，**该点的子目录保留**（作为"当前可回退的历史点"），其**之后**的子目录删除。
- 不再有 `checkpoints.json` 单独列表文件——目录即列表，`GET /agents/:id/checkpoints` 遍历子目录读 `meta.json` 返回。

**reload 端点（agent 侧新增，最小）**：agent 收到 `POST /reload` → `messageManager.reloadFromDisk()`（新增方法：从 `context.json` 重新 `_load` 进 `this.messages`，重置本轮运行态）。复用现有 `reloadConfig` 的热加载基础设施。

## A.6 与 compact 的关系（整文件替换下大幅简化）

核实：compact 在 agent 侧把 `messages` 换摘要（`message_manager.js:162`）+ 删 tool-results 文件（elf-002 `:227`）；jsonl 侧 compact 只追加 `compactLoading`+`compactSummary` 不删旧（`chat_proxy.js:430-442`）。

整文件替换方案下：
- 快照存的是"说话前"整份文件。若该说话点在 compact **之前**，快照里的 `context.json` 是压缩前原文、`history.jsonl` 是压缩前记录、`tool-results/` 是压缩前文件——**整份换回后三源天然一致**，无需特殊处理 compact 段。
- 故技术上**能**回退到 compact 前（快照存了完整旧态）；但 MVP **保留"compact 时删 compact 之前的快照包"**：理由是 compact 本就为省上下文，回退到压缩前再长对话会很快又触发 compact，体验差。compact 成功时由 gateway 删除对应快照包，P1 再评估放开跨 compact 回退。

## A.7 竞态（整文件替换下只剩两类）

| 竞态 | 处理 |
|---|---|
| rewind 时正在 streaming（proxyChat 写 jsonl / agent 写 context.json） | gateway 守卫 `activeStreams.get(id)` 存在 → 409 拒绝，要求先 abort。先 abort 再 rewind 是硬约束 |
| 文件覆盖中途崩溃留半截 | MVP 容忍（下次 rewind/clear 修正）；P1 可先写到临时目录再原子 rename |

## A.8 前端接入

- 双击 Esc / 回退按钮 / `canOpenRewind` 谓词（§4.5）**不变**。
- 前端调 gateway 端点：`GET /agents/:id/checkpoints`（列表）、`POST /agents/:id/rewind`（回退），不直连 agent。
- 回退成功后 `re-GET /agents/:id/subscribe`，`snapshot.turns` 因 jsonl 已被整份换回而是快照视图；`useChat.js:85` `case 'snapshot'` 原样复用。
- `restoredPrompt` 回填输入框。

## A.9 改动清单

| 文件 | 改动 | 范围 |
|---|---|---|
| `gateway/server.js` | 发消息前 `snapshotBeforeSend`；新增 `POST /agents/:id/rewind`（整文件替换 + 快照包清理 + 转发 reload/空跑）、`GET /agents/:id/checkpoints`（遍历快包子目录） | 大 |
| `gateway/chat_proxy.js` 或 `chat_history.js` | `snapshotBeforeSend` 在写 user 进 jsonl 前调；可选新增 `copyDir` 工具 | 中 |
| `shared/agent/message_manager.js` | 新增 `reloadFromDisk()`（从 context.json 重新 `_load` messages + 重置进程内运行态） | 小 |
| `agents/elf-002/message_manager.js` | override `reloadFromDisk()`：基类 `_load` 后重置 `_compactFailCount=0`/`_compactDisabled=false`（断路器是进程内累计态，回退应弃；阈值类来自 config 无需动） | 小 |
| `shared/agent/server.js` | 新增 `POST /reload`（调 `reloadFromDisk`） | 小 |
| `shared/agent/default_agent.js` | 不动（回退在 gateway 不在 agent） | 无 |
| `frontend/src/api/index.js` | `rewindAgent`/`listCheckpoints` 指向 gateway | 小 |
| `frontend/src/hooks/useChat.js` | `rewind()` 调 gateway，成功后 re-subscribe | 小 |
| `frontend/src/components/ChatPanel.jsx` | 双击 Esc / 回退按钮不变 | 无 |
| 测试 | integration：rewind 后 turns=快照视图；agent 未运行 rewind；streaming 中 409；compact 后旧快照包被删 | 必需 |

> 因采用文件副本作快照，无需内存 checkpoint 数组、深拷贝不可变约束、`rewindTo`、compact 钩子等；elf-002 tool-result 悬空引用问题随 `tool-results/` 整份换回自动消解。

## A.10 验收

- [ ] 发消息时（说话前）产生一个快照包；菜单列出各 user message（prompt 全文截断显示 + timestamp）。
- [ ] 回退到某点 → `context.json`/`history.jsonl`/`tool-results/` 全部整份换回快照态；re-subscribe 的 `snapshot.turns` = 快照视图。
- [ ] 回退后该条 prompt 回填输入框。
- [ ] 回退后该点**之后**的快照包被删；agent 运行中内存经 `/reload` 与文件一致，未运行时下次启动自然一致。
- [ ] streaming 中调 `/agents/:id/rewind` → 409，要求先 abort。
- [ ] compact 成功后 compact **之前**的快照包被删（A.6 MVP 决策）。
- [ ] 移动端回退按钮与双击 Esc 行为一致（§4.5）。
- [ ] integration 测试覆盖上述。
