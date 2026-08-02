# Avatar 缓存击穿修复(方案 B)

## 现象
config-ui 改任意字段(autosave),所有 `/agents/<id>/config/avatar.webp?v=...` 被重拉一次;用户消息头像 `/uploads/user_avatar.*?v=...` 同样被刷。

## 根因
`agentStore.js` 的 `refreshAgents` 里:
```js
set({ agents, _avatarBuster: Date.now() });
```
`_avatarBuster` 是全局单值,`Avatar.jsx` 所有头像(`kind="agent"` 与 `kind="user"`)共用做 cache-buster。autosave → `refreshAgents` → 全局时间戳变 → 每个已挂载的头像 `?v=` 都换新 → 浏览器对全量头像重发请求。

## 约束(决定方案)
- 头像文件名固定 `avatar.webp` / `user_avatar.webp`,覆盖写(`gateway/avatar.js:45`、`server.js:386`)→ buster **必需**,否则同格式重传浏览器不重拉。
- `refreshAgents` 还负责刷 `agents` 列表 `name`/`status`(`agentStore.js:84`)→ autosave/start/stop 里的调用**不能删**。
- 头像只在两处发生变更:agent 头像上传(`ConfigField.jsx`)、用户头像保存(`Sidebar.jsx`)。

## 方案 B(最小,同时修 agent 与用户两类)

核心:**把 `_avatarBuster` 的 bump 从 `refreshAgents` 里拿出来,只在这两处上传成功后 bump**。`Avatar.jsx` 不动。

1. **`frontend/src/stores/agentStore.js`**
   - `refreshAgents` 去掉 `_avatarBuster`:`set({ agents })`。保留 `_avatarBuster: 0` 初值。
   - 加 action:`bustAvatars: () => set({ _avatarBuster: Date.now() })`。

2. **`frontend/src/components/ConfigField.jsx`**(agent 头像上传成功处,约 `:25`)
   - 在现有 `refreshAgents()` 旁补 `useAgentStore.getState().bustAvatars()`。

3. **`frontend/src/components/Sidebar.jsx`**(用户头像保存成功处,约 `:182` setState 之后)
   - 补 `useAgentStore.getState().bustAvatars()`。

4. **`frontend/src/components/Avatar.jsx`**:不改。

## 行为对照
| 场景 | 改前 | 改后 |
|---|---|---|
| 改 systemPrompt 等 autosave | 全量头像重拉 | 不拉 |
| 启停 agent(refreshAgents) | 全量头像重拉 | 不拉 |
| 上传 agent 头像 | 全量头像重拉一次 | 全量头像重拉一次(不变) |
| 上传用户头像 | 列表不刷新(依赖后续 refresh) | 全量头像重拉一次 |

上传一个头像仍会 bust 全量一次,但上传是低频手动操作,且**不比现状差**;autosave/启停的风暴则被彻底关掉。

## 部署(已坐实,无需重启 gateway)
- `server.js:322-324` `express.static` 默认每请求读盘、无内存缓存;`server.js:296-307` 与 `:397-405` 头像均走 `res.sendFile` 读盘。
- 故:本次 `cd frontend && npm run build` 后**硬刷浏览器**即吃到新前端;日常传新图立即可见。**gateway 全程不重启**。