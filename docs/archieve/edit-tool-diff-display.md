# Edit 工具成功后显示 git diff 风格增删行

**日期**：2026-06-28
**状态**：🔍 方案待讨论（纯前端改动，不影响后端）
**涉及文件**：`frontend/src/components/ToolCallBadge.jsx`、新增 `frontend/src/components/EditDiff.jsx`、`frontend/src/components/EditDiff.module.css`、`frontend/src/utils/diff.js`

> 用户确认：① 自写 `lineDiff`，不引第三方 diff 包；② 行内字符级高亮（相邻 del/add 块再做字符级 diff，高亮真正改动的字符，非整行红绿）。

---

## 关键决策：不引包，自写 diff

调研了前端依赖（`frontend/package.json` 当前只有 react / react-dom / react-markdown / rehype-highlight / remark-gfm / zustand，依赖很干净），无任何 diff 包。

- **现成包**：npm 上最主流的 `diff` 包可用（`diffLines()` 一行搞定），但 gzip 后约 10KB，且捆绑大量本场景用不到的能力（字符级、word diff、JSON patch…）。为一个两行 diff 给干净的前端引库不划算。
- **自写成本**：lineDiff 核心是 LCS DP + 回溯，约 25 行；行内字符级高亮复用同一套 LCS 降一维跑字符，约 15 行。零依赖、可控。

**结论**：自写 `diff.js`，不引包。

---

## 背景与动机

当前 Edit 工具执行成功后，前端 `ToolCallBadge` 只显示一个绿色成功小圆点，参数区把 `old_string` / `new_string` 截断成「…最后 20 字符」（`ToolCallBadge.jsx:24-36`）。用户看不到这次编辑到底改了什么。需求：Edit 成功后，在工具徽章里展示类似网页端 git diff 的增删行（红色删除行 / 绿色新增行）。

---

## 关键调研结论

渲染 diff 所需的数据 **已经完整存在于前端，无需任何后端改动**：

- `tool_call` SSE 事件的 `args` 里携带完整的 `file_path`、`old_string`、`new_string`、`replace_all`
  - 产出位置：`shared/agent/default_agent.js:289-310`（`toolCallsSummary` 直接把 LLM 的函数调用参数解析进 `args`，Edit 的 `callSummary` 取 `args.file_path` 作为 `description`）
  - 传递位置：`gateway/chat_proxy.js:173-181`（`case 'tool_call'` 把 `{ ...tc, status: 'executing' }` 推入 bubble.toolCalls，`args` 被保留）
- `tool_result` SSE 事件只带 `status`（+ error 时的 `message`），不含 diff 内容
  - 产出位置：`shared/agent/default_agent.js:345-351`
  - 前端处理：`useChat.js:168-190` 的 `tool_result` 分支只更新 `status` / `message`，**不碰 `args`** → EditDiff 拿到的 `args` 始终是完整的
- 历史快照重建路径 `buildBubblesFromContext`（`chat_proxy.js:173-195`）亦保留 `args`
- 仓库内**没有任何 diff 工具**（`frontend/src/utils/` 只有 `format.js`、`logger.js`），需新增轻量行级 diff

**注意（diff 语义）**：这是 `old_string → new_string` 的文本 diff，不是整文件 before/after。对单次 Edit 等价于真实改动（Edit 本身就是用 old_string 精确匹配并替换成 new_string）。`replace_all` 多次匹配时，diff 只反映一次替换的文本（可接受，下方说明处注明即可）。若以后想要「带文件上下文行号的真实文件 diff」，需改 `Edit.execute()` 返回结构化结果 + 改 `default_agent.js:345-351` 转发——本次不做。

---

## 设计方案

### 1. 新增 diff 工具 `frontend/src/utils/diff.js`（零依赖）

两个函数，共用一套 LCS 实现：

```js
// 行级 diff：返回 [{ type: 'context' | 'del' | 'add', text }]
export function lineDiff(oldStr, newStr) { ... }

// 字符级 diff（用于行内高亮）：返回同结构，text 退化为 char
//   内部即对两串字符跑 LCS，与 lineDiff 同算法不同粒度
export function charDiff(oldStr, newStr) { ... }
```

