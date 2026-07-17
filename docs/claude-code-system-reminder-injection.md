# Claude Code `<system-reminder>` 与 `isMeta` 体系详解

> 基于 `cli.js` 源码逆向(v2.1.77+),记录 `<system-reminder>` 标签和 `isMeta` 标记的完整机制。
> 日期:2026-07-02

---

## 1. 两个独立维度

`<system-reminder>` 和 `isMeta` 是**两个独立的维度**,经常同时出现但不是绑定关系。

| 维度 | 位置 | 谁消费 | 效果 |
|:--|:--|:--|:--|
| **`<system-reminder>` 标签** | content 内(发给模型的文本) | 模型 | 识别为"系统元信息,不主动提及用户" |
| **`isMeta` 标记** | 消息对象上的布尔字段(**不传 API**) | cli.js harness | 中断检测跳过、轮次不计、fixture 过滤、compact 后重推 |

---

## 2. `<system-reminder>` 标签

### 2.1 本质

`<system-reminder>` 是 cli.js **自己约定**的内容包裹格式,不是 Anthropic API 的原生概念。它不是 `role: "system"` 消息,不是 API 参数——而是嵌在 `role: "user"` 消息的 content 中的 XML 标签。模型被训练识别这个标签,理解为"系统在对话中注入的上下文提示"。

### 2.2 包裹函数

```js
// cli.js:6836  核心包裹函数
function qT(A) { return `<system-reminder>\n${A}\n</system-reminder>` }

// cli.js:6838  批量包裹:对消息数组中每条消息的 content 调用 qT
function x5(A) {
  return A.map(q => {
    if (typeof q.message.content === "string")
      return {...q, message: {...q.message, content: qT(q.message.content)}}
    else if (Array.isArray(q.message.content)) {
      let K = q.message.content.map(Y => {
        if (Y.type === "text") return {...Y, text: qT(Y.text)}
        return Y
      })
      return {...q, message: {...q.message, content: K}}
    }
    return q
  })
}
```

**`x5` 的关键**:任何地方 `x5([p1({content:"...", isMeta:true})])`,content 都会被 `qT` 自动包上 `<system-reminder>`。

### 2.3 去重保护 `Gqz`

```js
// cli.js:6829  如果 content 已以 <system-reminder> 开头,不重复包裹
function Gqz(A) {
  let q = A.message.content
  if (typeof q === "string") {
    if (q.startsWith("<system-reminder>")) return A  // 已包裹,跳过
    return {...A, message: {...q.message, content: qT(q)}}
  }
  // array case: 每个 text block 独立判断
  ...
}
```

### 2.4 存储与发送的两阶段设计

附件(attachments)先以**原始内容**(不含 `<system-reminder>` 标签)存进 transcript;发给 LLM 前在规范化阶段(`P64` 管道)才通过 `x5`/`Gqz` 套上 `<system-reminder>` 标签。少数场景由工具直接把标签写进结果(如 Read 的告警,内联在 tool_result 中)。

### 2.5 消费侧(读取/处理 `<system-reminder>`)

| 函数 | 行号 | 作用 |
|:--|:--|:--|
| `tI9` 正则 | 1780 | `/<system-reminder>\n?([\s\S]*?)\n?<\/system-reminder>/` 提取标签内容 |
| `tZq` | 6829 | 把 tool_result 中夹带的 `<system-reminder>` text blocks 提出来,插到 tool_result 后面(防止模型忽略) |
| Strip | 3781 | 从 tool_result 中 `replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")`(用于文件内容去噪/缓存 key 计算) |

### 2.6 粘附(实验开关 `tengu_chair_sermon`)

`tZq` 把 reminder 移到同一条 user 消息里最后一个 `tool_result` 旁边——让提醒"贴着"工具结果。

---

## 3. `isMeta` 标记

### 3.1 本质

`isMeta` 是 cli.js 消息对象上的一个**布尔字段**,由 `p1({content:..., isMeta:true})` 构造。**不传给 Anthropic API**——API 只看到 `role:"user"` + `content`,不知道 isMeta 的存在。isMeta 纯粹是 harness 内部的标记。

### 3.2 消息构造

