# Abort 保留 partial 设计

## 1. 背景

用户反馈：**elf-002 在回答中 abort，对话会"rewind 到最近一次用户回复"——partial 消失、只剩用户那条消息**。预期是"只有 elf-018 能 rewind，其他 agent 的 abort 就是停（保留已生成内容），不调用 rewind"。

先澄清一个前提：**elf-002 的 abort 没有触发后端 rewind**。实测 base Agent（elf-002 走的就是 base）abort 后 `context.json` 仍是 `[user, partial]`，事件序列 `... aborted, done`，无 `abortRewind`。真正调 `rewindTo` 的后端路径只有一条——`abortRewind` 信号→gateway `rewindTo(latest)`——而全代码库**只有 elf-018 发这个信号**（`agents/elf-018/agent.js:81-83`，DNDAgent 在 `_aborted && _scene` 时 emit）。elf-002 用 base Agent，不发 abortRewind，gateway 不会为它 rewind。

用户看到的"rewind"是**前端/history 层把 partial 丢掉了**，而且这两段对所有 agent 生效，不是 elf-018 专属。

## 2. 现状代码定位

| 层 | 位置 | 现状行为 | 作用域 |
|---|---|---|---|
| 后端收尾 | `engine/abort_flow.js:51-65` `finishAborted` | 把已流出 token 存成 assistant 消息进 `context.json`（类型 B 保留），emit `aborted`+`done` | 全 agent |
| 后端 rewind | `gateway/process_manager.js:461-482` `_onAgentEvent('abortRewind')` → `rewindTo(aid,rid,null,…)` | 用 pre-round checkpoint 整份覆盖 `context.json`/`history.jsonl`/runtime/tool-results，弹 checkpoint，回填 `restoredPrompt` | 仅 `abortRewind` 事件（仅 elf-018 emit） |
| 信号源 | `agents/elf-018/agent.js:81-83` | `if (this._aborted) opts.emit({event:'abortRewind'})` | 仅 elf-018（DNDAgent，且有 `_scene`） |
| history 落盘 | `gateway/turn-stream-server.js:200-207` `aborted` 分支 | **丢弃** partial（不落 `history.jsonl`），清内存累积器 | 全 agent |
| 前端 SSE | `frontend/src/stores/sseDispatcher.js:365-372` `case 'aborted'` | `activeTurn: null` + 推"已停止生成"——partial 气泡整个清空 | 全 agent |
| 前端 SSE | `frontend/src/stores/sseDispatcher.js:349-356` `case 'abortRewind'` | `pendingRestorePrompt` + `loadHistory(force)` 重建 turns | 仅 elf-018 信号 |
| 前端 SSE | `frontend/src/stores/sseDispatcher.js:344-347` `case 'done'` | `finalizeActiveTurn`（把 activeTurn seal 进 turns） | 全 agent |
| 事件分发 | `gateway/private_room_stream.js:93-104` `handlePrivateAgentEvent` | 先 broadcast 给 SSE 订阅者，再 `_server.handleEvent` 喂 turn-stream | — |
| 死代码 | `engine/message_manager.js:722-731` `rewindToLastUser()` | 截断到最近真实 user | **无调用方**（commit `6066bb2` 起废弃） |

## 3. 根因

后端意图（`finishAborted` 类型 B）是**保留 partial**，但前端 `aborted` 与 turn-stream `aborted` 两段被写成了**丢 partial**，且注释自述"与 elf-018 auto-rewind 一致"——即把 elf-018 的 auto-rewind 观感套到了所有 agent 上。

历史可查：commit `6066bb2 "fix autorewind"` 把**后端** rewind 收敛到了 elf-018（elf-018 当初自己调 `rewindToLastUser()`，改成了发 `abortRewind` 信号交 gateway `rewindTo`；`rewindToLastUser()` 由此沦为死代码）。但那次只收敛了后端，**前端的"丢 partial"没一起收敛**，仍对所有 agent 生效。这就是"不是说只有 elf-018 能这样"——后端确实只剩 elf-018，前端却全局继承了 elf-018 的 auto-rewind 观感。

结果：
- 非 elf-018：后端 `context.json` 保留 `[user, partial]`，前端/history 却丢掉 partial → agent 记得一段用户看不到的半成品，下条消息时模型 context 带着这段隐藏 partial。**这才是比"看起来像 rewind"更实质的 bug**。

## 4. 方案

核心：把"丢 partial"也收敛——非 elf-018 的 abort **保留** partial（停但留已生成，对齐 Claude/ChatGPT 等 stop 语义）；elf-018 的全量 rewind 由其既有的 `abortRewind` 通路兜底，**不动**。

### Plan A（推荐，最小改动、不硬编码 agentId）

**改 1 — 前端保留 partial**：`sseDispatcher.js:365-372` `case 'aborted'` 把 `activeTurn: null` 换成 `finalizeActiveTurn(agentId)`（与 `done` 同路），保留"已停止生成"通知。

