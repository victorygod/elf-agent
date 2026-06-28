# Elf-002 分级上下文压缩方案

## 目标

为 elf-002 实现三层上下文压缩，对齐 Claude Code 的有效机制（第 1/2/4 层），解决现有压缩的两个核心问题：工具结果无限膨胀、摘要无结构丢失信息。

不做：图片/文档替换（第 3 层是空操作）、阻塞硬限制（第 5 层）、近期消息保留（Claude Code 全量替换，不保留近期）。

---

## 关键设计决策（对齐 Claude Code 源码）

| # | 决策 | Claude Code 源码依据 | elf-002 方案 |
|---|---|---|---|
| 1 | 单工具超限 → 磁盘持久化 + 引用替换 | `Xq4` + `CX1` + `IX1`：写入 `tool-results/<id>.txt`，消息替换为 `<persisted-output>` 标签 | 相同策略，存 `<dataDir>/tool-results/<toolCallId>.txt` |
| 2 | 持久化后只保留开头预览 | `iv8`：取前 2000 字符，后 50% 有换行则在换行处截断；`IX1`：`Preview (first 2KB):` + 内容 + `...` | 相同，`previewLength=2000`，换行截断逻辑一致 |
| 3 | 跨消息预算淘汰最大的 | `wh9`：`sort((a,b) => b.size - a.size)` 降序，贪心淘汰最大 | 相同策略 |
| 4 | fresh/frozen/mustReapply 三态 | `_h9`：fresh 可淘汰，frozen 不可淘汰，mustReapply 重新应用已有替换 | 相同三态；mustReapply 即 content 已是替换后字符串，直接保留 |
| 5 | 第 4 层全量替换，不保留近期 | `sZ6` → `gc(boundaryMarker, summaryMessages)`：压缩后 `[boundary, summaryUser]` | 相同，压缩后 `[摘要user消息]`，不需要 boundary（elf-002 无近期保留） |
| 6 | 摘要是 user 消息，无 assistant 回复 | `gc` 返回 `summaryMessages = [p1({content: oF6(...), isCompactSummary: true})]`，类型是 user | 相同，`{ role: "user", content: "This session is being continued..." }` |
| 7 | 摘要 system prompt 是专用的 | `QAq` 中 `systemPrompt: gq(["You are a helpful AI assistant tasked with summarizing conversations."])` | 相同，见下方「两个 Prompt 文件」章节 |
| 8 | `<analysis>` 删除，只保留 `<summary>` | `lL9`：去掉 `<analysis>` 标签，提取 `<summary>` 内容替换为 `Summary:\n` 前缀 | 相同，`_parseSummaryResponse()` |
| 9 | 摘要包装为延续性文本 | `oF6`："This session is being continued from a previous conversation..." + `Summary:\n` + 内容 | 相同，英文原文 "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n" + 内容 |
| 10 | 摘要 prompt 先 `<analysis>` 再 `<summary>` | `dL9` + `pL9`：analysis 是 scratchpad，summary 是正式输出 + 末尾 `IMPORTANT: Do NOT use any tools` | 相同，**直接用 Claude Code 英文原文，不意译** |
| 11 | 每次压缩用同一 prompt，无 partial | `sZ6` 永远用 `C44(dL9)`；`FAq(S44(cL9))` 仅手动保留触发 | 相同，删掉 `partialCompactPrompt`，自动压缩永远用 `compactPrompt` |
| 12 | 断路器 | 连续压缩失败检测，禁用自动压缩 | 相同，`_compactFailCount >= 3`，**进程内状态、不持久化**（重启清零，避免改配置后仍被历史失败卡死） |
| 13 | 持久化文件清理 | `Bjz` 30 天 age-based 扫描，但 walker 跳过扁平文件 → 实际泄漏 | **优于 Claude Code**：摘要成功后清空 tool-results/（孤儿即删），不做 30 天兜底（与摘要清空冗余） |
| 14 | 摘要调用禁用 thinking | `QAq` 中 `thinkingConfig: {type: "disabled"}` | 相同，`compactIfNeeded` 调 `chat` 时传 `{ enable_thinking: false }` 覆盖 `extraParams`（`_body` 中 options 后置覆盖 extraParams，见 `llm_model.js:59`） |
| 15 | 持久化状态判别 | `replacements` 纯内存 map，重启从 transcript 重建 | **简化**：不维护 replacements map，直接判 `content.startsWith('<persisted-output>')`。因 context.json = 内存镜像，content 字符串本身就是最准确的状态标记，无需额外记账本 |
| 16 | 阈值参数有代码默认值 | `$q4`/`SX1`/`jq4` 为源码常量 | 阈值参数（`perToolLimit`/`previewLength`/`budgetWindow`）`config.get()` 返回 undefined 时代码兜底（50000/2000/200000），配置覆盖默认值。**注意：prompt 文件不在其列——prompt 内容即文件内容，无退化、无代码默认值** |