```js
// cli.js:10573863
function p1({content, isMeta, isVisibleInTranscriptOnly, isCompactSummary, ...}) {
  return {
    type: "user",
    message: { role: "user", content: content },
    isMeta: isMeta,             // harness 内部标记
    isVisibleInTranscriptOnly,  // 是否只在 transcript 显示
    isCompactSummary,           // 是否是 compact 摘要
    // ...
  }
}
```

### 3.3 isMeta 在各处的确切行为

#### (a) 发送 API:不过滤,正常保留

`pM` 函数(API 消息序列化):isMeta 消息**正常 push 到消息数组**,不过滤。API 只看到 `role:"user"` + `content`(isMeta 字段不传)。

唯一例外:`BM1` 函数(fixture 测试录制)会 `filter(w => { if(w.type!=="user") return true; if(w.isMeta) return false })` 过滤掉 isMeta 消息,**但这是测试场景,不是正常 API 路径**。

#### (b) 中断检测:跳过

```js
// cli.js:8303045
if (q.type === "user") {
  if (q.isMeta || q.isCompactSummary) return { kind: "none" }  // 不触发中断
}
```

isMeta 消息不计为"用户输入",不会触发中断提示(UI 弹"用户有新输入")。

#### (c) 用户消息计数:排除

```js
// 找最后一个非 isMeta 用户消息
A.findLast(z => z.type === "user" && !z.isMeta)
```

isMeta 消息不计入"用户轮次"。

#### (d) Compaction 处理

isMeta 在 compact 时的关键行为——**参与摘要，不重推**：

```js
// 平时增量推送：mhY() 只推 !nT6.has(name) 的新 skill，推过即 nT6.add(name)；首推 isInitial=true
// gc4(): compact 时设 qE1 = true
// mhY() 在 qE1=true 时：把当前所有 skill 名加入 nT6("已推送过")→ return []（不产生新 attachment，防 compact 后重推）
// Pc(): 清空 nT6 + 重置 qE1(仅在会话重开时调用；rewind 不调)
```

Compact(上下文压缩)发生时，isMeta 消息和所有其他 user 消息一样，被包含在摘要请求中——`...this.messages.map(m => ({...m}))`。摘要文本本身会覆盖这些信息（如 skill 描述）。**不会**在 compact 后重新注入 isMeta 消息：

1. `mhY()` 检测到 `qE1=true` 后，只把 skill 名加进 `nT6` Set 然后 `return []`——不产出任何新 attachment。且 `nT6` 是进程内 Set、不在消息里、compact 不清空，故后续也无"已推过"的 skill 可推——**清单 compact 后永不重推**（只有 `invoked_skills` 例外，见 §5.2）
2. `WhY()`(date_change) 只在日期真的变了才产出，compact 不改变日期
3. 其他 isMeta 消息生产者也依赖各自的条件判断，compact 不会无条件重产

**所以 isMeta 不是"compact 后重推"，而是"参与 compact 摘要，被摘要文本替代"。** Compact 后 skill 依然可用是因为：Skill 工具永远在工具列表里 + 摘要里提到过可用 skill 的描述。

#### (e) 消息合并(去重)

`pM` 中:如果某 isMeta 消息之前有 tool_use,且其 content blocks 中有重复类型(`P` set 追踪),会去重:

```js
if (P && X.isMeta) {
  let Z = X.message.content
  if (Array.isArray(Z)) {
    let G = Z.filter(f => !P.has(f.type))
    if (G.length === 0) return   // 完全重复,丢掉
    if (G.length < Z.length) X = {...X, message: {...X.message, content: G}}  // 部分去重
  }
}
```

#### (f) isMeta 与 `isVisibleInTranscriptOnly`、`isCompactSummary` 的区别

| 标记 | 作用 | 发 API | 中断检测 | 轮次计数 | Compact |
|:--|:--|:--|:--|:--|:--|
| `isMeta` | 系统注入元消息 | 保留 | 跳过 | 不计 | 参与摘要,被摘要替代,compact 后不重推 |
| `isVisibleInTranscriptOnly` | 仅在 transcript 显示 | **不发 API** | - | - | - |
| `isCompactSummary` | compact 摘要产物 | 保留 | 跳过 | 不计 | 是摘要本身 |

---

## 4. 组合使用

### 4.1 两者都用:`<system-reminder>` + `isMeta`

Skill 清单、Context 注入(CLAUDE.md)、Team context、Plan mode 提示等。

