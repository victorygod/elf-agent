# async 压缩气泡修复方案：用 history.jsonl id 锚定跨 turn 气泡

> 目标：修复 async 模式（elf-001/003）下「压缩中」气泡永远不变成功的问题。
> 状态：方案待评审。
> 关联：`base-compact-async-upgrade-plan.md`（基类升级方案）。

---

## 1. 问题复现

async 模式下，`compact_start` 和 `compact` **必定落在不同的 turn**：

```
第 N 轮（触发压缩）:
  reasoning → compactIfNeeded → yield compact_start → 后台启动 → return
    前端：activeTurn(N) 建气泡 bubbleA（compactLoading: true）
  reasoning 继续：LLM 正常回复 tokens → 流入 activeTurn(N) 的 bubbleB（回复气泡）
  done → activeTurn(N) 整体封存移入 turns[]
    bubbleA 此时仍是「压缩中」，没人给它发 compact 事件

  [后台压缩异步完成] _bgDone=true，但 compact 事件只能在下一次 compactIfNeeded 里 yield
  —— compactIfNeeded 只在下一轮 reasoning 才被调用。两次用户对话之间没有 SSE 流，事件发不出去。

第 N+1 轮（用户发新消息）:
  reasoning → compactIfNeeded → _bgDone → _applyBgResult → yield compact
    这个 compact 到达前端时，activeTurn 已是 N+1 的新 turn
    前端 'compact' handler 改「最后一个 bubble」
    activeTurn(N+1) 此时还没有任何 bubble → lastBubble=undefined → 事件被静默丢弃
    turns[N] 里的 bubbleA 永远停在「压缩中」
```

**根因**：前端 handler 用「位置」（最后一个 bubble）定位，而 async 下 compact 事件跨越了 turn 边界，位置已失效。

---

## 2. 你的判断（采纳）

> compact 哪个气泡，肯定在 history.jsonl 里有个 id 标记的，应该就是 history 的那个 id，消息出来以后就去更新它。

完全正确。`compact_start` 在 chat_proxy 写 history.jsonl 时已经生成了 id（`chat_history.addMessage` → `_generateId`）。把这个 id 下发给前端气泡，compact 事件回来时带上同一个 id 去定位更新，就跨过了 turn 边界。

---

## 3. 现状链路梳理

### 3.1 compact_start 的 id 现在丢在哪

`gateway/chat_proxy.js` 收到 `compact_start` 事件：

```js
} else if (currentEvent === 'compact_start') {
  ctx.flushRoundToHistory();
  if (ctx.chatHistory) {
    ctx.chatHistory.addMessage(id, 'assistant', '', undefined, { compactLoading: true });
    //  ↑ _generateId 生成 msg_<ts>_<rand>，写进 history.jsonl
    //  ↑ 但这个 id 没有回流给前端！
  }
}
```

前端 `compact_start` handler 建气泡时用的是本地合成 id：

```js
const newBubble = {
  id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,  // ← 本地 id，与 history id 无关
  ...
  compactLoading: true,
};
```

→ **前端气泡的 id 和 history.jsonl 的 id 是两套**，无法对齐。

### 3.2 compact 事件现在不带 id

后端 `compactIfNeeded` yield：

```js
yield { event: 'compact', data: { tokenEstimate: this.estimateTokens() } };
//  ↑ 只带 tokenEstimate，不带 compact_start 的 id
```

前端 handler：

```js
case 'compact': {
  const lastBubble2 = at2.assistantBubbles[at2.assistantBubbles.length - 1];  // ← 靠位置
  if (lastBubble2) {
    const updatedBubble = { ...lastBubble2, compactLoading: undefined, compactSummary: ..., sealed: true };
    // ← 只改最后一个 bubble
  }
}
```

→ async 下最后一个 bubble 是别人（可能不存在），改错。

### 3.3 页面刷新：snapshot 用 historyToTurns，气泡带的就是 history id

刷新后 `loadHistory` → `historyToTurns`：

```js
current.assistantBubbles.push({ ...msg, sealed: true });
//  ↑ {...msg} 把 history jsonl 的 id（msg_<ts>_<rand>）原样带进 bubble
```

