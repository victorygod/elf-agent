# Rewind（双击 Esc 回退）设计文档

> 参考 Claude Code（cli.js v2.1.77 + 官方文档 code.claude.com/docs）的 rewind / checkpoint 机制，落地到 elf 全量 Agent。
> 设计原则：**照搬 CC 的核心机制（checkpoint + 截断 + 文件快照三轴解耦）**，再按 elf 的 HTTP/SSE 架构做适配。
> 本期范围：给所有 Agent（共用 `shared/agent/` 基类的 elf-001 / elf-002 / 未来 Agent）统一加上"回退到上一个状态"的能力，触发方式对标 CC 的双击 Esc。

---

## 一、CC rewind 机制（已从官方文档 + 源码核实）

### 1.1 触发：单次 Esc vs 双击 Esc

CC 的 Esc 行为**由「输入框是否有未发送文本」分流**，而非纯靠时序窗口：

| 快捷键 | 行为 | 备注 |
|---|---|---|
| `Esc`（单次） | **中断当前回复**。停掉当前响应或工具调用，"已生成的内容保留"。对应 `chat:cancel` action（`Chat` keybinding context）。 | elf 已有 `/abort`，等价于这个 |
| `Esc + Esc`（双击） | ① 输入框有文本 → 清空草稿并存入输入历史（`Up` 可召回）；② **输入框为空 → 打开 rewind 菜单** | rewind 菜单也可用 `/rewind` 打开（`/undo` 是别名） |

关于"时序窗口"：官方交互文档只写 `Esc + Esc`（双击），**未公开毫秒级阈值**。CC 别的双击快捷键有显式窗口（`Ctrl+L`/`Cmd+K` 2 秒内双击跑 `/clear`；`Ctrl+X Ctrl+K` 3 秒内双击确认停止 subagent）。rewind 未写明窗口 → **本文档不臆造具体毫秒数**，落地时给一个可配置常量（默认见 §4.2）。

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
- `compactIfNeeded` 会把 `messages` 整个替换成**单条摘要 user 消息**（`SUMMARY_PREAMBLE` + LLM 回复，`isCompactSummary:true`，见 `message_manager.js:117`）—— 与 rewind 互斥点见 §4.7。

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

### 4.1 数据结构：checkpoint 列表（加在 MessageManager）

在 `message_manager.js` 增加 checkpoint 机制。**checkpoint = 对话数组的一个不可变快照 + 元信息**。

```js
// MessageManager 新增字段
this.checkpoints = [];   // [{ id, createdAt, label, messagesSnapshot, fileSnapshotId? }]

// 每次 addUserMessage 之前，先 snapshot 当前 messages 作为"该 prompt 之前的状态"
addUserMessage(content) {
  // ★ 新增：在追加 user 消息前打 checkpoint
  this._pushCheckpoint({ label: content.slice(0, 40) });
  this.messages.push({ role: 'user', content });
  this._save();
}
```

**关键约束**：
- checkpoint 存的是"该 user prompt 加入**之前**"的 messages 快照 —— 等价于 CC 的"在 Claude 编辑前抓 checkpoint"。
- checkpoint 不可变：`messagesSnapshot` 做浅拷贝 + 内部 message 对象引用不就地改（elf 的 add 方法都是 push 新对象，符合）。
- checkpoint 单独写 `data/checkpoints.json`，不进 `context.json`（方案见 §4.6）。

### 4.2 rewind API（MessageManager 新增方法）

```js
/**
 * 回退到指定 checkpoint（对话轴）
 * @param {string} checkpointId - 目标 checkpoint；省略 = 回退到上一个（双击 Esc 默认）
 * @returns {{ restoredPrompt: string|null }} 被回退掉的那条 user prompt（还原进输入框）
 */
rewindTo(checkpointId) {
  // 空态：无可回退
  if (this.checkpoints.length === 0) throw new Error('no checkpoint to rewind to');
  const idx = checkpointId
    ? this.checkpoints.findIndex(c => c.id === checkpointId)
    : this.checkpoints.length - 1;         // 默认回退到最近一个
  if (idx < 0) throw new Error('checkpoint not found');

  const target = this.checkpoints[idx];
  // snapshot 存的是"该 prompt 之前"的状态，被丢弃的 prompt 在它之后
  const dropped = this.messages.slice(target.messagesSnapshot.length).find(m => m.role === 'user');
  const restoredPrompt = dropped?.content ?? null;

  this.messages = target.messagesSnapshot.map(m => ({ ...m }));  // 深拷贝防回退后被污染
  // checkpoint 存的是"该 prompt 之前"的状态；截断后该 prompt 已丢弃，
  // 故含自身一并删除（idx 之后全删）。回退后再发 prompt 会重新打检查点。
  this.checkpoints = this.checkpoints.slice(0, idx);
  this._save();
  return { restoredPrompt };
}

/** 列出所有 checkpoint（供前端渲染 rewind 菜单） */
listCheckpoints() {
  return this.checkpoints.map((c, i) => ({ id: c.id, index: i, label: c.label, createdAt: c.createdAt }));
}
```

