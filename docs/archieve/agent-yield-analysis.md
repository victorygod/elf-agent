# Agent Generator(yield) 与事件驱动架构分析

> 日期：2026-07-21（2026-07-22 落地完成）
> 关联：`agent-plugin-system-design.md`、`agent-refactor-plan.md`
> 状态：**P0–P6 已全量落地**，443 测试全绿，HTTP /chat 端到端冒烟通过（status→token→done 经 callback emit 到达）。
> `shared/agent/` 主对话流零 generator 残留：receive/reasoning/runAborable/finishAborted/executeBatch/compactIfNeeded/runCompact/chatStream 全部 async+emit；server.js `/chat` callback 订阅；前端按 `tool_call.id` 匹配 tool_result。后台 compactor 旁路 `_emit`/`callbacks` 不动（边界分立）。

## 一、背景

在参考 LangChain 的回调/事件驱动架构后，对当前代码库中 `yield`（async generator）的使用进行了全面审查。
**核心结论：`yield` 不是洪水猛兽，但当前的用法将「传输层」和「业务逻辑」耦合到了一起，需要拆分。**

---

## 二、改造前 yield 使用全景（P0–P6 后均已成 async+emit，本表为历史诊断快照）

| 位置 | 文件 | 角色 | 是否合理 |
|------|------|------|----------|
| `Agent.receive()` | `default_agent.js:293` | 入口 generator，外部通过 `for await...of` 消费 | ⚠️ 耦合点 |
| `Agent.reasoning()` | `default_agent.js:383` | **核心循环体**，yield status/token/tool_call/done 等全部事件 | ⚠️ 主要问题 |
| `AbortFlow.runAborable()` | `abort_flow.js:71` | 用 `yield*` 透传子 generator，同时做 abort 拦截 | ⚠️ 职责混合 |
| `AbortFlow.finishAborted()` | `abort_flow.js:40` | 中断收尾事件（compact_abort/aborted/done） | ⚠️ 可改为普通函数 |
| `MessageManager.compactIfNeeded()` | `message_manager.js:210` | 编排压缩流程，yield compact_start/compact/compact_error | ⚠️ 编排与产出混合 |
| `MessageManager.runCompact()` | `message_manager.js:255` | 包装 compactIfNeeded 为 generator | 🔄 中转层 |
| `MessageManager._triggerAsync()` | `message_manager.js:309` | 后台压缩触发，yield compact_start | ⚠️ 应改为 eventSink |
| `MessageManager._triggerBlocking()` | `message_manager.js:355` | 阻塞压缩，yield compact_start/compact/error | ⚠️ 应改为 eventSink |
| `LLMModel.chatStream()` | `llm_model.js:81` | 消费 HTTP SSE 流，yield token/tool_calls | ✅ 合理 |
| `ToolManager.executeBatch()` | `tool_manager.js:126` | 工具编排，yield status/tool_result | ⚠️ 应改为回调 |

### 数据流（当前）

```
server.js (for await...of)
  └─ Agent.receive()                    ← generator 入口
       └─ yield* this.reasoning()       ← generator：核心循环
            ├─ yield* abortFlow.runAborable(compact)
            │    └─ yield* messageManager.runCompact()
            │         └─ yield* compactIfNeeded()  ← generator：编排
            │              ├─ yield* _triggerAsync()   ← generator
            │              └─ yield* _triggerBlocking() ← generator
            ├─ for await...of model.chatStream()      ← generator：合理 ✅
            │    └─ yield token / tool_calls
            ├─ yield* abortFlow.runAborable(tool-exec)
            │    └─ yield* toolManager.executeBatch()  ← generator：编排
            └─ yield* abortFlow.finishAborted()
                  └─ yield compact_abort/aborted/done
```

**问题：4 层 generator 嵌套（receive → reasoning → runAborable → runCompact/executeBatch），yield 满天飞。**

> 落地后（终态）：`server.js` → `await agent.receive(msg,{emit})` → `await reasoning(msg,{emit})` → `await runAborable(workFn,emit)` / `await chatStream({onChunk})` / `await executeBatch({emit})`。普通 async 链，事件经 `emit` 直推 SSE，零 generator 嵌套。后台 compactor 旁路 `_emit`/`callbacks` 仍多播 `/events`，与主流 `emit` 分立。

