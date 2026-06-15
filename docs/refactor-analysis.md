# Elf 项目架构分析与重构方案

## 一、项目概况

- **前端**: `frontend/app.js` (1202行) + `style.css` (765行) + `index.html` (88行) + `default-config-ui.html` (126行)
- **网关**: `gateway/server.js` (716行) + `config-ui.js` (229行) + `process_manager.js` (325行) + `chat_history.js` (144行) + `config.js` (31行) + `index.js` (50行)
- **共享层**: `shared/logger.js` (65行) + `shared/agent/llm_model.js` (247行) + `shared/agent/mock_model.js` (91行)
- **Agent层**: elf-001 和 elf-002 各 7 个文件，绝大部分代码重复

---

## 二、核心问题

### 1. 前端 JS 过重，HTML 生成散落在 JS 中

`app.js` 有 **30+ 处** 通过 innerHTML / insertAdjacentHTML / 模板字符串拼接 HTML，涵盖：聊天消息渲染、工具调用标签、空状态占位、输入指示器、头像预览等。这导致结构（HTML）、样式（CSS）、逻辑（JS）三者严重耦合，难以维护和复用。

具体表现：
- 聊天消息构建（用户/助手/系统/压缩）全在 `renderChatHistory` 一个 89 行函数中，HTML 拼接与状态判断交织
- 头像渲染存在三个几乎相同的函数：`getAgentAvatar`、`getUserAvatar`、`renderAvatarContent`
- 头像上传逻辑在 `app.js` 和 `default-config-ui.html` 中各实现了一遍
- 8 处通过 `.style.display` 直接操作内联样式，未使用 CSS class 切换

### 2. elf-001 与 elf-002 代码大量重复

7 对文件中，2 对完全相同，5 对高度相似：

| 文件 | 重复程度 | 差异点 |
|------|---------|--------|
| `tools/read_file.js` | 100% 相同 | 无 |
| `tools/registry.js` | 100% 相同 | 无 |
| `server.js` | 近乎相同 | elf-001 多 SSE 优化头（`X-Accel-Buffering`、`setNoDelay`） |
| `message_manager.js` | 大量重叠 | elf-001 多 prefix/suffix prompt 支持；压缩提示词措辞微调 |
| `config.js` | 大量重叠 | elf-001 支持多 prompt 文件路径循环加载 |
| `index.js` | 大量重叠 | elf-001 传递 prefix/suffix 配置 |
| `agent.js` | 大量重叠 | elf-001 发射 `tool_call` 事件；elf-002 有压缩触发 bug |

elf-002 的 `agent.js` 引用 `this.memoryTokenLimit`（从未赋值），导致**内存压缩永远不会触发**——这是一个因复制粘贴引入的实际 bug。

### 3. Gateway server.js 过重，职责不清

`server.js` 承担了过多不属于网关的职责：

- **SSE 流解析 + 历史记录写入**（约 235 行）：解析 agent 事件流、累积内容、写入聊天记录——这是应用逻辑，不是路由转发
- **配置文件 CRUD**（约 190 行）：读/写 `config.json`、多个 prompt `.md` 文件、`api_key.json`，含字段校验、provider 合并——纯应用层业务
- **头像上传文件管理**（约 50 行）：base64 解码、写文件、删旧文件、更新配置
- **内存清除直接写文件**（约 28 行）：网关直接操作 `context.json` 文件系统
- **前端日志写入**（约 18 行）：应用层日志服务
- **配置页面 HTML 生成**：委托给 `config-ui.js`，但仍是网关在管的 UI 渲染

整个 716 行文件中，纯路由转发可能不到 100 行。

### 4. config-ui.js 在 JS 中生成 HTML

`config-ui.js` 完全用 JavaScript 模板字符串构建配置表单 HTML，而项目中已有 `default-config-ui.html` 模板文件。当前流程是：JS 读取 HTML 模板 → 替换占位符 → JS 再生成字段 HTML 填入占位符。这种半模板半拼接的方式使 UI 结构分散在两个地方，维护时需要同时关注 JS 生成逻辑和 HTML 模板。

此外，`elf-001` 有独立的 `config-ui.html` 自定义配置页，与 `config-ui.js` 的生成路径并行，两套 UI 各自维护。

### 5. 重复的常量和模式

- **Prompt 文件字段数组**（3 元素）在 `server.js` 中复制了 3 次（第 428、492、539 行）
- **api_key.json 读取模式**（try/catch 回退空对象）在 `server.js` 中重复 2 次
- **Agent 信息对象构造**在 `process_manager.js` 的 `getAgent()` 和 `listAgents()` 中重复
- **类型推断逻辑**（boolean→checkbox / number→number / string>100→textarea / else→text）在 `config-ui.js` 的 `extractAgentFields` 和 `extractModelFields` 中重复
- **CSS 样式**在 `style.css` 和 `default-config-ui.html` 的内联 `<style>` 之间存在重叠（头像、表单字段样式）

### 6. 性能与规范问题

- `chat_history.js` 的 `getRecent()` 每次请求都全量读取 JSONL 文件到内存，随历史增长将变慢
- `collectConfigFromFrame()` 使用同步 `XMLHttpRequest`，阻塞 UI 线程，已废弃
- `llm_model.js` 的 `chat()` 和 `chatComplete()` 共享大量 fetch/timeout/abort 样板代码，未提取公共方法

---

## 三、重构方案

