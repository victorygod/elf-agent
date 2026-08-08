# 进程内多 Agent 宿主(本地合并 v1)

> 状态:目标 + 本期(本地)方案 + 现状适配。**远端为后续阶段,仅留设计空间**。日期:2026-08-04。

## 一、目标

1. **收敛端口**。当前每个 agent 一个独立进程、一个 TCP 端口(`ProcessManager` detached spawn,N 个 80xx 端口)+ 群聊副本进程,端口占用面大、易冲突、cleanup 重。**目标:把 agent 侧端口数从 N 压到 1+M**(M=agent-server 数),与 agent 总数解耦。
2. **gateway ↔ 多 agent-server 平等路由**。gateway 把所有 server 内的 agent 视作**扁平、平等的 agent 池**,原子单位是 agent(全局唯一 agentId),server 只是承载/通信管道;通信按 **(agent-server, agentId)** 寻址。前端 `/agents` 是平铺列表,不暴露 server 划分。

## 二、阶段划分(关键解耦)

- **本期 = 本地合并**:gateway + M 个**本地** agent-server,gateway **拨每个 server 的端口**(A 模型),`fetch` + SSE **全保留,零传输改动**。端口 N→1+M。
- **后续 = 远端(仅留空间,本期不做)**:remote agent-server 需**反向连接**(优先 SSE+POST,WS 可选)+ 共享盘迁移。
- **为何解耦**:主诉1(端口)本地即可达成且不动传输;远端才是大工程。把两者捆 together 会强制引入 WS / 反向通道 / 跨盘迁移,本期不必付。

## 三、已确认约束

- **agent-server 一等公民,可多个**。每进程内 `Map<agentId,Agent>`(in-process 多 agent);并存 M 个;端口数 1+M,M 可低至 1。
- **gateway 与 agent-server 独立,gateway 做看门狗**。server 可独立重启;某 server 崩不拖垮 gateway。前端只连 gateway 8080,改造对前端零感知。
- **gateway 维护 agentId → server 路由表**,扁平路由;agent 全局唯一、平等。
- **agentId 全局唯一,重名即配置错误**。身份 = 单一记忆拥有者:同一 agentId 只能由一个 server 承载(否则两盘各一份 `profiles/agents/<id>/memory`,身份分叉)。故 agent-server `connect` 上报 `agentIds[]` 时,gateway **逐个查路由表,已被他 server 占有的 agentId 拒收**,错误明确指向"已被 serverX 占有",fail-fast。重名现实来源:同一 `agents/<id>/` 目录被多 server 挂载,或不同 config 目录都写了同一 agentId(改漏)。若将来要把同一 agent 的 room 实例分片到多 server,需把路由键从 agentId 升为 `(agentId, roomId)→server` 并解决跨盘记忆一致性——属另一种姿态,本期不做(见 §八)。
- **实例路由键须复合 (agentId, roomId)**。现状一进程只住一 agent,实例 `Map` 以 `roomId` 为键、agentId 隐式取自进程身份(`server.js`/`start.js`)。多 agent 共处一 server 后此假设破裂:同一群的两个共处成员会因 `Map<roomId>` 碰撞 alias 成同一实例。故承载层须显式化 agentId:复合键 + event payload 补 `_agentId` + dataDir 由实例 agentId 拼 `profiles/agents/<agentId>/rooms/<roomId>` + 群聊 observe body 显式带 agentId。私聊(`roomId=chat-<agentId>`)已编码 agentId 天然不撞,主要落在群聊共享成员。
- **预留接缝**:agent-server 是可独立重启的被监督进程这一结构性事实保留,本期不实现 agent 自更新/回滚,但所选架构不得使其后续叠加需推翻返工。
- **物理/逻辑分层(总原则)**:物理上 gateway 仍直连 agent-server(fetch/SSE),建连、重连、SSE 多路复用这些实现要靠谱;**逻辑上淡化 agent-server**——agent 全平级,不按"在哪个 server"区分,server 只是 agent 身上的 `port` 属性、不是一等概念。事件/路由一律 agent 标签(`_agentId`)平铺,不按 server 分组。

## 四、本期方案:本地合并

### 4.1 拓扑(A 模型,SSE 保留)

```
前端 ──(HTTP/SSE, 8080)──► gateway ──(fetch + SSE,每server一端口)──► 本地 agent-server × M
```

transmission 全程不变:gateway 仍 `fetch http://127.0.0.1:${serverPort}/...`、仍 subscribe 各 server 的 `/events` SSE。

