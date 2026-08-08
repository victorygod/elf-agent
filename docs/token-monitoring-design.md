# Token 消耗监控 — 设计方案

> 状态:设计稿,未实现。数据层为本(做扎实),前端为初版发挥设计(占位,后续按需求迭代)。分期见 §5。

## 1. 目标

- **聊天窗标题**:实时显示该 agent **累计消耗 token** 与**当前 context 占用 token**。
- **全局看板**:时间区间内**总量 + 按天柱状图**;**各 agent 占比环形图**,可选时间范围。

## 2. 现状速览(为什么要先修采集)

| 算的地方 | 算的什么 | 对吗 | 有人用吗 |
|---|---|---|---|
| 流式 LLM 调用用量 | prompt 恒 0;completion 数文本块数 | ❌ | 无人消费 |
| 非流式压缩调用用量 | 算了当场扔(`data.usage` 丢) | ❌ | 无人消费 |
| `done` 事件汇总用量 | prompt 填 context 体积;completion 恒 0 | ❌ 语义错 | 前端丢弃 |
| context 体积估算(`estimateTokens`) | 当前对话占多大 context | ✅ 准 | 仅压缩决策自用;前端只在压缩成功时闪现一次 |

**结论**:消耗数据现在是假且无消费方;context 体积算得准但缺一个对外的出口。所以监控 = 把消耗算对并接上出口,context 体积复用只加出口。elf-002 的压缩决策这套用 token 当闸门,是对的、在用的,**不碰**。

## 3. 数据层(本方案重心)

### 3.1 采集:把用量算对(改 `engine/models/llm.js`、`mock.js`)

- 流式 `chatStream`:请求体加 `stream_options:{include_usage:true}`,解析流末 `parsed.usage`。
- 非流式 `chat()`:改为 `return data` 并取 `data.usage`,return `{content, usage}`(当前直接丢 usage)。
- 用量口径:**provider 真实用量优先**;provider 不返回则 tokenizer 估算(prompt=`countMessageTokens(messages)`,completion=`countTokens(content)`)。
- `source` 字段标来源:`provider`(真实) | `estimate`(回退估算) | `mock`。不再用"块数"冒充 completion,不再 prompt 恒 0。
- Mock 模式产 `source:"mock"` 用量(无网也整链路自测)。

> 依据:elf-002 整套 compact 都信 `estimateTokens()` 口径,证明 tokenizer 估算站得住,回退路径可靠。

### 3.2 接线:记一笔 + 推前端(改 `engine/agent.js`、`message_manager.js`)

- `_runLLMStream` 收尾:拿到 `res.usage` → 调记录器记一笔 + `emit({event:'usage'})`。
- `_runCompactOnce` 收尾:`runCompact` 新增 `onUsage` 回调(replace 现有 onEvent/onDone 同链),透传压缩用量 → 记一笔 + emit,`phase:"compact"`。
- context 体积:同点取 `messageManager.estimateTokens()` 作为 `context_tokens` 随 usage 事件带出(算法不动,只加出口)。

### 3.3 删死路:done 不再背 usage(改 `engine/abort_flow.js`)

- `emitDone` 里那段 `{prompt_tokens, completion_tokens:0}` 语义错且前端从不读 → **删掉**(`done` 只保留 turn 结束语义)。遵循无向后兼容,不留死代码。用量改由 §3.2 的 `usage` 事件、单次调用粒度推送。

### 3.4 用量记录模型(`usage.jsonl`,append-only,对齐 history.jsonl)

`profiles/agents/<agentId>/usage.jsonl`,每行一条:

```jsonc
{
  "id": "u_<ts>_<rand>",      // 防重主键
  "ts": 1739000000000,        // 收尾毫秒时间戳
  "agentId": "elf-001",
  "roomId": "chat-elf-001",   // 私聊=chat-<agentId>;群聊=room_xxx;null=内部调用
  "userId": "default_userid", // 发起人(私聊归属);群聊 null
  "phase": "turn",            // turn | compact | compact-bottom
  "loop": "main",             // main | outline | render
  "iteration": 2,             // agent loop 第几轮
  "model": "gpt-4o",
  "prompt_tokens": 1234,      // provider 优先,否则 tokenizer 估算
  "completion_tokens": 567,
  "total_tokens": 1801,       // provider total 为准;缺则 prompt+completion
  "source": "provider",       // provider | estimate | mock
  "context_tokens": 5200,     // 收尾时 estimateTokens() 快照
  "aborted": false            // 中断也记一笔(estimate + aborted:true)
}
```

