# temp.md 八条问题分析结论（只读分析，未改代码）

> 基于 7 个并行探查 agent 的结论核对。每条含：现状、判断、方向。日期 2026-07-25。

---

## 1. 提示词注入点位 + 取消 messageManager 子类（已落地）

按 `docs/prompt-injection-module-plan.md` 落地：`PromptAssembler` 收口三点位（系统提示词追加/替换、最近 user 及其前后插消息/前后缀修改、末尾追加）的临时请求拼装。持久化 meta 不进本模块（维持 `addMetaMessage` 现状）。

**新增模块**：
- `engine/prompt_assembler.js` — `PromptAssembler`：6 个 `useXxx` 槽位（`useSystemAppend`/`useSystemReplace`/`useBeforeLastUser`/`useAfterLastUser`/`useWrapLastUser`/`useAppend`）+ `assemble(base, ctx)`。纯函数管道、按 order 叠加、provider 现算、无副作用。
- `engine/prompt_injectors.js` — `registerPrefixSuffixInjectors(assembler, config)`：把 config 的 prefix/suffix 注册成 `useWrapLastUser` 注入器；群聊模式（`ctx.agent.runContext.mode==='room'`）跳过（对齐旧 elf-001 子类群聊语义，顺带消除旧 elf-003 群聊也拼 prefix 的不一致 bug）。

**改造**：
- `engine/message_manager.js` — `getMessagesForLLM` 只产 base（systemMsg + stripped messages）；新增 `getBaseForLLM`；`estimateTokens` 经 `_setPromptAssembler` 回填的 assembler 计 token（含注入内容）；删 `_injectTransientListing` 方法 + `skillListing` 字段。
- `engine/default_agent.js` — 持 `PromptAssembler`；reasoning 改 `promptAssembler.assemble(mm.getBaseForLLM(), ctx)`；回填 `mm._setPromptAssembler`。
- `agents/elf-001/create_agent.js` + `agents/elf-003/create_agent.js` — 用 base mm（不再子类）+ `registerPrefixSuffixInjectors`。
- **删** `agents/elf-001/message_manager.js` + `agents/elf-003/message_manager.js`（prefix/suffix/roster 子类重写）。
- `engine/room_plugin.js` — `_ensureRoomPrompt` 改注册 `useSystemAppend(ROOM_BEHAVIOR_PROMPT)` + `useWrapLastUser(roster provider)`；删 mutate `mm.systemPrompt` / `mm._roomMode`；`_refreshRoster` 不再写 `mm.roomRosterPrefix`。`ROOM_BEHAVIOR_PROMPT` 改 export。
- `engine/skills/lister.js` — `enable()` 注册 `useBeforeLastUser(listing provider)`；`_refreshListing` 写 `lister._currentListing`（不再 `mm.skillListing`）；不接受 agent 入参改传 `agent`。
- `agents/elf-002/message_manager.js` — `getMessagesForLLM`/`getBaseForLLM` 删 roster 拼装 + listing 临注入（保留 `_enforceBudgetWindow` 副作用）；删 `estimateTokens` override（用基类 assembler-aware 版）；删 `roomRosterPrefix` 字段。

**测试**：新增 `prompt-assembler.test.js`（14）+ `prompt-assembly-anchor.test.js`（4，测注入器行为）；改 `elf001-message-manager.test.js` 测 `registerPrefixSuffixInjectors`；`skills.test.js` 改测 `_currentListing` + `assemble` 临注入。**510 pass / 0 fail** + vite build 通过。

**边界**：持久化 meta（addMetaMessage 系列）/ compact 历史改写 / compact 请求 system / 子 agent system / config 读写回——明确不进本模块。

---

## 2. `_enterRunLevel` 放哪（已落地）

**结论：run-level 逻辑全部归 harness，agent 不写一行 run-level 代码。**

落地形态（`engine/harness.js`）：
- 新增 `harness.withRunLevel({ toolManager, middlewares, tools, disableTools, middleware, filterTools })` 总入口，一次返回组合 restore。
- 无自有状态：`toolManager` / `middlewares` 数组都由调用方(agent)传入，harness 借它们做覆盖（工具/禁用借 toolManager，中间件借数组 push/length 截断）。
- 新增 `harness.runScoped(restore, fn)` 包 try/finally，供请求体一体化（当前 receive 仍用 `restore()` + 自己的 try/finally，runScoped 备用）。

