# 压缩气泡更新丢失：实测 bug 清单（2026-07-21）

> 现象：elf-003（compactMode=async, memoryTokenLimit=4000）后台压缩完成后，停在页面上时气泡不被更新到「已压缩 summary」状态；切 tab 再回来才更新。
> 复现 + 前后端插桩（`[DIAG]` 标记）后的日志证据见下。本文每条 bug 带【证据】【影响】【把握度】，逐项 review 后再修。

复现日志主要 compactId：
- `msg_1784619864510_1974`（下简称 **1974**）
- `msg_1784619948131_cacd`（下简称 **cacd**）
- `msg_1784620091091_a3f1`（下简称 **a3f1**）

---

## Bug 1：后端 `_onAgentEvent` 收到 compact 完成未回写 `ctx.eventLog`

**位置**：`gateway/process_manager.js` `_onAgentEvent`（约 386 行起）

**机制**：后台异步压缩完成走独立 /events 通道 → `ProcessManager._onAgentEvent`。它只调 `chatHistory.updateCompactRecord` 更新**磁盘** history.jsonl，**没**把 `compact`/`compact_error` 记录追加到内存里的 `streamContext.eventLog`。而 SSE 重连时 `buildSnapshot` 若走「有活跃流」分支，`buildBubblesFromContext(ctx)` 从 `ctx.eventLog` 重建气泡——eventLog 里那条 `compact_start` 永远是 `compactLoading:true`，重建出的压缩气泡永远是 loading。

【证据】gateway.log（复现实测）：
```
[events][DIAG] compact arrive agentId=elf-003 ctxAlive=true eventLogHasCompactDone=false compactId=msg_1784619864510_1974
```
- `ctxAlive=true`：压缩完成时活跃流 ctx 还在。
- `eventLogHasCompactDone=false`：证实 `_onAgentEvent` 没把 compact 完成写进 eventLog（只写了磁盘）。

【证据】frontend.log：紧接着的 snapshot 带的是 loading 气泡：
```
[compact-bubble][DIAG] snapshot arrive: streaming=true ... activeTurn id=msg_1784619864510_1974 loading=true summary=undefined
```
`streaming=true` 说明 snapshot 走「有活跃流」分支（eventLog 重建），压缩气泡 loading=true。

【影响】：
- 压缩完成时若 ctx 仍活着（/chat 流没 streamEnded），任何一次前端 SSE 重连 → snapshot 用 loading 气泡整替换前端内存 → 前端此前 `_applyCompactResult` patch 成的 summary 被覆盖回 loading。
- 「切 tab 回来才好」因为切回走 loadHistory 从磁盘读（磁盘已是 summary，updateCompactRecord 成功落盘）。

【把握度】高。日志 `eventLogHasCompactDone=false` + snapshot 带 loading 直接坐实因果链。

【修法候选】：
- A 让 `_onAgentEvent` 在 compact/compact_error 时往 `streamContext.eventLog` **追加一条 compact/compact_error 记录**（`buildBubblesFromContext` 已有 `case 'compact'`/`'compact_error'` 能把它应用到气泡）。需 process_manager import `streamContexts`（已加 [DIAG] 时 import）。
- B 让 `buildSnapshot` 有活跃流分支的压缩气泡**也从磁盘读**（不只用 eventLog）——更彻底但改 buildBubblesFromContext 语义。

【风险】：
- A：追加顺序要保证 compact 记录排在对应 compact_start 之后，buildBubblesFromContext 的 currentBubble 游标才能命中。需核对 eventLog 追加时机与游标逻辑。
- B：磁盘 jsonl 和 eventLog 双源，可能不一致（磁盘是终态、eventLog 是流内过程），要定同源优先级。

---

## Bug 2：前端 `_applyCompactResult` compactId 在 store 里找不到 → NOT FOUND

**位置**：`frontend/src/hooks/useChat.js` `_applyCompactResult`（40-77 行）+ fallback（68-76 行）

**机制**：compact 完成事件带 compactId 到前端，`_findBubbleByCompactId` 在 activeTurn + 所有 turns 里按 id 找气泡。若前端 store 里**根本没有这个 compactId 的气泡**（compact_start 没建、或气泡被清/挪），所有位置 found=-1，走 fallback。