---

## 三、LangChain 的做法对比

LangChain 的核心设计理念：

```typescript
// LangChain：业务逻辑是普通 async 函数，事件通过 callback 推送
const result = await chain.call({ input: userInput }, {
  callbacks: [{
    handleLLMStart(prompts) { /* 观察，不控制流 */ },
    handleLLMNewToken(token) { /* 推送到前端 */ },
    handleLLMEnd(response) { /* 观察 */ },
    handleToolStart(name, args) { /* 观察 */ },
    handleToolResult(name, result) { /* 观察 */ },
  }]
});
```

| 维度 | 当前代码 | LangChain |
|------|----------|-----------|
| 核心逻辑形态 | async generator（yield 推事件） | 普通 async 函数（return 最终结果） |
| 事件推送方式 | yield → 调用方 for await 消费 | callback / event emitter → 观察者消费 |
| 控制流 | yield 同时承担"产出事件"和"驱动流程" | 业务逻辑控制流独立，事件流仅观察 |
| 可测试性 | 必须遍历 generator 才能验证行为 | 直接 await 调用，检查返回值或回调记录 |
| 传输耦合 | 业务逻辑与 SSE 流绑定 | 业务逻辑无感知，callback 由外层注入 |

---

## 四、建议方案：分阶段改造

### 原则

1. **只改 yield 的用途（产出事件），不改 yield 的存在（流式输出必须）**
2. **业务逻辑回归普通 async 函数，事件通过 callback/emit 推送**
3. **流式消费边界（`chatStream`）一并 callback 化，用 `await onChunk` 补回天然背压**

> 注：`chatStream` callback 化后，`for await...of` 拉模式的天然背压（慢消费反压上游）被拆掉，需用 `await onChunk` 显式补回。这是 callback 推模式相对 generator 拉模式的唯一实质代价，必须处理，不可跳过。

### 阶段 1：`LLMModel.chatStream()` — 改为 callback ✅

```javascript
// 改造前（generator）
async *chatStream(messages, tools, options = {}) {
  const response = await fetch(..., { stream: true });
  for await (const chunk of parseSSE(response)) {
    yield chunk;   // 拉模式：消费者慢 → yield 挂起 → 上游暂停，天然背压
  }
}

// 改造后（callback）
async chatStream(messages, tools, { onChunk, ...options }) {
  const response = await fetch(..., { stream: true });
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  for await (const chunk of parseSSE(response)) {
    if (chunk.type === 'token') usage.completion_tokens += 1;
    await onChunk(chunk);   // 推模式需显式 await 才能恢复背压；不 await 则快 LLM + 慢客户端会在 res buffer 堆积
  }
  return { usage };
}
```

**理由**：callback 完全可行，统一到 callback 架构更清晰。唯一代价是背压从天然变显式（`await onChunk`），补上即与 generator 等价。

### 阶段 2：`Agent.reasoning()` — 核心改造 ⚠️→✅

**从 generator 改为普通 async 函数，通过 callback emitter 推送事件。token 时序与中断收尾都能与 yield 版等价映射。**

> **范围说明（review 修正）**：reasoning 不是单段函数，当前是**循环内 4 段 `yield* runAborable` + 2 处 `_dispatchGate` 门控**：compact 段（L415）、LLM 流段（L446，自管 try/catch）、tool-exec 段（L497）、兜底 compact 段（L543），加 `shouldBreakAfterTools`（L514）/`onAssistantContent`（L526）门控。callback 化要**整体重写这 4 段 + 2 门控**的控制流——这是改造的主体工作量，非单段映射。下面以 LLM 流段为例展示映射，其余段同构（`yield* runAborable(workFn)` → `await runAborable(workFn, emit)`）。