agent 侧（`engine/default_agent.js`）：**删 `_enterRunLevel` 方法**，`receive` 两个分支(chat/非chat)直接 `const restore = this.harness.withRunLevel({...})`，场景裁剪 `filterTools` 作为函数入参传(默认透传，scene 给就调)。

toolManager 侧（`engine/tools/tool_manager.js`）：新增 `withDisabled(names)` 返回 restore，收口原"外部直接戳 `_activeDisabled` 私有字段"的逻辑，由 ToolManager 自管（`_activeDisabled` 字段保留，`getAll` 行为不变）。

**取舍记录**：run-level 三件事里"工具/禁用"是有状态动作(操作 toolManager)，但 harness 携 toolManager 入参执行即可，不必让 harness 持有 toolManager——保持 harness 无状态。中间件归 agent 的 `this.middlewares` 数组，harness 借入参 push/pop。

---

## 2b. flushLoop 内联（已落地）

**结论：删 `ScenePlugin.flushLoop`，flush 循环内联进 `default_agent.receive` 的 chat 分支，reasoning 在主流程台面可见。**

落地形态（`engine/default_agent.js` receive chat 分支）：
```js
const restore = this.harness.withRunLevel({ toolManager, middlewares, tools, disableTools, middleware, filterTools });
let ranReasoning = false;
try {
  let merged;
  while ((merged = await this._dispatchGate('mergeForReason', null)) && merged.trim()) {
    ranReasoning = true;
    scene.replying(true);
    this.messageManager.addUserMessage(merged);
    try { await this.reasoning(null, { skipAddUser: true, emit }); }
    finally { scene.replying(false); await this._dispatchGate('postReason', null); }
    if (!scene.shouldContinue()) break;
  }
} finally { restore(); }
if (!ranReasoning) this.abortFlow.emitDone(emit);
```

scene 侧（`engine/scene_plugin.js`）：删 `flushLoop`，留两个原语 `replying(v)` / `shouldContinue()` 供循环驱动；`mergeForReason`/`postReason`/`shouldFlush` 保留为 gate handler。单 done 语义保留(仅"一轮没跑"补 done)。

测试侧（`test/room_agent.test.js`）：原直调 `flushLoop` 的两个 case 改走 `a.receive(...)` 入口驱动(buffer 由真实 @消息经 preReceive 填充，monkey-patch reasoning 仍控 pending)。

---

## 3. `_mw / _dispatchGate / _emit / _runInjection` + 死代码 + harness 职责（已落地）

**逐个核实（非测试调用方）**：

| 符号 | 原判断 | 落地 |
|---|---|---|
| `_mw`（getter） | 只是 `[...middlewares, _scene]` 的糖 | ✅ **删** |
| `_dispatchGate` / `_runInjection` | 薄封装转发 harness | ✅ **删**，调用点直接 `this.harness.dispatchGate/runInjection([...this.middlewares, ...(this._scene?[this._scene]:[])], ...)` 就地展开效中间件 |
| `_emit` | 仅 1 处生产调用（`mm._eventSink`），测试 4 处直调 | ✅ **删**，调用点 `this.harness.emit(this.callbacks, event, data)`；测试直调改 `a.harness.emit(...)` |
| `updateModel` | 非测试 0 调用（reloadConfig 绕过）→ 死代码 | ✅ **删**，测试 6 处 `agent.updateModel(x)` → `agent.model = x` |
| `updateMessageManagerConfig` | 非测试 0 调用 → 死代码 | ✅ **删**（测试也无引用） |
| `abort` | 活代码（server/子 agent abort 入口，触发 `mm.abortBackgroundCompact`） | ✅ 留 |

**default_agent 无任何"转发 harness"私有方法**：`_mw`/`_dispatchGate`/`_runInjection`/`_emit` 全删，调用点直调 `this.harness.*` 并就地展开效中间件（`[...this.middlewares, ...(this._scene ? [this._scene] : [])]`）。展开式重复 6 处接受——它比一个语义模糊的 `this._mw()` 直白。

**`reloadConfig` 不进 harness**：它做 `config.load()` → new Model（含 mock vs LLMModel 业务判断）→ `mm.updateConfig`，全是操作 agent 持有的有状态对象 + 业务决策，塞进 harness 破坏其"无状态机制层"定位。它就是 agent 编排。两个被删的死方法本是给 reloadConfig 留的入口，结果 reloadConfig 直接绕过它们——删之顺理成章。