---

## 第 1 层：单工具结果持久化

**触发**：`addToolResult()` 写入前，`result.length > perToolLimit(50000)`
**行为**：完整内容 → 磁盘文件，消息 content → `<persisted-output>` 引用 + 开头 2000 字符预览

### 参数

| 参数 | 值 | Claude Code 对应 |
|---|---|---|
| `perToolLimit` | 50,000 字符 | `$q4 = 50000` |
| `previewLength` | 2,000 字符 | `SX1 = 2000` |

### 持久化路径

`<dataDir>/tool-results/<toolCallId>.txt`

- 完整路径：`agents/elf-002/data/tool-results/<toolCallId>.txt`，与 `context.json` 同级的 `data/` 目录下（`dataDir` 由 `default_agent.js:81` 定义为 `configDir/../data`）
- 命名：直接用 `toolCallId` 当文件名（对齐 Claude Code `lv8()`），无 hash、无 uuid
- 不需要 `toolName`：持久化只用 `toolCallId`（文件名、判重）；前端展示的 toolName 已在 `default_agent.js` 别处处理，与持久化解耦

### `<persisted-output>` 格式（对齐 Claude Code `IX1`，英文，不本地化）

```
<persisted-output>
Output too large (XX.XKB). Full output saved to: <filepath>

Preview (first 2.0KB):
<前2000字符，换行处截断>
...
</persisted-output>
```

### Preview 提取逻辑（对齐 `iv8`）

取前 `previewLength` 字符；如果在该范围内有换行符且位于后 50% 区域，在换行处截断（保持行完整性）；否则硬切。

---

## 第 2 层：跨消息预算窗口

**触发**：在 `getMessagesForLLM()` **内部**，按 assistant turn 分 group，当某个 group 内 `fresh 总量 + frozen 总量 > budgetWindow(200000)` 时淘汰该 group 最大的 fresh。**注意是「group 内」而非「累计」**——Claude Code `wh9` 也是按 turn group 算（每轮请求独立判断），不是历史累计。这是第 1 层（单条 50k）之外的「单次请求内多条工具结果合计超限」保护，触发条件比第 4 层（累计 160k 字符摘要）窄。

**行为**：淘汰体积最大的 fresh 工具结果 → 持久化到磁盘 → content 改写为 `<persisted-output>`

### 参数

| 参数 | 值 | Claude Code 对应 |
|---|---|---|
| `budgetWindow` | 200,000 字符 | `jq4 = 200000` |

### 三态分类

| 状态 | 含义 | 可淘汰 |
|---|---|---|
| `fresh` | 当前 group 新出现的、未持久化的 tool_result（content 非 `<persisted-output>`） | ✅ |
| `frozen` | 之前 group 通过预算的 tool_result | ❌ |
| `mustReapply` | content 已是 `<persisted-output>`（判 `content.startsWith('<persisted-output>')`） | N/A（直接保留替换后内容） |

### 淘汰算法（对齐 `wh9`）

1. fresh 结果按体积降序排列
2. 贪心淘汰最大的，直到该 group 总量 ≤ budgetWindow
3. 逐一持久化 + content 改写为 `<persisted-output>` 并 `_save()` 落盘
4. 未淘汰的 fresh → frozen

### 持久化状态判别（context.json = 内存镜像，content 即状态）

**核心规则：`context.json` 永远是内存 `this.messages` 的完整镜像。** 持久化模型维持全量 overwrite（现状），每次 `addToolResult`/`_persistToolResult`/`compactIfNeeded` 改了内存就立刻 `_save()` 全量落盘。

