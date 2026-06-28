# Shared 工具集设计文档

## 1. 现状分析

### 1.1 mycode/tools.py（Python 内部框架）
已有 14 个工具，采用装饰器注册模式，覆盖四大类：
- **文件**：read_file, edit_file, write_file, append_file, search_files
- **执行**：run_command, run_skill_script
- **会话**：delete_tool_results, use_skill, skill_resource
- **网络/MCP**：fetch_web_text, load_mcp, call_mcp_tool

**缺失能力**：目录遍历、文件元信息、编码检测、JSON 解析、正则替换、HTTP 请求、Git 操作等。

### 1.2 elf/shared（Node.js Agent 平台）
目前 **仅有一个工具**：`read_file`，加上一个 `ToolRegistry` 注册框架。Agent 目录下的 `tools/` 只是 re-export，架构预留了扩展空间但能力极度贫瘠。

### 1.3 差距总结
| 能力域 | mycode/tools.py | elf/shared | 缺失程度 |
|--------|:-:|:-:|:-:|
| 文件读写 | ✅ 5 个 | ✅ 1 个 | ⚠️ 中等 |
| 目录操作 | ❌ | ❌ | 🔴 严重 |
| 代码搜索 | ❌ | ❌ | 🔴 严重 |
| Shell 执行 | ✅ | ❌ | 🔴 严重 |
| HTTP/网络 | ⚠️ 1 个 | ❌ | 🔴 严重 |
| 数据解析 | ❌ | ❌ | 🟡 中等 |
| Git 操作 | ❌ | ❌ | 🟡 中等 |
| 编码/文本处理 | ❌ | ❌ | 🟡 中等 |

---

## 2. 设计原则

1. **渐进式复杂度**：工具参数从简到繁，默认值覆盖 80% 场景
2. **安全边界**：路径沙箱、命令白名单、超时保护
3. **LLM 友好**：返回值结构化，错误信息包含可操作建议
4. **平台无关**：Node.js 原生实现，零第三方依赖（核心工具）
5. **可观测**：每个工具返回耗时、命中数等元信息

---

## 3. 推荐工具集（三层分级）

### 🔵 Layer 1: 基础必备（所有 Agent 都需要）

#### 3.1.1 `read_file`（已有，增强）
```
path: string          # 文件路径
start_line?: number   # 起始行，默认 1
max_lines?: number    # 最大行数，默认 500
encoding?: string     # 编码，默认 utf-8，自动检测
```
**增强点**：自动编码检测（UTF-8/GBK/GB2312/Latin-1 回退）、返回总行数、文件大小

#### 3.1.2 `write_file`（新增）
```
path: string          # 文件路径
content: string       # 文件内容
mode?: 'overwrite' | 'append'  # 写入模式
create_dirs?: boolean # 自动创建父目录，默认 true
```
**价值**：创建文件、覆盖写入、追加写入三位一体，减少 LLM 选择负担

#### 3.1.3 `edit_file`（新增，核心能力）
```
path: string           # 文件路径
old_string: string     # 要替换的原内容（需唯一匹配）
new_string: string     # 新内容
replace_all?: boolean  # 是否替换所有出现的，默认 false
```
**设计要点**：
- old_string 必须能在文件中唯一匹配，否则报错
- 错误信息精确指出匹配次数（0 次 or N 次）
- 这是 LLM 编码场景最高频的操作，设计必须极其稳健

#### 3.1.4 `list_directory`（新增）
```
path: string              # 目录路径
depth?: number            # 递归深度，默认 1，最大 3
filter?: string           # glob 模式过滤，如 "*.js"
include_hidden?: boolean  # 是否包含隐藏文件
limit?: number            # 最大返回数，默认 200
```
**返回**：`[{ name, path, type: 'file'|'dir', size, modified }]`

