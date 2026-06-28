# Shared 工具集构建方案

## 1. 目标

构建 5 个与 Claude Code 100% 对齐的基础工具，使 elf Agent 具备完整的编码能力。

对齐原则：**工具名、参数名、参数类型、描述文本、返回格式、行为语义**全部与 Claude Code 保持一致。

## 2. 工具清单

| # | 工具名 | 对标 Claude Code | 核心职责 |
|---|--------|-----------------|----------|
| 1 | `Read` | `Read` | 读取文件，支持行分页，cat -n 格式输出 |
| 2 | `Write` | `Write` | 创建或覆盖文件，必须先 Read |
| 3 | `Edit` | `Edit` | old_string → new_string 精准替换 |
| 4 | `Bash` | `Bash` | 执行 shell 命令，超时+输出截断 |
| 5 | `Glob` | `Glob` | 文件名模式匹配，纯文本返回 |

## 3. 工具详细定义

---

### 3.1 `Read`

```json
{
  "name": "Read",
  "description": "Reads a file from the local filesystem. Returns content in cat -n format (line numbers starting at 1). Supports pagination via offset and limit. Files that don't exist, empty files, and directories return an error.",
  "parameters": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "The absolute path to the file to read"
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "description": "The line number to start reading from. Only provide if the file is too large to read at once"
      },
      "limit": {
        "type": "integer",
        "minimum": 0,
        "description": "The number of lines to read. Only provide if the file is too large to read at once."
      }
    },
    "required": ["file_path"]
  }
}
```

**行为细则：**
- 不传 `offset` 时从头读取，不传 `limit` 时默认最多 2000 行
- 输出格式：每行 `行号\t内容`（cat -n 风格），**无额外 header，纯文本**
- 文件不存在 → 返回 `File does not exist: /path/to/file.`
- 读取目录 → 返回 `/path/to/dir is a directory.`
- 权限拒绝 → 返回 `Permission denied: /path/to/file.`
- 不做：图片/PDF/Jupyter notebook 读取（超出范围）

---

### 3.2 `Write`

```json
{
  "name": "Write",
  "description": "Writes a file to the local filesystem, overwriting if one exists. Creates parent directories automatically. The file to be overwritten must have been previously Read in this conversation, or the call will fail.",
  "parameters": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "The absolute path to the file to write (must be absolute, not relative)"
      },
      "content": {
        "type": "string",
        "description": "The content to write to the file"
      }
    },
    "required": ["file_path", "content"]
  }
}
```

**行为细则：**
- 文件存在 → 覆盖写入（必须先 Read 过，否则报错）
- 文件不存在 → 创建新文件，自动建父目录
- 返回纯文本：
  - 创建成功：`File created successfully at: /path/to/file`
  - 覆盖成功：`File overwritten successfully at: /path/to/file (file state is current in your context — no need to Read it back)`
  - 未 Read 覆盖：`Error: Cannot overwrite /path/to/file — must Read the file first`
  - 路径非法：`Error: Invalid path: /path/to/file`

---

### 3.3 `Edit`

```json
{
  "name": "Edit",
  "description": "Performs exact string replacement in a file. old_string must include all whitespace, indentation, blank lines, and surrounding code exactly as it appears in the file. old_string must be unique in the file — the edit fails if there is more than one match. The file must have been previously Read in this conversation, or the call will fail.",
  "parameters": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "The absolute path to the file to modify"
      },
      "old_string": {
        "type": "string",
        "description": "The text to replace"
      },
      "new_string": {
        "type": "string",
        "description": "The text to replace it with (must be different from old_string)"
      },
      "replace_all": {
        "type": "boolean",
        "description": "Replace all occurrences of old_string (default false)",
        "default": false
      }
    },
    "required": ["file_path", "old_string", "new_string"]
  }
}
```