**统计维度** —— 记录已携带全部统计所需维度,读时按需 group,不物化多维 rollup、不膨胀存储:

| 维度 | 字段 | 口径 |
|---|---|---|
| 时间(天/小时) | `ts` | 按 tz 派生 `YYYY-MM-DD` / `YYYY-MM-DD HH` |
| agent | `agentId` | 直接 |
| 模型 | `model` | **历史真实调用模型**(非当前配置),换过模型可分开看 |
| 房间 | `roomId` | 备选(群聊分房) |
| 用户 | `userId` | 备选(P2 多用户) |
| 调用类型 | `phase` | turn / compact |

现需维度(时间/模型/agent)全部覆盖,无需新增字段。各展示位的维度组合见 §4.1 维度对照表。

### 3.5 持久化模块:UsageRecorder(新建 `engine/usage_recorder.js`)

- 职责单一:吃 record 对象 → append 写 `usage.jsonl` + 通知订阅者(供 SSE)。
- 注入 `{agentId, dataDir}`(走 `shared/profiles_paths.js`,与 history 同根)。
- 不依赖 agent 内部状态,不知道 SSE/HTTP。独立模块便于测试。

### 3.6 实时推送:SSE 新增 `usage` 事件

复用聚合 SSE 通道(`POST /subscribe`),新增事件:

```
event: usage
data: {agentId, roomId, prompt_tokens, completion_tokens, total_tokens, context_tokens, source, ts}
```

- 粒度=单次 LLM 调用(不复用 `done`:done 是 turn 级,且 compact 无 done 也要推)。
- usage.jsonl **不进 snapshot/rewind 范围**(`gateway/snapshot.js` 只管 history+runtime):token 是已发生事实,rewind 不回退用量。

### 3.7 聚合读取:UsageStore + 路由(新建 `gateway/usage_store.js`,改 `gateway/server.js`)

- 读所有 `profiles/agents/*/usage.jsonl` 流式累加到 `Map<day>` 和 `Map<agentId>`。
- **读时聚合,不物化 rollup**:数据量小(单 agent 日均几千条),全扫毫秒级;进程内 LRU 缓存,key=`(from,to,tz)`,文件 mtime 变化即失效。
- 路由(支持读时切维度):
  ```
  GET /usage/summary?from=&to=&tz=&bucket=day|hour&groupBy=model|agent
     → 全局(admin):KPI + 按维度聚合
  GET /agents/:id/usage/summary?from=&to=&tz=&bucket=day|hour&groupBy=model
     → 单 agent(agent config 模型配置 tab + 标题卡基线)
  ```
  - `bucket`:day(柱状默认)/ hour(分时柱状)。
  - `groupBy`:单 agent 视图默认 model;全局 dashboard 默认 agent,可切 model。
  - 同一聚合模块按 (bucket, groupBy) 组合 group,不物化。
- 返回结构:
  ```jsonc
  {
    "range": {"from":"2026-08-01","to":"2026-08-08","tz":"Asia/Shanghai"},
    "kpi": {"total":..,"prompt":..,"completion":..,
            "bySource":{"provider":..,"estimate":..,"mock":..},
            "peakDay":"2026-08-05","peakDayTotal":..},
    "byDay":   [{"day":"2026-08-01","total":..,"prompt":..,"completion":..}],
    "byAgent": [{"agentId":"elf-001","agentName":"..","total":..,"share":0.62}]
  }
  ```
- 权限:Dashboard 全局视图 `requireAdmin`(`server.js:87`);单 agent summary visitor 可读自己的。

### 3.8 elf-002 边界

