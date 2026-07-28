# Engine 目录结构调整计划

## 目标

将 `engine/` 顶层 17+ 个散文件按职责归组到子目录，降低平铺文件数量，提升可维护性。**不改动任何业务逻辑，仅调整文件路径和 import 引用。**

## 调整内容

### 1. `models/` — LLM 模型层

| 原文件 | 新路径 | 说明 |
|--------|--------|------|
| `engine/llm_model.js` | `engine/models/llm.js` | OpenAI 兼容 API 调用 |
| `engine/mock_model.js` | `engine/models/mock.js` | 测试用 Mock，与 LLMModel 接口一致 |
| *(新增)* | `engine/models/index.js` | 统一 re-export 两个类 |

**index.js 内容：**
```js
export { LLMModel } from './llm.js';
export { MockModel } from './mock.js';
```

### 2. `prompt/` — Prompt 拼装层

| 原文件 | 新路径 | 说明 |
|--------|--------|------|
| `engine/prompt_assembler.js` | `engine/prompt/assembler.js` | Prompt 拼装器 + 注入器槽位机制 |
| `engine/prompt_injectors.js` | `engine/prompt/injectors.js` | prefix/suffix 注入器 |
| *(新增)* | `engine/prompt/index.js` | 统一 re-export |

**index.js 内容：**
```js
export { PromptAssembler } from './assembler.js';
export { registerPrefixSuffixInjectors } from './injectors.js';
```

### 3. `plugins/` — 场景插件层

| 原文件 | 新路径 | 说明 |
|--------|--------|------|
| `engine/scene_plugin.js` | `engine/plugins/scene_plugin.js` | 场景插件基类 |
| `engine/private_chat_plugin.js` | `engine/plugins/private_chat_plugin.js` | 私聊插件 |
| `engine/room_plugin.js` | `engine/plugins/room_plugin.js` | 群聊插件 |

> 此处不设 index.js，因为三个插件没有统一的 re-export 需求，各自独立被 `start.js` 按需 import。

### 4. `default_agent.js` → `agent.js` 重命名

文件名改为 `engine/agent.js`，与 `build_agent.js` 形成 `build_agent` → `agent` 的对称命名。

---

## 受影响的文件及改动

| 文件 | 改动类型 | 具体改动 |
|------|---------|---------|
| `engine/build_agent.js` | import 路径变更 | `./llm_model.js` → `./models` / `./mock_model.js` → `./models` / `./default_agent.js` → `./agent` / `./prompt_assembler.js` → `./prompt` / `./prompt_injectors.js` → `./prompt` |
| `engine/default_agent.js` → `engine/agent.js` | 文件重命名 | 文件物理重命名，内容不变 |
| `engine/start.js` | import 路径变更 | `./default_agent.js` → `./agent` |
| `engine/private_chat_plugin.js` | import 路径变更 | `./scene_plugin.js` → `./plugins/scene_plugin` |
| `engine/room_plugin.js` | import 路径变更 | `./scene_plugin.js` → `./plugins/scene_plugin` |
| `engine/server.js` | **无改动** | 不 import 上述任何文件 |

> 共 **5 个文件**需要改 import 路径（`build_agent.js`、`start.js`、`private_chat_plugin.js`、`room_plugin.js`），加 1 个文件重命名。

---

## 测试是否需要改

**需要修改。** 纠正早期判断——测试文件**大量直接 import** 这些 engine 内部模块：

- `mock_model` / `llm_model`：10 个测试文件直接 import
- `default_agent`：9 个测试文件直接 import `Agent`
- `room_plugin`：6 个测试文件 import `RoomMiddleware`；`sync_source.test.js` import `PrivateChatMiddleware`
- `prompt_assembler` / `prompt_injectors`：3 个测试文件；另 3 个 `agents/elf-00x/create_agent.js` import `registerPrefixSuffixInjectors`

因此引用路径必须一并更新（机械替换），并通过 barrel `models/index.js` / `prompt/index.js` 收敛入口。

⚠️ **关键教训**：移动文件时除"谁 import 它"外，还要修**文件内部**的相对 import 深度。本次三个 plugin 文件移入 `plugins/` 后，内部的 `./sync_source.js` → `../sync_source.js`、`../shared/logger.js` → `../../shared/logger.js` 必须同步改，否则 `ERR_MODULE_NOT_FOUND`。

---

## 执行顺序

1. 创建三个子目录：`models/`、`prompt/`、`plugins/`
2. 移动文件并重命名：
   - `llm_model.js` → `models/llm.js`
   - `mock_model.js` → `models/mock.js`
   - `prompt_assembler.js` → `prompt/assembler.js`
   - `prompt_injectors.js` → `prompt/injectors.js`
   - `scene_plugin.js` → `plugins/scene_plugin.js`
   - `private_chat_plugin.js` → `plugins/private_chat_plugin.js`
   - `room_plugin.js` → `plugins/room_plugin.js`
   - `default_agent.js` → `agent.js`
3. 创建 `models/index.js` 和 `prompt/index.js`（re-export）
4. 修改 5 个文件的 import 路径
5. `build_agent.js` 中删除"阶段二"注释（已落地）
6. `git add -A` 追踪，提交

---

## 调整后目录结构

```
engine/
  start.js
  server.js
  harness.js
  abort_flow.js
  run_context.js
  config_loader.js
  message_manager.js
  sync_source.js
  room_state.js
  build_agent.js
  agent.js                    ← 重命名自 default_agent.js
  models/
    index.js
    llm.js
    mock.js
  prompt/
    index.js
    assembler.js
    injectors.js
  plugins/
    scene_plugin.js
    private_chat_plugin.js
    room_plugin.js
  skills/                     ← 保持不变
  tools/                      ← 保持不变
```

顶层从 17+ 文件精简到 11 个文件 + 4 个子目录，结构更清晰。

---

## 执行结果（已完成）

- ✅ 8 个文件经 `git mv` 迁移（保留 history），新建 `models/index.js`、`prompt/index.js` 两个 barrel。
- ✅ 更新引用：engine 内部 4 文件（`agent.js`/`build_agent.js`/`start.js`/`room_state.js`）+ 3 个 `agents/*/create_agent.js` + 全部 test 文件。
- ✅ 修正移动后插件内部相对 import（`sync_source`、`shared/logger` 深度 +1）。
- ✅ 验证：`node --test` 全量 **509 tests, 0 fail**。