- **持久化时**（第 1/2 层）：tool 消息的 `content` 在内存里**改写**为 `<persisted-output>` 字符串，随即 `_save()` 全量写回 context.json（写回的就是替换后字符串）。
- **状态判别无 map**：判「这条 tool 是否已持久化」「第 2 层三态里的 mustReapply」时，**直接判 `content.startsWith('<persisted-output>')`**——不维护任何 replacements 内存 map。因为 content 字符串本身就是最准确的状态标记（已是镜像，落盘即同形）。
- **getMessagesForLLM**：直接返回 `this.messages`（tool 消息 content 已是替换后或原始，按需），**无需临时套用、无 mustReapply 重做**。
- **重启加载**：`_load()` 把 context.json 读回 `this.messages` 即可，**不做任何重建**（content 已是镜像，状态直接读字符串前缀判得）。

> 相比 Claude Code：它维护纯内存 `replacements` map 且重启从 transcript 日志重建，是因为它的消息历史与 LLM 输入有分离、需要额外记账。elf-002 的 context.json = 镜像，content 字符串自身就承载了状态，省掉 map 和重建逻辑——这是结构简化，不是缺失。

> 因为 context.json 始终是镜像，所以**不存在「旧 context.json 兼容」这个概念**。改造上线时直接清空旧聊天历史（旧 context.json 不做迁移），新会话从空 messages 起步，此后永远镜像。

### 持久化文件清理（修正 Claude Code 的泄漏问题）

> Claude Code 有 30 天 age-based 清理（`Bjz`，启动时跑，`cleanupPeriodDays` 默认 30），但**实际对工具结果文件不生效**——其 walker 在 `tool-results/` 层只递归子目录、跳过扁平 `.txt`/`.json`，而 `CX1` 写的恰是扁平文件 → **Claude Code 的工具结果文件基本永久泄漏**。

elf-002 有一个 Claude Code 没有的结构优势：**第 4 层摘要全量替换 messages，所有 `<persisted-output>` 引用消息都被摘要消灭，引用的 tool-results 文件瞬间变孤儿**。据此设计清理：

| 时机 | 动作 | 理由 |
|---|---|---|
| 持久化时 | 写 `<dataDir>/tool-results/<toolCallId>.txt` | 正常生成 |
| 第 4 层摘要**成功**后 | **清空 `tool-results/` 目录全部文件** | 摘要消灭了所有 `<persisted-output>` 引用，文件变孤儿，这是唯一确定的安全清理点（无 map 需清，状态全在 content 里） |

不做 30 天兜底扫描：摘要清空与 30 天扫描冗余，且第 4 层每轮 Agent Loop 内都会检查触发，崩残留概率低；保持单点清理最简单。

实现要点：
- 第 4 层 `compactIfNeeded()` 第 6 步「替换消息」之后：先 `_save()`（context.json 落盘新 messages），再 `_cleanupToolResults()`：`fs.rm(tool-results/, { recursive, force })` 后重建空目录。顺序不可颠倒。无 map 需清。
- 清理**只在摘要成功后**执行——摘要失败走断路器，保留 messages 和文件不动（用户可重新触发）。
- context.json 为真相源、tool-results 为其附属文件：有 `<persisted-output>` 引用消息在 → 文件在；引用被摘要消灭 → 文件即删。零孤儿。

---

## 第 4 层：结构化摘要压缩

**触发**：Agent Loop **内部**，每次 LLM 调用前检查 `estimateTokens() > memoryTokenLimit`（对齐 Claude Code `iSY` 的 `while` 顶部 autocompact，在 `callModel` 之前）。超阈值则在该轮 LLM 调用前先摘要压缩，避免长任务工具链中途撑爆上下文窗口。循环结束后再做一次兜底压缩（防止最后一轮 break 时刚累积的消息超限却没压）。
**行为**：全量替换所有消息为 1 条摘要 user 消息

