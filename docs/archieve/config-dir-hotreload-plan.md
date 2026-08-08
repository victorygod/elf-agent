# 全局配置目录化 + 热更新方案

## 背景

全局模型库改造后，生产路径（`startAgentServer`，被 gateway spawn 的共享 agent-server 子进程）此前**没有任何配置热更新**：在前端改了模型 / agent 模型配置，子进程里的 live agent 实例不会 reload，导致"配了模型还报未配置"。已在 `startAgentServer` 补 `fs.watch`（监听每个 agent configDir + 根 `api_key.json`）缓解。

但当前 watcher 仍有缺口：

1. **监听单文件 `api_key.json`，启动时不存在就漏**：子进程启动时若 `api_key.json` 还没建（用户首次未配模型），`fs.watch` 抛 ENOENT 被吞，之后用户在前端建了模型库也感知不到。被 agent configDir watcher 兜底（选 model_id 会写 config.json），但"只改模型库、不动 model_id"的边角场景不 reload。
2. **监听项目根不现实**：太吵，任何文件变更都触发。
3. **配置散落项目根**：`api_key.json`、`gateway.json` 都堆在根，无组织。

## 方案

新建项目根 `config/` 目录，集中存放**平台级全局配置**：

```
config/
  api_key.json      # 全局模型库（secrets，gitignore）
  gateway.json      # 平台级配置（端口等）
```

agent-server 子进程 `fs.watch(config/)` 全目录监听 → debounce → reload。目录存在即可监听，**文件后建也能感知**，缺口 1 根除；只放这两类配置，**不吵**（缺口 2 解决）；配置集中（缺口 3 解决）。

> agent 自身配置 `agents/<id>/config/` 不动——它是 per-agent 的，继续各自 watcher。

## 改动点

### 1. 路径收口

- `gateway/api_key_store.js`：`getApiKeyFile()` 改为 `path.join(_rootDir || process.cwd(), 'config', 'api_key.json')`。新增 `getConfigDir()` helper 供 watcher 用。
- `gateway/config.js`：`gateway.json` 路径改为 `path.join(projectRoot, 'config', 'gateway.json')`。

### 2. watcher 改为目录监听 + debounce

`engine/start.js:startAgentServer`：
- 保留每个 agent configDir 的 `fs.watch`（per-agent 配置/提示词热更新）。
- 把"监听单个 `api_key.json`"换成 `fs.watch(configDir, { persistent:false })`，回调里按 filename 分流：`api_key.json` 变 → `reloadAllLiveAgents()`；`gateway.json` 变 → gateway 侧自行处理（见下）。
- 加 **debounce ~200ms**（OS 一次写可能触发多次事件），合并成一次 reload。

### 3. gateway 侧 gateway.json 热读

`loadGatewayConfig` 当前启动时读一次并缓存。`gateway.json` 搬进 `config/` 后，gateway 进程也可以 `fs.watch(config/)`，`gateway.json` 变时清缓存、下次 `loadGatewayConfig()` 重读。
- 注意：端口字段改了不能热生效（listen 已占端口），需重启 gateway；其余可热读。文档注明。

### 4. .gitignore

`**/api_key.json` 已覆盖 `config/api_key.json`，无需改。确认 `config/` 目录本身可入库（只忽略其中的 secrets 文件）。

### 5. 一次性迁移（不留兼容，对齐 CLAUDE.md）

启动时（gateway/index.js 或各 store init）：若旧路径 `./api_key.json` 或 `./gateway.json` 存在而 `config/` 下没有对应文件，搬移过去并删旧。搬完即纯新路径，不再回退读旧位置。

## 测试影响

- `test/api_key_store.test.js`、`test/gateway.config-store.test.js`、`test/shared.test.js`：用 `setApiKeyStoreRootDir(tmp)` 隔离。改后这些 tmp 下要建 `config/` 子目录放 `api_key.json`。逐个改 setup。
- `test/gateway.test.js`：已用临时 root，同样加 `config/` 子目录。
- 真实 `config/api_key.json` 全程不碰（已验证测试不碰真实文件，搬迁逻辑只对"旧路径存在"生效，测试环境无旧路径则不触发）。

## 风险

- **路径变更面广**：api_key_store + gateway/config + 测试 setup + 搬迁逻辑。可控，纯路径替换。
- **fs.watch 平台差异**：macOS/Linux 对目录监听可靠；debounce 兜底多次触发。Windows 不在支持范围。
- **gateway.json 端口热读误用**：文档注明端口改需重启，避免用户误以为改端口即时生效。

## 验证

1. 首次未配模型时启动 → 前端建模型库 + 选 model_id → 不重启即时生效（原缺口 1 场景）。
2. 改模型库 base_url/auth_token（不动 model_id）→ 即时 reload all（验证 config/ watcher）。
3. 改 agent 提示词 → 即时 reload（per-agent configDir watcher 保留）。
4. `config/gateway.json` 改非端口字段 → gateway 热读生效。
5. 全量测试绿，真实 `config/api_key.json` 不被动。

## 不在本方案内（待后续）

- 单 agent 入口（`startAgent`/`agents/<id>/index.js`）清理——已记忆，另行处理。
- 前端 toast 双机制收敛——代码卫生，另行处理。
- `gateway/config-ui.js`、18 个 `agents/*/config/api_key.json` 死文件清理——统一清理。

---

**文档版本**：1.0  
**创建日期**：2026-08-08  
**作者**：Elf Team