# Agent 实例化（Definition / Instance 拆分）设计文档

> 背景：当前 elf 的 gateway 与 agent 之间是「一个 agent = 一个单例常驻进程」的关系。打开页面交互时，接的永远是同一段对话上下文、同一个工作目录，没有「新开会话 = 干净开始」的语义。
> 目标：对标 Claude Code（下称 CC）——`claude` 命令每次启动即一个新 session，有独立 cwd、独立 transcript、独立进程，可 `--resume` 选历史会话。
> 落地：把「agent」拆成 **Definition（模板）** 与 **Instance（会话实例）** 两层；每个实例拥有独立工作空间（workspace）与独立数据，一切 Bash / 文件读写都限定在该工作空间内。
> 本期范围：给 elf 引入实例化能力，覆盖数据模型、工作空间注入、进程模型、路由、生命周期与迁移路径。

---

## 0. TL;DR

| 现状 | 改造后 |
|---|---|
| `agents/<id>/` 既是配置又是会话数据 | `agents/<id>/config/`(模板) + `agents/<id>/instances/<iid>/`(会话) |
| `ProcessManager.agents: Map<agentId, 单条>` | `Map<instanceId, {...}>`,动态端口池 |
| Bash cwd = `process.cwd()`(项目根,会误操作 elf 源码) | Bash cwd = `instance.workspace` |
| 数据: `agents/<id>/data/{context,history}` 全局单份 | 每实例独立 `instances/<iid>/data/`,可 resume |
| 路由 `/agents/:id/*` | 新增 `/agents/:id/instances/*`,模板路由保留 |
| 打开页面 = 接唯一单例 | 打开页面 = 选/建一个实例 |

阶段化交付:§7 给出四阶段,阶段 1（工作空间注入）可独立交付核心体感,且低风险。

---

## 1. 现状诊断

### 1.1 数据流与寻址

- `ProcessManager`(`gateway/process_manager.js`) 内部 `agents: Map<agentId, { port, pid, status, config }>`,**一对一**:一个 agentId 对应一个 detached 进程、一个固定端口(写在 `config.json` 的 `port` 字段)。
- 数据目录由 `default_agent.js:81` 固定算出:`dataDir = path.join(configDir, '..', 'data')` → 即 `agents/<id>/data/`,内含全局唯一的 `context.json`(LLM 上下文) + `history.jsonl`(`message_manager.js:38`)。
- 网关路由 `gateway/server.js` 全部以 `/agents/:id/*` 寻址,`chat_proxy` 透传到该 agent 的端口。
- 《历史》分页(`chat_history.js:35`)路径前缀同样是 `agents/<agentId>/data/`。

→ 结论:第二次打开页面接的是**同一段对话上下文**,没有「新会话」的概念。

### 1.2 工作目录缺位

- `Bash.js:60` `spawn('bash', ['-c', command], { env, stdio })` —— **没有 `cwd`**,实际落在 `process.cwd()`(elf 项目根)。这意味着 agent 跑 Bash 默认就在 elf 自己的源码目录里操作,**存在误删源码的风险**。
- `Read/Write/Edit/Glob/Grep` 收的都是**绝对路径**(`Read.js:29` description 明写 "absolute path"),工具层完全不感知「工作空间」。模型被要求自己拼绝对路径,缺少相对路径解析与工作目录提示。
- 唯一有「实例」味道的是 subagent(`tools/Agent.js:65`):临时 `mkdtempSync` 一个 dataDir、复用父 model、跑完即清。但它在 loop 内部,不暴露给用户,也没有 workspace 概念(子 agent 照样跑在项目根 cwd)。

### 1.3 与 CC 的根本差别

CC 里 `claude` 每次启动 = 一个新 session:独立 cwd、独立 transcript(`~/.claude/projects/<cwd-hash>/*.jsonl`)、独立进程,可 `--resume` / `--continue` 选回历史会话。elf 现在 = 「一个 agent 永远只有一个活着的会话」,且 Bash 全局共享项目根 cwd。这两点正是本次要修的。

---

## 2. 核心概念重构:Definition vs Instance

把现在混在一起的「agent」拆成两层:

