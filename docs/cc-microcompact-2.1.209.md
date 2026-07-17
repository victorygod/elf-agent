# CC microcompact 方案与 elf 接入设计（2.1.209）

> 上半：CC microcompact 的方案/参数/源码证据（逆向 `claude.exe` v2.1.209）。
> 下半：elf-002 怎么加 microcompact（基于代码现状的具体接入方案）。
> 证据来源：`strings -n 6 claude.exe`，行号指 `strings -n 6` 输出行号。
> 日期：2026-07-16

---

## 一、CC microcompact 方案

### 1. 定位

microcompact 是 **L4 摘要之前的轻量省 token 闸**：不调 LLM、不摘要，只把**偏老的 tool_result 内容**清成短占位，保留最近 `keepRecent` 个完整。目的是在「还没到 L4 摘要阈值、但 tool_result 累计偏高」的区间提前瘦身，延迟/避免 L4。

与 L1/L2 的区别：L1/L2 是**单条/group 超限 → 存盘 + 预览**（可回读）；microcompact 是**跨历史的老 result → 清成占位**（默认不回读，可选落盘）。L1/L2 管体积上限，microcompact 管历史累计。

### 2. 触发

- **触发源**：服务端 `context_hint` SSE 提示（token 偏高）。
- **非定时器**：telemetry 名虽叫 `tengu_time_based_microcompact`，但 `trigger` 字段值为 `context_hint`，不是时间触发。
- **证据**：`context_hint_sse`(136403)、`context_hint`(161472/161495/222529)、`tengu_context_hint_reject`(161446)、`tengu_context_hint_busy_fallback`(161452)。

### 3. 机制

`BLs(messages, keepRecent)`：
1. 收集所有 tool_result，保留最后 `keepRecent` 个（`o = new Set(r.slice(-n))`），其余加入 clearSet；
2. 统计可省 token；
3. 裁剪 `fZr`：被清的 tool_result content → `[Old tool result content cleared]`；image/document block → `kvo` 占位；可选 `persist` 落盘成 `<persisted-output>`，`m4y` 标记可回查。

只动 tool_result 内容，user/assistant 文本全留；非递归。

### 4. 参数表

| 参数 | CC 值 | 证据 / 说明 |
|---|---|---|
| 触发源 | 服务端 `context_hint` SSE | strings `context_hint_sse`(136403) |
| 触发字段 | `trigger:"context_hint"` | telemetry 日志 |
| keepRecent | **5**（写死常量 `A$d=5`，非 config 可配） | `var A$d=5`；调用 `BLs(messages, A$d)` / `{keepRecent:A$d}`；telemetry `keepRecent` 字段上报实际值 |
| 最小节省阈值 `$Ls` | **20000** token | `var $Ls=20000`；`if (o < $Ls) return null` 省不到不触发 |
| 替换文本 | `[Old tool result content cleared]` | strings 111571 |
| 媒体占位 | `kvo`（image/document 块） | `fZr` |
| 可选落盘 | `<persisted-output>` + `m4y` 可回查 | `fZr` 的 persist 分支 |
| 边界标记 | `microcompact_boundary`（subtype，UI 不渲染） | strings 155349；区别于 full 的 `compact_boundary` |
| 日志 | `[KEEP-RECENT MC] context_hint trigger, cleared N tool results (~M tokens), kept last K` | strings 161474 |
| telemetry | `tengu_time_based_microcompact { toolsCleared, toolsKept, keepRecent, tokensSaved, trigger }` | strings 161446–161486 |

### 5. 与 L4 的关系

microcompact 在 L4 之前跑。若清完仍超 L4 阈值 → 进入 L4 摘要。microcompact 失败/不触发不影响 L4。两者边界标记不同（`microcompact_boundary` vs `compact_boundary`）。

---

## 二、elf-002 现状对照

| 项 | CC | elf-002 现状 | 代码位置 |
|---|---|---|---|
| L1 单条持久化 | 50000 | `perToolLimit=10000` | `addToolResult`(行84) |
| L2 group 预算 | 200000 | `budgetWindow=200000` | `_enforceBudgetWindow`(行145) |
| L4 摘要 | reactive/全量 | 全量替换 | `compactIfNeeded` override(行205) |
| **microcompact** | ✅ context_hint | ❌ **无** | — |
| 触发源 | 服务端 SSE | **无服务端信号** | `chatStream` 只解析 `data:`(行151)，无 usage/hint |
| token 估算 | 真实 usage+增量 | `JSON.stringify(all).length/4` | `estimateTokens`(行130) |
| L4 阈值 | ~167k | `memoryTokenLimit=400000` | config.json |

