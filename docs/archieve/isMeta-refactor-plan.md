# isMeta 改造方案

> 目标:为 elf 消息模块引入 isMeta 机制,使系统注入消息(如 skill 清单、context 提示)在 compact 后可恢复,同时不干扰用户中断检测和前端渲染。
> 日期:2026-07-07

---

## 0. 为什么需要 isMeta

elf 当前 `addUserMessage(content)` 没有区分"用户真正说的"和"系统注入的"。所有 user 消息一视同仁。

随着功能增加(skill 清单注入、context 提示、日期变更等),会出现以下问题:

| 问题 | 没有 isMeta 的后果 | 有 isMeta 的解法 |
|:--|:--|:--|
| compact 后系统信息丢失 | skill 清单、context 等被摘要吞掉,模型看不到 | 标记 isMeta,compact 后按 tag 重推 |
| 前端误渲染系统消息 | skill 清单出现在聊天流里像用户说的 | 前端过滤 isMeta 消息 |
| LLM API 收到多余字段 | isMeta:true 发给 API(虽被忽略但不优雅) | getMessagesForLLM 剥离 isMeta |

但**现在不急着做所有事**。本方案聚焦最小必要改动,让 isMeta 机制先落地,后续功能(skill 清单、context 注入等)再挂上来。

---

## 1. 改动清单

### 1.1 `shared/agent/message_manager.js` — 核心改动

**现状**:
```js
addUserMessage(content) {
    this.messages.push({ role: 'user', content });
    this._save();
}
```
所有 caller 直接 push `{role, content}`,没有 isMeta 概念。`getMessagesForLLM()` 用 `{ ...m }` 浅拷贝,会把所有字段(包括 isCompactSummary)原样发给 LLM。

**改动**:

#### (a) addUserMessage 增加 isMeta 参数

```js
addUserMessage(content, isMeta = false) {
    this.messages.push({ role: 'user', content, ...(isMeta ? { isMeta: true } : {}) });
    this._save();
}
```

向后兼容:现有所有 caller 不传 isMeta,默认 false,行为不变。只有新代码显式传 `true` 才标记。

#### (b) 新增 addMetaMessage 方法

```js
/**
 * 添加系统元消息(harness 注入,非用户输入)。
 * 语义:这条消息不是用户说的,是系统注入到 user channel 的提示。
 * compact 后会被消除,需要按 tag 重推。
 */
addMetaMessage(content, tag) {
    this.messages.push({ role: 'user', content, isMeta: true, metaTag: tag });
    this._save();
}
```

`tag` 是字符串标识(如 `'skill_listing'`, `'context'`, `'date_change'`),用于 compact 后按 tag 重建。

#### (c) getMessagesForLLM 剥离 isMeta 和 metaTag

```js
getMessagesForLLM() {
    const systemMsg = { role: 'system', content: this.systemPrompt };
    const msgs = this.messages.map(m => {
        const { isMeta, metaTag, ...rest } = m;
        return rest;
    });
    return [systemMsg, ...msgs];
}
```

确保 `isMeta` 和 `metaTag` 不发给 LLM API。

#### (d) compact 后标记需要重推

```js
// compactIfNeeded 中,替换 messages 时设置标记
this.messages = [{ role: 'user', content: SUMMARY_PREAMBLE + summary, isCompactSummary: true }];
this._compactHappened = true;  // 新增:标记 compact 刚发生过
this._save();
```

#### (e) 新增 getCompactHappened 方法

```js
/**
 * compact 后调用，返回 compact 是否刚发生。
 * 调用即消费（重置为 false），避免重复触发。
 *
 * @returns {boolean}
 */
getCompactHappened() {
    const happened = this._compactHappened === true;
    this._compactHappened = false;
    return happened;
}
```

**设计决策**:MessageManager 只提供"compact 是否刚发生"的信号,**不负责**决定重推什么内容。重推内容(skill 清单、context 等)由外层(agent 主循环或专门模块)根据当前状态重新生成后调用 `addMetaMessage`。

理由:
- MessageManager 不应该知道 skill 系统的存在(单一职责)
- 重推的内容可能随时间变化(conditional skill 激活、context 更新),需要用最新状态生成
- 保持 MessageManager 的通用性,不耦合具体功能