| 层 | 对应现有物 | 职责 | 生命周期 |
|---|---|---|---|
| **Agent Definition**(模板) | `agents/<id>/config/` | agentClass / tools / systemPrompt / model 配置 / 压缩配置 / subagents 启用集 | 长期,热加载 |
| **Agent Instance**(会话实例) | 现在没有,本次新增 | workspace(cwd) + 独立 context.json / history.jsonl + 一个进程 | 用户开/关,可 resume |

- **Definition 决定「它是什么样的 agent」**(用什么模型、哪些工具、什么 system prompt、怎么压缩)。
- **Instance 决定「这一次对话在哪个工作空间、带着哪段历史」**(类比 CC 的 session)。
- 用户「打开页面进行交互的应该是一个 agent 的实例」= Instance;「不是一个 agent 就是一个单例」= Definition 与 Instance 分离。

### 与 CC 的概念对照

| CC | elf 改造后 |
|---|---|
| `claude` 启动 = 新 session | 新建 Instance(`POST /instances`) |
| session 的 cwd | `instance.workspace` → 注入 Bash / 文件工具 |
| `~/.claude/projects/<cwd-hash>/*.jsonl` transcript | `instances/<iid>/data/history.jsonl` |
| `--resume` / `--continue` | 列实例 + start + `reloadFromDisk` |
| 项目级 `.claude/settings.json` | `agents/<id>/config/`(Definition) |
| 每 session 一进程(单机 CLI) | 每实例一进程(选 §4 方案 A) |

---

## 3. 数据模型

### 3.1 目录结构

```
agents/<id>/                          # Definition（模板,不变）
  config/
    config.json                       # 模板配置（port 字段语义降级,见 §3.4）
    system_prompt.md
    api_key.json
    ...
  instances/                          # ← 新增:该 agent 的所有会话实例
    <instanceId>/                     # instanceId = uuid 或 时间戳短码
      workspace/                      # 该实例工作空间(cwd);可为「外部绝对路径引用」模式
      data/
        context.json                  # 实例独立 LLM 上下文
        history.jsonl                 # 实例独立聊天记录
        tool-results/                 # L1 工具结果
      meta.json                       # 实例元数据,见 §3.2
```

- 现有 `agents/<id>/data/` 迁移成「默认实例」一次性平迁(§8),新会话一律走 `instances/<iid>/`。
- `workspace/` 有两种模式(见 §5.2):**managed**(elf 在 `instances/<iid>/workspace/` 下建空目录)与 **external**(实例只记录一个外部绝对路径作为 cwd,不在 instances 下复制文件)。

### 3.2 meta.json

```jsonc
{
  "instanceId": "a1b2c3",
  "agentId": "elf-002",          // 反向引用模板
  "title": "重写 user 模块",       // 首条 user message 摘要,侧栏展示用
  "workspace": "/abs/path/to/cwd", // 工作空间绝对路径
  "workspaceMode": "managed",    // managed | external
  "createdAt": "2026-06-30T...",
  "lastActiveAt": "2026-06-30T...",
  "status": "stopped",           // running | stopped | crashed
  "port": 8093,                  // 当前占用端口(running 时),回收后置 null
  "pid": null                    // 进程 pid,回收后置 null
}
```

`meta.json` 是侧栏会话列表、resume、空闲回收的唯一数据源,落盘以保证 Gateway 重启后可恢复。

### 3.3 进程管理器内部结构

`ProcessManager.agents` key 从 `agentId` 换成 `instanceId`:

```js
// Map<instanceId, { agentId, port, pid, status, config, workspace, instanceMeta }>
this.instances = new Map();
```

`listAgents()`(模板视图) 仍按 Definition 聚合,但每个 agent 附带其实例列表;新增 `listInstances(agentId)`。

### 3.4 config.json 的 `port` 字段语义降级

现状:每个 agent `config.json` 写死 `port`(8081/8082),进程绑定该端口。实例化后每实例一进程、端口动态分配,固定 `port` 失去意义:

