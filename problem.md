1. room里，模型如果没有使用speak发言而是使用content回复，需要注入一条role=user的system-reminder，提醒公开发言需要调用speak工具。然后第二次如果模型还是不调用speak工具才退出。
2. room的清理记忆有的时候好像不能把所有Agent的记忆都清理干净，需要查一下。
3. agent name可以随便改，agent需要以agentID为唯一标识；user自己也有个uid（现阶段默认为固定值——default_userid），username改了以后，用户说过的话还是用户说过的话。
4. 为什么创建的群聊，里面的实例都拉不起来？

---

## 分析

### 问题 1：room 模型用 content 回复而不调 Speak，应注入提醒、第二次才退出

现状代码（`shared/agent/default_agent.js` reasoning 主循环）在 room 模式下对“纯 content 回复”没有任何干预：

`default_agent.js:454-457` 的 else 分支——当 LLM 这一轮既没返回 tool_calls、只吐了 content 文本时：
```js
} else {
  this.messageManager.addAssistantMessage(fullContent);
  break;   // 直接结束 loop
}
```
对私聊，content 就是给用户的回答，`break` 正确。但在 room 模式下，content 只有 agent 自己能看见，群里没人看见它“说了话”（见 `room_agent.js:26-32` 的 ROOM_BEHAVIOR_PROMPT：“不调 Speak 就等于没说话”）。所以这里 `break` 等于“它以为自己答完了，实际群里一片安静”，然后整个 reasoning 退出，控制权回到 `/observe` 的 `processObserve`（`server.js:249-263`），这条 @ 消息就此没下文。

换句话说：当前完全没有“content 不可见→提醒→再给一次机会→仍不调 Speak 才退出”的门控。需要改的就是这个 else 分支：
- room 模式下，第一次收到纯 content（无 tool_calls）时，不要 `break`，而是 count+1、注入一条 `role:user` 的 system-reminder（“你刚才的 content 群里没人能看见，公开发言必须调 Speak 工具，请现在调用 Speak”)，`continue` 进下一轮让 LLM 再来一次；
- 计数到 2（即第二次仍纯 content / 仍不调 Speak）才真正 `break` 退出。
- 还要注意与 `default_agent.js:448-451` 那段 Speak-break 的配合：那一段只在“有 tool_calls 且其中有 Speak”时 break，纯 content 走不到它，所以要处理的正是上方的 else。

一个易踩的点：注入的提醒要进 context（写记忆，`addMetaMessage`/`addUserMessage`），否则下一轮 LLM 看不到“为什么被要求重来”。

### 问题 2：room 清理记忆有时清不干净所有 Agent

清理记忆走 `room_routes.js:99` → `RoomManager.clearMemberMemory`（`room_bus.js:773-802`），它是逐个成员 `fetch http://127.0.0.1:${port}/clear`。清不干净的原因是它依赖 `room.members` 里的 `port`，而这个 port 来源不靠谱：

1. **`room.members` 是纯内存态，重启即丢。** `RoomManager` 的 `this.rooms` Map 只在 `_ensureRoom` 时新建空 `members: new Map()`（`room_bus.js:474-484`），进程重启后里面一个成员都没有。`clearMemberMemory` 第 778-782 行 `if (!m?.port)` → 直接 `return {ok:false, reason:'no-port'}`，日志会打“无运行端口(副本未启动/离线),磁盘 context.json 不会被清理”。
   所以**只要 gateway 重启过、或群是从磁盘 re-discover 回来的**，清理就全员失败，磁盘上的 `rooms/<rid>/data/<agentId>/context.json` 原样保留。

2. **即便没重启，`port` 也可能对不上。** run.json（`RoomRegistry`，`room_bus.js:258-336`）是落盘的“副本注册表”，但 `clearMemberMemory` 完全没读它，只认内存 Map。两者在 `spawnReplica` 里是同步写的（`room_bus.js:530-531`），正常情况下一致；但一旦发生过重拉 / 手动停启，内存 Map 与 run.json 可能漂移，清理就会找错端口或找不到端口。

