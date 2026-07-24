# Agent 重构计划

> 版本：v0.1
> 日期：2026-07-19
> 关联：`room-as-agent-architecture.md`（架构愿景）、`interface-analysis.md`（接口现状）

按"业务能力 + 明确依赖接口"原则，逐步把 `default_agent.js` 里职责混杂的逻辑拆成独立模块。每一步保守、功能无 diff、有测试兜底。

---

## 总目标

`default_agent.js` 现状是 843 行的单体类，一个 `Agent` 类同时承担：工厂装配、进程生命周期、私聊 seq 同步、skill 清单注入、记忆压缩驱动、工具编排、room 门控、核心 reasoning 循环。重构目标是把**有明确依赖接口的业务能力**抽成独立模块，`Agent` 类收敛为"持有一组协作对象 + 编排主线"。

拆分原则（硬标准）：能抽出的能力必须满足 **Agent 只通过几个固定方法用它、不碰它的内部状态**。

---

## 已完成：SkillLister（v0.1）

**状态**：✅ 已完成、已验证（339 单测全绿）

### 问题
`default_agent.js` 里约 160 行 skill 相关代码（6 方法 + 4 字段）挂在 `Agent` 类上，但逻辑上全属于 skills 领域——只是因为要读写 `this.messageManager`（`skillListing` 字段、`addMetaMessage`）才宿主在 Agent。Agent 本身对 skill 一无所知。

### 方案
新建 `shared/agent/skills/lister.js` 的 `SkillLister`，把 skill 注入层整体迁出（数据层的 `SkillRegistry`/`parser`/`prompt` 已在 `skills/` 目录）。Agent 对 skill 的依赖从"6 方法 + 4 字段"收窄为 `inject() / reset() / reinvokeAfterCompact() / recordInvoked() / registry(getter)`。

### 行为分叉点（唯一）
原 `_resetSkillPushState()` 只清快照不清 invoked；原 `_reinjectMetaMessages()` 借它做"compact 后只清快照保留 invoked"。迁移后语义两分：
- `reset()` —— 全清（/clear 用，会话重开）
- `reinvokeAfterCompact()` —— 内部只清快照、**保留** invoked（compact 恢复用）

### 改动文件
| 文件 | 改动 |
|---|---|
| `shared/agent/skills/lister.js` | 新增 SkillLister |
| `shared/agent/default_agent.js` | 删 ~160 行 skill 代码，挂 `skillLister`，工厂/reasoning 两处委托 |
| `shared/agent/tools/Skill.js` | `_skillRegistry.get` → `skillLister.registry.get`；`_invokedSkills.push` 收口为 `list.recordInvoked` |
| `shared/agent/server.js` | `/clear` 收敛为 `skillLister.reset()` + `skillLister.inject()` |
| `test/skills.test.js` | 访问点改 `agent.skillLister.xxx`；2 处语义微调 |

---

## 已完成：SyncSource

**状态**：✅ 已完成、已验证（全量 383 测试全绿；连发相同内容回归测试从红转绿证 bug 已修）

### 现状诊断

`receive` 里的 seq 同步逻辑在基类 `Agent`（`_ensureSync`/`_advanceCursor`/`_alignSeq`/`_seedCursor`/`_fillGap`）和 `RoomAgent`（同名 5 个）**重复两份**：

| 方法 | 重复度 |
|---|---|
| `_alignSeq` | 几乎逐行相同（骨架：seed / 回退 / 连续 / 空洞四分支，唯一差是 room 多几行日志） |
| `_ensureSync` / `_advanceCursor` | 几乎逐行相同（room 多个 `Number/isNaN` 防护） |
| `_seedCursor` | 结构相同，只差 URL（`/agents/:id/sync-history` vs `/rooms/:rid/sync-history/:agentId`） |
| `_fillGap` | 结构相同，差异在"收到消息后怎么消费"（addUserMessage vs push buffer+mention） |

**关键现状**：基类这套 sync 在私聊路径下是**"假死"**——私聊 `runContext.dataDir` 是 null（`buildPrivateRunContext` 不传 dataDir，`ProcessManager` spawn 私聊 agent 也不传 `--data`），`_ensureSync` 因此建不出 SyncCursor，`_alignSeq` 经 `cursor==null → seedCursor 空操作 → cursor=seq-1 → 连续 → return` 全程短路。结果：**私聊 agent 离线时用户发的消息（走 `/chat` 返回 202 queued + 写 history）上线后无人补回，静默丢失**。Room 那套因为是活的（`runContext.dataDir` 在 room 模式 fail-fast 强制非空），被 `room_agent.test.js` 覆盖。

sync 在 receive 里高度集中、对 Agent 的依赖接口明确（就 `align(seq)` + `advance(seq)`），是典型的"适合封装"形状。

### 目标：接活私聊 sync + 抽 SyncSource（一步到位）

本轮不止抽 `SyncSource`，还**把私聊 sync 接活**——让私聊和 Room 走同一套 sync 机制，为后续"私聊即 2 人 Room"留好接口。私聊接活的可见行为变化是**修掉"离线消息静默丢失"的 latent bug**（场景 B），其余场景要么行为一致（场景 A），要么可接受（场景 C），要么暂不处理（场景 D，见下）。

### 去重语义：统一用 seq 去重（关键决策）

经分析**统一为 seq 去重**，删掉基类的内容去重。

**Room 按 seq 去重（`_processedSeqs`）——保持不变**——防双通道重复投递：
```
群里 elf-001 断线 5s。期间 user 发 seq=10 "你好"：
  observe 实时到 seq=10 → _processedSeqs.add(10) → 进 buffer
  fillGap 补洞到  seq=10 → _processedSeqs.has(10) 命中 → 跳过
（同一条从 /observe 和 _fillGap 两个通道各来一次，Room 才需要这个 Set）
```

**私聊原按内容去重（`existingUserContents.includes`）——删除**——有静默丢消息 bug：
```
私聊连发两条相同内容时触发 fillGap：
  context 已有 user:"嗯"（seq=10）
  用户又发 "嗯"（seq=20）→ fillGap 若拉回与之内容重复的条目
  → 内容命中 → 跳过 → 静默丢消息
```
私聊单通道（只有 /chat），fillGap 只补 `cursor+1..seq-1` 历史空洞、绝不补当前 seq，每补一条就 `advance(seq)`——**seq 自然推进本身就是去重**，不需要内容去重，也不需要 `_processedSeqs` Set。去掉内容去重后：正常路径行为不变、连发相同内容的丢消息 bug 消除。

> ⚠️ 私聊 `onGapMessage` **不引入任何去重逻辑**，靠 SyncSource 内 `advance` 天然去重；Room `onGapMessage` 保留 `_processedSeqs`（seq）去重防双通道。两者都不再用内容去重。

### 已知局限（暂不处理）：场景 D 的一次性重复

> 接受现状，不在本轮处理。