【证据】frontend.log（a3f1 这条，compact_error 失败）：
```
_applyCompactResult: compactId=msg_1784620091091_a3f1 patch={"compactError":"记忆压缩失败"} activeTurn=false turns=5
find turns[4..0]: ... found=-1          （所有 turn 都找不到）
find NOT FOUND: msg_1784620091091_a3f1
```
磁盘有 a3f1 记录（seq=22, compactError），但前端 store 里**没有** a3f1 气泡。patch 来时 `activeTurn=false` → fallback 的 `if (!chat.activeTurn) return;`（line 69）→ **直接 return，啥都没改**。

【纠正初判】：我初判「fallback 改错气泡」**对 a3f1 不成立**——a3f1 时 activeTurn=false，fallback 直接 return，没改错任何气泡。a3f1 的真问题是「前端根本没有 a3f1 气泡」，而非「fallback 写错地方」。

【影响】：这条本身不造成「loading 卡住」（fallback 没动），但暴露**前端缺气泡**：compact_start 事件若没在前端建气泡（或建了又被 snapshot 清掉），后续 compact/compact_error 都无处落。表现是磁盘有记录但前端不显示这条压缩。

【把握度】中-低。found=-1 + fallback return 是铁证，但**根因**（为什么前端没 a3f1 气泡）证据不足：可能是 compact_start 事件没到前端（SSE 断窗）、或气泡被 snapshot 整替换挪走、或 id 用了 local_ 兜底对不上——当前 [DIAG] 没给 compact_start 打日志，需补。

【修法候选】：
- 补 compact_start 的 [DIAG]（到达时前端建了什么 id 的气泡）再定位。
- fallback 时若 activeTurn=false，可记一条 WARN 便于追「气泡缺失」而非静默 return。

【风险】：低。当前 fallback return 是安全行为；改它要确认不破 blocking 单 turn（elf-002）。

---

## Bug 3：前端 activeTurn 出现重复 compactId 气泡

**位置**：`frontend/src/hooks/useChat.js` `case 'compact_start'`（280-309 行）

**机制**：activeTurn.assistantBubbles 里同一 compactId 出现两次，后续 `_findBubbleByCompactId` 的 `findIndex` 命中第一个、patch 只改第一个，第二个永远 loading。

【证据】frontend.log（cacd 这条，compactAttempt=1 非重试）：
```
find activeTurn: msg_1784619948131_cacd ids=[...,msg_1784619948131_cacd,msg_1784619948131_cacd] found=6
```
activeTurn 末尾两个气泡 id 都是 `msg_1784619948131_cacd`（重复）。磁盘 cacd compactAttempt=1。

【纠正初判】：我初判「重试（attempt>1）push 重复」**对 cacd 不成立**——cacd 的 attempt=1，不是重试路径。所以重复不是「重试复用气泡」逻辑导致的。

【仍存的疑问】：重复从哪来？两种可能、当前证据区分不开：
- (a) 同一 compactId 的 compact_start 事件到达前端 ≥2 次（SSE 重连把已处理事件重发，compact_start 无幂等）。
- (b) compact_start 新建气泡代码无去重，某条逻辑路径 push 了两次。
当前 [DIAG] 没给 compact_start 打日志，**无法判定 a 还是 b**。

【影响】：一个气泡被 patch、一个永远 loading；界面可能出现一直 loading 的重复压缩气泡。

【把握度】中。ids 重复是铁证；但根因（a/b 未分）证据不足，需补 compact_start [DIAG]。

【修法候选】：
- 补 compact_start [DIAG]（每次到达记录 compactId + attempt + 是否已存在同 id 气泡）定位 a/b。
- 修：compact_start 新建前先 `findIndex(b => b.id === compactId)`，命中则复用不新建（去重，无论 a/b 都挡住）。

【风险】：低，去重是纯增量防护；但若根因是 (a)（事件重发），去重只挡前端症状、后端重发仍在，应一并治。

---

## Bug 4：snapshot 整替换 turns/activeTurn 与在线 patch 的时序竞争

**位置**：`frontend/src/hooks/useChat.js` `case 'snapshot'`（189-194 行）`patchChat({turns, activeTurn, ...})`

**机制**：snapshot 是「整替换」前端 turns/activeTurn。若 snapshot 到达**晚于** `_applyCompactResult` 的 patch，会用 snapshot 的（可能 loading 的）turns 覆盖掉 patch 的 summary。这是 Bug 1 的下游放大器：Bug 1 让 snapshot 带 loading，本 bug 让 loading 覆盖 patch。