→ **刷新后 turn 里的气泡确实带了 history id**。但活跃流期间前端 handler 建的气泡带的是 local id。两套都对不齐。

---

## 4. 修复方案

核心思想：**让 history.jsonl 的 id 成为「压缩气泡」的唯一锚点**，从 compact_start 下发 → 气泡携带 → compact/compact_error 回带 → 按 id 跨 turn 定位更新。

### 4.1 改动 1：后端 compact_start 事件回传 history id

`gateway/chat_proxy.js`：把 `addMessage` 返回的 record.id 通过 compact_start 事件下发给前端。

```js
} else if (currentEvent === 'compact_start') {
  ctx.flushRoundToHistory();
  if (ctx.chatHistory) {
    const rec = ctx.chatHistory.addMessage(id, 'assistant', '', undefined, { compactLoading: true });
    if (rec?.id) {
      // 把 history id 回传给前端:前端气泡用这个 id,compact 完成后按 id 回写
      ctx.broadcastChunk(`event: compact_start\ndata: ${JSON.stringify({ compactId: rec.id })}\n\n`);
      ctx.recordEvent('compact_start', { compactId: rec.id });
      // 注意:原始 compact_start 已由 pump 上面的 broadcastChunk(chunk) 透传过了,
      // 这里再发一条带 compactId 的会重复。需要在透传层拦截 compact_start 不透传原始,
      // 改由这里统一发带 id 的。见 §4.4 拦截说明。
      return; // 跳过下面的原始透传(currentEvent 已消费)
    }
  }
}
```

**拦截原始 compact_start 透传**（见 §4.4）：pump 里识别到 `event: compact_start` 时，不把原始 chunk 透传给前端，等 addMessage 拿到 id 后统一发带 id 的版本。避免前端收到两条 compact_start。

### 4.2 改动 2：前端 compact_start handler 用回传的 id 建气泡

`useChat.js` compact_start 分支：

```js
case 'compact_start': {
  const chat4 = getChat();
  let at = chat4?.activeTurn;
  if (!at) return;

  const prevBubble = at.assistantBubbles[at.assistantBubbles.length - 1];
  // 未决的压缩气泡标 error（同现状逻辑，略）
  let sealedPrev = ...;

  const newBubble = {
    id: data.compactId || `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    //  ↑ 优先用后端回传的 history id,fallback 本地 id(后端无 chatHistory 时)
    content: '',
    toolCalls: [],
    ts: new Date().toISOString(),
    sealed: false,
    compactLoading: true,
  };
  ...
}
```

### 4.3 改动 3：前端 compact / compact_error / compact_abort 改为按 id 定位

`useChat.js`，新增跨 turn 定位辅助。**关键：要同时搜 activeTurn 和 turns[]**（async 下旧气泡已封存进 turns）。

```js
// 按 compactId 在 (activeTurn.bubbles + turns[].bubbles) 反向查找未决压缩气泡
function _findCompactBubble(state, agentId, compactId) {
  const chat = state.chats.get(agentId);
  if (!chat) return null;
  const candidates = [];
  if (chat.activeTurn) candidates.push({ turn: chat.activeTurn, isTurn: false });
  // turns 从新到旧倒序,优先近的
  for (let i = chat.turns.length - 1; i >= 0; i--) {
    candidates.push({ turn: chat.turns[i], isTurn: true });
  }
  for (const c of candidates) {
    const idx = c.turn.assistantBubbles.findIndex(
      b => b.id === compactId && b.compactLoading && b.compactSummary == null && !b.compactError
    );
    if (idx !== -1) return { ...c, bubbleIdx: idx };
  }
  return null;
}