D = `addUserMessage` 写 context 成功、但紧接的 `advance(seq)` 前进程崩溃 → 重启后 sync_cursor 落后于 context → fillGap 把已在 context 里的消息再 `addUserMessage` 一次 → context 落一条重复消息。

- seq 去重（内存 Set）重启即清空，防不住 D；内容去重能防住但有连发误杀 bug，已决定删。两者都选 seq 去重，故 D 不可避免。
- 但 D **只重复一次**：第一次重复后 fillGap 推进 cursor 到该 seq 并落盘，下次重启 cursor 已跟上，不再补。不累积、低概率（要求崩在极小窗口）。
- 权衡：接受 D 的一次性重复，换掉确定性的连发误杀 bug。两害相权取其轻。本轮不为此引入复杂对账逻辑。

### 场景 ABCD 行为对照

| 场景 | 现状（sync 死） | 接活 + seq 去重后 | 判定 |
|---|---|---|---|
| A 在线正常对话 | 收消息不补洞，addUserMessage，advance 空操作 | `cursor+1===seq` 不补洞，addUserMessage，advance | 一致 ✓ |
| B agent 离线后用户发消息 | 202 queued，消息永不上线 | 上线后首条消息触发 fillGap，补回漏掉的 user 消息进 context | 修 latent bug ✓ |
| C 重启且 sync_cursor 丢失 | 啥也不补 | seedCursor 把 cursor 置成 gateway latestSeq，跳过历史；极端情况下可能连续 user | 可接受（你说无所谓）✓ |
| D cursor 落后于 context | 不补（死） | 仅一次性重复一条，不累积 | 已知局限，暂不处理 ⚠️ |

### 文件落点：合并 SyncCursor + SyncSource

两者都是"消息同步"这一块业务——SyncCursor 是同步的**进度记录**（状态），SyncSource 是同步的**对齐算法+拉取+投递**（行为）。合起来才是完整同步能力，应放同一文件。测试随之改 import 即可（测试跟随业务结构，不反之）。

### 方案

新建 `shared/agent/sync_source.js`，export `SyncCursor`（从 sync_cursor.js 迁入）+ 新 `SyncSource`。`SyncSource` 持有 `SyncCursor`，对齐算法只一份：

```js
class SyncSource {
  constructor({ dataDir, syncSourceUrl, onGapMessage, logger })
  ensure()                          // 原 _ensureSync
  advance(seq)                      // 原 _advanceCursor（含 Number/isNaN 防护）
  getCursor()
  async align(seq)                  // 原 _alignSeq 骨架，唯一一份
  async _seed()                     // 用 syncSourceUrl
  async _fillGap(from, to)          // 拉取+范围过滤+推进 cursor；逐条 await onGapMessage(msg, from, to)
}
```

- `dataDir`：SyncCursor 落盘目录。**私聊用 MessageManager 的 dataDir**（`agents/<id>/data`，由 fromConfigDir 回退得到），不是 `runContext.dataDir`（私聊为 null）。Room 用 `runContext.dataDir`（room 模式 fail-fast 保证非空）。
- `syncSourceUrl`：私聊 `${gatewayUrl}/agents/${agentId}/sync-history`；room `${roomBusUrl}/sync-history/${agentId}`。
- `onGapMessage(msg, from, to)`：调用方决定怎么消费 + 如何去重。签名支持同步/异步（内部 `await` 它，对同步回调零成本，留 async 口子）。去重逻辑留在回调内，不下沉 SyncSource。
  - 私聊：纯 `addUserMessage(msg.content)`，**不加去重**。
  - Room：`_processedSeqs` seq 去重 + 自消息过滤 + `_parse` 加前缀 + push buffer + mention 追踪。
- 基类 `Agent` 和 `RoomAgent` 各删 5 个 sync 方法，改持 `this.syncSource`；receive 里 `await this.syncSource.align(seq)` + `this.syncSource.advance(seq)`。

### 风险提示

基类私聊 sync 路径**零单测覆盖**（`run_context.test.js`/`agent.test.js` 都没测 `_alignSeq`/`_fillGap`/`_seedCursor`）。Room 那套有 `room_agent.test.js` 兜底。再加上本轮要 **私聊接活（行为变更）+ 删内容去重**，所以**必须先补私聊 sync 单测 + 离线补回 / 连发相同内容回归测试**，让测试先锁住现状、暴露 bug、再随重构转绿，否则无网可兜。

### 执行顺序

1. **补测试覆盖**（先于一切代码改动，让现有实现先被测试锁住）：
   - 私聊 sync 路径单测（`_alignSeq`/`_fillGap`/`_seedCursor` 主分支：seed/连续/回退/空洞）——此前零覆盖。注意现状私聊 dataDir=null 让 sync 假死，测试需显式注入 dataDir 才能测到真实逻辑。
   - **离线补回**回归测试（接活后私聊离线消息应被补回，现状会失败 → 接活后转绿）。
   - **连发相同内容不丢消息**回归测试（现状内容去重会丢 → 删内容去重后转绿）。
   - 确认 room_agent.test.js 已覆盖 Room 的 seq 去重（双通道防重复投递），缺则补。
2. 建 `sync_source.js`（SyncCursor 迁入 + SyncSource 新建）。
3. 改基类 `Agent`：删 5 个 sync 方法 + 删内容去重，持 `syncSource`（注入 MM dataDir + 私聊 URL + 无去重 onGapMessage），receive 委托。
4. 改 `RoomAgent`：删 5 个 sync 方法，持 room 版 `syncSource`（注入 room 版 URL + room 版 onGapMessage 含 `_processedSeqs`）。
5. 跑全量测试——重点：第 1 步的离线补回 / 连发相同内容回归测试应从红转绿（证明 latent bug 已修）。

### 落地结果（已完成）

- 新建 `shared/agent/sync_source.js`：`SyncCursor`（从 sync_cursor.js 迁入零改动）+ `SyncSource`（`align`/`advance`/`seed`/`getCursor`，对齐算法唯一一份，消费+去重经 `onGapMessage` 回调）。
- 删 `shared/agent/sync_cursor.js`。
- 基类 `Agent`：删 5 个私聊 sync 方法 + 内容去重；`receive` 委托 `syncSource.align/advance`；新增 `_ensureSyncSource()` 惰性构建，dataDir 用 `messageManager.dataDir`（接活关键——绕过私聊 `runContext.dataDir=null` 的假死）。
- `RoomAgent`：删 5 个 Room sync 方法；`_ensureState` 建 room 版 syncSource，`onGapMessage = _consumeGapMessage`（自消息过滤 + `_processedSeqs` seq 去重 + parse + buffer + mention）；`receive`/`syncMissingHistory` 改委托。
- 测试：`sync_cursor.test.js` import 改自 sync_source.js；`sync_source.test.js` 访问点改走 syncSource，连发相同内容回归测试**去 skip 转绿**；`room_agent.test.js` 的 `_syncCursor`→`syncSource.cursor`、`_advanceCursor`→`syncSource.advance`。