### 4.2 改动点(有界,主要碰承载与生命周期)

- **server.js**:实例 `Map<roomId>` → **`Map<agentId, Map<roomId, RoomState>>`**(嵌套,镜像"agent 拥有若干 room"层级);`/observe`、`/abort`、`/clear`、`/reload` 按 (agentId, roomId) 取实例;`/events` 的 event payload 补 `_agentId`;dataDir **私聊用 `agentMemory(<id>)`(对齐 snapshot/rewind 记忆源)、群聊用 `agentRoomState(<id>,<rid>)`(同群共处成员不串目录)**。**RoomState 显式带 `agentId` 字段**(镜像复合键,供路由/日志/event 标签直接取,不再 dig `runContext`)——`createRoomState` 已收 agentId 参数,只需返回对象补这一个字段。不动 `profiles/agents/<id>/rooms/<rid>` 布局。
- **observe body 显式带 agentId**(群聊):gateway 的 `postObserve(agentId, payload)` 现已持 agentId,只需写入 body;server 据此取实例。私聊仍靠 `chat-<id>` 编码,免改。
- **agent_events**(物理连 server、逻辑按 agent):gateway 物理上只跟目标 server 建一条 `/events` SSE(M=1 即 1 条,取代现状 N 条 per-agent);但流过来的事件**全部带 `_agentId`**,gateway 按 agentId 平铺路由到前端聚合流,**不按 server 分组**。连接建立/重连是底层管道的实现细节,不暴露成分组 agent 的依据。
- **room 副本入进程**:`room_bus.spawnReplica`(spawn `start.js --mode room`)+ `start.js` room 模式 spawn + `run.json` **删除**;成员实例转为目标 server 内的 RoomState(观察式懒建)。`room_bus` 已有"有 pm 时复用 pm.startAgent 不再 spawn"的 v3 路由,本次是收尾:去掉 spawn 兜底 + RoomState 带 (agentId,roomId)。
- **`ProcessManager` 保持 agent 为中心**(淡化 server 概念):不引入一等的 `AgentServerRegistry`;`ProcessManager` 仍是 `Map<agentId, {port, pid, status, config, ...}>`,**server 只是 agent 身上的 `port`/`pid` 属性**。M=1 下所有 agent 的 `port`/`pid` 指向**同一个**进程(那个装全部 agent 的 server),`getAgentPort(agentId)` 即返回该共享 port——从 gateway 视角看是"agent 自带的 port",恰好共享。`start agent X` = 确保共享 server 在跑(`ensureServerUp`,**串行化**:并发 startAgent 共享同一次 spawn,防 EADDRINUSE 竞态)+ 标记 X 启用;`stop agent X` = **禁用 X(server 不杀,别的 agent 还在用**;只有全局停 server 才杀进程)。**重启恢复靠 `probeServer` 探测 detached 残留 server**(不落盘注册表);cleanup 杀进程靠 `gateway.json:agentServerPort` + grep `engine/start.js`(覆盖共享 server + 旧 `--mode room` 残留 + standalone)。
- **`cleanup.sh`**:删"扫 `agents/*/config` N 端口 + grep `--mode room` + run.json 兜底",改"读 server 注册表 → 杀 M 个 server 进程(端口兜底)+ 杀 8080"。
- **不动 `fs.watch`**(本期)。此前怀疑的"`config.json` 半写→`fs.watch` 触发 `reloadConfig`→`JSON.parse` 崩"路径**未在日志中得到证实**(grep `reloadConfig|JSON.parse|配置加载失败|Unexpected token|SyntaxError` 全部零命中);日志里实际可见的重复错误只有 `agent_events` 的 `/events` 5s 重连风暴(agent 进程不在线所致),与 config 热加载无关。根因未证实则不预改——不靠 debounce/原子写/try-catch 去修一个也许不存在的 bug(见下原则)。`fs.watch` 是 config 热更新的现有传播机制(`PUT /agents/:id/config` 写盘后无显式 reload 端点,靠 watch 让 agent 进程 reload),本期保留现状。若要查"崩盘",先复现/查日志定位真因,再对症。

### 4.3 在线语义(两层:server 级 + 实例级)

**注册 ≠ 实例化**:启动只读各 agent 的 config 元信息(名/头像)做 `/agents` 列表,Agent 对象**首条消息才 materialize**。保留懒起成本优势。

**"在线" = 能收消息**,不等于"实例已在内存":agent 在线 ⟺ (agent-server 进程在跑) + (该 agent 启用)。实例按需懒建。

