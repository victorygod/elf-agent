# 运行时隔离与自改架构方案

## 目的

1. **测试时绝不能影响正在运行的服务**——全量跑测试不再打挂真实 gateway / agent-server、不再写真 agent 配置 / 读真 apiKey。
2. **支持同机多实例**(多 gateway / 多 agent-server,各自端口 + 数据互不串)。
3. **支持 agent 安全地自改**(含改自己定义、改平台代码):运行时环境不被自身原地修改,改在隔离实例里验证,蓝绿切换,失败可回滚。

三者同根:**把"不可变的 template"与"物化的 instance"分开,用版本化制品 + 健康门发布。**

---

## 一、北极星:template / instance 架构

### 命名

- **template(模板)**= git 工作树本身(`agents/`+`engine/`+`gateway/`+`frontend/`),运行时**只读**,是所有实例的不可变来源。(不另建 `template/` 目录;仓库根即 template。)
- **instance(实例)**= 从 template 物化出的隔离运行目录,每个环境一个,各跑在自己的 root 里。
- 收口位:`runtime.json`(仓库根)声明 template 路径 + 各 instance 的 root / 端口 / token。**端口、路径、环境在此一处声明,生产写好运行时不改。**

> 命名注:仓里已有 `gateway/agent_template/`(新建 agent 的脚手架模板),范围不同(那是造单个 agent,本 template 是整平台来源),可共存;若觉混淆,instance 层可改叫 `workspace` / `runtime-root`。

### 架构图

```
仓库根 = template(git 跟踪,运行时只读)
  agents/  engine/  gateway/  frontend/
  runtime.json            ← 收口:template 路径 + 各 instance(root/端口/token)

        │ 每环境物化一份
        ▼
┌──────────────┬─────────────────┬──────────────────┐
│ prod         │ test            │ self-modify      │
│ instances/   │ instances/      │ instances/       │
│   prod/      │   test/         │   sm-<sha>/      │
│  (full 物化) │  (light:agents  │  (full 物化)     │
│  port 8080/  │   +profiles)    │  ← elf-002 在这改自己/改平台
│    8180      │  port 9800/     │     跑测试 → 绿 → promote
│  cwd=此 root │     18180       │  port 隔离       │
└──────────────┴─────────────────┴──────────────────┘
```

### 两档 instance(物化范围不同,按用途选)

- **light instance(测试够用)**:cwd 仍 = template(`engine/gateway` 共享只读),仅 `ELF_AGENTS_DIR` + `ELF_PROFILES_ROOT` 指向 instance root 的 agents+profiles。覆盖测试隔离,不物化 engine。
  - 可行性依据:agent-server spawn 的 `cwd: process.cwd()`(`process_manager.js:216`)、`entryFile = cwd/engine/start.js`(`:213`)不变,`engine/start.js` 3 处 `process.cwd()/agents`(108/160/177)改走 `agentsDir()` helper(读 `ELF_AGENTS_DIR`)即可。
- **full instance(自改 / prod 隔离用)**:整个 template 物化到 instance root,spawn `cwd = instance root`,engine/gateway/agents 全在 instance 内。agent 改平台代码也只落本 instance。
  - 依据:`engine/start.js` 经 cwd 解析 engine 自身与 agents,故全量自改需整树物化(无法只物化 agents)。

### 自改流程 = 蓝绿(版本化制品,非文件快照)

```
elf-002 在 instances/sm-<sha>/ 改自己 / 改平台
  ① 改前:template 永不被动;sm-<sha> 已是 template 物化副本
  ② 改完:在隔离 instance 跑全量测试(隔离端口/数据)
  ③ 绿 :给该状态打 git tag(= "开发态备份",用制品不用快照)
        → promote:prod instance 指向新 SHA;优雅重启(Node 无可靠热更,平台代码改了必重启)
          旧 prod instance 保留 = 回滚态
  ④ 红 / 重启失败 / 健康门不过:回滚
        → 回滚到 prod 上一稳定 tag(="开发态")
        → 或回滚到 template 原始 SHA(="原始态")
```

### 业界对照(判断这套是否合理)