3. 清理失败时只打个 warn，**不打断、不重试、也不 fallback 到直接删 `rooms/<rid>/data/<agentId>/context.json`**。而 `context.json` 才是记忆本体（`message_manager.js:229-237` `_save` 写的就是它）。所以“清不干净”= 部分 agent 的 context.json 没被清空。

4. 顺带：`/clear` 端点（`server.js:192-221`）本身清得是干净的（`agent.messageManager.clear()` + 清 tool-results），问题不在副本端，而在 gateway 这一侧拿不到正确的 port / 没兜底删盘。

修法方向：`clearMemberMemory` 增强——内存 Map 没 port 时回退读 `this.registry.read(roomId, agentId)` 拿 port；端口探不通时直接删 `rooms/<rid>/data/<agentId>/context.json`（和 tool-results 目录）作兜底。本质上清理记忆应该是“按盘上的 data 目录清”，而不是“按活着的进程清”。

### 问题 3：以 agentId / user-uid 为唯一标识，name 只是显示名

这是设计层面的现状盘点 + 要求，目前实现半对：

**Agent 侧——基本已对，但 name 仍被当身份用。**
- `runContext.agentId` 来自 `config.agentId`（`start.js:41-42`），是类级只读身份，`runKey` 也用它拼（`run_context.js:46`），副本落盘的 `memberName` 缺省就是 agentId（`run_context.js:48`）。所以“agent 唯一标识 = agentId”这点成立。
- **但 roster 里的 `memberName` 把显示名当成了身份标识，会出问题。** `RoomAgent._normalizePayload`（`room_agent.js:134-136`）判“是否 @ 我”用的是 `myName = this.runContext?.memberName`，而 `parseMentions`（`room_bus.js:694-726`）解析出的 `mentions` 已归一到 **agentId**。当前能 work，纯粹是因为 `memberName` 缺省=agentId（`run_context.js:48`）、`spawnReplica` 传的 `--member` 也是 agentId（`room_bus.js:437`）。一旦哪天 `memberName` 改用显示名（name），这里 `mentionList.includes(myName)` 就会失配——因为 mentions 里是 id 不是 name。这正是“name 可改、id 才是唯一标识”这条要求要防的坑：判 @ 应该用 `agentId`，不是用 `memberName`/显示名。
- `_formatRoster`（`room_agent.js:81-99`）把成员渲染成 `- elf-001 / 大黑塔`（id / name）是对的，允许 @id 或 @name 都能命中（parseMentions 双候选，`room_bus.js:702`），这块符合“name 随便改、id 才稳定”。

**User 侧——目前根本没有 uid，username 直接当 speaker 写进历史，改了就断了。**
- 全局只有一个 `userName`（`gateway/config.js`，缺省 `'user'`），存在 `gateway.json`。room 的群历史 `RoomHistory.add(speaker=userName, ...)`（`room_routes.js:148`）、`broadcast('speak', {speaker:userName})`（`room_routes.js:151`）、`broadcastObserve(rid, message, userName)`（`room_routes.js:154`）全拿它当发言者标识。
- 私聊 `ChatHistory`（`chat_history.js`）的 user 消息连 speaker 字段都没有，role 就是 `'user'`。
- 后果：用户改了 `userName`（`PUT /settings`，`server.js:458`），群历史里旧消息的 `speaker` 还是老名字，新消息是新名字——同一个人在历史里变成两个 speaker，“用户说过的话还是用户说过的话”就不成立。
- 要求里提的 `default_userid` 现阶段还没落地（代码里 grep 不到 `userId/uid`，只有 `userName`）。要满足这条，需要：给 user 引入稳定 uid（缺省固定值 `default_userid`），历史记录 / 群消息里 `speaker` 用 uid（或同时存 `speakerName`+`speakerId`），显示时再按 uid 查当前 name 渲染；改 name 不动历史归属。

