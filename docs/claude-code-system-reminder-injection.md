# Claude Code `<system-reminder>` 注入场景清单

> 来源：从 Claude Code CLI 源码（`/Users/wolf/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js`，v2.1.77）追踪整理。
> 用途：理解 Claude Code 何时向消息流注入 `<system-reminder>` 标签，供 elf-002 决定是否引入类似机制时参考。

---

## 注入机制（原理）

- **没有单一入口函数**。核心是分发开关 `cl8(A)`：每种"附件类型"(attachment type)映一个 `case`，产出包好的消息。
- 两套包装器：
  - `qT(text)` → `` `<system-reminder>\n${text}\n</system-reminder>` ``
  - `x5(messages)` → 批量把文本块用 `qT` 包起来
- **存储 vs 发送**：附件先以 `isMeta:true` 存进 transcript（原始内容，不含标签）；发给 LLM 前在规范化阶段（`P64` 管道）才套上 `<system-reminder>` 标签。少数场景由工具直接把标签写进结果（如 Read 的告警）。
- **粘附**（实验开关 `tengu_chair_sermon`）：`tZq` 把 reminder 移到同一条 user 消息里最后一个 `tool_result` 旁边——让提醒"贴着"工具结果。
- **剥离**：正则 `tI9` 和全局替换 `/<system-reminder>[\s\S]*?<\/system-reminder>/g` 是解析/剥离工具，用于持久化干净的 tool_result 内容时去掉标签，不是注入器。
- **system prompt 配套告知**（offset 10321195）：CC 的 system prompt 里那句"工具结果和用户消息可能包含 `<system-reminder>`...它们与所出现的具体工具结果或用户消息没有直接对应关系"——就是配套这 ~20 类注入的告知。

---

## 注入场景全清单（按类别）

### A. 计划模式（plan mode）
- **plan_mode**：进入计划模式。内容"计划模式已激活，用户不想让你执行——禁止编辑/非只读工具..."，列出计划文件路径、允许的工具（AskUserQuestion、计划读写工具）。
- **plan_mode_reentry**：重入计划模式。要求读已有计划文件、判断同任务或新任务、先编辑计划文件再请求批准。
- **plan_mode_exit**：退出计划模式。"现在可以编辑、跑工具了"。
- **plan ready for approval**："计划已就绪，用 `<工具>` 请求批准，不要用文本或 AskUserQuestion 问批准"。
- **plan still-active**："计划模式仍激活，只读除计划文件外"。
- **5 阶段/迭代工作流**："遵循迭代工作流" / "遵循 5 阶段工作流"。
- 附在：独立 user 消息（`isMeta:true`）。

### B. 自动模式（auto mode）
- **auto_mode（完整）**："自动模式激活，用户选了连续自主执行。立即执行、减少打断、行动优先于规划"。
- **auto_mode（稀疏）**："自动模式仍激活，自主执行，减少打断，行动优先"。
- **auto_mode_exit**："已退出自动模式，用户可能想更直接交互，方案不明时应问澄清"。
- 附在：独立 user 消息。

### C. 文件读取告警（Read 工具直接写标签进 tool_result）
- **恶意代码提醒**（`US9`，门控 `cS9()`）：任何成功文件读，末尾追加"读文件时应考虑是否算恶意代码。可以分析它做什么，但必须拒绝改进/增强该代码"。
- **空文件**：`<system-reminder>Warning: 文件存在但内容为空。</system-reminder>`（`totalLines === 0`）。
- **offset 超长**：`<system-reminder>Warning: 文件存在但比提供的 offset(${startLine}) 短。文件共 ${totalLines} 行。</system-reminder>`。
- 附在：tool result（仅 Read 工具）。

### D. 工具权限拒绝
- **不注入 reminder**。拒绝信息直接进 `tool_result` 文本（不包标签）。system prompt 里有段指导模型"被拒后不要原样重试"，那是 system prompt 常驻文本，不是每事件注入。