核心原则(不可变运行时 / 改前备份 / 隔离测试 / 通过后留开发态 / 失败回滚两档)与业界**不可变基础设施 + 蓝绿 + CI 发布门**同谱,合理。三处按业界主流调整:

| 本方案初版 | 业界主流 | 理由 |
|---|---|---|
| 杀自己→改自己→重启(原地) | 蓝绿:新实例先验证再切流,旧实例留作回滚 | 避"重启失败→服务挂"窗口;新版本在杀旧前已验证 |
| 文件快照备份/回滚态 | 版本化制品(git SHA/tag 物化) | 可 diff/审计/复现;回滚=重部署旧 SHA |
| agent 自判是否回滚 | 客观健康门(测试+探活+无崩溃循环);agent 仅"请求" | 改坏自己的主体判"我坏没坏"是利益冲突 |

两个现实约束:① **Node 无可靠进程级热更**,平台代码改了生效只能重启(优雅重启:状态已落盘 profiles,重启重物化 RoomState);真零中断需蓝绿前后台双进程+切流,单机无代理时中断≈重启秒级。② 让 agent 改"跑着自己的平台"在业界很少见(主流沙箱在用户数据),但**若要做自改,template/instance+蓝绿+健康门是唯一稳妥玩法**(K8s、自托管 updater、DB migration 同套路)。

---

## 二、现状与根因(证据)

### 现状:运行时分两层

- **profiles 层(可隔离 ✅)**:`shared/profiles_paths.js` 统一,所有对话/用户/鉴权/日志在 `profiles/` 下,`ELF_PROFILES_ROOT` 可整体覆盖。
- **cwd 层(不可隔离、运行时写 ❌)**:
  - `gateway.json`——平台配置 `port`(8080)+`agentServerPort`(8180),`config.js:92` `saveGatewayConfig` 写 `cwd/gateway.json`(`_configPath`,`config.js:25`)。UI 保存平台设置即写回。
  - `agents/<id>/config/`——agent 定义 + 运行时写:`config_store.js:118/131`、`engine/config_loader.js:78/173`、`avatar.js:57`、`agent_scaffold.js`。`process.cwd()/agents` 硬编码。
- **端口(半隔离)**:gateway HTTP 8080 死读 `gateway.json` 无 env(`config.js:74`);agent-server 8180 有 `ELF_PORT_OFFSET`(`process_manager.js:44,49`)。

### agents/ 耦合面(集中式,5 锚点)

真正硬编码 `process.cwd()/agents` 的根锚点只 5 处,约 15 个消费点自动跟随:

| 锚点 | 文件:行 | 作用 |
|---|---|---|
| 1 | `gateway/process_manager.js:40` | `pm.agentsDir`——gateway 侧总根 |
| 2 | `engine/start.js:160` | serve-all 扫 agents |
| 3 | `engine/start.js:108` | startAgent configDir fn |
| 4 | `engine/start.js:177` | serve-all configDir fn |
| 5 | `gateway/room_bus.js:484` | `agentConfigDir` 兜底(已验证生效:`room_bus.js:506/635/649` 调用;gateway/index.js 未传该 opt) |

> 证据(不能只读共享):`server.js:213` PUT /agents/:id/config 写 `agentsDir/<id>/config/config.json`;`test/auth.test.js:184`、`integration.test.js:188/263` 真的 PUT(改 memoryTokenLimit,save/restore);`.gitignore` 只忽略 `**/api_key.json`,真 apiKey 躺共享 cwd;`agents/elf-001/config/config.json` mtime 8/7 02:21。

### 根因:测试为何打挂运行中服务(已用日志实证)

实证(`profiles/logs/gateway.log`,12:50:52–12:51:01):bare `node --test`(未带 `--import setup-env`)跑含 `auth.test` 的测试 → 测试进程 `ELF_PORT_OFFSET` 未设 → `new ProcessManager()` 算出 `server.port=8180`(= 生产)。