> **阈值量级**：`memoryTokenLimit` 必须与第 2 层 `budgetWindow`（200000 字符 ≈ 50k tokens）同量级，否则第 2 层成为死代码（第 4 层先触发全量摘要，消息总量到不了 budgetWindow）。`memoryTokenLimit` 默认调到 **40000**（≈160k 字符），使三层阈值递进：单工具 50k 字符 → 第 1 层；单请求 200k 字符 → 第 2 层；累计 160k 字符 → 第 4 层摘要。
>
> **estimateTokens 含 systemPrompt**：现有 `estimateTokens()` 用 `getMessagesForLLM()`（含 `[system, ...messages]`），systemPrompt 计入阈值。触发阈值含 systemPrompt，但摘要请求用的 system 是 COMPACT_SYSTEM_PROMPT（短得多）——两者体积不一致属正常，不影响正确性。
>
> **estimateTokens 不得有 budget 副作用**：第 2 层 budget 强制嵌在 `getMessagesForLLM()` 内，但 `estimateTokens()` 频繁被调用（触发检测、done 事件），**不能因此触发持久化/改写**。实现时 `estimateTokens()` 直接读 `this.messages` + systemPrompt 长度做纯计算，**不调 `getMessagesForLLM()`**；budget 副作用只在「真正要发给 LLM」的 `getMessagesForLLM()` 路径触发。

### 两个 Prompt 文件

压缩涉及 2 个 prompt，全部通过 `config.json` 指向 md 文件，与 `systemPrompt` 采用相同的 `type: "path"` 机制。**没有代码默认值，配置即内容。**

每次压缩（包括二次压缩）都用同一个 `compactPrompt`，不需要单独的 partial prompt。Claude Code 的 partial compact（`cL9`/`S44`/`FAq`）仅在用户手动选择保留部分消息时触发，自动压缩永远走全量路径（`dL9`/`C44`/`sZ6`）。二次压缩时，messages 里只有上次的摘要 user 消息，LLM 看到的输入是 `[摘要, 新对话...]` + `compactPrompt`，自然会基于已有摘要补充新内容，不需要换 prompt、不需要 boundary 标记。

| 场景 | config.json 字段 | 指向文件 | 用途 |
|---|---|---|---|
| **正常运行** | `systemPrompt` | `system_prompt.md` | 驱动 Agent 行为 |
| **压缩时 system** | `compactSystemPrompt` | `compact_system_prompt.md` | 摘要时的 system prompt，专注摘要生成 |
| **压缩时 user** | `compactPrompt` | `compact_prompt.md` | 摘要时的 user prompt，9 段结构化模板（每次压缩都用这个） |

> **Claude Code 的正常运行 system prompt** 由大量片段动态拼装：身份声明（`A21`："You are Claude Code, Anthropic's official CLI for Claude."）+ System 规则（`y8z`）+ Doing tasks（`L8z`）+ Executing actions with care（`R8z`）+ Using tools（`h8z`）+ Tone and style（`I8z`）+ Dynamic 环境信息（`ec6`），通过 `sM()` → `ec6()` → `Mh()` 链式组装。elf-002 用单文件简化版等价。

> **`system_prompt.md` 用英文**，以 Claude Code 英文原文为底（措辞精准），做 elf-002 本地化裁剪：身份改为「You are elf-002, a coding agent」；删掉 elf-002 无机制的 hooks 条、权限模式条、`/help` 反馈条；压缩条措辞改为「when memory exceeds its limit」（对应 `memoryTokenLimit` 触发）；受阻条「Ask tool」改为「ask the user」（无 Ask 工具）；保留 URL 警告。三个 prompt 文件（`system_prompt.md` / `compact_system_prompt.md` / `compact_prompt.md`）统一英文。

config.json 示例：

```json
{
  "agentId": "elf-002",
  "systemPrompt": { "type": "path", "content": "system_prompt.md" },
  "compactSystemPrompt": { "type": "path", "content": "compact_system_prompt.md" },
  "compactPrompt": { "type": "path", "content": "compact_prompt.md" },
  "memoryTokenLimit": 40000,
  "perToolLimit": 50000,
  "previewLength": 2000,
  "budgetWindow": 200000,
  ...
}
```

对应 md 文件内容：

**`compact_system_prompt.md`**（对齐 Claude Code `QAq` 中的 `systemPrompt`）：

```markdown
You are a helpful AI assistant tasked with summarizing conversations.
```

**`compact_prompt.md`**（完整压缩 prompt，对齐 Claude Code 当前源码 `dL9` + `pL9` + `C44` 拼装结果。已去掉 CC 动态注入"额外 compact 指令"的相关段落——elf-002 无此机制）：

```markdown
Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

IMPORTANT: Do NOT use any tools. You MUST respond with ONLY the <summary>...</summary> block as your text output.
```

