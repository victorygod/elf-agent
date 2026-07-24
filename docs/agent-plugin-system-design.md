# Agent 插件体系设计：Middleware + Callback

> v0.1 · 2026-07-21
> 关联：`room-as-agent-architecture.md`（v0.2 愿景）、`agent-refactor-plan.md`（v0.1 重构）、`agent-events-channel.md`

## 目标

1. **可替代**：通过 middlewares 注入完全替代 `room_agent.js`，行为逐字等价。
2. **零回归**：不注入 middlewares / callbacks 时与现状 agent 逐字一致。

借鉴 LangChain 两套分离的扩展机制，按本系统场景（单进程、单 Agent 类、Room 单 provider）落地。核心判断：我们的 reasoning 每轮内部是一次模型调用 ≡ LangChain react agent 的一个 step，**整套照搬，无诉求对立**。

- **Middleware**（拦截器）—— 拦截控制流 / 改 input / 门控。替代 RoomAgent 的载体。
- **Callback**（事件）—— 观察 / 发事件 / 跨请求异步。收编现有 `eventSink` + `/events` 通道。

## 借鉴 LangChain

**照搬**：两套分离（callback observer-only / middleware 管改值门控）；middleware 链式叠加 + 合并；`pre_model_hook`/`modify_request`（每步前跑，改 prompt/tools/state/注册工具）；callback fan-out + 多 handler + 异常自吞；同步主数据流 vs 旁路观察区分。

**对应**：我们的 `preReason` ≡ `modify_request`（每轮前跑），loop 内门控点（shouldBreak 等）≡ LangChain react loop 控制流扩展点——只是点位随用例而异。

**当前未实现、留口**（要时按 LangChain 方式加，不推倒）：请求级注入（`RunnableConfig`）；同步事件旁路 emit 给 callback（构架上 callback 与 yield 并存，当前只 emit 异步事件因暂无 tracing）；run_id 追踪；observer-class callback（tracing/metrics，handler 数组已就位）。

**不照搬**：callback 用于门控/改值（LangChain 自己禁止）。其余均为"当前没需求"而非"设计对立"。

## 扩展点盘点 → 归属

### Middleware

| # | 现状 | 点 | type | Room 填 |
|---|---|---|---|---|
| M1 | `_preReasoningHooks[]`（detectChangedFiles） | `preReason` | 注入 | detectChangedFiles + roster 刷新 + prompt 前缀 + 注册 Speak |
| M2 | RoomAgent.receive 重载 | `preReceive` | 门控 | drop/buffer/parse |
| M3 | `_doFlush` do-while + `_flushPending` | `mergeForReason`/`postReason` | 门控 | 合并/再 flush |
| M4 | reasoning 462 `含Speak→break` | `shouldBreakAfterTools` | 门控 | 含 Speak → true |
| M5 | reasoning 469-485 Speak 门控 | `onAssistantContent` | 门控 | inject reminder / break |

- 门控型（M2-M5）：决定控制流，链式叠加 + 合并语义。
- 注入型（M1）：改 prompt/注册工具/副作用，顺序执行累积。注册 Speak、prompt 前缀并入 `preReason`（首轮注册幂等、前缀注入幂等或自管已注入标记），不另设 `onInit`——对齐 LangChain `modify_request`。

### Callback

| # | 现状 | 对应 | 为什么归 callback |
|---|---|---|---|
| C1 | `eventSink`/`_pushEvent`/`/events` 通道 | 事件总线 + 多 handler | 后台 compact 完成是异步、跨 /chat 生命周期、广播多连接、不阻断压缩；现已是 fan-out(Set)，差结构化 handler 接口 + 异常自吞 |
| C2 | compact 事件 | `onCompact`/`onCompactError`/`onCompactStart`/`onCompactAbort` | 同步压缩走 yield、后台异步压缩走 callback |
| C3 | `SkillLister.inject` | 归 middleware(`preReason`) | 产物进 LLM input → 改值非观察 |

**不搬**：同步 yield 事件（token/status/tool_call/tool_result/done）为主数据流，不被 callback 替代（替代才乱序）。callback 可旁路 emit 一份（留口），当前不 emit。

## Middleware 设计

```js
this.middlewares = [];   // 按注册序

// 注入型：顺序执行，效果累积，无返回值
async _runInjection(point, ...args) {
  for (const m of this.middlewares) if (typeof m[point] === 'function') await m[point](...args);
}

// 门控型：链式，按点合并语义归并返回值；acc=null ≡ 无人接管 → 基类走默认
async _dispatchGate(point, ...args) {
  let acc = null;
  for (const m of this.middlewares) {
    if (typeof m[point] !== 'function') continue;
    const val = await m[point](acc, ...args);   // provider 见前序 acc 决定改不改
    acc = val ?? acc;
  }
  return acc;
}
```