```js
// Skill 清单(行10610944)
case "skill_listing": {
  return x5([p1({content: "The following skills are available...", isMeta: true})])
  // x5 调 qT 包 <system-reminder>, p1 设 isMeta:true
}

// Context 注入(行6546)
function vE1(A, q) {
  return [p1({content: `<system-reminder>\n...\n</system-reminder>`, isMeta: true}), ...A]
  // 手写 <system-reminder>, p1 设 isMeta:true
}
```

效果:
- 模型看到 `<system-reminder>` → 识别为系统提示,不主动提及
- Harness 看到 `isMeta:true` → 不计轮次、不触中断、参与 compact 摘要

### 4.2 只有 `<system-reminder>`,没有 isMeta

Read 工具的空文件/偏移量警告(行1648):内联在 tool_result content 中,不是独立消息,没有 isMeta。

### 4.3 只有 isMeta,没有 `<system-reminder>`

"Output token limit hit" 提示(行9083040):

```js
p1({content: "Output token limit hit. Resume directly...", isMeta: true})
// 没有 x5 包裹,没有 <system-reminder> 标签
```

---

## 5. 注入场景全清单（两类 ~45 个注入点）

isMeta 消息分两大类：**每轮注入**（`KhY()` 生产的 attachment → dispatch 转消息）和**事件驱动**（工具返回/hook/中断等直接调用 `p1`）。

### 5.1 第一类：每轮 context attachment（KhY → dispatch）

每轮 reasoning 前由 `KhY()` 调用 `zz()` 并行生产 attachment，经 dispatch 函数（`switch(A.type)`）转为 isMeta 消息。dispatch 中 `return x5([p1(...)])` 的 case 都会产出一条 `<system-reminder>` + isMeta 消息。

| attachment type | 内容 | 备注 |
|:--|:--|:--|
| `date_change` | "The date has changed..." | 仅跨天时产出，compact 不触发 |
| `skill_listing` | "The following skills are available..." | 增量推送（`nT6` 去重） |
| `nested_memory` | 嵌套记忆内容 | |
| `relevant_memories` | 相关记忆 | |
| `ultramemory` | 超记忆 | |
| `changed_files` | "The following files have changed..." | 文件变更通知 |
| `diagnostics` | `<new-diagnostics>` 代码诊断 | |
| `plan_mode` | "Plan mode is active..." | |
| `plan_mode_exit` | "Exited Plan Mode..." | |
| `plan_mode_reentry` | 重入计划模式 | |
| `auto_mode` | "Auto Mode Active..." | 完整/稀疏两种 |
| `auto_mode_exit` | 退出自动模式 | |
| `todo_reminder` | 待办事项提醒 | |
| `task_reminder` | 任务提醒 | |
| `output_style` | "output style is active..." | |
| `token_usage` / `budget_usd` | Token / USD 预算用量 | |
| `output_token_usage` | 输出 token 用量 | |
| `verify_plan_reminder` | 验证计划提醒 | |
| `ultrathink_effort` | "reasoning effort level..." | |
| `deferred_tools_delta` | 延迟工具变更 | |
| `mcp_instructions_delta` | MCP 指令变更 | |
| `critical_system_reminder` | 关键系统提醒（透传） | |
| `teammate_mailbox` | 队友消息汇总 | 受 `h7()` feature flag 控制 |
| `team_context` | 团队角色/能力说明 | 同上 |
| `queued_command` | 排队命令 | |
| `agent_mention` | Agent 提及 | |
| `mcp_resource` | MCP 资源 | |
| `at_mentioned_files` | @ 提及的文件 | |
| `compaction_reminder` | "Auto-compact is enabled..." | ❌ `KhY` 中无 producer，当前未注入 |
| `context_efficiency` | return `[]` | 空返回 |
| `dynamic_skill` | return `[]` | 空返回 |
| `structured_output` | return `[]` | 空返回 |

### 5.2 第二类：事件驱动（工具返回 / hook / 中断等直接调用 p1）

不走 `KhY` → dispatch 链路，由具体事件处理函数直接调用 `p1({content, isMeta:true})`。

#### 文件/资源读入