```javascript
// 改造后（普通函数 + callback）——以当前 reasoning L446-474 的流消费 + 中断收尾段为例
async reasoning(message, emit) {
  emit({ event: 'status', data: { state: 'thinking' } });

  let fullContent = '', toolCallsResult = null;
  this._abortController = new AbortController();
  try {
    await this.model.chatStream(messages, tools, {
      signal: this._abortController.signal,
      onChunk: (chunk) => {
        if (this._aborted) return;                          // ① 中断后静默丢弃 token，不 emit
        if (chunk.type === 'token') {
          fullContent += chunk.content;
          emit({ event: 'token', data: { content: chunk.content } });
        } else if (chunk.type === 'tool_calls') {
          toolCallsResult = chunk.tool_calls;
        }
      },
    });
  } catch (err) {
    this._abortController = null;
    if (err.name === 'AbortError' || this._aborted) {
      this._finishAborted(emit, 'llm-stream', fullContent); // ② 异常路径收尾后
      return;                                              //   return，后续不执行（≈ yield 版 L459-460）
    }
    emit({ event: 'error', data: { message: `LLM API error: ${err.message}` } });
    emit({ event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } });
    return;
  }
  this._abortController = null;

  if (this._aborted) {                                     // ③ 流正常结束但仍可能已 abort
    this._finishAborted(emit, 'llm-stream', fullContent);  //   （≈ yield 版 L470-473）
    return;
  }

  // ... tool_call / executeBatch / compact 段同理，各用 emit + return 处理中断 ...
  emit({ event: 'done', data: { usage: {...} } });
  return finalResult;
}

// finishAborted 改为同步普通函数：事件顺序由函数体语句序保证（与 yield 版等价）
//   不是"纯函数"——含 mm 副作用：abandonPendingCompact（→compact_abort）+ addAssistantMessage（fullContent 存档）
_finishAborted(emit, reason, fullContent) {
  const pc = this.messageManager.abandonPendingCompact?.();   // 副作用：放弃未决压缩
  if (pc) emit({ event: 'compact_abort', data: { compactId: pc.compactId } });
  if (fullContent) this.messageManager.addAssistantMessage(fullContent);   // 副作用：存档已流出 token
  emit({ event: 'aborted', data: {} });
  emit({ event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } });
}
```

**三件硬事的等价性（一一映射）：**

| 契约 | yield 版 | callback 版 | 等价？ |
|------|----------|-------------|--------|
| token 时序 | `yield` 调用序 | `onChunk` 调用序 | ✅ |
| 中断收尾顺序（compact_abort→aborted→done） | `finishAborted` 内 `yield` 语句序（L44/51/52） | `_finishAborted` 函数体语句序 | ✅ |
| 中断后不漏 token | `if(this._aborted) break` + `return`（L447/460） | `onChunk` 内 `return` + 函数 `return`（①②③） | ✅ 1:1 |

> 注：中断收尾三事件（compact_abort/aborted/done）必须由 `_finishAborted` 显式 emit；漏写则前端收不到 aborted/done。这是改造时要照搬的契约，非 callback 固有缺陷。

**好处：**
- 可以直接 `await agent.reasoning(msg, fn)` 测试逻辑
- 业务逻辑不再被 generator 嵌套绑架
- callback 由 server.js 注入 SSE 写入逻辑，业务不感知传输

### 阶段 3：`AbortFlow` — 去 generator 化 ⚠️→✅

```javascript
// 改造前（generator，对应当前 abort_flow.js:71-86）
async *runAborable({ reason, controllerField, fullContent = '' }, workFn) {
  const ac = new AbortController();
  this._agent[controllerField] = ac;
  try {
    const ret = yield* workFn(ac.signal);      // 透传子 generator 事件，同时 await
    this._agent[controllerField] = null;
    return { aborted: false, value: ret };
  } catch (err) {
    this._agent[controllerField] = null;       // ← 清字段（照搬 L79，勿漏）
    if (err.name === 'AbortError' || this._agent._aborted) {   // ← 照搬 L80 双条件
      yield* this.finishAborted(reason, fullContent);   // yield 收尾事件
      return { aborted: true };
    }
    throw err;
  }
}

// 改造后（普通 async 函数 + emit 注入）
async runAborable({ reason, controllerField, fullContent = '' }, workFn, emit) {
  const ac = new AbortController();
  this._agent[controllerField] = ac;
  try {
    const ret = await workFn(ac.signal, emit);  // workFn 改普通 async，内部 emit 事件
    this._agent[controllerField] = null;
    return { aborted: false, value: ret };
  } catch (err) {
    this._agent[controllerField] = null;       // ← 清字段（照搬，勿漏）
    if (err.name === 'AbortError' || this._agent._aborted) {   // ← 照搬双条件
      this.finishAborted(emit, reason, fullContent);   // 同步发 compact_abort/aborted/done
      return { aborted: true };
    }
    throw err;
  }
}
// finishAborted 不再是 generator，而是同步普通函数（见阶段 2 _finishAborted）
```