#### 3.1.5 `search_files`（增强 mycode 版本）
```
pattern: string         # 搜索文本或正则
path: string            # 搜索路径（目录或文件）
glob?: string           # 文件过滤，如 "*.{js,py,ts}"
case_sensitive?: boolean
use_regex?: boolean     # 是否用正则，默认 false（字面量搜索更安全）
max_results?: number    # 最大结果数，默认 50
context_lines?: number  # 上下文行数，默认 0（匹配行前后各 N 行）
```
**增强点**：正则支持、上下文行、glob 过滤

#### 3.1.6 `run_command`（新增，高优先级）
```
command: string          # 执行的命令
cwd?: string             # 工作目录
timeout?: number         # 超时毫秒，默认 30000
env?: Record<string, string>  # 额外环境变量
```
**安全设计**：
- 沙箱化：限定工作目录在项目范围
- 超时强制 kill
- 返回 `{ stdout, stderr, exitCode, duration }`
- 输出截断保护（stdout/stderr 各限制 100KB）

---

### 🟡 Layer 2: 编码增强（代码生成/修改场景）

#### 3.2.1 `grep_files`（代码搜索专用）
```
query: string                # 搜索关键词
path?: string                # 搜索路径
include?: string             # 包含的文件 glob，如 "*.{js,ts}"
exclude?: string             # 排除的 glob，如 "node_modules"
max_results?: number         # 默认 30
output_mode?: 'content' | 'files_with_matches' | 'count'
```
**与 search_files 的区别**：grep 是**文件内容搜索**，search_files 更偏向**文件名/路径搜索**。两个都要。

#### 3.2.2 `read_lints`（新增）
```
path?: string           # 文件或目录路径，默认项目根
```
**返回**：`[{ file, line, column, severity, message, rule }]`
**用途**：LLM 修改代码后自检，形成 write → lint → fix 闭环

#### 3.2.3 `parse_file`（结构化解析）
```
path: string            # 文件路径
format?: 'json' | 'csv' | 'yaml' | 'auto'  # 解析格式
limit?: number          # 数据行限制（CSV 场景）
```
**返回**：解析后的结构化数据 + schema 推断
**用途**：LLM 需要理解数据文件内容时，比纯文本更高效

#### 3.2.4 `ast_search`（代码结构搜索，可选高级）
```
path: string            # 文件或目录
symbol?: string         # 搜索符号名（函数、类、变量）
kind?: 'function' | 'class' | 'variable' | 'import' | 'export'
language?: 'javascript' | 'typescript' | 'python' | 'auto'
```
**返回**：`[{ name, kind, file, line, column, signature? }]`
**难度**：需要 tree-sitter 或各语言 parser。可先用正则近似实现。

---

### 🟢 Layer 3: 平台增强（运维/集成场景）

#### 3.3.1 `http_request`（新增）
```
url: string             # 请求 URL
method?: string         # GET/POST/PUT/DELETE，默认 GET
headers?: Record        # 自定义请求头
body?: string           # 请求体
timeout?: number        # 超时毫秒
```
**返回**：`{ status, headers, body, duration }`

#### 3.3.2 `git_operation`（新增）
```
operation: 'status' | 'diff' | 'log' | 'branch' | 'blame' | 'show'
path?: string           # 文件路径（diff/blame 场景）
limit?: number          # log 条数限制
```
**设计考量**：不直接提供 commit/push 能力（安全风险），只读操作通过子命令暴露

#### 3.3.3 `file_info`（新增）
```
path: string            # 文件路径
```
**返回**：`{ size, modified, created, encoding, mime_type, line_count, is_binary, hash }`
**用途**：LLM 判断是否需要读取、如何读取文件

#### 3.3.4 `mcp_tools`（MCP 集成，从 mycode 移植）
```
mcp_name?: string       # MCP 服务名，不传则列出所有可用
```
**返回**：可用的 MCP 工具列表及参数定义