| 触发 | 调用点 | 内容 |
|:--|:--|:--|
| `directory` attachment | dispatch | 目录列表 |
| `file` attachment | dispatch | 文件内容（截断的追加 truncation note） |
| `notebook` attachment | dispatch | Notebook 内容 |
| `pdf_reference` attachment | dispatch | PDF 引用说明 |
| `plan_file_reference` | dispatch | 计划文件引用 |
| `selected_lines_in_ide` | dispatch | IDE 选中行 |
| `opened_file_in_ide` | dispatch | IDE 打开文件 |
| PDF page extraction | Read 工具返回 | PDF 页面提取结果（`newMessages`） |
| Image extraction | Read 工具返回 | 图片 base64 数据（`newMessages`） |
| MCP resource（无内容） | MCP 工具 | `(No content)` 提示 |

#### Hook 相关

| 触发 | 内容 |
|:--|:--|
| `hook_blocking_error` | 阻断错误详情（`RF8()`） |
| `hook_success` | "hook success: ..." |
| `hook_stopped_continuation` | "hook stopped continuation" |
| `hook_additional_context` | hook 附加上下文 |
| `async_hook_response` | 异步 hook 响应 |
| `hook_system_message` | hook 系统消息透传（`metaMessages`） |

#### 中断/恢复/会话

| 触发 | 函数 | 内容 |
|:--|:--|:--|
| Output token limit hit | 流式处理中 | "Output token limit hit. Resume directly..." |
| Interrupted turn | `$M()` 调用处 | "Continue from where you left off." |
| Session resumed from another machine | `bZY()` | "The updated working directory is..." |
| 子 agent at-mention | 子 agent 调用 | 子 agent 说明/上下文 |

#### Tool 结果/命令/权限

| 触发 | 内容 |
|:--|:--|
| `invoked_skills` | compact 后 `dAq()` 重新注入本会话已触发过的 skill **正文全文**（name + path + SKILL.md 完整内容，含变量替换和 !cmd 预处理后的结果）。dispatch 为 `"The following skills were invoked in this session. Continue to follow these guidelines:\n\n### Skill: name\nPath: path\n\n...full content..."`。让模型在 compact 后仍知道之前用过哪些 skill 及其完整上下文 |
| `task_status` | 任务状态变更（如被用户停止） |
| File snapshot | `type:"system"`, 文件快照内容 |
| `<local-command-caveat>` (`$h()`) | 本地命令运行透气消息 |
| PDF inline content | PDF 页面内容注入 |

### 5.3 不注入 isMeta 的类型

以下 attachment type 在 dispatch 中返回 `[]`（不产生任何消息）或 `return null`（UI 层跳过）：

`dynamic_skill`、`structured_output`、`context_efficiency`、`todo`、`task_progress`、`background_task_status`、`autocheckpointing`、`already_read_file`（return `[]`）、`command_permissions`（UI 层）、`edited_image_file`、`hook_cancelled`、`hook_error_during_execution`、`hook_non_blocking_error`、`hook_system_message`、`hook_permission_decision`

---

## 6. 完整数据流:Skill 清单从生产到模型

```
1. mhY() 生产 attachment
   {type:"skill_listing", content: kN8(skills, budget), skillCount, isInitial}

2. 消费侧(行10610944) 转消息
   case "skill_listing" → x5([p1({content: "The following skills...\n" + A.content, isMeta: true})])
   ↓
   x5 调 qT 包 <system-reminder>:
   p1({content: "<system-reminder>\nThe following skills...\n- name: desc\n</system-reminder>", isMeta: true})
   ↓
   {type:"user", message:{role:"user", content:"<system-reminder>..."}, isMeta:true}

3. pM(序列化) → 正常保留,发给 API
   API 看到: {role:"user", content:"<system-reminder>\nThe following skills...\n</system-reminder>"}
   (isMeta 字段不传 API)

4. 模型处理
   模型看到 <system-reminder> 标签,理解这是系统注入,不主动向用户提及

5. Harness 处理
   isMeta:true → 不计轮次 / 不触中断
   compact: isMeta 消息参与摘要，被摘要文本替代。compact 后不重推（各生产者按条件重新判断，条件不变则不产出）
```

---

## 7. isMeta 消息在 API 消息数组中的位置

### 7.1 数据流

CC 的消息组装分为两层：

1. **attachment 生产** (`KhY`) — 每轮计算所有 attachment（`date_change`, `skill_listing`, `context` 等），返回 attachment 对象数组
2. **转录（transcript）组装** (`gf6` async generator) — 将 attachment 按类型分发为 `p1({content, isMeta:true})` 消息，按顺序插入 transcript
3. **API 序列化** (`pM`) — 遍历 transcript，拼成发给 LLM 的消息数组

