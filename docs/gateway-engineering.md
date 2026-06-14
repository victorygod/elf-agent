# Gateway 工程设计文档

---

## 1. 模块职责

```
gateway/
├── index.js               # 入口：启动流程编排
├── server.js              # Express 路由、中间件、SSE 透传
├── process_manager.js     # Agent 进程生命周期管理
└── config.js              # Gateway 配置加载
```

### 1.1 index.js — 入口

职责：启动流程编排，按顺序完成所有初始化。

```
启动流程:
  1. 加载 gateway.json
  2. 初始化 ProcessManager
  3. 扫描 agents/ 目录，发现所有 Agent
  4. 对每个 Agent:
     a. 读取 config/config.json 获取端口
     b. GET http://localhost:{port}/status 探活
        - 200 → 标记 running，记录映射（pid, port）
        - 不可达 → 仅标记 stopped（不自动启动）
  5. 默认启动第一个 Agent（POST /agents/:id/start）
  6. 注册子进程 exit 监听
  7. 启动 Express HTTP 服务，监听 gateway.json 中配置的端口
  8. 输出启动日志
```

导出：无。作为进程入口直接执行。

### 1.2 server.js — 路由与中间件

职责：定义所有 REST API 路由，处理 HTTP 请求/响应，SSE 透传。

**中间件**：
- `express.json()` — 解析请求体
- 日志中间件 — 记录请求方法和路径
- 错误处理中间件 — 捕获未处理异常，返回 500

**路由表**：

| Method | Path | 处理函数 | 说明 |
|--------|------|---------|------|
| GET | `/agents` | `listAgents` | 列出所有 Agent 及状态 |
| GET | `/agents/:id` | `getAgent` | 获取单个 Agent 详情 |
| POST | `/agents/:id/start` | `startAgent` | 启动 Agent 进程 |
| POST | `/agents/:id/stop` | `stopAgent` | 停止 Agent 进程 |
| POST | `/agents/:id/restart` | `restartAgent` | 重启 Agent 进程 |
| POST | `/agents/:id/chat` | `chatWithAgent` | 透传聊天请求（SSE） |
| GET | `/agents/:id/config` | `getAgentConfig` | 获取 Agent 配置 |
| PUT | `/agents/:id/config` | `updateAgentConfig` | 更新 Agent 配置 |

**SSE 透传实现**（`chatWithAgent`）：

```
chatWithAgent(req, res):
  1. 从 req.params 获取 agentId
  2. 从 ProcessManager 获取 agent 的 port
  3. 若 agent 状态非 running → 返回 503
  4. 设置 res 头: Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive
  5. 向 Agent 发起 POST http://localhost:{port}/chat，req.body 作为请求体
  6. 将 Agent 返回的 SSE 流逐行 pipe 到 res
  7. Agent 响应结束 → 关闭 res
  8. 任一端异常 → 发送 error 事件到 res → 关闭 res
```

关键点：Gateway 不解析 SSE 内容，只做字节级透传。

### 1.3 process_manager.js — 进程管理

职责：管理所有 Agent 子进程的生命周期。

**数据结构**：

```js
// agents: Map<agentId, {
//   port: number,
//   pid: number | null,       // running 时有值
//   status: 'running' | 'stopped' | 'error',
//   childProcess: ChildProcess | null,
//   config: object            // config.json 内容
// }>
```

**方法**：

| 方法 | 说明 |
|------|------|
| `discoverAgents()` | 扫描 `agents/` 目录，读取每个子目录的 `config/config.json`，填充 agents Map（状态均为 `stopped`） |
| `probeAgent(id)` | 对 agent 的 port 发 `GET /status`，存活则标记 `running` |
| `startAgent(id)` | `fork(agents/{id}/index.js)` → 记录 pid → 标记 `running` → 注册 exit 监听 |
| `stopAgent(id)` | `childProcess.kill()` → 标记 `stopped` |
| `restartAgent(id)` | `stop` + `start` |
| `getAgent(id)` | 返回 agent 信息 |
| `listAgents()` | 返回所有 agent 信息列表 |
| `onAgentExit(id, code)` | 子进程退出回调 → 标记 `error`（非零退出码）或 `stopped`（零退出码） |

