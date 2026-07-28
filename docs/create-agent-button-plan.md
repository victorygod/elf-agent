# 私聊区段新增「创建 agent + 私聊窗口」按钮方案

> 需求:在私聊(Sidebar 私聊区段)也像群聊那样新增一个 + 创建按钮,点击后弹表单,必填项只有「名字」,提交后创建一个配置与 elf-001 一致的 agent,并进入该 agent 的私聊窗口。
>
> **关键约束**:创建流程**完全不读写 `agents/elf-001`**——必须独立建一套**自包含模板**(`gateway/agent_template/`),数值上参考 elf-001 取值并固化在模板里,创建时从模板复制。elf-001 的存在/改动不影响新建。
>
> **新 agent 是白板**:三个 prompt 文件留空、头像留空、name 必填、agentId 自增;只保留 compactPrompt/compactSystemPrompt 和让 agent 能启动的运行字段。

---

## 现状关键事实(调研结论)

### 群聊的创建按钮(参照对象)
- 入口:`frontend/src/components/Sidebar.jsx:295-298`,群聊 sectionHeader 里一个 `+` 按钮,`onClick={() => setShowCreate(true)}`。
- 弹窗:`frontend/src/components/CreateRoomModal.jsx`。字段 `name`(可选,默认 `群${Date.now()%1000}`)、`selected`(Set\<agentId\>,至少 1 个)。提交:`createRoom(...) → loadRooms() → selectRoom(room.roomId)`。
- store:`frontend/src/stores/roomStore.js:76-80` `createRoom(name, members)`。
- API:`frontend/src/api/index.js:324-332` `POST /rooms`。
- 后端:`gateway/room_routes.js:53-64` → `roomManager.createRoom(name, members)`,`gateway/room_bus.js:672-683`。落盘 `profiles/rooms/<rid>/room.json`,schema `{ roomId, name, members, createdAt }`。

### 私聊面板(对应关系)
| 角色 | 群聊 | 私聊 |
|---|---|---|
| 主聊天面板 | `RoomChatPanel.jsx` | `ChatPanel.jsx` |
| 状态 store | `roomStore.js` | `agentStore.js` |
| 配置抽屉 | `RoomConfigDrawer.jsx` | `ConfigDrawer.jsx` |
| 数据模型 | `room_<ts>_<hex>` | 单 agent,roomId = `chat-<agentId>` |

- 私聊房 roomId 由 agentId 派生:`chat-<agentId>`(`room_routes.js:28-30` 的 `isPrivateRoom` / `privateAgentId`)。
- **私聊房是隐式创建的**:用户首条消息时由 ChatHistory 自动 mkdir `profiles/rooms/chat-<id>/`,无需显式建房间。
- **私聊区段目前没有 + 按钮**(Sidebar.jsx:317-345 只有标题),入口就是点已有 agent → `selectAgent`(agentStore.js:84-136,懒建 chat state + auto-start)。

### Agent 创建(关键:目前没有任何创建接口)
- **前端零创建入口**;只有 `loadAgents`(GET /agents)、`rediscoverAgents`(POST /agents/rediscover)、`startAgent`、`PUT /agents/:id/config`、`POST /agents/:id/avatar`。
- **后端没有 POST /agents**。agent 的诞生靠在 `agents/<id>/` 放好配置文件后,被 `ProcessManager._scanAgents()`(`gateway/process_manager.js:62-139`)扫描进内存(Map,status=stopped)。`POST /agents/rediscover` 触发该扫描。
- 因此必须**新建磁盘文件** + **rediscover** 才能「创建 agent」。

### elf-001 完整配置(克隆模板源)
目录 `agents/elf-001/`:
```
agents/elf-001/
├── index.js              # startAgent(configDir) 委托 engine/start.js(不含 agentId 硬编码)
├── create_agent.js       # 装配入口,agentId 取自 runContext(不含硬编码)
└── config/
    ├── config.json       # 主配置
    ├── config-ui.json    # 前端配置面板布局
    ├── api_key.json      # LLM 凭证
    ├── system_prompt.md
    ├── prefix_prompt.md
    ├── suffix_prompt.md
    ├── avatar.webp
    └── user_avatar.webp
```
`config/config.json`:
```json
{
  "agentId": "elf-001",
  "name": "大黑塔",
  "port": 8081,
  "avatar": "avatar.webp",
  "userAvatar": "user_avatar.webp",
  "provider": "llm",
  "systemPrompt":       { "type": "path", "content": "system_prompt.md" },
  "prefix_prompt":      { "type": "path", "content": "prefix_prompt.md" },
  "suffix_prompt":      { "type": "path", "content": "suffix_prompt.md" },
  "compactPrompt": "总结至今的对话内容",
  "compactSystemPrompt": "你是说话者的记忆系统，使用高度凝练的话语生成摘要。",
  "compactMode": "async",
  "memoryTokenLimit": 40000,
  "maxIterations": 0,
  "messageManagerClass": "message_manager",
  "interaction": { "strategy": "observe", "observe": { "observationWindowSec": 60 } },
  "tools": ["Read", "Bash", "Grep", "Glob"],
  "_ui": { /* 各字段 label/hint,ConfigDrawer 渲染用 */ }
}
```
其它 elf-00x 同构,仅 `agentId/name/port` 不同(例 elf-012 = `elf-012 / 阮·梅 / 8092`)。