- **真凶 = `ensureServerUp` 的"端口被占→清占用者"**(`process_manager.js:197-204`):auth.test 的 visitor-start 用例打 `POST /agents/:id/start` → `startAgent`(`:273`)→ `ensureServerUp` 发现 8180 被生产 agent-server 占着 → 当"崩溃残留" SIGTERM/SIGKILL → spawn 测试自己的(pid 60788)。
- 随后 `after()` 的 `stopServer()`(`gateway.test:145`/`auth.test:62`/`integration:79` 调):`/shutdown` + 超时 SIGKILL,杀掉 60788(`process_manager.js:318-340`)。
- 生产 agent-server(原 pid)被 `ensureServerUp` 杀、60788 被 `stopServer` 杀 → 生产 gateway(8080)失后端 → agent 全 `server-down`、SSE `/events` 断 → 前端 event 错 + 5s 重连风暴。

> `integration.test.js:42` 自设 `ELF_PORT_OFFSET=10000`(落 18180),所以 integration 的 `ensureServerUp`/`stopServer` 只打 18180,不碰生产——隔离正确例。问题在 auth.test/gateway.test 不自设,只靠 `setup-env`,bare 跑就漏。

**`ensureServerUp` 为何要"清端口占用者"(这操作本身是对的)**:agent-server 由 gateway `spawn({detached:true}) + child.unref()`(`process_manager.js:217/221`)启动,故 gateway 崩/重启时 agent-server **故意继续活着**(脱离父进程,不连累在途对话)——这就是"孤儿"。新 gateway 的 PM 是全新的(`server.status='stopped'`),内存里没有幸存者 pid。`ensureServerUp` 选"杀占用者 + 重 spawn"而非"探活后收养复用",主因是**代码新鲜度**:agent-server 内存里跑的是当初加载的 `engine/start.js` 代码,gateway 重启多半伴随改码,而 Node 不能热重载,只能杀进程重启以跑新代码(不是因为 SSE——`probeServer` 能直连 `/events`)。此取舍(新鲜度 > 复用)是当前选择,非唯一解;本方案不动它,只让测试端口永不与生产重合,使这条"清占用者"只会清测试自己的孤儿。

### memory/ 归属(代码证据,非注释)

- gateway 生产只写 `agents/<id>/rooms/<rid>/`:`server.js:132 agentRoomState` → `room_state.js:37/48` dataDir 必填传 `createAgent` → `create_agent.js:22` 走 `dataDir||agentMemory` 时 dataDir 非空不取 agentMemory → `message_manager.js:65` 写 `rooms/<rid>/context.json`;`snapshot.js:34`、`room_routes.js:456` 同用 agentRoomState。
- `memory/` 仅 dev 直跑 `node agents/<id>/index.js` 写:`startAgent` 不传 dataDir → `start.js:53-56` null → `create_agent.js:22` 兜底 `agentMemory()`。磁盘实证:memory/ 15 文件(dev 足迹)、rooms/ 73 文件(生产足迹)。
- elf-002 工具含 Write/Edit/Bash(`create_agent.js:4`),Write/Edit **无路径沙箱**(只要求先 Read),agent-server spawn `cwd=平台仓库`(`process_manager.js:216`)→ elf-002 可改自己定义**甚至改 engine/gateway 平台代码**。这是 self-modify 必须隔离的根 因。

---

## 三、实施分步(向北极星推进;原改动 1-5 重排为此)

### Step 1 —— 首刀(修订):`test_mode` 统一隔离,替代 `setup-env`

**为何修订**:前一版在 `test/setup-env.js` 加 `ELF_PORT_OFFSET` 只对 `npm test`/`test:all`(带 `--import`)生效;bare `node --test …`(用户漏带 `--import`)完全绕过,导致 auth.test 的 `ensureServerUp` 在真实 8180 上杀生产 agent-server(见「根因」)。隔离不能再靠一个易漏的 `--import` 标志。

**方案**:全仓**唯一一次** `process.argv.includes('--test')` 判定,导出 `isTestMode`,在该处一次性设好**全部**隔离 env(吸收 setup-env 全部职责),由被测试必然 import 的模块自动触发,不依赖 `--import`。

