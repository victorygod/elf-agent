# 压缩气泡修复方案：compactId 锚定 + 同气泡重试计数

> 目标：修复压缩气泡的状态收尾问题——
> ① async 模式（elf-001/003）下「压缩中」气泡永远不变成功；
> ② elf-002 阻塞模式下失败/无声重试导致气泡永久 loading、且历史里堆一串 loading 气泡。
> 状态：方案待评审。
> 关联：`base-compact-async-upgrade-plan.md`（基类升级方案）。

---

## 0. 设计总纲：把「未决压缩任务」封装成基类小对象

核心抽象：**一次"把超阈历史压下来"的目标 = 一个 compactId，可能经历多次尝试（attempt）**。

- `compactId`：标识这个压缩任务（不是单次尝试）。async 由后台任务持有、阻塞由 agent 持有，跨轮次存活。
- `attempt`：同一 compactId 的第几次尝试。失败后下一轮被动再试时 attempt++，复用同一 compactId。
- 前端：气泡以 compactId 为锚点。同一 compactId 的多次 attempt 更新同一个气泡（页眉显示"重试第 N 次"）；成功/彻底失败收尾。

> **attempt 语义边界**：仅 elf-002 阻塞模式会产生 attempt>1（失败后下一轮被动再试复用同 compactId）。基类 async 模式**不会** attempt++——后台失败 → `_bgFailed`→compact_error(final) 清掉 `_pendingCompact`，再压一律是 attempt=1 的新 compactId、新气泡。封装统一，但 async 的 attempt 恒为 1，实现时勿困惑。

封装成基类的一个内部字段 `this._pendingCompact`：

```js
// 基类 constructor
this._pendingCompact = null;   // { compactId, attempt } | null
```

基类提供三个受保护方法（elf-002 阻塞 override 与基类 async 共用）：

```js
// 开始一次尝试：有未决任务就 attempt++（重试），否则新建 compactId 第 1 次
_beginCompactAttempt() {
  if (this._pendingCompact) {
    this._pendingCompact.attempt++;
  } else {
    this._pendingCompact = { compactId: this._genMsgId(), attempt: 1 };
  }
  return { ...this._pendingCompact };   // 返回快照供事件 data 用
}

// 成功收尾：清未决任务
_endCompactSuccess() { this._pendingCompact = null; }

// 彻底放弃（断路器禁用）：清未决任务
_endCompactAbandoned() { this._pendingCompact = null; }

// abort：也算放弃当前任务（next attempt 由下一轮决定）。但 attempt 计数？
// → abort 是用户主动中止，不算失败重试：直接 _endCompactAbandoned()，下轮若再压是全新 compactId。
```

事件 data 约定（所有模式统一）：

| 事件 | data |
|---|---|
| `compact_start` | `{ compactId, attempt }` |
| `compact` | `{ compactId, tokenEstimate }` |
| `compact_error` | `{ compactId, attempt, error, final? }` |
| `compact_abort` | `{ compactId }` |

`final?: true` 表示"已彻底放弃"（断路器禁用、不再重试），前端显示永久失败态。

---

## 1. async 模式修复（elf-001/003，基类路径）

### 1.1 复现

async 下 compact_start（turn N）和 compact（turn N+x）跨 turn：

```
turn N: yield compact_start → 前端建气泡A(loading) → 后台启动 → return
        reasoning 继续 LLM 回复 → done → activeTurn(N) 封存进 turns[]
turn N+x: reasoning → _bgDone → _applyBgResult → yield compact
          到达前端时 activeTurn 已是 N+x，前端"改最后一个 bubble"改错/丢失
          → turns[N] 的气泡A 永远 loading
```

### 1.2 修复：compactId 跨 turn 由 agent 持有

async 启动后台时 `_beginCompactAttempt()`（首次 attempt=1）；后台完成/失败时事件带同一 compactId。

```js
// 基类 compactIfNeeded async 分支
if (async) {
  if (this._bgRunning) return;
  if (this._compactDisabled) return;

  const compact = this._beginCompactAttempt();          // ★ {compactId, attempt}
  this._bgRunning = true;
  this._bgDone = false;
  this._bgResult = null;
  this._bgAbortController = new AbortController();

  this._bgPromise = this._doCompact(...)
    .then(r => { this._bgResult = r; this._bgDone = true; this._bgRunning = false; })
    .catch(err => {
      this._bgRunning = false;
      if (err?.name === 'AbortError') {
        logger.info('后台记忆压缩被中止');
      } else {
        this._bgFailed = true;
        this._recordFailure();
      }
    });

  yield { event: 'compact_start', data: compact };      // ★ 带 id+attempt
  return;
}
```

应用后台结果（compactIfNeeded 顶部 bgDone 分支）：

