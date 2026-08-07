# agent-server 收养优先(adopt-priority)方案

> 状态:**L1 已落地并验证**(2026-08-08);L2(token 指纹核验)为候选,未做。
> 关联:`docs/test-runtime-isolation-plan.md`(test_mode 端口隔离已堵住"测试杀 prod",L1 是 `ensureServerUp` 侧的**第二道防线**,独立成立)。

## 一、目标

让 `ensureServerUp` 从"端口被占就杀占用者 + 重 spawn"改为**收养优先**:

1. 端口被占时,**先探活**(`GET /status`):
   - 健康(响应 `/status`)→ **收养复用**(标 `running`、记 pid、连 SSE),不杀、不 spawn;
   - 不响应(真僵尸/卡死)→ 才 SIGTERM/SIGKILL 回收端口 + 重 spawn。

2. `stopServer` 同理引入**所有权**:只对"本 PM spawn 的"(记 `_spawnedPid`)发 `/shutdown`/SIGKILL;探活收养来的不杀,只断 SSE + 清本地态。

**预期收益**:
- `fresh PM`(测试、或不走 `probeServer` 的入口)遇见健康 agent-server 时**复用而非谋杀**(结构性堵住 12:50 那类事故,不依赖 test_mode)。
- crash-恢复路径(gateway 崩后直接 `node gateway/index.js` 不走 cleanup)复用孤儿的**在飞 RoomState**(observe 计时器/buffer、内存 messages、syncSource 游标),不丢在途对话。
- 语义上跟新设计(`probeServer` 启动收养)对齐,把旧"每 agent 一进程、按端口清孤儿"的遗物更新为"单共享 server、收养优先"。

**不改的**:`npm run restart`(走 `scripts/cleanup.sh` 显式 `kill -9` 按端口清 → 重 spawn)这条**正常重启**流不变——届时端口空,收养优先走不到杀,行为同现状。

## 二、现状分析(基于代码,非推断)

### 1. 两进程模型

```
gateway(8080)  ←spawn(detached+unref)→  agent-server(8180, --serve-all)
```
- spawn:`process_manager.js:215-221`,`{detached:true, stdio:'ignore'}`,`unref()`。detached → agent-server 在独立进程组,**gateway 崩/Ctrl-C 都不带走它**(故 `cleanup.sh` 需显式按端口杀)。
- spawn 契约(关键):`['--serve-all','--port',port,'--gateway-url',gatewayUrl]`,env 注入 `ELF_GATEWAY_URL` + `ELF_INTERNAL_TOKEN`(后者来自 `loadGatewayConfig().internalToken`,持久化在 `profiles/auth.json`,`config.js:_ensureSecret`)。
- agent-server 无身份:不记"哪个 gateway 的",`/observe` 谁都服务,`/events` 广播所有订阅者;回调 gateway 用 `gatewayUrl + internalToken`(`sync_source` 拉 `/rooms/<rid>/history`)。

### 2. `probeServer` / `ensureServerUp` 决策树(`process_manager.js:133-252`)

```
probeServer():  GET /status → ok? → status='running', pid=r.pid, 连 SSE  (收养)
                         否 → status='stopped', 断 SSE
ensureServerUp():
  if status==='running':  probe → alive? return(复用) ; 否则 fall-through
  [fall-through / status!=='running']
  occupiedPid = findPidFromPort(port)         ← lsof,任何 LISTEN 进程
  if occupiedPid: SIGTERM → 不死 SIGKILL       ← "清占用者"(本方案要改的点)
  spawn(--serve-all --port --gateway-url, env ELF_GATEWAY_URL+ELF_INTERNAL_TOKEN)
  乐观标 running → probe 兜底 → 连 SSE
```

### 3. 谁触发 `ensureServerUp`(调用方)

- `startAgent`(`:273`)← gateway 路由 `POST /agents/:id/start`(私聊启用)
- `room_bus.ensureAgentPresent`(`:513`)← `ensureReplicasAlive` / 进群拉活
- `index.js` 启动序:`new ProcessManager`(26) → `discoverAgents`(33) → **`probeServer`(36)** → RoomManager → `ensureReplicasAlive`(64,逐房 `ensureAgentPresent`→`ensureServerUp`) → `app.listen`(73)。
  - 即**生产启动必先 `probeServer`**:孤儿健康则已标 `running`,`ensureServerUp` 走 fast-path 复用。**收养在启动时已发生**;`ensureServerUp` 的"杀占用者"只在 `status!=='running'` 时触发。

### 4. 两条杀路径

| 路径 | 位置 | 触发 | 现状是否判所有权 |
|---|---|---|---|
| `ensureServerUp` 清端口占用 | `:197-211` | `status!=='running'` 且端口被占(fresh PM / 僵尸 / 未探活) | ❌ 不判,任何占用者都杀 |
| `stopServer` 优雅关+强杀 | `:319-341` | `pm.stopServer()`:**仅测试**调(`gateway.test:145`/`auth.test:62`/`integration:79`);生产路由无 | ❌ 不判,探活收养的 pid 也杀 |

### 5. 重启流(决定"有没有孤儿可收养")

