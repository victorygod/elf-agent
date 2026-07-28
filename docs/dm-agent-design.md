# DM Agent 设计

私聊 DM agent（DND 5e 风格地下城主），按轮次为玩家叙事演绎剧情。

每轮：撰写大纲 → review → 修订 → 渲染剧情给选项 → 后台维护设定集。

## 1. 装配

- 新建 `agents/elf-018/`，从 `gateway/agent_template` 拷改。
- 私聊场景由 `PrivateChatPlugin` run-level 自动注入（room = `chat-elf-018`），无需在 agent 里声明。
- `messageManagerClass: "dnd_message_manager"` 启用自定义压缩。

`config.json` 关键字段：

```json
{
  "agentId": "elf-018", "name": "DM", "provider": "llm",
  "messageManagerClass": "dnd_message_manager",
  "compactMode": "async", "memoryTokenLimit": 40000, "maxIterations": 50,
  "interaction": { "strategy": "observe" },
  "tools": ["Read", "Grep", "Glob", "Write", "Edit", "Agent", "Roll"],
  "subagents": ["DM-Reviewer", "Lore-Keeper"]
}
```

不开 `skills`（文件索引走独立注入器，不依赖 skill 机制）。

## 2. 目录与文件命名

```
agents/elf-018/
  index.js / create_agent.js / message_manager.js / DMChatPlugin.js
  config/
    system_prompt.md  compact_prompt.md  compact_system_prompt.md
    lore/                       # 设定集（DM 直接 Write/Edit 改）
      world.md  rules.md  locations.md  items.md  quests.md  foreshadowing.md
      characters/*.md  state.md          # state.md = 背包/NPC现状/已揭露伏笔/已维护轮次
    outline/round-{N}-{标题}.md           # 本轮大纲
    scene/round-{N}-{标题}.md             # 本轮剧情输出
```

文件名 = **轮数 + ≤10 字高凝练标题**（如 `scene/round-03-血染黑狗酒馆.md`），由 DM 落盘时自拟。看索引即知每轮演了啥，按需 Read。

## 3. 工具

- 复用：`Read`/`Grep`/`Glob`（检索设定集）、`Write`/`Edit`（写大纲 + 直接改设定集）、`Agent`（起子 agent）。
- 新增 `Roll`：d20 简版。参数 `{ purpose, dc?, modifier? }`；`crypto` 取随机；自然 1 大失败 / 自然 20 大成功；给 dc 判 `total = roll + mod >= dc`。

## 4. 子 agent（`registry.js` 新增两类）

| 类型 | 工具白名单 | 职责 |
|---|---|---|
| `DM-Reviewer` | `[Read, Grep, Glob]` 只读 | 加载全部设定集 + 本轮大纲，查一致性/伏笔/人物/平衡，输出整改意见 |
| `Lore-Keeper` | `[Read, Grep, Glob, Write, Edit]` 可写、禁 `Agent`/`Roll` | 读剧情更新 `lore/` + `state.md`（背包/NPC经历/新地点人物） |

`Agent.js` 的 `allowedNames` 需扩展：`tools` 为具体数组时取交集（当前只认 `['*']`/`disallowedTools`）。

## 5. 单轮时序

```
1. 玩家行动
2. 文件索引注入器现算（useBeforeLastUser，<system-reminder>，列 lore/+outline/+scene/ 文件名）
3. DM 撰写 outline/round-N-{标题}.md：Read/Grep/Glob 查 lore、Roll 判定
4. Agent(DM-Reviewer, 带设定集根+大纲路径) 恰好一次 → 回流整改意见
5. 据意见 Edit 大纲（可补查补 roll）→ 不再 review
6. 渲染剧情 → Write scene/round-N-{标题}.md 落盘 + assistant 输出给玩家 + 2-4 个选项
7. turn 结束 → onFlushDone 同步起 Lore-Keeper 维护本轮设定/状态
等下一轮
```

## 6. 消息压缩定制（`DNDMessageManager`）

override `compactIfNeeded`：

- **保留最近一次 user 输入后的全部消息原文**。
- 之前的老区：未超 `memoryTokenLimit` 不动；超限调 LLM 摘要（`compactPrompt` 引导保留剧情脉络/伏笔推进，丢弃工具过程/设定引用/roll/review）。
- 历史大纲/剧情靠**落盘文件 + 注入索引**保留，不占消息历史，所以老区可放心摘要。
- 摘要请求不含文件索引（索引是临注入）。

## 7. 文件索引注入器

注册到 `promptAssembler.useBeforeLastUser(...)`（同 skills listing 槽位）：

- 每轮 reasoning 前扫 `lore/` + `outline/` + `scene/`。
- 产 `<system-reminder>` 包裹的索引，插在最近 user 前。
- 仅含目录 + 文件名（带轮次+标题），DM 据此按需 Read。
- 非持久化、每轮现算、压缩不影响。

## 8. 轮尾维护（方案 Z：引擎钩子同步）

`DMChatPlugin extends PrivateChatPlugin`，override `onFlushDone`：

```js
async onFlushDone() {
  try {
    await this.toolManager.execute('Agent', {
      subagent_type: 'Lore-Keeper',
      prompt: '维护设定集：Read state.md 看已维护到第几轮 → Glob scene/round-*.md → '
            + '对未维护的最新轮 Read 其 scene + 相关 lore → Edit/Write 更新 lore/ + 推进 state.md'
    }, null, { agent: this._agent });
  } catch (e) { /* 记日志 + notice，不阻断 */ }
}
```

- `await` 保证维护完才放行下一轮 → **无竞态**（串行）。代价：玩家若在维护期输入下一条会排队等几秒（实现时验证 gateway 对同 room 消息串行化）。
- Lore-Keeper 自驱：靠 `state.md` 的"已维护到 round-N"找未维护轮，不用主 agent 传参。首轮无 scene → no-op。
- 复用 `Agent` 工具起子 agent，零额外构造代码。
- `start.js` 场景注入加默认回退 `agent._scene = agent._scene || new PrivateChatPlugin(agent)`，让 `create_agent.js` 能注入 `DMChatPlugin`。

## 9. 改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `agents/elf-018/` 新建 | `index.js`、`create_agent.js`（+注入 DMChatPlugin、文件索引注入器、lore/outline/scene 绝对路径）、`message_manager.js`（DNDMessageManager）、`DMChatPlugin.js`、`config/*`、`lore/` 种子+`state.md`、`outline/`、`scene/` |
| 2 | `engine/tools/Roll.js` + `engine/tools/index.js` | 新增 d20 简版掷骰工具 + re-export |
| 3 | `engine/subagents/registry.js` | 加 `DM-Reviewer`、`Lore-Keeper` |
| 4 | `engine/tools/Agent.js` | `allowedNames` 支持具体白名单数组 |
| 5 | `engine/start.js` | 场景注入加 `agent._scene = agent._scene || …` 回退 |
| 6 | 文件索引注入器 | `useBeforeLastUser` 扫 `lore/`+`outline/`+`scene/` 产 `<system-reminder>` 索引 |