全异步 `await`（preReason 内有 fetch/读盘）。`middlewares=[]` 时 `_dispatchGate` 返回 null → 基类走默认。

**合并语义**：

| 点 | 语义 | 筆 |
|---|---|---|
| `preReceive` | first-action-wins | 每条消息只有一个去向 |
| `shouldBreakAfterTools` | OR | 中断是安全倾向 |
| `onAssistantContent` | merge（reminder 拼接 / break OR） | 多 provider 可各注入提醒 |
| `postReason` | OR for reflush | 任一要求重 flush 即重 flush |
| `mergeForReason` | first-wins | 每轮合并文本唯一 |

**扩展点清单与默认**：

| 点 | 时机 | 签名 | 默认（不接管 = 现状） |
|---|---|---|---|
| `preReason(mm)` | 每轮 LLM 前 | `(mm) => Promise<void>` | no-op（`_preReasoningHooks` 迁入；注册 Speak/roster/前缀/detectChangedFiles） |
| `preReceive(payload)` | 每条消息 | `(acc, payload) => {action, text?, mentionedMe?, flushNow?}` | null → 基类 process（align→addUser→advance→reasoning） |
| `mergeForReason()` | flush 时 | `(acc) => string` | null → 不进入（process 不 flush） |
| `postReason()` | 每轮后 | `(acc) => {reflush:bool}` | null → 不重 flush |
| `shouldBreakAfterTools(tc)` | 工具批次后 | `(acc, tc) => bool` | null → false（现状 continue） |
| `onAssistantContent(content)` | 纯文本未调工具 | `(acc, content) => {break, injectReminder?}` | null → {break:true}（现状） |

**flush 循环上提到基类**：`_doFlush` 的 do-while + `_flushPending` 从 RoomAgent 挪进基类 receive 的 buffer 分支。私聊 preReceive 返回 null → 永不进入 flushLoop，零回归。`_speakAttempts`/`_buffer`/`_pendingBuffer`/`_replying` 等状态挪进 RoomMiddleware 实例字段。

**reasoning 两处硬编码 hook 化**：
- 462 `if (含Speak) break` → `if (await this._dispatchGate('shouldBreakAfterTools', null, tc) === true) break`
- 469-485 Speak 门控 → `const r = await this._dispatchGate('onAssistantContent', null, content); if (!r||r.break) break; if (r.injectReminder){addMetaMessage(r.injectReminder,'speak_reminder');continue;}`

## Callback 设计

```js
this.callbacks = [];   // duck-typing 方法可选

_emit(event, payload) {
  const m = 'on' + event[0].toUpperCase() + event.slice(1);
  for (const h of this.callbacks) {
    if (typeof h[m] === 'function') try { h[m].call(h, payload); } catch (e) { /* 自吞记日志 */ }
  }
}
```

| 事件 | handler | 现状对应 |
|---|---|---|
| compactStart | `onCompactStart` | `compact_start` |
| compact | `onCompact` | `compact`（经 eventSink） |
| compactError | `onCompactError` | `compact_error`（经 eventSink） |
| compactAbort | `onCompactAbort` | `compact_abort`（现走 yield，见下） |

**收编 eventSink**：`_pushEvent` 桥接到 `agent._emit`；SSE forwarder 包成 handler 入 `callbacks`（`onCompact(e){agent._pushEvent('compact',e);}` …）。mm 接口不变（仍注入单函数 eventSink），变的只是 agent 侧该函数内部从直写 SSE 改为 `_emit` fan-out。`callbacks=[sseHandler]` 时与现状逐字一致。

**同步事件留 yield**：循环内同步压缩产出、中断收尾、token/status/tool_result/done 继续走 reasoning yield → /chat。callback 总线只收后台异步压缩。yield 是主数据流、callback 是旁路观察/异步通知，两者并存不互斥。

**`compact_abort` 归属**：倾向留 reasoning yield（与 done/aborted 同批，保同步收尾时序）；外部有监听中断需求时才改 callback。待定。

## 两套载体关系：分立

```js
class Agent { constructor() { this.middlewares = []; this.callbacks = []; } }
```

两套各自接口、装机口、默认。一个 middleware 实例不需实现 callback 方法，反之亦然。不统一进 Plugin 基类（避免把"门控改值"和"观察发事件"两种异质语义塞一个对象）。Room 落点 `agent.middlewares=[roomMiddleware]`；前端落点 `agent.callbacks=[sseHandler]`，并存互不感知。协作对象（skillLister/abortFlow/toolManager/syncSource）不动，是 agent 器官非插件；其中 `SkillLister.inject` 的调用时机并入 `preReason`。

## 命名