**harness 职责**：维持无状态机制层（`runInjection/dispatchGate/emit/abort` + 新增 `withRunLevel/runScoped`）。机制归 harness，状态归主人（config/model/messageManager 归 agent，toolManager 自管工具注册表），分工干净。

---

## 4. 群聊压缩 + 加日志（已落地）

**"不按配置"误判**：压缩入口 `compactIfNeeded` 模式无关，私聊/群聊同一份代码和配置。群聊插件完全不碰压缩；唯一差异在网关 `process_manager.js` 丢弃群聊 compact 事件（前端无订阅者）。

**落地**：三处静默跳过加日志 + 群聊 compact 抑制日志。
- `engine/message_manager.js:212` 主门：`logger.info([compact] tokens=${_est} <= memoryTokenLimit=${...}, 未触发压缩)`
- `engine/message_manager.js:229` bg apply 后复检：`logger.info([compact] bg apply 后 tokens=${_est2} <= ...，本轮不再压)`
- `agents/elf-002/message_manager.js:329` microcompact 后门：同上
- `gateway/process_manager.js:396` compact 类群聊事件明记抑制行，消除"压了但看不到"的误判。

---

## 5. 数据布局收敛到 profiles/（按所有权重设计）

**核心原则（你的）**：
- **agent 的记忆、临时状态 → 属于 agent**（agent 记忆不与群成员共享）。
- **room/chat 的聊天历史、临时状态 → 属于 room**。

按此所有权落盘，**不要三份并行副本**：

```
profiles/
├── agents/
│   └── <agentId>/                 # ← agent 拥有
│       ├── config/                #   代码+配置（从 agents/ 迁来）
│       │   └── config.json, *_prompt.md, api_key.json, avatar...
│       ├── memory/                #   私聊记忆（原 chat/<id>/data/）
│       │   ├── context.json
│       │   ├── tool-results/
│       │   ├── checkpoints/
│       │   └── sync_cursor.json
│       └── rooms/                 #   该 agent 在各群的私有记忆（原 chat/<id>/<rid>/）
│           └── <roomId>/
│               ├── context.json
│               └── sync_cursor.json
├── rooms/
│   ├── <roomId>/                  # ← room 拥有
│   │   ├── room.json              #   房间专属配置
│   │   ├── history.jsonl          #   群聊历史（schema: speaker/event，不落 tool）
│   │   └── run/<agentId>.json     #   成员进程登记（port/pid/roomBusUrl），room 视角的成员运行态
│   └── chat-<agentId>/            #   私聊也是 room（v3）
│       └── history.jsonl          #   私聊历史（schema: role/toolCalls，落 tool），无 room.json
└── logs/
```

**所有权边界**：
- agent 拥有：`config/`、`memory/`、`rooms/<rid>/`（私聊记忆 + 该 agent 在某群的记忆）
- room 拥有：`room.json`、`history.jsonl`、`run/<agentId>.json`

**消除并行副本**：当前 `chat/<id>/<rid>/` 与 `rooms/<rid>/data/<id>/` 同存一份成员 context，按新设计**只留一份** `profiles/agents/<id>/rooms/<rid>/`；原 `rooms/<rid>/data/<id>/run.json` 拆到 `profiles/rooms/<rid>/run/<id>.json`。

**私聊状态天然拆两主**（符合所有权）：记忆在 `profiles/agents/<id>/memory/`，历史在 `profiles/rooms/chat-<id>/history.jsonl`。**checkpoint 要同时重建这两目标**——`snapshot` 改成从这两个源取，rewind 写回这两目标，寻址关系保。

**解散删除**（删哪个目录现在清晰）：`delete room` → 删 `profiles/rooms/<rid>/`（历史+配置+run 登记）+ 循环删每个成员 `profiles/agents/<id>/rooms/<rid>/`（该 agent 在此群记忆）。成员私聊 `memory/` + `checkpoints/` 不动。

**迁移点**：
- `agents/` → `profiles/agents/<id>/config/`
- `chat/<id>/data/` → `profiles/agents/<id>/memory/`
- `chat/<id>/<rid>/` → `profiles/agents/<id>/rooms/<rid>/`
- `rooms/<rid>/` → `profiles/rooms/<rid>/`（run.json 拆到 `run/<id>.json`）
- `rooms/<rid>/data/<id>/` → **去掉**（并入 `profiles/agents/<id>/rooms/<rid>/`）
- `rooms/chat-<id>/` → `profiles/rooms/chat-<id>/`
- `logs/` → `profiles/logs/`