**关键**：去 generator 后，`yield* workFn()` 的"透传子事件 + 拿返回值"两职拆为：workFn 接收 `emit` 自推事件、`return` 拿值。中断收尾由 `finishAborted(emit, ...)` 同步补发（必须补发，见阶段 2 注）。**照搬契约**：catch 内先清 `controllerField`（L79）、判断用双条件 `AbortError || _aborted`（L80），两处勿漏。

### 阶段 4：`MessageManager.runCompact()` — 事件回调化 ⚠️→✅

> **review 修正**：当前 `runCompact` 已带 `onDone` 回调（L417-420，`onDone: () => skillLister.reinjectAfterCompact()`），非纯 generator——`onDone` 管副作用、yield 管事件。改造后 `onEvent`（推 compact* 事件）与 `onDone`（副作用）并存：`compactIfNeeded` 内部改用 `onEvent` 推事件，`onDone` 语义不变。

```javascript
// 改造前（yield 推事件 + onDone 副作用 callback 并存）
async *runCompact(model, { signal, onDone }) {
  for await (const event of this.compactIfNeeded(model, { signal })) {
    yield event;
  }
  if (done && onDone) await onDone();
}

// 改造后（onEvent 推事件 + onDone 副作用 callback 并存）
async runCompact(model, { signal, onEvent, onDone }) {
  await this.compactIfNeeded(model, { signal, onEvent });   // 事件改 onEvent 推
  if (onDone) await onDone();                              // 副作用 callback 不变
}
```

### 阶段 5：`ToolManager.executeBatch()` — 回调化 ⚠️→✅

```javascript
// 改造前（generator，当前 L126-177）
//   现状语义：Promise.all 等所有并发工具完成 → 再按原序 yield tool_result
//   ⇒ 前端必须等最慢工具完成，快工具的"完成"才一起出现
async *executeBatch(toolCallsResult, { signal, isAborted }) {
  // ...
  for (const item of batch) {
    if (item.tool?.statusEvent) yield { event: 'status', data: {...} };
  }
  const results = await Promise.all(batch.map(item => this.execute(...)));  // ← 等全部
  for (let k = 0; k < batch.length; k++) {
    mm?.addToolResult(batch[k].tc.id, results[k]);
    yield { event: 'tool_result', data: {...} };                            // ← 才开始发
  }
}

// 改造后（callback，逐个完成即推）
async executeBatch(toolCallsResult, { signal, emit, isAborted }) {
  // ...
  await Promise.all(batch.map(async item => {
    if (item.tool?.statusEvent) emit({ event: 'status', data: {...} });
    const result = await this.execute(item.toolName, item.toolArgs, signal, ctx);
    mm?.addToolResult(item.tc.id, result);
    emit({ event: 'tool_result', data: { id: item.tc.id, status: ..., message: ... } });  // 谁先完成谁先推
    if (isAborted()) throw new DOMException('aborted', 'AbortError');
  }));
  return { aborted: false };
}
```

**callback 净优场景**：当前 `Promise.all` + 原序轮训锁死顺序，快工具的结果要等最慢的才一起发；callback 可逐个完成即推，前端工具状态更新更及时。收益真正来自放宽"结果按原序发出"语义（允许谁先完成谁先推），callback 只是让"并发回调里逐个推"写起来自然。前提：前端按 `tool_call.id` 拼装状态，`tool_result.data` 需补 `id` 字段（当前 payload无 id）。中断契约（`throw AbortError`）不变。

### 阶段 6：`Server.js` — 从 `for await...of` 改为 callback 订阅 ⚠️→✅

```javascript
// 改造前（拉模式，天然背压）
const stream = agent.receive(message);
for await (const event of stream) {                    // 消费慢 → 上游 yield 挂起
  res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

// 改造后（推模式，显式背压）
const emit = async (event) => {
  const data = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for (const r of currentResponses) {
    if (!r.write(data)) await new Promise(res => r.once('drain', res));  // 未 drain 则等
  }
};
await agent.receive(message, { emit });
```