- 压缩决策(单工具裁剪/预算/microcompact/全量压缩)用 token 当闸门,准、在用、是核心价值——**不动**。
- elf-002 无专属消耗计量,消耗走通用 `llm.js`;§3.1 修了非流式 `chat()`,elf-002 压缩消耗自动补上,**无需碰 elf-002 任何文件**。
- "压缩省了多少 token"不纳入监控口径(省是体积账,不是消耗账)。

### 3.9 边界情况

- **中断(partial)**:`aborted:true` 照记,source=estimate(prompt 用 messages,completion 用 partial.content),保总账闭合。
- **重试**:`withRetry` 内中间失败不记(没花 completion);耗尽抛错不记,可记现有 `notice`。
- **rewind**:用量不回退;前端"累计"重连/rewind 后强制拉 `GET /agents/:id/usage/summary` 重定基线。
- **时区**:前端传 `Intl.DateTimeFormat().resolvedOptions().timeZone`,后端按本地 `YYYY-MM-DD` 分天。
- **多用户**:P1 Dashboard 为 admin 平台视角(按 agent 聚合,不按 user 拆);单用户私聊视角按 userId 过滤留 P2。
- **群聊**:一次调用记在该 agent + roomId 下,不分摊成员。

### 3.10 测试(全量串行,见 memory)

- `test/usage_recorder.test.js`:写盘/append/aborted/订阅通知。
- `test/usage_store.test.js`:多 jsonl 聚合、时间范围、缓存 mtime 失效。
- `test/llm_usage.test.js`:mock fetch 带/不带 usage chunk,断言 source 与回退。
- `test/agent_server.test.js` 加 case:跑一轮 mock 对话 → `usage.jsonl` 落盘 + 收到 `usage` 事件。

## 4. 前端层(初版发挥设计 — 后续按需求迭代)

> ⚠️ 本节为初版占位设计,作者自行发挥,非最终需求。先留好位置与数据通路,UI 后续根据实际使用不断改。

### 4.1 标题卡 token 显示

- 后端出口已就绪:`usage` SSE 事件 + `GET /agents/:id/usage/summary`(基线)。
- 前端:stores/agentStore 加 `usage:{cumulative, context}` 字段,订阅 `usage` 事件累加 `cumulative += total_tokens`,记 `context=context_tokens`。
- 展示组件 `UsageBadge`(共享):Sidebar agent 列表项为主落点(已有 name/path/status,旁加一行 `⚡1.8k · ctx 5.2k`);ChatPanel 顶部可加细 header。
- 格式:`<1000` 原值,`≥1000` 用 `1.8k/23.4k/1.2M`;context 附占 memoryTokenLimit 百分比(超阈值变橙红,提示"快压缩")。
- 刷新:实时随 `usage` 事件;初次打开/切 agent 拉基线;rewind 后重拉基线。

### 4.2 看板类视图(发挥设计 — 后续按需求迭代)

> ⚠️ 本节为初版发挥设计,非最终需求。共用聚合 API,仅 `groupBy`/`bucket` 不同。

维度对照:

| 展示位 | 时间 | 模型 | agent | 数据接口 |
|---|---|---|---|---|
| 标题卡 | — | — | 单 agent 累计 | SSE + `/agents/:id/usage/summary`(无 group) |
| **单 agent 消耗图**(agent config「模型配置」tab 下) | 天/小时 | ✓ | 固定该 agent | `/agents/:id/usage/summary?groupBy=model&bucket=day\|hour` |
| **全局 dashboard**(设置入口,admin) | 天/小时 | ✓ | ✓(额外维) | `/usage/summary?groupBy=agent\|model&bucket=day\|hour` |

**单 agent 消耗图**(agent config 的模型配置 tab 下,发挥):柱状图分天/分时(bucket 可切),按模型着色/堆叠,配时间范围选择;帮用户看"这个 agent 各模型每天花多少"。

**全局 dashboard**(发挥):