> "回退到上一个"（双击 Esc 默认动作）= `rewindTo()` 不传 id。对应 CC 菜单里选最近一项 + Restore conversation。

### 4.3 Agent 层：`rewind()` 入口（不重复 processing 守卫）

`default_agent.js` 加一个与 `abort()` 并列的方法。**agent 层不重复判断 processing**——processing 守卫只由 server 层 `isProcessing` 统一把关（§4.4），agent 层的 `rewind()` 被调到时必然已是空闲态。

```js
rewind(checkpointId) {
  // 不在此判 processing：server 层 isProcessing 守卫已保证调用时 loop 已结束。
  // （勿用 this._abortController 判 processing——核验 default_agent.js 可见，
  //   reasoning loop 中 _abortController 几乎全程非 null，且语义是"当前 AbortController"
  //   而非"是否在处理"，用它当 processing 标志会判错。）
  return this.messageManager.rewindTo(checkpointId);
}
```

**为什么禁止 processing 中 rewind**：CC 文档未明确支持流式中 rewind，且 elf 的 reasoning loop 是 async generator，中途改 `messages` 会出现「loop 还在用旧引用写消息」的竞态。规则简单且安全：**回退前必须先 abort**（双击 Esc 时若正在跑，第一击视为 abort，回退按钮届时隐藏——见 §4.4、§4.5）。守卫只放 server 层一处，避免双判断不一致。

### 4.4 Server 层：`POST /rewind` 端点

`server.js` 加端点，与 `/abort`、`/clear` 并列。**唯一 processing 守卫在此**：

```js
// POST /rewind — 回退到上一个状态（或指定 checkpoint）
app.post('/rewind', (req, res) => {
  if (isProcessing) {
    return res.status(409).json({ error: 'Agent 正在处理，请先 /abort' });
  }
  try {
    const { restoredPrompt } = agent.rewind(req.body?.checkpointId);
    logger.info('已回退到上一个 checkpoint');
    res.json({ status: 'ok', restoredPrompt, checkpoints: agent.messageManager.listCheckpoints() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /checkpoints — 列出可回退点（供前端渲染菜单）
app.get('/checkpoints', (req, res) => {
  res.json({ checkpoints: agent.messageManager.listCheckpoints() });
});
```

`isProcessing` 守卫复用现有串行队列状态（`server.js:30`），保证了"回退时无人写消息"。

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
              ├─ 后端截断 messages、删该点之后的 checkpoint
              ├─ 返回 { restoredPrompt, checkpoints }
              └─ 前端：关菜单 → restorPrompt 回填输入框 → 重新拉 snapshot 刷新 turns
```

#### 布局：输入框上方浮层（已定）

菜单浮在输入框正上方，**列表反向**——最近的 checkpoint 排在最下、贴近输入框（"回退最近一轮"是高频，焦点默认停在这一项）。上方留出对话区，对话区内容在回退后被 snapshot 刷新。

```
┌─ 对话区(回退后被 /chat snapshot 刷新) ──────────┐
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
2. `POST /rewind` 返回的 `restoredPrompt` **回填进输入框**（对标 CC"还原进输入框"），用户可改写后重发。
3. 重新拉 `GET /chat` 的 snapshot（`useChat.js:85` 已有 snapshot 机制，`turns` / `activeTurn` 直接替换）刷新对话区——被回退掉的轮次消失。
4. `checkpoints` 列表更新（后端已删该点之后的 checkpoint）。

#### 边界态

- **菜单空（无 checkpoint）**：刚开始的会话还没打过 checkpoint。双击 Esc 弹出浮层显示"暂无可回退状态"，仅有 Esc 关闭，无列表项。
- **streaming 中双击 Esc**：现有 window 监听拦下第一击直接 `abort`（复用现有中断，`ChatPanel.jsx:420`），不进菜单流程；中断完成（`activeTurn` 归 null、输入框空）后再双击才走分流③开菜单。
- **文件轴 P1 未上线前**：菜单文案明确"仅回退对话"，不承诺回退代码改动（见 §4.8、§六）。

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