```js
if (this._bgDone) {
  const result = this._applyBgResult();
  if (result) {
    const compact = this._pendingCompact;
    this._endCompactSuccess();                            // ★ 清未决
    yield { event: 'compact', data: { ...result, compactId: compact.compactId } };
    return;
  }
  // _bgResult 为 null（_doCompact 返回 null 或 _applyBgResult 内部 anchor 丢失）
  // 必须补 compact_error final 收尾，否则气泡卡 loading（review 发现的必要修复）
  const compact = this._pendingCompact;    // 先取快照
  this._recordFailure();
  this._endCompactAbandoned();             // 再清（清后 _pendingCompact=null）
  yield { event: 'compact_error', data: { compactId: compact?.compactId, attempt: compact?.attempt, error: '记忆压缩失败：无可压缩内容', final: true } };
}
```

后台失败待报（`_bgFailed`，下一轮才报）。**async 失败是否算"可重试"**：async 模式没有"被动再试"概念（后台是单次任务），失败后下一轮若还超阈值会**全新启动**一个后台 = 新 compactId。所以 async 失败 = final，不复用气泡：

```js
if (this._bgFailed) {
  this._bgFailed = false;
  const compact = this._pendingCompact;
  const final = this._compactDisabled;                   // 断路器到阈值 → 彻底放弃
  if (final) this._endCompactAbandoned();
  yield { event: 'compact_error', data: {
    compactId: compact?.compactId,
    attempt: compact?.attempt,
    error: '记忆压缩失败',
    final: final || undefined
  }};
}
```

### 1.3 阻塞分支（基类默认 / 无 compactMode）

同款用 `_beginCompactAttempt()`，失败也走 `compact_error` + final 判定：

```js
// 基类阻塞分支
if (this._compactDisabled) return;
const compact = this._beginCompactAttempt();
yield { event: 'compact_start', data: compact };

try {
  const r = await this._doCompact(llmModel, options);
  if (!r) { this._endCompactAbandoned(); return; }       // 无 group
  if (r.summary === null) {
    this._recordFailure();
    const final = this._compactDisabled;
    if (final) this._endCompactAbandoned();
    yield { event: 'compact_error', data: { ...compact, error: '记忆压缩失败：响应为空', final: final || undefined } };
    return;
  }
  this._applyResultSync(r);
  this._endCompactSuccess();
  yield { event: 'compact', data: { tokenEstimate: this.estimateTokens(), compactId: compact.compactId } };
} catch (err) {
  if (err?.name === 'AbortError') throw err;
  this._recordFailure();
  const final = this._compactDisabled;
  if (final) this._endCompactAbandoned();
  yield { event: 'compact_error', data: { ...compact, error: err.message || '记忆压缩失败', final: final || undefined } };
}
```

---

## 2. elf-002 阻塞模式修复：同气泡 + 重试次数

### 2.1 现状问题（review 确认）

elf-002 `compactIfNeeded`（line 305-380，override 基类）：

```
yield compact_start                      ← 前端建新气泡(loading)
try:
  if (o<2)        _recordCompactFailure(); return;   ← 静默！气泡卡 loading
  if (summary<1)  _recordCompactFailure(); return;   ← 静默！
  response = await llm...
  if (!summary)   _recordCompactFailure(); return;   ← 静默！
  ...成功... yield compact
catch err:
  if AbortError throw
  _recordCompactFailure()                            ← 静默！气泡卡 loading
```

4 个失败分支（3 个 return + 1 个 catch）**全静默**，前端气泡靠 `done`→`finalizeActiveTurn` 封存成 `sealed + compactLoading + 无summary + 无error` → 永久显示"压缩中"。下次用户发消息 → 又 yield compact_start → 前端又建一个新气泡 → 失败又卡 loading。**连续 3 次失败 = 历史里堆 3 个永久 loading 气泡**，然后 `_compactDisabled=true` 断路。

### 2.2 修复：复用基类 `_pendingCompact` 封装 + 失败补 compact_error + 跨轮复用气泡

elf-002 override 内改用基类 `_beginCompactAttempt()` 等方法（继承即用）。关键改动：

**a) compact_start 带 compactId+attempt（复用基类封装）**

