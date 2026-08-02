# 基类压缩升级提纲：保留最近 1 group + 非阻塞后台压缩

> 目标：升级 `shared/agent/message_manager.js` 基类的 `compactIfNeeded`，从 naive 全量替换改成「保留最近 1 个 group + 摘要老历史」，并支持非阻塞后台压缩（压缩期间可继续对话）。elf-002 不动（继续 override 阻塞版）；elf-001/003 自动用新基类。
> 状态：决策已定，待实现。

---

## 1. 设计决策（全定）

| 项 | 决策 |
|---|---|
| 函数数量 | **一个 `compactIfNeeded`** + config 开关 `compactMode` 切模式。不分两个函数 |
| 压缩核心 | 抽内部方法 `_doCompact`（切group/摘要/返回结果），阻塞/非阻塞共用一份逻辑 |
| 保留量 | 固定保留最近 1 个 group（s=1） |
| group 切分 | `_groupByAssistantTurn` 上提基类，**每条 assistant 切**（通用版）；elf-002 保留自己的 override（带 tool_calls 切）覆盖基类 |
| 阻塞/非阻塞 | config `compactMode: "blocking"|"async"`，默认 `async`。elf-002 配 `blocking` |
| anchor（swap 定位） | **给 context.json 的 messages 加 `id` 字段**（`msg_<ts>_<rand>`，agent 进程内 push 时生成）。group 首条消息的 id 作 anchor，swap 时 `messages.find(m=>m.id===anchorId)` 零碰撞 |
| history.jsonl id | **不动、不对齐**。history.jsonl 的 id 是 gateway 写展示层时自生成、只记 user/assistant、不含 tool；context.json messages 全角色。两套服务对象不同、不互通 |
| 老摘要(isCompactSummary) | 作为普通消息参与（不排除），对齐 CC |
| L1/L2/microcompact | **不加**基类 |
| 断路器 | 基类加（连续 3 次失败禁用） |
| 解析 | naive：不强制解析 `<summary>`，直接用整段回复（子类可 override 解析版） |
| 续写指令 | 基类加 `CONTINUATION_CLAUSE` |
| 失败重试 | **不立即重试**。后台失败设标志、下一轮自然再试（下一轮 loop 顶部 compactIfNeeded 还会被调、还超阈值就再启后台）。直到断路器 3 次禁用 |
| 后台不重触发 | **统一判 `_bgRunning`**：任何轮次（循环内 / done 前）只要后台在跑，不启新压缩、不发 compact_start、本轮正常回复 |
| elf-002 | **不动**（override 阻塞版、含 L1/L2/microcompact、config 配 blocking） |

---

## 2. 消息加 id（anchor 基础）

### 2.1 为什么加

非阻塞 swap 时，压缩期间 messages 会变（主 loop 又加消息）。要定位"压缩启动时保留 group 的首条消息"、从它往后全保留。用 id 最稳、零碰撞。

### 2.2 加在哪

**context.json 的 messages 数组**（`MessageManager.messages`）。`addUserMessage`/`addAssistantMessage`/`addAssistantToolCalls`/`addToolResult`/`addMetaMessage` push 时生成 id：

```js
_genMsgId() { return `msg_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`; }

addUserMessage(content, isMeta=false) {
  this.messages.push({ id: this._genMsgId(), role: 'user', content, ...(isMeta ? {isMeta:true} : {}) });
  this._save();
}
// 其他 add* 同理加 id
```

### 2.3 为什么不和 history.jsonl 对齐

| 维度 | context.json messages | history.jsonl |
|---|---|---|
| 角色 | 全角色（user/assistant/tool/system） | 只 user/assistant（不含 tool/system） |
| id 生成 | agent 进程内 push 时 | gateway 写展示层时 |
| 用途 | 给 LLM、压缩操作、anchor | 前端分页游标 |
| 切分 | message_manager 按 assistant 切 group | 不切 group（一条一记录） |

两套服务对象不同、id 各自独立生成。**强行对齐无收益**（group 首条常是 tool_call assistant，history 里没这条 tool）。各自 `msg_<ts>_<rand>` 格式即可。

### 2.4 发给 LLM 时 strip id

`getMessagesForLLM` 把 id 从消息里去掉（LLM API 不接受额外字段）。现状已在 strip `isMeta/metaTag`，加 `id` 一起 strip：

```js
getMessagesForLLM() {
  const systemMsg = { role: 'system', content: this.systemPrompt };
  const msgs = this.messages.map(m => {
    const { id, isMeta, metaTag, ...rest } = m;
    return rest;
  });
  return [systemMsg, ...msgs];
}
```

### 2.5 兼容旧 context.json

`_load` 读旧 messages（无 id）时，给每条补生成 id（向后兼容）。

---

## 3. 阻塞 vs 非阻塞：一个函数 + 开关

### 3.1 不分两个函数的理由