关键差异：
1. **elf 无服务端 context_hint** → microcompact 触发必须改成客户端 `estimateTokens()` 判定。
2. elf-002 的 `perToolLimit/budgetWindow` 现**已对齐 CC 默认**（50000/200000，本轮修正）；microcompact 的收益场景是**跨 group 累计的中等体积老 result**——单条没超 perToolLimit、单 group 合计没超 budgetWindow，但跨 group 累计把 token 顶高。
3. elf 已有 `_persistToolResult` 落盘基建 → microcompact 清理时可落盘 + 带 filepath 占位，可回读（比 CC 默认纯清理更安全）。

---

## 三、elf 接入方案

### 1. 触发源改造（无 context_hint → 客户端阈值）

新增 `microcompactThreshold`：低于 L4 的 `memoryTokenLimit`。当 `estimateTokens() ∈ [microcompactThreshold, memoryTokenLimit)` 时跑 microcompact；到 `memoryTokenLimit` 仍走 L4。

建议 `microcompactThreshold = memoryTokenLimit * 0.6 ≈ 240000`（400000 的 60%），可调。

### 2. 接入点（最小侵入，只改 elf-002/message_manager.js）

在 `compactIfNeeded` override **最开头**插入 `_microcompactIfNeeded()`，**在 `_compactDisabled` 检查之前**（microcompact 不调 LLM、不会失败，不应被 L4 断路器连坐）：

```js
async *compactIfNeeded(llmModel, options = {}) {
  this._microcompactIfNeeded();          // ★ 轻量第一道，独立于 L4 断路器
  if (this._compactDisabled) return;
  if (this.estimateTokens() <= this.memoryTokenLimit) return;
  // ... 原 L4 逻辑不变 ...
}
```

`compactIfNeeded` 在 agent loop 每轮顶部 + 兜底步都会被调（`default_agent.js` 行272/487），所以 microcompact 每轮都有机会判，无需改 `default_agent.js`。

### 3. `_microcompactIfNeeded()` 实现

```js
_microcompactIfNeeded() {
  if (!this.microcompactEnabled) return;
  if (this.estimateTokens() < this.microcompactThreshold) return;   // 没到轻量阈值不跑

  const toolMsgs = this.messages.filter(m => m.role === 'tool');
  if (toolMsgs.length <= this.microcompactKeepRecent) return;       // 没几个 result，不值得

  // 保留全局最近 keepRecent 个 tool result，其余为候选
  const keepIds = new Set(
    toolMsgs.slice(-this.microcompactKeepRecent).map(m => m.tool_call_id)
  );
  const candidates = toolMsgs.filter(m => !keepIds.has(m.tool_call_id));

  // 只清"未持久化的中等体积 result"——已 <persisted-output> 的清掉省得少，跳过
  const toClear = [];
  let savedChars = 0;
  for (const m of candidates) {
    if (typeof m.content !== 'string') continue;
    if (m.content.startsWith('<persisted-output>')) continue;       // L1/L2 已压过，跳过
    const placeholder = this._buildMicrocompactPlaceholder(m);     // 含 filepath 回读
    if (m.content.length > placeholder.length) {
      savedChars += m.content.length - placeholder.length;
      toClear.push({ m, placeholder });
    }
  }

  // 最小节省阈值（token 口径 = chars/4）
  const savedTokens = Math.ceil(savedChars / 4);
  if (savedTokens < this.microcompactMinSavings) return;            // 省不到不触发（对齐 $Ls）

  for (const { m, placeholder } of toClear) m.content = placeholder;
  this._save();
  logger.info(`[microcompact] cleared ${toClear.length} tool results (~${savedTokens} tokens), kept last ${this.microcompactKeepRecent}`);
}
```

### 4. 占位策略（复用落盘基建，可回读）

推荐**友好方案**：清理时先 `_persistToolResult` 落盘，再替换成带 filepath 的占位（复用 `_buildPersistedOutput` 或精简版），模型可 Read 回读，不丢信息——和 L1/L2 体验一致，比 CC 默认纯清理更安全。

