# TurnStream 模块封装方案

> 日期：2026-07-25
> 目标：把 temp #8 修复的"私聊流式 history + snapshot + 刷新稳定"逻辑，从散在 3 处收敛成两个独立模块 + 一份跨端共享的形状定义代码，固化这套行为，避免外部变动时反复修。
> 约束：**仅封装私聊**，群聊零影响；**不改 agent 层**；**最终效果零 diff**。

---

## 一、解决什么（只限 #8 范围）

封装**只解决 #8**，不带分页/rewind/背压/事件注册等发散功能。核心保证：

1. 多轮生成时每轮正确分块落盘（不丢、不并）
2. streaming 中 snapshot 去重当前 turn 的 user + 补全整轮（已落盘部分 + 未落盘尾）= 不翻倍、不残缺
3. streaming 必带 activeTurn（首 token 前的窗口也要锁 + 能续接）
4. 前端靠 `bubble.sealed` 续接（尾 bubble 续接 / 新轮新建）
5. SSE 自动重连，重连后用 snapshot 重建（数据正确）

---

## 二、现状结构（#8 修复后，逻辑散在三处）

```
gateway/private_room_stream.js （单文件 4 类职责混编）
├─ messagesToTurns()          磁盘消息 → turns
├─ _ensure(roomId)            进程内每房状态
├─ subscribePrivateRoom()     SSE 建连 + 拼 snapshot（去重 pop + 补全整轮 + 必带 activeTurn）
├─ handlePrivateAgentEvent()  收 agent 事件（isNewRound 启发式 → _flushBubble 分块落盘）
└─ _flushBubble()             写盘 + 清空累积器

frontend/src/stores/sseDispatcher.js + useAgentSubscriptions + agentStore.js （三文件耦合）
├─ useAgentSubscriptions      SSE 连接 + 2s 重连 + 解析 → handleSSEEvent
├─ agentStore.loadHistory     REST 历史（已守门成 force-only，单源靠"不触发"维持）
├─ _patchChat                 store 更新（懒创建 chat）
└─ handleSSEEvent
    ├─ snapshot case          用 snapshot 重建 store
    └─ token/tool_call/tool_result case
        └─ needNewBubble = !lastBubble || lastBubble.sealed  【续接约定，隐式】
        └─ _flushRaf raf 批处理

三方隐式契约（无代码，靠各自守约）：
  ① 后端：snapshot activeTurn 尾 bubble 不标 sealed，已落盘 bubble 标 sealed
  ② 后端：streaming 必带 activeTurn（即使无内容）
  ③ 前端：尾 bubble 无 sealed → 续接；有 sealed → 新建
  ④ 前端：snapshot 是唯一加载源，REST 不覆盖
```

**问题**：①②③④ 全靠注释/隐式约定，改一处要同步改三个文件且无人提醒。

---

## 三、封装后结构

```
shared/turn-stream-contract.js        前后端共享的形状定义（有逻辑的工厂/判定函数，非纯注释）
  - sealedBubble(open) / openBubble()       后端产出 bubble 的工厂：落盘的标 sealed、未落盘的不标
  - shouldStartNewBubble(lastBubble)        前端续接判定：sealed→新建，未 sealed→续接（①③契约由函数定义）
  - makeSnapshot({turns,activeTurn,...})    snapshot 形状工厂
  契约由代码定义，前后端 import 同一份，改一处全联动。前端经 vite alias 引用（纯 ES module，不依赖 Node API）。

gateway/turn-stream-server.js         后端模块
  class TurnStreamServer {
    constructor({ historyFile, shouldStartNewBubble, eventSink? })
    startTurn(userRecord)            标 streaming + 写 user + 并发互斥
    handleEvent(event, data)         content 累加 / 锚定事件按 id 应用 / 调注入判定决定分块
    buildSnapshot()                  { turns, activeTurn } 去重+补全整轮+必带 activeTurn（用 contract 工厂产 bubble）
    isStreaming()
  }

frontend/src/lib/turn-stream-client.js   前端模块（仅私聊 SSE）
  class TurnStreamClient {
    constructor({ sseUrl, onState })  私聊 SSE 端点 + 状态回调
    connect() / disconnect()          自管 SSE + 2s 重连
    // 内部：snapshot 单源重建 + shouldStartNewBubble 续接 + raf 批处理
  }

useAgentSubscriptions                 保留作 React⟷client 胶水：监听 agents 列表 → diff runningIds → 建拆 client 实例；onState 写 agentStore；React 卸载时清理
agentStore (zustand)                  保留：React 状态容器，模块经 onState 喂状态，不动 store/选择器
```