```js
async *compactIfNeeded(llmModel, options = {}) {
  this._microcompactIfNeeded();
  if (this._compactDisabled) {
    // 断路器已禁：若有未决气泡（上次失败没 final 收尾的），补一个 final error
    if (this._pendingCompact) {
      const c = this._pendingCompact;
      this._endCompactAbandoned();
      yield { event: 'compact_error', data: { ...c, error: '记忆压缩已禁用（连续失败）', final: true } };
    }
    return;
  }
  if (this.estimateTokens() <= this.memoryTokenLimit) return;

  const compact = this._beginCompactAttempt();   // ★ 首次 attempt=1；上次失败未 final → attempt++（同气泡重试）
  yield { event: 'compact_start', data: compact };

  try {
    const groups = this._groupByAssistantTurn();
    const o = groups.length;
    if (o < 2) { return this._fail(compact, '无可压缩内容'); }   // 见 _fail
    const summaryCount = o - 1;
    if (summaryCount < 1) { return this._fail(compact, '无可压缩内容'); }

    const summaryGroups = groups.slice(0, summaryCount);
    const preserveGroups = groups.slice(summaryCount);
    const summaryRequest = [
      { role: 'system', content: this.compactSystemPrompt },
      ...summaryGroups.flat().map(m => ({ ...m })),
      { role: 'user', content: this.compactPrompt }
    ];
    const response = await llmModel.chat(summaryRequest, { enable_thinking: false, ...options });
    const summary = this._parseSummaryResponse(response);
    if (!summary) { return this._fail(compact, '记忆压缩失败：响应为空或无 summary'); }

    // 成功
    const wrappedSummary = SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + 'Summary:\n' + summary;
    this.messages = [{ role: 'user', content: wrappedSummary, isCompactSummary: true }, ...preserveGroups.flat()];
    this._compactHappened = true;
    this._save();
    this._cleanupToolResults(this._referencedToolCallIds());
    this._compactFailCount = 0;
    this._endCompactSuccess();                                      // ★ 清未决
    yield { event: 'compact', data: { tokenEstimate: this.estimateTokens(), compactId: compact.compactId } };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;                      // abort 抛给 agent，由 default_agent yield compact_abort
    return this._fail(compact, err.message || '记忆压缩失败');
  }
}
```

**b) `_fail` 封装：记断路器 + compact_error + final 判定**

elf-002 新增私有方法，把 4 个失败分支统一走它：

```js
/**
 * 压缩失败收尾：记断路器、yield compact_error、按断路器状态决定 final。
 * @param {{compactId, attempt}} compact  当前未决任务快照
 * @param {string} msg                    失败原因
 * @returns {undefined}                   供 `return this._fail(...)` 用，结束 generator
 */
_fail(compact, msg) {
  const logger = createLogger('message_manager', logFileName);
  logger.error(`记忆压缩失败: ${msg}`);
  this._recordCompactFailure();
  const final = this._compactDisabled;   // _recordCompactFailure 后若到阈值 → true
  if (final) this._endCompactAbandoned();
  yield_via_event...                       // ⚠️ generator 不能在普通方法里 yield，见下文处理
}
```

⚠️ **关键约束**：`_fail` 不能用 `yield`（普通方法不是 generator）。处理方式有二：

- **方式 1（推荐，保持封装）**：`_fail` 只做"记断路器 + 算 final + 清状态"，**返回** `{ error, final }`，由调用方 `return yield { event:'compact_error', data:{ ...compact, ...result } }`。封装在"算 final/记状态"，yield 留在 generator 主体 —— 封装仍成立，只是 yield 留在主流程。

```js
_fail(compact, msg) {          // 返回 {error, final}，不 yield
  const logger = createLogger('message_manager', logFileName);
  logger.error(`记忆压缩失败: ${msg}`);
  this._recordCompactFailure();
  const final = this._compactDisabled;
  if (final) this._endCompactAbandoned();
  return { error: msg, final };
}
// 调用方：
if (o < 2) {
  const f = this._fail(compact, '无可压缩内容');
  yield { event: 'compact_error', data: { ...compact, ...f } };
  return;
}
```

- 方式 2（省一层）：直接在 4 个失败点 inline 写 `yield compact_error + return`，不抽 `_fail`。重复但直观。

→ 选方式 1，封装"记断路器/算 final/清状态"这三步（这正是易错、易漏清状态的部分），yield 因语言限制留 generator 主体。

**c) 跨轮复用同一气泡的 attempt 计数**

`_beginCompactAttempt()` 的核心：**上次失败但未 final（断路器没禁）→ `_pendingCompact` 仍在 → 下轮 attempt++、复用 compactId**。前端收到 `attempt>1` 的 compact_start，按 compactId 找到旧气泡复用（见 §3.3），把徽章从"失败"改回"loading · 重试第 N 次"。

→ 这正是你说的"同一气泡写失败重试第几次"。语义上接受：两次 attempt 间用户说了话、历史变长，但压缩意图（把超阈历史压下来）未变，复用气泡合理。

**d) reloadFromDisk 重置**

elf-002 `reloadFromDisk` 已重置 `_compactFailCount/_compactDisabled`，补上 `_pendingCompact=null`（基类 `reloadFromDisk` 也要重置，见 §4）。