```js
_buildMicrocompactPlaceholder(msg) {
  // 落盘（已存在则 _persistToolResult 内部跳过写，安全）
  const meta = this._persistToolResult(msg.tool_call_id, msg.content);
  if (meta) {
    return [
      '<persisted-output>',
      `[Old tool result content cleared] Full output saved to: ${meta.filepath}`,
      `Preview (first ${this._formatSize(this.previewLength)}):`,
      meta.preview,
      meta.hasMore ? '...' : '',
      '</persisted-output>'
    ].filter(Boolean).join('\n');
  }
  // 落盘失败兜底：纯占位（对齐 CC 默认）
  return '[Old tool result content cleared]';
}
```

> 落盘文件生命周期与 L1/L2 一致：L4 摘要成功后 `_cleanupToolResults` 会清空 `tool-results/` 目录（此时 messages 已整体替换为摘要，占位不再被引用，无孤儿）。

### 5. 参数建议（elf-002）

| 参数 | 建议值 | 理由 |
|---|---|---|
| `microcompactEnabled` | true（opt-in 配置） | 与 skills 一样 config 开关 |
| `microcompactThreshold` | 240000 | `memoryTokenLimit(400000) * 0.6`，低于 L4 留提前量 |
| `microcompactKeepRecent` | 5 | 对齐 CC 常量 `A$d=5`，保住最近工作上下文 |
| `microcompactMinSavings` | 20000 | 对齐 CC `$Ls`；elf token 口径 chars/4，≈ 80000 字符节省才触发 |
| 占位 | 落盘 + filepath | 复用 `_persistToolResult`，可回读 |

config.json 增项：
```json
"microcompactEnabled": true,
"microcompactThreshold": 240000,
"microcompactKeepRecent": 5,
"microcompactMinSavings": 20000
```
`MessageManager` 构造 + `updateConfig` 用 `_getThreshold`/`_get` 读取（同 perToolLimit 模式）。

### 6. 与 L1/L2/L4 的关系（不冲突点）

- **L2**：管单 group 内 fresh 合计 > budgetWindow → 持久化预览。microcompact 管跨 group 老的、未持久化的 result。两者作用域正交，且 microcompact 跳过已 `<persisted-output>` 的，不重复处理。
- **L4**：microcompact 在 L4 之前跑，清完重估 token，可能避免本轮 L4。L4 仍走原 `compactIfNeeded` 逻辑不变。
- **断路器**：`_compactDisabled` 只禁 L4；microcompact 不调 LLM、放在断路器检查之前，不受影响。

### 7. rewind / 事件 / 边界

- **rewind**：microcompact 改的是 messages content 并 `_save` 到 context.json；`reloadFromDisk` 从 context.json 重载即恢复该点状态，与 L1/L2 一致，无需额外处理。
- **事件**：microcompact 同步、不调 LLM，默认静默 + 日志；可选 yield `{event:'microcompact', data:{cleared, tokensSaved}}` 通知前端（非必需）。
- **boundary**：elf 无需 `microcompact_boundary`（不像 L4 整体替换需要锚点）；microcompact 只改 content，不影响 L4 的 boundary 逻辑。

---

## 四、落地清单

改 1 个文件 + 1 个配置：

1. `agents/elf-002/message_manager.js`
   - 构造 + `updateConfig`：读 4 个新阈值（`_getThreshold` 模式）
   - 新增 `_microcompactIfNeeded()`、`_buildMicrocompactPlaceholder(msg)`
   - `compactIfNeeded` override 开头插入 `this._microcompactIfNeeded()`（在 `_compactDisabled` 前）
2. `agents/elf-002/config/config.json`：加 4 个 microcompact 配置项
3.（可选）`reloadFromDisk` 无需改；`_ui` 配置界面项可选加

### 风险点

- `_persistToolResult` 对每个被清 result 落盘，长对话可能写一批文件——但和 L1/L2 同目录、同清理机制（L4 后清空），无累积风险。
- `estimateTokens()` 在 microcompact 前后各算一次（O(n) JSON 序列化），每轮 loop 顶部开销可接受；若敏感可缓存。
- microcompact 改 content 后若 rewind 到更早快照，占位会被快照态覆盖（快照机制整份换回），一致。

---

## 五、与既有文档关系

- `docs/cc-toolresult-group-compact-2.1.209.md` §2.1：microcompact 简述 + 字面量证据。本文是它的展开 + elf 接入方案。
- `docs/claude-code-l4-compact-2.1.209.md` §13：五层总览。本文补 microcompact 层的 elf 落地。
- `docs/cc-compact-request-anatomy.md`：L4 摘要请求解剖，与 microcompact 无重叠。