### 压缩流程（对齐 Claude Code `sZ6` + `QAq`）

```
1. 检测是否需要压缩
   estimateTokens() > memoryTokenLimit → 触发

2. 构建摘要请求（system prompt 用摘要专用的，不含原始 system_prompt.md）
   ⚠️ 直接读 this.messages 手拼，不走 getMessagesForLLM()——
      后者内嵌第 2 层 budget 强制，会误把待摘要的大工具结果替换成预览、丢信息
   system = { role: "system", content: COMPACT_SYSTEM_PROMPT }
   messages = [system, ...this.messages.map(m=>({...m})), { role: "user", content: COMPACT_PROMPT }]

3. 调用 LLM.chat(messages, { enable_thinking: false })
   ⚠️ 必须传 enable_thinking:false 覆盖 extraParams（对齐 Claude Code thinkConfig disabled）
      chat() 写死 tools=null，天然不带工具；options 在 _body 中后置覆盖 extraParams

4. 解析回复（对齐 lL9）
   去 <analysis> → 提取 <summary> 内容 → 替换为 "Summary:\n" 前缀

5. 包装摘要（对齐 oF6）
   "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n" + summary

6. 替换消息 + 落盘事务（context.json 为真相源，先落盘再删文件）
   this.messages = [{ role: "user", content: wrappedSummary, isCompactSummary: true }]
   _save()                          ← 先把新 messages（只剩摘要、无 persisted-output 引用）落盘 context.json
   _cleanupToolResults()            ← 再清空 <dataDir>/tool-results/ 目录（context.json 已无引用，文件可安全删）
   顺序必须 _save 先、_cleanup 后：即使删文件失败，context.json 已干净（文件残留但无引用，下次可清）；反过来才会产生「引用在文件没了」的真正损坏

7. 仍超阈值 → 再次触发 compactIfNeeded（断路器 3 次保护）
   二次压缩时输入只有 [摘要user消息]，LLM 基于已有摘要生成新摘要
```

### 期望行为效果（务必满足）

> 实现时按此节自检，每条都要对。

**1. COMPACT_SYSTEM_PROMPT 是临时的，绝不持久化**
- `this.systemPrompt` 字段**全程不变**，始终是 `system_prompt.md` 的内容。
- COMPACT_SYSTEM_PROMPT 只在第 2 步构建摘要请求时临时拼进去，调用完即弃，不写回 `this.messages`、不写回 `context.json`。
- 自检：压缩前后 `this.systemPrompt` 严格相等；`getMessagesForLLM()` 在压缩后拼出的 system 消息仍是正常的 system_prompt.md。

**2. 摘要请求是一次性独立调用**
- 第 2 步拼出的 `messages`（含 COMPACT_SYSTEM_PROMPT + 全部历史 + COMPACT_PROMPT）**只传给 LLM 做一次摘要**，结果解析后这些 messages 全部丢弃。
- 不能把 COMPACT_SYSTEM_PROMPT 或 COMPACT_PROMPT 写进 `this.messages`。

**3. LLM 应产出 `<analysis>` + `<summary>` 两段**
- `<analysis>...</analysis>`：LLM 的思考草稿，解析时整体删除，不保留。
- `<summary>...</summary>`：正式摘要，解析时提取其内部内容，加 `"Summary:\n"` 前缀。
- 自检：最终存入 `this.messages` 的 content **不含任何 `<analysis>`、`<summary>` 标签**，只保留 `Summary:\n` + 纯文本。

**4. 压缩后 `this.messages` 全量清空，只剩一条 user 消息**
- 原来的 user/assistant/tool 消息**全部丢弃**，不保留任何近期原始消息。
- 只剩一条 `{ role: "user", content: wrappedSummary, isCompactSummary: true }`。
- 自检：压缩后 `this.messages.length === 1`，且 `messages[0].role === "user"`，且 `messages[0].isCompactSummary === true`。

**5. 摘要是 user 消息，不是 assistant 消息**
- 虽然 LLM 回复时角色是 assistant，但解析包装后存入历史的是 **user 角色**（对齐 Claude Code `p1({isCompactSummary: true})`）。
- 自检：压缩后没有 `{ role: "assistant" }` 消息紧跟着摘要。