**契约不再靠文档固化**——①③(sealed)由 `shared/turn-stream-contract.js` 的工厂+判定函数定义，前后端调同一份代码；②④(streaming 必带 activeTurn、snapshot 单源)由模块实现本身保证。无独立"契约文档"，只有模块使用说明（README 性质）。

### 架构图（封装后）

```
                  SSE 事件流（agent → gateway）
                        │
          ┌─────────────▼─────────────┐
          │ TurnStreamServer (后端)    │  认：content 增量 + 命名锚定事件
          │ - 写盘（多轮分块）          │  不认：reasoning/tool_call/compact（payload）
          │ - 内存态（当前 turn）       │  shouldStartNewBubble 由 gateway 注入
          │ - buildSnapshot 去重+补全  │
          └─────────────┬─────────────┘
                        │ SSE（snapshot + 流式事件）
                        ▼
          ┌─────────────────────────────┐
          │ TurnStreamClient (前端,仅私聊)│  认：snapshot + 流式事件
          │ - 自管连接 + 2s 重连          │  不认：业务事件名（sealed 是通用机制）
          │ - snapshot 单源重建          │
          │ - sealed 续接 + raf 批处理   │
          └─────────────┬─────────────┘
                        │ onState(turns, activeTurn, historyLoaded)
                        ▼
                  agentStore(zustand) → React UI
                        ▲
                        │ onState 写
          ┌─────────────┴─────────────┐
          │ useAgentSubscriptions(React 胶水) │  监听 agents→diff runningIds→建/拆 client；卸载时清理
          └──────────────────────────────────┘

群聊（useRoomChat/EventSource）：不加载本模块，零影响。
```

---

## 四、关键设计点

| 点 | 决定 |
|---|---|
| 通用性边界 | **只解决 #8**，不带分页/rewind/背压/事件注册 |
| 跨端共享 | **sealed 形状约定跨端共享同一份代码**（`shared/turn-stream-contract.js`：工厂 `sealedBubble`/`openBubble` + 判定 `shouldStartNewBubble`，前后端 `import` 同一份；前端 vite alias 引，纯 ES module 不依赖 Node）。模块实现（server/client）各端一份不跨。契约由代码定义，**不靠文档**。 |
| 业务语义 | 模块**不认识** reasoning/tool_call/compact。content 作"流式增量"原语，其余作"带锚定 id 的命名事件"，模块按 id 找记录合并 payload |
| 多轮分块触发 | **外部注入判定函数 `shouldStartNewBubble`**——agent 层零改动，逻辑原样从现在 `isNewRound` 搬到 gateway 注入 |
| SSE 连接 | 前端模块**自管**（仅私聊，含 2s 重连）；重连是 #8"刷新稳定"一环 |
| 并发互斥 | 后端 `startTurn` 在 streaming 中拒绝第二个 turn |
| `useAgentSubscriptions` | 保留作 React⟷client 胶水：监听 `agents` 列表 → diff runningIds → 建拆 client 实例 + React 卸载清理。决定权在 hook（要响应式看 agents 变化），执行权（建连/断连/重连/状态构建）委派给 client。**不是空壳**——它守住 hook 独有、client 替代不了的 React 响应式桥接职责 |
| `agentStore` | 保留，模块经 `onState` 喂状态，store/选择器/ChatPanel 渲染零改动 |

---

## 五、为何 `shouldStartNewBubble` 外部注入

`isNewRound` 现在的判定（`toolCalls 非空 且 无 executing，且新 token/tool_call 到达`）是**业务启发式**——它认识 tool/executing，属 elf 领域知识。

- 塞进模块 → 模块不通用（换无工具项目就废）
- 让 agent 层 emit `startBubble` → 违反"不改 agent 层"底线
- seq+1 ≠ isNewRound（seq 是落盘副产物，且被 user/compact 混入，区分不出"assistant 新一轮"）

**折中**：判定由外部注入。模块只认"注入函数说该分块了，就 flush 上一轮 + 开新块"。

```js
// gateway 侧注入（即现在 isNewRound 原样搬入）
const server = new TurnStreamServer({
  historyFile,
  shouldStartNewBubble: (state, event) =>
    state.toolCalls.length > 0 && !hasExecuting(state.toolCalls)
    && (event.name === 'token' || event.name === 'tool_call'),
});
```

换项目：传"永远不分块"的恒 false，或自己的判定。

---

## 六、职责迁移对照