### 7.2 发给 LLM 的消息顺序

```js
// gf6 消费侧: attachments 在 history + tool_results 之后 yield
for await (let att of gf6(null, w6, null, k6, [...userMsg, ...assistantMsgs, ...toolResults], threadName))
    yield att, toolResults.push(att)
```

新的用户输入在更外层单独处理，位于所有 attachment 之后。最终 API 消息数组顺序：

```
[
  { role: "system", content: systemPrompt },
  ...history messages (assistant + tool turns),        ← 历史对话
  { role: "user", content: "<system-reminder>date_change</system-reminder>", isMeta: true },
  { role: "user", content: "<system-reminder>skill listing</system-reminder>", isMeta: true },
  { role: "user", content: "<system-reminder>context / CLAUDE.md</system-reminder>", isMeta: true },
  { role: "user", content: "用户的实际输入" }              ← 排在最后
]
```

**关键规律：isMeta 消息位于用户输入之前、历史消息之后。**

### 7.3 多条 isMeta 之间的顺序

从 `KhY` 函数中 `zz()` 调用顺序可确认多条 isMeta 消息的内部顺序：

```
J 组（文件相关）: at_mentioned_files, mcp_resources, agent_mentions
M 组（核心注入）: date_change, skill_listing, context, plan_mode, auto_mode, todo_reminders
D 组（IDE 相关）: ide_selection, diagnostics, token_usage, verify_plan_reminder
```

最终返回 `[...J.flat(), ...M.flat(), ...D.flat()]`，即 **文件 → 核心注入（date→skill→context）→ IDE**。

### 7.4 对 elf 的指导

如果要注入 date_change isMeta 消息到 elf，正确做法是在 `addUserMessage(用户输入)` **之前**调用 `addMetaMessage`：

```
addMetaMessage(dateContent, 'date')   // 先插入 isMeta
addUserMessage(message)                // 再插入用户输入
```

这样 `messages` 数组为 `[system, ...历史, isMeta date, 用户输入]`，`getMessagesForLLM` 剥离 `isMeta`/`metaTag` 后发给 API 的顺序为 `[system, ...历史, date, 用户输入]`——与 CC 一致。

---

## 8. system prompt 配套告知

cli.js 的 system prompt 里有配套说明(行6447):

> "Tool results and user messages may include `<system-reminder>` or other tags. Tags contain information from the system. They bear no direct relation to the specific tool results or user messages they appear with."

这是给模型的"元提示",告诉模型如何解读 `<system-reminder>` 标签。

---

## 9. 符号速查

| 符号 | 行号 | 作用 |
|:--|:--|:--|
| `qT` | 6836 | `<system-reminder>\n${A}\n</system-reminder>` 包裹函数 |
| `x5` | 6838 | 批量给消息 content 包 `<system-reminder>`(调 `qT`) |
| `Gqz` | 6829 | 去重保护:已包裹则跳过 |
| `tI9` | 1780 | `/<system-reminder>...<\/system-reminder>/` 正则,解析内容 |
| `tZq` | 6829 | 重排:tool_result 中 `<system-reminder>` blocks 提到 tool_result 后 |
| `p1` | 10573863 | 构造 user 消息:`{type:"user", message:{role:"user",content},isMeta,...}` |
| `vE1` | 6546 | Context 注入:手写 `<system-reminder>` + `p1({isMeta:true})` |
| `pJ7` | 383 | Memory 时间戳:返回 `<system-reminder>timestamp</system-reminder>` |
| `pM` | 10584820 | API 消息序列化:isMeta 消息**不过滤**,正常发 API |
| `BM1` | 4869483 | Fixture 测试录制:**过滤掉** isMeta 消息 |
| `gc4` | 9004510 | 设置 `qE1=true`，标记"compact 刚发生"，不触发重推 |
| `mhY` | 9004538 | Skill listing 生产：**增量推送**(`nT6` 去重，只推 !nT6.has 的新 skill；未注册 Skill 工具→`return []`)；`qE1=true`(compact 后)时把全部 skill 标进 `nT6` 后返回空——**compact 后不重推清单** |
| `Pc` | 9004477 | 清空 `nT6` + 重置 `qE1`（仅会话重开时调用；rewind 不调） |
| `nT6` | 9013199 | `Set<string>`，已推送 skill 名集合，增量去重用，会话内常驻(compact 不清) |
| `NZY` | 2835 | 回放 transcript 中的 attachment：遇 `skill_listing` → 调 `gc4()` |
| `cl8` | - | 附件分发器:每种 attachment type 映一个 case,产出消息 |