**写路径收敛**：新增一个 profiles 路径解析模块（取代各处 `path.join` 散写），涉及 `engine/message_manager.js:65-69`、`engine/sync_source.js:40`、`engine/run_context.js`、`engine/start.js`、`gateway/snapshot.js`、`gateway/room_bus.js`、`gateway/chat_history.js`、`gateway/index.js`。顺带写 `migrateProfiles()`（仿 `start.js:44 migrateDataDir`）兼容旧目录。

---

## 6. skills 单目录 `~/.elf`（已落地）

**落地**：去 project 根，统一 `~/.elf/skills`。
- `engine/skills/registry.js` — 删 `projectDir` 加载，`loadAll()` 无参；`_loadDir`/`_loadOne` 去 `source` 参数；Skill 对象删 `source` 字段。
- `engine/skills/lister.js` — 去 `_cwd` 字段，`enable/inject/reinvokeAfterCompact` 里 `loadAll()` 无参。
- `engine/build_agent.js` — `new SkillLister({ messageManager, toolManager })` 去 `cwd`。
- `gateway/skill_store.js` — `skillRoots()`→`skillRoot()` 单根导出；`listSkills`/`getSkillDetail`/`deleteSkill` 去 `source` 参数。
- `gateway/server.js` — `/skills/:source/:name` → `/skills/:name` 路由；返回 `root` 单字段。
- `frontend/src/api/index.js` — `getSkillDetail(name)`/`deleteSkill(name)` 单参。
- `frontend/src/components/SkillManager.jsx` — 删 `SOURCES` 两栏渲染，改单 section 列表；删 `roots` 分 source 逻辑。
- `test/skills.test.js` — `makeSkillDir` 写 `ELF_SKILLS_USER_DIR/.elf/skills/`；`makeSkillAgent()` 去 cwd 入参；各 `loadAll()` 无参；beforeEach 清隔离 home 防残留。
- 清理项目根 `.elf/` 空目录。

**取舍确认**：项目级 skill 能力被砍，所有项目共享一套。已接受。

---

## 7. LLM 请求失败重试前端气泡

**现状**：重试全在后端静默——`llm_model.js:38 MAX_RETRIES=3`，`withRetry` 包建连+首响应，失败抛 `lastErr`，**不发任何 SSE**。前端失败仅**私聊**一个 Toast（`sseDispatcher.js:366`）；**群聊连 error 监听都没注册**（`useRoomChat.js:30-58` 只听 snapshot/speak/member_status）。

**现成范式**：`CompactBadge` 已实现 "loading/success/abort/error + 第 N 次重试" 气泡（`CompactBadge.jsx:12-14`，`attempt>1` 显示"（第 N 次重试）"），`sseDispatcher.js:260-315` 配合 `compact_start/compact_error` 驱动。LLM 重试气泡几乎照抄。

**落地切片**：
- 后端：`withRetry/chatStream` 加 `onRetry`，`default_agent.js` reasoning 里 `emit({event:'llm_retry', data:{attempt, maxRetries, error}})` + 耗尽 `emit llm_retry_final`。私聊/群聊同一 emit 点。
- 网关：私聊 `private_room_stream.js` 加 `llm_retry_*` 分支（仿 compact）；**群聊** `room_bus.js` 广播当前不转发 error/retry，要新增 `broadcast('llm_retry_*')` 分支。
- 前端：私聊 `sseDispatcher` 加 `llm_retry_*` case（照抄 compact），`AssistantBubble` 加 `LLMRetryBadge`；群聊 `useRoomChat` 加 `addEventListener`，RoomChatPanel 现无 Toast/瞬态气泡，需新建。
- 顺序：先私聊（改完即闭环），再群聊（多个广播通道）。

---

## 8. 私聊 history.jsonl 格式 + 流式 snapshot 契约（已落地）

### 8a. 格式约定（已落地）