### 2.3 attempt 计数的语义边界（务必确认）

| 场景 | compactId | attempt | 前端气泡 |
|---|---|---|---|
| 首次压缩 | 新 id | 1 | 新建"压缩中" |
| 第1次失败 | 同 id | 1 | 同气泡→"压缩失败" |
| 下轮再试 | 同 id（复用） | 2 | 同气泡→"重试第2次·压缩中" |
| 第2次失败 | 同 id | 2 | 同气泡→"压缩失败·第2次" |
| 第3次失败 → 断路 | 同 id | 3 final=true | 同气泡→"压缩已禁用（连续失败3次）"永久态 |
| 下轮再发消息 | _compactDisabled → 不再压 | — | 无新气泡（上个已 final 收尾） |
| 成功（任一次） | 同 id | — | 同气泡→"压缩成功" |
| abort | 同 id | —（放弃） | 同气泡→"已终止"；下轮再压=新 id（abort 不算重试） |

---

## 3. 前端改造（useChat.js）：按 compactId 锚定 + 同气泡重试

### 3.1 compact_start：先找旧气泡复用，否则新建

```js
case 'compact_start': {
  const { compactId, attempt } = data;
  const state = useAgentStore.getState();
  const chat = state.chats.get(agentId);
  if (!chat?.activeTurn) return;       // 压缩气泡只挂在 activeTurn（活跃流内）；跨轮复用见下

  // attempt > 1：同 compactId 重试，在 turns[] 里找旧气泡原地复用（留在历史位置）
  if (compactId && attempt > 1) {
    const found = _findBubbleByCompactId(state, agentId, compactId);   // 跨 activeTurn+turns[]
    if (found) {
      // 原地更新：旧气泡留在它的 turns[N] 历史位置，只改状态字段 → loading 态、"重试第N次"
      _updateBubbleInPlace(state, agentId, found, {
        compactLoading: true, compactError: undefined, compactSummary: undefined,
        compactAttempt: attempt, sealed: false,
      });
      break;
    }
  }

  // 新建气泡
  const prevBubble = chat.activeTurn.assistantBubbles[chat.activeTurn.assistantBubbles.length - 1];
  let sealedPrev = (prevBubble && !prevBubble.sealed) ? { ...prevBubble, sealed:true } : prevBubble;
  if (sealedPrev && sealedPrev.compactLoading && sealedPrev.compactSummary == null && !sealedPrev.compactError) {
    sealedPrev = { ...sealedPrev, compactLoading:undefined, compactError:'记忆压缩未完成', sealed:true };
  }
  const newBubble = {
    id: compactId || `local_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,  // ★ 用 compactId 当 bubble.id
    content:'', toolCalls:[], ts:new Date().toISOString(), sealed:false,
    compactLoading:true, compactAttempt: attempt || 1,
  };
  const newBubbles = sealedPrev
    ? chat.activeTurn.assistantBubbles.map((b,i)=>i===chat.activeTurn.assistantBubbles.length-1?sealedPrev:b).concat(newBubble)
    : [...chat.activeTurn.assistantBubbles, newBubble];
  patchChat({ activeTurn:{ ...chat.activeTurn, assistantBubbles:newBubbles } });
  break;
}
```

> **跨轮气泡位置（已拍板：留历史位置原地更新）**：attempt>1 时旧气泡在 turns[]（历史区）、新对话在 activeTurn（当前区）。按决策1原地更新——旧气泡留在它的 turns[N] 历史位置，只改状态字段为 loading+重试第N次，**不**移动到 activeTurn。**视觉副作用（by design）**：重试中的 loading 徽章会停在一历史对话的中间位置，而非当前对话末尾；用户当前在 turn N+x 对话，历史中间有个"重试第N次·压缩中"在转。TurnView 是 React.memo 但 turn 对象引用会变（原地更新建新 turn 对象），浅比较检测到 → 重渲染，正常工作。

### 3.2 辅助：跨 turn 找气泡

```js
function _findBubbleByCompactId(state, agentId, compactId) {
  const chat = state.chats.get(agentId);
  if (!chat) return null;
  if (chat.activeTurn) {
    const idx = chat.activeTurn.assistantBubbles.findIndex(b => b.id === compactId);
    if (idx !== -1) return { turn: chat.activeTurn, bubbleIdx: idx, inActive: true };
  }
  for (let i = chat.turns.length - 1; i >= 0; i--) {
    const idx = chat.turns[i].assistantBubbles.findIndex(b => b.id === compactId);
    if (idx !== -1) return { turn: chat.turns[i], bubbleIdx: idx, inActive: false };
  }
  return null;
}
```

### 3.3 compact / compact_error / compact_abort：按 id 更新

```js
function _applyCompactResult(state, agentId, compactId, patch, fallbackPatch) {
  const chats = new Map(state.chats);
  const chat = chats.get(agentId);
  if (!chat) return;
  const found = compactId ? _findBubbleByCompactId(state, agentId, compactId) : null;

  if (found) {
    const updated = { ...found.turn.assistantBubbles[found.bubbleIdx], ...patch, compactLoading: undefined, sealed: true };
    const updatedBubbles = found.turn.assistantBubbles.map((b,i)=>i===found.bubbleIdx?updated:b);
    const updatedTurn = { ...found.turn, assistantBubbles: updatedBubbles };
    if (found.inActive) chats.set(agentId, { ...chat, activeTurn: updatedTurn });
    else {
      const turns = [...chat.turns];
      turns[chat.turns.indexOf(found.turn)] = updatedTurn;
      chats.set(agentId, { ...chat, turns });
    }
  } else {
    // fallback：无 id 或找不到 → 最后一个 bubble（blocking 单 turn 兜底）
    if (!chat.activeTurn) return;
    const at = chat.activeTurn;
    const last = at.assistantBubbles[at.assistantBubbles.length-1];
    if (!last) return;
    const updated = { ...last, ...fallbackPatch, compactLoading: undefined, sealed: true };
    const newBubbles = at.assistantBubbles.map((b,i)=>i===at.assistantBubbles.length-1?updated:b);
    chats.set(agentId, { ...chat, activeTurn:{ ...at, assistantBubbles:newBubbles } });
  }
  set({ chats });
}

