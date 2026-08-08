# Agent 自定义 UI 方案

## 1. 目标

允许 Agent 在自己的目录下携带**前端 UI 组件**和**后端 API 处理器**，使 Agent 能够：

- 定义自己的聊天区页面布局（不再所有 Agent 共享同一个 ChatPanel）
- 定义自己的配置面板 tabs（替代目前 `config-ui.json` + `ConfigDrawer.jsx` 的硬编码分发）
- 携带自己的专属后端 API 路由（替代目前在 `gateway/server.js` 里写死的 elf-018 专有端点）

对没有自定义 UI 的 Agent 零影响。

## 2. 现状与问题

### 现状

前端目前有两套机制控制 Agent UI，但都是硬编码、不统一：

**config-ui.json** — 控制配置抽屉的 tab 布局：

```
config/config-ui.json（JSON 声明）
  → gateway/config-ui.js 读文件后返回前端
  → ConfigDrawer.jsx 遍历 tabs[]
    → 检查 tab.type:
        'game-state'     → <GameStatePanel />        ← 硬编码
        'skill-manager'  → <SkillManager />           ← 硬编码
        默认              → 遍历 fields[] 渲染 ConfigField
    → 额外：tab.key === 'prompt' → <LanguageStylesPanel /> ← 硬编码
```

**专属 API 端点** — elf-018 特有端点写死在 gateway：

```
gateway/server.js
  GET  /agents/:id/game-state       ← 读 lore 目录，拼 metadata
  PUT  /agents/:id/protagonist-name ← 改主角 frontmatter
  GET  /agents/:id/styles           ← CRUD 风格文件
  POST /agents/:id/styles
  PUT  /agents/:id/styles/:filename
  DELETE /agents/:id/styles/:filename
```

### 问题

1. **组件归属混乱**：`GameStatePanel` 等组件代码躺在 `frontend/src/components/`，但只有 elf-018 在用。加新 agent 的自定义 UI 就要改 SPA 代码
2. **硬编码 dispatch**：`tab.type === 'game-state'` 这种 switch 无法在运行时扩展，每加一种新 tab 都要改 `ConfigDrawer.jsx`
3. **聊天页无法定制**：`config-ui.json` 只管配置抽屉，所有 agent 用同一个 `ChatPanel`，无法自定义聊天区布局
4. **专属 API 散落**：elf-018 的 game-state / styles CRUD 写在 gateway/server.js 里，和其他通用路由混在一起

## 3. 方案：UI 目录 + manifest 声明

### 3.1 目录组织

```
agents/elf-018/
  config/
    config.json             ← 已有，不变
  ui/                       ← 新增：Agent 自带的 UI 文件
    manifest.json           ← 统一声明（页面 + 配置 drawer）
    DnDChatView/
      index.jsx             ← 聊天区主组件（可选）
      index.module.css
    GameStatePanel/
      index.jsx             ← 配置 tab 组件（可选）
      index.module.css
    LanguageStylesPanel/
      index.jsx
      index.module.css
    api.js                  ← 后端路由处理器
```

**无 `ui/` 目录** → 走当前默认逻辑，零影响。

### 3.2 manifest.json schema

```jsonc
{
  "uiType": "dm-game",

  // === 聊天区 ===
  "page": {
    // 可选，不设时聊天区渲染默认 ChatPanel
    "chatView": "DnDChatView"
  },

  // === 配置抽屉 ===
  "config": {
    "tabs": [
      {
        // 方式 A：自定义组件渲染整个 tab
        "key": "game-state",
        "label": "游戏状态",
        "component": "GameStatePanel"      // 指向 ui/ 下组件
      },
      {
        // 方式 B：标准字段自动渲染（同现状 fields 机制）
        "key": "prompt",
        "label": "提示词配置",
        "fields": [
          { "key": "systemPrompt", "type": "textarea", "label": "总纲 system_prompt" },
          { "key": "loop_outline_prompt", "type": "textarea", "label": "outline 大纲任务" }
        ]
      },
      {
        "key": "model",
        "label": "模型配置",
        "fields": [
          { "key": "base_url", "type": "text", "label": "API Base URL" },
          { "key": "auth_token", "type": "text", "label": "Auth Token" },
          { "key": "model", "type": "text", "label": "模型名称" }
        ]
      }
    ]
  }
}
```

### 3.3 manifest 发现

后端 gateway 启动时和前端 Vite 构建时，各自扫描 `agents/*/ui/manifest.json`：

- **Vite 构建** → `import.meta.glob` → 静态映射 `{ agentId: manifest }` → 编译进 SPA
- **Gateway 启动** → `fs.readdirSync` + JSON.parse → 注册 API 路由
- **Agent 列表 API** (`GET /agents`) 返回时，从 manifest 读取 `uiType` 字段，附在 agent 对象上