- `port` 降级为「建议起始端口」或**移除**,改由 `ProcessManager` 维护端口池(`8090+`,启动时探活占用情况后递增分配)。
- 模板配置其余字段(tools / systemPrompt / model 配置 / 压缩配置 / subagents / maxIterations / agentClass / messageManagerClass)不变,沿用现有 `Config` 加载与热加载机制。

---

## 4. 进程模型:每实例一进程(方案 A,推荐)

两条候选路线:

### 方案 A:每实例一进程(对齐 CC,推荐)

一个 instance = 一个 detached Node 进程,动态分配端口。

- **优点**:隔离最干净——abort / 崩溃 / 内存 / 文件描述符互不影响,符合 CC 用户体感;现有 `ProcessManager` 本就是进程级,把 key 从 `agentId` 换成 `instanceId`、端口从固定改动态,改造顺;`rewind` / `abort` / `compact` / config 热加载 这些「针对一个进程」的能力**几乎不用改**,只是寻址 key 换了。
- **代价**:多会话 → 多进程,资源(内存/端口/FD)开销大,必须有空闲回收兜底(§6.2),否则长跑会爆。

### 方案 B:单 agent 进程内多 actor

一个 agent 进程内跑多个会话,`MessageManager` 按 instanceId 分桶,agent loop 串行/并发处理多实例请求。

- **优点**:省资源。
- **代价**:要重做 agent loop 的并发与 abort 隔离——现状 `server.js` 的 `isProcessing` / `pendingMessage`、`default_agent.js` 的 `_abortController` / `_aborted` 都是**单会话级全局态**,多 actor 共用会互相串扰;改造深,回归风险高。与「对标 CC 每 session 一进程」的目标偏离。

**结论:选 A。** 资源问题用空闲回收解决,不值得为省进程而把 agent loop 改成多 actor。

### 进程启动参数

`startAgent` 现状:`spawn(process.execPath, [entryFile], { cwd: process.cwd(), detached, stdio:'ignore' })`(`process_manager.js:238`)。实例化后:

- `entryFile` 仍是 `agents/<id>/index.js`(委托 `shared/agent/start.js`)。
- 传参:`start.js` / `fromConfigDir` 增加接收 `instanceId` + `workspace`,内部用它定位 `instances/<iid>/data/` 与注入 workspace。
- 传参方式:沿用 CLI `--config <dir>` 风格,新增 `--instance <iid>`(或扩展 config 目录指向 `instances/<iid>/`)。`start.js:78` 的 argv 解析处扩展即可。

---

## 5. 工作空间(workspace / cwd)注入 —— 改动核心

这是本次改动的技术核心。现有工具层完全不感知 workspace,需要把它一路传到每个工具。

### 5.1 注入链路(复用已有 ctx 通道)

关键观察:`ToolRegistry.execute(name, args, signal, ctx)` 已经透传 `ctx`,且 `default_agent.js:374 / 395` 调用时传的就是 `{ agent: this }`。**这条链路已存在,改动极小**:

1. **入口**:`Agent` 增加 `this.workspace` 字段。`fromConfigDir(configDir, options)` 增加 `workspace` 参数(或从实例配置读取),构造时写入。
2. **透传**:`execute(...)` 的 `ctx` 从 `{ agent }` 扩成 `{ agent, workspace }`(或下游直接读 `ctx.agent.workspace`)。无需改 registry 签名,只改调用点带上 workspace。
3. **工具消费**:各工具在 `execute(args, signal, ctx)` 里读 `ctx.workspace`。

```
fromConfigDir --workspace--> Agent.workspace
                                   │  (default_agent.js 调 execute 时带上)
                                   ▼
              ToolRegistry.execute(name, args, signal, { agent, workspace })
                                   │
       ┌───────────────────────────┼───────────────────────────┐
       ▼                           ▼                           ▼
   Bash (cwd)              Read/Write/Edit/Glob/Grep       Agent(subagent)
   spawn({cwd:workspace})   相对路径 path.resolve(workspace,p)  继承父 workspace
```

### 5.2 workspace 两种模式