**`agent.status` 三态 + 两层错误区分**(共享 server 后必须分清,影响面不同):

| 状态 | 含义 | 错误来源(分清) |
|---|---|---|
| `running` | server 在跑 + agent 启用(实例可能未 materialize,但能收消息 = 在线) | — |
| `error` | 实例级:**该 agent 实例化失败**(bad config / 缺 create_agent.js / 提示词错) | 只影响这一个;错误明确指名 agent + 原因;兄弟 agent 仍 `running` |
| `server-down` | 进程级:**agent-server 起不来**(EADDRINUSE / 缺 agents/ / bootstrap 错) | 它名下**所有** agent 全标 `server-down`;错误指名 server + 原因 |

- **实例失败不拖死 server**:`createRoomState` 抛 → `/observe` 返 500 + "agent <id> 实例化失败: <原因>";server 存活、兄弟 agent 不受影响。**catch+上报 ≠ 吞错掩盖**(掩盖是吞了当没发生);与 §七"不吞错"原则一致——错误显式上送给 gateway 标该 agent `error`。
- **server 失败全员躺**:ProcessManager spawn 捕获 → 标 server `error` → 名下 agent 全派生 `server-down`(由 server 状态推导,不逐个探活)。
- **群聊同套**:群成员在线 = 其 server 在跑 + 启用;observe 失败走 `room_bus` 现有 `_onAgentOffline` 标该成员离线。无群聊专属在线概念。
- `start agent X` = 确保 server 在跑 + 标 X 私聊实例启用;`stop agent X` = 标 X 私聊实例禁用 + 中断在飞私聊回合(`/abort chat-<id>`)。**私聊实例与群聊实例独立生命周期**——私聊 stop 不碰群聊实例(群聊由群成员退订管),群聊拉活不碰私聊 enable。全局停 server 才杀进程。UI 文案:`启动实例`/`停止实例`(不再是"启动/停止服务"——服务是共享 server,非 per-agent)。

## 五、现状功能适配(本期本地)

| 类 | 现状 | 本期 | 成本 |
|---|---|---|---|
| 控制 fetch(observe/abort/clear/reload/status/shutdown) | gateway 拨 agent 端口 | 拨 **server** 端口;observe 带 agentId;余同 | ✅ 几乎不变 |
| `/events` SSE(agent→gateway) | N 条 per-agent | M 条 per-server,事件带 `_agentId` | ✅ 连接更少 |
| agent→gateway(Speak/notice/sync、LLM 直连模型) | POST gateway / 直连模型 | 不变 | ➖ |
| 前端面(`/agents` `/rooms/*` `/subscribe` `/skills` `/settings`) | HTTP/SSE @ 8080 | 不变(外部契约零改) | ➖ |
| 共享盘(snapshot/config_store/skill_store/avatar/DM state) | gateway 直读直写 agent 盘 | **本期同盘照旧** | 🔨 本期不碰,延后远端 |
| `ProcessManager` / `cleanup.sh` | N 端口 + 副本 + run.json | M server 注册表 | 🔨 |
| room 副本 spawn | `start.js --mode room` | 进程内 RoomState(删 spawn) | 🔨 |
| `Map<roomId>` 单 agent 假设 | `server.js` | 复合键 (agentId,roomId) | 🔨(§三) |
| 测试桩(`integration.test` 抢端口式) | `ELF_PORT_OFFSET` per-agent | 按 server 端口 | 🔨 |

## 六、远端(后续阶段,仅留设计空间)

- **反向连接**:agent-server 主动连 gateway(NAT 后 gateway 拨不进)。传输**优先 SSE+POST**(下行 SSE push `req`、上行 POST `event`/`res`,复用现 express+SSE,无新依赖、无 WS);**WS 仅作"高频 token 上行"可选优化,非前提**。→ 专项研究见 [reverse-connection.md](./reverse-connection.md)。
- **共享盘迁移**:远端不共盘,agent-server **自拥其盘**,agent 文件经 `req` 访问;**snapshot/rewind 跨盘协调**(gateway 改 room history + `req:rewind` 还原 agent memory + server reload,三步协调 + 失败补偿)是远端最大风险点。
- 远端鉴权/配对(openclaw 式 device pairing)等远端才引入。
- **业界印证**:B 是"远端 worker 集群"事实标准(reverse connection / broker–worker);**openclaw** 的 gateway 即同形(单入站 WS、node 主动连声明 caps、远端经 Tailscale/SSH tunnel)。openclaw node ≈ 我们的 agent-server(声明持 agentId 即 caps),gateway ≈ 我们的 gateway(只路由+监督,不背 messaging 面)。