#### (f) estimateTokens 不变

```js
estimateTokens() {
    // 不变:isMeta 消息也占 token,列入选旧估算
    // 只有 getMessagesForLLM 剥离字段,estimateTokens 按原始 messages 估算
}
```

---

### 1.2 `shared/agent/default_agent.js` — 调用 compact 后重推

**现状**:reasoning 循环顶部和底部各有一处 `yield* compactIfNeeded`，都没有 compact 后重推逻辑。

**改动**:两处都从 `yield*` 改为 `for await...of`，拦截 compact 事件并调用 `_reinjectMetaMessages`。

**改动**:

```js
// compactIfNeeded 从 yield* 改为 for await...of，拦截 compact 事件
try {
  for await (const event of this.messageManager.compactIfNeeded(this.model, { signal: this._abortController.signal })) {
    yield event;
    // && 短路求值：只有 compact 事件才消费 _compactHappened 标记
    if (event.event === 'compact' && this.messageManager.getCompactHappened()) {
      await this._reinjectMetaMessages();
    }
  }
  this._abortController = null;
} catch (err) { ... }
```

新增 `_reinjectMetaMessages` 方法:

```js
/**
 * compact 后重推系统注入消息。
 * 具体重推什么由子类或模块决定。
 * 基类默认空实现,elf-002 可覆写。
 */
async _reinjectMetaMessages() {
    // 基类空实现
    // 未来 skill/context 模块在此挂载
}
```

---

### 1.3 `agents/elf-002/message_manager.js` — 适配覆写

**现状**:override 了 `getMessagesForLLM`, `estimateTokens`, `compactIfNeeded`, `updateConfig`, `reloadFromDisk`。

**改动**:

- `getMessagesForLLM`:不调 super(现状如此),在自己的 `{ ...m }` 浅拷贝后剥离 isMeta/metaTag:
  ```js
  getMessagesForLLM() {
    this._enforceBudgetWindow();
    const systemMsg = { role: 'system', content: this.systemPrompt };
    const msgs = this.messages.map(m => {
      const { isMeta, metaTag, ...rest } = m;
      return rest;
    });
    return [systemMsg, ...msgs];
  }
  ```
- `compactIfNeeded`:在 `this.messages = [{...isCompactSummary}]` 后加 `this._compactHappened = true;`。
- `reloadFromDisk`:重置 `_compactFailCount` / `_compactDisabled` 之外,也重置 `_compactHappened = false;`。
- `_enforceBudgetWindow`:不受 isMeta 影响(isMeta 消息也占预算)。
- `estimateTokens`:不受 isMeta 影响(直接读 this.messages,不计 metaTag)。

**注意**:基类和 elf-002 的 `getMessagesForLLM` 都有 `{ ...m }` 浅拷贝 + 剥离逻辑,目前不能抽成公共方法(因为 elf-02 在拷贝前要先跑 `_enforceBudgetWindow`)。后续可以重构为:基类的 `getMessagesForLLM` 先剥离 isMeta,子类再 override。但本轮先保持最小改动。

---

### 1.4 `gateway/chat_history.js` — 写入过滤

**现状**:`addMessage(agentId, role, content, toolCalls, extraFields)` 只记 `user` / `assistant` 角色,不记 `system`。

**改动**:

写入 history.jsonl 时,过滤 `isMeta: true` 的消息——**不写入 history.jsonl**。

```js
addMessage(agentId, role, content, toolCalls, extraFields) {
    // isMeta 消息不写入 history(不是用户真正说的,不需要持久化到展示层)
    if (extraFields?.isMeta) return null;
    // ...原有逻辑
}
```

---

### 1.5 `gateway/chat_proxy.js` — 无改动

现有 `flushRoundToHistory` 和 SSE 事件处理不动。compact 事件(compactLoading/compactSummary/compactError)写入 history.jsonl 的逻辑保持不变(它们通过 extraFields 字段走,不走 isMeta)。

---

### 1.6 `frontend/` — 渲染过滤(可选,后续)

**现状**:`historyToTurns` 过滤 `role === 'system'`。