- **managed**:elf 在 `instances/<iid>/workspace/` 建空目录作为 cwd。适合「让 agent 在沙盒里自由创建文件」的场景,不碰用户已有项目。
- **external**:实例只记录一个外部绝对路径(如 `/Users/wolf/Desktop/some-project`),cwd 直接设为它,不在 instances 下复制文件。适合「在某个现有项目里干活」。新建实例 API 的 `{ workspace }` 参数即指定它;不传则默认 managed。

### 5.3 各工具改动

| 工具 | 现状 | 改动 |
|---|---|---|
| **Bash** | `spawn('bash',['-c',cmd],{env,stdio})` 无 cwd | 加 `{ cwd: ctx.workspace, env, stdio }`。对齐 CC「一切 bash 在设定工作空间进行」 |
| **Read** | 要求绝对路径 | ① 相对路径 `path.resolve(workspace, p)`;② 路径提示随 system-reminder 注入「工作目录是 X」 |
| **Write / Edit** | 绝对路径 | 同 Read,相对路径按 workspace 解析;权限可考虑限制在 workspace 内(可选) |
| **Glob / Grep** | 绝对/当前目录模糊 | 默认根目录 = workspace(对齐 CC 固定 cwd 语义),相对模式按 workspace 解析 |
| **Agent(subagent)** | 子 agent 复用父 model/config,临时 dataDir,但 cwd 仍是项目根 | `Agent.js:88` 构造 subAgent 时令 `workspace = parentAgent.workspace`,子 agent 同工作空间干活;语义自然,改动一行 |

### 5.4 模型侧:工作目录提示

对齐 CC 的 `Environment` 块 —— 在实例的 system-reminder(或 system prompt 前缀)注入:

```
# Environment
Working directory: /abs/path/to/workspace
```

让模型知道 cwd,从而倾向于用相对路径、bash 不必每次 `cd`。复用现有 `docs/claude-code-system-reminder-injection.md` 的注入通道。

### 5.5 安全收益(顺带修缺陷)

当前 Bash 跑在项目根 → agent 可能 `rm` 到 elf 自己的源码。实例化 + workspace 注入后,Bash 默认限定在用户指定工作空间,**天然消除这个误操作面**。这是一项独立于「多会话」的安全收益。

---

## 6. 路由与生命周期

### 6.1 网关路由

模板级路由(`/agents`、`/agents/:id/config`、`/agents/:id/config-ui`)保留,作用域是 Definition。新增实例级路由:

```
POST   /agents/:id/instances                 # 新建实例  body:{workspace?, workspaceMode?} → {instanceId, port, status}
GET    /agents/:id/instances                 # 列出该 agent 的所有会话(meta 摘要,供侧栏)
GET    /agents/:id/instances/:iid            # 实例详情(meta + status)
POST   /agents/:id/instances/:iid/start      # 启动进程(新建即启动则可省)
POST   /agents/:id/instances/:iid/stop       # 停止进程,保留 data(可 resume)
POST   /agents/:id/instances/:iid/chat       # SSE,透传到该实例端口
POST   /agents/:id/instances/:iid/abort      # 中断当前回复(透传 /abort)
GET    /agents/:id/instances/:iid/history    # 分页历史
DELETE /agents/:id/instances/:iid            # 删实例(杀进程 + rm -rf instances/<iid>/)
DELETE /agents/:id/instances/:iid/memory     # 只清 context.json,保留 history(resume 友好)
POST   /agents/:id/instances/:iid/rewind     # 复用现有 rewind(/reload 透传)
```

向后兼容(过渡期):`/agents/:id/chat` 等单例路由可保留为「默认实例」的别名,迁移完成后再删。

### 6.2 生命周期

- **新建实例** = 建 `instances/<iid>/` 目录结构 + spawn 进程(分配端口)+ 写 `meta.json` → 返回 instanceId。前端「新对话」按钮调它。
- **空闲回收**:实例 N 分钟(默认建议 30min,可配)无活动 → Gateway 发 `/shutdown` 停进程、保留 `data/` 与 `meta.json`(status→stopped, pid/port→null)。由 `meta.lastActiveAt` 驱动,Gateway 定时扫描。回收后磁盘数据仍在 → 可 resume。
- **resume**:点历史会话 → 若进程在跑直接连 SSE;若已回收则重新 spawn 进程 + Agent `reloadFromDisk`(`server.js:194` 已有 `/reload` 端点,天然复用)从 `context.json` 恢复内存 messages。
- **删除实例**:杀进程 + `rm -rf instances/<iid>/`(`meta` 一并删除,不可恢复,前端二次确认)。

