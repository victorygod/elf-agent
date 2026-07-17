# Claude Code L4 摘要请求解剖（2.1.209，源码级参数）

> 专门讲清楚一件事：L4 compact 触发那一刻，**发给摘要 LLM 的请求长什么样**——消息结构、每个参数的真实值。
> 证据来源：`/Users/wolf/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`（v2.1.209，229MB Bun 二进制），`strings` 提取可读函数体。
> 日期：2026-07-16

---

## 0. 为什么单独成文

`docs/claude-code-l4-compact-2.1.209.md` 讲了 L4 的四条路径和机制，但**没有把"摘要请求的完整上下文结构 + 每个参数的真实值"拎出来逐条核实**。本文专门做这件事——尤其要回答：

1. **保留了近 s 个 group，这些 group 送摘要请求吗？**（答：不送）
2. **摘要请求的上下文结构是啥？**（答：专用 system + 老 group + 末尾 compactPrompt）
3. **每个参数（阈值、模型配置、tools、thinking、maxTurns 等）的真实值是多少？**

所有参数从二进制 `strings` 核实，不凭记忆。

---

## 1. 核心结论（先看这个）

**摘要请求只送"将被替换的老历史"，不送近期保留的 group。** 近期 s 个 group 在摘要请求里缺席，只在压缩成功后原样拼回最终 history、留给后续正常 LLM 调用完整看到。

```
摘要请求发给 LLM 的结构(reactive 路径,aDg):

  [
    { role:"system",  content: <专用 compact system prompt> },
    ── forkContextMessages: 老 group 展平成消息流(保护区外全部) ──
    { role:"user",      content: ... },   ← G0
    { role:"assistant", content: ..., tool_calls:[...] },   ← G1 起
    { role:"tool",      content: ...(或已被 L1/L2 预览化为 <persisted-output>) },
    ...
    ── promptMessages: compactPrompt 作为本轮 user 输入(末尾) ──
    { role:"user",      content: "CRITICAL: Respond with TEXT ONLY...<9段模板>...IMPORTANT: Do NOT use any tools..." }
  ]

  ★ 近期 s 个 group(G_{o-s}..G_{o-1}) 不在这个请求里
```

**核心三段**：专用 system + 老 group（forkContextMessages，"上文要摘的内容"）+ compactPrompt（末尾 user，"去摘"的指令）。

---

## 2. 老历史怎么送：`forkContextMessages`

### 2.1 源码（`aDg`）

**证据**（`strings` 行 399396 内，`aDg` 函数体）：
```js
async function aDg(e, t, r, n) {           // e = 要摘要的老 group 消息流(已 flat)
  let o = KZn(r);                           // o = compactPrompt 文本
  let i = Br({content: o});                 // 包成 user 消息
  s = await z$({
    promptMessages: [i],                    // ★ compactPrompt 作为本轮 user 输入
    cacheSafeParams: {
      ...t,
      forkContextMessages: n ? EXi(e) : e   // ★ 老历史放这里,不是 promptMessages
    },
    canUseTool: AXi(),                      // 工具全 deny
    querySource: "compact",
    forkLabel: "reactive-compact",
    maxTurns: 1,
    ...
  });
}
```

### 2.2 `z$` 如何展开

`z$`（fork 调用入口）把 `cacheSafeParams.forkContextMessages` 作为"会话上文"展开、`promptMessages` 作为"本轮用户输入"追加在末尾。最终拼出的消息序列就是：

```
[<system>] + [forkContextMessages...] + [promptMessages...]
```

老 group 在前、compactPrompt 在后。模型读老对话、按 compactPrompt 指令产出摘要。

### 2.3 关键证据：`KZn` 的"conversation above"

