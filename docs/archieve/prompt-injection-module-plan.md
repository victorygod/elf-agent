# PromptAssembler —— 提示词拼装统一模块

> 日期：2026-07-26
> 依据：`docs/temp-analysis-conclusions.md` §1 + 全点位探查。

## 一、范围（严格三点位 + 临时拼装）

只收口**发给 LLM 这一轮请求的临时拼装**（不落盘、每轮重算、可叠加）。其余历史修改不进本模块。

**三个点位**：

| 点位 | 操作 | 现散点 |
|---|---|---|
| ① 系统提示词 | 追加到 systemPrompt 尾 / 整体替换 | `RoomPlugin._ensureRoomPrompt`（mutate `mm.systemPrompt`）；config 读 `system_prompt` 作基线 |
| ② 最近一条 user 消息及其前后 | 前插独立消息 / 后插独立消息 / 前后缀修改其 content | prefix_prompt、suffix_prompt、roster（mm 子类重写 `getMessagesForLLM`）；skill listing（mm `_injectTransientListing` 插最近 user 前） |
| ③ 末尾追加 | push 一条独立消息 | `_injectTransientListing` 无 user 时 push 末尾 |

**明确不进**：持久化 meta（addMetaMessage 系列）、compact/microcompact/budget 历史改写、compact 请求的 system/指令、子 agent system、config 读写回。

---

## 二、模块 API（纯函数管道）

`engine/prompt_assembler.js`，注册时声明槽位，`assemble` 时按 order 顺序应用，纯函数无副作用。

| API | 点位 | provider 返回 |
|---|---|---|
| `useSystemAppend(provider, {order,name})` | ① 追加到 system 尾 | string（拼到 systemPrompt 后） |
| `useSystemReplace(provider, {order,name})` | ① 整体替换 system | string（替代基线） |
| `useBeforeLastUser(provider, {order,name})` | ② 最近 user 前插独立消息 | string（新 `{role:'user'}` content） |
| `useAfterLastUser(provider, {order,name})` | ② 最近 user 后插独立消息 | string |
| `useWrapLastUser(provider, {order,name})` | ② 修改最近 user 前后缀 | `{prefix?, suffix?}`（拼到该 user content 前/后） |
| `useAppend(provider, {order,name})` | ③ 末尾追加独立消息 | string |
| `assemble(base, ctx)` | 拼 | 返回最终 messages |

- `base` = mm 产的 `[{role:'system',content:systemPrompt}, ...stripped messages]`。
- `provider(ctx)` 返回 `null/''` → 本轮不注入。
- `ctx` 只读上下文：`{ mm, agent, roomMembers? }`，让 provider 现算（roster 要 fetch / listing 要扫）。
- `order` 决定同槽位多注入器的先后（数字小先），`name` 供诊断日志。

---

## 三、现有散点 → 注入器映射

| 现（散 + 脏） | 新（注册注入器） | 注册方 |
|---|---|---|
| `RoomPlugin._ensureRoomPrompt` 前拼 `ROOM_BEHAVIOR_PROMPT` 到 `mm.systemPrompt` | `useSystemAppend(() => ROOM_BEHAVIOR_PROMPT)` | RoomPlugin |
| config `prefix_prompt` 前拼最近 user | `useWrapLastUser(() => ({prefix: config.prefix_prompt}))` | create_agent |
| config `suffix_prompt` 后拼 | `useWrapLastUser(() => ({suffix: config.suffix_prompt}))` | create_agent |
| `roomRosterPrefix` 前拼（mm 子类 + 字段） | `useWrapLastUser(async () => ({prefix: await fetchRoster()}))` | RoomPlugin |
| `_injectTransientListing` 插最近 user 前 | `useBeforeLastUser(() => mm.skillListing)`（删字段，provider 现算） | skillLister |
| `_injectTransientListing` 无 user 末尾 push | `useAppend(() => mm.skillListing)` | skillLister |

---

## 四、改动清单

**删**：
- `agents/elf-001/message_manager.js`（prefix/suffix/roster 重写 `getMessagesForLLM`）→ 用 base mm
- `agents/elf-003/message_manager.js`（同上）→ 用 base mm
- elf-002 mm 的 roster 拼装 + `_injectTransientListing` 调用段（**compact/microcompact/budget 保留**——不属三点位）
- `RoomPlugin._ensureRoomPrompt`（不再 mutate `mm.systemPrompt`、不再设 `mm._roomMode`）
- `mm._injectTransientListing`、`mm._roomMode`、`mm.roomRosterPrefix`、`mm.skillListing` 字段

**改**：
- base mm `getMessagesForLLM` 只产 `base`（systemMsg + stripped messages），拼装委托 agent 持有的 `PromptAssembler`
- agent：持 `PromptAssembler`；reasoning 里 `messages = this.promptAssembler.assemble(mm.getBaseMessages(), ctx)`；暴露 `promptAssembler.useXxx` 给 plugin/装配访问
- `create_agent.js` ×3：装配时注册 config 注入器（prefix/suffix）；new base mm 不再子类
- `RoomPlugin.onRoomEnter`：`agent.promptAssembler.useSystemAppend(...)` 注册群聊行为；`preReason` 时刷 roster 改 provider 现算（不写字段）
- `skillLister.inject()`：不再写 `mm.skillListing`，每轮 assemble 时 provider 现算（compact 后自然重算，删 `reinvokeAfterCompact` 的 listing 重推那步；`invoked_skills` meta 重推保留——那是轴 B 不属本模块）
- `PrivateChatPlugin`：私聊不注册 roster/群聊行为（现状即如此）

---

## 五、效果

| 要求 | 达成 |
|---|---|
| 可控 | 注入器显式 `use(slot, provider, {order})`，槽位/顺序全声明，不靠 `_roomMode` 标志 |
| 方便（新场景） | 写个 provider + `useXxx`，不写 mm 子类、不 mutate |
| 理解高效 | 三点位 + 6 个 use 方法，一眼看全；provider 签名即契约 |
| 实现高效 | 纯函数管道，无副作用，易测 |
| 干净整洁 | 删 2 个 mm 子类的 prompt 部分 + 1 个 plugin mutate + 4 个实例字段；`systemPrompt` 不再被改 |

---

## 六、落地顺序（每步绿了进下一步）

0. **测试锚定**：先补后端测试锚定现状（system 追加/前拼、prefix/suffix、roster、skill listing 插位），跑绿=锚定；封装后跑绿=一致。
1. 建 `engine/prompt_assembler.js` + 纯函数单测（各 use 槽位、order 顺序、provider 返回空跳过）。
2. base mm `getMessagesForLLM` 产 base；agent 持 assembler 调 `assemble`。跑锚定测试。
3. `create_agent.js` 注册 config 注入器（prefix/suffix）；删 elf-001/003 mm 子类。跑锚定 + 全量。
4. RoomPlugin 注册 system append + roster（provider 现算）；删 `_ensureRoomPrompt`/`_roomMode`。跑全量。
5. skillLister 改注册注入器；删 `_injectTransientListing`/`skillListing` 字段。跑全量。
6. elf-002 mm 删 roster/listing 段（保留 compact/budget）。跑全量 + 前端 build。

**不破坏他功能的守则**：每步跑全量 `npm test` + 受影响回归（agent reasoning 流式、群聊 roster、skill 触发）；`private_room_stream`/`turn-stream` 模块不动；发现要碰持久化/compact/子 agent 立即停下重评估。