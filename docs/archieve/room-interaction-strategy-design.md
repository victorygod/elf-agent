# 群聊交互策略设计：@ 召唤式 vs 观测式

> v0.1 / 2026-07-26
> 关联：`room-as-agent-architecture.md`、`engine/room_plugin.js`、`engine/scene_plugin.js`、`engine/default_agent.js`

---

## 1. 两种策略

| | @ 召唤式（现有） | 观测式（新增） |
|---|---|---|
| 触发 | 被 @ 即时 | 关键词命中即时 **或** 观测窗口到期 |
| 发言义务 | 必须发言 | 允许不发言（Skip / 连续静默） |
| 门控阈值 | 不调 Speak 重试 1 次放弃 | 连续 `silentRetries`（默认2）次放弃 |
| 配置 | 无 | 关键词（agent 运行时自改）；观测间隔=动态退避常量（不可配） |

`interaction.strategy`：`'mention'`（默认，向后兼容）/ `'observe'` / `'both'`（@ 优先，观测兜底）。

---

## 2. 观测式触发条件（OR）

```
触发 = 关键词命中  OR  (观测窗口到期 AND buffer 非空)
```

- **关键词命中**：buffer 未读消息里有任一条匹配本 agent 的关键词（子串/正则）。即时触发一次 reasoning（加急通道，等同 @ 的即时性，但走弱门控）。
- **观测窗口到期 ∧ buffer 非空**：上次 reasoning 结束后满当前观测间隔（`_observeIntervalSec`）的"沉淀期"，若期间 buffer 又攒了新消息，触发一次巡视 reasoning。窗口起算点 = 上次 reasoning 结束时刻。观测间隔动态退避：初始 10s；每次 `Skip`→间隔×2 封顶 600s；每次 `Speak`→复位 10s；沉默不变（不落盘、重启回 10s，不在提示词里反映）。

两条都走弱门控（可静默）。`both` 策略下，被 @ 仍优先即时触发并走强门控（必须发言）；观测路径走弱门控。

---

## 3. 关键词模型与自配置

### 3.1 默认与上限

- 关键词**默认包含本 agent 名字**（等同"别人提到我名字我也能感知"，比 @ 更宽松——不要求显式 @）。
- 最多 **7 个**（含名字）。agent 可加可删，甚至删掉名字。
- 匹配：字符串元素用子串 `includes`，`/.../i` 形式用正则 `test`。

### 3.2 为什么需要工具

agent 要在运行时调整自己的关键词（"这个话题我感兴趣，加个关键词"），必须有工具写自己的配置——否则只能靠人改 config.json 重启。观测间隔由 RoomPlugin 按行权（Skip/Speak）动态退避，不归 agent 配。

### 3.3 `SetObserveConfig` 工具

```
name: SetObserveConfig
params:
  keywords: string[]        // 可选，整体替换；≤7 项；超出截断并提示
execute:
  // 校验 → 写 profiles/agents/<id>/rooms/<rid>/observe_status.json（只存关键词）
  // RoomPlugin 下次读配置走最新值（热更新，与 roster 同机制）
  return `已更新：keywords=[...]`
  // 观测间隔不由此工具设置——RoomPlugin 按 Skip/Speak 动态退避（见 §2）。silentRetries 固定常量。
```

- 调用即生效：`getObserveConfig()` 取运行时文件里的关键词（文件是关注词唯一来源）。观测间隔不在此取——见 §2 动态退避。
- 工具仅 `strategy in ['observe','both']` 时注册（`room_state.js` 装配判定）。
- `keywords` 缺省 = 不改；传 `[]` = 清空（连名字也删，等同于"只靠窗口巡视"）。

> 配置层：`SetObserveConfig` 写的运行时文件是关注词唯一来源；观测间隔为内存动态退避（非配置项、不落盘）。

---

## 4. 静默放手

观测式触发 reasoning 不强制发言：

- **`Skip` 工具**：主动声明"看过了不回"，`shouldBreakAfterTools` 见 Skip → break，零提醒。
- **连续 `silentRetries` 次不调 Speak/Skip**：`onAssistantContent` 注入提醒再试，超阈值 break。
- `both` 策略下 @ 触发仍用阈值 1（被@必须回）；观测触发用 `silentRetries`。用 `_currentTrigger` 标记本次来源切换门控。

`Skip` 与 `SetObserveConfig` 都仅在观测式注册，避免 @ 式 agent 多无用工具。

---

## 5. 落地要点

### 5.1 自驱动 flush（核心难点）