### 阶段一：消除 Agent 代码重复（优先级最高）

**目标**：将 elf-001 和 elf-002 的重复代码提取到 `shared/` 层，消除 copy-paste bug。

1. 将 `tools/registry.js` 和 `tools/read_file.js` 移入 `shared/agent/tools/`
2. 将 elf-001 的 `server.js`（含 SSE 优化）提升为 `shared/agent/server.js`，elf-002 直接引用
3. 将 elf-001 的 `message_manager.js`（含 prefix/suffix 支持）提升为 `shared/agent/message_manager.js`，prefix/suffix 默认为空字符串保持向后兼容
4. 将 elf-001 的 `config.js`（含多 prompt 文件支持）提升为 `shared/agent/config.js`，prompt 文件列表可配置
5. 将 elf-001 的 `agent.js`（含 tool_call 事件 + 正确的压缩阈值引用）提升为 `shared/agent/agent.js`，同时修复 elf-002 的 memoryTokenLimit bug
6. 各 Agent 的 `index.js` 仅保留差异配置（agentId、端口、prompt 文件列表、注册的工具）

**效果**：Agent 目录从各 7 文件精简到各 1-2 文件（仅 `index.js` + 可选的自定义工具），共享层承载所有通用逻辑。

### 阶段二：Gateway 瘦身

**目标**：将应用逻辑从 `server.js` 剥离，使其回归路由网关的定位。

1. **抽取配置管理模块** `gateway/config_store.js`：封装 config.json / api_key.json / prompt 文件的读写、校验、合并逻辑，导出 `getConfig(agentId)` / `updateConfig(agentId, data)` / `getApiKey(agentId)` 等接口
2. **抽取头像模块** `gateway/avatar.js`：封装 base64 解码、文件写入、旧文件清理、配置更新逻辑
3. **抽取聊天代理模块** `gateway/chat_proxy.js`：封装 SSE 流解析、内容累积、历史记录写入、事件转发逻辑
4. **server.js 仅保留**：路由定义、请求校验、调用上述模块、静态文件服务
5. 提取重复的 prompt 文件字段常量和 agent URL 构建逻辑为共享常量/辅助函数

### 阶段三：前端结构化

**目标**：消除 JS 中的 HTML 拼接，分离结构与逻辑。

1. **引入模板片段**：将重复的 HTML 结构（消息气泡、工具调用标签、空状态、头像等）定义为 `<template>` 标签或在 `index.html` 中声明，JS 通过 `cloneNode` + 数据填充替代字符串拼接
2. **统一配置页**：合并 elf-001 的自定义 `config-ui.html` 与 `default-config-ui.html`，通过配置驱动差异（如 elf-001 的提示词 tab），而非维护两套 HTML
3. **消除 CSS 重复**：将 `default-config-ui.html` 的内联样式移入 `style.css` 或独立配置页样式文件，配置页通过 iframe + 共享样式引用
4. **消除头像上传重复**：提取为 `frontend/avatar-upload.js` 共享模块，app.js 和配置页均引用
5. **替代内联样式操作**：将 8 处 `.style.display` 替换为 CSS class 切换（如 `.hidden` / `.visible`）
6. **替代同步 XHR**：`collectConfigFromFrame` 中的同步 `XMLHttpRequest` 改为 `fetch` + async/await
7. **拆分长函数**：`renderChatHistory`（89行）拆为消息预处理 + 按类型渲染；`doSend`（71行）拆为消息发送 + SSE 解析器；`selectAgent`（45行）拆为状态切换 + UI 更新 + 侧边逻辑

### 阶段四：配置页面重构

**目标**：统一配置页生成机制。

1. 废弃 `config-ui.js` 中的 HTML 字符串拼接，改为纯数据驱动：`extractAgentFields` / `extractModelFields` 只返回字段描述数据
2. 所有 Agent 使用同一个 HTML 模板（增强 `default-config-ui.html`），通过数据属性或 JS 渲染填充字段
3. Agent 差异通过 `config.json` 中的 `_ui` 元数据驱动（已有此机制但未被 elf-001 使用），而非独立的 HTML 文件
4. 合并类型推断逻辑为单一 `inferFieldType(value, meta)` 函数

### 阶段五：工程规范与性能

1. **聊天历史**：`chat_history.js` 的 `getRecent()` 改为流式读取或维护内存索引，避免全量加载
2. **LLM 请求封装**：`llm_model.js` 提取 `_request()` 方法消除 `chat()` / `chatComplete()` 重复
3. **ProcessManager 去重**：`listAgents()` 复用 `getAgent()`
4. **统一错误构造**：提取 `throwHttpError(message, statusCode)` 辅助函数
5. **前端日志优化**：`/api/log` 端点改为批量写入或异步队列

---

## 四、优先级排序

| 优先级 | 阶段 | 理由 |
|--------|------|------|
| P0 | 阶段一 | 消除现有 bug（elf-002 压缩失效），阻止后续复制粘贴引入更多 bug |
| P1 | 阶段二 | Gateway 716 行持续增长会越来越难维护，且业务逻辑混入路由不利于测试 |
| P2 | 阶段三 | 前端 1202 行 JS 中的 HTML 拼接难以维护，但不影响功能正确性 |
| P3 | 阶段四 | 配置页统一是效率提升，可与阶段三并行 |
| P4 | 阶段五 | 性能优化和工程规范，当前规模下不紧迫 |