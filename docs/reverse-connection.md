# 远端 agent-server:反向连接研究

> 状态:**研究/设计**,未实现。日期:2026-08-05。
> 上游:[inprocess-agent-host.md](./inprocess-agent-host.md) §六(远端阶段)。本文档只研究**传输通道**;数据访问迁移另开。
> **已定:传输走 SSE+POST(不引 WebSocket)**。下行(g→s)经 server 主动连的 SSE 下行流推 `req`;上行(s→g)经 server POST `event`/`res` 到 gateway HTTP。复用 express+SSE、零新依赖。
> **已定:统一 B**——本地 agent-server 也切反向 SSE+POST(不再保留本地 A 拨号模型);agent-server 零入站端口,全平台仅 gateway 8080 一个入站端。当前本地 A 实现(拨 8180)将被重构为反向通道。

## 一、目标与范围

- **目标**:把 gateway↔agent-server 的传输从"gateway 拨 server 端口"(A,本地)改成"server 主动连 gateway"(B,反向),使 agent-server 可在 NAT/防火墙后(远端)被 gateway 用。
- **范围只限传输通道**:握手、`req`/`res`/`event` 协议、连接生命周期、agentId→server 路由。
- **明确不在范围**(远端的另一块——数据访问迁移,另开):共享盘迁移(config_store/skill_store/avatar/DM state 经 `req` 访问)、snapshot/rewind 跨盘协调、agent 分片、远端鉴权细节(本文只列选项)。
- **反向连接是远端的必要非充分**:有了它远端能连通,但远端完整可用还需数据访问迁移。

## 二、为何"相对可行"(可单独先做)

1. **可本地建+测**:server 连 gateway localhost,不依赖真远端就能开发验证;真远端只是网络层(Tailscale/SSH tunnel)。
2. **与共享盘迁移解耦**:本地同盘下 config/snapshot 等仍走盘,反向连接只换传输、不动数据访问。能先单独落地传输,数据访问迁移后做。
3. **路由层不变**:agentId→server→channel 路由 + 复合键 `(agentId,roomId)` 照旧;channel 实现从 `fetch` 换成持久连接,路由语义不动。
4. **openclaw 同形参考**:单入站端口、node 主动连、`req`/`res`/`event`、idempotency、events 不重放——成熟模板(docs/inprocess-agent-host.md §六已印证)。

## 三、传输选型:**SSE+POST**(已定)

**机制**:
- **下行(g→s)**:server 主动连 gateway 的 SSE 下行流 `GET /servers/:serverId/stream`(长连接);gateway 把 `req`(observe/abort/clear/...)作为 SSE event 推下来。
- **上行(s→g)**:server 用 `POST /servers/:serverId/event` 和 `POST /servers/:serverId/res/:reqId` 把 `event`(token/done/compact/...)和 `res` 送回 gateway。
- **握手**:server 先 `POST /servers/:serverId/register` `{agentIds[], auth}` 注册;gateway 校验后开通 SSE 下行流。

**为何选它(而非 WS)**:
- **g→s 是低频控制**(observe/abort/clear/reload),无高频推流 → SSE 下行流正合适,不需要 WS 的双向轻帧。
- 高频只在 **s→g token 上行** → POST-per-event,这是唯一权衡点(可批量缓解);g→s 不分担此压力。
- 复用现有 express + SSE 设施(gateway 已有 `/subscribe` SSE、agent `/events` SSE),零新依赖、不引 `ws`。
- 鉴权复用 HTTP 层(register/POST 带 token),无需新 connect 帧握手协议。
- 与现有 `/events` SSE 语义一致(events 不重放),易对齐。

**关键红利:agent-server 零入站端口**。反向 SSE+POST 下 agent-server 是**纯出站客户端**(连 gateway SSE 下行流 + POST event/res 到 gateway + POST 到 LLM 模型方),**不 listen 任何端口**;gateway 也不拨它。唯一入站端 = gateway 8080(SSE 下行 + POST uplink + 前端 HTTP/SSE 全挂 8080)。即一旦走反向(含本地统一 B),`agentServerPort(8180)` 消失,全平台仅 1 个入站端口,比当前本地 A(8080+8180)还少。

**已知权衡(上行 POST-per-event)**:
- 高频 token 上行 = 每 token 一 POST;HTTP keep-alive 下开销可接受,但量大时偏重。
- **缓解(本期可不做,留优化)**:server 端批量合并 token(如 50ms 窗口或 N 条合一)再一次 POST;或 token 走单独聚合 uplink。
- WS 在这个点上更优(帧轻),但本期不引 WS,先把通道跑通;真成瓶颈再加。

## 四、协议(SSE+POST 帧集)

- **register** s→g `POST /servers/:serverId/register`:`{agentIds[], version, auth}` → g 返 `{ok, features}`;gateway 建 `agentId→serverId` 路由(重复 agentId 拒收,见 inprocess-agent-host §三)。
- **下行流** s→g `GET /servers/:serverId/stream`:SSE;gateway 推 `req` 帧:`{id, method, params:{agentId,roomId,...}, idempotencyKey?}`。
- **res** s→g `POST /servers/:serverId/res/:reqId`:`{ok, payload|error}`(对应下行 req 的应答)。
- **event** s→g `POST /servers/:serverId/event`:`{event, payload:{_agentId,_roomId,...}}`(异步事件,原 `/events` SSE 的全部)。
- 方法集(g→s `req.method`):`observe|abort|clear|reload|status|shutdown|getConfig|...`;事件(s→g `event.event`):`token|tool_call|done|compact|say|notice|...`。
- side-effect req(`observe`/`putConfig`)带 `idempotencyKey` + gateway 短时 dedupe。
- **events 不重放**:断线重连后 gateway/前端自行 refresh(与现 `/events` SSE 一致)。