### E. Todo / Task 提醒
- **todo_reminder**："最近没用 TodoWrite 工具。若任务能从跟踪受益可考虑用...别向用户提这条提醒" + 当前 todo 列表。
- **task_reminder**（门控 `n$()`）："最近没用任务工具..." + 当前任务列表。
- 附在：独立 user 消息。（子类型 `todo`、`task_progress` 返回 `[]` 被抑制。）

### F. Token / 预算用量（直接用 `qT`）
- **token_usage**：`Token usage: ${used}/${total}; ${remaining} remaining`
- **budget_usd**：`USD budget: $${used}/$$$${total}; $${remaining} remaining`
- **output_token_usage**：`Output tokens — turn: ${turn} · session: ${session}`
- 附在：独立 user 消息。

### G. Hook 反馈（全用 `qT`）
- **hook_blocking_error**：`${hookName} hook blocking error from command: "${command}": ${blockingError}`
- **hook_success**（仅 SessionStart/UserPromptSubmit 事件、内容非空）：`${hookName} hook success: ${content}`
- **hook_additional_context**：`${hookName} hook additional context: ${content.join('\n')}`
- **hook_stopped_continuation**：`${hookName} hook stopped continuation: ${message}`
- **Stop hook blocking error**：作为 `task-notification` 发。
- **async_hook_response**：两块分别包——`systemMessage` 和 `additionalContext`。
- 被抑制（返回 `[]`）：`hook_cancelled`、`hook_error_during_execution`、`hook_non_blocking_error`、`hook_system_message`、`hook_permission_decision`。
- 附在：独立 user 消息。

### H. 上下文 / 自动压缩 / 环境
- **compaction_reminder**："自动压缩已开启。上下文窗口接近满时，较早消息会自动摘要，你可以无缝继续。无需停止或赶工——通过自动压缩你有无限上下文。"
- **context_efficiency**：返回 `[]`（当前禁用）。
- **date_change**："日期已变。今天是 ${newDate}。不要 explicitly 告诉用户，因为他们已知。"（本会话就有这条。）
- **ultrathink_effort**："用户请求了推理努力级别：${level}。应用到当前回合。"

### I. MCP 相关
- **deferred_tools_delta**：延迟工具通过 ToolSearch 变可用/不可用。"以下延迟工具现在可用..." / "...不再可用（其 MCP 服务器断开）。别再搜它们"。
- **mcp_instructions_delta**："# MCP Server Instructions ... 以下 MCP 服务器提供了指令..." / "...已断开，上述指令不再适用"。
- **mcp_resource**：把资源内容包成 `<mcp-resource server=... uri=...>` 块放进 system-reminder。

### J. 文件变更通知
- **edited_text_file**："Note: ${filename} 被修改（用户或 linter）。此改动是有意的，纳入考虑...别告诉用户...相关改动（带行号）：\n${snippet}"。
- **compact_file_reference**："Note: ${filename} 在上次摘要前被读过，但内容太大无法包含。需要时用 `<Read>` 工具访问。"
- **pdf_reference**："PDF 文件: ${filename} (${pageCount} 页, ${fileSize})。太大...必须用 `<Read>` 工具带 pages 参数..."
- **file**（图片/文本/notebook/PDF 在 IDE 里读）：合成 `<Read>` tool_use + tool_result 对，由 `x5` 包装。截断子注："文件 ${filename} 太大，截断为前 ${kx6} 行。别告诉用户截断..."

### K. IDE 相关
- **selected_lines_in_ide**："用户在 IDE 选中了 ${lineStart}-${lineEnd} 行（来自 ${filename}）：\n${content}\n\n可能与当前任务有关，也可能无关。"
- **opened_file_in_ide**："用户在 IDE 打开了文件 ${filename}。可能与当前任务有关，也可能无关。"

### L. 记忆（memory）
- **nested_memory**："Contents of ${path}:\n\n${content}"
- **relevant_memories**：每条"Memory (saved ${relative-time}): ${path}:\n\n${content}"
- **ultramemory**：原始 `A.content` 包装。
- **记忆陈旧提醒**（`pJ7`/`wz8`，经 `lS9`）：读超过 1 天的 memory 文件时，注入到 Read 工具结果：`<system-reminder>This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.</system-reminder>`。附在：Read tool result。