case 'compact': {
  const compactId = data.compactId;
  const state = useAgentStore.getState();
  const target = compactId ? _findCompactBubble(state, agentId, compactId) : null;
  if (!target) {
    // fallback:无 id 或找不到 → 退回原"最后一个 bubble"逻辑(blocking 模式仍走这条)
    const at2 = state.chats.get(agentId)?.activeTurn;
    ...原逻辑...
    break;
  }
  // 命中:更新该 bubble,封存
  const chats = new Map(state.chats);
  const chat = chats.get(agentId);
  const turn = target.turn;
  const bubble = turn.assistantBubbles[target.bubbleIdx];
  turn.assistantBubbles[target.bubbleIdx] = {
    ...bubble,
    compactLoading: undefined,
    compactSummary: data.tokenEstimate || true,
    sealed: true,
  };
  // 若是 turns[] 里的,替换对应 turn;若是 activeTurn,替换 activeTurn
  ...set...
  break;
}
```

compact_error / compact_abort 同理，带 `compactId`（abort 见 §4.5）。

### 4.4 改动 4：后端 compact 事件带 compactId

`shared/agent/message_manager.js`：`_applyBgResult` 返回的 data 要能带 id。但基类**不知道** history.jsonl 的 id（那是 gateway 层的东西），且同一个压缩气泡的 id 是 gateway 在 compact_start 时生成的。

→ 这里有个**层级问题**：gateway 生成 id，agent 层 yield 事件。compact 事件不带 id 是因为 agent 层压根没有这个 id。

**解法**：compact_start 的 id 由 gateway 生成并下发前端；gateway 在透传 compact/compact_error 事件时，**注入当前未决压缩气泡的 id**。即 gateway 维护一个 `ctx.pendingCompactId`，compact_start 时记下，compact/compact_error 透传时把它塞进 data。

`gateway/chat_proxy.js`：

```js
// StreamContext 增加字段
this.pendingCompactId = null;  // 当前未决压缩气泡的 history id

// compact_start 分支:记下 id + 回传(改造 §4.1)
} else if (currentEvent === 'compact_start') {
  ctx.flushRoundToHistory();
  let compactId = null;
  if (ctx.chatHistory) {
    const rec = ctx.chatHistory.addMessage(id, 'assistant', '', undefined, { compactLoading: true });
    compactId = rec?.id || null;
  }
  ctx.pendingCompactId = compactId;
  // 不透传原始 compact_start;改发带 id 的
  ctx.broadcastChunk(`event: compact_start\ndata: ${JSON.stringify({ compactId })}\n\n`);
  ctx.recordEvent('compact_start', { compactId });
  currentEvent = '';
  return; // 跳过本行透传(见下文拦截)
}

// compact 分支:注入 pendingCompactId
} else if (currentEvent === 'compact') {
  const payload = { ...parsedData };
  if (ctx.pendingCompactId) {
    payload.compactId = ctx.pendingCompactId;
    ctx.pendingCompactId = null;
  }
  // 透传带 id 的 payload(而非原始):
  ctx.broadcastChunk(`event: compact\ndata: ${JSON.stringify(payload)}\n\n`);
  ctx.recordEvent('compact', payload);
  if (ctx.chatHistory) {
    ctx.chatHistory.addMessage(id, 'assistant', '', undefined, { compactSummary: payload.tokenEstimate || true });
  }
  currentEvent = '';
  return;
}