### 4.6 持久化方案

两个选项：

| 方案 | 说明 | 取舍 |
|---|---|---|
| A. 同文件 | checkpoint 随 `context.json` 一起存：`{ messages, checkpoints }` | 改 `_save/_load` 结构；现有 `context.json` 是纯数组（`message_manager.js:198`，`_load` 里 `Array.isArray(data)` 判断），需升级为对象，**破坏向后兼容**，要做迁移 |
| B. 独立文件 | `data/checkpoints.json` 单独存 | 不动 `context.json`，向后兼容好；checkpoint 失效不影响主对话 |

**推荐 B**：独立 `checkpoints.json`，与 `context.json` 解耦。代价：每次 `_save()` 要写两个文件，可接受。

> **IO 优化**：checkpoint 只在打点/回退时变化，不必随每条消息写。落地时新增 `_saveCheckpoints()`，仅在 `_pushCheckpoint` / `rewindTo` / `clear` / compact 清理时调用，`_save()` 仍只写 `context.json`。避免"每条消息双写"。

### 4.7 与 compact 的互斥

`compactIfNeeded` 会把 `messages` 替换成单条摘要（`message_manager.js:117`）。回退到 compact **之前**的 checkpoint 在技术上可行（checkpoint 存的是原始快照），但语义上 CC 未明确支持"跨 compact 回退"。**MVP 规则**：
- compact 发生时，**清空 compact 之前的所有 checkpoint**（只保留 compact 后新建的）。
- 理由：compact 后旧 messages 已不在 `this.messages` 里，回退到更早 checkpoint 会让"当前 messages"与"摘要后的状态"语义错乱；与其半支持，不如明确不可回退过 compact 点。
- P1 再考虑保留全量快照做"跨 compact 回退"。

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

## 五、改动清单

| 文件 | 改动 | 范围 |
|---|---|---|
| `shared/agent/message_manager.js` | 新增 `checkpoints` 字段、`_pushCheckpoint`、`rewindTo`、`listCheckpoints`、`_saveCheckpoints`（独立写 `checkpoints.json`，见 §4.6）；`addUserMessage` 打 checkpoint；`compactIfNeeded` 后清旧 checkpoint | 核心 |
| `shared/agent/default_agent.js` | 新增 `rewind(checkpointId)` 方法 + processing 守卫 | 小 |
| `shared/agent/server.js` | 新增 `POST /rewind`、`GET /checkpoints` 端点 | 小 |
| `gateway/chat_proxy.js` / `gateway/server.js` | 透传 `/rewind`、`/checkpoints` 到 agent 子进程（若前端经 gateway 调用） | 中，需核实路由 |
| `frontend/src/hooks/useChat.js` | 新增 `rewind(checkpointId)`、`listCheckpoints()`；双击 Esc 检测 | 中 |
| `frontend/src/components/RewindMenu.jsx`（新增） | 输入框上方浮层菜单：列表（反向、默认焦点最近项）+ 键盘（↑↓/Enter/Esc）+ 触屏（点击选中 +「回退到此」按钮），见 §4.5 | 中 |
| `frontend/src/components/ChatPanel.jsx` | 输入框工具条加「⟲回退」按钮（移动端入口，点击开 `RewindMenu`，与双击 Esc 共用 `openRewindMenu`） | 中 |
| `frontend/src/api/index.js` | `rewindAgent(id, checkpointId)`、`listCheckpoints(id)` | 小 |
| `frontend/src/api/index.js` | `rewindAgent(id, checkpointId)`、`listCheckpoints(id)` | 小 |
| 测试 | `test/agent.test.js` 加 checkpoint/rewind 用例；`test/integration.test.js` 加"回退后重发 prompt"端到端 | 必需 |

**不动**：elf-001 / elf-002 的 `agent.js`（继承基类自动获得；elf-002 override 的 reasoning 不影响 rewind，因为 rewind 不在 reasoning 内）。

---

## 六、风险与边界

