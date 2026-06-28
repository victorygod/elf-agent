# Grep 工具改造方案

> 目标：在 `shared/agent/tools/` 中新增与 Claude Code `Grep` 工具等价的工具，供 Agent 按需注册。
> 约束：与现有工具（`Glob.js` / `Bash.js` / `Read.js`）保持同构——纯 Node、零外部依赖、统一元数据契约。

---

## 1. 背景与对齐目标

### 1.1 现状
`shared/agent/tools/` 已实现 `Read / Write / Edit / Bash / Glob` 五个工具，均遵循同一结构：

```js
export const Xxx = {
  name,            // 工具名，与 config.json 的 tools 数组对应
  description,     // 暴露给 LLM 的英文说明（与 Claude Code 措辞对齐）
  statusEvent: { state, detail: (args) => string },  // 前端状态事件
  callSummary: (args) => string,                      // 工具调用摘要展示
  parameters: { type, properties, required },         // JSON Schema
  execute: async (args) => string                     // 返回纯文本结果
};
```

工具通过 `tools/index.js` 纯 re-export 暴露，`default_agent.js` 在 `fromConfigDir()` 中根据 `config.json` 的 `tools` 数组按名注册（`default_agent.js:62-78`）。常见目录排除约定统一为 `['node_modules', '.git']`（见 `Glob.js:10`）。

### 1.2 Claude Code Grep 工具语义
Claude Code 的 `Grep` 基于 ripgrep，核心能力：
- **正则搜索**文件内容，默认递归当前工作目录。
- 支持 `path`（限定目录/文件）、`glob`（文件名过滤）、`output_mode`（`content` / `files_with_matches` / `count`）、上下文行 `-A/-B/-C`、`-i`（忽略大小写）、行号（`-n`，content 模式默认带行号）。
- 结果以纯文本返回，含截断保护。

本方案目标：在零外部依赖、纯 Node 前提下提供等价能力，输出格式与 Claude Code 对齐。

---

## 2. 设计决策

### 2.1 实现路线：`spawn` ripgrep，回退自研

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A. spawn ripgrep（`rg`）** | 与 Claude Code 行为完全一致；正则/glob/上下文/性能均最优；实现最简 | 运行环境须装 `rg`；需处理 `rg` 缺失 |
| B. 纯 Node 自研 | 零运行时依赖 | 需自实现正则匹配、目录遍历、上下文、glob 过滤、二进制/大文件防护；与 `Glob.js` 重复造轮子；性能差 |

**推荐：方案 A 为主 + 方案 B 回退。**
- 运行时优先 `which rg`，命中则 `spawn` 调用，参数透传，输出直接截断返回。
- 未命中 `rg` 时，回退到内置纯 Node grep（复用 `Glob.js` 的遍历与排除约定），保证在无 `rg` 环境下仍可用。
- 与 `Bash.js` 的 `spawn` 模式一致，已有超时/截断经验可复用。

> 理由：`rg` 缺失仅影响性能与少数边界语法，不影响主路径可用性；回退实现保证工具在任何机器都能跑。回退实现仍需做，但可写得更精简（只覆盖 content / files_with_matches / count + glob 过滤 + 行号，不含上下文或上下文简化）。

### 2.2 输出格式对齐 Claude Code

- **`content`**：`<relative/path>:<line>:<matched line>`，行号从 1 开始（与 `Read.js` cat -n 一致）。
- **`files_with_matches`**：每行一个相对路径。
- **`count`**：`<relative/path>:<N>`，仅命中数 > 0 的文件。

### 2.3 与现有代码复用
- 目录排除默认 `['node_modules', '.git']`，与 `Glob.js` 对齐（可抽取为共享常量，见第 5 节）。
- 截断阈值沿用 `Bash.js` 风格：输出上限与最大结果文件数，末尾追加 `... and N more`。
- 不与 `read_state.js` 耦合（Grep 为只读搜索，无需追踪 Read 状态）。

---

## 3. 接口定义（JSON Schema）

```js
parameters: {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'The regular expression (Rust regex syntax when using ripgrep; JS RegExp in fallback) to search for in file contents.'
    },
    path: {
      type: 'string',
      description: 'File or directory to search. Defaults to the current working directory (recursive).'
    },
    glob: {
      type: 'string',
      description: 'Glob pattern to filter which files to search (e.g. "*.js", "src/**/*.{ts,tsx}"). Applied to file paths.'
    },
    output_mode: {
      type: 'string',
      enum: ['content', 'files_with_matches', 'count'],
      description: "Set to 'files_with_matches' to return only file paths, 'count' to return match counts per file. Defaults to 'content'.",
      default: 'content'
    },
    '-i': {
      type: 'boolean',
      description: 'Case-insensitive search.',
      default: false
    },
    '-n': {
      type: 'boolean',
      description: 'Include line numbers in content output (default true in content mode; ignored for other modes).',
      default: true
    },
    '-A': {
      type: 'integer',
      minimum: 0,
      description: 'Number of context lines to show after each match.'
    },
    '-B': {
      type: 'integer',
      minimum: 0,
      description: 'Number of context lines to show before each match.'
    },
    '-C': {
      type: 'integer',
      minimum: 0,
      description: 'Number of context lines to show before and after each match (shorthand for -A and -B).'
    }
  },
  required: ['pattern']
}
```

> 参数命名 `-i` / `-A` 等沿用 Claude Code 风格，便于 LLM 直接迁移；`description` 用英文，与既有工具一致。

---

## 4. 实现要点

### 4.1 文件结构
```
shared/agent/tools/
├── Grep.js          ← 新增
├── excludes.js      ← (可选)抽取共享常量 DEFAULT_EXCLUDES，供 Glob/Grep 复用
└── ...
```