- 入口:`settingsView:'dashboard'`(设置 modal 内加按钮,与 LLMManager 同级),admin 可见。elf 前端是轻 hash 无路由框架,沿用子视图最省;不顺手再改独立入口。
- 顶部:时间范围选择器(今日/7天/30天/本月 + 自定义),两图共用,默认最近 7 天。
- KPI 卡:区间总量 Σ、日均、峰值日;另标 `bySource` 估算占比(诚实可观测)。
- 日总量柱状图:X=天/小时,Y=total;可切 prompt/completion 堆叠;可比 agent 分组或按 model 着色;零值天留空位保时间轴连续。
- 各 agent 占比环形图:按 agent total 占比(纯 agent 维度);点某段下钻→下方表格列该 agent 区间逐天明细。可按 phase 切换(turn vs compact)。

### 4.3 图表包(待确认)

- 现状:前端无图表库、纯亮色主题。
- 推荐 **Recharts**(成熟模式,~100KB,声明式),覆盖柱状+环形+堆叠+tooltip。
- 备选:手撸 SVG(0 依赖但交互易碎)或 ECharts(过重)。
- **待定**:是否同意加 Recharts。

### 4.4 待确认决策点(前端迭代时逐条定)

1. 两图联动共用时间范围 vs 各自独立 — 推联动。
2. 环形下钻:表格 vs 再一张图 — 推表格。
3. 估算占比是否显式标注 — 推显式(防误读为精确)。
4. 零值天:留空位 vs 不显示 — 推留空位。
5. 看板入口:设置 modal 内 vs 侧边栏独立图标 — 暂定设置内,可改。
6. 单 agent 详情是否需要独立页 — 暂不需要,下钻表格够。

## 5. 实施分期

- **P1 数据层闭环(必做扎实)**:§3.1 采集 → §3.5 recorder 写盘 → §3.2 接线 + §3.6 SSE → mock 自测绿。此期消耗数据真实可信且已落盘/SSE 出口就绪,前端可随时接。
- **P2 标题卡**:§4.1,前端接 `usage` 事件 + 基线 API,标题卡显示累计/context。
- **P3 看板**:§3.7 聚合 API → §4.2/4.3 看板页(确认 Recharts 后实现)。

## 6. 改动清单

| 层 | 文件 | 动作 |
|---|---|---|
| 采集 | `engine/models/llm.js` | 流式加 `include_usage`+取 usage;非流式 return usage;回退 tokenizer+source |
| 采集 | `engine/models/mock.js` | 产 `source:"mock"` usage |
| 接线 | `engine/agent.js` | LLM/压缩段收尾 record+emit `usage`;带 context_tokens |
| 接线 | `engine/message_manager.js` | `runCompact` 加 onUsage 透传 |
| 删死路 | `engine/abort_flow.js` | `emitDone` 删假 usage 字段 |
| 持久化 | `engine/usage_recorder.js` | **新建** record 写盘+通知 |
| 聚合 | `gateway/usage_store.js` | **新建** 读 jsonl 聚合+缓存 |
| 路由 | `gateway/server.js` | 加 `GET /usage/summary`、`GET /agents/:id/usage/summary` |
| 前端-store | `frontend/src/stores/agentStore.js`、`sseDispatcher.js` | `usage` 事件分支+累计 |
| 前端-API | `frontend/src/api/index.js` | `getUsageSummary`/`getAgentUsageSummary` |
| 前端-标题 | `UsageBadge.jsx`(新) | Sidebar/ChatPanel 插入 |
| 前端-看板 | `Dashboard.jsx`+css(新) | 两图+时间范围(P3) |
| 前端-入口 | `Sidebar.jsx` | settingsView 加 dashboard |
| 依赖 | `frontend/package.json` | 加 `recharts`(P3,待确认) |
| 测试 | `test/usage_*.test.js` | 新建(串行) |

## 7. 用户反馈与待办诉求(P1-P3 实现后)

> 以下为使用后反馈,待实现。逐条记现状/根因/拟方案。

### 7.1 ctx 刷新后全没
- 现状:标题卡 `context` 仅来自 SSE `usage` 事件的 patch(`sseDispatcher case 'usage'`)。`loadUsage` 只拉 `cumulative`(kpi.total),**不补 context**。刷新页面后 usage Map 重建,context 字段空 → ctx 显示 — 或隐藏。
- 方案:context 改独立来源(见 7.3 直读 context.json),不依赖 SSE usage patch;刷新重拉不丢。