1. **跨 compact 回退不支持**（§4.7）—— MVP 明确限制，UI 要提示用户。
2. **文件轴 P1 才做** —— MVP 只回退对话；用户若依赖"回退代码改动"需等 P1。UI 文案要说清"仅回退对话"。
3. **Bash 污染文件轴的真实行为(源码核实,见 §4.8)** —— 不是简单的"Bash 改的文件 rewind 不动"。CC 实际行为分两类:**Bash 独立改的非追踪文件**(rewind 不碰,留在磁盘)vs **Bash 改了被 Edit 追踪过的文件**(rewind 会**无提示强制覆盖回快照**,Bash 改动静默丢失)。后者是 CC 源码里真实存在、文档未明说的坑。elf P1 实现**必须**在 restore 前比对当前内容与快照、发现外部改动则弹窗确认(见 §4.8 推荐做法),这是 elf 可以比 CC 做得更好的点,不可省。
4. **双击 Esc 窗口未公开**（CC 未给毫秒数）—— 取 400ms 可配常量，写入本文档作为 elf 的决策。
5. **streaming 中不可回退** —— `activeTurn !== null` 时不可回退，必须先中断。双击 Esc 第一击若在跑（现有 window 监听拦下），当次只 abort 不进菜单流程；回退按钮此时隐藏。
6. **`context.json` 不破坏向后兼容** —— 选 §4.6 方案 B（独立 `checkpoints.json`）。
7. **checkpoint 体积** —— 每个 checkpoint 存全量 messages 快照，长会话会膨胀。P1 可改为"存 messageCount + 增量"，MVP 先全量、加 `maxCheckpoints`（默认 50）上限 + 滑窗淘汰。
8. **文件轴不引入工作目录边界**（已定决策，见 §4.8）—— 只快照"工具写过的文件名单"，不做 cwd 子树判定。代价：Edit/Write 写项目目录外的绝对路径时照快照照覆盖（同 CC）。已否决 cwd 严格方案及其五层衍生问题。
9. **processing 守卫只放 server 层一处（架构约束）** —— `POST /rewind` 必须在 server 层用 `isProcessing` 拦截（§4.4），agent 层 `rewind()` 不重复判（§4.3，勿用 `_abortController` 当标志——它 reasoning 中几乎恒非 null，会判错）。**技术债提示（独立，不在本期范围）**：现有 `POST /clear`（`server.js:181`）**不做 `isProcessing` 守卫**，streaming 中调 clear 会与 loop 竞态写 `context.json`；`/rewind` 引入同类风险，故必须守卫，`/clear` 的既有问题另行处理。

---

## 七、验收标准（MVP）

- [ ] 任意 Agent，发若干轮对话后，**双击 Esc（输入框空、非 processing）** 弹出 rewind 菜单浮层。
- [ ] 菜单列出每个用户 prompt 对应的 checkpoint，最近的在最下、默认聚焦；`↑↓` 移动焦点、`Enter` 选中、`Esc` 关闭。
- [ ] 选中一项 → `messages` 截断回该点，对话区被 snapshot 刷新，被回退的 prompt 回填输入框。
- [ ] 回退后再次发送，LLM 请求的 messages 确实是截断后的（从 log 验证）。
- [ ] 正在处理时按 Esc → 仅中断，不进菜单；中断完成、输入框空后再双击 Esc 才开菜单。
- [ ] 会话初始无 checkpoint 时双击 Esc → 浮层显示"暂无可回退状态"，无列表项。
- [ ] 移动端（`max-width:768px`）点击输入框旁「⟲回退」按钮 → 打开同一个 rewind 菜单；触屏点击列表项选中 +「回退到此」确认回退。
- [ ] 回退按钮显隐与双击 Esc 开菜单时机逐字一致（`canOpenRewind = !isStreaming && inputRef.current?.value.trim() === ''`）：streaming 中、输入框有字时按钮隐藏；两入口任何时刻要么都可开菜单要么都不可。
- [ ] 刷新页面/重启 Agent 后，checkpoint 仍在，可继续回退。
- [ ] 触发 compact 后，旧 checkpoint 被清空，不可回退到 compact 之前（符合 §4.7）。
- [ ] `test/agent.test.js`、`test/integration.test.js` 通过新用例。

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
- elf 相关代码：
  - `shared/agent/message_manager.js` —— 主改动
  - `shared/agent/default_agent.js` —— `rewind()` 入口
  - `shared/agent/server.js` —— `/rewind`、`/checkpoints` 端点
  - `frontend/src/hooks/useChat.js:270`（aborted）、`:355`（abort）—— 双击 Esc 参考