**行为细则：**
- 返回纯文本：
  - 替换成功：`The file /path/to/file has been updated successfully. (file state is current in your context — no need to Read it back)`
  - replace_all 全部成功：`The file /path/to/file has been updated successfully (N replacements). (file state is current in your context — no need to Read it back)`
  - old_string 未找到：`Error: old_string not found in /path/to/file`
  - 匹配多次但没开 replace_all：`Error: old_string matched N times in /path/to/file. Set replace_all=true to replace all, or provide more context to make it unique.`
  - old === new：`Error: old_string and new_string are identical`
  - 未 Read：`Error: Cannot edit /path/to/file — must Read the file first`

---

### 3.4 `Bash`

```json
{
  "name": "Bash",
  "description": "Executes a bash command and returns its output. Working directory persists between calls. Shell state (env vars, functions) does not persist between calls — the shell is initialized from the user's profile each time.",
  "parameters": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "The command to execute"
      },
      "description": {
        "type": "string",
        "description": "Clear, concise description of what this command does in active voice. For simple commands keep it brief (5-10 words). For commands that are harder to parse at a glance, add enough context to clarify what it does."
      },
      "timeout": {
        "type": "number",
        "description": "Optional timeout in milliseconds (max 600000, default 120000)"
      },
      "dangerouslyDisableSandbox": {
        "type": "boolean",
        "description": "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
        "default": false
      }
    },
    "required": ["command"]
  }
}
```

**行为细则：**
- 持久化 cwd：`cd` 效果跨 Bash 调用保留（用模块级变量记录当前目录）
- timeout 默认 120000ms（2 分钟），上限 600000ms（10 分钟）
- 返回纯文本：
  - 成功（exitCode=0）：直接返回 stdout
  - 失败（exitCode≠0）：`Exit code N` 换行后跟 stdout/stderr 按实际输出顺序拼合
  - stdout 截断至 100KB，超出尾部追加 `[truncated: N bytes omitted]`
  - 超时：SIGTERM → 3 秒后 SIGKILL，返回 `Exit code null (timed out after Nms)\n` + 已捕获的 stdout/stderr
- `dangerouslyDisableSandbox: false`（默认）：不做额外沙箱，elf 没有沙箱基础设施，此参数仅作为接口占位
- **不做**：`run_in_background`（后台执行），复杂度太高

---

### 3.5 `Glob`

```json
{
  "name": "Glob",
  "description": "Find files matching a glob pattern. Returns matching file paths with type and size information. Useful for discovering files in a project by naming convention.",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "The glob pattern to match files against. Supports standard glob syntax: ** for recursive matching, * for wildcards, ? for single character, [abc] for character classes."
      }
    },
    "required": ["pattern"]
  }
}
```

**行为细则：**
- 搜索根目录：Agent 进程的工作目录（项目根目录）
- 返回纯文本，每行一个路径，type/size 内联：
  ```
  src/tools/Read.js (file, 2048B)
  src/tools/ (directory)
  ```
- 无匹配返回空字符串
- 默认排除：`node_modules`、`.git`
- 最多返回 500 条，超出尾部追加 `... and N more results`
- 使用 Node.js 内置 `fs`/`path` 实现，不依赖第三方 glob 库

---

## 4. 与 Claude Code 的差异清单

| 差异项 | Claude Code | elf 方案 | 原因 |
|--------|------------|---------|------|
| Read 图片/PDF | 支持 | 不支持 | 超出第一阶段范围 |
| Bash `run_in_background` | 支持 | 不支持 | 复杂度高，需进程管理基础设施 |
| Bash 沙箱 | 有 sandbox 机制 | 参数占位，不实现 | elf 没有沙箱基础设施 |
| Bash cwd 持久化 | ✅ | ✅ (用模块变量模拟) | 行为一致 |

**除此之外，工具名、参数名、参数类型、描述文本全部与 Claude Code 对齐。**

## 5. 文件结构

```
elf/shared/agent/tools/
├── registry.js          # ToolRegistry 类（已有，不改）
├── read_file.js         # 旧 Read，将被替换
├── Read.js              # 新增：Read 工具
├── Write.js             # 新增：Write 工具
├── Edit.js              # 新增：Edit 工具
├── Bash.js              # 新增：Bash 工具
├── Glob.js              # 新增：Glob 工具
└── index.js             # 新增：统一注册入口
```