**exit 监听处理**：

```js
childProcess.on('exit', (code, signal) => {
  agent.status = code === 0 ? 'stopped' : 'error';
  agent.pid = null;
  agent.childProcess = null;
  logger.info(`Agent ${id} exited with code ${code}, signal ${signal}`);
});
```

### 1.4 config.js — 配置加载

职责：加载 `gateway.json`。

```js
function loadConfig(): {
  port: number  // Gateway 端口，默认 8080
}
```

启动时调用一次，结果缓存。

---

## 2. 错误处理

| 场景 | 处理 |
|------|------|
| Agent 不存在（agents/ 下无此目录） | 返回 404，`{ error: "Agent not found" }` |
| Agent 已在运行时调用 start | 返回 409，`{ error: "Agent already running" }` |
| Agent 已停止时调用 stop | 返回 409，`{ error: "Agent already stopped" }` |
| Agent 进程不可达（chat 时 /status 失败） | 返回 503，`{ error: "Agent unavailable" }` |
| Agent 进程间通信超时 | SSE 发送 error 事件后关闭连接 |
| config.json 解析失败 | 启动时跳过该 Agent 并打警告日志，标记 `error` |
| fork 失败（端口被占用等） | 标记 `error`，返回 500 |

---

## 3. Agent 配置读写

Gateway 始终从文件系统读取和写入 Agent 配置，不依赖 Agent 的 `/config` 端点。Agent 的 `/config` 端点仅在 standalone 调试时使用。

**读取**（`GET /agents/:id/config`）：
1. 读取 `agents/{id}/config/config.json`
2. 对其中的 path 字段（如 `systemPromptPath`），读取对应文件内容，替换 path 为实际内容
3. 返回合并后的 JSON

**更新**（`PUT /agents/:id/config`）：
1. 接收部分更新的 JSON
2. 读取现有 `config.json`，合并更新
3. 若更新中包含 `systemPrompt`（字符串），写入 `config/system_prompt.md`，更新 `config.json` 中 `systemPromptPath` 指向它
4. 将合并结果写入 `config.json`
5. Agent 的 `fs.watch` 自动检测到文件变化，重载配置（无论 Agent 是否运行，写文件即可）

---

## 4. 前端功能需求（暂不实现）

以下为未来前端需支持的功能，当前仅记录需求：

- Agent 列表页：显示所有 Agent 及状态（running/stopped/error）
- 单个 Agent 详情：配置查看与编辑
- 操作按钮：启动、停止、重启
- 聊天界面：与 Agent 实时对话（SSE 流式展示）
- 状态实时更新：Agent 崩溃时前端即时反映

---

## 5. 启动流程伪代码

```js
async function main() {
  // 1. 加载配置
  const config = loadConfig();  // gateway.json

  // 2. 初始化进程管理器
  const pm = new ProcessManager();

  // 3. 扫描 agents/ 目录
  pm.discoverAgents();  // 读取每个 agents/{id}/config/config.json

  // 4. 探活已有进程
  for (const [id, agent] of pm.agents) {
    pm.probeAgent(id);  // GET /status → 存活则标记 running
  }

  // 5. 默认启动第一个 Agent（如果有）
  const firstAgent = pm.agents.keys().next().value;
  if (firstAgent && pm.agents.get(firstAgent).status === 'stopped') {
    pm.startAgent(firstAgent);
  }

  // 6. 启动 HTTP 服务
  const app = createApp(pm);
  app.listen(config.port, () => {
    logger.info(`Gateway listening on port ${config.port}`);
  });
}
```