- 每条消息一行，按 seq 时序，与流式渲染序一致。
- **多轮 reasoning 分轮落盘**：LLM 一次 turn 内多轮 reasoning（第1轮返回 tool_calls→执行→第2轮返回纯文本），每轮各落一条独立 assistant 记录。`_flushBubble` 在检测到"上一轮 tools 已全完成 + 新 token/tool_call 到达"时即时落盘上一轮并清空累积器。`done` 时收尾 flush 剩余。整 turn 无输出（abort）也落一条空记录保 seq。
- assistant 即使 content 为空也落盘（保时序：前端 `historyToTurns` 纯行序重建，缺位即错位）。
- compact 多次重试只存一条，用 `compactAttempt` 字段记第几次，`updateCompactRecord` 全文件 in-place 改写同 `compactId` 行。
- tool call + tool result 同一条 assistant 记录的 `toolCalls[]` 同一对象里：`tool_call` 事件设 `status:'executing'`，`tool_result` 事件按 `id` 更新 `status`→`success`/`error` + `message`。
- 空 content 强制落 `''`（去 `st.assistantContent` 空跳过 guard）。

### 8b. 刷新 SSE 流式状态契约（已落地，重点）

**根因回顾**：v3 把私聊建成 `chat-<id>` Room + 常驻 SSE subscribe 后，存在两条历史加载路径——`useAgentSubscriptions` 的 SSE snapshot（gateway 从磁盘+内存拼）和 `ChatPanel` mount 时的 REST `loadHistory`（纯磁盘）。两条并行读磁盘建 turns，谁后到谁覆盖，导致：
- user 翻倍（REST turns 含 turn_U1 + snapshot activeTurn 也含 U1）
- 历史乱（REST 静态快照与实时流错位）
- snapshot 残缺（gateway 原来只把未落盘尾放进 activeTurn，但 pop 了磁盘 turn_U1 含已 flush 的 A1，A1 丢）
- SSE"断裂"假象（snapshot 在"发消息→首 token"窗口返回 activeTurn=null，前端不锁输入框 + 后续 token 被 token handler `if(!at) return` 全丢）

**落地修复**：
- **历史加载单源**：running 时刷新只走 SSE snapshot（snapshot 设 `historyLoaded:true`），REST `loadHistory` 仅 `force:true` 时用（rewind）+ agent stopped 时兜底一次。`loadHistory` 非 force 直接 return。删 `sseDispatcher` 的死 `idle` case（后端从不发 idle）。
- `_patchChat` 懒创建 chat 对象——SSE snapshot 可能在 ChatPanel mount 前到达，原 `if(!chat) return` 会丢 snapshot。
- **snapshot 拼装补全整轮**（修残缺）：`activeTurn` = pop 出的 `turn_U1.assistantBubbles`（已 flush 落盘的 A1/A2，标 `sealed:true`）+ 当前未落盘尾 bubble。这样不翻倍（turn_U1 被 pop）、不残缺（A1 在 activeTurn）、token 续接正常（尾 bubble 没 sealed，token handler 追加；新一轮 token 到达时 lastBubble 已 sealed → 新建）。
- **snapshot streaming 必带 activeTurn**：即使首 token 未到（`assistantContent=''`、`toolCalls=[]`）也带空 bubbles 的 activeTurn，保锁输入框 + 续接后续 token。修复"发消息→首 token 窗口刷新"断 SSE 假象。

### 8c. snapshot 三阶段刷新行为（修复后）

| 阶段 | 磁盘 turns | activeTurn | 前端表现 |
|---|---|---|---|
| A (首token前) | pop turn_U1 → `[]` | `{U1, bubbles:[]}` | U1 一次 + 锁输入框 + 接首 token |
| B (回复中,多轮) | pop turn_U1 → `[]` | `{U1, bubbles:[A1(sealed), 尾部分]}` | U1 一次 + 历史轮次完整 + 流式续接 |
| C (done后) | 含 turn_U1(A1,A2) 不 pop | `null` | 历史正常 |

### 8d. vite proxy（已落地）

`frontend/vite.config.js` proxy 补 `/rooms`、`/skills`、`/settings` 三个顶层路由（原只 `/agents`、`/api`，开发态 Vite dev server 下这些路由全 404）。

### 8e. 不统一确认

群聊 `RoomHistory` schema（speaker/event，无 toolCalls）与私聊 `ChatHistory` schema（role/toolCalls/compactId）本就不同，也不应统一。代码未改此差异。

### 8f. 契约模块化封装（已落地）

按 `docs/turn-stream-module-plan.md` 方案，把散在 3 处的 snapshot/streaming 契约收敛成模块 + 跨端共享的形状定义代码（不靠文档）。