#### 3.3.5 `call_mcp_tool`（从 mycode 移植）
```
mcp_name: string        # MCP 服务名
tool_name: string       # 工具名
arguments?: object      # 工具参数
```

---

## 4. 省略的工具（有意识排除）

| 工具 | 原因 |
|------|------|
| `delete_file` / `delete_directory` | 安全风险极高，LLM 误删不可逆 |
| `git commit/push` | 同上 |
| `install_package` | 环境破坏风险 |
| `rename_file` | 可通过 write + edit 组合实现 |
| `copy_file` | 低频需求，可用 run_command 替代 |
| `download_file` | http_request 可覆盖 |

---

## 5. 架构集成方案

### 5.1 文件组织
```
elf/shared/agent/tools/
├── registry.js          # ToolRegistry（已有，无需改动）
├── index.js             # 统一导出 + 内置工具注册
├── file/
│   ├── read_file.js     # 已有，增强
│   ├── write_file.js    # 新增
│   ├── edit_file.js     # 新增
│   └── file_info.js     # 新增
├── fs/
│   ├── list_directory.js
│   └── search_files.js
├── code/
│   ├── grep_files.js
│   ├── parse_file.js
│   └── read_lints.js    # 可选
├── exec/
│   └── run_command.js
├── net/
│   └── http_request.js
├── git/
│   └── git_operation.js
└── mcp/
    ├── mcp_tools.js
    └── call_mcp_tool.js
```

### 5.2 工具定义规范
```javascript
// 每个工具模块统一导出格式
module.exports = {
  name: 'read_file',
  description: 'Read a file from the local filesystem...',
  parameters: {
    type: 'object',
    properties: {
      path:       { type: 'string', description: '...' },
      start_line: { type: 'number', description: '...' },
      max_lines:  { type: 'number', description: '...' },
    },
    required: ['path'],
  },
  async execute(args, context) {
    // context = { workspace, logger, ... }
    // 返回字符串结果
  }
};
```

### 5.3 Agent 注册
```javascript
// agents/elf-001/index.js
const { registerBuiltinTools } = require('../../shared/agent/tools');
registerBuiltinTools(toolRegistry);

// Agent 也可以选择注册部分工具
const { registerFileTools } = require('../../shared/agent/tools');
registerFileTools(toolRegistry); // 只注册文件类
```

---

## 6. 实施路线图

| 阶段 | 工具 | 工作量 | 优先级 |
|------|------|--------|--------|
| **Phase 1** | write_file, edit_file, list_directory, search_files | 2-3h | 🔴 P0 |
| **Phase 2** | run_command, grep_files, file_info | 2-3h | 🔴 P0 |
| **Phase 3** | parse_file (JSON/CSV), http_request | 2h | 🟡 P1 |
| **Phase 4** | git_operation, read_file增强, mcp_tools | 2-3h | 🟡 P1 |
| **Phase 5** | read_lints, ast_search (tree-sitter) | 4h+ | 🟢 P2 |

---

## 7. 讨论要点

1. **工具粒度**：write_file + edit_file + append_file 合并还是分开？分开更清晰但增加 LLM 选择成本；合并后单个工具逻辑更复杂。我倾向保持 3 个独立工具（与 Claude Code 的 Write/Edit 模式一致）。

2. **安全边界**：run_command 是否需要命令白名单？要不要限制只能执行 `npm`/`node`/`git` 等已知安全命令？还是依赖沙箱+超时机制？

3. **MCP 工具**是否需要内置，还是作为可插拔模块？Current elf 项目似乎没有 MCP 概念。

4. **parse_file 的深度**：仅支持 JSON/CSV，还是要 YAML/TOML/XML？是否需要 schema 推断？

5. **git_operation 的写操作**：是否开放 branch/checkout 切换能力？还是严格只读？

6. **测试策略**：每个工具是否都需要单元测试 + 集成测试？mock 文件系统还是用真实临时目录？

请逐项讨论你的想法，我会根据反馈调整设计方案。