case 'compact':
  _applyCompactResult(useAgentStore.getState(), agentId, data.compactId,
    { compactSummary: data.tokenEstimate || true },
    { compactSummary: data.tokenEstimate || true });
  break;
case 'compact_error':
  _applyCompactResult(useAgentStore.getState(), agentId, data.compactId,
    { compactError: _formatCompactError(data) },          // 含"第N次"+final 文案
    { compactError: _formatCompactError(data) });
  break;
case 'compact_abort':
  _applyCompactResult(useAgentStore.getState(), agentId, data.compactId,
    { compactError: '记忆压缩已终止' }, { compactError: '记忆压缩已终止' });
  break;
```

`_formatCompactError(data)`：拼"压缩失败"+（attempt>1?`·第${attempt}次`:'')+（final?'·已禁用自动压缩':'）。

### 3.4 CompactBadge：显示重试次数

`CompactBadge.jsx`（loading 态）增加 attempt 显示：

```
loading:  "压缩中" 或 "重试第 N 次·压缩中"（attempt>1）
success:  "压缩成功" + tokenEstimate
error:    "压缩失败" + 次数 + (final ? "·已禁用" : "")
```

气泡对象新增字段 `compactAttempt`（compact_start 写入）、`final`（compact_error 写入）。MessageBubble.jsx 透传给 CompactBadge。

### 3.5 snapshot / 气泡 id 对齐

`buildBubblesFromContext`（chat_proxy.js）compact_start 气泡 `id = entry.data.compactId`、`compactAttempt = entry.data.attempt`。刷新页面后气泡带 compactId，后续事件按 id 命中。snapshot handler 的 `b.id || snap_xxx` fallback 保留（compactId 是稳定 id，会优先用上）。

---

## 4. gateway / history 改造

### 4.1 chat_proxy.js 写 history 带 compactId + attempt

```js
} else if (currentEvent === 'compact_start') {
  ctx.flushRoundToHistory();
  if (ctx.chatHistory) {
    ctx.chatHistory.addMessage(id, 'assistant', '', undefined,
      { compactLoading: true, compactId: parsedData.compactId || null, compactAttempt: parsedData.attempt || 1 });
  }
} else if (currentEvent === 'compact') {
  if (ctx.chatHistory) {
    ctx.chatHistory.addMessage(id, 'assistant', '', undefined,
      { compactSummary: parsedData.tokenEstimate || true, compactId: parsedData.compactId || null });
  }
} else if (currentEvent === 'compact_error') {
  if (ctx.chatHistory) {
    ctx.chatHistory.addMessage(id, 'assistant', '', undefined,
      { compactError: parsedData.error, compactId: parsedData.compactId || null, final: parsedData.final, compactAttempt: parsedData.attempt });
  }
} else if (currentEvent === 'compact_abort') {
  if (ctx.chatHistory) {
    ctx.chatHistory.addMessage(id, 'assistant', '', undefined,
      { compactError: '记忆压缩已终止', compactId: parsedData.compactId || null });
  }
}
```

`buildBubblesFromContext` compact_start 气泡带 `id=compactId, compactAttempt=attempt`（见 §3.5）。

**gateway 零状态透传**：事件自带 compactId/attempt，gateway 不拦截、不维护跨 ctx 状态。这是方案 a 的核心优势。

### 4.2 chat_history.js：压缩记录就地更新（P1，每任务一条记录）

**设计转向 P1**：放弃"append 两条 + 读取时合并"的方案，改为**压缩任务始终一条记录、状态更新就地改写**。目的：让 history.jsonl 与前端"一个气泡就地更新"完全同源，刷新/流式零 diff。

#### 4.2.1 写入侧

- `compact_start` 仍 `addMessage` 写一条 `{ compactLoading:true, compactId, compactAttempt }`（动作起点）
- `compact` / `compact_error` / `compact_abort` **不再 addMessage**，改调新方法 `updateCompactRecord(agentId, compactId, patch)`：读 history.jsonl 全文 → 按 compactId 定位那条记录 → 改其状态字段（去 compactLoading、加 compactSummary/Error/final）→ 整文件写回

```js
updateCompactRecord(agentId, compactId, patch) {
  if (!compactId) return false;
  const filePath = this._getFilePath(agentId);
  if (!fs.existsSync(filePath)) return false;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  let updated = false;
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.compactId === compactId) {
        delete rec.compactLoading;
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete rec[k]; else rec[k] = v;
        }
        updated = true;
        out.push(JSON.stringify(rec));
      } else out.push(line);
    } catch (e) { out.push(line); }
  }
  if (!updated) { logger.warn(`updateCompactRecord 未命中 compactId: ${compactId}`); return false; }
  fs.writeFileSync(filePath, out.join('\n') + '\n', 'utf-8');
  return true;
}
```

chat_proxy 对应分支改调 `updateCompactRecord`（compact_start 不变，仍 addMessage）。

#### 4.2.2 读取侧

`getRecent` **删掉** `_mergeCompactRecords` 调用，直接返回原始记录。每个压缩任务物理一条 → `historyToTurns` 每条 assistant 记录一个气泡 → 1 条 = 1 气泡，天然同步。

#### 4.2.3 删除 `_mergeCompactRecords` / `_compactRecordRank`

不再需要合并逻辑。整个合并方法删除。

#### 4.2.4 性能/并发

- 压缩是低频操作（记忆满才触发），每次 update 读+写整个 history.jsonl 开销可接受
- agent 单实例访问自己的 jsonl，无并发写；update 期间无 append（同一 agent 的 chat 事件串行到达）
- 跨 turn 更新（async 模式 compact 事件在下一 turn 的 ctx pump 里到达）正常工作——`updateCompactRecord` 只依赖 agentId + compactId 在文件里找记录，不依赖 ctx

#### 4.2.5 不兼容旧数据

旧 history.jsonl 里同一 compactId 的两条（loading + success/error）不会被合并、不会被 update 改写（update 只改 compactId 匹配的那条，旧的两条各自独立）。按决策：旧数据不兼容、不清，刷新可能显示旧的两条；新数据始终一条。需重建/清空旧 history 才能完全干净。

---

## 5. agent 侧封装细节

### 5.1 基类新增（message_manager.js）

```js
// constructor
this._pendingCompact = null;   // { compactId, attempt } | null

