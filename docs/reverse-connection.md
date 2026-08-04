# 远端 agent-server:反向连接研究

> 状态:**研究/设计**,未实现。日期:2026-08-05。
> 上游:[inprocess-agent-host.md](./inprocess-agent-host.md) §六(远端阶段)。本文档只研究**传输通道**;数据访问迁移另开。

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

## 三、传输选型

| | WS | SSE+POST |
|---|---|---|
| 方向 | 双向单连接 | 下行 SSE push req + 上行 POST event/res(两通道) |
| 依赖 | `ws` 库 | 复用 express+SSE,零新依赖 |
| 上行 token 流 | 帧轻 | 每事件一 POST(高频 token 时开销大,可批量缓解) |
| 鉴权 | 新 connect 帧设计 | 复用 HTTP 鉴权 |
| openclaw | 同款(WS) | — |

**倾向 WS**(双向干净、openclaw 验证、token 流轻)。若想零依赖先跑通可先 SSE+POST,但上行高频 token 是其弱点(需批量)。

## 四、协议帧(握手后)

- `connect` s→g:`{serverId, agentIds[], version, auth}` → `hello-ok` g→s:`{features}`。
- `req` g→s:`{id, method, params:{agentId,roomId,...}, idempotencyKey?}` → `res` s→g:`{id, ok, payload|error}`。
- `event` s→g:`{event, payload:{_agentId,_roomId,...}}`。
- 方法集(g→s):`observe|abort|clear|reload|status|shutdown|getConfig|...`;事件(s→g):`token|tool_call|done|compact|say|notice|...`。
- side-effect req(`observe`/`say`/`putConfig`)带 `idempotencyKey` + gateway 短时 dedupe(防重试双发)。
- **events 不重放**:断线重连后 gateway/前端自行 refresh(openclaw 同款;与现有 `/events` SSE 语义一致)。

## 五、代码改动地图

**gateway 端**
- 新增 **WS 入站服务**(挂 8080 同端口 upgrade),接受 server 连接 + 握手/鉴权。
- `AgentServerRegistry`(本地 M=1 时淡化,远端升一等):`serverId→{ws, agentIds[], status}` + `agentId→serverId` 路由表 + 注册/拒重。
- `room_routes`/`room_bus` 的 `fetch http://serverPort/...` → `registry.sendReq(agentId, method, params)`(走该 agent 的 server 通道)。
- `agent_events`(现 gateway 订阅 server `/events` SSE)→ 收 channel `event` 帧,按 `_agentId` 路由(复用现有 `_onAgentEvent`/聚合 SSE,前端面不动)。

**server 端**
- 启动时 WS connect gateway,声明 `agentIds[]`。
- 收 `req` → 分发到 `(agentId,roomId)` RoomState(复用 `server.js` 的 `handleObserve`/`clearRoom`/`reloadRoom` 逻辑,改成函数调用而非 HTTP 路由)。
- 推 `event`/`res` → 经 channel 发送(替代 `serverPushEvent` / `/events` SSE)。
- 纯反向模式下 server.js 的 express 端点可不挂(或本地双模式保留)。

## 六、鉴权/配对(远端,本文只列选项)

- **openclaw 式设备配对**:server `connect` 带设备身份 + challenge 签名;gateway 审批 + 发 device token;metadata 变更需重新配对。
- **网络层鉴权**:Tailscale/VPN 内网信任,gateway 信任来源。
- **共享密钥**:`connect.params.auth.token`,简单但密钥分发 manually。
- 本地开发:loopback auto-approve。

## 七、重连/恢复

- server 断线自动重连(指数退避);gateway 标该 server offline,名下 agent 派生 `server-down`(对齐 inprocess-agent-host §4.3)。
- 重连后 re-`connect`(声 agentIds);gateway 路由表恢复。
- 在飞 `req`(断线时):gateway 判 `res` 超时 → 返错或幂等重试;`event` 不重放,前端 refresh。

## 八、与本地 A 模式的关系(关键决策)

- **选项 1:统一 B**——本地 server 也走反向连(localhost WS),代码一套,端口仍只 8080(本地 server 零入站端口)。代价:本地已稳的 fetch/SSE 传输要重构。
- **选项 2:本地 A + 远端 B 两套**——本地继续 fetch/SSE(已实现),远端加反向通道。代价:两套传输是长期复杂度负担。
- 倾向 **统一 B**(一套代码、本地也享零入站端口、远端无额外分支),但需评估重构成本 vs 长期收益。这是本文档头号开放问题。

## 九、开放问题(落地前拍)

1. **统一 B vs 本地 A+远端 B 两套**?(§八)——决定改动面。
2. **WS vs SSE+POST** 定型?(§三)
3. 在飞 `req` 断线的**重试/超时**策略(幂等 key 兜底到什么程度)?
4. **配对审批 UX**(前端管理页?CLI 工具?)?
5. 多 server 时 **agentId 拒重的注册协议**落法(`connect` 上报 + gateway 查表拒重,见 inprocess-agent-host §三)?
6. 反向通道建成后,前端↔gateway 的聚合 SSE **应不变**(gateway 收 channel event 喂给现有聚合流)——确认。
7. server 端 express 端点在纯反向模式下**保留与否**(双模式 vs 单反向)?

## 十、参考

- openclaw gateway(`docs.openclaw.ai/concepts/architecture`):单入站 WS、node `role:node` 主动连声明 caps、`req`/`res`/`event`、idempotency key、events 不重放、远端经 Tailscale/SSH tunnel、device pairing。本文档的同形模板。
- inprocess-agent-host.md §六/§三:远端阶段定位 + agentId 唯一性/拒重约束。