### 验证

- 全量 383 测试全绿，0 失败，串行跑自然退出。
- **连发相同内容回归测试**：现状（内容去重）时红（seq=2,3 的"嗯"被静默丢弃，只补出 2 条 user），删内容去重后绿（补出 4 条）。bug 被测试精确证实已修。
- Room fillGap 真实拉取 5 个测试全绿，填补此前"骨架被测、补洞没测"的缺口。

### 唯一可见行为变化

私聊接活：agent 离线后用户发的消息（走 /chat 返回 202 queued + 写 history），上线后由 receive 的 `syncSource.align` 触发 fillGap 补回进 context。修复此前"离线消息静默丢失"的 latent bug。其余路径（cursor 连续不补洞、Room 双通道 seq 去重）行为零 diff。

### 已知局限（暂不处理）

场景 D（cursor 与 context 偏移导致一次性重复）——低概率、不累积，接受现状。

---

## 已完成：Compactor

**状态**：✅ 已完成、已验证（全量 386 测试全绿）

### 现状诊断

compactor 机制现在分散在三处：

| 位置 | 内容 | 行数 |
|---|---|---|
| `message_manager.js` | 压缩**本体**：8 个状态字段 + `compactIfNeeded`（双模式 generator，140 行，7 个分支揉一起）+ `_doCompact`（核心）+ `_applyResultSync`/`_applyBgResult`（两份近似 apply）+ `_groupByAssistantTurn`/`_countCompactableTokens` + 断路器 + 未决任务管理 + `abortBackgroundCompact` | ~350 |
| `default_agent.js fromConfigDir` | events 桥接：`_onBgCompactDone`/`_onBgCompactError` 回调硬编码挂 mm，含 apply + `pushEvent` + 日志三件事焊死；`_pushEvent` 挂载时序靠惰性闭包兜底 | ~35 |
| `default_agent.js reasoning` | 循环内压缩（386-410）+ 兜底压缩（611-635）两处**逐行复制粘贴**；6 处 `_abortCompactBubble` 样板 | ~50 |

亮点（已做对、保留不动）：断路器（连失 3 次禁用）；`COMPACT_MIN_SAVINGS` 预判（老区 token<500 不压，涵盖单组对话）；compactId 锚定前端气泡（失败重试跨轮复用同气泡）；events 通道解耦（async 不阻塞对话的根基）；anchor 锚定保留 group。

### 封装边界判断

compactor 与 message_manager **强耦合同生共死**——压缩的输入是 mm 的 `messages`、输出也写回 `messages`，还要读 `estimateTokens`/`systemPrompt`/调 `_save`。与 skill/sync 不同（skill 只用 mm 两个方法、sync 完全不碰 mm）。

→ **结论：compactor 留在 message_manager.js，不抽独立类。** 抽成 `Compactor` 类会是"持有 mm 引用、疯狂调 mm 私有方法"的更脏结构。本轮做的是 mm **内部重构** + 给 agent 一个干净入口消灭 reasoning 复制粘贴。

### 方案

**① `compactIfNeeded` 只做编排（拆 7 步）**

现在 7 步揉在一个 generator：① `_bgDone` 就绪→apply → ② 还超阈值? → ③ `_bgFailed` 待报 → ④ 老区 token<MIN_SAVINGS 跳过 → ⑤ async 触发 → ⑥⑦ blocking 同步。拆成私有方法，`compactIfNeeded` 只做编排：

```
compactIfNeeded(model, opts)           // 编排：依次调下面，决定走哪条
  *_applyReadyBgResult()                // ① 后台结果就绪 → apply + yield compact/error
  *_reportBgFailure()                   // ③ 上轮后台失败待报 → yield compact_error
  *_triggerAsync(model, opts)           // ⑤ 后台触发 + yield compact_start
  *_triggerBlocking(model, opts)        // ⑥⑦ 同步 _doCompact + yield compact/error
  // ②（超阈值检查）、④（MIN_SAVINGS 预判）内联在编排里
```

纯内部重构，行为零 diff。

**② 两个 apply 合一**

`_applyResultSync`（blocking）和 `_applyBgResult`（async）合并为一个 `_applyResult({summary, anchorId})`，async/blocking 共用。消除"两条 apply 路径各漏一处"的风险。两者差异（async 有 anchorId===null 全量替换分支、anchor 丢失算失败）合并进同一个方法的条件分支里。

**③ events 桥接收口**

mm constructor 加 `eventSink` 参数（`(eventName, data) => void`）。`_onBgCompactDone`/`_onBgCompactError` 的逻辑从 `fromConfigDir` 内联搬进 mm 的私有方法，内部调 `this._eventSink('compact'/'compact_error', ...)`。`fromConfigDir` 只剩"构造 mm 时传 eventSink = (...args)=>agent._pushEvent?.(...args)"一行（或直接让 agent 把 `_pushEvent` 在就绪后赋给 mm）。

消灭：fromConfigDir 35 行硬编码 + 惰性闭包时序耦合。mm 不再被 agent 的工厂方法反过来挂私有方法。

**④ reasoning 两处压缩样板收敛**

mm 加公共入口 `*runCompact(model, { onDone })`：内部建 AbortController → `for await compactIfNeeded` 转发事件 → compact 完成后调 `onDone()`（agent 传 `()=>this.skillLister?.reinvokeAfterCompact()`）。reasoning 循环内、兜底两处都收敛成 `yield* this.messageManager.runCompact(this.model, { onDone: ()=>this.skillLister?.reinvokeAfterCompact() })`。

注意：AbortController 的归属。现状 reasoning 每次 new 一个存 `this._abortController`，abort() 停它。`runCompact` 内部建 AC 意味着压缩的 AC 和 LLM 的 AC 分离——`agent.abort()` 要能同时停两个。现状 `abort()` 已调 `mm.abortBackgroundCompact()`（停后台压缩），只需确认 `runCompact` 的前台 AC 也被一个 abort 入口覆盖。**保守做法**：`runCompact` 不自建 AC，由调用方传入 signal（reasoning 把当前轮的 `this._abortController.signal` 传进去）——这样 abort 机制完全不动，只消灭复制粘贴。**选这个**。

**⑤ 顺手：mm 加 `abandonPendingCompact()`（仅状态清理）**

`_abortCompactBubble` 的状态清理部分（读 `_pendingCompact` + `_endCompactAbandoned`）收进 mm 公共方法 `abandonPendingCompact()`，返回 `{compactId} | null`。agent 的 `_abortCompactBubble` 简化为：

```js
* _abortCompactBubble() {
  const pc = this.messageManager?.abandonPendingCompact();
  if (pc) yield { event: 'compact_abort', data: { compactId: pc.compactId } };
}
```

6 处调用不变。**顺手把 compactor 状态清理归位到 mm，但不消灭 6 处 abort 样板**——那是 AbortFlow 的范畴，且不能让 mm yield 前端事件（职责倒退）。

### 不做（明确划界）