**证据**（`strings` 行 399396 内，`KZn` 函数体）：
```js
function KZn(e) {
  let t = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.   ← "上面的对话"
- Tool calls will be REJECTED and will waste your only turn...
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
` + $Hg;                                                                   // $Hg = 9 段模板
  if (e && e.trim() !== "")
    t += `\nAdditional Instructions:\n${e}`;                                // 可选 customInstructions
  return t += hHu, t;                                                       // hHu = IMPORTANT 结尾
}
```

`"You already have all the context you need in the conversation above."` 明确告诉模型：**上面那段 forkContextMessages（老 group）就是要被摘要的内容**。

---

## 3. 近期 s 个 group **不送**

`neo` 里 `m = n.slice(p)`（保留的近期 group）只用于**返回后的最终消息队列**：

**证据**（`strings` 行 399396 内，`neo` return）：
```js
if (y.ok) {
  return { ok:true, result: {
    summaryMessages: y.messages,        // 摘要产物(1 条 user 消息)
    messagesToPreserve: m.flat(),       // ★ 近期 s 个 group,原样保留
    attempt:a, groupsPreserved:s, totalGroups:o
  }};
}
```

`messagesToPreserve` **不进 `aDg`、不进摘要请求**。上层（`deo`/`peo`）把它和 `summaryMessages` 拼回最终 history：

```
最终 history = [compact_boundary, summaryMessages(G0..G_{o-s-1} 的摘要), messagesToPreserve(G_{o-s}..G_{o-1} 原文)]
```

→ 摘要 LLM 只摘要老历史、从不见近期 group；近期 group 在压缩后的**正常 LLM 调用**里完整登场。

> **澄清：保留 group 是 reactive 的常驻行为，与摘要是否超长无关**。
> `neo` 成功分支（`y.ok` 为真、即首轮摘要请求没超长就成功）**照样返回 `messagesToPreserve`**——只是此时 `s=1`（仅保留最近 1 个 group）。`prompt_too_long` 重试做的只是把 `s` 从 1 调大（临时扩保留区、缩摘要区），不是"不超长就不保留"。
>
> 即：**保留近期 group 是 reactive 压缩的固有结构**（让模型续上有完整上下文、不只靠摘要），默认保留量 = 最近 1 个 group；超长重试只是把保留量从 1 临时涨到 N 的容错机制。两件事正交：
> - "保留 group 原样" —— 每次压缩都做（至少 1 个）；
> - "超长重试扩保留" —— 只在摘要请求超长时触发，扩到能装下或 3 次用尽（`THu=3`）。

---

## 4. 摘要请求参数表（已逐条源码核实）

下表每行的"真实值"从二进制 `strings` 核实，证据详见 §5。

| 参数 | 真实值 | 源码锚点 |
|---|---|---|
| system prompt | `"You are a helpful AI assistant tasked with summarizing conversations."` | `strings` 行 168068；`CHu` 内 `ld([...])` |
| messages 顺序 | `[system] + forkContextMessages(老group) + promptMessages(compactPrompt)` | `aDg` + `z$` 展开 |
| forkContextMessages | reactive: `stripNonEssential ? EXi(e) : e`（EXi 做 media strip：image/document→`[image]`/`[document]`）；全量: 经 `Ub` 裁剪 | `aDg`（§5.4 EXi 已查） |
| promptMessages | `[Br({content: KZn(customInstructions)})]` = compactPrompt 一条 user | `aDg` |
| compactPrompt 文本 | `KZn` = `CRITICAL: Respond with TEXT ONLY...` + `$Hg`(9段) + (可选 Additional Instructions) + `hHu`("REMINDER: Do NOT call any tools...") | `KZn` 函数体（§5.1/§5.2 已查） |
| tools（reactive） | 不显式带；走 `toolUseContext` 继承主会话 tools，但 `canUseTool:AXi()` 全 deny → 实际调不出 | `aDg` / `z$`（§5.6 已查） |
| tools（全量自动） | `stripNonEssential ? [] : (tool-search开 ? [Read,ToolSearch,...MCP] : [Read])`；但 `canUseTool:AXi()` 全 deny | `CHu` |
| canUseTool | `AXi()` → 全 deny（`"Tool use is not allowed during compaction"`） | `AXi`；`strings` 行 168040 |
| thinkingConfig | `Y6r(主会话)`：**取主会话 thinkingConfig**；若有 `max_thinking_tokens` permissionLayer 且=0 → disabled，否则 enabled(budgetTokens:N)。**非恒禁** | `Y6r`/`pMs`（§5.5 已查） |
| toolChoice | `void 0`（不强制） | `CHu` options |
| maxTurns | `1` | `aDg` / `z$` |
| enablePromptCaching | `false` | `CHu` options |
| querySource | `"compact"` | `aDg` |
| forkLabel | reactive: `"reactive-compact"`；全量: `"compact"` | `aDg` |
| skipTranscript | reactive: `true` | `aDg` |
| skipCacheWrite | reactive: `true` | `aDg` |
| 重试上限（partial，prompt_too_long） | `THu = 3` | `EHu` |
| 断路器（连续失败禁用） | `qHu = 3` | `UHu` |
| 摘要包装前缀 | `"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n"` | `z6r` |
| 续写指令（自动路径） | `suppressFollowUpQuestions=false` 时追加 `"Continue the conversation from where it left off...Resume directly...do not preface with 'I'll continue'...Pick up the last task as if the break never happened."` | `z6r` continuationClause |
| transcriptPath 附加 | 有则追加 `"If you need specific details...read the full transcript at: <path>"` | `z6r` |
| Read 工具名常量 | `var Yi="Read"`（`CHu` 的 `nS` 工具对象其 name 解析为 `"Read"`） | `strings` |

---

## 5. 参数逐条核实（从源码 grep 补全 §4）

本节逐条 grep 二进制真实值，补进 §4。
### 5.1 `hHu` —— compactPrompt 结尾常量

**证据**（`strings` 行 399396 内）：
```
hHu = `
REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`
```
→ 加在 `KZn` 返回的 compactPrompt 末尾。与开头的 "CRITICAL: Respond with TEXT ONLY..." 首尾呼应，两道防线禁工具。

### 5.2 `$Hg` —— 9 段模板主文

**证据**（`strings` 行 399396 内，`$Hg` 常量）：开头为 `"Your task is to create a detailed summary of the conversation so far..."`，含 9 段标题（Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors and fixes / Problem Solving / All user messages / Pending Tasks / Current Work / Optional Next Step）。第 6 段含 2.1.209 新增的 `"Preserve any security-relevant instructions or constraints verbatim so they remain in effect after compaction."`。完整文本见 `docs/claude-code-l4-compact-2.1.209.md` §8。

### 5.3 `THu` / `qHu` —— 重试与断路器

**证据**（`strings` 行 399396 内）：
```
THu = 3   // partial compact prompt_too_long 重试上限
qHu = 3   // 断路器:连续失败 3 次禁用自动压缩
```

### 5.4 `EXi` —— reactive 路径的 media strip（forkContextMessages 预处理）

**证据**（`strings` 行 399396 内，`EXi` 完整函数体）：
```js
function EXi(e) {
  return e.map((t) => {
    if (t.type === "attachment") {
      let i = YHg(t.attachment);
      return i === t.attachment ? t : {...t, attachment: i};
    }
    if (t.type !== "user") return t;
    let r = t.message.content;
    if (!Array.isArray(r)) return t;
    let n = !1,
        o = r.flatMap((i) => {
          if (i.type === "image")     return n=!0, [{type:"text", text:"[image]"}];
          if (i.type === "document")  return n=!0, [{type:"text", text:"[document]"}];
          if (i.type === "tool_result" && Array.isArray(i.content)) {
            let s = !1, a = i.content.map((l) => {
              if (l.type === "image")    return s=!0, {type:"text", text:"[image]"};
              if (l.type === "document") return s=!0, {type:"text", text:"[document]"};
              return l;
            });
            if (s) return n=!0, [{...i, content:a}];
          }
          return [i];
        });
    if (!n) return t;
    return {...t, message: {...t.message, content: o}};
  });
}
```

**含义**：`aDg(..., n)` 的 `n`（对应 `stripNonEssential`）为 true 时，`forkContextMessages = EXi(e)`——把老历史里的 **image/document 块替换成 `[image]`/`[document]` 文本占位**（含 tool_result 内部的媒体块）。这是 reactive 路径减小摘要请求体积的预处理：模型摘要时不需要看图片/文档细节，文本占位足够。

→ `n ? EXi(e) : e`：n=true 走 media strip，n=false 原样。

### 5.5 `Y6r` —— thinkingConfig（修正：非恒禁）

**证据**（`strings` 行 399396 内，`Y6r` + `pMs`）：
```js
function Y6r(e) {
  let t = e.options.thinkingConfig;
  for (let r of e.permissionLayers ?? [])
    if (r.kind === "max_thinking_tokens") t = pMs(r.maxThinkingTokens);
  return t;
}
function pMs(e) {
  return e === 0 ? {type:"disabled"} : {type:"enabled", budgetTokens:e};
}
```

**修正 §4 表**：thinkingConfig **不是恒禁**。逻辑：
- 默认取 `options.thinkingConfig`（主会话的 thinking 配置）
- 若有 `max_thinking_tokens` permissionLayer 且值为 0 → `{type:"disabled"}`
- 否则 `{type:"enabled", budgetTokens:N}`

所以**摘要时 thinking 是否真关，取决于主会话配置**——若主会话禁了 thinking（maxThinkingTokens=0），摘要也禁；否则摘要时 thinking 开 `budgetTokens:N`。我之前在 `claude-code-l4-compact-2.1.209.md` §2 说"thinking 关"过于绝对，应订正为"取决于 Y6r 解析的配置"。

### 5.6 reactive `aDg` 是否带 tools

**证据**（`strings` 行 399396 内，`z$` 签名）：
```js
async function z$({promptMessages:e, cacheSafeParams:t, canUseTool:r, querySource:n,
                  forkLabel:o, overrides:i, maxOutputTokens:s, maxTurns:a, onMessage:l,
                  skipTranscript:c, skipCacheWrite:u, fallbackModel:d}) {
  ...
  let {systemPrompt:y, userContext:_, systemContext:b, toolUseContext:T, forkContextMessages:E} = t;
  ...
}
```

**关键**：`z$` **不接收 `tools` 参数**——工具列表来自 `cacheSafeParams.toolUseContext`（继承主会话 `t`）。`aDg` 传 `cacheSafeParams:{...t, forkContextMessages:...}`，所以工具定义走主会话的 tools，**但 `canUseTool:AXi()` 把任何工具调用硬 deny**。

→ 与全量自动 `CHu`（显式 `tools:[nS]`/[Read]）不同，reactive `aDg` 不显式带 tools、靠 AXi deny。**效果一致：模型调不出工具**。

### 5.7 Read 工具名变量

**证据**（`strings`）：`var Yi="Read"`（Read 工具名常量是 `Yi`，不是 `nS`——`nS` 是 `CHu` 里引用的工具对象变量，其 `name` 解析为 `Yi`/`"Read"`）。`CHu` 的 `tools:[nS]` = `[Read 工具对象]`。

### 5.8 §4 表更新（核实后）

| 参数 | 真实值（核实后） | 核实状态 |
|---|---|---|
| system prompt | `"You are a helpful AI assistant tasked with summarizing conversations."` | ✅ 行168068 |
| messages 顺序 | `[system] + forkContextMessages(老group) + promptMessages(compactPrompt)` | ✅ |
| forkContextMessages | reactive: `stripNonEssential ? EXi(e) : e`（EXi 做 media strip）；全量: `Ub(e)` | ✅ EXi 已查 |
| promptMessages | `[Br({content: KZn(customInstructions)})]` = compactPrompt 一条 user | ✅ |
| compactPrompt 文本 | `KZn` = `CRITICAL: Respond with TEXT ONLY...` + `$Hg`(9段) + (可选 Additional Instructions) + `hHu`(REMINDER: Do NOT call any tools...) | ✅ hHu/$Hg 已查 |
| tools（reactive） | 不显式带；走 toolUseContext 继承主会话 tools，但 `canUseTool:AXi()` 全 deny → 实际调不出 | ✅ |
| tools（全量自动） | `stripNonEssential ? [] : (tool-search开 ? [Read,ToolSearch,...MCP] : [Read])` | ✅ CHu 已查 |
| canUseTool | `AXi()` → 全 deny（"Tool use is not allowed during compaction"） | ✅ 行168040 |
| thinkingConfig | `Y6r(n)`：取决于主会话配置——`maxThinkingTokens=0` 则 disabled，否则 enabled(budgetTokens:N)。**非恒禁** | ✅ Y6r 已查 |
| toolChoice | `void 0`（不强制） | ✅ |
| maxTurns | `1` | ✅ |
| enablePromptCaching | `false` | ✅ |
| querySource | `"compact"` | ✅ |
| forkLabel | reactive: `"reactive-compact"`；全量: `"compact"` | ✅ |
| skipTranscript | reactive: `true` | ✅ |
| skipCacheWrite | reactive: `true` | ✅ |
| 重试上限（partial） | `THu = 3` | ✅ |
| 断路器 | `qHu = 3`（连续失败 3 次禁用） | ✅ |

---

## 6. 一次完整的摘要请求（端到端例子）

设对话 G0-G10（11 个 group），reactive 触发、`stripNonEssential=true`(`n`)、二分到 `s=4`（保留 G7-G10、摘要 G0-G6）。

```
调用: aDg(g = G0..G6 flat, t = 主会话 toolUseContext, customInstructions, n = true)

  ↓