**新增模块**：
- `shared/turn-stream-contract.js` — 跨端共享的纯函数形状定义：`sealedBubble`/`openBubble`（后端产 bubble 工厂，落盘标 sealed/未落盘不标）、`shouldStartNewBubble`（前端续接判定：sealed→新建，未 sealed→续接）、`makeSnapshot`。前后端 `import` 同一份，sealed 约定由代码定义而非注释。
- `gateway/turn-stream-server.js` — 后端模块 `TurnStreamServer`：写盘（多轮分块）、当前回合内存态、`buildSnapshot` 去重+补全整轮+必带 activeTurn。不认识 reasoning/tool_call/compact（content 作流式增量原语，其余作带 id 的命名锚定事件）。多轮分块判定 `shouldStartNewBubble` 由外部注入（原 `isNewRound` 逻辑搬入 gateway，agent 层零改动）。
- `frontend/src/lib/turn-stream-client-core.js` — 前端纯计算核心：`rebuildFromSnapshot`（snapshot 单源重建）、`applyToken`（sealed 续接）、`applyToolCall`/`applyToolResult`（增量更新 + 全完成 sealed）。不碰 React/IO/raf，可 node:test 测。

**适配/改造**：
- `gateway/private_room_stream.js` — 转为适配层：保留生产导出签名（`subscribePrivateRoom`/`startPrivateTurn`/`handlePrivateAgentEvent`/`isPrivateRoom`/`_testReset`，route 层零改），内部转调 `TurnStreamServer` 单例。res/SSE 订阅者管理留适配层（模块不碰 res）。
- `frontend/src/stores/sseDispatcher.js` — snapshot/token/tool_call/tool_result 4 个 case 改为调 `turn-stream-client-core` 纯函数；compact/finalize/aborted 等 store-coupled 逻辑留原处（抽走收益为负）。
- `frontend/src/hooks/useAgentSubscriptions.js` — 现状已是方案要求的胶水（监听 agents→diff runningIds→建拆 SSE，执行委派 fetch/重连，事件转 sseDispatcher 即转 client-core），无实质改动。

**未做的事**（按方案 §0b 标注的风险）：未建独立 `TurnStreamClient` 类包揽 SSE 连接（连接已在 hook 跑通且被后端锚定测试兜底，建类牵动 React hook 收益不明）。SSE 自管+重连逻辑仍在 `useAgentSubscriptions`，靠 vite build + 手动端到端 + integration 间接覆盖。

**测试网**（先补测试锚定现状，再封装）：
- `test/private_room_stream.test.js` 扩 +7 case 锚定 #8 修复点（多轮分块/空 content/tool 状态/snapshot 去重/补全整轮/必带 activeTurn/done 终态）。
- `test/turn-stream-contract.test.js`（+10）测跨端契约纯函数。
- `test/turn-stream-client-core.test.js`（+12）测前端纯计算。
- 封装前后均 494 pass / 0 fail（含后端 9 + contract 10 + client-core 12 锚定）。vite build 通过。

---

## 附：八条最终判定速查

| 条 | 核心断言 | 判定 |
|---|---|---|
| 1 | 注入点位 + 取消 mm 子类 | ✅ 已落地：`PromptAssembler`（三点位 6 个 useXxx 槽位）收口临时请求拼装；删 elf-001/003 mm 子类 + RoomPlugin mutate + 4 个 mm 实例字段；群聊 prefix/suffix 不一致 bug 顺带消除；持久化 meta 不进本模块。11 步详见 §1 |
| 2 | `_enterRunLevel` 放哪 | ✅ 已落地：run-level 全归 `harness.withRunLevel`，agent 零 run-level 代码；另删 `ScenePlugin.flushLoop`，flush 循环内联进 `receive`（reasoning 台面可见），见 §2/§2b |
| 3 | 符号冗余/死代码 | ✅ 已落地：删 `updateModel`/`updateMessageManagerConfig` + `_mw`/`_dispatchGate`/`_runInjection`/`_emit` 四个私有方法（全内联直调 `this.harness.*`）；`abort` 留；`reloadConfig` 不进 harness（业务编排），见 §3 |
| 4 | 群聊压缩 + 加日志 | ✅ 已落地：三处静默跳过加 token 数日志 + 群聊 compact 抑制日志，见 §4 |
| 5 | 收敛 profiles/ | 按所有权重设计：agent 拥有 memory+rooms 记忆，room 拥有 history+room.json+run 登记去重副本 |
| 6 | skills 单目录 ~/.elf | ✅ 已落地：去 project 根，统一 ~/.elf/skills；registry/lister/skill_store/server/frontend/api/test 全面收敛，见 §6 |
| 7 | LLM 重试前端气泡 | 可行性高，CompactBadge 现成范式，缺后端 `llm_retry_*` 事件 + 群聊广播 |
| 8 | history.jsonl 格式+流式 snapshot | ✅ 已落地：多轮分轮落盘、空 content 保时序、tool 状态 executing→success/error；刷新历史加载单源(SSE snapshot 为主, REST 仅 rewind/stopped 兜底)；snapshot 补全整轮(修残缺)+ streaming 必带 activeTurn(修断 SSE 假象)；vite proxy 补 /rooms/skills/settings。契约模块化待讨论，见 §8 |

