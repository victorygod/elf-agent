# 撰写本轮大纲

把本轮当小说一章构思，按情节弧推进，兼顾人物塑造与伏笔节奏，依据玩家最新行动撰写。有战斗则按「战斗」节推演，无战斗则剧情叙事。

## 流程
1. 已预载：`state.md` 全局进度、主角面板、lore 索引（name/description）均在上下文。需某实体详情再 `Read` 对应 lore 文件，缺设定用 `Grep`。
2. 按「大纲格式」构思；需判定处调 `Roll`；涉及战斗按「战斗」节推演。
3. `WriteOutline` 写本轮大纲（只传 content）。
4. 落完即自查维护（同 loop 内）：大纲涉及的每项 item/skill/location/quest/character 已在 lore 登记，state 类变更在 `state.md` 有记录，既有设定变化的同步到 final。用 `Write`/`Edit`：
   - **面板↔图鉴一致性（必检先做）**：面板 `技能` 列每个技能须有 `lore/skills/<名>.md`，`背包` 列每个物品须有 `lore/items/<名>.md`；缺失即本轮 `Write` 补登（frontmatter `name` 取面板规范名，`description` 写简明用途/表现）。
   - `lore/characters|items|skills|locations|quests/*.md`：新登场实体补登（含 frontmatter），既有据 changes 同步 final。
   - `lore/user_profile.md` 据_changes 更新面板到 final；`lore/state.md` 更新 篇章/主线·支线/伏笔/人物曲线/玩家所在。
   - render 不读 lore，大纲「设定信息」节须抄全 render 所需 fact；发现抄录缺失回 `EditOutline` 补。

## lore 规范
- 目录：`locations|quests|items|skills|characters/` 每文件一实体；`user_profile.md` 主角卡（固定名）；`state.md` 故事态。
- 文件名用实体名；每个 md 首部须 frontmatter：
```
---
name: 某人的名字
description: 某人已知背景，简介
---
```
- 角色卡 = 面板 + 设定，正文含数值状态（lv/exp/hp/mp/技能/状态/背包）或性格/关系/近况，格式自由。

## 大纲格式
```
## 章节定位
承接上轮何事、推进主线/支线哪段、本章情绪与主题。

## 情节弧
跨章节奏定位（不写本章 beat，那进「剧情发展」）：
- 节奏阶段：缓章（铺垫/塑造/喘息）或急章（冲突/揭示/战斗）；篇章阶段（开端/发展/转折/高潮/收束），高低潮交替。
- 弧线推进：推进主线哪截、是否到人物曲线转折点；伏笔埋设/回收（短线近 2-3 章回收/长线跨篇章），勿积压、勿同章即埋即收、勿强收未铺垫。
- 余韵钩：断章留钩驱动下一章。

## 剧情发展
本章完整但简洁的叙事性大纲（连贯叙事流，非正文）——render 渲染正文的核心参考。
- 按 beat 顺序（铺垫→引发→发展→冲突/高潮→余韵）连贯叙事本轮发生的事，不只列意图；体量克制抓主干。
- **判定逐个进行，严禁不调 Roll 凭空写骰值。** 写到需判定处，**先把至此已发生的剧情写下来**，再调 `Roll`（purpose 必填，用本次判定用途当标识；判定用默认 1d20+dc，伤害/结算用 dice=技能骰、无 dc）取结果，把结果续写其后并标注 `[Roll: <purpose>]` 出处。**一次只调一个 Roll——禁止在同一次回复里并行发起多个 Roll**；多次判定须逐个进行，每次 Roll 前都先写下该判定之前的前情，拿到结果再继续往下写。判定结果必须能凭 purpose 追到对应掷骰。
- 本节是大纲文件组成部分（WriteOutline 的 content），写入文件即可，绝不在对话回复中输出。

## 人物塑造
各 NPC 动机与转变、玩家角色成长或抉择时刻——点明意图，不展开心理描写。

## 战斗（无则省略）
分两轮推进（机制见 system），依本轮玩家是否已给策略定形态：
- **战前轮**：只铺战场（环境/敌情/可利用条件）+ 给 2-4 个整场策略方向；本轮不 roll、不结算，changes 留空（仅记 initial）。
- **战斗轮**：据策略一战到底——命中与伤害各自调 `Roll` 逐个进行（判定：1d20+dc+modifier；命中后伤害：dice=技能骰+modifier、无 dc；nat 20 暴击 dice 翻倍），末尾标注 `[Roll: <purpose>]` 出处（purpose 与调 Roll 时一致）；结算多敌人按威胁顺序，击败按 exp 规则（见 system），达阈值升级连带技能点/HP·MP 上限。

## 数值结算
- initial/final：本轮前后面板状态（主角+参战方，引自角色卡）。
- changes：每个确定性变更一行 —— `类型:规范名 / field / from / to / reason`；类型 ∈ character|item|skill|location|quest|state，前五类规范名须与 lore frontmatter `name` 一致。无变更写「无」。

## 涉及实体清单
character/item/skill/location/quest/state 分类列出本轮涉及项，标「新登场」或「复用」。

## 设定信息
按登场实体摘抄 render 所需 fact（NPC 性格/外观/关系、地点氛围/特征、物品外观/用途、技能表现等），只摘所需、记 fact 不描写。本节是 render 设定的唯一通道（render 不读 lore，见 system），须覆盖所有登场实体；新登场实体无既有 lore 卡的在此先给设定要点，本轮由你用 `Write` 落库。

## 选项方向
供 render 的 2-4 个分支方向（不写具体措辞）。

## 语言风格
从 system「语言风格 metadata」里选最契合本章的一个风格，**只写一个** `<文件名.md>`（如 `<combat_style.md>`）；都不契合则写「无」（默认风格恒在 system 末尾，无需点名）。
```

## 约束
- 大纲整体一律经 `WriteOutline` 写入 outline 文件，**不在对话回复输出**正文/叙事/选项。落盘后对话只回一句 `大纲已完成`。
- 实体命名用 lore 规范名，便于逐项核登记。
- 面板↔图鉴必须一致（见流程 4），不得"面板有而图鉴无"。
- 数值公式与战斗机制统见 system，本节不重述。
- 「语言风格」节只许一个 <文件名.md>，须取自 system 语言风格 metadata，不得臆造。