---

## 10. elf-002 对照(isMeta 改造优先级)

elf-002 当前代码**0 处注入** `<system-reminder>`,也**0 处使用 isMeta**。CC 的 ~20 类注入对应的功能 elf-002 几乎都没有。

### 每处是否必须加 isMeta 的判断框架

**核心原则**:`isMeta` 标记的作用是(1)不计入用户轮次/不触发中断 (2)参与 compact 摘要——isMeta 消息和其他 user 消息一起被摘要，摘要文本替代了原始 isMeta 内容。CC 不会在 compact 后无条件重推 isMeta 消息，各 producer 按自身条件重新判断（条件不变则不产出）。

| 场景 | 是否必须 isMeta | 不加会怎样 | 备注 |
|:--|:--|:--|:--|
| Skill 清单 | **是** | 被判为"用户输入"，干扰中断检测、计入轮次 | isMeta 让其参与 compact 摘要，不必重推；Skill 工具始终在工具列表里 |
| Context 注入(CLAUDE.md 等) | **是** | 同上 | 同上，摘要覆盖 context 信息 |
| Plan/Auto mode 提示 | **是** | 同上 | 同上 |
| date_change | 推荐 | 计入轮次，干扰中断检测 | CC 的 WhY() 只在日期真变才产出，compact 不触发 |
| Token 预算提醒 | 推荐 | 同上 | |
| Hook 反馈 | 推荐 | 同上 | |
| Todo/Task 提醒 | 推荐 | 同上 | |
| Read 工具告警(内联) | **不必** | 它在 tool_result 内联，不是独立消息 | CC 也没加 isMeta |
| MCP 指令/工具变更 | **是** | 同上 | |
| 文件变更通知 | 推荐 | 同上 | |
| 团队上下文 | **是** | 同上 | |
| 输出 token 限制提醒 | 推荐 | 同上 | |
| 侧问 agent prompt | 不必 | 独立的子 agent 调用，不走主对话 | |

### elf-002 当前应优先引入 isMeta 的场景

1. **Skill 清单** — 如果 elf-002 要支持 skill，isMeta 让它不计轮次、参与摘要
2. **Context 注入(CLAUDE.md / system prompt 之外的信息)** — 如日期、环境变量等
3. **任何不希望被当成"用户输入"的系统提示** — 这是 isMeta 的核心价值

### isMeta 的 compact 行为（重要更正）

**CC 不会在 compact 后无条件重推 isMeta 消息。** Compact 发生时：

- isMeta 消息**参与摘要**——和其他 user 消息一起包含在 compact 请求中，摘要文本覆盖了 skill 描述、context 内容等信息
- 各 producer 按**自身条件**重新判断要不要产出新消息
- `gc4()`/`mhY()` 并不是"重推 skill 清单"——`qE1=true` 时 `mhY()` 只是把当前 skill 全部标记为"已推送过"（`nT6.add(name)`），然后**返回空数组**
- 作用是防止 compact 后增量推送把已有 skill 当"新 skill"再写一遍

elf 的 `_reinjectMetaMessages()` 应**对齐 CC**:
- **skill 清单不重推**——靠进程内 `_pushedSkills: Set`(对齐 `nT6`,会话常驻、compact 不清、rewind 不清)做增量去重;compact 后无新增 → `_formatSkillListing()` 返回空 → 不注入
- **只重推 `invoked_skills`**(对齐 `dAq()`):compact 后把本会话已触发过的 skill 正文全文以 `<system-reminder>` + isMeta 重新注入(这条 CC 确实重推,见 §5.2)
- 即:compact 后 elf 只补一类消息——调用过的 skill 全文(invoked_skills),不补清单

### 不需要 isMeta 的场景

- 一次性提醒(如"Output token limit hit")— 可以只发普通 user 消息
- 内联在 tool_result 中的告警 — 它的生命周期随 tool_result,不受 compact 影响
- 纯信息性提示,compact 后丢失也无害的场景