---

## 附：本次落地变更

**temp #2 + flushLoop 内联 + temp #3 死代码/内联**：
- `engine/harness.js` — 新增 `withRunLevel({...})` 总入口（三件覆盖 setup/restore，无自有状态，借 toolManager/middlewares 入参）+ `runScoped(restore, fn)`。
- `engine/tools/tool_manager.js` — 新增 `withDisabled(names)` 收口 `_activeDisabled` 私有戳。
- `engine/default_agent.js` — 删 `_enterRunLevel`；`receive` chat/非chat 两分支直接调 `harness.withRunLevel`；chat 分支内联 flush 循环；**#3：删 `updateModel`/`updateMessageManagerConfig` 死方法；删 `_mw`/`_dispatchGate`/`_runInjection`/`_emit` 四个私有方法，调用点直接 `this.harness.*` 就地展开效中间件**。
- `engine/scene_plugin.js` — 删 `flushLoop`；加 `replying(v)` / `shouldContinue()` 原语。
- `test/run_level_tools.test.js` — 直调 `_enterRunLevel` 改为调 `harness.withRunLevel`。
- `test/room_agent.test.js` — 直调 `flushLoop` 两个 case 改走 `receive` 入口。
- `test/agent.test.js` / `test/shared.test.js` — `agent.updateModel(x)` 6 处改为 `agent.model = x`；`_emit`/`_runInjection`/`_dispatchGate` 直调改 `a.harness.*`。

**temp #5 profiles/ 收敛**（详见 §5）：
- 新增 `shared/profiles_paths.js` — 单一路径源：`profilesRoot/agentMemory/agentRoomState/roomsRoot/logsDir`。**不兼容旧布局、无自动迁移**（老数据手动搬）。
- `shared/logger.js` — `logsDir()` → `profiles/logs`。
- `gateway/process_manager.js` — spawn `ELF_DATA_DIR` → `agentMemory(id)`。
- `gateway/index.js` — `roomsDir` → `roomsRoot()`；删 `pm.chatDir`。
- `gateway/snapshot.js` — `_dataDir`/`_checkpointsDir` 基于 `agentMemory(id)`；`snapshotBeforeSend`/`rewindTo`/`listCheckpoints` 去掉 agentsDir 形参（双根打包/还原改使用 profiles 路径）。
- `gateway/room_bus.js` — `RoomRegistry` 写 `<roomsDir>/<rid>/run/<id>.json`（schema 从旧 `data/<id>/run.json` 改 `run/<id>.json`）；`deleteRoom`/`removeMember`/`clearMemberMemory` 删 `agentRoomState(id, rid)`（不再删 `chat/<id>/<rid>`）；删 `chatRoot` 字段。
- `gateway/room_routes.js` — snapshot 调用去 `pm.chatDir`；memory 清理用 `agentMemory(id)`。
- `agents/<id>/create_agent.js` ×3 — 开发回退 `agentMemory(id)`。
- `.gitignore` — 加 `profiles/`；留旧 `chat/`、`rooms/`、`agents/*/data/` 防残留误入库。
- 测试：`room_bus.test.js` 设 `ELF_PROFILES_ROOT` 隔离 + 伪数据走 `agentRoomState` + 修原 3 个预存 fail；`room_routes.test.js`/`integration.test.js` 隔离 profiles；`shared.test.js` 日志断言走 `logsDir()`。

