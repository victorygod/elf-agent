# DM Agent 设计

私聊 DM agent（DND 5e 风格地下城主），按轮次为玩家叙事演绎剧情。单 agent，reasoning 内跑 4-loop workflow；数值用 md 文档维护，靠 LLM 推理 + Roll 工具。

## 1. 装配

- 新建 `agents/elf-018/`，从 `gateway/agent_template` 拷改。
- 私聊场景由 `PrivateChatPlugin` run-level 自动注入（room = `chat-elf-018`），无需声明。
- `messageManagerClass: "dnd_message_manager"` 自定义压缩。

```json
{
  "agentId": "elf-018", "name": "DND DM", "provider": "llm",
  "messageManagerClass": "dnd_message_manager",
  "compactMode": "async", "memoryTokenLimit": 40000, "maxIterations": 0,
  "interaction": { "strategy": "observe" },
  "tools": ["Read", "Grep", "Glob", "Write", "Edit", "Roll"]
}
```

无子 agent、无数值引擎。

## 2. 目录布局

```
agents/elf-018/
  index.js / create_agent.js / message_manager.js
  config/
    system_prompt.md  compact_prompt.md  compact_system_prompt.md
    lore/                       # 叙事设定（lore_keeper loop 维护）
      world.md  rules.md  locations.md  quests.md  foreshadowing.md
      characters/*.md  state.md  metadata.md
    stats/                     # 数值层（md，LLM 维护）
      char/{id}.md             # 实例面板：lv/exp/hp/mp/技能/状态/背包
      items/{id}.md            # 物品/消耗品定义
      skills/{id}.md           # 技能/法术定义
      rules.md                 # roll 加成阶梯/hp-mp 公式/伤害抗性规则
    outline/round-{N}-{标题}.md           # 本轮大纲（节拍 + changes 序列）
    scene/round-{N}-{标题}.md             # 本轮渲染剧情
```

文件名 = **轮数 + ≤10 字高凝练标题**，DM 落盘时自拟。

## 3. 数值系统（md 维护）

养成仅靠技能系统；物品是消耗资源，状态是临时效果。

- **等级**：经验升级，获技能点（无属性点）。hp/mp 上限按等级 + 角色基线（公式在 `rules.md`）。
- **技能**：技能/法术列表 + 等级；技能点解锁/升级；技能等级是 roll modifier 与伤害加成的主要来源。
- **物品**：消耗品使用触发效果；背包记在 `char`。
- **状态**：来源/形态/影响/清除（改 modifier、改行动、dot/hot、护盾）。
- **roll 耦合**：`modifier = 技能等级加成 + 状态加成`；`伤害 = 技能骰 + 技能等级加成 + 状态加成`。

**面板契约 = initial + changes + final**，全 md 承载：
- `initial`：本轮初始面板（上轮 final）
- `changes`：`[{entity, field, from, to, reason}]` 变化序列 + 原因
- `final`：变化后终态

各 loop 用法：main 初稿拟定 changes 写进大纲；reviewer 验 changes 合理性并改；lore_keeper 按 changes 更新 `char/*.md` 到 final；render 看 initial+final 描述变化。

trade-off：无数值引擎兜底，正确性靠 reviewer loop 把关（读 md 验）。先简化跑通，专用工具后加。

## 4. 工具

`Read`/`Grep`/`Glob`/`Write`/`Edit`/`Roll`。
- `Roll(purpose, dc?, modifier?)`：d20 掷骰，自然 1/20 大失败/成功，`crypto` 取随机。
- 其余数值靠 LLM 读写 md 推理。无演算/落地数值工具、无 Agent 工具、无子 agent。

各 loop 取子集：main·初稿 / reviewer / lore_keeper 用上述全集；**render 无工具**。

## 5. reasoning workflow（4-loop，reasoning 内编码）

单 agent，reasoning 内跑 4 loop 串行，文件在 loop 间传递。每 loop 跑 LLM+工具到纯文本 break，检查期望产出，没产出注入提示再跑（不加上限），产出则切下一 loop。

| loop | 角色 | 上下文 | 期望产出 |
|---|---|---|---|
| main·初稿 | DM 撰写 | 玩家指令 + 压缩历史 outline + 上一轮正文 + initial 面板 + 设定 metadata | `outline/round-N.md`（含 changes） |
| reviewer | 审校改写 | 压缩历史 outline + 本轮 outline + initial 面板 + metadata + 相关设定全文 | outline 已修订（不再调工具） |
| lore_keeper | 状态维护 | 压缩历史 outline + reviewer 后 outline + metadata + initial 面板 | `char/*.md` 更新到 final + lore/metadata |
| render | 渲染 | 压缩历史 outline + reviewer 后 outline + 上一轮正文 + initial+final 面板 | 正文 → 流式前端 + 落 `scene/round-N.md` + 入 history(MM) |

