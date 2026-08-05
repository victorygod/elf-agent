# elf-018 右侧面板刷新解耦改造

> 状态:设计文档(尚未实施)。收到指令后据本文落地,不进 plan。
> 关联:`docs/dm-frontend-game-state.md`(game-state API 初始设计)、`docs/elf-agent-ui-design.md`(bridge / agent UI 架构)。

## 一、背景与目标

聊天流式输出时,右侧游戏状态面板有两类问题:

1. **高频无谓渲染**:流式每个 token 帧都让整棵右侧面板重新 reconcile,且每帧发一次 `GET /game-state` 请求(还伴 `loading` 闪烁)。右侧面板数据在流式期间实际不变,纯属浪费。
2. **刷新机制错误寄生**:面板"整轮结束更新 lore"的真实实现,寄生在"bridge 每帧重建 → loadState 每帧重跑"这个副作用上;而设计上本该触发的 streaming-edge 是死代码。

**目标(已确认方向)**:

- **解耦**:面板刷新与聊天区更新解耦。token 高频更新只影响左侧 ChatPanel,不拖右侧面板;流式期间不再每帧拉 game-state。
- **时刻反映真实文件**:面板始终反映 `runtime/lore/` 真实文件状态。在"确实改了文件的信号点"重新拉 game-state,而非每帧盲拉。
- **metadata 自动正确**:metadata 随 game-state 拉取现算,不单独做触发机制。

## 二、现状诊断(基于实代码)

### 2.1 高频渲染与每帧请求的根因链

```
sseDispatcher.js                token 每帧 rAF flush → _patchChat
agentStore.js:160-166           _patchChat 每次 new Map(chats) → set({chats})  【chats 每帧新引用】
useBridge.js:18                 const chats = useAgentStore(s => s.chats)     【整表订阅】
useBridge.js:96                 useMemo(..., [agentId, chats, ...])           【chats 变 → bridge 每帧新对象】
AgentPageRenderer.jsx:16,51     useBridge → <Component bridge={bridge}>       【父每帧重渲染,传新 bridge】
DnDChatView/index.jsx:60        loadState = useCallback(..., [bridge])        【bridge 每帧新 → loadState 每帧新引用】
DnDChatView/index.jsx:62        useEffect(() => { loadState(); }, [loadState])【loadState 变 → effect 每帧重跑】
                                → 每帧调 loadState() → 每帧 GET /game-state(+ setLoading(true) 闪烁)
DnDChatView/index.jsx:90-131    右侧 sidePanel 与左侧 ChatPanel 同处一个组件 → 每帧整树重渲染
```

关键:`loadState` 的 `useCallback` 依赖 `[bridge]`,而 `bridge` 流式时每帧重建,使 mount-effect 实际上每帧重跑——这才是面板"会更新"的真实手段(不是设计意图的"整轮结束刷一次")。

### 2.2 streaming 字段:后端发、前端漏接,streaming-edge 成死代码

**后端是活的**(`gateway/turn-stream-server.js`):

- `:123` `st.streaming = true`(startTurn)
- `:201` `st.streaming = false`(turn 结束)
- `:255` snapshot 事件返回 `streaming: st.streaming`,随事件发前端

**前端漏接**(`frontend/src/stores/sseDispatcher.js` snapshot case):

```js
const rebuilt = rebuildFromSnapshot(data);   // turn-stream-client-core.js:35 算出 streaming: !!streaming
_patchChat(agentId, {
  turns, activeTurn, historyLoaded, hasMore,
  // ← 漏传 streaming: rebuilt.streaming
});
```

前端 `chat.streaming` 仅有 `false` 写入点(`agentStore.js:129,163`、`sseDispatcher.js:100`、断连 `useAgentSubscriptions.js:40`),**无任何 true 写入** → 恒 `false`。

→ `bridge.streaming` 恒 `false` → `DnDChatView/index.jsx:65-70` 的 `if (prevStreamingRef.current && !bridge.streaming)` 中 `prevStreamingRef.current` 恒 `false` → **loadState 永不由此边沿触发 = 死代码**。