- Middleware：`preReason` / `preReceive` / `mergeForReason` / `postReason` / `shouldBreakAfterTools` / `onAssistantContent`
- Callback handler：`onCompact` / `onCompactError` / `onCompactStart` / `onCompactAbort`
- type 标记：门控型 = 后五者；注入型 = `preReason`

## 零回归证明

| 扩展点 | 注入 Room | 不注入 |
|---|---|---|
| `preReceive` | drop/buffer/parse | null → 基类 process（= 现状私聊） |
| `shouldBreakAfterTools` | 含 Speak→true | null → false（= 现状 continue） |
| `onAssistantContent` | 第1次 inject+continue，第2次 break | null → {break:true}（= 现状） |
| `preReason` | 注册 Speak + roster + 前缀 + detectChangedFiles | 空 → no-op（= 现状） |
| `mergeForReason`/`postReason` | buffer 合并/reflush | null → 不进 flushLoop（= 现状） |
| callback `compact*` | sseHandler 转发 | 空遍历（= eventSink=null） |

`middlewares=[] && callbacks=[sseHandler]` 时 reasoning 全路径与现状逐字一致。

## 落地（6 阶段，每步保守、测试兜底）

0. ✅ **盘测试**：列 `room_agent.test.js` 覆盖场景，补 10 条缺口测试（`_doFlush` 多轮、`_flushPending` mention 继承、parse contents、roster 映射、consumeGap）。
1. ✅ **立骨架**：基类加 `middlewares`/`callbacks`/`_runInjection`/`_dispatchGate`/`_emit`，现存逻辑不动，空跑零回归。
2. ✅ **callback 收编 eventSink**：mm `_eventSink` 桥接 `_emit`，SSE forwarder 包成 handler；修了 `_emit` 事件名→handler 方法名驼峰转换 bug；补 10 条插件合同测。
3. ✅ **注入型迁移**：`_preReasoningHooks` 收编为 `preReason` middleware，detectChangedFiles 改 middleware 注册。
4. ✅ **门控型迁移**：reasoning 两处 `mode==='room'` 硬编码 → `_dispatchGate`，RoomGateAdapter 承接（后并入 RoomMiddleware）；基类 reasoning 已无 room 硬编码。
5a. ✅ **RoomMiddleware 建成**：Room 行为（buffer/flush/parse/roster/consumeGap/prompt/syncMissingHistory + gate 门控 + preReason 重置 _speakAttempts）整体迁入 `room_middleware.js`；RoomAgent 退成代理壳（getter/setter 转发）；`_speakAttempts` 迁入 RoomMiddleware 实例；删 RoomGateAdapter；修了 handleReceive 非 chat 递归 bug。

**当前状态：全量 443 测试全绿。v0.2 "Room is Plugin、引擎与修饰分离" 全部落地，RoomAgent 类已删除。**

5b. ✅ **基类 receive 上提 + start.js 直推**：基类 receive 加 buffer 分支 + `_roomFlushLoop` 上提；RoomMiddleware 拆门控点被基类回调；删 `handleReceive`；start.js 删 `setPrototypeOf` 改 `middlewares.push(new RoomMiddleware)` 直推。

5c. ✅ **删 RoomAgent 代理壳**：测试工厂改 `new Agent + push RoomMiddleware`，访问点 `a._buffer` 等改 `a._rm._buffer`（agent 挂 `_rm` 引用 RoomMiddleware）；删 `room_agent.js`；清 shared/agents 各处 "RoomAgent" 注释为 "RoomMiddleware"；server.js /clear 清 room buffer 改遍历 middlewares 找 RoomMiddleware（RoomAgent 删除后 agent 无 `_buffer` 字段）。

6 待定（对账，非功能）：更新 `room-as-agent-architecture.md` 现状段。

## 不做

- 不碰 reasoning 核心循环体（LLM 调用/工具执行/压缩算法/abort 触发），只在两个门控点插 middleware。
- syncSource、Speak 工具本身不动（只改门控/Speak-break 的 middleware 化）。
- 不做请求级注入、callback 同步事件替代 yield、统一 Plugin 基类。
- 不做"私聊即 2 人 Room"合并（下一阶段）。

## 待定 / 风险

- **门控合并语义实测**：OR/first-wins/merge 当前 Room 单 provider 无实测，加第二个门控 provider 时补合并测试。
- **prompt 前缀每轮注入幂等**：并入 `preReason` 后默认每轮跑，实现需幂等或自管已注入标记。
- **RoomMiddleware 状态隔离**：确认 setPrototypeOf 形态彻底移除、无残留字段挂 agent。
- **测试字段改名**：`_buffer` 等 → `roomMiddleware._buffer`。
- **最高风险**：阶段 5 `_doFlush` 上提 + 状态迁移，跨 reasoning 边界 reflush 循环——必须阶段 0 先补测试覆盖。