### 5.1 `index.js` —— 纯 re-export

shared 层只负责导出工具定义，**不负责注册**。每个 Agent 自行决定注册哪些工具。

```javascript
// shared/agent/tools/index.js
export { Read } from './Read.js';
export { Write } from './Write.js';
export { Edit } from './Edit.js';
export { Bash } from './Bash.js';
export { Glob } from './Glob.js';
```

### 5.2 Agent 入口改动（elf-001）

每个 Agent 在自己的 index.js 中手动注册工具，自由选择注册哪些。

```diff
// agents/elf-001/index.js
- import { ToolRegistry } from './tools/registry.js';
- import { readFileTool } from './tools/read_file.js';
+ import { ToolRegistry } from '../../shared/agent/tools/registry.js';
+ import { Read, Write, Edit, Bash, Glob } from '../../shared/agent/tools/index.js';

  // 5. 初始化工具注册表
  const toolRegistry = new ToolRegistry();
- toolRegistry.register(readFileTool);
+ toolRegistry.register(Read);
+ toolRegistry.register(Write);
+ toolRegistry.register(Edit);
+ toolRegistry.register(Bash);
+ toolRegistry.register(Glob);
```

elf-002 同理，保持两个 Agent 相同的工具集。未来如果某个 Agent 只需要部分工具或需要自定义工具，在各自 index.js 中调整即可。

### 5.3 Agent 目录清理

```
agents/elf-001/tools/
├── registry.js    # 保留 re-export
└── read_file.js   # ❌ 删除
```

## 6. 实现顺序

| 步骤 | 内容 | 预估 |
|------|------|------|
| 1 | 实现 `Read.js`（从现有 read_file 重构，参数改名+输出格式对齐） | 10min |
| 2 | 实现 `Write.js` | 15min |
| 3 | 实现 `Edit.js` | 20min |
| 4 | 实现 `Bash.js`（含 cwd 持久化） | 25min |
| 5 | 实现 `Glob.js`（纯 fs 递归实现） | 15min |
| 6 | 创建 `index.js` 统一入口 | 5min |
| 7 | 修改 Agent 入口文件（elf-001 + elf-002） | 10min |
| 8 | 清理旧 re-export 文件 | 2min |
| 9 | 端到端验证（启动 Agent，对话测试每个工具） | 15min |

总预估：~2h

## 7. 不做的

| 不做 | 原因 |
|------|------|
| 单元测试 | 当前项目无测试基础设施，端到端验证即可 |
| `run_in_background`（Bash） | 需要进程管理基础设施，后续迭代 |
| Read 支持图片/PDF/Jupyter | 超出第一阶段范围 |
| 旧 read_file 兼容/deprecation | 直接替换 |
| elf-002 差异化工具集 | elf-002 使用同样的 5 个工具 |

## 8. 附加改动

### 8.1 agent.js 工具状态 emit 更新

保留并扩展工具状态提示模式（用于前端渲染 Agent 当前动作）。将旧的单工具匹配扩展为覆盖 5 个工具：

```diff
// agents/elf-001/agent.js
- if (toolName === 'read_file') {
-   yield {
-     event: 'status',
-     data: { state: 'reading_file', detail: `正在读取 ${toolArgs.path || ''}` }
-   };
- }

+ if (toolName === 'Read') {
+   yield {
+     event: 'status',
+     data: { state: 'reading_file', detail: `正在读取 ${toolArgs.file_path || ''}` }
+   };
+ } else if (toolName === 'Write') {
+   yield {
+     event: 'status',
+     data: { state: 'writing_file', detail: `正在写入 ${toolArgs.file_path || ''}` }
+   };
+ } else if (toolName === 'Bash') {
+   yield {
+     event: 'status',
+     data: { state: 'executing_command', detail: `正在执行命令` }
+   };
+ }
```

### 8.2 elf-002 同步改造

`elf-002/index.js` 做同样工具注册改造；`elf-002/agent.js` 的 `read_file` 硬编码一并更新为同样的模式。