界面仍正常的原因:`ChatPanel.jsx:180` `const isStreaming = activeTurn !== null`,判断"正在回复"用的是 activeTurn,不读 `chat.streaming`。所以死的只是 streaming 字段本身和那个 edge effect,无人感知。

### 2.3 lore 谁写、何时写

- **outline loop**(`agents/elf-018/agent.js:47-58`,`disableTools: []` 全工具开):
  - `WriteOutline` → 写 `outline/round-N.md`(大纲)
  - `Write`/`Edit`(lore 专版,`tools/Write.js:30` `isInsideLore` 守卫 + `:65` writeFileSync)→ 写 lore 下设定卡 / `user_profile.md` / `state.md`
- **render loop**(`agent.js:60-64`,`disableTools: null` → `:104-106` 禁全部工具):
  - 只 `_runLLMStream` 流式生成正文 + 落 `scene/round-N.md`(`:206`),`loop_render_prompt.md:25`"不调用任何工具"
  - **render 不写任何 lore 文件**

结论:lore 只在 outline 阶段被写;render 阶段(流式正文)不改 lore。所以"文件可能变化的时机"= outline 阶段的写类工具执行,而非 token 流。

### 2.4 metadata 机制(澄清:无独立触发)

`buildMetadata(loreDir)`(`shared/agents/elf-018/buildMetadata.js:15-62`)是纯函数,每次调用现扫 lore 五类目录 + `user_profile.md` + `state.md` 的 frontmatter(name/description),无缓存。`GET /game-state` handler(`agents/elf-018/ui/api.js:86`)每次请求调一次 `buildMetadata` 现算。

因此:**metadata 没有"文件改→自动触发"的独立机制,它寄生在 game-state 拉取上**。只要前端在文件改后重新拉一次 game-state,metadata 自动反映最新(无需为 metadata 单独接线)。

## 三、改造方案

总原则:右侧面板订阅"文件可能变化的信号"触发 `loadState`,不订阅 token 流;UI 与数据源的绑定关系不变(React state → JSX)。

### 3.1 解耦:sidePanel 与 loadState 稳定化

**a. 抽 SidePanel 子组件 + React.memo**

将 `DnDChatView/index.jsx:90-131` 右侧整段抽成 `<SidePanel state={state} loading={loading} />`,用 `React.memo` 包裹。props 只传 `state`/`loading`,**不传 bridge**(流式期间 `state`/`loading` 引用稳定,memo 生效;bridge 每帧变会破 memo)。DnDChatView 自身仍可能每帧重渲染(父传新 bridge),但 memo 使 sidePanel 子树跳过 reconcile。

**b. loadState 去 `[bridge]` 依赖**

```jsx
const bridgeRef = useRef(bridge);
bridgeRef.current = bridge;                       // 每 render 赋,不触发重渲染
const loadState = useCallback(() => {
  setLoading(true);
  bridgeRef.current.call('GET', '/game-state')
    .then(setState).catch(() => setState(null)).finally(() => setLoading(false));
}, []);                                            // 空依赖 → 引用稳定
```

mount-effect(`:62`)依赖稳定后只跑一次,初始化拉取。

**c. 删 streaming-edge 死代码**(`:65-70`)。

### 3.2 正确的刷新触发(替代"寄生每帧")

采用基于 `activeTurn` 的两层信号(均每 turn 必发、不依赖 snapshot 推送时机):

**信号 ①(保底):turn 结束 —— `activeTurn` 有→null**

- `done` → `finalizeActiveTurn`(`sseDispatcher.js:133`)→ `_patchChat({ activeTurn: null })`
- DnDChatView 订阅 `activeTurn`,用 ref 记 prev,`prev && !cur` 时 `loadState()`
- 保证整轮结束面板必为最新(覆盖正常 done 与 abort 两条收尾路径)

**信号 ②(增强,接近"时刻"):写类工具完成**

- 订阅 `activeTurn.assistantBubbles` 内 toolCalls,检测写类工具(`Write`/`Edit`/`WriteOutline`/`EditOutline`)的 toolCall 从 `executing`→完成且成功时 `loadState()`
- 用 `Set` 记已触发 loadState 的 toolCall id,防重复
- 效果:outline 写完 lore 当场刷,不必等 render 跑完