阻塞和非阻塞的**压缩逻辑完全一样**（保留最近 1 group、摘要其余），只是调度方式不同：阻塞 `await` 压完、非阻塞 fire-and-forget。差异在"怎么调 `_doCompact`"。所以一个 `compactIfNeeded` + config 开关，核心 `_doCompact` 共用。

### 3.2 config 开关

```json
// elf-002 config（保持阻塞现状）
"compactMode": "blocking"

// elf-001/003（用新非阻塞）
不配 → 默认 "async"
```

### 3.3 后台不重触发（统一判 _bgRunning）

```
轮 N（超阈值、_bgRunning=false）:
  compactIfNeeded → 启后台 → yield compact_start → return（不等）
  立即 getMessagesForLLM → 正常回复

轮 N+1, N+2...（_bgRunning=true）:
  compactIfNeeded → return（不启、不 yield、正常回复）
  （若后台已失败设了 _bgFailed → 本轮 yield compact_error + 清标志 + 下一轮可再启）

轮 M（后台跑完 _bgDone=true）:
  compactIfNeeded → _applyBgResult（swap）→ yield compact
  _bgRunning 清 → 若还超阈值、下一轮可启新后台
```

**done 前兜底也同理**：`_bgRunning` 就不启、done 直接发。

---

## 4. 核心逻辑

### 4.1 `_doCompact`（压缩核心，阻塞/非阻塞共用）

```js
async _doCompact(llmModel, options) {
  const groups = this._groupByAssistantTurn();
  if (groups.length < 2) return null;                          // too_few_groups

  const preserveGroup = groups[groups.length - 1];            // 保留最近 1 group
  const summaryGroups = groups.slice(0, -1);                   // 老（送摘要）

  // anchor：保留 group 首条消息的 id
  const anchorId = preserveGroup[0].id;

  const summaryRequest = [
    { role: 'system', content: this.compactSystemPrompt || this.systemPrompt || '' },
    ...summaryGroups.flat().map(m => ({ ...m })),
    { role: 'user', content: this.compactPrompt }
  ];

  const response = await llmModel.chat(summaryRequest, { enable_thinking: false, ...options });
  const summary = this._parseOrRaw(response);                  // naive: 直接用回复
  if (!summary) return null;

  return { summary, anchorId };
}
```

### 4.2 `compactIfNeeded`（一个函数、两模式）

```js
async *compactIfNeeded(llmModel, options = {}) {
  if (this.estimateTokens() <= this.memoryTokenLimit) return;
  const async = (this._config?.get('compactMode') || 'async') === 'async';

  // 后台失败待报（上一轮后台 catch 设的标志）
  if (this._bgFailed) {
    this._bgFailed = false;
    yield { event: 'compact_error', data: { error: '记忆压缩失败' } };
  }

  if (async) {
    if (this._bgRunning) return;                                // 后台在跑 → 不重触发
    if (this._compactDisabled) return;                          // 断路器
    this._bgRunning = true;
    this._bgDone = false;
    this._bgPromise = this._doCompact(llmModel, options)
      .then(r => { this._bgResult = r; this._bgDone = true; })
      .catch(() => { this._bgRunning = false; this._bgFailed = true; this._recordFailure(); });
    yield { event: 'compact_start', data: {} };
    return;                                                     // 不等
  }

  // 阻塞
  if (this._compactDisabled) return;
  yield { event: 'compact_start', data: {} };
  try {
    const r = await this._doCompact(llmModel, options);
    if (!r) { this._recordFailure(); return; }
    this._applyResultSync(r);                                   // 同步 swap（messages 没变）
    yield { event: 'compact', data: { tokenEstimate: this.estimateTokens() } };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    this._recordFailure();
  }
}
```

### 4.3 应用结果（swap）

**同步（阻塞模式）**：messages 没变，anchor 直接是当时 preserveGroup：
```js
_applyResultSync({ summary, anchorId }) {
  const idx = this.messages.findIndex(m => m.id === anchorId);
  this.messages = [
    { id: this._genMsgId(), role: 'user', content: SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + summary, isCompactSummary: true },
    ...this.messages.slice(idx)
  ];
  this._save();
}
```

**异步（非阻塞模式）**：压缩期间 messages 变了。按 anchorId 找保留 group 首条、从它往后全保留（含压缩期间新加的）：
```js
_applyBgResult() {
  const { summary, anchorId } = this._bgResult;
  this._bgRunning = false; this._bgDone = false; this._bgResult = null;

  const idx = this.messages.findIndex(m => m.id === anchorId);
  if (idx === -1) { this._recordFailure(); return; }           // anchor 没了（理论不会）

  this.messages = [
    { id: this._genMsgId(), role: 'user', content: SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + summary, isCompactSummary: true },
    ...this.messages.slice(idx)                                 // anchor 往后全保留
  ];
  this._save();
  yield { event: 'compact', data: { tokenEstimate: this.estimateTokens() } };
}
```