实现复用现有机制：
- **切 prompt/context**：`promptAssembler.useSystemReplace` 换 loop system prompt；`useBeforeLastUser`/`useAppend` 注入该 loop context（面板/设定/历史 outline）。
- **切工具视图**：`harness.withRunLevel({disableTools})` 按 loop 禁用（render 禁全部）。
- **注入循环**：loop 纯文本 break 后检查期望产出；没产出 `addMetaMessage` 注入提示再跑该 loop，不加上限；产出切下一 loop。
- **render 流式**：无工具 → 一次纯文本 `chatStream`（onChunk emit token 给前端）+ `addAssistantMessage` 入 MM history + `Write` 落 `scene/round-N.md`。
- **产出检测**：检查期望产出（outline 含 changes 段 / `char/*.md` 已更新 / render 正文非空）。

## 6. 大纲格式（数值契约载体）

`outline/round-N-{标题}.md` 含：
- **剧情节拍**（自然语言）：场景目标、走向、roll 判定点及结果、给玩家的选项。
- **changes 序列**：initial → changes `[{from,to,reason}]` → final，确切值由 Roll/LLM 演算。

reviewer 验改、lore_keeper 据此更新面板、render 据此描述——共用这张契约。

## 7. 单轮时序

```
1. 玩家行动 + 文件索引注入
2. main·初稿 loop：演算 + Roll + 写 outline/round-N.md（含 changes）
3. reviewer loop：读 outline+面板+设定验算，直接改 outline 到不再调工具
4. lore_keeper loop：按 outline 的 changes 更新 char/*.md（到 final）+ lore/metadata
5. render loop：无工具，读 outline+initial+final 渲染正文 → 流式前端 + 落 scene + 入 history
   - 若本轮触发升级：正文结尾给"如何分配技能点"选项，下一轮玩家决策后落地
等下一轮
```

## 8. 消息压缩（`DNDMessageManager`）

override `compactIfNeeded`：
- **保留最近一次 user 输入后的全部消息原文**。
- 老区超限调 LLM 摘要（`compactPrompt` 引导保留剧情脉络/伏笔推进，丢弃工具过程）。
- 历史大纲/剧情靠**落盘文件 + 注入索引**保留，不占消息历史。

MM 角色：存对话（玩家指令 + DM 渲染正文）；长期记忆靠文件（outline/scene/char/lore）+ 压缩历史 outline 摘要。各 loop context 显式从文件构建。

## 9. 文件索引注入器

`promptAssembler.useBeforeLastUser`（同 skills listing 槽位）：每轮 reasoning 前扫 `lore/`+`stats/`+`outline/`+`scene/`，产 `<system-reminder>` 索引插在最近 user 前；仅目录+文件名（带轮次+标题）；临注入、每轮现算、压缩不影响。

## 10. 改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `agents/elf-018/` 新建 | `index.js`、`create_agent.js`（+文件索引注入器、各根目录绝对路径）、`message_manager.js`、`config/*`、`lore/`+`stats/` md 种子、`outline/`、`scene/` |
| 2 | `engine/message_manager.js` 或 elf-018 子类 | `DNDMessageManager`：压缩按最近 user 切 |
| 3 | `engine/agent.js` reasoning | 4-loop workflow 编码：loop 状态机 + 产出检测 + 注入循环 + prompt/context/工具视图切换 |
| 4 | `engine/tools/Roll.js` + `index.js` | d20 掷骰工具 + re-export |
| 5 | 文件索引注入器 | `useBeforeLastUser` 扫各目录产 `<system-reminder>` 索引 |

去掉了：数值引擎、演算/落地数值工具、Agent 工具、子 agent registry、`Agent.js` 白名单扩展、`start.js`/`DMChatPlugin` 场景钩子。

## 待决策

- `rules.md` 具体规则（技能等级→roll 加成阶梯、hp/mp 公式、伤害骰来源）。
- changes 序列的 md 格式。
- reviewer "相关设定全文"的自动注入检索机制（按大纲实体从 metadata 抽取）。
- 各 loop system prompt 文案。