**6. 包装前缀固定（对齐 `oF6`）**
- content 以 `"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n"` 开头，**一字不差**，不意译、不本地化。
- 这条 user 消息在最新请求里是"延续上文"的语义，告诉 LLM 这是一个被摘要过的会话。

**7. 压缩后下一次正常对话的请求结构**
- `getMessagesForLLM()` 自动拼出（注意 system 来自 `this.systemPrompt`，不是 messages 里）：
  ```
  [
    { role: "system", content: this.systemPrompt },        ← 正常 system_prompt.md（从没变过）
    { role: "user",  content: wrappedSummary },            ← 摘要，在 system 下面
    { role: "user",  content: <用户新消息> }                ← 用户继续的对话
  ]
  ```
- 摘要 user 消息确实"在 system prompt 下面"，符合预期。

**8. 二次压缩**
- 触发后 messages 里已有 `[摘要user消息, 新对话...]`，第 2 步把它们连同 COMPACT_PROMPT 一起发给 LLM。
- LLM 看到已有摘要，自然在其基础上补充新内容；再次清空、再留一条包装摘要。
- 不换 prompt（仍用 COMPACT_PROMPT）、不存 boundary 标记。

**9. 断路器**
- 连续压缩失败（LLM 调用抛错或解析结果为空）≥ 3 次 → 禁用自动压缩，保留当前消息不动，避免无限重试。
- 断路器计数是**进程内状态、不持久化**：重启清零。避免用户改配置/换模型想重试却被历史失败次数卡死。
- 自检：重启后 `_compactFailCount === 0`。

**10. 摘要调用禁用 thinking + 不带工具**
- 第 3 步调 `chat(messages, { enable_thinking: false })`，覆盖 `extraParams` 里可能的 thinking 配置（对齐 Claude Code `thinkingConfig disabled`）。
- `chat()` 写死 `tools=null`，摘要请求天然不带任何工具（对齐 Claude Code 摘要只用 Read）。
- 自检：摘要请求 body 不含 `tools` 字段，`enable_thinking` 为 false（或模型等价禁用项）。

**11. 摘要成功后清理孤儿文件**
- 第 6 步只在摘要解析成功后执行清理；失败走断路器时不清理（保留 messages 和文件，用户可重试）。
- 清空 `<dataDir>/tool-results/` 全部文件，保证 context.json 与 tool-results 状态一致：有 `<persisted-output>` 引用消息在 → 文件在；引用被摘要消灭 → 文件即删。
- 自检：压缩成功后 `data/tool-results/` 目录为空（或不存在）；压缩失败（断路器触发）时文件不动。

**12. 摘要请求不走 getMessagesForLLM**
- 第 2 步直接 `this.messages.map(m=>({...m}))` 手拼，**不调** `getMessagesForLLM()`——后者内嵌第 2 层 budget 强制，会误替换待摘要的大工具结果。
- 自检：摘要请求的 tool 消息 content 是 messages 里现存内容（原始完整或已是 `<persisted-output>` 串），未被 budget 二次截断。

### 压缩后消息结构

```javascript
this.messages = [
  { role: "user", content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n   ...\n2. Key Technical Concepts:\n   ...", isCompactSummary: true }
]
// 无 assistant 回复，无近期保留，无 compact_boundary
```

### 摘要包装前缀（对齐 `oF6`）

解析后的摘要文本在存入消息前，需加前缀：

```
This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
<解析后的摘要内容>
```

### 摘要解析逻辑（对齐 `lL9`）

```javascript
_parseSummaryResponse(response) {
  let text = response;
  // 1. 去掉 <analysis>...</analysis>
  text = text.replace(/<analysis>[\s\S]*?<\/analysis>/, '');
  // 2. 提取 <summary>...</summary> 内容
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    const summaryContent = summaryMatch[1] || '';
    text = `Summary:\n${summaryContent.trim()}`;
  }
  // 3. 压缩多余空行
  text = text.replace(/\n\n+/g, '\n\n').trim();
  return text.length > 0 ? text : null;
}
```

### 二次压缩

压缩后仍超阈值 → 再次压缩，仍用 `config.compactPrompt`。此时 messages 里只有 `[摘要user消息]`，LLM 基于已有摘要生成新摘要，不需要换 prompt，也不需要 boundary 标记。断路器 3 次连续失败后禁用自动压缩。

---

## 参数汇总