- **不消灭 reasoning 6 处 `_abortCompactBubble` + aborted/done 三件套样板**。理由：`compact_abort` 是前端 UI 事件，不该由 mm yield；且这 3 件套是 AbortFlow 的事。留到 AbortFlow 那轮，基于 `abandonPendingCompact()` 接口做。
-.mm 不新增任何 yield 前端事件的方法（保持 mm = 状态/记忆管理，不碰前端 UI 事件）。`compactIfNeeded` 现有 yield compact/compact_error 等是历史既有行为，保留；但不新增类似入口。

### 风险

| 项 | 风险 | 缓解 |
|---|---|---|
| ①拆 7 步 | 中，140 行重排易引入 subtle 行为差 | 测试网兜底（见下），逐步拆、每步跑测试 |
| ②合并 apply | 中，anchor===null 全量替换分支/anchor 丢失算失败的边界 | 单测覆盖这两个边界 |
| ③events 收口 | 低-中，改 mm constructor 签名 + fromConfigDir | eventSink 可选（默认 no-op），现有测试直接构造 mm 不传也兼容 |
| ④runCompact | 低（保守变体：不自建 AC、signal 由调用方传），abort 机制不动 | runCompact 透传 signal |
| ⑤abandonPendingCompact | 零，纯状态方法抽取 | — |

### 测试覆盖盘点（动手前先确认）

现有压缩测试在哪？需先 grep 确认 `compact` 相关测试覆盖了哪些分支，缺哪些要先补。预计：
- async 模式（后台完成→apply→pushEvent compact）
- blocking 模式（同步 _doCompact→yield compact）
- 断路器（连失 3 次禁用）
- MIN_SAVINGS 预判（老区不足跳过）
- anchor===null 单组全量替换、anchor 丢失算失败
- compact_error 各路径（空回复、无可压缩、异常）
- abort 收尾（abandonPendingCompact 清状态）

缺的先补全，再动重构。

### 执行顺序

1. **补/确认测试覆盖**（先于代码改动）：grep 现有 compact 测试，确认上述分支被覆盖，缺则补。
2. ②合并 apply（`_applyResultSync`+`_applyBgResult`→`_applyResult`），跑测试。
3. ①拆 `compactIfNeeded` 7 步成私有方法，跑测试。
4. ③events 收口（mm 加 eventSink 参数 + 搬 `_onBgCompactDone`/`_onBgCompactError` 进 mm），改 fromConfigDir，跑测试。
5. ④`runCompact` 入口 + reasoning 两处收敛，跑测试。
6. ⑤`abandonPendingCompact` 抽取 + `_abortCompactBubble` 简化，跑测试。

### 落地结果（已完成）

- ① `compactIfNeeded` 拆成编排：步骤 1/3/5/6-7 抽成 `_handleReadyBgResult`/`_reportBgFailure`/`_triggerAsync`/`_triggerBlocking`，`compactIfNeeded` 只编排。对外 generator 契约不变（测试全绿）。
- ② apply 合并**未做**（review 后撤回）：`_applyResultSync`/`_applyBgResult` 的 4 处分歧是 async/blocking 模式差异的忠实体现，非重复，合并会引入 mode 分支增加复杂度。保留两个独立方法。
- ③ events 收口：mm constructor 加 `eventSink` 参数（默认 no-op）；后台完成/失败逻辑固化进 mm 的 `_bgCompactDoneHandler`/`_bgCompactErrorHandler`（调 `this._eventSink`）；`fromConfigDir` 删 35 行反挂逻辑，改成 `agent.messageManager._eventSink = (...args) => agent._pushEvent?.(...args)` 一行（时序靠闭包惰性，和原来一样但只有一个出口而非两个反挂方法）。
- ④ `runCompact(model, {signal, onDone})` 入口：转发 `compactIfNeeded` 事件 + compact 成功后调 `onDone`。reasoning 循环内、兜底两处都收敛成 `yield* this.messageManager.runCompact(this.model, {signal, onDone: ()=>this.skillLister?.reinvokeAfterCompact()})`。`onDone` 是 agent 注入回调，compactor 不知其内容（职责不耦合）。signal 由 reasoning 传（abort 机制不动，abort 收尾仍归 reasoning）。
- ⑤ `abandonPendingCompact()`：把 `_abortCompactBubble` 的状态清理收进 mm 公共方法，返回 `{compactId}|null`。agent 的 `_abortCompactBubble` 简化为"调它、有结果 yield compact_abort"。6 处调用点不变（消灭 6 处 abort 样板留 AbortFlow 那轮）。

### 落地中暴露的两点

1. 第18条"async 多组压缩"测试原意是"不注入回调→后台完成不立即 apply→留下一轮"——这是非生产边角（生产必注入 eventSink）。收口后 handler 固化，改成"注入 eventSink→后台完成立即 apply"的生产语义，断言 eventSink 收到 compact。
2. agent.test.js 两处 `_onBgCompactDone`/`_onBgCompactError` 赋值测试，③收口后改成"赋 `mm._eventSink` + 断言事件"——和 skill/sync 那次改访问点同构。

### 验证

- 测试先补：动手前补了 3 条 apply 边界（anchor===null 全量替换、async anchor 丢失算失败记断路器、blocking anchor 丢失退化保留），锁住 async/blocking 对 anchor 丢失的相反语义。
- 全量 386 测试全绿，0 失败，串行跑自然退出。

### 改动文件
| 文件 | 改动 |
|---|---|
| `shared/agent/message_manager.js` | 拆 compactIfNeeded（4 个私有 generator）；加 eventSink 参数；加 `_bgCompactDoneHandler`/`_bgCompactErrorHandler`；加 `runCompact`；加 `abandonPendingCompact` |
| `shared/agent/default_agent.js` | fromConfigDir 删 35 行反挂、改一行赋 eventSink；reasoning 两处压缩改 runCompact；`_abortCompactBubble` 简化为调 abandonPendingCompact |
| `test/agent.test.js` | 补 3 条 apply 边界测试；2 处 events 通道测试改 eventSink 注入；第18条 async 多组测试改生产语义 |

---

## 已完成：AbortFlow

**状态**：✅ 已完成、已验证（全量 391 测试全绿）

### 现状诊断

`reasoning()` 里 6 处"中断收尾样板"，每处形态是 `yield* _abortCompactBubble()` → 视情况保留已生成内容 → yield `aborted` → yield `done` → return。位置：压缩期间中断、LLM 流 catch 里中断、LLM 流结束后检查中断、工具并发段中断、工具串行点中断、兜底压缩中断。

样板分两类：
- **类型 A（纯收尾，5 处）**：无已生成内容要保留，直接三件套。
- **类型 B（1 处，LLM 流 catch，line 418-432）**：多了"中断时若已有 token 流出，调 `addAssistantMessage` 保留"的分支。

6 处手写，每处 4-8 行，改一处忘一处的风险高（已经发生过：早期 abort 后 typing 不消失就是漏 yield done）。