## 七、非目标

- 不做 k8s/sidecar 编排、不**跨机**调度(单机域内多进程)。
- 本期**不做远端**、**不做 agent 自更新/回滚**(仅留 §三 接缝)、**不引 WS**。

**错误处理原则**:不靠 `try/catch` 吞错掩盖问题;不据未证实的"可能崩盘路径"预先开药(防 debounce/原子写/吞错去修一个也许不存在的 bug)。根因要么溯源复现、要么显式上报,不静默吞。

## 八、v1 决策(原开放问题,已落地定)

1. **agent 划分到 agent-server**:**全塞一个 server**(M=1)。本期现状就一个含全部 agent 的共享 server;划分问题 M>1 时再开。
2. **agentId → server 路由表**:**不打注册协议**。M=1 下 gateway 直拨已知 server 端口,`getAgentPort(agentId)` 全返该端口;路由表退化为"全归 server1"。注册式路由留 M>1/远端。
3. **M 取值与端口**:**M=1,端口 `gateway.json:agentServerPort`(默认 8180)**。
4. **"在线"实例化时机**:**走 4.3 懒起**(首条消息才 materialize)。

(远端相关:传输模型落地、远端鉴权、跨盘 snapshot/rewind 协调、**agent 分片(同 agentId 多 server)**——推迟到远端阶段再开。)

## 九、v1 实施补注(代码已落,文档同步)

- **per-agent 日志(AsyncLocalStorage)**:`agent-server` 进程经 `enableAgentLogRouting()` 启用;`agent.receive()` 包 `withAgentLog(agentId)`,回合内所有 logger 写 `profiles/logs/agent-<agentId>.log`;上下文外(建房/生命周期/compact 异步等)落 `agent-server.log`。gateway 进程不启用,继续 `gateway.log`。
- **`ensureServerUp` 串行化**:并发 `startAgent`(典型:恢复多成员房间 `ensureReplicasAlive` 的 `Promise.all`)共享同一次 spawn,防多路同时 listen 8180 的 EADDRINUSE 竞态。
- **实例语义已重定义(原 stop 缺口,按实例视角解决)**:`start/stop` 不再是"服务起停"(服务是共享 server),而是**私聊实例 enable/disable**。`stopAgent` = 标私聊禁用 + `/abort chat-<id>` 中断在飞私聊回合(不清 memory、不 dispose RoomState;私聊实例 PrivateChatPlugin 无自驱定时器,挡新消息+中断在飞即 inert)。**群聊实例独立**(由群成员退订 `stopReplica` 管,dispose 群 RoomState + 停 observe 定时器)——故私聊 stop 不影响群聊、群聊拉活不影响私聊,是设计如此,非缺口。
- **群拉活改为群聊实例范围**:`ensureAgentPresent` 不再调 `pm.startAgent`(那是私聊启用,会 spill 解锁私聊),改 `pm.ensureServerUp()`(平台级)+ `pm.getServerPort()`(server 端口,与私聊 status 无关)+ 订阅本群广播。群聊实例首条消息时 server 懒建。`stopReplica`/`clearMemberMemory` 群路径端口兜底同步改 `getServerPort`(原 `getAgentPort` 被私聊 status 门控,群路径不该用)。
- **room 级端点不可假设 engine 内存态(rooms 按需持房、重启即空)**:共享 server 内 `rooms` Map 按需 `getOrCreateRoom` 持有、**重启即空**;`engine/server.js` 的 `/clear/:rid`、`/reload/:rid` 用 `getRoom`(非 create),房未驻留内存 → 直接 **404**(不自动建)。故 gateway 的 room 级"清/重载"端点,落盘保证**不能依赖 engine 内存态成功**——须检查 `resp.ok`,失败/未驻留走**删盘兜底**(对齐群聊 `room_bus.clearMemberMemory` 的 `if (resp.ok)` 判定 + 删盘兜底)。案例:私聊 `DELETE /rooms/:rid/memory` 曾因 running 分支不检 `resp.ok` + 写盘兜底锁在 `else`(非 running)分支,在 running+房不在内存时**静默不清 `context.json`**(`curl http://127.0.0.1:<P>/status` 观察房是否驻留、对未驻留房 `POST /clear/:rid` 返 404 即可复现);2026-08-08 修复(写盘兜底移出 `else`)+ 回归测试见 `test/room_routes.test.js` 的 `/rooms/:rid/memory 私聊清记忆 fallback` describe。