### 7.2 ctx 不实时、滞后慢
- 现状:context 仅在 **LLM 调用收尾**(`_recordUsage`)emit 一次。用户发消息→LLM 回完才更新;对话进行中 / 工具执行中不更新 → 滞后。
- 方案:见 7.3。

### 7.3 提议:直接读 context.json(采纳)
- 事实:`messageManager._save()` 在每次 messages 变(加 user/assistant/tool 结果/压缩)都**全量写** `profiles/agents/<id>/rooms/<rid>/context.json`(`message_manager.js` 多处 `_save()` 已验证)。故 context.json **实时反映**当前 context window。
- 方案:gateway 加只读 `GET /rooms/:rid/usage/context?agentId=` → 读 `agentRoomState(agentId, roomId)/context.json` → `countMessageTokens(messages)` 返回实时 token。前端标题卡 context 来源改此接口:
  - 定时轮询(如 3s)+ 发消息/工具结果后触发拉取;或
  - 后端 watch context.json mtime 变 → 经聚合 SSE 推 `context` 事件(更实时,加 fs.watch)。
- 复用 `shared/tokenizer.countMessageTokens`,口径与 `estimateTokens()` 同源。
- **刷新不丢**(独立 HTTP 来源,重拉即有)、**天然规避 elf-018 两 loop**(见 7.4)。

### 7.4 elf-018 两 loop
- 事实:elf-018 多 loop 共享同一 `messageManager`(同一 messages 数组),`estimateTokens()` 是整体体积,不按 loop 拆。
- 结论:**直读 context.json 天然不受 loop 影响**——context 就是 messageManager 当前 messages 体积,两 loop 共享同一份。标题卡显示整体即可,不需按 loop 拆。

### 7.5 群聊只在 sidebar 群聊项显示该群 token 总量
- 现状:群聊消耗已落 `record.roomId`(群聊 room_xxx / 私聊 chat-<uid>-<id>),但展示层无群聊维度(Sidebar UsageBadge 是 agent 全量;Dashboard 仅 agent/model)。
- 方案(简化,**不做单群图**):UsageStore 加 `roomSummary(roomId)` 扫所有 agent 的该 roomId 记录聚 total;Sidebar 群聊项(`rooms` 区段)挂 `RoomUsageBadge`(显示该群总量,`loadRoomUsage` 拉基线)。不做 ConfigDrawer 群聊图、不做事件,最小满足"群聊项看总量"。

### 7.6 usage record userId 为何 null
- 根因:`_recordUsage` 用 `this.runContext?.userId`,但 **`buildRunContext` 根本没有 userId 字段**(返回 agentId/mode/port/dataDir/roomId/memberName/roomBusUrl,无 userId)。故 userId **恒 null**。
- 方案:`buildRunContext` 加 `userId` 参数;各 `create_agent.js` / 副本启动注入:
  - 私聊:uid 从 `privateRoomId`(chat-<uid>-<id>)解析,或 gateway 启动 agent-server 副本时透传。
  - 群聊:userId 记该次调用触发者(若可得)或 null(群聊无单一发起人,可接受 null)。
- 影响:userId 当前只落盘不消费(Dashboard P1 是 admin 平台视角不按 user 拆)。修了才支持 §3.9 多用户私聊视角(P2)。

### 7.7 缓存命中 / 输出维度没展示
- 现状:record 已落 `cached_tokens`/`reasoning_tokens`/`cache_creation_tokens`/`prompt_tokens`/`completion_tokens`(provider 返回则填)。但展示层:
  - UsageBadge 仅 `cumulative`(total)+`context`,不显细分。
  - Dashboard KPI 显 prompt/completion,但**不显 cached/reasoning**。
- 方案(数据已在,仅补展示):
  - Dashboard KPI 加"缓存命中 N(占 prompt X%)"、"其中推理 N"。
  - UsageBadge hover tooltip 显细分,或单 agent 详情展开 reasoning/cached(默认折叠,§4 已定)。