### 端口分配
- config.json 的 `port` 手动指定。现有动态分配工具 `allocPort()`(`gateway/room_bus.js:377-386`,`net.createServer().listen(0)`),目前仅群聊副本 spawn 用。

---

## 方案总览

补两块:**后端「克隆 elf-001 → 创建 agent」接口** + **前端私聊 + 按钮 / 弹窗(只填名字)**。
私聊房 `chat-<agentId>` 隐式创建,所以「私聊窗口」不用单独建——agent 进列表 + `selectAgent` 即可。

---

## 一、后端:新增 `POST /agents` 克隆接口

**位置**:`gateway/server.js` 的 agent 路由区(47-218 行,`/agents/rediscover` 旁)。

**契约**:
```
POST /agents
body: { name: string }              // 必填,唯一必填项
resp: { agentId, name, port }
```

**内部逻辑**(建议独立到 `gateway/agent_scaffold.js`,由路由调用):

1. **生成 agentId**:扫描现有 `agents/elf-*` 取最大序号 +1(如 `elf-013`),需校验目录不存在;备选 `elf-<时间戳>`(绝对不重但风格不统一)。
2. **生成 agentId**(自增):扫现有 `agents/elf-*` 取最大序号 +1(如 `elf-013`);需校验目录不存在。
3. **分配 port**:`allocPort()` 动态拿空闲口 + 扫已加载 agent 的 `config.port` 兜底校验。
4. **从独立模板复制**到 `agents/<newId>/`(**完全不读 `agents/elf-001`**):
   - 模板目录由 `agent_scaffold.js` 直接读 `gateway/agent_template/`(见下节),把整套文件复制到 `agents/<newId>/`。
   - 复制完后**只覆写 `config/config.json` 的三个占位字段**:`agentId = <newId>`、`name = <入参,必填>`、`port = <分配 port>`。
   - 其余一切(空 prompt 文件、api_key.json、运行字段、_ui)**原样来自模板,不触碰 elf-001**。
5. **调 `pm._scanAgents()`** 把新目录增量扫进内存(全量重扫不覆盖已运行 agent,安全;新 agent 默认 stopped)。
6. 返回 `{ agentId, name, port }`。

> **原则**:`agents/elf-001` 在创建流程中**零读写**;模板是自包含的静态文件集,elf-001 删除/改动不影响新建。

---

## 一·补、独立模板目录

**位置**:`gateway/agent_template/`(**必须**在 `agentsDir = cwd/agents` 之外,否则会被 `_scanAgents` 当成 agent 扫描加载,占位 port 还可能冲突。`_scanAgents` 扫 `agents/` 下所有子目录、不过滤名字,见 `process_manager.js:62-139`)。

**目录内容**(提前固化的静态文件,数值上参考 elf-001 取值,但作为模板自带、与 elf-001 解耦):
```
gateway/agent_template/
├── index.js                    # 与 elf-001/index.js 同(委托 engine/start.js)
├── create_agent.js             # 与 elf-001/create_agent.js 同(agentId 来自 runContext)
└── config/
    ├── config.json             # 占位:agentId="__TEMPLATE__"/name=""/port=0,其余运行字段沿用 elf-001 取值
    ├── config-ui.json          # 与 elf-001 同(ConfigDrawer 布局)
    ├── api_key.json            # 自带一份可用凭证(与 elf-001 相同账号;模板自带,不读 elf-001)
    ├── system_prompt.md        # 空(0 字节)
    ├── prefix_prompt.md        # 空(0 字节)
    └── suffix_prompt.md        # 空(0 字节)
```

**模板 `config/config.json` 内容**(占位字段会被覆写):
```json
{
  "agentId": "__TEMPLATE__",
  "name": "",
  "port": 0,
  "avatar": "",
  "userAvatar": "",
  "provider": "llm",
  "systemPrompt":  { "type": "path", "content": "system_prompt.md" },
  "prefix_prompt": { "type": "path", "content": "prefix_prompt.md" },
  "suffix_prompt": { "type": "path", "content": "suffix_prompt.md" },
  "compactPrompt": "总结至今的对话内容",
  "compactSystemPrompt": "你是说话者的记忆系统，使用高度凝练的话语生成摘要。",
  "compactMode": "async",
  "memoryTokenLimit": 40000,
  "maxIterations": 0,
  "messageManagerClass": "message_manager",
  "interaction": { "strategy": "observe", "observe": { "observationWindowSec": 60 } },
  "tools": ["Read", "Bash", "Grep", "Glob"],
  "_ui": { /* 同 elf-001 的字段布局 */ }
}
```