### 封装边界判断

AbortFlow **不是独立业务能力**——它没有自己的领域（不像 skill/sync/compactor），它的存在完全依附于 reasoning 的中断检查点。只有 reasoning 知道"我刚调完 LLM/工具/压缩，这里该检查一下是否被中断"。

→ 两个结论：
1. **抽不出"中断检查点"**：那是 reasoning 的控制流，硬抽成回调会变回调地狱。reasoning 保留 `if (被中断)` 这种检查点。
2. **抽得走"被中断后怎么收尾"**：三件套 + 内容保留 + aborted/done。这才是 6 处重复的样板，收口到一个生成器。

所以"agent 尽可能不关心 abort"的**可实现边界**是：reasoning 只保留中断**检查点**（一行 if），**中断后所有收尾动作**交给 AbortFlow。风格上仍是"协作对象 + 窄接口"，但 AbortFlow 更像"reasoning 的收尾 helper"而非独立领域。

### 方案：新建 `shared/agent/abort_flow.js`，统一 `_finishAborted`

**AbortFlow 类**（持 messageManager 引用，唯一公共方法 `*finishAborted(reason, fullContent)`）：

```js
class AbortFlow {
  constructor({ messageManager }) { this._mm = messageManager; }

  // 统一收尾：压缩气泡 + 保留已生成内容 + aborted + done
  async *finishAborted(reason, fullContent = '') {
    // 1. 收尾压缩气泡（有未决压缩 → yield compact_abort）
    const pc = this._mm?.abandonPendingCompact();
    if (pc) yield { event: 'compact_abort', data: { compactId: pc.compactId } };
    // 2. 中断时保留已生成内容（类型 B：LLM 流中断时已流出 token 存为 assistant 消息）
    if (fullContent) this._mm?.addAssistantMessage(fullContent);
    // 3. 报中断 + done
    yield { event: 'aborted', data: {} };
    yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
    return reason;   // 给 yield* 调用方一个信号（备用，便于将来决定是否 continue）
  }
}
```

**`_finishAborted` 取代 `_abortCompactBubble`**：原 `_abortCompactBubble` 的逻辑（调 `abandonPendingCompact` + yield compact_abort）被 `finishAborted` 的步骤 1 吸收，删掉。

**reasoning 6 处统一收敛**：
```js
// 类型 A（5 处）：无内容
if (this._checkAborted(fullContent)) {       // 或 catch 里 if (err.name === 'AbortError' || this._aborted)
  logger.info('用户中断了请求（...）');
  yield* this.abortFlow.finishAborted('reason');
  return;
}
// 类型 B（1 处，LLM 流 catch）：传 fullContent
yield* this.abortFlow.finishAborted('llm-stream', fullContent);
return;
```

注意：类型 B 原来用 `_checkAborted(fullContent)` 做"判断+保留"合一，现在拆开——catch 里已经判断了是 AbortError，直接 `finishAborted(reason, fullContent)` 让它保留。`_checkAborted` 仍用于类型 A 的"判断"（返回 bool），但不再负责内容保留（保留移到 finishAborted）。

**AbortFlow 的注入**：`fromConfigDir` 里构造 agent 后 `agent.abortFlow = new AbortFlow({ messageManager: agent.messageManager })`（和 skillLister 同样的 opt-in 风格，但 abortFlow 默认就建——它无门控、零开销）。或 constructor 内直接 `this.abortFlow = new AbortFlow({ messageManager })`。倾向 **constructor 内建**：abort 无 opt-in 概念，每个 agent 都需要收尾能力，且 messageManager 构造时就在。

### 不动（明确划界）

- **`abort()` / `_aborted` / `_abortController` / `_checkAborted` 留在 Agent**。这些是中断的"触发与判断"，是 reasoning 控制流的一部分。现有 5 条 abort 测试直访 `agent._aborted`/`agent._abortController`，不动它们测试不破。
- **`_checkAborted` 语义微调**：原来"判断+保留"合一，现在只保留"判断"（返回 bool），内容保留移到 `finishAborted`。检查现有调用点——类型 A 用 `_checkAborted(fullContent)` 但 fullContent 可能是 `''`（工具段 line 526/546 传的是 `''`）或真实内容（LLM 流后 line 441）。重构后：`_checkAborted` 只判 `_aborted`（fullContent 参数废弃或仅日志用），保留动作由 finishAborted 接管。
- **不碰 abort 的 signal 分发**：压缩用独立 `_bgAbortController`、LLM/工具复用 `this._abortController`，这套时序不动。AbortFlow 只管收尾，不管 signal。

### 风险

| 项 | 风险 | 缓解 |
|---|---|---|
| 类型 B 拆 `_checkAborted` 的"判断+保留" | 中，原 `_checkAborted(fullContent)` 在 LLM 流后（line 441）传真实 fullContent，既要判中断也要保留；拆开后判断在 if、保留在 finishAborted，顺序要对 | 仔细核对 line 441：`if (_checkAborted(fullContent))` 时若 `_aborted` 为真且 fullContent 有值 → 进 if → `finishAborted(reason, fullContent)` 保留。语义等价 |
| 测试直访 `_aborted`/`_abortController` | 5 条测试，不动这些字段就不破 | AbortFlow 不持有这俩，留 Agent |
| `finishAborted` 是 generator，yield* 委托顺序 | 低，compact_abort → (保留无 yield) → aborted → done，顺序和现状一致 | 对照现有 6 处事件顺序逐个验证 |
| `_checkAborted` 参数语义改变 | 中，多处调用 | 全 grep `_checkAborted` 调用点，挨个核对 |

### 测试覆盖盘点（动手前确认）

现有 abort 测试（agent.test.js）：
- `POST /abort 应中断`、`POST /abort 无活跃`、`abort() 应设置 _aborted`、`LLM 调用期间 abort 产生 aborted 事件`、`reasoning 入口重置 _aborted`。

缺口（要补）：
1. **类型 B 内容保留**：LLM 流中断时已流出 token 应被存为 assistant 消息（`addAssistantMessage`）。现有"LLM 调用期间 abort"只断言有 aborted+done，没断言内容保留。补一条：验证中断后 `messages` 里有一条 assistant 消息含已生成内容。
2. **compact_abort 事件**：中断时有未决压缩气泡应 yield compact_abort。若有覆盖则确认，否则补。
3. **finishAborted 入口**：直接构造 AbortFlow，断言它 yield `compact_abort(有气泡时)` → `aborted` → `done`，fullContent 时保留内容。这是 AbortFlow 自身的合同测。

缺的先补，再动重构。

### 落地结果（已完成）

