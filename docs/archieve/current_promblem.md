1. ai润色出来的结果为什么会在正文对话框里写成：
```markdown
---
name: 边境小镇
description: 文明边缘的黄昏薄雾聚落，冒险者的起始之地。
---

玩家冒险的起始之地。小镇常年笼罩于黄昏薄雾中，街道由陈旧石板铺就。镇中心坐落着唯—酒馆与镇长所在的政厅。城镇位于文明边缘，紧邻幽深山林，因地缘靠近旧日遗迹与荒野，常被视为未知异频交汇的危险边境。
```
name和description不应该填在上面的单独的对话框里么？是因为返回内容格式有时候会多带了```markdown嘛？这种是不是解析的时候可以过滤一下？提示词里也可以限制一下？
而且点保存还说边境小镇.md不存在，明明存在的呀（边境小镇.md这个时候还有种子标，但是我希望如果我们处于setup界面，是不是应该先有一个临时的目录从seeds生成出来，用来帮我们编辑设定集的状态，等到点开始游戏了才把临时目录搬运到正式目录，这样也不会再出现seeds标了，因为永远都是从临时目录里显示的设定内容）

2.哪次改动把config 的布局给改了？原来默认的不是提示词配置、agent配置、模型配置三个界面嘛？我怀疑可能是我们改造ui分离那次？正常来讲如果不读config-ui.json了，每个agent是不是都得有个ui目录然后把config-ui.json的内容迁移进manifest.json里？

3. 为什么第一次对话之后，rewind没有可选项？

4. 切换用户后，当前页面的聊天历史仍然被前一个页面的污染，刷新后才好，是不是登陆后应先刷新dom？

5. 点注销应该弹窗提醒是否注销，注册应该让用户重复密码验证一致，同用户名不允许重复注册

6. 注销按钮应该在附近那个齿轮按钮的页面里，就是配置页面，配置页面还应该允许改密码。

---

## 分析结论与修复方案（2026-08-06 复盘补充，未改代码）

> 基于当前代码（HEAD = `bbc798b support multi-user`，其前一次 `3abf5b3 add ai-polish; add custom UI for agent`）与线上运行实例（gateway :8080 / agent-server :8180）的只读验证。

### 总览

| # | 根因 | 结论 | 方案级别 |
|---|---|---|---|
| 1a | LLM 输出被 ` ```markdown ` 代码块包裹 → `parseFrontmatter` 锚定开头匹配失败 → 整段（含 frontmatter）被当成正文 | 解析层剥 fence + 提示词禁代码块 | 小 |
| 1b | 种子文件在 `config/seeds/`，setup 的保存/删除却操作私聊房 `runtime/lore/` → 双源不一致，编辑种子条目 404 | 临时目录物化方案（按你的设计） | 中 |
| 2 | `3abf5b3` 废弃 `config-ui.json`（`gateway/config-ui.js` 恒返回 layout:null），无 manifest 的 agent 丢提示词 tab | 逐 agent 迁移到 `ui/manifest.json` | 批量文件 |
| 3 | `snapshotBeforeSend` 在目录存在前 `writeFileSync(context.json)` → ENOENT，外层空 catch 静默吞掉 → 每条私聊房首条消息必无快照 | 先 mkdir 再写 + 空 catch 补日志 | 小 |
| 4 | `logout` 不清 store；snapshot 合并把旧用户 turns 当"上翻历史"保留 → 切用户串历史 | 重置 store + chats 复合 key | 中 |
| 5 | 注销无确认、注册无二次密码 | 全修（重名注册后端已拦 409） | 小 |
| 6 | 注销在侧栏 ⏻ 不在齿轮页；后端无改密码接口 | 移入齿轮弹窗 + 新增改密端点 | 小 |

---

### 1a. AI 润色结果串进正文框 —— 剥 fence + 提示词约束

**根因**（已脚本复现）：

- `agents/elf-018/ui/api.js:595` 用 `parseFrontmatter(llmOutput)` 解析 LLM 输出。
- `engine/skills/parser.js:12` 的正则 `FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/` **锚定在字符串开头**。
- LLM 输出以 ` ```markdown\n---\nname:...` 开头时开头匹配失败 → 返回 `frontmatter: {}`、`body = 全文`（含 fence 和 YAML）。后端 `outDesc=''`、`outBody=整段`；前端 `GameSetupPanel.jsx:64-66` 只 setBody → name/description 全部以文本形式出现在正文框。
- `POLISH_SYS` 只写了"完整的 Markdown 文件（含 frontmatter）"，未禁止代码块包裹。

**修复方案**：

1. **解析层（不做"先删首尾行"，做"先判断再剥"）**：
   - 解析前先检测是否被 fence 包裹：首行匹配 `^```[A-Za-z0-9_+-]*\s*1. ai润色出来的结果为什么会在正文对话框里写成：
```markdown
---
name: 边境小镇
description: 文明边缘的黄昏薄雾聚落，冒险者的起始之地。
---