**改动(后续)**:当 isMeta 消息因 bug 写入了 history.jsonl 时,前端也应过滤。但只要 1.4 正确实现(写入时过滤),前端不需要额外改动。

---

## 2. 不改的地方

| 模块 | 为什么不改 |
|:--|:--|
| `default_agent.js` 的 `addUserMessage(message)` 调用 | 这是用户真正的输入,永远 `isMeta=false`,不需要传参 |
| `addAssistantMessage` / `addAssistantToolCalls` / `addToolResult` | LLM 产出和工具结果,语义明确不是 isMeta |
| `history.jsonl` 的 _mergeCompactRecords | compact 事件通过 extraFields 走,不受 isMeta 影响 |
| 前端渲染组件 | isMeta 消息不进 history.jsonl,前端自然看不到 |
| `context.json` 的持久化 | isMeta 消息需要写入 context.json(因为 compact 后重推需要原消息),这是对的 |

---

## 3. 改动文件清单

| 文件 | 改动 |
|:--|:--|
| `shared/agent/message_manager.js` | (a) addUserMessage 加 isMeta 参数;(b) 新增 addMetaMessage;(c) getMessagesForLLM 剥离 isMeta/metaTag;(d) compact 后设 _compactHappened;(e) 新增 getCompactHappened() |
| `shared/agent/default_agent.js` | reasoning 循环中 compact 后调 _reinjectMetaMessages;(f) 新增 _reinjectMetaMessages 空方法 |
| `agents/elf-002/message_manager.js` | getMessagesForLLM 剥离 isMeta/metaTag;compact 中设 _compactHappened;reloadFromDisk 重置 _compactHappened |
| `gateway/chat_history.js` | addMessage 开头过滤 isMeta:true |

---

## 4. 边界情况与设计决策

### 4.1 compact 摘要请求中 isMeta 消息的处理

elf-02 的 `compactIfNeeded` 手拼摘要请求:`[{system}, ...messages, {user:compactPrompt}]`。这里 `...this.messages` 会包含 isMeta 消息。

**决策:isMeta 消息应该参与摘要**,因为它们是模型上下文的一部分(skill 清单、context 提示等)。摘要后 isMeta 消息被消除,靠重推恢复。

摘要请求发给 LLM 时,isMeta/metaTag 字段也会跟着 `{...m}` 扩展进去,但 LLM API 会忽略未知字段,无影响。如果想更干净,可以在拼 summaryRequest 时也剥离,但不是必须——本轮不做。

### 4.2 context.json 包含 isMeta 消息

`_save()` 全量写回 `this.messages`,isMeta 消息会写入 context.json。这是对的:
- compact 后重推需要知道"要推什么"(虽然当前方案是外层决定,但 context.json 保留完整历史有利于 rewind)
- rewind 恢复时,context.json 中的 isMeta 消息会被重新加载

### 4.3 `_enforceBudgetWindow` 与 isMeta

elf-02 的 `_enforceBudgetWindow` 只过滤 `role === 'tool'` 的消息,不涉及 isMeta。isMeta 的 user 消息不参与 budget window 计算(因为 budget 只管 tool 结果)。无需改动。

### 4.4 多次 compact 与重推

compact 可能触发多次(压缩后仍超阈值,下一轮再压)。`_compactHappened` 在 `getCompactHappened()` 调用后重置为 false,避免重复触发。每次 compact 后只重推一次。

### 4.5 _cleanupToolResults 与 isMeta

elf-02 的 `_cleanupToolResults()` 在 compact 成功后清空 tool-results 目录。isMeta 消息不含 tool_results,不受影响。

---

## 5. 验证

1. **向后兼容**:所有现有 caller 不传 isMeta,默认 false,行为不变
2. **LLM API 不收多余字段**:调用 getMessagesForLLM 后验证输出不含 isMeta/metaTag
3. **context.json 包含 isMeta**:addMetaMessage 后 _save,验证 context.json 中有 isMeta:true
4. **history.jsonl 不包含 isMeta**:addMetaMessage 后,验证 history.jsonl 中无对应记录
5. **compact 后重推**:手动触发 compact,验证 _compactHappened 为 true,调用 _reinjectMetaMessages 后消息恢复
6. **前端渲染不变**:isMeta 消息不入 history.jsonl,前端无感知