| 职责 | 现在 | 封装后 |
|---|---|---|
| 监听 agents 列表 → diff runningIds → 决定建/拆 | `useAgentSubscriptions` | `useAgentSubscriptions`（**hook 独有**：响应式看 agents 变化，client 进不来 React 做不了） |
| React 卸载时清理 | `useAgentSubscriptions` | `useAgentSubscriptions`（**hook 独有**：组件生命周期，client 不懂） |
| SSE 建连/断连（建拆时的动作） | `useAgentSubscriptions` 内部 `_startSubscribe/_stopSubscribe` | hook 调 `client.connect()/disconnect()`，**动作委派 client** |
| SSE 解析 + 2s 重连 | `useAgentSubscriptions` | `TurnStreamClient` 内部 |
| snapshot 单源重建 | `sseDispatcher` | `TurnStreamClient` 内部 |
| sealed 续接 + 新建 bubble | `sseDispatcher` | `TurnStreamClient` 内部 |
| raf 批处理 | `sseDispatcher._flushRaf` | `TurnStreamClient` 内部 |
| 写盘 + 多轮分块 | `private_room_stream` | `TurnStreamServer` 内部（判定由注入决定） |
| snapshot 去重+补全整轮 | `private_room_stream` | `TurnStreamServer.buildSnapshot` |
| 状态容器 | `agentStore` | `agentStore` 不变（onState 喂） |
| `/say` 路由 | `room_routes` | 不动（调 `server.startTurn` + `handleEvent`） |

---

## 七、测试锚定（先补测试，再封装）

封装是行为搬位置，必须先有测试锁住"搬之前=搬之后"。现状：后端只有 `private_room_stream.test.js` 2 个 case（只锚 compact 落盘+重连），前端无任何测试。#8 修过的多个 bug **没有测试覆盖**，封装时若手滑测试抓不到。

### 7a. 后端补测试（`test/private_room_stream.test.js` 扩充，调现有导出函数 + 读磁盘/snapshot 断言）

封装前先补 case 锚定每个修复点，确保封装后这些 case 仍绿：

1. **多轮分块落盘**：一次 turn 内 tool_call→tool_result→纯文本两轮，磁盘落**两条** assistant 记录（第1条 content="" + toolCalls 含 status，第2条纯 content）。防"全并成一条"回归。
2. **空 content 保时序**：assistant content 为空（只调 tool）也落一条，前端 `historyToTurns` 行序不错位。防"空跳过 guard"回归。
3. **tool 状态 executing→success/error**：`tool_call` 落盘 toolCalls 有 `status:'executing'`，`tool_result` 后磁盘同条记录该 tool 的 status 更新为 success/error + message。防"迁移漏掉更新"回归。
4. **snapshot 去重当前 turn user**：streaming 中 subscribe 的 snapshot，`turns` 不含当前 turn 的 user（被 pop），`activeTurn` 含。防"刷新 user 翻倍"回归。
5. **snapshot 补全整轮**：多轮中 subscribe（第1轮已落盘 A1 + 第2轮未落盘尾），`activeTurn.assistantBubbles` 含 A1（sealed）+ 尾 bubble。防"刷新残缺"回归。
6. **snapshot streaming 必带 activeTurn**：`startPrivateTurn` 后、首 token 前 subscribe，snapshot `activeTurn` 非空（空 bubbles），`streaming:true`。防"发消息→首 token 窗口刷新断 SSE"回归。
7. **首 token 前窗口**：6 的具体时点——`startPrivateTurn` 立即 subscribe，activeTurn 存在且 bubbles=[]。

这些 case 在封装前用**现状代码**写、跑绿（证明锚定当前行为）；封装后再跑，绿=一致。

### 7b. 前端补测试（新建 `test/` 下纯函数测试，不碰 React/DOM）

前端原生无测试基建。`vite build` 不跑测试。可行路径：把可测逻辑抽成**纯函数**，用 `node --test` 测（和后端同套）。

1. **`shared/turn-stream-contract.js` 纯函数单测**（`test/turn-stream-contract.test.js`）：
   - `shouldStartNewBubble(lastBubble)`：无 bubble→true、sealed→true、未 sealed→false。
   - `sealedBubble`/`openBubble`：产出字段正确（sealed 标记）。
   - `makeSnapshot`：形状 + 默认值。
2. **snapshot 重建抽纯函数单测**：把 `TurnStreamClient` 里"snapshot → {turns, activeTurn}"的映射抽成纯函数 `rebuildFromSnapshot(snapshot)`，配 `test/turn-stream-client.test.js`：
   - snapshot 到 turns/activeTurn 正确拆分。
   - 单源：historyLoaded 标记正确。