玩家冒险的起始之地。小镇常年笼罩于黄昏薄雾中，街道由陈旧石板铺就。镇中心坐落着唯—酒馆与镇长所在的政厅。城镇位于文明边缘，紧邻幽深山林，因地缘靠近旧日遗迹与荒野，常被视为未知异频交汇的危险边境。
```
name和description不应该填在上面的单独的对话框里么？是因为返回内容格式有时候会多带了```markdown嘛？这种是不是解析的时候可以过滤一下？提示词里也可以限制一下？
而且点保存还说边境小镇.md不存在，明明存在的呀（边境小镇.md这个时候还有种子标，但是我希望如果我们处于setup界面，是不是应该先有一个临时的目录从seeds生成出来，用来帮我们编辑设定集的状态，等到点开始游戏了才把临时目录搬运到正式目录，这样也不会再出现seeds标了，因为永远都是从临时目录里显示的设定内容）

2.哪次改动把config 的布局给改了？原来默认的不是提示词配置、agent配置、模型配置三个界面嘛？我怀疑可能是我们改造ui分离那次？正常来讲如果不读config-ui.json了，每个agent是不是都得有个ui目录然后把config-ui.json的内容迁移进manifest.json里？

3. 为什么第一次对话之后，rewind没有可选项？

4. 切换用户后，当前页面的聊天历史仍然被前一个页面的污染，刷新后才好，是不是登陆后应先刷新dom？