- 新建 `shared/agent/abort_flow.js`：`AbortFlow` 类，唯一公共方法 `*finishAborted(reason, fullContent)`——收尾压缩气泡（`abandonPendingCompact`）→ 保留已生成内容（`addAssistantMessage`，类型 B 统一）→ yield `aborted` + `done`。
- `default_agent.js`：constructor 内建 `this.abortFlow`（无门控，每 agent 都建）；6 处三件套全收敛成 `yield* this.abortFlow.finishAborted(reason, fullContent?)`；删 `_abortCompactBubble`（逻辑进 finishAborted 步骤1）；删 `_checkAborted`（"判断+保留"拆开——判断改用 `this._aborted` 直接判定、保留移 finishAborted 的 fullContent 参数）。
- RoomAgent 不依赖这两个已删方法，无影响。`agents/elf-002/message_manager.js` 仅注释提及，非代码。

### 验证

- 测试先补：类型 B 内容保留（LLM 流中断时已流出 token 存为 assistant）、`_abortCompactBubble` 行为（合同测顶上，改为直接测 `abortFlow.finishAborted`）——3 条合同测覆盖无气泡/有气泡/fullContent 保留三种情况。
- 全量 391 测试全绿，0 失败。abort 相关 6 处端到端行为（含直接读 `_aborted`/`_abortController` 的现有测试）零回归。

### 唯一语义调整

`_checkAborted(fullContent)` 原来是"判断是否中断 + 若中断且有内容则 `addAssistantMessage`"二合一。删它后：
- 判断 → reasoning 里直接 `if (this._aborted)`（工具段）或 `if (err.name === 'AbortError' || this._aborted)`（catch 段）。
- 保留 → `finishAborted(reason, fullContent)` 的 fullContent 参数（类型 B 处传 LLM 流出的内容，类型 A 处不传）。

行为等价：类型 B（LLM 流中断）保留已生成内容；类型 A（压缩/工具中断）不保留（无内容可留）。各处事件产出顺序与现状一致（compact_abort→aborted→done）。

### 改动文件
| 文件 | 改动 |
|---|---|
| `shared/agent/abort_flow.js` | 新建：AbortFlow 类，`*finishAborted(reason, fullContent)` |
| `shared/agent/default_agent.js` | import + constructor 建 abortFlow；6 处三件套收敛；删 `_abortCompactBubble` + `_checkAborted` |
| `test/agent.test.js` | 补类型 B 内容保留 + 3 条 finishAborted 合同测（顶替原 `_abortCompactBubble` 测） |

---

## 后续候选（不在本轮）

- **MessageRouter**：把 RoomAgent 的 buffer/mention 调度提成 preReceive 插件——这是"Room is Plugin"愿景的落点。顺带把 reasoning 里硬编码的 room Speak 门控（Speak-break、speak_reminder）也 hook 化。

每块满足"业务明确 + Agent 依赖接口窄"，本轮聚焦 AbortFlow，避免一次动太多。

---

## 已完成：ToolManager（合并 ToolRegistry + 工具编排）

**状态**：✅ 已完成、已验证（全量 419 测试全绿）

### 现状诊断

`default_agent.js` 里工具执行逻辑约 70 行（line 449-517），职责包括：
- 工具元数据解析（从 LLM 返回的 tool_calls 提取 name/args，从 toolRegistry 拿 isConcurrencySafe/statusEvent）
- CC processQueue 语义编排：连续 isConcurrencySafe=true 的只读工具并发（上限 10），遇到 isConcurrencySafe=false 的写工具串行；混合批次里只读工具并发跑完才跑写工具
- 事件产出：先按原序 yield status，再并发执行，最后按原序 yield tool_result
- abort 检查：每批工具执行后检查 `_aborted`，若中断则调 abortFlow 收尾

现状工具注册和管理在 `tools/registry.js`（ToolRegistry 类），提供 register/get/getAll/execute/isConcurrencySafe 方法。

#### 原已知缺陷：工具执行期间 abort signal 未透传（本轮已修）

`default_agent.js:453` 取 `toolExecSignal = this._abortController?.signal` 注释自称"abort 时立刻中断（signal 传工具）"，但 chatStream 正常结束后 line 406 已将 `this._abortController = null`，工具执行段（449+）在其后，于是 `toolExecSignal` 恒为 `undefined`，工具 `execute` 从未收到 signal。

后果：注释承诺的"abort 时 signal 传工具杀子进程"从未生效；现行 abort 只靠每条 tool_result 后检查 `_aborted` 标志（软中止，等当前 batch 跑完），能过现有 abort 父级测试，但"中止进行中的 Bash 子进程"做不到。

本轮已修：给 Agent 新增 `_toolAbortController` 字段，reasoning 工具执行段建专用 AbortController，signal 透传给工具；`abort()` 兼顾 abort 它——Bash 杀子进程的 abort 能力现在真生效。`test/agent.test.js` 的 signal 断言已转严为"signal 非 null"并转绿。

### 重构目标

合并 ToolRegistry 和工具执行逻辑成 ToolManager，实现三个目的：
1. **单一入口**：agent 只持一个 `toolManager`，而不是 `toolRegistry` + 分散的工具编排代码
2. **职责清晰**：reasoning 只保留 LLM 流与门控骨架，工具编排（解析/并发/串行/abort 检查）整体收进 ToolManager，由 reasoning `yield*` 接管其产出事件
3. **独立可测**：工具编排逻辑（并发/串行/abort 检查）可单独测试，不需要搭建完整 reasoning 环境

### 核心方案

**一、新建 ToolManager 类（合并 ToolRegistry + 工具编排）**

ToolManager 持有以下内容：
- 工具注册表（Map<name, tool>）
- messageManager 引用（调用 addToolResult 写入对话历史）
- agent 引用（通过 ctx.agent 传给工具，Agent 工具需要）

> 注：status/tool_result 是 reasoning 一轮内的同步产出，**继续走 reasoning 的 yield 流**（即 /chat 的 SSE 流），以保证前端时序零 diff。ToolManager 的 `executeBatch` 设计为 generator，由 reasoning `yield*` 接管。eventSink（指向 `_pushEvent` / `/events` 通道）只用于 compact 这类脱离 /chat 生命周期的真异步事件，**不经 ToolManager 派发工具事件**——详见"eventSink 与事件通道"小节。

公共方法：
- `register(tool)`：注册工具
- `get(name)`：获取工具定义
- `getAll()`：获取所有工具（用于 LLM tools 参数）
- `isConcurrencySafe(name)`：判断工具是否并发安全
- `execute(name, args, signal, ctx)`：单工具执行（供外部直接调用，如 Agent 工具内部调子 agent）
- `executeBatch(toolCallsResult, options)`：批次工具编排（核心逻辑，见下）

**二、executeBatch 的逻辑（原 default_agent.js line 449-517 迁入）**

`executeBatch` 是 generator，产出 `{ event, data }` 事件由 reasoning `yield*` 接力出去。

输入：
- `toolCallsResult`：LLM 返回的 tool_calls 数组
- `options.signal`：当前轮的 abortController.signal（传给工具）
- `options.isAborted`：函数，返回 `_aborted` 状态（调用方传入，避免 ToolManager 持有 agent 引用）