3. **sealed 续接抽纯函数单测**：token/tool_call/tool_result → 更新 activeTurn 的 reducer 抽纯函数 `applyStreamEvent(state, event, data)`，测：
   - 尾 bubble 未 sealed → token 续接到它。
   - 尾 bubble sealed → token 新建 bubble。
   - tool_call 加到尾 bubble、tool_result 更新其 status。

> React/hooks/store（`useAgentSubscriptions`/`agentStore`/raf 批处理）仍无单测——这些和 React 强绑定，不在纯函数测试范围。靠 `vite build` + 手动端到端 + `integration.test.js` 间接覆盖兜底。封装时这里风险最高，要格外小心。

### 7c. 锚定保证

- 封装前：7a 全绿（锚定现状）+ 7b 全绿（锚定纯函数行为）。
- 封装后：7a 全绿（行为不变）+ 7b 全绿（纯函数复用）+ 全量 `npm test` + `vite build` 通过。
- 任何 7a case 红了=后端行为漂了，必须修到绿才进下一步。

---

## 八、零 diff 保证

- **后端 snapshot 输出形状**：`buildSnapshot()` 复刻现在 `{turns, activeTurn, streaming, hasMore}`，去重 pop / 补全整轮 / 必带 activeTurn / sealed 标记全部逐行等价。
- **前端给 React 的状态形状**：`onState(turns, activeTurn, historyLoaded)` 产出结构 = 现在 store 里的，ChatPanel 渲染零改动。
- **落盘行为**：多轮分块 flush 时机 = 现在 `isNewRound`（原样注入），空 content 落盘、tool 状态更新、compact 锚定全复刻。
- **agent 层**：零改动。
- **群聊**：不加载模块，零影响。
- **其他功能**（skills/rewind/agent 列表）：不动。

---

## 九、实现顺序（建议）

**第 0 步（前置）：先补测试锚定现状。**
0a. 扩 `test/private_room_stream.test.js` 补 §7a 的 7 个 case（多轮分块/空 content/tool 状态/去重/补全整轮/必带 activeTurn/首 token 前窗口），跑现状代码全绿——证明锚定当前行为。
0b. 提前抽出 `shared/turn-stream-contract.js`（pure）+ `test/turn-stream-contract.test.js` 测纯函数；snapshot 重建 + sealed 续接先以纯函数形态抽出来 + 配 `test/turn-stream-client.test.js`（即便此时纯函数暂放 sseDispatcher 里、尚未封装，也能测）。
> 0 步全绿才进封装——它们是"搬之前=搬之后"的裁判。

1. 后端模块 `TurnStreamServer`：把 `private_room_stream` 的写盘/分块/状态/snapshot 拼装搬入，`shouldStartNewBubble` 由 gateway 注入（原 `isNewRound` 逻辑原样）。`private_room_stream` 保留为"调用模块"的适配层（不急着删，等验证通过再瘦身）。跑 0a + 全量绿。
2. 前端模块 `TurnStreamClient`：把 `sseDispatcher` 私聊的 snapshot/续接/raf + `useAgentSubscriptions` 的私聊连接/重连搬入，续接判定调 `shouldStartNewBubble`、snapshot 重建调 `rebuildFromSnapshot`、流式更新调 `applyStreamEvent`（这俩纯函数已在 0b 测过）。跑 0a + 0b + vite build 绿。
3. `useAgentSubscriptions` 改成 React⟷client 胶水（保留 agents diff + 生命周期，执行委派 client）。`sseDispatcher` 私聊分支移除（**先确认群聊无引用**再删；若有引用则保留群聊分支）。跑全量 + vite build 绿。
4. 全量测试 + 前端 build + 手动端到端（发消息→流式→刷新三阶段→rewind）验证零 diff。

**每步不破坏其他功能的守则**：
- 每步改完先跑全量 `npm test`（465 测试）+ 前端 `vite build`，绿了才进下一步。
- 后端改造时 `private_room_stream` 的导出函数签名(`subscribePrivateRoom`/`handlePrivateAgentEvent`/`startPrivateTurn`/`isPrivateRoomEvent`)保持不变——route 层 `room_routes.js` 零改动。
- 前端 `useRoomChat`(群聊) 全程不碰，确认 `sseDispatcher` 只移除私聊分支（群聊 SSE 是否也走 sseDispatcher? 实现时先查清，群聊分支若存在必须保留）。
- `agentStore` 的 store 接口(`_patchChat`/`loadHistory`/`loadMoreHistory`/`clearHistory`)不动，ChatPanel 渲染零改动。
- 任何一步若发现要动 agent 层 / 群聊 / skills / rewind，停下回来重新评估方案，不硬塞。

每步独立验证、可回滚。