## 4. 组件加载

### 4.1 chatView 分歧

```
App.jsx 检测 activeAgentId
  → agent.uiType && agent.uiType 有对应 manifest?
    → 有 → AgentPageRenderer
        → 动态加载 manifest.page.chatView 指向的组件
        → 创建 Bridge 实例
        → <ChatView bridge={bridge} />
    → 无 → <ChatPanel key={agentId} />  ← 今天逻辑，一行不改
```

### 4.2 配置 tab 分歧

ConfigDrawer 渲染逻辑从：

```js
if (tab.type === 'skill-manager') → <SkillManager />     ← 硬编码
if (tab.type === 'game-state')    → <GameStatePanel />    ← 硬编码
tab.key === 'prompt'              → +<LanguageStylesPanel /> ← 硬编码
else → fields 渲染
```

改为：

```js
tab.component 存在
  → 动态加载 agents/<id>/ui/<component>
  → 渲染组件
tab.fields 存在
  → ConfigField 渲染（不变）
```

 `tab.component` 替代了 `tab.type` 的"自定义组件"角色，`tab.fields` 保持默认字段渲染，**`ConfigField` 组件本身不改**。

### 4.3 Bridge（SPA ↔ Agent UI 通信协议）

| 能力 | 说明 |
|---|---|
| chat 数据 | bridge.getTurns() / bridge.getActiveTurn() |
| 发送/中断 | bridge.send(text) / bridge.abort() |
| SSE 事件 | bridge.onEvent(handler) — 只收当前 agent 的事件 |
| 专属 API | bridge.call(method, path, body?) — 自动拼 agent 路径前缀 |
| 生命期 | 切 agent 时组件卸载，bridge 失效 |

Agent UI 组件只能通过 Bridge 与主 SPA 交互，**不直接访问 React store 或全局变量**。标准的数据驱动隔离。

## 5. 后端 API

Gateway 启动时，扫描 `agents/*/ui/manifest.json`：

- 检测到 manifest 提供 `api.js` →  `require()`
- `api.js` 导出数组：`[{ method, path, handler }]`
- Gateway 按 `/agents/:id/` 前缀挂 Express 路由
- **仅该 agent 的 profile 路径下生效**

```js
// 概念，非代码
// api.js 的 path 自动挂成:
// GET /agents/elf-018/game-state    → handler
// GET /agents/elf-018/styles        → handler
```

 `gateway/server.js` 中 elf-018 的硬编码端点移除，归入 agent 自身。

## 6. 降级链

前端决定渲染什么的优先级：

```
1. ui/manifest.json 有 page.chatView    →  AgentPageRenderer + 自定义聊天区
2. ui/manifest.json 有 config.tabs      →  ConfigDrawer 按 manifest 渲染（component / fields）
3. config/config-ui.json 存在           →  读取 config-ui.json 渲染（过渡期兼容）
4. config-ui.json 也不存在              →  buildDefaultLayout(config) 推字段
                                          ← 今天已有代码，不改
```

每一个切换点都是**纯新增**，不走现有 agent 的路径永远不变。

## 7. 迁移路径

| 阶段 | 内容 |
|---|---|
| Phase 1 | 建立 `ui/` 目录约定 + Vite glob 发现 + `AgentPageRenderer` 分歧 + Bridge 实现 |
| Phase 1a | elf-018 创建 `ui/manifest.json` + `DnDChatView`（左聊天右面板） |
| Phase 2 | `GameStatePanel`、`LanguageStylesPanel` 代码从 `frontend/src/components/` 搬入 `agents/elf-018/ui/`；ConfigDrawer.jsx 改 `tab.component` 动态加载 |
| Phase 3 | elf-018 专属端点从 `gateway/server.js` 移除 → `agents/elf-018/ui/api.js` |
| Phase 4（可选） | 废弃 `config-ui.json`，全部转为 manifest |

Phase 1 + 1a 即可覆盖 elf-018 "左聊天右面板"需求，后续 phases 向后兼容。

## 8. 影响范围

| Agent | ui/ 目录 | 页面 | 配置面板 | 说明 |
|---|---|---|---|---|
| elf-001~017 | 无 | ChatPanel（不变） | config-ui.json / buildDefaultLayout（不变） | 零影响 |
| elf-018 Phase 1a | 有 | DnDChatView + ChatPanel 嵌入 | manifest 声明 tabs | 新旧共存 |
| elf-018 Phase 2 | 有 | DnDChatView + 组件搬入 | manifest 声明 tabs + 自携组件 | `frontend/src/components/` 删除迁走的文件 |
| 未来新 agent | 可选 | manifest 声明 chatView | manifest 声明 tabs | 不碰 SPA 核心 |