所有阈值参数：代码有默认值兜底，`config.json` 配置则覆盖默认值（`config.get()` 返回 undefined 时用默认值）。

| 参数 | 默认值 | 层 | 来源 |
|---|---|---|---|
| `perToolLimit` | 50,000 字符 | 1 | Claude Code `$q4` |
| `previewLength` | 2,000 字符 | 1/2 | Claude Code `SX1` |
| `budgetWindow` | 200,000 字符 | 2 | Claude Code `jq4` |
| `memoryTokenLimit` | **40,000 tokens**（≈160k 字符，须与 budgetWindow 同量级，否则第 2 层成死代码） | 4 | 现有配置调大 |
| `compactSystemPrompt` | `{ "type": "path", "content": "compact_system_prompt.md" }` | 4 | config.json，`type: "path"` 指向 md 文件，文件内容即内容、无代码默认值 |
| `compactPrompt` | `{ "type": "path", "content": "compact_prompt.md" }` | 4 | config.json，`type: "path"` 指向 md 文件，文件内容即内容、无代码默认值 |
| 断路器阈值 | 3 次 | 4 | 硬编码 |
| 摘要调用 thinking | 禁用（`enable_thinking: false`） | 4 | 硬编码，`compactIfNeeded` 传 options 覆盖 |

---

## 热更新范围

`shared/agent/start.js` 用 `fs.watch(configDir)` 监听 Agent 配置目录变化 → 触发 `agent.reloadConfig()`（`default_agent.js:171`）。reloadConfig 重读 config.json + 重建 model + 调 `messageManager.updateConfig({ systemPrompt, memoryTokenLimit })`；elf-002 子类的 `updateConfig` override 会从 config 重读所有压缩阈值/prompt。因此**改完配置下一轮对话即生效**的有：

| 配置 | 热更新 | 说明 |
|---|---|---|
| `systemPrompt`（含 system_prompt.md 内容） | ✅ 下一轮 | updateConfig 更新 |
| `memoryTokenLimit` | ✅ 下一轮 | updateConfig 更新 |
| `perToolLimit` / `previewLength` / `budgetWindow` | ✅ 下一轮 | 子类 updateConfig override 重读 |
| `compactSystemPrompt` / `compactPrompt`（含 md 内容） | ✅ 下一轮 | 子类 updateConfig override 重读 |
| `model` 连接配置（api_key.json） | ✅ 下一轮 | reloadConfig 重建 model |
| `tools`（工具列表） | ❌ 需重启 | ToolRegistry 仅启动时注册，reloadConfig 不重建 |
| `messageManagerClass` | ❌ 需重启 | MM 实例不重建，换类无效 |
| `agentClass` | ❌ 需重启 | Agent 实例不重建 |

> prompt 的 md 文件也在 configDir 内，改 md 同样触发 reloadConfig → 重读 → 下一轮生效。
> ⚠️ macOS 的 fs.watch（FSEvents）对"写临时文件→rename 覆盖"的编辑器保存方式可能漏触发；若改配置未生效，重启或 `touch` 一下 config.json。

---

## 修改文件

**shared 一行不动**——全部改造通过 elf-002 自己的子类实现（沿用 elf-001 的继承模式）：`config.json` 声明 `messageManagerClass` + `agentClass`，`message_manager.js` 继承基类 override 压缩逻辑，`agent.js` 继承基类 override `reasoning()` 把压缩移到循环内。

| 文件 | 改动 |
|---|---|
| `agents/elf-002/message_manager.js`（新建） | 继承 `BaseMessageManager`，override `addToolResult`/`getMessagesForLLM`/`estimateTokens`/`compactIfNeeded`，新增第 1/2/4 层逻辑 + 持久化工具方法 + 摘要解析 + `_cleanupToolResults()`。用基类原签名（`addToolResult(toolCallId, content)`，不引入 toolName）|
| `agents/elf-002/agent.js`（新建） | 继承 `BaseAgent`，override `reasoning()`：把 `compactIfNeeded` 从循环后移到循环内、每次 `getMessagesForLLM` 之前（对齐 Claude Code `iSY` 循环顶部 autocompact）；循环后保留一次兜底压缩 |
| `agents/elf-002/config/config.json` | 新增 `messageManagerClass: "message_manager"`、`agentClass: "agent"`、`perToolLimit`、`previewLength`、`budgetWindow`、`compactSystemPrompt`、`compactPrompt`；`memoryTokenLimit` 调为 40000 |
| `agents/elf-002/config/system_prompt.md`（改内容，文件原有） | 改为英文版，以 Claude Code 英文原文为底 + elf-002 本地化裁剪（见「两个 Prompt 文件」章节） |
| `agents/elf-002/config/compact_system_prompt.md`（新建） | 压缩时的 system prompt |
| `agents/elf-002/config/compact_prompt.md`（新建） | 压缩时的 user prompt（每次压缩都用） |