### 4.4 group 切分（基类通用版）

```js
_groupByAssistantTurn() {
  const groups = [];
  let current = [];
  for (const msg of this.messages) {
    const isNewTurn = msg.role === 'assistant' && current.length > 0;
    if (isNewTurn) { groups.push(current); current = [msg]; }
    else { current.push(msg); }
  }
  if (current.length) groups.push(current);
  return groups;
}
```

> 每条 assistant 切（不管有无 tool_calls）——适用 elf-001/003 纯文本对话。
> elf-002 override 成"带 tool_calls 才切"，覆盖基类。

---

## 5. 前端气泡处理

### 5.1 现状机制（不改）

后端事件 → 前端 useChat.js：
- `compact_start` → 新建 `compactLoading: true` 气泡
- `compact` → 气泡改 `compactSummary`（成功）
- `compact_error` → 气泡改 `compactError`（失败）

### 5.2 非阻塞模式的气泡行为

```
轮 N: 后端 compact_start → 前端"压缩中"气泡
轮 N+1..M-1: 后端不发 compact 事件（_bgRunning 不重触发）→ 气泡常驻"压缩中"
            用户可继续讲话、正常回复气泡在"压缩中"气泡之后
轮 M: 后端 compact → 前端"压缩中"改"压缩成功"
```

### 5.3 要处理的点

1. **气泡常驻**：现状已支持（建了不改、直到 compact/error 收尾）。
2. **后端不发重复 compact_start**：`_bgRunning` 时不 yield compact_start（§4.2 已保证）。
3. **后台失败延迟报**：后台 catch 设 `_bgFailed`，下一轮 compactIfNeeded yield `compact_error`。前端收到、气泡改"失败"。
4. **压缩中气泡 + 正常回复气泡共存**：确认 MessageBubble 渲染能正确显示"压缩中气泡 + 后续正常回复气泡"并存（不互相覆盖）。
5. **aborted**：用户在压缩中点停止 → aborted 事件把压缩中气泡标"已终止"（现状已处理 line 275-296）；后台压缩任务传 abort signal 中止。

### 5.4 前端改动量

- useChat.js：基本不动（已是"建气泡→等收尾"模型）
- 加：compact_start 重复保护兜底（后端已保证、前端可加防御）
- UI（MessageBubble/CompactBadge）：不动（loading/success/error 三态已支持）

---

## 6. 改动文件

| 文件 | 改动 |
|---|---|
| `shared/agent/message_manager.js` 基类 | messages 加 id（add*/_load 兼容）；`compactIfNeeded` 一函数两模式 + config `compactMode`；加 `_doCompact`/`_applyBgResult`/`_applyResultSync`/`_groupByAssistantTurn`(通用)/`_parseOrRaw`/`_recordFailure`/`_genMsgId`；加 `CONTINUATION_CLAUSE`；`getMessagesForLLM` strip id；加断路器 |
| `shared/agent/default_agent.js` | 两处 `for await compactIfNeeded` 不改逻辑（async 模式 compactIfNeeded 自己不阻塞、for await 自然不阻塞） |
| `agents/elf-002/config/config.json` | 加 `compactMode: "blocking"` |
| `agents/elf-002/message_manager.js` | **不动**（override 阻塞版） |
| `agents/elf-001/config/config.json` | 不配 compactMode（默认 async） |
| `agents/elf-003/config/config.json` | 不配 compactMode（默认 async） |
| `frontend/src/hooks/useChat.js` | 兜底 compact_start 重复保护；其余不动 |

---

## 7. message.id 加 id 的连带影响

加 id 给 messages 后，要确认这些地方不副作用：

- **`_save`/`_load`**：JSON 整存整取、id 自然保留；_load 旧无 id 的补生成 ✅
- **`getMessagesForLLM`**：strip id（LLM 不接受额外字段）✅
- **`estimateTokens`**：若 JSON.stringify 含 id 会多算 token——要和 `getMessagesForLLM` 一样 strip 后再算（否则 estimate 偏大）
- **elf-002 override 的 estimateTokens/getMessagesForLLM**：子类也 strip id（现状已 strip isMeta/metaTag、加 id 一起 strip）
- **history.jsonl**：不动（独立 id）

---

## 8. 与 elf-002 的关系

- elf-002 override `compactIfNeeded`（阻塞、含 L1/L2/microcompact、解析 `<summary>`、续写指令、tool-results 清理）——**完全不动**
- elf-002 config 配 `compactMode: "blocking"`——即便哪天不 override、走基类也是阻塞
- 基类新版给 elf-001/003 等"无 L1/L2、自由对话"agent 用——naive 解析、无 tool-results 清理、但加了保留近 1 group + 非阻塞 + 断路器 + 续写指令 + message.id