新建 `shared/test_mode.js`(不 import logger,避免循环,用 `console` 打日志):
```js
import fs from 'fs'; import os from 'os'; import path from 'path';
// 全仓唯一判定:Node 测试 runner 把 --test 留父进程,测试文件在子进程跑、argv 不含 --test,
// 但 Node 给子进程设 NODE_TEST_CONTEXT=child-*。二者取或覆盖父子两种情况。
export const isTestMode =
  process.argv.includes('--test') || !!process.env.NODE_TEST_CONTEXT;
const _created = [];
if (isTestMode) {
  if (!process.env.ELF_LOG_DIR)      { const d=fs.mkdtempSync(path.join(os.tmpdir(),'elf-test-logs-'));    process.env.ELF_LOG_DIR=d; _created.push(d); }
  if (!process.env.ELF_PROFILES_ROOT){ const d=fs.mkdtempSync(path.join(os.tmpdir(),'elf-test-profiles-'));process.env.ELF_PROFILES_ROOT=d; _created.push(d); }
  if (!process.env.ELF_PORT_OFFSET)    process.env.ELF_PORT_OFFSET='10000';
  if (!process.env.ELF_SKIP_AUTH)      process.env.ELF_SKIP_AUTH='1';
  if (!process.env.ELF_JWT_SECRET)     process.env.ELF_JWT_SECRET='test-jwt-secret-0123456789abcdef0123456789abcdef';
  if (!process.env.ELF_INTERNAL_TOKEN) process.env.ELF_INTERNAL_TOKEN='test-internal-token-0123456789abcdef0123456789';
  console.warn(`[elf] test mode on: port_offset=10000 skip_auth=1 profiles=<tmp> logs=<tmp>`);
  process.on('exit', () => { if (process.exitCode===0) for (const d of _created) try{fs.rmSync(d,{recursive:true,force:true});}catch{} });
}
```
> 信号选择是本方案的关键坑:`process.argv.includes('--test')` **不够**——Node 22 实测,测试 runner 给每个测试文件 spawn 的子进程 argv 是 `['node','<file>']`,**没有 `--test`**;真正可靠的子进程信号是 env `NODE_TEST_CONTEXT=child-*`。曾因只判 argv 导致 test_mode 在子进程不触发、PM 仍落 8180。
**接线**:`shared/profiles_paths.js` 顶部第一行 `import './test_mode.js';`(副作用 import)。`gateway/process_manager.js` 可选 `import { isTestMode } from '../shared/test_mode.js'`(若要按标志分支;读 env 的话连这都不用)。`ensureServerUp` **原样保留**。`test/setup-env.js` 退役(或留空壳过渡);package.json 的 `--import ./test/setup-env.js` 可移除。

**代码 review(env 读取时序——决定可行性的关键)**:

| env | 读取点 | 时机 | test_mode 何时设好才安全 |
|---|---|---|---|
| `ELF_LOG_DIR` | `logger.js:18 const LOG_DIR=logsDir()` | **import 时缓存** | 必须在 logger:18 前 → 靠 profiles_paths 顶部 import test_mode(logger:15 `import{logsDir}from'./profiles_paths'` 先解析 profiles_paths→test_mode,再执行 logger:18)✅ |
| `ELF_PROFILES_ROOT` | `profiles_paths.js:28 profilesRoot()`(lazy 缓存 `_root`) | 首次调用时 | import 期设好,早于任何 runtime 首次调用 ✅ |
| `ELF_PORT_OFFSET` | `process_manager.js:44` 构造、`engine/start.js:47` | runtime | 早于 `new ProcessManager()` ✅ |
| `ELF_SKIP_AUTH` | `auth.js:165`、`auth_middleware.js:59` | per-request runtime | 早于首次请求 ✅ |
| `ELF_JWT_SECRET`/`ELF_INTERNAL_TOKEN` | `config.js:_ensureSecret`、`internal_auth.js:13` | runtime per-call | 早于首次调用 ✅ |

**覆盖面**:任何 import 平台模块的测试都 transitively import `logger`/`profiles_paths`(logger 是 createLogger 的必经路)→ test_mode 触发。纯工具单测不 import 平台模块,本就无需隔离,无回归。
**prod**:`node gateway/index.js` 无 `NODE_TEST_CONTEXT` 且 argv 无 `--test` → `isTestMode=false` → 零副作用、零 env 改动、零日志。
**幂等**:自隔离测试(gateway:13/auth:17/integration:17/abort:39 自设 `ELF_PROFILES_ROOT`)会覆写 + `_resetProfilesRoot()`,test_mode 先设的 tmp 被它们覆盖,行为同现状。