### 问题 4：创建的群聊里实例“拉不起来”

实测：群 `room_1784037626172_be87` 的两个副本进程**当前是活着的**（pid 76199/76200，端口 59127/59130 都在 LISTEN，`logs/agent-room_1784037626172_be87-elf-001.log` 里也正常打到了“listening on port 59127”）。建群当时的 gateway.log 也打了“副本 …/elf-001 已起 (port 59127, pid 76199)”（`gateway.log:1138-1139`）。**所以“拉不起来”更准确说是“拉起来过、但前端显示它们是离线的 / 不响应”。** 根因在保活与重发现这条链：

`gateway/room_routes.js:121-137` 的 `/subscribe`：
```js
const room = roomManager.getRoom(rid);     // 取 snapshot 用
const snapshot = { ..., members: room.members, ... };
bc.add(res, snapshot);
// 非阻塞保活：不 await，立即返回 snapshot
roomManager.ensureReplicasAlive(rid).then(...)
```
`getRoom`（`room_bus.js:611-620`）对每个成员 `room.members.get(agentId)`，**取不到就 status 默认 `offline`**（`m?.status || MEMBER_STATUS.OFFLINE`）。

而 `ensureReplicasAlive`（`room_bus.js:641-662`）有个致命分支：
```js
const m = room.members.get(agentId);
if (!m || m.status === MEMBER_STATUS.STOPPED) {
  return;   // ← 直接 return，不探活、不重拉
}
```
`room.members` 是**纯内存 Map**（`room_bus.js:474-484`），只在 `spawnReplica` 时才 `set`。两种场景下它会是空的：
- **gateway 重启后**：内存 Map 清空，但磁盘上 `room.json` 还在、`run.json` 还在、甚至副本进程可能还活着（detached，`room_bus.js:441-446`）。此时 `members.get(agentId)` = `undefined` → `ensureReplicasAlive` 对每个成员直接 return → 不探活也不重拉 → `getRoom` 报全员 offline → 前端 snapshot 拿到全员 offline，`RoomChatPanel.jsx:111` 把它们都标灰。
- 即便没重启，`/subscribe` 的 snapshot **早于** `ensureReplicasAlive`（非阻塞 `.then`），保活结果要靠 `broadcastMemberStatus` 推 `member_status` 事件回填。保活若因为上面那个 `return` 短路了，回填就永远不来，前端就一直 offline。

**核心 bug：`ensureReplicasAlive` 把“内存里没有该成员记录（!m）”当成“已停止、别管它”，但实际它恰好在 gateway 重启这种最常见场景下表示“需要从磁盘 run.json re-discover / 重新探活”。** 设计层留了 `RoomRegistry`（落盘 run.json，`room_bus.js:258-336`）做 re-discover，注释也写了“re-discover / cleanup.sh 用”，但 `ensureReplicasAlive` 根本没调用 `registry.read/list` 去恢复内存 Map——所以 re-discover 机制形同虚设。

修法方向：`ensureReplicasAlive` 里 `!m` 时，先 `this.registry.read(roomId, agentId)` 取落盘的 port/pid，`probePort` 探活：活的就回填到内存 Map（标 running）；死的就 `spawnReplica` 重拉。即让“内存丢的成员”走 re-discover，而不是直接 return。这样 gateway 重启后重新打开群，副本才会被重新探活/重拉并回填状态，前端才显示在线。

另外 `spawnReplica` 里有个细节也会让“看似拉不起来”：只要 `waitForReady` 一次没探到（`this.startTimeout` 默认 10s），就标 offline 并把 port 带进内存 Map（`room_bus.js:525-528`），但**进程其实可能稍后才起来**——之后没人再探它，就一直 offline。保活短路问题修好后这个也能被周期性探活兜住。