**已确认属性**:
- 三个 prompt 文件内容空 + 头像字段空。
- `compactPrompt` / `compactSystemPrompt` **保留**(模板里固化 elf-001 的值)。
- 运行字段(provider/tools/interaction/compactMode/memoryTokenLimit/messageManagerClass/_ui)沿用 elf-001 取值,确保 agent 能启动。
- `api_key.json` 模板自带(同账号),创建时不读 elf-001。

**错误处理**:模板缺失 / 目录已存在 / port 分配失败 / 文件写入失败 → 400/500。

---

## 二、前端:Sidebar + 弹窗

### 2.1 Sidebar 私聊区段加 + 按钮
**位置**:Sidebar.jsx:317-345 私聊 sectionHeader,照搬群聊写法:
```jsx
<div className={styles.sectionHeader}>
  <span>私聊</span>
  <button className={styles.btnIconSm} onClick={() => setShowCreateAgent(true)} title="新建 agent">+</button>
</div>
```
+ `showCreateAgent` state(仿现有 `showCreate`)。

### 2.2 新建 CreateAgentModal.jsx
仿 `CreateRoomModal.jsx`,更简单:
- 只一个字段 `name`(必填),placeholder「给 TA 起个名字」。
- 提交:
```jsx
const { agentId } = await createAgent(name);   // 新增 store/api
await loadAgents();                            // 刷新列表
selectAgent(agentId);                          // 进入私聊面板,auto-start
```
- loading 态 / 错误提示照 CreateRoomModal 抄。

### 2.3 store + api
- `api/index.js` 加 `createAgent(name)`:`POST ${API_BASE}/agents`,body `{ name }`,返回 `{ agentId, name, port }`。
- `agentStore.js` 加 `createAgent` action(与 createRoom 对称;也可组件内直调 api)。

### 2.4 ChatPanel 无需改动
`selectAgent` 走 agentStore.js:84-136 已有逻辑:懒建 chat state + auto-start。私聊房首条消息自动 mkdir。**不动 ChatPanel / room 路由**。

---

## 三、各字段最终决定

| 项 | 决定 |
|---|---|
| agentId | **自增**:扫现有 `agents/elf-*` 取最大序号 +1(如 `elf-013`),与现有命名一致 |
| name | **必填**,唯一入参 |
| 模板源 | **独立模板** `gateway/agent_template/`,**不读 elf-001**;数值上参考 elf-001 取值并固化在模板里 |
| 提示词文件 | `system_prompt.md` / `prefix_prompt.md` / `suffix_prompt.md` **留空**(0 字节) |
| compactPrompt / compactSystemPrompt | **保留**(模板里固化 elf-001 的值) |
| 头像 | 留空(`avatar` / `userAvatar` 字段空) |
| port | `allocPort()` 动态拿空闲 + 兜底校验 |
| 行为字段(provider/tools/interaction 等) | **沿用 elf-001 取值**(固化在模板),保证 agent 能启动 |

---

## 四、关键风险 / 注意点

1. 新建后立即 `selectAgent` 进入新私聊,体验与群聊对称,符合预期。
2. **新 agent 是「白板」**:三个 prompt 文件空、头像空,只有名字 + compact 提示词 + 运行机制配置。
3. **api_key.json 复用 elf-001 凭证** → 同一 LLM 账号;后续要隔离 key 再说。system_prompt 等留空时,agent 仍可启动(空 prompt 不报错),但行为接近裸 LLM,后续可在 ConfigDrawer 填。
4. **port 冲突**:`allocPort()` 只保证「此刻空闲」,稳妥起见扫一遍已加载 agent 的 port 兜底校验。
5. **rediscover 增量性**:`_scanAgents` 全量重扫不覆盖已运行 agent,安全;新 agent 默认 stopped,selectAgent 时 auto-start。
6. **commit 钩子**:本仓库有「工具改动后自动 commit 成 fix」钩子,且 working tree 看磁盘别看 git status——落实代码时注意。

---

## 五、改动文件清单(落实时)

**后端**
- `gateway/agent_template/` — **新建独立模板目录**(`index.js` / `create_agent.js` / `config/*`,自包含,不依赖 elf-001)
- `gateway/agent_scaffold.js` — 新文件,从 `agent_template/` 复制 + 自增 id + 分配 port + 覆写 config.json 三字段的核心逻辑
- `gateway/server.js` — 加 `POST /agents` 路由(1 处),调用 agent_scaffold
- 可能微调 `gateway/process_manager.js` — 暴露增量「扫描单个 agent」方法(若不想全量 _scanAgents)

**前端**
- `frontend/src/components/Sidebar.jsx` — 私聊区段加 + 按钮 + state
- `frontend/src/components/CreateAgentModal.jsx` — 新文件,仿 CreateRoomModal
- `frontend/src/api/index.js` — 加 createAgent
- `frontend/src/stores/agentStore.js` — 加 createAgent action(可选)

**不动**:ChatPanel、roomStore、room_routes、room_bus、私聊房创建逻辑。