- **`npm run restart`**:`cleanup.sh`(按端口 `kill -9` engine/start.js 进程 + 8180)→ `sleep 1` → `node gateway/index.js`。此时 8180 已空 → `probeServer` 探不到 → `ensureServerUp` spawn 新的。**正常重启 = 杀+重起新进程**,不收养(cleanup 已清)。
- **crash 恢复**(gateway 崩,未走 cleanup 直接 `node gateway/index.js`):孤儿存活 → `probeServer` 收养复用。
- **fresh PM**(测试、或裸起一个 gateway 实例):没走 `index.js` 的 `probeServer` → `status='stopped'` → `ensureServerUp` 直接"杀占用者"。**12:50 事故就是这条**:测试 PM 把健康 prod 当"占用者"杀。

## 三、待决的正确性问题(adopt-priority 必须 answering)

1. **spawn 契约错配(最关键)**:收养孤儿 = 用它**当初 spawn 时**的 `gateway-url`/`ELF_INTERNAL_TOKEN`。若崩溃期间这些变了:
   - `ELF_INTERNAL_TOKEN`:`profiles/auth.json` 被**删除/重生成** → 孤儿持旧 token → 回调 gateway `/rooms/<rid>/history` 401 → `sync_source` 容错"非致命跳过" → **历史静默不同步 → 对话可能失同步**(正确性问题,非新鲜度)。
   - `gateway-url`:8080 端口不变则稳;改部署拓扑才变。
   - 现状"杀+重 spawn"天然保证凭证是**当前 gateway 的**;adopt-priority 丢了这层保证。`/status`(`engine/server.js:383`)返回 `{status,agentId,runKey,mode,pid,agentIds,instanceErrors,rooms}`,**不暴露 token/url**,无法收养时核验。
   - 👉 必须决定:① 接受"token 正常稳定、极端重生成情况罕见"(收养);或 ② 给 `/status` 加返回 `gatewayUrl`/token 指纹,收养时核验不匹配则重 spawn;或 ③ 仍守"只在确需时收养"。

2. **"正常重启就要新代码"是否算正确性**:`npm restart` 走 cleanup 已杀,不受影响。但若运维**裸 `node gateway/index.js`** 想要新代码,adopt-priority 会复用旧代码孤儿 → 跑旧码。这是新鲜度(用户已表态不认可)还是正确性(若旧码与新 gateway 的 wire 协议不兼容)?需界定"gateway↔agent-server 协议变更时是否必须重 spawn"。

3. **真僵尸仍必须能杀**:adopt-priority 的"探活失败→杀"分支要保留,且要能处理"端口被占但不是 agent-server"(如别的程序蹭 8180)——此时探活失败,杀后 spawn;但杀"陌生非 agent-server 进程"是否可接受?现状就这么做,需确认。

4. **`stopServer` 所有权**:`stopServer` 现在不判所有权,探活到谁杀谁(测试 `after()` 因此杀了 prod 60788)。adopt-priority 要不要顺带给 `stopServer` 加 `_spawnedPid` 判定(只杀自己 spawn 的)?测试场景需要。

5. **`index.js` 启动已 `probeServer` 收养**与 `ensureServerUp` adopt-priority 的关系:启动 `probeServer` 已是收养;`ensureServerUp` 的"杀占用者"本就只在"未探活/fresh"时兜底。adopt-priority 是把这条兜底也改成"先探活收养",两者语义统一,不冲突。

## 四、L1 落地(已实现 + 验证)

**改动**:仅 `gateway/process_manager.js` `_ensureServerUpImpl` 一处,在"端口被占"分支**先探活**:健康就 `probeServer()` 收养复用(设 running/pid/instanceErrors + 连 SSE),探不活(真僵尸/卡死/非 agent-server)才走原有 SIGTERM/SIGKILL + spawn。约 +6 行,复用现成 `probeServer`,不新写探活逻辑、不动 agent-server、不加端点。

**验证**:
1. fresh PM(plain `node`,无 `--test` → 落 8180)遇假健康 agent-server(应 /status+/events)→ `ensureServerUp` 日志"探活健康,收养复用,不杀不 spawn",`status` 变 running、pid=占用者 pid,**占用者存活** ✓(原路径会杀它)。
2. `npm run test:all` = 661 pass / 0 fail(基线无回归)。

**L1 接受的边缘**(L2 才处理):`profiles/auth.json` 被删重生成 + 孤儿存活同时发生 → 收养错配 token → 回调 401 → `sync_source` 静默跳过历史同步(降级非崩)。罕见。

## 五、L2(候选,未做)

若要彻底堵 §三.1 的 token 错配:给 `engine/server.js` `/status` 返回加一个 `ELF_INTERNAL_TOKEN` 的短指纹(如前 8 字符 hash)+ `gatewayUrl`;`ensureServerUp` 收养时比对——不匹配则不走收养、走"杀+重 spawn"(拿当前 gateway 的新 token)。改动小(两端各 +1 字段 + 比对一行),但需动 agent-server 端点,暂不急。

## 六、未做的相关项(待定)

- `stopServer` 所有权(`_spawnedPid`):测试 `after()` 杀 prod 走那条;test_mode 已让测试落 18180 碰不到 prod,故非必需,属于可选第三道防线。
- §三.2"裸重启想要新代码":L1 会让裸 `node gateway/index.js`(不走 cleanup)复用旧码孤儿;`npm restart` 走 cleanup 不受影响。是否需要"裸重启也强制新 spawn"待界定(若仅新鲜度则不必)。