**temp #1 提示词注入统一**（详见 §1）：
- 新增 `engine/prompt_assembler.js`（`PromptAssembler`：6 个 useXxx 槽位 + assemble）+ `engine/prompt_injectors.js`（`registerPrefixSuffixInjectors`）。
- `engine/message_manager.js` — getMessagesForLLM 只产 base + 新 getBaseForLLM + estimateTokens 经 assembler + 删 `_injectTransientListing`/`skillListing`。
- `engine/default_agent.js` — 持 `PromptAssembler` + reasoning 调 assemble + 回填 mm._setPromptAssembler。
- `agents/elf-001/create_agent.js` + `agents/elf-003/create_agent.js` — base mm + 注册 prefix/suffix 注入器。
- **删** `agents/elf-001/message_manager.js` + `agents/elf-003/message_manager.js` 子类。
- `engine/room_plugin.js` — `_ensureRoomPrompt` 注册 useSystemAppend + roster useWrapLastUser；删 mutate/`_roomMode`；`_refreshRoster` 不再写 mm 字段；export `ROOM_BEHAVIOR_PROMPT`。
- `engine/skills/lister.js` — enable 注册 useBeforeLastUser；`_currentListing` 取代 mm.skillListing；接受 agent 入参。
- `agents/elf-002/message_manager.js` — 删 roster/listing 段（保留 budget/compact）；删 estimateTokens override；删 roomRosterPrefix 字段。
- 测试：+`prompt-assembler.test.js`(14) +`prompt-assembly-anchor.test.js`(4)；改 `elf001-message-manager.test.js` / `skills.test.js` 测新实现。

**temp #4 压缩日志**（详见 §4）：
- `engine/message_manager.js` — 主门(L212) + bg apply 复检(L225) 各加 `tokens <= limit` 跳过日志。
- `agents/elf-002/message_manager.js` — microcompact 后门(L329) 同上。
- `gateway/process_manager.js` — compact 类群聊事件增加抑制日志，消除"压了但看不到"的误判。

**temp #6 skills 单目录**（详见 §6）：
- `engine/skills/registry.js` — 去 project 根；`loadAll()` 无参；Skill 对象删 `source` 字段。
- `engine/skills/lister.js` — 去 `_cwd` 字段和入参。
- `engine/build_agent.js` — `new SkillLister({ messageManager, toolManager })` 去 cwd。
- `gateway/skill_store.js` — `skillRoot()` 单根；`listSkills`/`getSkillDetail`/`deleteSkill` 去 source。
- `gateway/server.js` — `/skills/:source/:name` → `/skills/:name`。
- `frontend/src/api/index.js` + `SkillManager.jsx` — 去 source 参数 + 两栏渲染改单 section。
- `test/skills.test.js` — 全面适配单目录，beforeEach 清隔离 home 防残留。
- 清理：项目根 `.elf/` 空目录已删。

**数据清理**：
- 旧布局目录 `chat/`、`rooms/`、`logs/` 已手动删除。新数据从 `profiles/` 起。

**temp #8 私聊 history 流式 snapshot**（详见 §8，多轮迭代修复）：
- `gateway/private_room_stream.js` — 多轮 reasoning 分轮落盘（`_flushBubble` 即时 flush + `isNewRound` 检测）；空 content 强制落盘保时序；`tool_call` 设 `status:'executing'` + `tool_result` 按 id 更新 status；snapshot streaming 必带 activeTurn（修"发消息→首 token 窗口刷新"断 SSE 假象）；snapshot `activeTurn` 补全整轮（pop 的 `turn_U1.assistantBubbles` 标 sealed + 未落盘尾 bubble 合并，修残缺）。
- `frontend/src/stores/agentStore.js` — `loadHistory` 非 force 直接 return（单源：SSE snapshot 为主）；`_patchChat` 懒创建 chat（SSE snapshot 可能在 ChatPanel mount 前到达）。
- `frontend/src/components/ChatPanel.jsx` — init `useEffect` 移除 running 时 `loadHistory` 兜底；仅在 `agent.status !== 'running'` 时 `loadHistory({force:true})` 兜底。
- `frontend/src/stores/sseDispatcher.js` — 删死 `idle` case（后端从不发）+ snapshot 到达诊断日志。
- `frontend/src/hooks/useChat.js` — rewind 用 `loadHistory({force:true})`。
- `frontend/vite.config.js` — proxy 补 `/rooms`、`/skills`、`/settings`。

**测试结果**：全量 **465 pass / 0 fail**（含修掉基线预存的 3 个 `room_bus` fail）。