**效果**:bare `node --test …` 与 `npm test` 行为完全一致(端口 18180、profiles/logs tmp、skip-auth、固定密钥);测试 PM 永不碰生产 8180;`ensureServerUp` 在 18180 上只清测试自己的孤儿。

### Step 2 —— light instance for test + runtime.json 起步

- 新增 `agentsDir()`/`agentConfigDir(id)` helper(`shared/profiles_paths.js`,与 `profilesRoot()` 对称,读 `ELF_AGENTS_DIR`)。
- 5 个 agents 锚点(见上表)改调 helper;锚点 5 二选一(改 room_bus:484 兜底 / gateway/index.js 显式传 agentConfigDir)。
- `test/setup-env.js`:`fs.cpSync` 复制 `cwd/agents` → tmp(18MB,亚百毫秒),抹副本内 `**/api_key.json` 为假值,设 `ELF_AGENTS_DIR=tmp`。配合既有 `ELF_PROFILES_ROOT` + Step 1 端口偏移 → 测试全隔离(不碰真 profiles / 真 agents / 真 80/81 段端口)。
- 建 `runtime.json` 收口雏形:声明 template 路径 + `test` instance(root/端口/token)。从此环境声明收口于此。

### Step 3 —— full instance + 蓝绿自改

- 物化整 template 到 `instances/sm-<sha>/`(git worktree 或 copy;含 engine/gateway/agents/frontend),agent-server spawn `cwd = instance root`。
- 自改闭环:sm-<sha> 内改 → 跑测试(隔离) → 绿打 tag → promote(prod 指向新 SHA + 优雅重启,旧 prod 保留) → 红/重启失败/健康门不过 → 回滚到 prod 上一 tag 或 template 原始 SHA。
- 健康门:测试通过 + 探活 + 无崩溃循环,agent 仅可请求回滚,不自判。
- `runtime.json` 扩展 `selfmod` instance 段。

### Step 4 —— prod 迁 instance + gateway.json 解耦

- prod 脱离直接跑 cwd 工作树,迁到 `instances/prod/`(full 物化)。template 工作树运行时纯只读,`saveGatewayConfig` 写入 instance root 而非 cwd(替代原改动 3)。
- gateway HTTP 端口进 `runtime.json`(替代原改动 1 的 `ELF_GATEWAY_PORT` env;收口改为配置驱动)。
- 同机多 prod 实例:各一组 `runtime.json` instance 段。

### 收尾 —— memory/ 退役

`engine/start.js` startAgent 显式给 `dataDir = agentRoomState(agentId, roomId)`;删 19 个 `create_agent.js` 的 `|| agentMemory(...)` 兜底 + `agentMemory()` helper + `profiles_paths.js:11` memory 布局行;磁盘清 `profiles/agents/*/memory/`。数据根单一化为 `rooms/<rid>/`。

---

## 四、验收

1. **Step 1 后**:真实 gateway+agent-server 运行中跑 `npm run test:all`:8180 存活、无 SSE 重连错误日志。
2. **Step 2 后**:且真实 `profiles/` 与 `agents/*/config/`(config.json/api_key.json/avatar)字节不变;测试全在 tmp instance 内。
3. **Step 3 后**:elf-002 在 sm-<sha> 自改 + 测试通过 → promote 后 prod 生效;改坏或重启失败 → 回滚到上一 tag,prod 恢复;template 工作树全程不被运行时写入。
4. **Step 4 后**:同机两组 `runtime.json` instance 段 → 两个 prod gateway 端口不冲突、数据/配置互不串。
5. `app.listen` 的 `EADDRINUSE` 只可能发生在测试/自改 instance 内部。

---

## 五、业界一句话结论

本方案合理,规避了自改系统最常见坑(运行时原地改)。按"蓝绿>原地杀更、制品>快照、健康门>agent 自判"三处调整后,即 K8s/自托管 updater/DB migration 标准做法。Node 侧"热更"务实作"优雅重启"看;真零中断需蓝绿双进程切流。