流程：
1. 预解析：遍历 tool_calls，提取 name/args，从工具注册表拿 tool/isConcurrencySafe/statusEvent
2. 按 tool_call 原序遍历：
   - 收集连续的 isConcurrencySafe=true 且未达并发上限的工具为一个 batch
   - 如果有 batch：
     - 先按原序 yield status 事件（每个工具如果有 statusEvent）
     - 并发执行 batch 中所有工具（Promise.all，每个工具传 signal 和 ctx.agent）
     - 按 batch 原序：`addToolResult` 落后端 history → yield tool_result 事件（检查 isErrorResult 决定 success/error）
     - 每发完一个 tool_result，检查 isAborted()，若中止标记已设则设置 abortedHere 标志并退出循环
   - 如果当前工具是 isConcurrencySafe=false 的写工具：
     - yield status 事件（如果有）
     - 串行执行该工具
     - `addToolResult` 落后端 history → yield tool_result 事件
     - 检查 isAborted()，若中止则设置 abortedHere 标志并退出循环
3. 返回 `{ aborted: abortedHere }`（generator return 值，由 reasoning 读取）

注意：
- ToolManager 不持有 abortFlow，中止时只返回 aborted 标志，由调用方（reasoning）决定是否调 abortFlow.finishAborted
- 工具事件经 yield 出 reasoning，走原 /chat SSE 流；ToolManager 内部不持有也不调用 eventSink

**三、agent 注入 ToolManager**

constructor 内初始化 toolManager，传入：
- messageManager（用于 addToolResult）

兼容性：如果初始化时传入了 toolRegistry（旧代码），将 toolRegistry 里已注册的工具迁移到 toolManager。

**四、reasoning 收敛工具执行**

删除原 70 行工具编排逻辑，改为：

1. `yield* this.toolManager.executeBatch(toolCallsResult, { signal: this._abortController?.signal, isAborted: () => this._aborted })`，接力产出 status/tool_result 事件、并取得返回值
2. 检查返回值的 `aborted` 字段，若为 true 则调 `abortFlow.finishAborted('tool-exec')` 并 return

Room 的 Speak 门控保留在 reasoning 里（line 521-524），这是 Room 的业务逻辑，不属于工具编排范畴。后续 MessageRouter 那轮会 hook 化。

### 依赖接口

ToolManager 对 agent 的依赖：
- `messageManager.addToolResult(id, result)`：写入工具结果到对话历史
- `signal`（传入工具）：中止信号
- `isAborted()`（由 agent 提供）：中止状态检查函数
- `ctx.agent`（传给工具）：主 agent 引用（Agent 工具需要）

agent 对 ToolManager 的依赖：
- `toolManager.register(tool)`：注册工具
- `toolManager.get(name)` / `toolManager.getAll()`：查询工具
- `toolManager.executeBatch(...)`：执行批次工具编排（generator，reasoning `yield*` 接力其事件产出）

依赖接口清晰，符合"协作对象 + 窄接口"原则。

### eventSink 与事件通道（关键澄清）

后端有**两条独立的 SSE 通道**，本轮重构必须分清：

- **`/chat` 流（reasoning 的 yield 流）**：`server.js` 在收到 /chat 请求时 `for await (event of agent.receive(...))`，把每个 `yield { event, data }` 写进当次对话的响应 SSE 流。它**绑定这次请求的生命周期**、前端此刻正在订阅，reasoning 一轮内的所有有序产出（token / status / tool_result / done / aborted）都走这条。
- **`/events` 流（`_pushEvent`）**：`server.js:329` 的 `agent._pushEvent` 写进一个全局 `eventsClients` 集合，是**独立长连接、脱离任何一次 /chat 生命周期**。设计用途是 compact 这类"无 /chat 流在场时发生的异步状态事件"（后台压缩完成、断路器触发等）。

`eventSink`（mm constructor 注入、目前指向 `_pushEvent`）是后端"往 /events 发异步事件"的统一入口。它的语义是"跨请求的异步通知"，**不是 yield 的等价替换**。

> 早先版本的方案曾设想把工具的 status/tool_result 也改走 eventSink 以"和 reasoning 的 yield 流分离"。**这是错的**：一旦工具事件走 eventSink，它们就脱离了当次 /chat 流、改由 /events 全局长连接投递。后果：
> 1. 同一轮内 token（走 /chat）与 status/tool_result（走 /events）落在两条流上，前端要跨流重排——两条 SSE 流到达无全局序保证，status→tool_result 配对时序会乱。
> 2. `/events` 的订阅者是全局集合（含 gateway 的状态收集），把每轮都有的高频工具事件灌进去会职责污染。
> 3. 这是前后端协议变更，不是"功能无 diff"。

**本轮决策**：工具的 status/tool_result **继续走 yield（/chat 流）**，ToolManager 作为 generator 由 reasoning `yield*` 接力。这样：
- 前端仍只看一条 /chat 流，时序与现状逐字一致，零 diff。
- eventSink / /events 通道不动，继续专供 compact 这类真异步事件。
- 同时仍达成 reasoning 瘦身（70 行编排收进 ToolManager）、ToolRegistry+编排合并、编排逻辑独立可测。

后续若确有"工具事件脱离 /chat 流"的需求（例如长任务工具想让前端在 /chat 流结束后仍能收状态），那是另一轮前后端协议改造，本轮不碰。

### 改造前后时序对比（均走 /chat yield 流）

两个只读工具并发：
```
yield status(tool_A)        ← 经 reasoning yield → /chat
yield status(tool_B)
await Promise.all([A, B])
addToolResult(A.id, r_A)    ← 先落后端 history
yield tool_result(tool_A)   ← 再 yield 通知前端
addToolResult(B.id, r_B)
yield tool_result(tool_B)
```

改造前（70 行内联在 reasoning）与改造后（迁进 `executeBatch`、reasoning `yield*`）的产出顺序逐字一致：status 原序、并发执行、tool_result 原序、每条 tool_result 前先 `addToolResult`。

混合批次（两个只读 + 一个写工具）同理：
```
yield status(A), yield status(B)
await Promise.all([A, B])
addToolResult + yield tool_result(A/B)
yield status(C)
await tool_C
addToolResult + yield tool_result(C)
```
改造前后顺序不变。abort 语义也不变：每条 tool_result 后检查 isAborted()，命中则 `abortedHere=true` 退出循环、reasoning 读到后调 `abortFlow.finishAborted('tool-exec')`——和现状 line 492-496 / 510-514 一致。

### 测试覆盖

**现有测试覆盖**：
- test/agent.test.js:738：`isConcurrencySafe=true 的只读工具应并发执行`（验证并发，但未测 abort）
- test/agent.test.js:775：`isConcurrencySafe=false 的写工具应串行执行`（验证串行）
- test/agent.test.js:814：混合批次测试（只读 + 写工具混合）