现有 `receive` 是消息驱动（`/observe`→`preReceive`→`flushNow`）。观测式需要"窗口到期、无新消息也触发"。

- `RoomPlugin` 武装 `setTimeout(_observeIntervalSec)`，到期回调 `agent.triggerRoomFlush()`。间隔按行权动态退避：`Skip`→×2 封顶 600s，`Speak`→复位 10s（`shouldBreakAfterTools` 内更新），沉默不变。
- `default_agent.js` 抽出 `_runFlushLoop()`（把 `receive` 内联 flush 循环提为可复用），`triggerRoomFlush` 调它。
- 到期回调内 `if (_replying) return` + `shouldFlushObserve()` 复核（buffer 非空、窗口确实到期），防竞态。
- 心跳兜底：`onRoomEnter` 起 `setInterval(heartbeatSec)`（默认30s）巡检 `shouldFlushObserve()`，防 timer 丢失。

### 5.2 状态与生命周期

`RoomPlugin` 新增：`_lastFlushAt`、`_observeTimer`、`_observeIntervalSec`（动态退避当前间隔）、`_currentTrigger`、`_speakAttempts`。

`dispose()` 清 timer + interval，在 `clearRoom`/`stopReplica`/`reloadFromDisk` 调用，防幽灵回调。

### 5.3 装配

`room_state.js` 按 `interaction.strategy`：
- mention：现状，注 `Speak`。
- observe：注 `Speak`+`Skip`+`SetObserveConfig`，`flushNow` 由关键词命中定，timer+heartbeat 兜底窗口。
- both：注三者，`flushNow = mention ∨ keyword`，@ 走强门控、观测走弱门控。

---

## 6. 时序示例（observe）

```
t=0   user:"这个架构有性能问题" → 命中关键词"性能"，flushNow→reasoning→调Skip
      _observeIntervalSec: 10→20（Skip 翻倍），_lastFlushAt=0，arm timer=0+20s
t=8   user:"要重构"            → 入buffer，未命中关键词，不即时触发
t=20  timer到期，buffer非空     → 巡视reasoning→又调Skip
      _observeIntervalSec: 20→40，_lastFlushAt=20，arm timer=20+40s
t=35  user:"大家怎么看"中"@elf" → 被@即时触发→调Speak发言
      _observeIntervalSec: 40→10（Speak 复位），_lastFlushAt=35，arm timer=35+10s
t=45  timer到期，buffer空       → 仍巡视一次（agent 可 Skip/主动 Speak）
间隔封顶 600s；沉默（只输出文本不调工具）不改间隔；退避不写进提示词。
```

---

## 7. 边界风险

1. **定时器生命周期**：`dispose` 必须清 timer+interval，漏清→幽灵回调。rewind/`/clear`/退群都要调。
2. **buffer 上限**：观测式下 buffer 可能堆积（窗口未到），设上限（如100）溢出丢最旧并 log。
3. **`Date.now()` 依赖**：测试用 fake timers。
4. **关键词即时触发防抖**：连续命中可能频繁触发 reasoning。建议加最小冷却（如窗口期的 1/3），作为实现细节，非硬需求。

---

## 8. 落地步骤

1. `Config` 支持 `interaction` 段；`RoomPlugin.getObserveConfig()` 读运行时文件 > config 默认。
2. `engine/tools/Skip.js` + `engine/tools/SetObserveConfig.js`。
3. 状态字段 + `_bufferHasKeyword()`；`preReceive` 关键词命中设 `flushNow=true`。
4. `_runFlushLoop` 抽取 + `triggerRoomFlush` + timer/heartbeat。
5. 门控分支（`onAssistantContent` 按 `_currentTrigger` 切阈值；`shouldBreakAfterTools` 纳 Skip）。
6. `dispose` + 生命周期接线。
7. 测试：关键词命中即时触发、窗口到期巡视、Skip、silentRetries、both 优先级、dispose 无幽灵、`SetObserveConfig` 热生效。

---

## 9. 待决

- **关键词即时触发的冷却**：是否需要（§7.4）？倾向加，防刷屏。
- **窗口起算点**：本文取"上次 reasoning 结束时刻"。备选"首次未读消息时刻"（消息进入即起算）。前者语义="沉淀期后巡视"，更稳；后者=消息驱动延迟触发。倾向前者。
- **`both` 下观测窗口内被 @**：@ 触发消费 buffer 后，观测起算点重置（@ 结束时刻起算），不保留旧窗口。待确认。