```js
case 'aborted': {
  // 中断 = 保留本轮已生成 partial 为可见 turn（停但留已生成，对齐 stop 语义）。
  //   后端 turn-stream 同步把 partial 落 history.jsonl（见 turn-stream-server aborted 分支）。
  //   elf-018 的全量回退由其随后发的 abortRewind 信号触发 loadHistory(force) 把 turns 整份重建掉——
  //   'aborted' 在前收成 turn、'abortRewind' 在后 force-reload 覆盖；两者背靠背到达，partial 顶多闪一帧。
  finalizeActiveTurn(agentId);
  _pushNotice(agentId, { text: '已停止生成' });
  break;
}
```

**改 2 — turn-stream 落盘 partial**：`turn-stream-server.js:200-207` `aborted` 分支把"丢弃"换成 `this._flushBubble(roomId)`（与 `done` 同路），空 turn 时 `_flushBubble` 内部 no-op，无副作用。

```js
if (eventName === 'aborted') {
  // 中断：保留本轮已生成 partial——先 flushBubble 落盘 history（替代旧"丢弃"），再清内存累积器。
  //   elf-018 的全量回退由其随后发的 abortRewind → gateway rewindTo(latest) 用 pre-round checkpoint
  //   整份覆盖 history.jsonl 把此处先落盘的 partial 一并清掉（顺序 aborted→done→abortRewind，同进程串行无竞态）。
  st.streaming = false;
  finished = true;
  this._flushBubble(roomId);   // 空 turn 时 no-op；有内容则落盘 + 置 _hasHistoryOutput=true + 清累积器
  // ⚠ 原 discarded 分支末尾有 st._hasHistoryOutput = false（行 207），必须删——否则会抹掉刚落盘的标志，
  //    虽 done 兜底因 content 已空不会双写，但语义错（historic output 却标 false），后续若有人改兜底条件即埋雷。
  // _flushBubble 已清 assistantContent/toolCalls，下两行可省，保留无害。
  st.assistantContent = '';
  st.toolCalls = [];
} else if (eventName === 'done' || eventName === 'error') {
```

**改 3 — 删死代码**：`engine/message_manager.js:722-731` `rewindToLastUser()` 及其单测（`test/dm-agent.test.js` 的 `rewindToLastUser` 两例）。按 CLAUDE.md"不保留过时代码"。

## 8. 代码核查（Review）

逐条对着当前代码验过，结论与需注意处：

| 核查项 | 结论 | 证据 |
|---|---|---|
| `finalizeActiveTurn` 行为符合改 1 预期 | ✅ flush rAF→seal bubbles→activeTurn 入 turns→置 null；无 activeTurn 时早返（空 abort 安全） | `sseDispatcher.js:138-148` |
| 改 2 必须连带删 `st._hasHistoryOutput = false`（行 207） | ⚠ **原 doc 漏标，已补** | `turn-stream-server.js:207` |
| aborted→done 不双写 | ✅ aborted `_flushBubble` 后 `_hasHistoryOutput=true`、累积器清空；done 的 `_flushBubble` 早返（行 100 无内容 no-op）、兜底 `if(!st._hasHistoryOutput)` skip | `turn-stream-server.js:96-107,208-223` |
| elf-018 时序 aborted→done→abortRewind | ✅ `finishAborted` 在 `runFourLoopWorkflow` 内 emit aborted+done，返回后 `if(_aborted) emit abortRewind` | `agents/elf-018/agent.js:75-83` |
| abortRewind 的 `rewindTo` 覆盖 history.jsonl 能清掉改 2 落的 partial | ✅ 同进程 `_onAgentEvent` 按序：aborted（落盘）→done→abortRewind（`rewindTo` 整份覆盖）；`abort_rewind.test.js` 验过本轮 user+partial 被清 | `process_manager.js:461-482`、`test/abort_rewind.test.js:85-104` |
| `loadHistory(force)` 确会替换 turns（elf-018"闪一帧"属实） | ✅ await getHistory 后 `chats.set(key,{…chat,turns,activeTurn:null})` | `agentStore.js:190-202` |
| 群聊不受波及 | ✅ `/abort` 仅私聊（`checkPrivateOwner`）；前端 `abortRequest`→`/rooms/{myPrivateRoomId}/abort`；群聊 observe 模式无 abort 按钮，abort 事件不经 `handlePrivateAgentEvent`（要 `_roomId` 以 `chat-` 开头） | `room_routes.js:394`、`api/index.js:188-189`、`private_room_stream.js:95` |
| 孤儿 abort（`forceFinishPrivateTurn`） | ✅ 只发一次 aborted：`handleEvent('aborted',{})`+`_broadcast('aborted')`，改后会把死前累积 partial 落盘（行为变化，§7 已记） | `private_room_stream.js:137-143` |
| `rewindToLastUser` 确为死代码 | ✅ 全库无生产调用方（仅 `sseDispatcher.js:366` 注释提及）；仅 `dm-agent.test.js` 两例单测直测它 | grep `rewindToLastUser` |
| 后端 partial 保留对真实 llm 成立 | ✅ `llm.js:165-167` abort 时挂 `err.partial={content,…}`；`abort_flow.js:113,58-60` 取 content 存 `context.json` | `engine/models/llm.js:165`、`engine/abort_flow.js:113` |

