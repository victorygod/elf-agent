# Prompt 分拆架构 — elf-018

## 问题

当前 `loop_outline_prompt.md` 和 `loop_render_prompt.md` 都是完整文件整体注入，但每份文件内部实际包含两类性质不同的内容：

- **静态格式规范** — 产出物的 schema、文件规范、写作格式。不随轮次变化，属于 system prompt 层面的知识。
- **动态任务指令** — 本轮具体做什么、怎么做、有什么行为约束。更近于每轮 injection。

混在一起意味着同一份"固定格式"每轮都要作为 user 末尾注入，浪费 token；同时前端配置页只提供一个编辑框给整个文件，用户不知道哪些内容应该调、哪些不应该。

## Outline Loop 的分拆

### 属于 system prompt 后缀（静态，`_outlineSystem()` 注入）

**来源**：从 `loop_outline_prompt.md` 拆出

```
## lore 规范
- 设定文件按实体类型分类存放（地点/任务/物品/技能/NPC），每文件一实体。
- 文件名用实体名；每个 md 首部须 frontmatter：
  ---
  name: 某人的名字
  description: 某人已知背景，简介
  ---
- 角色卡 = 面板 + 设定，正文含属性/数值状态或性格/关系/近况。

## 大纲格式
## 章节定位
承接上轮何事、推进主线/支线哪段、本章情绪与主题。

## 情节弧
跨章节奏定位（缓章/急章）、弧线推进、伏笔埋设/回收、余韵钩。

## 剧情发展
按 beat 顺序连贯叙事，判定逐个进行，不并发不凭空写骰值。

## 人物塑造
各 NPC 动机与转变、玩家角色成长或抉择时刻。

## 战斗（无则省略）
分两轮推进（战前轮/战斗轮），战斗轮逐个调用 Roll。

## 数值结算
initial/final/changes 格式，升级属性随机增长，游戏时间。

## 涉及实体清单
character/item/skill/location/quest/state 分类列出。

## 设定信息
按登场实体摘抄 render 所需 fact，render 不读设定文件。

## 选项方向
2-4 个分支方向（不写措辞）。

## 语言风格
从 language style metadata 选最契合的一个。

## 游戏时间
起始时间→结束时间。
```

这些内容放在 `_outlineSystem()` 的返回值末尾，即 system prompt 固定后缀。每次 outline loop 都作为 system 的一部分存在，不额外占 user 末尾的 injection 预算。

### 属于动态任务指令（`_outlineContext()` 注入）

**来源**：从 `loop_outline_prompt.md` 拆出 + 代码生成的 `MAIN_TASK_INSTR`

```
## 流程
1. 已预载：故事全局进度、主角面板、所有 lore 设定索引均在上下文。
2. 按「大纲格式」逐段推演：
   a. 写到需判定处 → WriteOutline 保存进度
   b. 调用 Roll 获取骰值
   c. 写入大纲并标注 [Roll: <purpose>]
   d. 根据结果推演后续
   e. 遇到下一个判定点重复 a~d
   f. 一次只调一个 Roll，不得并发
3. 全部推演完毕后自查维护：
   - 检查 [Roll:] 标注
   - 面板↔图鉴一致性（必检先做）
   - 补登缺失设定文件
   - 更新面板到 final + 更新 state.md
   - 检查设定信息节抄录是否完整
4. 维护临时状态（轮数 -1）与游戏时间（Edit 改，不写入大纲）

## 约束
- 大纲一律经 WriteOutline 写入，不在对话回复输出正文/叙事/选项
- 实体命名用 lore 规范名
- 面板↔图鉴必须一致
- 语言风格节只许一个 <文件名.md>，不得臆造

## 主任务指令
本轮轮次 N。写大纲（含情节弧 + 剧情发展 + 数值结算），需判定时调 Roll；落完大纲后维护 lore/面板/state.md。全部落盘后只回一句"大纲已完成"——本阶段不渲染正文。
```

这些通过 `_outlineContext()` 放在 user 末尾（`useAfterLastUser`），其中 `MAIN_TASK_INSTR` 含轮次号 N，必须动态生成。

## Render Loop 保持现状

render loop 的提示词全为静态格式，本也应进 system 后缀。但 render 逻辑简单（纯流式无 tool），当前在 user 消息末尾注入的额外开销可接受。为减少改动面，render 保持现有注入方式不变。

### 如果未来需要拆分

render 的 `loop_render_prompt.md` 全部内容可整体放入 `_buildRenderMessages()` 的 system 块末尾（类似 outline 的 loop_outline_system），移除 user 消息末尾的注入。但当前没有动态任务需求，暂无必要。

## 前端配置页影响

### 当前状态

config 页面对应三个可编辑文件：
| 配置字段 | 当前文件 | 性质 |
|---|---|---|
| `systemPrompt` | `system_prompt.md` | outline 和 render 共用系统总纲 |
| `loop_outline_prompt` | `loop_outline_prompt.md` | outline 任务指令（混合） |
| `loop_render_prompt` | `loop_render_prompt.md` | render 任务指令（全静态） |

### 拆分后

| 配置字段 | 位置 | 性质 |
|---|---|---|
| `systemPrompt` | sys system | 共用总纲（不变） |
| `loop_outline_system` | outline system 后缀 | outline 专属系统提示词（静态） |
| `loop_outline_task` | outline user 末尾 | 大纲任务指令（动态） |
| `loop_render_format` | render system 后缀 | 渲染格式规范（静态） |
| `loop_render_task` | （无，render 没有动态指令） | — |

config.json 里可能需要新增/修改字段：

```json
{
  "systemPrompt": { "type": "path", "content": "system_prompt.md" },
  "loop_outline_system": { "type": "path", "content": "loop_outline_system.md" },
  "loop_outline_task": { "type": "path", "content": "loop_outline_task.md" },
  "loop_render_format": { "type": "path", "content": "loop_render_format.md" }
}
```

前端配置页需要：
1. manifest.json 的 `prompt` tab 字段列表新增 `loop_outline_system` 编辑框，标注"outline system prompt"
2. 把 `loop_outline_prompt` 编辑框改为只含动态任务指令（已实施）

## 代码改动点

| 文件 | 改动 |
|---|---|
| `create_agent.js` | `_outlineSystem()` 末尾拼接 `loop_outline_system`，`_outlineContext()` 只注入 `loop_outline_task` |
| `agent.js` | `_buildRenderMessages()` 的 system 块末尾拼接 `loop_render_format`，不再在 user 消息末尾注入 |
| `config/config.json` | 字段拆分 |
| 前端 config 页 | 编辑框一拆为二 + 标注 |

## 注意

- 静态格式进了 system prompt 后，LLM 会更稳定地遵守这些规则（system 的指令权重天然高于 user 末尾注入）
- 拆分后 outline loop 每轮节约 `## lore 规范` + `## 大纲格式` 的 token 开销（这两节是不变文本，几百到上千 token 每轮）
- 如果未来 render loop 也有动态任务需求（比如按轮次不同的渲染策略），可以再在 `loop_render_task` 字段预留扩展点