- `lineDiff`：`\n` 分割为行数组，LCS DP + 回溯，产出 `context`/`del`/`add`。边界：空 old（纯新增）→ 全 add；空 new（纯删除）→ 全 del。
- `charDiff`：把两段文本当字符序列跑同一套 LCS，产出字符级的 `context`/`del`/`add`。EditDiff 渲染时用它做行内高亮。
- 不引第三方依赖，避免给干净的前端加包、避免打包体积变化。

### 2. 新增组件 `frontend/src/components/EditDiff.jsx` + `EditDiff.module.css`

git diff 风格，带行内字符级高亮：

- 头部：`file_path`
- 主体：对 `lineDiff` 的结果逐行渲染，`del` 行红色背景 + 前缀 `-`，`add` 行绿色背景 + 前缀 `+`，`context` 行灰色弱化
- **行内高亮**：对「相邻的 del 块 + add 块」调用 `charDiff`，del 行里未被匹配的字符用深红高亮、add 行里新增的字符用深绿高亮、公共字符保持原行色。整行内容相同时（纯上下文无关移动）跳过高亮。这样单行内的字符级改动读者一眼可见，而不是整行红/绿。
- 等宽字体，沿用 `ToolCallBadge.module.css` 的 `font-family`
- 高度上限 + 纵向滚动（参考现有 `.errorMsg` 的 `max-height` / `overflow-y` 写法，`ToolCallBadge.module.css:80-93`）
- 上下文折叠：超长 diff 时只展示紧邻变更的少量上下文行，中间折叠，避免巨型 diff 撑爆气泡（先做全展示+滚动，折叠作 v2）

配色对齐现有徽章调色板：

| 元素 | 背景 | 文字 |
|------|------|------|
| del 行 | `#ffebee` | `#c62828`（与 error 一致）|
| add 行 | `#e8f5e9` | `#2e7d32`（与 success 一致）|
| context 行 | 透明 | `#5f6368` |
| del 行内高亮（删除的字符）| `#ffcdd2` | `#b71c1c`（更深红）|
| add 行内高亮（新增的字符）| `#c8e6c9` | `#1b5e20`（更深绿）|

### 3. 接入 `ToolCallBadge.jsx`

当前所有工具一律渲染截断的 args 键值列表。改为条件渲染：

- `name === 'Edit'` 且 `status === 'success'` → 用 `<EditDiff args={args} />` **代替**默认 args 区块（Edit 成功后**只显示 diff，不再显示 old_string / new_string 键值**，也不显示 file_path 键值——file_path 移到 diff 头部展示）
- 其他情况（executing / error / 非 Edit 工具）→ 保持现有 args 键值渲染不变
- error 仍显示 `toolCall.message`

### 4. 流式 / 历史一致性（无需改代码，仅验证）

- 流式：`useChat.js` 的 `tool_result` 分支只更新 `status`，不动 `args` ✓
- 刷新重建：`buildBubblesFromContext` 保留 `args` ✓
- store / 快照逻辑不动

---

## 涉及文件清单

| 操作 | 文件 |
|------|------|
| 新增 | `frontend/src/utils/diff.js` |
| 新增 | `frontend/src/components/EditDiff.jsx` |
| 新增 | `frontend/src/components/EditDiff.module.css` |
| 修改 | `frontend/src/components/ToolCallBadge.jsx`（Edit+success 时条件渲染 EditDiff）|

后端、gateway、store、useChat 均不改动。

---

## 验证方式

1. 启动前端 dev（`frontend/`），打开某 agent 发起对话
2. 让 agent 执行一次 Edit（如改文件里一行），观察工具徽章：成功后出现 diff 区块，删行红、增行绿，含 file_path
3. 测纯新增（old 空）、纯删除、多行块替换，确认 LCS 行对齐正确
4. 刷新页面（历史快照重建路径）确认 diff 仍在、内容一致
5. 确认 error 的 Edit 仍显示错误文案，executing 中不渲染 diff

---

## 待讨论 / 可选

1. **diff 范围**：只展示 `old_string`→`new_string` 文本 diff（当前方案，零后端改动），还是希望带文件上下文行号的「真实文件 diff」（需改 `Edit.execute()` 返回结构化结果 + 改 `default_agent.js` 转发，工作量更大）？→ 倾向当前方案。
2. **超长 diff 折叠**：先做「全展示 + 滚动条」，还是一开始就做上下文行折叠？→ 先做全展示+滚动。
3. **是否覆盖 Edit 以外的写工具**（如 NotebookEdit 有 old/new 可 diff）？→ 本期只做 Edit，NotebookEdit 后续扩展。
