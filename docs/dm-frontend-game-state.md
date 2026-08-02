# DM Agent 前端改造方案

## 1. 游戏状态标签卡

### 后端 API
`GET /agents/:id/game-state`
- gateway 直读 `profiles/agents/<id>/memory/runtime/lore/`（不需 agent 进程）
- 扫 `locations/quests/items/skills/characters` 下 `*.md` 的 frontmatter（`name`+`description`），排除 `.prev.md`
- 组装 metadata（同 `_buildMetadata` 逻辑：foreshadowing.md + state.md + 上述条目）
- 返回 JSON：
```json
{
  "characters": [{ "name": "玩家", "description": "玩家角色" }],
  "locations":  [{ "name": "边境小镇", "description": "玩家起始地…" }],
  "quests":     [],
  "items":      [],
  "skills":     [],
  "metadata":   "## 设定集 metadata\n- 玩家: 玩家角色（…）\n…"
}
```

### 前端
- `config-ui.json` 加 tab `{ "key": "game-state", "label": "游戏状态" }`（自定义渲染，非标准 field）
- 前端组件调 API → 5 块等高列表（characters/locations/quests/items/skills），每块 `max-height: ~200px; overflow-y: auto`，列表项 `name — description`
- 底部 metadata 块（同高度，纯文本）

## 2. 非 render loop 输出折叠

### 后端
**事件 loop 标记**：`_runLLMStream`/`_runToolExec` emit 的 `status`/`token`/`tool_call`/`tool_result` 事件，data 加 `loop: this._currentLoop`。

**消息 _loop 持久化**：MM 每条消息加 `_loop` 字段（`addAssistantToolCalls`/`addToolResult`/`addAssistantMessage` 时记 `this._currentLoop`）→ context.json 自然序列化。`getBaseForLLM` strip 时去掉 `_loop`（不发给 LLM）。

**room-history**：emit 事件含 `loop` → room-history.jsonl record 自然带 loop。

### 前端
- 按 `msg._loop` / `event.loop` 分流：
  - `render`：正常大气泡（token 流式、assistant 正文）
  - `main` / `reviewer`：折叠成一行框，动态文案"正在执行 [loop]: [当前工具/状态]"；展开看完整气泡（tool_call/tool_result/token/纯文本）
  - 未标记（非 DM agent）：正常显示（兼容）
- **刷新一致**：从 context.json / room-history.jsonl 重建，按 `_loop` 字段折叠 vs 正常

## 改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| 后端 API | `gateway/server.js` | 加 `GET /agents/:id/game-state` |
| 后端事件 | `engine/agent.js` `_runLLMStream`/`_runToolExec` | emit data 加 `loop: this._currentLoop` |
| 后端 MM | `agents/elf-018/message_manager.js` | add* 方法记 `_loop`；`getBaseForLLM` strip `_loop` |
| 后端 loop 传递 | `agents/elf-018/agent.js` `runFourLoopWorkflow` | 每 loop 设 `this.messageManager._currentLoop = loop.name` |
| 前端 config | `config-ui.json` + 前端组件 | game-state tab + 自定义渲染 |
| 前端消息 | 前端渲染逻辑 | 按 `_loop` 折叠/展开 + 重建一致 |