---

## 五、总结：各层推荐方案

| 层级 | 当前 | 推荐 | 理由 |
|------|------|------|------|
| `LLMModel.chatStream()` | `yield` ✅ | callback（`await onChunk` 补背压）| 统一到 callback 架构；背压从天然变显式，补上即等价 |
| `Agent.reasoning()` | `yield*` ⚠️ | callback emitter ✅ | 核心业务逻辑不应被 generator 绑架；token/中断三件硬事可 1:1 映射 |
| `AbortFlow.runAborable()` | `yield*` ⚠️ | 普通 async + emit ✅ | 标准 AbortSignal 模式；须照搬 finishAborted 收尾事件 |
| `AbortFlow.finishAborted()` | `yield*` ⚠️ | 同步普通函数 ✅ | 收尾三事件顺序由语句序保证（含 mm 副作用：放弃未决压缩 + 存档 token） |
| `MessageManager.runCompact()` | `yield*` ⚠️ | onEvent 回调 ✅ | 事件推送非流程控制 |
| `ToolManager.executeBatch()` | `yield*` ⚠️ | onEvent 回调 ✅ | **净优**：逐个完成即推（放宽结果原序语义） |
| `Server.js` 消费端 | `for await...of` ⚠️ | callback 订阅 ✅ | 传输层只关心写入 |

### 关键原则

> **LangChain 的洞察**：Agent 循环是一系列**决策**（调用LLM？调用工具？停止？）。
> **流式输出是传输层关注点**——不应决定业务逻辑的结构。

Generator 模式制造了"流式化循环"的幻觉，代价是：
- 深度嵌套、难以测试、难以调试
- 业务逻辑与传输协议强耦合
- AbortError 在多层 generator catch 块中传播，控制流不透明

**callback 化的收益**：业务逻辑回归普通 async 函数（可测试、可 profile、可推理）；事件通过 emit 推送（传输层自行订阅）；tool 状态可逐个完成即推。

**callback 化的代价**：唯一实质代价是背压——`for await` 拉模式天然反压上游，callback 推模式需 `await onChunk`/drain 显式补回。补上即等价；不补则在快 LLM + 慢客户端场景有 buffer 堆积风险。其余（中断收尾时序、token ordering）均与 yield 版等价映射。

---

## 六、实施优先级

建议按以下顺序实施，每一步都保持测试通过：

1. **P0（高收益、低风险）**：`ToolManager.executeBatch()` → callback（净优：逐个完成即推；前端按 id 拼状态，payload 补 id）
2. **P1**：`AbortFlow.finishAborted()` → 同步普通函数（收尾三事件显式 emit + mm 副作用照搬：放弃未决压缩、存档 token，契约照搬）
3. **P2**：`AbortFlow.runAborable()` → 普通 async + emit 注入（须配合 P1）
4. **P3（核心、收益最大）**：`Agent.receive()` + `Agent.reasoning()` → callback emitter。`receive()`（入口，L293）从 `async *receive` 改 `async receive(msg, emit)`，内部 `await this.reasoning(msg, emit)`；`reasoning` 重写 4 段 `yield* runAborable` + 2 门控的控制流，token/中断三件硬事 1:1 映射、时序契约逐一对账。
5. **P4**：`LLMModel.chatStream()` → callback + `await onChunk` 背压（必须改；`await onChunk` 补背压不可跳过）
6. **P5**：`MessageManager.runCompact()` → `onEvent` 回调
7. **P6**：`Server.js` 从 `for await...of` 改为 async emit 订阅（背压 drain 处理）

> P3 放在 P0-P2 之后：reasoning 是核心循环体、风险最高（重写控制流 + 契约对账），先用低风险的 executeBatch / finishAborted 打底。`receive()` 入口与 reasoning 同步改造（P3），是 server.js 直接调用的边界，二者必须一起改才能接通主流 callback 通路。

> **落地结果（2026-07-22）**：P0–P6 全部按序落地，443 测试全绿，HTTP /chat 端到端冒烟通过。实际交付因 P0–P3+P5+P6 在 generator→callback 边界上强耦合（中间态不可运行），合为一批全量改造；P4（chatStream）作为末批独立接通。`shared/agent/` 主对话流零 generator 残留。