**为什么 token 流不触发**:token 走 `applyToken` 只改 bubble.content,不产生新的"写类 toolCall 完成"边沿,也不使 activeTurn→null。所以 render 正文流式期间面板不拉——正好解耦。

两个信号都靠订阅 `activeTurn`(它在 token 帧也会变新引用,但 effect 体只做 O(1) 比较 / toolCall 边沿检测,不发请求;仅在边沿成立时才调 `loadState`)。

### 3.3 metadata:无需改动

`buildMetadata` / `game-state` handler 保持不变。3.2 任一信号触发 `loadState` 后,metadata 随 game-state 响应现算,自动正确。不为 metadata 写任何触发逻辑。

## 四、改动清单

| 范围 | 文件 | 改动 |
|---|---|---|
| 必做 | `agents/elf-018/ui/DnDChatView/index.jsx` | ① loadState 去 `[bridge]` 依赖(bridgeRef);② 删 `:65-70` streaming-edge;③ 订阅 activeTurn,加 done 边沿 + 写类 toolCall 完成边沿触发 loadState;④ 抽 `<SidePanel>` + `React.memo`,props 仅 state/loading |

必做层全部封闭在 elf-018 自身 UI,不碰 SPA 公共代码、不碰后端,风险可控。

### 可选层(进一步降频,改动面大,建议后续单独评估)

| 范围 | 文件 | 改动 | 代价 |
|---|---|---|---|
| 可选 | `frontend/src/hooks/useBridge.js` | bridge 的 `turns/activeTurn/streaming` getter 改读 `useAgentStore.getState()`(不闭包 chats),`useMemo` 去掉 `chats` 依赖 → bridge 引用稳定 | DnDChatView 须从"render 时读 getter"改为"显式订阅",否则 bridge 静默后收不到 activeTurn 变化(hasHistory 切换 / 刷新信号断)。需扩展 bridge API(激活死接口 `bridge.onEvent` 或加细粒度订阅),改动面大 |
| 可选 | `frontend/src/stores/sseDispatcher.js` | snapshot case 补传 `streaming: rebuilt.streaming`(顺手修 2.2 漏传) | 仅 snapshot 时机生效(snapshot 不在每 turn 推),不解决流式中刷新;属一致性修复 |
| 可选后端 | `gateway` / 工具执行层 | lore 写盘后推 `lore_changed` SSE 事件,sidePanel 订阅 | 最语义化的"文件改→刷",覆盖非工具的文件改;需后端改动 |

## 五、风险与注意事项

- **漏更**:信号 ② 的写类工具清单须完整(`Write`/`Edit`/`WriteOutline`/`EditOutline`);未来新增写 lore 的工具要同步加入。可用"任何 tool_result 成功即 loadState"作为更保守的实现(代价:Roll 等非写工具多触发一次拉取,可接受)。
- **重复拉**:toolCall 边沿必须用 id 去重(Set),否则同一工具完成会被多帧重复触发。
- **可选层风险**:稳定 bridge 后,DnDChatView 失去"靠父每帧渲染间接响应"的便利,所有它依赖的信号(hasHistory、刷新)必须显式订阅;漏订即静默不更新。建议必做层先落地并验证,可选层另起评估。
- **不改**:game-state handler、buildMetadata、outline/render workflow、SSE 事件协议(可选后端除外)。

## 六、验证要点

实施后应观察:

1. 流式输出期间右侧 sidePanel 不再每帧 reconcile(React DevTools Profiler);Network 不再每帧出现 `/game-state` 请求。
2. outline 阶段 `Write`/`Edit` 写完 lore 后,面板即刻出现新设定(信号 ②);整轮 done 后面板为最终态(信号 ①)。
3. metadata 与 lore 各项同步更新(无单独操作)。
4. 中断(abort)/回退(rewind)路径面板仍能收敛到正确态(activeTurn→null 边沿覆盖 abort 的 finalize)。