5. 点注销应该弹窗提醒是否注销，注册应该让用户重复密码验证一致，同用户名不允许重复注册

 且末行为 ` ``` `，是则剥掉首尾 fence 行，再走 `parseFrontmatter`。
   - 更稳的做法：给 `engine/skills/parser.js` 增加一个导出函数（如 `stripFence(text)`），把"剥 fence"做成可复用的前处理；`polishLore` 与未来所有解析 LLM Markdown 输出的地方统一先调它。也可直接增强正则一次把 fence 内的 frontmatter + body 整体匹配出来（meta 直接从内层拿），但不动 SKILL 解析的既有行为（SKILL.md 不会带 fence，改共享正则要回归 `test/skills.test.js`）。
2. **提示词**：`POLISH_SYS` 输出格式增加明确约束——"**直接输出 Markdown 原文，以 `---` 开头**；**禁止用 ` ``` ` 代码块包裹，禁止 ` ```markdown ` 开头/结尾**"。提示词只能降概率，解析层才是兜底。
3. 涉及文件：`engine/skills/parser.js`（新增 fence 兼容导出）、`agents/elf-018/ui/api.js`（polishLore 前处理 + `POLISH_SYS` 文案）。

---

### 1b. Setup 临时目录方案（按确认的设计）

**目标行为**：

1. 打开 setup 页面时：**临时目录存在 → 直接读临时目录展示**（不重新生成、不再有种子标）；**临时目录不存在 → 才从 `agents/<id>/config/seeds/lore/` 复制物化**。
2. setup 期间的所有编辑（lore 增删改 + 主角面板 + AI 润色的参考上下文）**全部读写临时目录**，不再读写 seeds、也不再读写正式 runtime。
3. 点「开始游戏」：把临时目录内容**复制**到正式目录（`runtime/lore/`，覆盖），再发开场白。**临时目录不删除**。
4. rewind 回第一步（无历史）→ `DnDChatView` 的 `hasHistory=false`（`agents/elf-018/ui/DnDChatView/index.jsx:159`）自动回到 setup 页 → 临时目录还在 → 展示之前的内容，无需重新从种子生成。
5. 种子标（`fromSeed`）整个概念删除（永远展示临时目录内容，天然无标）。

**落地要点**：

- 临时目录位置：`profiles/agents/<id>/rooms/chat-<uid>-<id>/setup/lore/`（与正式 `runtime/lore/` 同构：`{characters,items,locations,skills,quests}/` + `user_profile.md` + `state.md`）。跟随现有多用户房隔离，天然 per-user。
- 后端（`agents/elf-018/ui/api.js`）：
  - `GET /seeds` 语义改为"读临时目录；不存在则先物化再返回"（物化 = 从 `config/seeds/lore` 递归复制）。
  - lore CRUD（`GET/POST/PUT/DELETE /lore/:type...`）与 `PUT /user-profile` 增加 setup 模式参数（前端带 `mode=setup` 或 query），setup 模式下读写 `setup/lore/`，否则维持读写正式 `runtime/lore/`（右侧游戏状态面板等仍读正式目录，不受影响）。
  - 新增 `POST /setup/commit`：把 `setup/lore/` 递归复制到 `runtime/lore/`（覆盖）。「开始游戏」前端先调 commit，再 `bridge.send(openingMessage)`。
  - `polishLore` 在 setup 模式下，参考上下文（user_profile + 各类型交叉参考）改读临时目录。
- 前端（`GameSetupPanel.jsx`）：初始化逻辑改为"读临时目录（由新 `/seeds` 语义保证已物化）"，去掉 `fromSeed` 分支；保存/删除/润色请求带 setup 模式。
- 可选补充：setup 页可加一个「从种子重置」按钮（删临时目录重新物化），否则种子文件更新后旧临时目录不会自动刷新——按你的设计这不是必须项。

---

### 2. config-ui.json → ui/manifest.json 迁移

**确认**：就是 `3abf5b3`（UI 分离）干的。`gateway/config-ui.js` 从"读 `config-ui.json` 返回 layout"改为恒返回 `layout: null`（文件头注释已标 deprecated）。前端 `ConfigDrawer.jsx:128-134` 的优先级是 manifest tabs → layout → `buildDefaultLayout(config)`；无 manifest 的 agent 落到 `buildDefaultLayout`，它只生成 **Agent 配置 + 模型配置** 两个 tab（`ConfigDrawer.jsx:239-260`），**提示词配置 tab 丢失**（`prefix_prompt`/`suffix_prompt`/`compactPrompt`/`compactSystemPrompt` 无编辑入口；`systemPrompt` 只是被塞进 Agent tab 兜底显示）。elf-018 因有 manifest（4 tab）正常。

**修复方案**：

- 为 elf-001 ~ elf-017 逐个新建 `agents/<id>/ui/manifest.json`，把现有 `config/config-ui.json` 的 `tabs` **原样**迁入 `manifest.config.tabs`（`fields` 结构兼容 `ConfigField`，无需改渲染代码）。迁移完删除各 agent 的 `config-ui.json`。
- 参考 elf-018 的 manifest 结构（`agents/elf-018/ui/manifest.json`）；`config-ui.json` 的 tab 里 `type: "avatar"/"readonly-tags"/"textarea"/"number"/"text"` 等字段在 manifest 里原样保留即可。
- 纯文件操作，无代码改动（`ConfigDrawer`/`ConfigField` 已支持 manifest 优先）。

---

### 3. 首次对话后 rewind 无可回退项 —— 先 mkdir 再写 + 空 catch 补日志

**根因**（已脚本复现 + 线上验证：三个私聊房 checkpoints 均返回 `[]`）：

- `room_routes.js:316` 在用户发言前调 `snapshotBeforeSend(...)`，外层 `catch (e) { /* 快照失败不阻塞 */ }` **静默吞掉异常**。
- 首次对话时私聊房数据目录 `profiles/agents/<id>/rooms/chat-<uid>-<id>/` **尚不存在**——它由 agent-server 收到 `/observe` 后才在 `engine/server.js:133` `fs.mkdirSync` 创建，而 gateway 的 `/say`（含快照）发生在 `postObserve` 之前。
- `snapshot.js:81-84` 在**确保目录存在之前** `fs.writeFileSync(contextFile, '[]')` → `ENOENT`（实测直接调 `snapshotBeforeSend` 抛 `ENOENT ... context.json`；目录存在后第二次调用正常）。→ **每条私聊房的第一条消息必无快照**，rewind 菜单显示"暂无可回退状态"。

**修复方案**：

1. `snapshotBeforeSend` 开头先 `fs.mkdirSync(dataDir, { recursive: true })` 再写 context.json（一行修复）。
2. **不做**"快照栈为空时 rewind 允许回退到完全空状态"的兜底（按你的决定）。
3. **写文件前统一 ensure 目录**（`mkdirSync(dir, { recursive: true })` 再写）。排查结果：
   - `gateway/snapshot.js`：`context.json` 首次创建（:83，本轮修复点）；`meta.json`（:115，cpDir 已在 :94 mkdir，安全）；rewind 的 `copyFileSync` 到 dataDir（:217/:221，dataDir 因快照在其内部而必然存在，可防御性补 mkdir）。
   - `agents/elf-018/ui/api.js`：**`updateUserProfile`（:316 `writeFileSync(protPath)` 无 mkdir，用户首次进 setup 失焦保存主角面板时会 ENOENT → 500，前端 `.catch(()=>{})` 静默）需补 `mkdirSync(path.dirname(protPath), {recursive:true})`**；`createLore`（:260）已有 mkdir ✓；`saveGame/loadSave` 的目录由 `_copyDir`（:327）保证 ✓。
   - 其余 writeFileSync/copyFileSync 点（gateway 的 auth.js/avatar.js/chat_history.js/config_store.js/room_bus.js/server.js 等）目标目录均有前置 mkdir 或必然存在，按同样标准过一遍即可。
4. **空 catch 必须打日志**（`logger.warn`/`error`；有默认返回值的读取容错可 `logger.debug`）。全量清单（提交时以 grep 为准）：
   - gateway：`room_routes.js:233,316,434,449,456`（:316 就是本轮吞掉快照 ENOENT 的元凶）；`aggregated_stream.js:107,111,149`；`room_bus.js:601,620,625,642,656,993`；`process_manager.js:306`；`server.js:361,414`；`agent_events.js:84`。
   - engine：`server.js:336,351,415,419,450`；`tools/Agent.js:128`、`tools/file_change_detector.js:126`、`tools/SetObserveConfig.js:71` 等。
   - agents/elf-018/ui：`api.js:83,121,154,188,245,279,380,406,414,524`。
   - shared：`agents/elf-018/buildMetadata.js:33,84`。
   - 有默认返回值的读取容错（保留但补 debug）：`gateway/config.js:88`、`api.js:73,542,548`、`engine/prompt/injectors.js:15`、`shared/checkpoint_meta.js:14` 等。

---

### 4. 切换用户后聊天历史被污染 —— 重置 store + chats 复合 key

**根因**：

- `authStore.logout()`（`authStore.js:23-26`）只清 token/user，**不清 `agentStore.chats` / `roomStore` / activeAgentId / URL hash**。
- `agentStore.chats` Map 只按 `agentId` 做 key，不区分 uid；换号后同 agentId 直接命中旧用户 chat。
- 更隐蔽一层：`sseDispatcher.js:187-189` 的 snapshot 合并 `olderTurns = existing.filter(t => !snapIds.has(t.id))`——新用户登录后聚合 SSE 重连（`useAggregatedSubscription.js:74-78` token 变化触发），gateway 推来新用户房间的 snapshot，旧用户 turn 的 id 不匹配 → 被当成"上翻历史"**保留合并**进新会话。刷新整页后 store 从零初始化，所以"刷新就好"。

**修复方案**：

1. **重置 store**：新增 `agentStore.reset()` / `roomStore.reset()`（恢复初始 state：`chats` 清空、`activeAgentId=null`、`roomChats` 清空、`activeRoomId=null`），并在 `authStore.logout()` 与登录成功（`setAuth` 换 user）时调用；同时清 `window.location.hash`。聚合 SSE 由 token 置空自然断开、换号后由新 token 重连，无需手动处理。
2. **chats 复合 key**：`agentStore.chats` 的 key 从 `agentId` 改为 `` `${uid}:${agentId}` ``（`roomChats` 已按 roomId 隔离，不动）。所有读改写点**统一收口到一个 helper**（如 `chatKey(agentId)` 内部读 `useAuthStore.getState().user.uid`），避免散落：`agentStore.js`（selectAgent / _patchChat / loadHistory / loadMoreHistory / updateChatField / clearHistory）、`sseDispatcher.js`（全部 `chats.get/set`，约 20 处）、`useChat.js`、`useBridge.js`、`ChatPanel.jsx`（:153-162 约 10 处 selector）。
3. **回答"重置 store 是否强制 loadHistory"**：重置本身**不主动**调 loadHistory，但现有机制会自动补齐，无需额外 force——
   - running agent：聚合 SSE 重连后 gateway 逐房补发 snapshot，`handleSSEEvent('snapshot')` 里 `_patchChat` 懒创建 chat 并置 `historyLoaded=true`（`sseDispatcher.js:190-195`）；
   - stopped agent：`ChatPanel` 挂载时的 init effect 兜底 `!historyLoaded && stopped → loadHistory(agentId, { force: true })`（`ChatPanel.jsx:216-219`）。
   - 重置 + 复合 key 双保险；重置后 `activeAgentId=null`，新用户需重新点选会话（此时 ChatPanel 重新 mount，走上面两条路径之一）。

---

### 5. 注销确认 / 注册二次密码 / 重名注册 —— 全修

- **注销确认**：复用现有 `ConfirmModal`（`ConfigDrawer` 清空聊天同款），⏻ 按钮与（第 6 条移入后的）齿轮页"退出登录"都弹「确定退出登录？」。
- **注册二次密码**：`LoginPage.jsx` 注册模式加"确认密码"输入框，前端校验两次一致 + 长度 ≥4（与后端 `registerUser` 的"密码至少 4 位"一致，`auth.js:90-92`），不一致禁用提交并提示。
- **重名注册**：后端已实现——`auth.js:93-95` `findByUsername`（大小写不敏感）→ 409「用户名已存在」，前端 `LoginPage.jsx:29` 已显示该错误。补前端体验即可：提交时展示 409 文案（已有）；可选在提交前本地校验用户名格式（`USERNAME_RE`：2-32 位字母/数字/`_.-`）。
- 涉及文件：`LoginPage.jsx`、`Sidebar.jsx`；`ConfirmModal` 复用不改。

---

### 6. 注销移入齿轮页 + 配置页改密码

**确认方案**：

1. 注销从侧栏顶栏 ⏻ 移入 ⚙ 全局设置弹窗（`Sidebar.jsx:256-297`），弹窗内加「退出登录」按钮（带确认，见第 5 条）；侧栏顶栏只保留刷新按钮。
2. 齿轮弹窗增加「修改密码」区块：旧密码 / 新密码 / 确认新密码。
3. **后端新增改密端点**：如 `PUT /settings/password`（或 `POST /auth/change-password`）——校验旧密码（`bcrypt.compareSync`，`auth.js` 已有 `verifyUser` 可复用）→ 新密码 `bcrypt.hashSync` 更新 `user.passwordHash` → `saveUser`。改密成功后**强制重新登录**（前端清 token 回登录页）或提示手动重登。
4. 涉及文件：`gateway/auth.js`（新端点）、`gateway/server.js`（挂路由）、`frontend/src/api/index.js`（新 API）、`Sidebar.jsx`（齿轮弹窗改造）。

---

### 修复顺序建议

1. **问题 3**：snapshot 先 mkdir 再写 + 全量空 catch 补日志（低风险高收益，还能暴露 1b 里 `updateUserProfile` 的 ENOENT）。
2. **问题 1a**：解析层剥 fence + 提示词禁代码块（小改动）。
3. **问题 4**：store 重置 + chats 复合 key（中改动，注意回归私聊/群聊切房、rewind、切 tab）。
4. **问题 1b**：setup 临时目录（elf-018 api.js 结构调整，依赖第 3 步的日志便于排查）。
5. **问题 5/6**：登录注册改密码、注销迁移（相互独立的小改）。
6. **问题 2**：18 个 agent 的 manifest 迁移（批量文件操作，无代码，可最后做）。

---

## 实现状态（2026-08-06 已落地，未跑测试）

| # | 落地内容 | 涉及文件 |
|---|---|---|
| 1a | 新增 `stripFence()`（检测首尾 ``` 围栏再剥，含 BOM/前导空行容错）；`polishLore` 解析前先 `stripFence`；`POLISH_SYS` 加「以 `---` 开头、禁止代码块包裹」 | `engine/skills/parser.js`、`agents/elf-018/ui/api.js` |
| 1b | setup 临时目录 `profiles/agents/<id>/rooms/chat-<uid>-<id>/setup/lore/`：`/seeds` 仅在目录缺失时从 seeds 物化；lore CRUD / user-profile / polish 支持 `mode=setup`（读写临时目录）；新增 `POST /setup/commit`（临时目录 → 正式 `runtime/lore`，临时目录保留）；前端 setup 页只读 `/seeds`，保存/删除/润色带 `mode=setup`，开始游戏 = PUT user-profile → commit → send；移除种子标 | `agents/elf-018/ui/api.js`、`agents/elf-018/ui/DnDChatView/GameSetupPanel.jsx`、`index.module.css` |
| 2 | elf-001~017 全部新建 `ui/manifest.json`（config-ui.json 的 tabs 原样迁入），删除各自 `config-ui.json`；`useConfig` 默认 tab 改为 manifest 首个 | 17 个 `agents/<id>/ui/manifest.json`、`frontend/src/hooks/useConfig.js` |
| 3 | `snapshotBeforeSend` 先 `mkdirSync(dataDir)` 再写 context.json（首条消息 ENOENT 修复，已本地验证 turn1/turn2 均出快照）；`rewindTo` 防御性 mkdir；`updateUserProfile` 写前 mkdir；全量空 catch 补日志（gateway/engine/shared/elf-018 工具/elf-002 mm，读取容错类按 ENOENT 静默、其余 warn） | `gateway/snapshot.js`、`gateway/room_routes.js`、`agents/elf-018/ui/api.js` 及约 30 个文件 |
| 4 | `authStore` 新增 `chatKey()`（`<uid>:<agentId>` 复合 key）；`agentStore.chats` / `sseDispatcher` / `useChat` / `useBridge` / `ChatPanel` 全部改复合 key；`agentStore` / `roomStore` 新增 `reset()`；`App.jsx` 登录态（uid）变化时 reset 两 store + 清 URL hash（历史由 SSE snapshot / ChatPanel init force 自动补齐，无需手动 loadHistory） | `frontend/src/stores/{authStore,agentStore,roomStore,sseDispatcher}.js`、`useChat.js`、`useBridge.js`、`ChatPanel.jsx`、`App.jsx` |
| 5/6 | 后端 `changeUserPassword` + `PUT /settings/password`（校验旧密码 → bcrypt 更新，**不强制重登**——JWT 无状态，改 hash 不影响已签发 token，前端成功 toast 即关弹窗）；注册加确认密码 + 前端校验；注销确认弹窗（复用 ConfirmModal）；⏻ 从侧栏顶栏移入 ⚙ 齿轮弹窗；齿轮弹窗拆两视图（main=头像+用户名+入口按钮；password=改密子页，取消/‹ 返回 main） | `gateway/auth.js`、`gateway/server.js`、`frontend/src/api/index.js`、`LoginPage.jsx`、`Sidebar.jsx`、`Sidebar.module.css` |
| 7 | **私聊实例用户自治**：去掉"访客必须全局 running 才能启动私聊"的门。访客 `start` = 确保共享 server 在跑 + 启用自己的 `chat-<uid>-<id>`；`/say` 私聊检查从"全局 agent running"改为"共享 server 端口活着 + 该用户未停用自己 room"；`postObserve` 端口改 `getServerPort()`（不依赖全局开关）；`presentAgent` 访客视角 status = 自己启用态（与全局解耦）。admin 全局启停 + 共享进程管理语义保留。旧测试「访客 start 403」改写为「访客可自启私聊、不影响全局、stop 幂等」+ 补改密用例 | `gateway/server.js`、`gateway/room_routes.js`、`test/auth.test.js` |
| 8 | 清理 `profiles/agents/{elf-018,elf-002}/memory/` 旧布局残留（生产路径已无人读写；dev 直跑会从 seeds 重新播种） | 磁盘清理（无代码） |

> 前端已 `npm run build` 通过；后端改动文件 `node --check` 语法通过；本地跑过针对性冒烟（stripFence 解析、snapshot 首条消息 mkdir），**未运行测试套件**——按约定等你确认后再跑。

### 待商榷 / 后续（未实现）

- **`agentMemory(runContext?.agentId || 'unknown')` 兜底**（`agents/*/create_agent.js`）：目前 dev 直跑 `node agents/<id>/index.js` 时 dataDir 为 null 会落到 `profiles/agents/<id>/memory`（已清理的旧布局目录，运行时会从 seeds 重新播种）。**不做"对齐成 room 语义"的兜底改造**——兜底本身值得商榷，倾向直接移除该回退，让 dev 直跑也显式给 dataDir（对齐生产 `agentRoomState(agentId, roomId)` 语义）；改动面为 18 个 `create_agent.js` + `gateway/agent_template/create_agent.js`，待定。
- **群成员制可见性**（见 `docs/group-membership-visibility.md`）：群聊目前对**所有注册用户可见**（`GET /rooms` 不区分），后续要改成"只有群成员（用户）才能看到/进入群"。