**需要补充**：
1. **工具执行期间 abort**：现状有 abort 检查（每批工具执行后检查 `_aborted`），但未见单测覆盖。改造后改为 `isAborted()` 回调 + `abortedHere` 返回，需要验证中止时机、剩余工具不再执行、reasoning 收到 aborted 后调 finishAborted。
2. **statusEvent 产出顺序**：验证并发工具的 status 按 tool_call 原序 yield；写工具串行段的 status 位置正确。
3. **isErrorResult 边界**：验证工具返回各种错误格式时的 tool_result 事件 status=error/success。
4. **yield 时序**：直接消费 `executeBatch` 产生的 generator，断言产出的 status/tool_result 序列与改造前 reasoning 内联版本逐字一致（含"addToolResult 在 yield tool_result 前"的先后关系）。

### 风险

| 风险项 | 缓解 |
|---|---|
| yield 时序回退 | ToolManager 仅做 generator 迁移、`yield*` 接力，不跨流；逐事件对照改造前产出 |
| abort 机制 | 现状是"软中止"（等当前工具/批次跑完再退），改造后保持不变——`isAborted()` 在每条 tool_result 后检查 |
| **signal 未透传缺陷** | 见"已知缺陷"小节：重构时让工具执行段拿到有效 signal（工具执行前不置 null 或建专用 controller），并修复 `agent.abort()` 兼顾工具段；同步把 `test/agent.test.js` 的 signal 断言转严 |
| agent 引用传递 | 保持 `{ agent }` 约定（Agent 工具需要主 agent 引用） |
| 测试覆盖缺失 | 先补测试（特别是 abort 和 yield 时序），再动重构 |
| 兼容性 | toolRegistry 初始化时代迁工具到 toolManager |

### 改动文件（实际落地）

| 文件 | 改动 |
|---|---|
| `shared/agent/tools/tool_manager.js` | 新建：ToolManager 类（保留 ToolRegistry 全签名 register/get/getAll/execute/isConcurrencySafe + 新增 `executeBatch` generator） |
| `shared/agent/tools/registry.js` | 删除（命名统一后无兼容 shim） |
| `shared/agent/default_agent.js` | import 改 ToolManager；fromConfigDir `new ToolManager()`；constructor 接 `toolManager` 参数 + 回填 `_setMessageManager`；reasoning 工具段删 70 行改 `yield* this.toolManager.executeBatch(...)` + 读 aborted 调 finishAborted；新增 `_toolAbortController` 字段 + `abort()` 兼顾；Room Speak 门控保留 |
| `shared/agent/tools/Agent.js` | `parentAgent.toolManager.constructor` + `ToolManagerCtor`；注释文本更新 |
| `shared/agent/tools/Speak.js` | 注释文本更新 |
| `shared/agent/skills/lister.js` | 参数名/内部字段 `_toolManager` |
| `shared/agent/start.js` | `agent.toolManager.register(Speak)` |
| `test/agent.test.js` | import 改 ToolManager；`new ToolManager()`；访问点 `agent.toolManager`；补 6 条缺口测试 + signal 断言转严 |
| 8 个测试文件 | import `ToolRegistry`/`registry.js` → `ToolManager`/`tool_manager.js`，`new ToolRegistry()` → `new ToolManager()` |

### 落地结果（已完成）

- **新建 `shared/agent/tools/tool_manager.js`**：`ToolManager` 保留原 ToolRegistry 全部方法签名 + `executeBatch` generator。executeBatch 内迁入原 CC processQueue 编排（预解析/并发段/串行点/status+tool_result 原序 yield/每条 tool_result 后 isAborted 检查），`return { aborted }`。`isErrorResult` 判据随编排一并迁入。经 `yield*` 透传，status/tool_result 走 reasoning 的 /chat yield 流。
- **signal 缺陷已修**：新增 `_toolAbortController`，reasoning 工具执行段建专用 AbortController、signal 透传给工具，`abort()` 兼顾 abort 它。原"signal 恒 undefined、Bash 杀子进程从未生效"的 bug 消除。
- **命名彻底统一**：类 `ToolManager`、文件 `tool_manager.js`、agent 字段 `agent.toolManager` 三者一致。删 `registry.js`（无 shim）。8 个测试文件 import + 55 处 `new ToolRegistry()` + 全部字段名 `toolRegistry`→`toolManager` 一并迁移；`ToolManagerCtor` 变量名同步。
- **reasoning 收敛**：工具执行段从 ~70 行内联删为 `yield* this.toolManager.executeBatch(...)` + 读 `aborted` 调 `abortFlow.finishAborted('tool-exec')`。事件产出经 `yield*` 透传，与改造前逐字一致（status 原序、tool_result 原序、addToolResult 先于 yield tool_result、软中止语义不变）。
- **测试先补再重构**：补 6 条缺口（并发上限 10、addToolResult 落 history 契约、args JSON 容错、同批 statusEvent 缺失不发、ctx.agent 透传、并发上限回归）；4 条原前置安全网修稳（并发/串行 abort 补 execCount、status 原序按 state 过滤排除 thinking 污染、混合批次改 deepEqual 原序断言）。signal 断言转严为"非 null"并转绿。
- **errata**：方案阶段设想过的"工具事件改走 eventSink"未采纳——核出 `/chat`（yield）与 `/events`（`_pushEvent`）是两条独立 SSE 流，工具事件跨流会乱序+职责污染，故继续走 yield（详见"eventSink 与事件通道"小节）。早先按 eventSink 方案写的 `test/tool_manager.test.js` 是坏资产（import 不存在的类且方向相悖），已删，测试落在 `test/agent.test.js`。

### 验证

- 全量 419 测试全绿，0 失败 0 跳过。
- signal 测试（"工具 execute 应收到透传的 signal 与 ctx.agent"）转严为 `assert.ok(seenSignal)` 转绿——证 executeBatch 新路径在跑（旧内联代码这条必败）。
- 并发上限/history 契约/args 容错/statusEvent 缺失/yield 时序/abort 等新测全绿。
- 删 shim 前后、字段名全量改名后均全绿。

### 唯一可见行为变化

修复"工具执行期间 abort signal 未透传"的 latent bug：`abort()` 现能经 `_toolAbortController.abort()` 中止进行中的工具（Bash 杀子进程生效）。此前 signal 恒 undefined、该能力从未生效。其余路径（并发/串行/事件时序/软中止）行为零 diff。

### 验证标准

- 全量测试全绿
- 前端收到的事件流顺序与改造前逐字一致（executeBatch 产出的 status/tool_result 序列等于改造前 reasoning 内联版本的产出；addToolResult 仍在 yield tool_result 之前）
- 工具执行期间 abort 能正确触发中止收尾（isAborted 命中后剩余工具不再执行、reasoning 调 finishAborted）
- 并发/串行逻辑行为不变（并发工具并发执行，写工具串行执行）
- /events 通道（eventSink）行为零变化——本轮不让工具事件走它
- signal 缺陷已修：工具 `execute` 收到非 null signal；`test/agent.test.js` 的 signal 断言转严转绿