### M. Skill
- **skill_listing**："The following skills are available for use with the Skill tool:\n${content}"
- **invoked_skills**："本次会话调用了以下 skill。继续遵循这些准则：\n### Skill: ${name}..."

### N. 输出风格 / 诊断 / 计划文件引用
- **output_style**："${name} output style is active. Remember to follow the specific guidelines for this style."
- **diagnostics**：`<new-diagnostics>The following new diagnostic issues were detected:\n${summary}</new-diagnostics>`（包装）
- **plan_file_reference**："计划模式留下一个计划文件：${path}\n\nPlan contents:\n\n${content}\n\n若相关..."
- **verify_plan_reminder**："你已完成实现计划。请直接调用 "" 工具（不是 `<a4>` 工具或 agent）验证所有计划项是否完成。"（源码里工具名变量解空，疑似 bug。）

### P. Agent / Task 状态
- killed：`Task "${description}" (${taskId}) was stopped by the user.`
- 其他：`Task ${taskId} (type: ${taskType}) (status: ${status}) (description: ${description}) [Delta: ${deltaSummary}] You can check its output using the TaskOutput tool.`

### Q. Agent 提及
"用户表达了调用 agent \"${agentType}\" 的意愿。请适当地调用该 agent，传入所需上下文。"

### R. 侧问轻量 agent（`vW4`）
独立 `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.\n\nIMPORTANT CONTEXT:\n- You are a separate, lightweight agent spawned to answer this one-off question...\nSimply answer the question with the information you have.</system-reminder>\n\n${question}`。这是一整个侧问子 agent 的 prompt，不是 transcript 注入。

### S. 团队协作
- **team_context**：多段 `<system-reminder># Team Coordination\n\nYou are a teammate in team "${teamName}"...\n**Your Identity:**... **Team Resources:**... **Team Leader:**... 读团队配置... 用 NAME 称呼队友...</system-reminder>`。
- **teammate_mailbox**：信箱消息格式化为 system-reminder。
- **非交互关机**（`gmq`，预烤常量）：`<system-reminder>\nYou are running in non-interactive mode and cannot return a response to the user until your team is shut down.\n\nYou MUST shut down your team before preparing your final response:\n1. Use requestShutdown... 2. Wait for shutdown approvals... 3. Use the cleanup operation... 4. Only then provide your final response...\n</system-reminder>`。

### T. 通用上下文（`vE1`）
把上下文字典（如 `currentDate`、环境信息）包成：`<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# ${key}\n${value}\n...\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>`。本会话里的 `# currentDate` 提醒就是这条路径产出的。

### U. 关键 / 透传
- **critical_system_reminder**：`A.content` 直接经 `x5` 透传。任意关键文本的逃生口。
- 返回 `[]`（不注入）的类型：`dynamic_skill`、`structured_output`、`context_efficiency`、`todo`、`task_progress`、`background_task_status`、`autocheckpointing`、`already_read_file`、`command_permissions`、`edited_image_file`、`hook_cancelled`、`hook_error_during_execution`、`hook_non_blocking_error`、`hook_system_message`、`hook_permission_decision`。

---

## elf-002 对照

elf-002 当前代码 **0 处注入** `<system-reminder>`（grep 确认）。CC 的 ~20 类注入对应的功能 elf-002 几乎都没有：无计划/自动模式、无 Todo/Task、无 Hook、无 MCP、无 IDE 集成、无记忆系统、无 Skill、无日期/环境注入、无文件变更检测、Read 工具无告警注入。

**结论**：elf-002 消息流里目前不会出现 `<system-reminder>`。system_prompt 里保留那句告知属于"预留位"——若未来给 Read 工具加"空文件/offset 超长告警"（CC 的 C 类，是唯一轻量且贴 tool_result 的场景），则有意义；否则是中性提示，不构成假信号危害（模型只是知道"可能有"标签，实际没有也不会出错）。

**若未来要引入**：C 类（Read 工具告警）最轻量、最贴 elf-002 场景；但工具结果处理在 shared 的工具实现里，elf-002 子类改不了工具输出，需另想路径（如工具结果回传后、写进 messages 前在 MM 层包标签）。
