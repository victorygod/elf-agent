# prefix_prompt / suffix_prompt 功能

> elf-001 专属功能，通过自定义 MessageManager 实现，不涉及 shared 模块。

## 行为定义

- `prefix_prompt` 和 `suffix_prompt` 为可配置字符串，拼接在**最后一条** `role: 'user'` 消息的 content 前后
- 拼接公式：`content = prefix_prompt + original_content + suffix_prompt`
- 仅在 `getMessagesForLLM()` 时动态拼接，`context.json` 始终存储裸内容
- 上一轮的 user 消息在下一轮自动恢复为裸内容（因为存的就是裸的），只有最新的 user 消息会被包装
- Agent loop 多轮迭代（tool calls）期间，最后一条 user 消息始终被拼接，符合预期
- 空字符串 = 不生效，无需额外开关

## 实现方式

通过 `config.json` 的 `messageManagerClass` 字段激活 elf-001 专属的 MessageManager 子类：

### agents/elf-001/message_manager.js

继承 `shared/agent/message_manager.js` 的 `MessageManager`，扩展三个能力：

1. **构造函数**：从 `config` 对象读取 `prefix_prompt` / `suffix_prompt`
2. **updateConfig()**：热更新时从 `config` 重读值（`reloadConfig()` 先调用 `config.load()` 再调用 `updateConfig()`，因此 config 已是最新的）
3. **getMessagesForLLM()**：调用 `super.getMessagesForLLM()` 后，对最后一条 user 消息拼接前后缀

```js
import { MessageManager as BaseMessageManager } from '../../shared/agent/message_manager.js';

export class MessageManager extends BaseMessageManager {
  constructor(params) {
    super(params);
    this._config = params.config || null;
    this.prefixPrompt = this._config?.get('prefix_prompt') || '';
    this.suffixPrompt = this._config?.get('suffix_prompt') || '';
  }
  updateConfig(params) {
    super.updateConfig(params);
    if (this._config) {
      this.prefixPrompt = this._config.get('prefix_prompt') || '';
      this.suffixPrompt = this._config.get('suffix_prompt') || '';
    }
  }
  getMessagesForLLM() {
    const msgs = super.getMessagesForLLM();
    const prefix = this.prefixPrompt || '';
    const suffix = this.suffixPrompt || '';
    if (prefix || suffix) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          msgs[i].content = prefix + msgs[i].content + suffix;
          break;
        }
      }
    }
    return msgs;
  }
}
```

### agents/elf-001/config/config.json

```json
"messageManagerClass": "message_manager",
"prefix_prompt": { "type": "path", "content": "prefix_prompt.md" },
"suffix_prompt": { "type": "path", "content": "suffix_prompt.md" }
```

### 激活流程

1. `default_agent.js` 的 `fromConfigDir()` 读取 `messageManagerClass` 字段
2. `_loadModuleClass('message_manager', configDir)` 查找 `agents/elf-001/message_manager.js`（优先于 `shared/agent/message_manager.js`）
3. 用 `mmParams`（含 `config` 引用）实例化 elf-001 的 `MessageManager`
4. `getMessagesForLLM()` 自动拼接前后缀

### 不涉及的模块

- **shared/agent/** — 基类 `MessageManager` 不感知 prefix/suffix，不含任何相关逻辑
- **gateway/** — `prefix_prompt`/`suffix_prompt` 是普通字段，`type:"path"` 机制通用处理
- **start.js** — 无需修改

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

## 其他 Agent 如何实现类似功能

如果另一个 Agent 也需要专属的消息处理逻辑：

1. 在 Agent 目录下创建 `message_manager.js`，继承 `shared/agent/message_manager.js`
2. 在 `config.json` 中添加 `"messageManagerClass": "message_manager"`
3. `mmParams` 中的 `config` 引用可读取任意自定义字段