【证据】1974 这条的时序：
```
07:44:31.838 snapshot arrive: activeTurn id=1974 loading=true          （snapshot 带 loading）
07:45:46.790 _applyCompactResult: 1974 FOUND idx=0 inActive=true          （patch 成 summary，在 snapshot 之后）
```
这条 patch 在 snapshot 之后 → patch 成功、snapshot 没覆盖它。**所以对 1974，sub-时序是 snapshot→patch，没翻车**。但如果顺序反过来（patch→snapshot），patch 会被覆盖。1974 这次没复现反向，但 a3f1/cacd 的混乱说明竞争存在。

【影响】：patch 与 snapshot 谁后到谁赢，summary 和 loading 互覆盖，表现不稳定。

【把握度】中。机制成立但本次日志没直接抓到「patch 后被 loading snapshot 覆盖」的反向时序；它更像是 Bug 1（snapshot 带 loading）+ Bug 2（fallback 改错）+ Bug 3（重复气泡）的**放大器**而非独立主因。

【修法候选】：
- 不把 snapshot 当「整替换」——snapshot 的压缩气泡若 loading 而内存已是 summary，保留内存的（按 compactId merge 而非 replace）。
- 或前端 snapshot 到达时，对压缩气泡做「loading 不覆盖 summary」的合并策略。

【风险】：snapshot 整替换是当前「刷新权威重建」机制，改 merge 策略要小心不破 historyLoaded 语义。

---

## 实证小结

| Bug | 位置 | 日志铁证 | 把握度 | 修复是否独立 |
|---|---|---|---|---|
| 1 _onAgentEvent 未回写 eventLog | gateway/process_manager | `eventLogHasCompactDone=false` + snapshot 带 loading | 高 | 是（先修） |
| 2 compactId 在 store 找不到（前端无气泡） | frontend/useChat `_applyCompactResult` | a3f1 全 found=-1（且 activeTurn=false，fallback 没改错——初判已纠正） | 中-低，根因证据不足 | 疑衍生，需补 compact_start DIAG |
| 3 activeTurn 重复 compactId 气泡 | frontend/useChat `compact_start` | cacd ids 重复（attempt=1，非重试——初判已纠正） | 中，根因 a/b 未分 | 需补 compact_start DIAG |
| 4 snapshot 整替换覆盖 patch | frontend/useChat `snapshot` 分支 | 机制成立，本次未抓 patch 被 loading 覆盖的反向时序 | 中，放大器非独立主因 | 修 1 后大概率缓解 |

## 对照：1974 是「主诉成功」的参照

1974 这条 patch 成成功（FOUND idx=0 inActive=true），磁盘 summary=9676。它的时序是 `snapshot(loading) → patch(summary)`，patch 在后、赢。**这条没复现「停在页面上不更新」**——说明主诉（气泡不更新）主要来自 cacd/a3f1 这类（重复气泡 / 前端无气泡），而非 Bug 1 的 snapshot 覆盖。Bug 1 的 loading snapshot 确实存在（07:44:31 那条），但后续 patch 修好了它。

**这修正了我之前「Bug 1 是主因」的判断**：Bug 1 真实存在（eventLog 未回写 → loading snapshot），但本次复现它被后续 patch 覆盖前修复了，不是「停在页面不更新」的直接凶手。直接凶手更可能是 Bug 3（重复气泡一个 loading 一个 patched，界面上看到 loading 那个）。

## 当前证据缺口（需补 [DIAG]）

1. **compact_start 到达前端时建了什么 id 的气泡、到达几次**——定位 Bug 2（前端为何无 a3f1 气泡）和 Bug 3（cacd 为何两个）的根因。当前 compact_start 无 [DIAG]。
2. **compact 完成事件与 compact_start 的 id 是否一致**——确认 patch 对不上是「气泡没建」还是「id 不一致」。

## review 与修复顺序建议（修订）

1. **先补 compact_start [DIAG]**（前端 `case 'compact_start'` 打：compactId + attempt + activeTurn 是否已有同 id 气泡 + bubbles 长度），再复现一次，定位 Bug 2/3 根因。**不靠猜。**
2. **Bug 1**（高把握独立）：修 `_onAgentEvent` 回写 eventLog。修后复现验 `eventLogHasCompactDone=true`、snapshot 不带 loading。
3. **Bug 3**：定位根因后修（去重 或 后端不重发）。
4. **Bug 2**：定位「前端无气泡」根因后修。
5. **Bug 4**：修 1+3 后复测，若 snapshot 覆盖仍卡，再做 merge 策略。

> 复现时保留 `[DIAG]` 插桩，每修一条用日志验证因果链是否真的断掉。绝不靠猜下结论（前面因臆测翻车过）。