**遗留边界（非本次引入，§7 已记）**：`finishAborted` 仅存文本 partial 进 `context.json`（`abort_flow.js:113` 只取 `err.partial.content`），而 `_flushBubble` 存文本+toolCalls 进 `history.jsonl`。中途 abort 一个工具调用时两处可能不完全一致。本次不扩面处理，仅记录。

改 1+改 2 后，非 elf-018 的 abort：前端可见 partial + `history.jsonl` 有 partial + `context.json` 有 partial（`finishAborted` 既有行为）**三层一致**，divergence 消除。

### Plan B（备选，消除 elf-018 的"闪一帧"，代价是更多 plumbing）

elf-018 的 abort 时序里 `aborted`→`abortRewind` 之间 partial 会先收成 turn 再被 force-reload 清掉，理论上有 ~一次 getHistory 往返的闪烁。若不可接受：给 agent 加 `rewindOnAbort` 配置位（elf-018 置 true），snapshot 把它带给前端，前端 `aborted` 据此二分——`rewindOnAbort` 走旧 `activeTurn:null`（不闪），其余 finalize。需 config + snapshot 字段 + 前端读取三处联改。**默认不上**，除非实测闪烁刺眼。

## 5. elf-018 兼容性（时序核查）

elf-018 的 `reasoning` override（`agents/elf-018/agent.js:67-87`）：`runFourLoopWorkflow` 内 `finishAborted` 已 emit `aborted`+`done`，返回后 `if(this._aborted)` emit `abortRewind`。故事件序恒为 **aborted → done → abortRewind**，gateway `_onAgentEvent` 同进程按序处理：

1. `aborted` → `handlePrivateAgentEvent` → broadcast + `handleEvent('aborted')`：**改 2** 落盘 partial 到 `history.jsonl`。
2. `done` → `handleEvent('done')`：`_flushBubble`（累积器已清，no-op）+ 空 turn 兜底（`_hasHistoryOutput=true`，skip）。**无重复落盘**。
3. `abortRewind` → `_onAgentEvent` abortRewind 分支：`rewindTo(latest)` 用 checkpoint **整份覆盖** `history.jsonl`（步骤 1 落的 partial 随本轮 user 一起被清）+ broadcast abortRewind + 异步 `/reload`。

前端同序收 aborted → done → abortRewind：aborted 收 partial 成 turn（改 1）→ done no-op → abortRewind `loadHistory(force)` 重建 turns（partial+user 消失、输入框回填）。终态与现状一致（rewind 到 user 前），**仅多一次"先显后清"的瞬时**。

## 6. 改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `frontend/src/stores/sseDispatcher.js` | `case 'aborted'`：`activeTurn:null` → `finalizeActiveTurn`，更新注释 |
| 2 | `gateway/turn-stream-server.js` | `aborted` 分支：丢弃 → `_flushBubble`，更新注释 |
| 3 | `engine/message_manager.js` | 删 `rewindToLastUser()`（死代码） |
| 4 | `test/dm-agent.test.js` | 删 `rewindToLastUser` 两例单测 |
| 5 | `test/private_room_stream.test.js`（新增） | 加一例：base-agent 风格 abort → `history.jsonl` 落了 partial（非丢弃） |

## 7. 风险 / 待决策

- **elf-018 闪一帧**：见 §4 Plan B。默认接受（partial 本就在流式显示，"多留 ~100ms 再 rewind"未必更突兀）。
- **tool_call 中途 abort 的 context/history 差异**：`finishAborted` 只取 `err.partial.content`（文本，`abort_flow.js:113`）存 `context.json`；`_flushBubble` 存文本+toolCalls 到 `history.jsonl`。中途 abort 工具调用时两处可能不完全一致。属既有边界、非本次引入，先记。
- **孤儿 abort（`forceFinishPrivateTurn`）行为变化**：`private_room_stream.js:140` 调 `handleEvent('aborted',{})`，改 2 后会把 agent 死亡前已累积的 partial 落盘（旧逻辑丢）。语义上是"留已生成"，比丢弃更合理，但属行为变化，需知情。
- **群聊不受影响**：`/abort` 路由仅私聊（`room_routes.js:394`），群聊不走此路。
- **`aborted` 后 `done` 的空 turn 兜底**：改 2 后 aborted 已 `_hasHistoryOutput=true`（有内容时），done 的兜底分支 skip，不会重复 append。空 abort（无任何 partial）时 `_flushBubble` no-op、`_hasHistoryOutput` 仍 false，done 兜底查 hasContent/hasTools 均空也不 append。**无双写**。