// compact_error 同理注入 pendingCompactId
} else if (currentEvent === 'compact_error') {
  const payload = { ...parsedData };
  if (ctx.pendingCompactId) { payload.compactId = ctx.pendingCompactId; ctx.pendingCompactId = null; }
  ctx.broadcastChunk(`event: compact_error\ndata: ${JSON.stringify(payload)}\n\n`);
  ctx.recordEvent('compact_error', payload);
  if (ctx.chatHistory) {
    ctx.chatHistory.addMessage(id, 'assistant', '', undefined, { compactError: payload.error || '记忆压缩失败' });
  }
  currentEvent = '';
  return;
}
```

**拦截原始透传**：现状 pump 里 `ctx.broadcastChunk(chunk)` 在解析前就把整个 chunk 透传了。改造后 compact/compact_start/compact_error 这三类事件不能靠 chunk 透传，要拦截。做法：在 `ctx.broadcastChunk(chunk)` 之前，对当前 chunk 做 SSE 行扫描——如果含 `event: compact_start`/`compact`/`compact_error` 则不透传原始 chunk（这几类由上面改造的分支统一构造带 id 的事件透传）。其余事件（token/tool_call 等）照常透传。

> 注意：一个 chunk 可能含多条 SSE 事件（token + compact 混在一个 chunk）。要做行级扫描、只 withhold 这三类事件行、其余照透。实现上可以：解析出 lines 后，把含这三类 event 的行从「待透传 buffer」剔除，只透传其余行；解析逻辑照常在组装出这三类事件时走改造分支。

### 4.5 改动 5：abort 时跨 turn 收尾压缩气泡

`default_agent.js` abort 时 yield `compact_abort`，gateway 注入 pendingCompactId 透传。前端 `aborted`/`compact_abort` handler 用同一个 `_findCompactBubble` 按 id 把气泡标「已终止」。

但 abort 可能在后台压缩跑了一半时发生，`pendingCompactId` 已记下。compact_abort 透传时带上即可。

前端 `aborted` handler 现在只查 activeTurn 的最后一个 bubble，要改成：若有 compactId（compact_abort 事件带的），按 id 跨 turn 查找；否则保留原逻辑。

### 4.6 改动 6：history.jsonl 合并修复

现状 `_mergeCompactRecords` 只合并**相邻**的 compactLoading + compactSummary/Error。async 下两者跨越了多轮记录（中间隔了 reply + user），不相邻 → 不会合并 → 刷新后出现两个气泡（一个永久 loading + 一个 success）。

**解法**：合并不再依赖相邻，而依赖 **compactId 配对**。`compact_start` 写 history 时记录 `{ compactId, compactLoading:true }`（compactId = 自己生成的 record.id）；`compact`/`compact_error` 写 history 时**记录同一个 compactId**。

改造 `gateway/chat_history.js`：

```js
// addMessage 支持 compactId 配对字段
// compact_start 时:record = { id: compactId, role, content:'', compactLoading:true, compactId }
// compact 时:record = { id: <new>, role, compactSummary, compactId }
// _mergeCompactRecords:扫到 compactSummary/compactError 记录,按 compactId 回找对应 compactLoading 记录合并删除
```

读历史时（`getRecent`）按 compactId 配对：success/error 记录留下、对应的 compactLoading 记录删掉。这样刷新后只剩一个状态正确的气泡。

> compatId 字段一旦写入旧 history.jsonl 不兼容——需 forward 兼容：`_mergeCompactRecords` 对无 compactId 的旧记录仍走旧的「相邻合并」逻辑。

---

## 5. 改动文件清单

| 文件 | 改动 |
|---|---|
| `gateway/chat_proxy.js` | StreamContext 加 `pendingCompactId`；compact_start/compact/compact_error 事件拦截原始透传、改由分支构造带 compactId 的事件 + 写 history 时带 compactId 配对 |
| `gateway/chat_history.js` | `addMessage` 透传 compactId 字段；`_mergeCompactRecords` 改为按 compactId 配对合并（兼容旧相邻合并） |
| `frontend/src/hooks/useChat.js` | compact_start 用 `data.compactId` 建气泡；新增 `_findCompactBubble` 跨 turn 按 id 定位；compact/compact_error/compact_abort/aborted 改用 id 定位更新（blocking 无 id 时 fallback 原位置逻辑） |
| `shared/agent/message_manager.js` | **不动**（agent 层不感知 history id，由 gateway 注入） |
| `shared/agent/default_agent.js` | **不动**（compact_abort 事件已 yield，gateway 注入 id） |

---

## 6. 阻塞模式 (elf-002 / 无 config 默认) 兼容

blocking 模式 compact_start → compact 在同一 turn、且 compact 触发时气泡是最后一个，按位置逻辑本来就能工作。改造后：

- blocking 模式 gateway 也走同一条路：compact_start 生成 id 下发、compact 注入 id。前端带 id 的气泡也能按位置命中（因为是最后一个，且 id 也能匹配）。
- 两者都走 id 定位，blocking 不退化、async 跨 turn 也能命中。
- fallback 保留「无 id 找不到 → 最后一个 bubble」逻辑，做防御。

---

## 7. 边界情况

1. **后台压缩跨多轮用户消息才完成**：compact_start 在 turn N，用户 N+1、N+2 一直没触发新压缩（固然超阈值但 `_bgRunning=true` 不重触发），到 turn N+3 后台才完。compact 事件带 compactId，前端按 id 在 turns[] 里找回 turn N 的气泡 → 正确更新。✅

2. **后台压缩失败 → 下一轮 yield compact_error**：同 1，带 id 跨 turn 把气泡标 error。✅

3. **压缩期间 abort**：compact_abort 带 pendingCompactId，前端按 id 标终止。若 abort 时后台还没写入 history（压缩半途），history 里只有 compactLoading 记录无配对——按 compactId 配对合并时该 loading 记录无 success/error 配对，`_mergeCompactRecords` 要把无配对的 compactLoading 记录**也删掉**（压缩没成功就是没有气泡），否则刷新后留永久 loading。

4. **连续两次后台压缩**：turn N 启动压缩 A（compactId=A），还没完成；turn N+x `_bgRunning` 守卫不发新 compact_start。A 完成后 yield compact(id=A) 更新气泡 A；下一轮若还超阈值启动压缩 B（compactId=B），新建气泡 B。两气泡各自配对，互不干扰。✅

5. **pendingCompactId 串台**：一个 ctx 一次只可能有一个未决压缩（`_bgRunning` 守卫），所以 `pendingCompactId` 单值字段足够，不需数组。

6. **页面刷新在 compact_start 后、compact 前**：snapshot 用 historyToTurns 读 history.jsonl，能读到 compactLoading 记录（气泡带 history id）。订阅后续事件，compact 到来带同 id → 按 id 命中该气泡更新。✅ 但前提是 §4.6 合并没把 loading 记录误删——刷新时压缩还没完，loading 记录无配对应**保留**（不是删掉），只有 abort 的 loading 才删。合并逻辑要区分「未决 loading（保留）」与「abort 的 loading（删）」——这其实难区分，history 里 loading 无配对到底是「在途」还是「abort」？→ 见下。

7. **§4.6 与 §7.3 §7.6 矛盾**：无配对 compactLoading 记录，刷新时该保留（在途）还是删除（abort）？解法：**不删无配对 loading 记录**，让它在历史里以 loading 态保留。刷新后若压缩继续完成，compact 事件按 id 命中把它转 success；若压缩被 abort/失败则 compact_error/compact_abort 命中转 error/终止。即 `_mergeCompactRecords` 只做「success/error 按配对吞掉对应 loading」这一个方向，不做反方向。clean。

---

## 8. 待你拍板的点

1. **compact_start 事件拦截原始透传**要不要做？现状 pump 一来就 `broadcastChunk(chunk)` 透传全部。拦截这三类事件需行级扫描 withhold，稍复杂。替代方案：不拦原始，agent 层 compact_start 事件 data 让 gateway 注入 compactId 再透传——但 gateway 拿到 id 是在 addMessage 之后，而透传在之前。除非把 compact_start 透传延迟到 addMessage 之后（与 recordEvent 同步）。即：**把这三类事件从「边透传边解析」改成「先 parse → 拿 id/写 history → 再构造带 id 的事件透传」**，pump 内对这三类事件跳过 `broadcastChunk(chunk)` 的对应行。这是必然要做的，没绕开。

2. **history.jsonl 合并改动**是否接受？这是刷新正确性的关键。若接受，old records 走 legacy 相邻合并兼容。

3. compact_start 在**无 chatHistory**（测试/无 dataDir）时 addMessage 返回 null，前端用 local id fallback，blocking 同 turn 仍按位置命中。可接受？

---

## 9. 实现顺序建议

1. 先改 `chat_history.js`：addMessage 透传并返回 compactId 字段、`_mergeCompactRecords` 按 id 配对（兼容旧）。
2. 改 `chat_proxy.js`：pendingCompactId + 三类事件拦截透传改造。
3. 改 `useChat.js`：_findCompactBubble + 各 handler 按 id 定位。
4. 手测 elf-001/003 长对话触发压缩、刷新、abort 三场景。
5. 回归全测试套。

---

## 附：一句话总结

> **gateway 在 compact_start 写 history 时生成 id，把这个 id 下发给前端气泡；compact/compact_error/abort 完成时，gateway 把同一个 id 注入事件、前端按 id 跨 turn 回找气泡更新。history.jsonl 合并也从「相邻」改成「按 id 配对」。**