> 不改 `shared/agent/default_agent.js`：`addToolResult(tc.id, result)` 用原签名即可。压缩时机改到循环内需要 override `reasoning()`，故 elf-002 同时声明 `messageManagerClass` 和 `agentClass`（`fromConfigDir` 自动加载 `agents/elf-002/message_manager.js` 与 `agents/elf-002/agent.js`）。

---

## 实现步骤

1. **新建 message_manager 子类**：`agents/elf-002/message_manager.js` 继承 `BaseMessageManager`，override 需改方法；config 加 `messageManagerClass`
2. **新建 agent 子类**：`agents/elf-002/agent.js` 继承 `BaseAgent`，override `reasoning()`——把 `compactIfNeeded` 从循环后移到循环内、每次 `getMessagesForLLM` 之前（对齐 Claude Code `iSY` 循环顶部 autocompact）；保留循环后一次兜底压缩；config 加 `agentClass`
3. 持久化工具方法（子类私有）：`_ensureToolResultsDir()` / `_persistToolResult(toolCallId, content)` / `_extractPreview()` / `_buildPersistedOutput()` / `_formatSize()` / `_cleanupToolResults()`
4. **持久化状态判别 + context.json 镜像**：持久化时把 tool 消息 `content` **永久改写**为 `<persisted-output>` 并立刻 `_save()` 全量落盘（context.json = 内存镜像，无形态差异）；**不维护 replacements map**，判「是否已持久化/mustReapply」直接用 `content.startsWith('<persisted-output>')`；`_load()` 只读 messages，**不做任何重建**
5. 第 1 层：override `addToolResult(toolCallId, content)`（基类原签名，不引入 toolName），超限（>perToolLimit，默认 50000，config 覆盖）持久化 + 改写 content 为 `<persisted-output>` + `_save()`
6. 第 2 层：override `getMessagesForLLM()`，内部先跑 `_enforceBudgetWindow()`（按 turn group，fresh 总量超 budgetWindow 才淘汰最大的 → 持久化 + 改写 + `_save()`）再返回；fresh/frozen/mustReapply 三态靠 `content.startsWith` 判。**override `estimateTokens()` 独立纯计算（直接读 this.messages + systemPrompt 长度），不调 `getMessagesForLLM()`，无 budget 副作用**
7. 第 4 层：override `compactIfNeeded()` 全量替换改造：从 `config` 读 `compactSystemPrompt`/`compactPrompt`（无配置时无默认值，文件即内容）+ **手拼摘要请求（不走 getMessagesForLLM）** + 调 `chat(messages, {enable_thinking:false})` + `_parseSummaryResponse()` 解析 + 摘要成功后**先 `_save()` 再 `_cleanupToolResults()`** + 断路器 `_compactFailCount>=3`（进程内、不持久化）。由 agent 子类在循环内每轮调用
8. `config_loader.js` 无需改（`compactSystemPrompt`/`compactPrompt` 是 `type:"path"` 字段，自动加载）；创建 2 个 md 文件；`config.json` 新增全部参数 + `memoryTokenLimit:40000` + `messageManagerClass` + `agentClass`
9. 测试：
   - 第 1 层：50k 边界、预览换行截断、content 改写并落盘、context.json 镜像一致
   - 第 2 层：三态转换、group 内 fresh 总量超限淘汰最大、estimateTokens 无 budget 副作用
   - 第 4 层：解析 `<analysis>`/`<summary>`、thinking 已禁用、断路器 3 次（重启清零）、清理触发、二次压缩、摘要请求未走 budget、`_save` 先于 `_cleanupToolResults`、**循环内触发**（多轮工具任务中途超限压缩）
   - 持久化：重启加载镜像一致、无 map 重建、`content.startsWith` 判别 mustReapply