### 6.3 现有能力在实例模型下的迁移

| 能力 | 现状 | 实例化后 |
|---|---|---|
| `rewind` | gateway 整文件覆盖 `data/` + agent `/reload` + streaming 守卫 | 路径前缀加 `instances/<iid>/`,其余不变 |
| `abort` | 透传 `/abort` | 寻址 key 换 instanceId,不变 |
| `compact` | MessageManager 进程内,落 `context.json` | dataDir 指向实例目录,不变 |
| config 热加载 | `fs.watch(configDir)` → `reloadConfig` | 见 §6.4 |
| history 分页 | `chat_history.js` 按 `agents/<id>/data/` | 路径前缀加 `instances/<iid>/` |

### 6.4 Definition 热加载对运行中实例的生效策略

Definition 配置(system prompt / tools / 压缩阈值)变更时,对**正在运行的实例**如何生效?两种选择:

- **即时 reload**(现状):`fs.watch` 触发 `reloadConfig()`,运行中实例立即生效。
- **仅新实例生效**(对齐 CC):CC 是新 session 才读最新配置,运行中 session 不变。

**推荐照搬 CC:仅新实例生效**。理由:运行中实例的对话上下文是按旧 system prompt 建立的,中途换 prompt 会让早期 messages 与新 system 不一致,语义割裂;且实例化后用户随时可「新建实例」拿到最新配置,无需热侵入旧会话。`fs.watch` 可仅用于刷新模板缓存(供新建实例读取),不再 `reloadConfig` 现存实例。

---

## 7. 迁移路径(四阶段,可独立交付)

### 阶段 1:工作空间注入(最小价值切片,低风险)

- `Agent` 加 `workspace`,`ctx` 带 workspace,Bash 注入 cwd,文件工具做相对路径解析。
- **此时仍是单例**,但已有「工作空间」概念,可独立验证。
- 顺带修掉 §5.5 的 Bash 误操作源码的风险。
- **交付即可用**:用户能指定一个工作目录,Bash/文件操作限定其中。

### 阶段 2:实例化数据层

- 引入 `instances/<iid>/data/`,`ProcessManager` key 换 instanceId,加动态端口池。
- 旧 `agents/<id>/data/` 作为「默认实例」一次性平迁(§8)。
- `meta.json` 读写。

### 阶段 3:路由 + 前端

- 实例 CRUD 路由(§6.1)。
- 前端侧栏从「agent 列表」演化为「agent → 会话列表」两级;「新对话」按钮、会话切换、resume。

### 阶段 4:生命周期

- 空闲回收(定时扫描 `meta.lastActiveAt`)+ resume(回收后重 spawn + reload)。
- Definition 热加载策略切换为「仅新实例生效」。

**阶段 1 单独就能交付「每个会话有自己的工作空间」的核心体感**,后续阶段是把它多会话化。建议按序推进,每阶段可独立验证、独立上线。

---

## 8. 一次性迁移(旧 `agents/<id>/data/` → 默认实例)

阶段 2 上线时,把存量 `agents/<id>/data/` 平迁为该 agent 的「默认实例」,避免历史对话丢失:

```
agents/<id>/data/                  →  agents/<id>/instances/default/data/
                                       meta.json: { instanceId:"default", workspace: <推断>, status:"stopped" }
```

- `workspace` 推断:旧单例无 workspace 概念,默认填 `process.cwd()`(项目根)或留 managed 空目录,由用户后续新建实例时显式指定。
- 迁移脚本写入 `scripts/`,幂等(已存在 `instances/default/` 则跳过)。
- `meta.json.createdAt/lastActiveAt` 取 `data/context.json` 的 mtime 或 history.jsonl 首行时间。
- 兼容期:`/agents/:id/*` 单例路由内部重定向到 `instances/default/`,迁移确认后再删旧路由。

---

## 9. 风险与权衡