## 五、代码改动地图(SSE+POST)

**gateway 端**
- 新增路由:`POST /servers/:serverId/register`(注册 + 拒重)、`GET /servers/:serverId/stream`(SSE 下行,每 server 一条)、`POST /servers/:serverId/event`、`POST /servers/:serverId/res/:reqId`。挂 8080,无新端口。
- `AgentServerRegistry`(本地 M=1 淡化,远端升一等):`serverId→{downstreamRes, agentIds[], status}` + `agentId→serverId` 路由表。
- `room_routes`/`room_bus` 的 `fetch http://serverPort/...` → `registry.sendReq(agentId, method, params)`(经该 server 的 SSE 下行推 req,等 res/超时)。
- `agent_events`(现 gateway 订阅 server `/events` SSE)→ 收 `POST /servers/:serverId/event`,按 `_agentId` 路由(复用 `_onAgentEvent`/聚合 SSE,前端面不动)。

**server 端**
- 启动时 `POST gateway/register` 声明 agentIds → 开 `GET gateway/stream` SSE 下行。
- 收 SSE `req` → 分发到 `(agentId,roomId)` RoomState(复用 `server.js` 的 `handleObserve`/`clearRoom`/`reloadRoom` 逻辑,改成函数调用)。
- 推 `event`/`res` → `POST gateway/event`|`/res/:reqId`(替代 `serverPushEvent` / `/events` SSE)。
- 纯反向模式下 server.js 的 express 端点可不挂(或本地双模式保留,见 §八)。

## 六、鉴权/配对(远端,本文只列选项)

- **openclaw 式设备配对**:server `connect` 带设备身份 + challenge 签名;gateway 审批 + 发 device token;metadata 变更需重新配对。
- **网络层鉴权**:Tailscale/VPN 内网信任,gateway 信任来源。
- **共享密钥**:`connect.params.auth.token`,简单但密钥分发 manually。
- 本地开发:loopback auto-approve。

## 七、重连/恢复

- server 断线自动重连(指数退避);gateway 标该 server offline,名下 agent 派生 `server-down`(对齐 inprocess-agent-host §4.3)。
- 重连后 re-`connect`(声 agentIds);gateway 路由表恢复。
- 在飞 `req`(断线时):gateway 判 `res` 超时 → 返错或幂等重试;`event` 不重放,前端 refresh。

## 八、本地 vs 远端:**统一 B**(已定)

- **决策:本地 agent-server 也切反向 SSE+POST**,不保留本地 A 拨号模型。一套代码、agent-server 零入站端口、全平台仅 8080 一个入站端(比当前本地 A 的 8080+8180 少一个)、远端无额外分支。
- **代价**:当前本地 A 实现(gateway 拨 8180 / `fetch http://127.0.0.1:8180/...` / `agent_events` 订阅 8180 `/events` / `ensureServerUp` spawn+probe 8180)将被**重构为反向通道**。这是对刚稳定(517 绿)的传输层的返工,作为**反向通道阶段**单独、测试驱动地推进。
- **不重构的部分**:数据访问(config_store/skill_store/avatar/snapshot)本地仍走同盘直读直写(本地同机,不经通道),直到远端才迁移——与本文档"只研究传输通道、数据访问另开"的范围一致。控制类(observe/abort/clear/reload/events)全部走反向通道。

## 九、开放问题(落地前拍)

1. **统一 B 已定**(§八)——本地也切反向 SSE+POST。下一步是落地实现(见 §五/§八)。
2. 在飞 `req` 断线的**重试/超时**策略(幂等 key 兜底到什么程度)?
3. **配对审批 UX**(前端管理页?CLI 工具?)?
4. 多 server 时 **agentId 拒重的注册协议**落法(`register` 上报 + gateway 查表拒重,见 inprocess-agent-host §三)?
5. 反向通道建成后,前端↔gateway 的聚合 SSE **应不变**(gateway 收 `POST event` 喂给现有聚合流)——确认。
6. server 端 express 端点在纯反向模式下**保留与否**(双模式 vs 单反向)?
7. **上行 token POST-per-event 是否需批量**?v1 可先不批量(keep-alive 撑),成瓶颈再加 50ms/N 合并。

## 十、参考

- openclaw gateway(`docs.openclaw.ai/concepts/architecture`):单入站 WS、node `role:node` 主动连声明 caps、`req`/`res`/`event`、idempotency key、events 不重放、远端经 Tailscale/SSH tunnel、device pairing。**我们借其协议形态(req/res/event + idempotency + events 不重放),但传输用 SSE+POST 而非 WS**(零依赖、复用 express+SSE);同形不同线。
- inprocess-agent-host.md §六/§三:远端阶段定位 + agentId 唯一性/拒重约束。
