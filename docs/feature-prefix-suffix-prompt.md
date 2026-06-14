# prefix_prompt / suffix_prompt 功能改造（elf-001 专属）

> 本功能为 elf-001 agent 的特有行为，不涉及 shared 模块或 gateway 的通用改动。

## 行为定义

- `prefix_prompt` 和 `suffix_prompt` 为可配置字符串，拼接在**最后一条** `role: 'user'` 消息的 content 前后
- 拼接公式：`content = prefix_prompt + original_content + suffix_prompt`
- 仅在 `getMessagesForLLM()` 时动态拼接，`context.json` 始终存储裸内容
- 上一轮的 user 消息在下一轮自动恢复为裸内容（因为存的就是裸的），只有最新的 user 消息会被包装
- Agent loop 多轮迭代（tool calls）期间，最后一条 user 消息始终被拼接，符合预期
- 空字符串 = 不生效，无需额外开关

## 改动范围

仅改动 `agents/elf-001/` 下的文件，gateway 和 shared 不动。

### 1. agents/elf-001/config/config.json

新增字段和 UI 元数据：

```json
"prefix_prompt": "",
"suffix_prompt": "",
"_ui": {
  "prefix_prompt": { "label": "前缀提示词", "hint": "附加在用户最新输入之前，仅发送给 LLM 时拼接，不写入记忆" },
  "suffix_prompt": { "label": "后缀提示词", "hint": "附加在用户最新输入之后，仅发送给 LLM 时拼接，不写入记忆" }
}
```

### 2. agents/elf-001/message_manager.js

- 构造函数新增 `this.prefixPrompt = ''`、`this.suffixPrompt = ''`
- 新增 `setPrefixPrompt(v)`、`setSuffixPrompt(v)` 方法
- `getMessagesForLLM()` 中从后往前找到最后一条 `role: 'user'`，用 `prefixPrompt + content + suffixPrompt` 替换该条消息的 content（浅拷贝，不修改原数组元素）

### 3. agents/elf-001/index.js

- 启动时从 config 读取 `prefix_prompt`/`suffix_prompt`，传入 MessageManager
- `fs.watch` 热更新回调中，检测到变更时调用 `messageManager.setPrefixPrompt()` / `setSuffixPrompt()`

### 4. agents/elf-001/config/config-ui.html（新建）

elf-001 专属自定义配置页面，覆盖 gateway 的默认生成逻辑。三个标签页：

| 标签 | 字段 |
|------|------|
| **提示词配置** | systemPrompt (textarea)、prefix_prompt (textarea)、suffix_prompt (textarea) |
| **Agent 配置** | name、memoryTokenLimit、maxIterations 等 |
| **模型配置** | base_url、auth_token、model |

提示词配置为默认激活标签页。

### 不需要改动的部分

- **gateway/** — `prefix_prompt`/`suffix_prompt` 是普通 top-level 字段，PUT config 的现有 merge 逻辑天然支持
- **gateway/config-ui.js** — elf-001 提供 `config-ui.html` 后，gateway 直接使用自定义页面，不再走默认生成

## 时序验证

```
轮次1: user="haha"
  context.json 存储: {"role":"user","content":"haha"}
  getMessagesForLLM(): {"role":"user","content":"<prefix>haha<suffix>"}

轮次2: user="ohoh"
  context.json 存储: {..., {"role":"user","content":"haha"}, ..., {"role":"user","content":"ohoh"}}
  getMessagesForLLM(): {..., {"role":"user","content":"haha"}, ..., {"role":"user","content":"<prefix>ohoh<suffix>"}
                          ↑ 裸内容                    ↑ 拼接
```