| 风险 | 说明 | 对策 |
|---|---|---|
| **进程数膨胀** | 每实例一进程,多会话/多用户时进程、端口、FD 暴涨 | 空闲回收(§6.2)+ 端口池上限告警;长期可评估方案 B 兜底,但非本期 |
| **端口从固定变动态** | `config.json` 的 `port` 字段语义变化,前端/文档/API/`probeAgent` 全依赖固定端口 | `port` 降级/移除,`meta.json` 记录运行端口,`probeAgent` 改按 instanceId+meta 查 |
| **路径前缀扩散** | `agent/data/` → `agent/instances/<iid>/data/`,`chat_history`、`rewind`、`/memory`、`/clear` 等多处硬编码路径 | 集中一个 `instanceDataDir(agentId, iid)` 计算函数,所有路径经它派生 |
| **Definition 热加载语义变化** | 从「即时 reload」改为「仅新实例生效」,运行中实例不再跟随配置变更 | 文档与前端提示明确;新建实例即得最新配置,无需侵入旧会话 |
| **workspace 安全边界** | external 模式下 cwd 指向用户任意路径,文件工具可能越界写 | 可选:加 workspace 内写限制(类似 CC 权限墙);本期先靠 workspace 收窄默认面,权限墙作后续 |
| **subagent workspace 继承** | 子 agent 若不继承父 workspace,会回退到项目根,重现阶段 1 的误操作风险 | 阶段 1 同步改 `Agent.js` 令子 agent 继承父 workspace(§5.3) |

---

## 10. 与 CC 的最终对照(验收视角)

| CC 行为 | elf 实例化后是否对齐 | 备注 |
|---|---|---|
| `claude` 启动 = 新 session,干净上下文 | ✅ | `POST /instances` 新建,空 context |
| session 有独立 cwd | ✅ | `instance.workspace` 注入 Bash/文件工具 |
| `--resume` 选历史会话 | ✅ | 列实例 + start + reloadFromDisk |
| `--continue` 续最近的会话 | ✅ | 前端默认打开 lastActiveAt 最新的实例 |
| transcript 落盘、跨进程恢复 | ✅ | `instances/<iid>/data/history.jsonl` + meta |
| 每 session 一进程 | ✅ | 方案 A |
| 新 session 读最新项目配置 | ✅ | §6.4 仅新实例生效 |
| working directory 提示进 context | ✅ | §5.4 Environment 块注入 |

机制上 1:1 可对齐。elf 已有 subagent 的「临时实例」先例(`Agent.js` 临时 dataDir + 复用父引擎),主路径引入实例化是顺势而为,非推倒重来。

---

## 附:改动文件清单(预估)

| 文件 | 改动 |
|---|---|
| `shared/agent/default_agent.js` | `fromConfigDir` 接收 workspace;`Agent.workspace`;execute 调用带 workspace |
| `shared/agent/start.js` | argv 解析 `--instance`;传 workspace |
| `shared/agent/server.js` | `/status` 返回 instanceId+workspace;不涉大改 |
| `shared/agent/message_manager.js` | `dataDir` 由实例目录派生(已参数化,基本不动) |
| `shared/agent/tools/Bash.js` | `spawn` 加 `cwd: ctx.workspace` |
| `shared/agent/tools/Read.js` / `Write.js` / `Edit.js` / `Glob.js` / `Grep.js` | 相对路径按 workspace 解析 |
| `shared/agent/tools/Agent.js` | subagent 继承父 workspace |
| `gateway/process_manager.js` | key 换 instanceId;动态端口池;`listInstances`;实例元数据 |
| `gateway/server.js` | 新增 `/agents/:id/instances/*` 路由 |
| `gateway/chat_history.js` | 路径前缀加 `instances/<iid>/` |
| `gateway/index.js` | 启动扫描 instances 目录、resume 探活 |
| `frontend/src/**` | 侧栏两级(agent→会话)、新对话按钮、会话切换/resume |
| `scripts/migrate-instances.js` | 新增:旧 data/ → default 实例迁移 |
| `agents/<id>/config/config.json` | `port` 字段语义降级(注释或移除) |