z$({
  promptMessages: [ {role:user, content: KZn(customInstructions)} ],
  cacheSafeParams: {
    ...t,
    forkContextMessages: EXi(G0..G6 flat)   ← media strip: 图片/PDF → [image]/[document]
  },
  canUseTool: AXi(),                          ← 工具全 deny
  querySource: "compact",
  forkLabel: "reactive-compact",
  maxTurns: 1,
  skipTranscript: true,
  skipCacheWrite: true,
  fallbackModel: <主模型 fallback>
})

  ↓ z$ 展开 forkContextMessages + promptMessages
实际发给 LLM:

  [
    { role:"system", content:"You are a helpful AI assistant tasked with summarizing conversations." },

    ── forkContextMessages (G0..G6,媒体已 strip) ──
    { role:"user",      content:"帮我重构 auth 模块" },              ← G0
    { role:"assistant", content:"我先看下 auth.js", tool_calls:[{Read}] },  ← G1
    { role:"tool",      content:"<persisted-output>...预览...</persisted-output>" },  ← L1 已预览化
    { role:"assistant", content:"问题在 line 45", tool_calls:[{Grep}] },
    { role:"tool",      content:"auth.js:45: const pwd = ..." },
    ... G2..G6 ...

    ── promptMessages (compactPrompt,本轮 user) ──
    { role:"user", content:
       "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
        - Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
        - You already have all the context you need in the conversation above.
        - Tool calls will be REJECTED and will waste your only turn...
        - Your entire response must be plain text: an <analysis> block followed by a <summary> block.
        Your task is to create a detailed summary of the conversation so far...  ← $Hg 9段
        [Additional Instructions: ...]                                        ← 可选
        REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block..." }  ← hHu
  ]

  ★ G7-G10(近期保留) 完全不在这个请求里
  ★ 工具列表走 toolUseContext(继承主会话),但 canUseTool deny → 模型调不出
  ★ thinkingConfig = Y6r(主会话) → 看配置,非恒禁
```

### 摘要成功后

`aDg` 返回：
```js
{ ok:true,
  summaryText: "<analysis>...</analysis><summary>...</summary>",
  messages: [ {role:user, content: z6r(parsedSummary, {suppressFollowUpQuestions:true, transcriptPath, replStateCleared}),
               isCompactSummary:true, isVisibleInTranscriptOnly:true} ] }
```

`neo` 包装：
```js
{ summaryMessages: <上面的1条摘要user>, messagesToPreserve: [G7,G8,G9,G10 原文], groupsPreserved:4 }
```

上层拼最终 history：
```
[compact_boundary{trigger:"auto", preTokens, messagesSummarized:7, ...},
 摘要user消息("This session is being continued...Summary:\n...G0..G6摘要...", isCompactSummary:true),
 G7原文, G8原文, G9原文, G10原文]                    ← 近期4个group原样保留
```

→ 下次正常 LLM 调用，模型看到 `[boundary + 摘要 + G7-G10原文]`，远期靠摘要、近期靠原文，衔接工作上下文。

---

## 7. 端到端走查：从触发到压缩完毕（真实参数 + 真实响应推演）

§6 重在"摘要请求长什么样"（静态结构）。本节按**时序**走一遍完整的触发→压缩完毕，每步带真实参数值和源码函数名。

### 7.1 场景参数（真实值，取自 §4 表）

- 模型：Claude（窗口 200k token，演示用；机制与具体模型无关）
- auto-compact 阈值 ≈ `GF(model) - DF8` = 有效窗口 − ~13k ≈ **~180k token**（超即触发）
- L1 单工具阈值：`$q4=50000` 字符
- L2 budget 窗口：`jq4=200000` 字符
- 摘要 system：`"You are a helpful AI assistant tasked with summarizing conversations."`
- 摘要 user prompt：`KZn(...)`（禁工具头 + 9 段 `$Hg` + `hHu` REMINDER 结尾）
- canUseTool：`AXi()` 全 deny
- maxTurns：`1`
- 断路器：`qHu=3`
- reactive 重试（partial 路径）：`THu=3`

### 7.2 触发前的消息历史（9 个 group）

用户让 CC 重构项目，对话走到 G9。按 `xXt`(`message.id` 变化切分)：

```
G0  [user] 帮我重构 auth 模块，按新规范改
G1  [assistant#a1] (tool_use: Read auth.js)
    [tool] <persisted-output>...auth.js 预览(原 60k,已被 L1 预览化)...</persisted-output>
    [assistant#a1] line 45 的问题
G2  [assistant#a2] (tool_use: Edit auth.js line45)
    [tool] 修改成功
G3  [assistant#a3] (tool_use: Read login.js)
    [tool] <persisted-output>...login.js 预览(原 80k)...</persisted-output>
    [assistant#a3] (tool_use: Grep "session")
    [tool] login.js:12: session = ...
G4  [user] 把 session 也一起改了
G5  [assistant#a4] (tool_use: Edit login.js)
    [tool] 修改成功
G6  [assistant#a5] (tool_use: Bash "cat logs/app.log | tail")
    [tool] <persisted-output>...日志预览(原 120k,被 L1 预览化)...</persisted-output>
G7  [assistant#a6] (tool_use: Read test.js)
    [tool] test.js 内容(8k,未超 L1)
    [assistant#a6] 我补几个测试用例
G8  [assistant#a7] (tool_use: Edit test.js)
    [tool] 修改成功
    [assistant#a7] 已补全
G9  [user] 跑下测试看看   ← 最近
```

此刻累计 token ≈ 185k > ~180k 阈值。

### 7.3 第 0 步：触发检测（循环内、LLM 前）

`iSY` while 顶部 / `VXi` generator：

```
vDg(messages, model, autoCompactWindow, ...):
  i = xv(e, Sw(t)) - o        // 当前估算 ~185k tok - snipFreed
  s = dLe(i, t, r)             // level
  return s.level === "compact" // true → 触发 L4
```

→ 进入 `VXi`，判定走 reactive 路径（阈值触发）。

### 7.4 第 1 步：切 group（`Z6r` → `xXt`）

```
groups = [G0,G1,G2,G3,G4,G5,G6,G7,G8,G9]   o = 10
```

### 7.5 第 2 步：PreCompact hook（`kge`）

```
kge({trigger:"auto", customInstructions:null}, signal)
→ {userDisplayMessage, blockedBy:undefined}   // 未阻塞
→ customInstructions = null（本例无）
```

elf-002 无 hooks，此步 no-op。

### 7.6 第 3 步：reactive 二分试探（`neo`）

`s=1`（保留量）、`a=0`（尝试次数）。本例无 `initialTokenGap` 种子，从 s=1 开始。

#### 尝试 1（s=1, a=1）

```
p = o - s = 9
f = n.slice(0,9) = [G0..G8]   // 摘要候选（老）
m = n.slice(9)  = [G9]         // 保留（近期）
g = f.flat()

aDg(g, toolUseContext, null, n=true):
```

**3a. 构造 compactPrompt（`KZn`）**——见 §2.3 / §5.1-5.2，含禁工具头 + 9 段 `$Hg` + `hHu` REMINDER。

**3b. `EXi` media strip（`n=true`）**——G0..G8 里若含 image/document 块 → `[image]`/`[document]`。本例全文本/工具结果，内容不变。

**3c. 真实发给摘要 LLM 的请求**（这就是 §6 的结构）：

```
[
  { role:"system", content:"You are a helpful AI assistant tasked with summarizing conversations." },

  // forkContextMessages (G0..G8, media-stripped)
  { role:"user",      content:"帮我重构 auth 模块，按新规范改" },
  { role:"assistant", content:null, tool_calls:[{id:"t1",function:{name:"Read",arguments:'{"file_path":"auth.js"}'}}] },
  { role:"tool", tool_call_id:"t1", content:"<persisted-output>Output too large (58.6KB)...Preview: const auth=require('express')...</persisted-output>" },
  { role:"assistant", content:"line 45 的问题" },
  { role:"assistant", content:null, tool_calls:[{Edit auth.js line45}] },
  { role:"tool", content:"修改成功" },
  ... G3..G8 同理（大 tool 结果已是 <persisted-output> 预览）...
  { role:"assistant", content:"已补全" },

  // promptMessages (compactPrompt, 本轮 user)
  { role:"user", content:"CRITICAL: Respond with TEXT ONLY...<9段 $Hg>...REMINDER: Do NOT call any tools...(hHu)" }
]

  ★ G9("跑下测试看看") 不在此请求
  ★ canUseTool:AXi() → 工具调用全 deny；maxTurns:1
  ★ thinkingConfig = Y6r(主会话)（maxThinkingTokens=0 则 disabled）
  ★ enablePromptCaching:false, querySource:"compact", forkLabel:"reactive-compact"
```

**3d. 摘要 LLM 返回**（典型响应）：

```
"<analysis>
1. 用户要重构 auth 模块、顺带 session...
2. 读了 auth.js (L1 预览)、改了 line45...
3. 读了 login.js (L1 预览)、改了 session...
4. cat 了日志、补了 test.js 测试...
</analysis>
<summary>
1. Primary Request and Intent: 重构 auth 模块、按新规范改 session...
2. Key Technical Concepts: L1 <persisted-output> 预览化...
3. Files and Code Sections: auth.js (line45)、login.js (session)、test.js (补测试)...
4. Errors and fixes: ...
5. Problem Solving: ...
6. All user messages: "帮我重构 auth 模块..." / "把 session 也一起改了" / ...
7. Pending Tasks: 跑测试验证...
8. Current Work: 刚补全 test.js 测试用例，准备跑测试...
9. Optional Next Step: 运行测试。
</summary>"
```

**3e. 解析（`qHg`/`wJ`）**：

```
去 <analysis>...</analysis> → 提 <summary> 内容 → 加 "Summary:\n" 前缀
H = "Summary:\n1. Primary Request and Intent: ...\n...9. Optional Next Step: 运行测试。"
H.startsWith(r6)  // r6="Summary:" → true，有效
```

→ `aDg` 返回 `{ok:true, summaryText:H, messages:[Br({content:z6r(H,{suppressFollowUpQuestions:true,transcriptPath,replStateCleared}), isCompactSummary:true, isVisibleInTranscriptOnly:true}]}`

> **reactive 路径 `suppressFollowUpQuestions:true` → 不追加续写指令**（保留近期 G9、模型本就在续）。续写指令仅全量自动路径追加。

**3f. `neo` 包装返回**：

```js
return { ok:true, result:{
  summaryMessages: [摘要user消息("This session is being continued...\n\nSummary:\n...G0..G8 摘要...")],
  summaryText: H,
  messagesToPreserve: [G9 原文],   // {user:"跑下测试看看"}
  attempt:1, groupsPreserved:1, totalGroups:10,
  totalUsage: {input_tokens, output_tokens, cache_read_input_tokens, ...}
}}
```

→ **一次成功，循环结束**（不必到尝试 2）。

### 7.7 第 4 步：构造 boundary marker（`Q6r`）

```
U = Q6r("auto", preTokens=185000, anchorUuid=<G8 末 assistant uuid>, userContext=null, messagesSummarized=9)
U.compactMetadata = {trigger:"auto", preTokens:185000, messagesSummarized:9, durationMs:<耗时>, postTokens:<压缩后>}
// U = {type:"system", subtype:"compact_boundary", content:"Conversation compacted (...)", compactMetadata:{...}}
```

### 7.8 第 5 步：PostCompact hook + 附件重建（`eeo`）

```
eeo(readFileState, context, appState, "compact_partial"):
  → memory restore / invoked_skills / plan_file_reference / task_status 重建（按配置）
  → 产出 attachments:[]
→ PostCompact hook 运行
```

elf-002 无这些，no-op。

### 7.9 第 6 步：拼最终 history（`HH`）

```
最终 messages:
[
  { compact_boundary marker (U) },
  { role:"user",
    content:"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent: 重构 auth...\n...9. Optional Next Step: 运行测试。\n\nIf you need specific details...read the full transcript at: <path>",
    isCompactSummary:true },
  { role:"user", content:"跑下测试看看" }   // G9 原样保留（messagesToPreserve）
]
```

→ token **从 ~185k 降到 ~15k**（摘要数 k + G9 极小 + boundary）。

### 7.10 第 7 步：回到 Agent Loop，正常 LLM 调用

压缩完毕，循环继续、调正常 LLM：

```
[
  { role:"system", content:<正常 system_prompt.md> },   // ← 恢复正常 system（非 compact system）
  { role:"user",   content:"This session is being continued...\n\nSummary:\n...\nIf you need specific details...transcript at: <path>" },
  { role:"user",   content:"跑下测试看看" }              // G9 原文
]
```

模型看到：远期靠摘要、近期靠 G9 原文 → 续上"跑下测试"，调 Bash 跑测试。

### 7.11 关键时序一图

```
每轮循环顶部:
  ① L2 budget 检查（getMessagesForLLM 内）        ← 先跑，管单轮 tool 结果体积
  ② L4 autocompact 检查（VXi）                    ← 触发！
       ├─ PreCompact hook (kge)
       ├─ Z6r 切 group
       ├─ neo 二分试探（s=1 起步）
       │     └─ aDg → z$: [compact system + 老 group + compactPrompt] 发摘要 LLM
       │           canUseTool deny / maxTurns 1 / thinking 看配置
       │           ★ 近期 s 个 group 不进这个请求
       ├─ 摘要成功 → qHg/wJ 解析 <analysis>/<summary> → z6r 包装
       ├─ Q6r 造 boundary
       ├─ PostCompact hook + eeo 附件重建
       └─ HH 拼 [boundary, 摘要, 近期 group 原文]
  ③ getMessagesForLLM + callModel                 ← 压缩后才调正常 LLM（恢复正常 system）
  ④ 工具执行 → 回 ①
```

### 7.12 为什么这个设计 work（4 点）

1. **摘要只送老历史、不送近期**：摘要 LLM 专注"将被丢弃的部分"；近期保留区原文不参与摘要、直接留最终 history。下轮模型看"摘要+近期原文"，远期靠摘要、近期靠原文，无缝衔接。
2. **大 tool 结果已被 L1/L2 预览化**：摘要请求里 60k/80k/120k 字符结果都已是 ~2k 预览——摘要请求体积可控、不会自己也爆窗口。
3. **二分试探保成功**：s=1 先试最激进（压最狠），装不下就加保留量；`gap_guided` 按 LLM 返回 token 差精确算下一 step，通常 1-2 次成功。
4. **断路器 + 续写指令的路径区分**：连续 3 次失败（`qHu=3`）禁用避免死循环；续写指令仅全量自动路径追加（reactive 保留近期、模型本就在续，不追加）。