// 受保护方法（elf-002 override 复用）
_beginCompactAttempt() {
  if (this._pendingCompact) this._pendingCompact.attempt++;
  else this._pendingCompact = { compactId: this._genMsgId(), attempt: 1 };
  return { ...this._pendingCompact };
}
_endCompactSuccess() { this._pendingCompact = null; }
_endCompactAbandoned() { this._pendingCompact = null; }

// reloadFromDisk 补
this._pendingCompact = null;
```

### 5.2 elf-002 复用

elf-002 override 直接调基类 `_beginCompactAttempt/_endCompactSuccess/_endCompactAbandoned`，自己只新增 `_fail(compact,msg)`（返回 {error,final}）。`reloadFromDisk` 补 `_pendingCompact=null`（基类 reload 已清，elf-002 可不重复，但保险加上）。

### 5.3 default_agent.js：压缩 abort 收尾契约（必要协调点）

现状 default_agent.js:277-289 压缩期间 abort 的 catch：`yield { event:'compact_abort', data:{} }`（空 data）。改为带 compactId，且**收尾权归 default_agent**——这是 message_manager 与 default_agent 的必要协调契约：

**契约**：阻塞/async 模式下，压缩中的 AbortError 由 `compactIfNeeded` 的 catch `if (err?.name === 'AbortError') throw err` **重新抛出**（见 §1.3），**不在 compactIfNeeded 内调 `_endCompactAbandoned`、不 yield compact_abort**。抛到 default_agent 的 for-await catch 后，由 default_agent 取 `this.messageManager._pendingCompact` 快照、调 `_endCompactAbandoned()`、yield 带 compactId 的 compact_abort。

> 原因：若 compactIfNeeded 自己先 `_endCompactAbandoned()` 清了 `_pendingCompact`，default_agent 就取不到 compactId 了。所以"清状态 + yield compact_abort"必须由 default_agent 统一做，compactIfNeeded 遇 AbortError 只管抛。

```js
// default_agent.js reasoning 压缩 for-await 的 catch（两处：循环内 + 兜底）
if (err.name === 'AbortError' || this._aborted) {
  // 若有未决压缩任务，yield 带 compactId 的 compact_abort 收尾气泡
  const pc = this.messageManager._pendingCompact;
  if (pc) {
    this.messageManager._endCompactAbandoned();   // abort 放弃当前任务（清 _pendingCompact）
    yield { event: 'compact_abort', data: { compactId: pc.compactId } };
  }
  // 无未决压缩任务时（abort 发生在非压缩阶段），不补 compact_abort，直接 aborted
  yield { event: 'compact_abort', data: {} };     // 保留空 data 兜底（前端 fallback 处理）
  yield { event: 'aborted', data: {} };
  yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
  return;
}
```

> 注：现状已有两条 compact_abort 路径——循环内压缩 abort（default_agent:283）和兜底压缩 abort（:498）。两处都要按此改造。前端 compact_abort handler：有 compactId 走按 id 收尾、无 compactId 走 fallback 最后气泡。

### 5.4 async 模式 abort 的收尾（方案 Y：abort 瞬间收尾气泡）

async 模式下，后台压缩用**独立 AbortController**（基类 `_bgAbortController`）——这是**必要保留**的：compact_start 后 generator 就 return 了，调用方的 `_abortController` 早已 null，后台压缩的 signal 必须自带、跨 generator 调用存活。`abort()` 同时 abort `_abortController`（停 LLM 流）和 `abortBackgroundCompact()`（停后台压缩），"两者都停"已实现。signal 传递链路（compactIfNeeded → `{...options, signal: _bgAbortController.signal}` → _doCompact → llmModel.chat）已 review 确认无误，后台压缩能被正确 abort。

**缺失的是气泡收尾**：后台 `.catch` 到 AbortError 只 `logger.info('被中止')`（不设 _bgFailed、不设 _bgDone、不清 _pendingCompact），气泡停在 loading。解法（方案 Y）：

**抽 default_agent 私有 generator `_abortCompactBubble()`，在所有 abort 收尾点统一调用**（不只 LLM catch——因为 async 后台压缩可能在 LLM 已正常结束、进入工具执行阶段时还活着，abort 落点不固定）：

```js
// default_agent 新增
* _abortCompactBubble() {
  // 若有未决压缩任务（blocking 压缩在 await 中被 abort，或 async 后台还在跑），
  // 收尾它的气泡为"已终止"。后台被 abort 的 _doCompact 走 AbortError 分支不设 _bgDone，
  // 结果丢弃是符合预期的（用户都停了，不要应用半截压缩结果）。
  if (this.messageManager._pendingCompact) {
    const pc = this.messageManager._pendingCompact;
    this.messageManager._endCompactAbandoned();
    yield { event: 'compact_abort', data: { compactId: pc.compactId } };
  }
}
```

在 default_agent 的**每个** abort return 前调 `yield* this._abortCompactBubble()`：

- LLM 流 chatStream 的 abort catch（default_agent.js:327）—— async 模式 LLM 回复阶段 abort 的主落点
- LLM 流结束后的 `_checkAborted` 分支（:346）—— LLM 正常结束但已被 abort
- 工具执行后的 abort 分支（:420 / :439）—— async 后台压缩可能在工具执行阶段还活着
- 压缩 for-await 的 abort catch（:283 / :498）—— blocking 模式压缩 await 中 abort 的主落点

这样 blocking 与 async 的 abort 收尾**完全同构**：都是"检测 _pendingCompact 还在 → _endCompactAbandoned + yield compact_abort(compactId)"，只是触发落点不同，统一辅助覆盖。

> **为什么放主流程而非后台 .catch**：abort 是用户主动、要即时视觉反馈。放后台 .catch 要等下一轮 compactIfNeeded 才能报（延迟）。放主流程 abort catch → abort 瞬间就 yield compact_abort，气泡立即变"已终止"。
>
> **边界：async 压缩已跑完（_bgDone=true）、LLM 还在回时 abort**：_pendingCompact 还在（apply 在下一轮 compactIfNeeded 顶部才做）。LLM catch 里 `_abortCompactBubble` 会 `_endCompactAbandoned` 丢弃这个已成功的摘要 + yield compact_abort。可接受——用户都停了，不应用这个结果是合理的。下一轮若还超阈值，新建 compactId 重新压。
>
> **后台 .catch 的 AbortError 分支不动**：仍只 logger.info，不设标志、不清状态。清状态归 `_abortCompactBubble`。两者职责清晰：后台 .catch 只管"后台任务停止"，主流程 abort catch 管收尾气泡。

---

## 6. 改动文件清单

| 文件 | 改动 |
|---|---|
| `shared/agent/message_manager.js` 基类 | 加 `_pendingCompact` + `_beginCompactAttempt/_endCompactSuccess/_endCompactAbandoned`；async 分支用之、compact/compact_error 带 compactId+final；阻塞分支同款；reload 清 `_pendingCompact` |
| `agents/elf-002/message_manager.js` | override 内复用基类封装；compact_start 带 `{compactId,attempt}`；4 个失败分支 + catch 走新 `_fail()`（yield compact_error + final 判定）；成功 `_endCompactSuccess`；断路禁用时补 final error；reload 清 `_pendingCompact` |
| `gateway/chat_proxy.js` | compact_start 仍 `addMessage` 写一条（带 compactId/attempt）；compact/compact_error/compact_abort 改调 `updateCompactRecord` 就地改写（不再 addMessage）；`buildBubblesFromContext` compact_start 气泡 `id=compactId, compactAttempt=attempt` |
| `gateway/chat_history.js` | 新增 `updateCompactRecord(agentId, compactId, patch)` 就地改写压缩记录状态；删除 `_mergeCompactRecords`/`_compactRecordRank`；`getRecent` 去掉合并调用直接返回原始记录；每压缩任务物理一条记录 |
| `frontend/src/hooks/useChat.js` | compact_start：attempt>1 时按 compactId 找旧气泡复用+移到 activeTurn，否则新建(用 compactId 当 id)；新增 `_findBubbleByCompactId`/`_applyCompactResult`/`_moveBubbleToActiveTurn`/`_formatCompactError`；compact/compact_error/compact_abort 按 id 更新（带 fallback） |
| `frontend/src/components/CompactBadge.jsx` + `MessageBubble.jsx` | loading 态显示"重试第N次"；error 态显示次数+final；气泡带 compactAttempt/final 字段透传 |
| `shared/agent/default_agent.js` | 压缩 abort 路径 yield `compact_abort` 带 compactId（若 _pendingCompact 存在） |

---

## 7. 已拍板的点

1. **跨轮重试气泡的位置**（§3.1）：**留在历史位置原地更新**。attempt>1 时旧气泡在 turns[N]，原地改状态字段为 loading+重试第N次，不移动到 activeTurn。✅
2. **abort 不算重试**（§2.3）：abort 后 `_endCompactAbandoned`，下轮再压 = 新 compactId。✅
3. **history 合并按 compactId 分组取最后终态**（§4.2）：同一 compactId 多条 loading/error 记录只留最后有意义的。✅
4. **前端气泡跨 turn 操作**改到 store 状态管理：原地在 turns[] 更新（不跨 turn 移动，配合决定1）。✅
5. **CompactBadge 文案**："重试第 N 次·压缩中" / "压缩失败·第 N 次" / "压缩失败·已禁用自动压缩"。✅

---

## 8. 实现顺序

1. 基类 `_pendingCompact` 封装 + async/阻塞分支接上（含 final 判定）。
2. elf-002 override 接上封装 + `_fail` + 失败补 compact_error。
3. default_agent abort 带 compactId 的 compact_abort。
4. gateway chat_proxy 写 history 带 id/attempt + buildBubblesFromContext 透传。
5. chat_history `_mergeCompactRecords` 按 compactId 分组（+测试）。
6. 前端 useChat：_findBubbleByCompactId / _applyCompactResult / compact_start 复用移动 / 文案。
7. CompactBadge/MessageBubble 显示重试次数。
8. 手测：elf-001/003 async 成功/刷新/abort；elf-002阻塞 成功、失败1次放弃、失败2次成功、失败3次断路、abort、刷新各态。
9. 回归全测试套（补 compactId/attempt 断言）。

---

## 附：一句话总结

> **把"未决压缩任务"封装成基类的 `{compactId, attempt}` 小对象，agent 持有、跨轮存活。compact_start/compact/compact_error/compact_abort 事件统一带 compactId(+attempt/final)，前端按 compactId 锚定同一气泡：成功更新、失败显示"第N次"、重试时复用同气泡改回 loading、断路禁用时 final 永久失败。gateway 零状态透传、写 history 时带 id 供刷新按 compactId 合并。**