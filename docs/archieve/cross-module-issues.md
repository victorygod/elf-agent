# Elf 跨模块问题记录

> 生成于 2026-06-25，基于对 shared/agent/、gateway/、agents/ 全部源码的架构评审。

---

## 1. Config 加载逻辑在 Agent 侧和 Gateway 侧重复

**涉及文件**:
- `shared/agent/config_loader.js` — Agent 进程自己加载配置
- `gateway/config_store.js` — Gateway 读写 Agent 配置给前端展示

**重复内容**:
- `type:"path"` 字段展开逻辑（遍历 config.json，遇到 `{type:"path"}` 就读文件内容）
- `api_key.json` 读取和合并
- model 必填字段校验（`base_url`/`auth_token`/`model`）

**影响**: 两处独立实现，容易出现行为不一致。例如 `config_loader.js` 有 `API_KEY_TEMPLATE` 自动创建空模板的逻辑，`config_store.js` 没有。

**方向**: 抽取共享的 `readRawConfig(configDir)` 函数放到 shared/，两边复用。写入逻辑（`writeAgentConfig`）可以保留在 gateway 侧，因为只有网关需要写配置。

---

## 2. 日志全局状态跨模块耦合

**涉及文件**: `shared/agent/start.js`、`config_loader.js`、`default_agent.js`、`server.js`、`message_manager.js`

**问题**: 每个模块都有独立的 `let logFileName` 变量和 `export function setXxxLogFileName()` setter，`start.js` 启动时逐个调用：

```js
setConfigLogFileName(logFileName);
setAgentLogFileName(logFileName);
setServerLogFileName(logFileName);
setMessageManagerLogFileName(logFileName);
```

每新增一个需要日志的模块就要加一对 setter，是隐式全局状态。

**方向**: `startAgent()` 中创建统一的 logger 实例，注入给各模块的构造函数。或使用 `AsyncLocalStorage` 传递日志上下文。

---

## 3. Token 估算精度问题

**涉及文件**: `shared/agent/message_manager.js` → `estimateTokens()`

**问题**: `content.length / 4` 对中文极不准确。英文 1 char ≈ 0.25 token，中文 1 char ≈ 1.5 token，偏差可达 6 倍。当 `memoryTokenLimit` 设为 8000，实际可能 16000+ tokens 才触发压缩，压缩频率远低于预期。

**方向**: 至少按字符类型加权估算。更精确的方案是引入 `tiktoken` 或类似的 tokenizer，但会增加依赖。

---

## 4. 缺少请求级日志追踪 ID

**问题**: 日志以模块为粒度（`createLogger('agent-main', logFileName)`），没有请求 ID 贯穿 Agent Loop 的各个阶段。当多个请求并发排队时，排查问题难以关联同一请求的完整链路。

**方向**: 在 `enqueueRequest` 时生成 `requestId`，注入到 Agent、MessageManager、LLMModel 的日志调用中。

---

## 5. LLM 调用无重试机制

**涉及文件**: `shared/agent/llm_model.js`

**问题**: 遇到 429（限流）、5xx（临时服务端错误）或网络瞬时故障直接抛错，Agent Loop 终止。生产环境中这类错误概率不低。

**方向**: 至少对 429/5xx 做一次指数退避重试（1s → 2s），在 `chatStream()` 和 `chat()` 中加入 `maxRetries` 参数。

---

## 6. ChatProxy 职责过重

**涉及文件**: `gateway/chat_proxy.js`

**问题**: `proxyChat` 函数 160+ 行，承担了"HTTP 代理 + SSE 事件解析 + 聊天历史写入 + 订阅者广播 + 生命周期管理"五重职责。`buildBubblesFromContext` 也有近 60 行事件到 UI 模型的转换逻辑。

**方向**: 将 SSE 事件解析逻辑（事件 → bubbles/历史记录）抽取为独立模块，`proxyChat` 只负责代理和广播。