### 4.2 `Grep.js` 骨架（关键流程）

```js
/**
 * Grep 工具
 * 文件内容正则搜索，对齐 Claude Code Grep
 * 优先使用 ripgrep，未安装时回退到纯 Node 实现
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const DEFAULT_EXCLUDES = ['node_modules', '.git'];
const MAX_OUTPUT = 100 * 1024;     // 100KB，与 Bash.js 一致
const MAX_FILES = 1000;            // 回退模式下扫描文件上限
const DEFAULT_TIMEOUT = 30000;      // 30s

export const Grep = {
  name: 'Grep',
  description: "Search file contents using a regular expression. Returns matching lines with file paths and line numbers. Useful for finding code, definitions, or text across a project. Defaults to searching the current working directory recursively.",
  statusEvent: {
    state: 'searching_content',
    detail: (args) => `正在搜索 ${args.pattern || ''}`,
  },
  callSummary: (args) => args.pattern || '',
  parameters: { /* 见第 3 节 */ },

  execute: async (args) => {
    // 1. 解析参数（pattern 必填校验、output_mode 归一、上下文合并）
    // 2. 探测 ripgrep：which rg
    // 3. 命中 → spawn rg，透传参数，截断 stdout 返回
    // 4. 未命中 → fallbackGrep(args) 纯 Node 实现
    // 5. 异常 / 超时 → 友好错误文本（不 throw，对齐 registry 的 try/catch）
  }
};
```

### 4.3 arg → `rg` 参数映射

| 工具参数 | rg flag |
|----------|---------|
| `pattern` | 位置参数 |
| `path` | 位置参数（默认 `.`） |
| `glob` | `--glob <pattern>` |
| `output_mode=files_with_matches` | `-l` |
| `output_mode=count` | `-c` |
| `-i=true` | `-i` |
| `-A` | `-A N` |
| `-B` | `-B N` |
| `-C` | `-C N` |
| ——（隐含） | `--no-heading --color=never -n`（content 模式带行号） |

推荐固定加 `--no-heading --color=never` 保证输出纯净可解析；裁剪用 `MAX_OUTPUT` 截断 stdout，末尾追加 `... [truncated: N bytes]`。

### 4.4 回退实现（纯 Node，无 rg 时）

复用 `Glob.js` 的 `walk` + 排除约定：
1. 递归遍历 `path`（默认 `process.cwd()`），跳过 `DEFAULT_EXCLUDES` 目录。
2. 按 `glob` 过滤文件名（复用 `globToRegex`，可抽取共享）。
3. 跳过二进制文件（探测 NUL 字节）与超大文件 (> 1MB 跳过)。
4. 逐行用 `RegExp`（`-i` 时加 `i` flag）匹配。
5. 按 `output_mode` 聚合；`-A/-B/-C` 上下文在 content 模式下输出相邻行（无重叠时去重）。
6. 超 `MAX_FILES` / `MAX_OUTPUT` 截断并追加计数。

> 回退实现复用 `Glob.js` 的 `globToRegex` —— 建议将其从 `Glob.js` 抽取到 `glob_util.js` 共享（见第 5 节），避免重复。

### 4.5 边界与安全
- `pattern` 非法正则：捕获异常，返回 `Error: invalid pattern: <pattern>`，不 throw。
- `path` 不存在：返回 `No such file or directory: <path>`。
- 二进制/超限文件静默跳过。
- 超时：`rg` 进程 `SIGTERM` 后 3s `SIGKILL`（沿用 `Bash.js:64-73` 模式）。
- 结果为空：返回固定提示，如 `No matches found.`。

---

## 5. 配套重构（可选但推荐）

1. **抽取共享常量与工具函数**：
   - `excludes.js`：`DEFAULT_EXCLUDES`（`Glob.js` 与 `Grep.js` 共用）。
   - `glob_util.js`：`globToRegex` / `formatSize`（从 `Glob.js` 迁出，`Grep.js` 复用，消除重复）。
2. `Glob.js` 改为从上述模块 import，行为不变。

> 不做该重构亦可行（在 `Grep.js` 内联副本），但会留下逻辑重复，建议一并清理。

---

## 6. 接入与启用

### 6.1 导出
`shared/agent/tools/index.js` 增加：
```js
export { Grep } from './Grep.js';
```

### 6.2 注册到 agent
在 `agents/<id>/config/config.json` 的 `tools` 数组加入 `"Grep"`，例如 `agents/elf-002/config/config.json`：
```json
"tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
```
无需改动 `default_agent.js`——按名注册逻辑已通用（`default_agent.js:62-78`）。

### 6.3 测试
在 `test/` 下补充脚本，覆盖：
- rg 可用：content / files_with_matches / count 三种模式 + `-i` + 上下文。
- rg 缺失：回退路径同三模式。
- 边界：非法正则、不存在路径、二进制文件跳过、输出截断、空结果。

---

## 7. 工作量与检查清单

- [ ] 新建 `shared/agent/tools/Grep.js`（参数解析 + rg 探测 + spawn + 回退）
- [ ] （可选）抽取 `excludes.js` / `glob_util.js`，改造 `Glob.js`
- [ ] `tools/index.js` 增加 `export { Grep }`
- [ ] 目标 agent `config.json` 的 `tools` 加入 `"Grep"`
- [ ] `test/` 补充用例（rg 在/不在两条路径）
- [ ] 验证：启动 agent，让 LLM 调用 Grep 确认状态事件、摘要、输出格式

预计实现约 200–250 行（含回退），与 `Glob.js` / `Bash.js` 量级相当。
