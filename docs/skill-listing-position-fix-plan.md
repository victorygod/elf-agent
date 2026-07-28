# Skill Listing 注入位置修正计划

> 日期：2026-07-26
> 起因：temp #1 后 skill listing 用 `useBeforeLastUser` 注入到"最近 user 前"，但 skill 触发会连写两条 user 消息（commandTag + skill 正文），listing 钻进它们中间，把一次 skill 触发劈成两半。对齐 cc：listing 固定放 system 后、历史前。

## 改动

### 1. PromptAssembler 加新槽位 `useAfterSystem`
- 新槽语义：system 段之后、所有历史消息之前插独立消息。
- `assemble` 顺序：① system 段处理 → ② useAfterSystem（新）→ ③ 最近 user 前/后 + wrap → ④ 末尾 append。
- 不影响其它 6 个槽位。

### 2. skillLister 改注册槽位
- `enable()` 里 listing 注入器从 `useBeforeLastUser` 改为 `useAfterSystem`。
- listing 固定注入到 system 后、历史前，不再 splice 到最近 user 前。
- 这样 skill 触发连写的 commandTag + 正文两条 user 消息紧挨，listing 不会钻进去。

### 3. 删 useBeforeLastUser 的"无 user 回退末尾"逻辑中针对 listing 的部分
- listing 改用 useAfterSystem 后，不再依赖 useBeforeLastUser 的回退。
- useBeforeLastUser 自己的"无 user push 末尾"行为保留（给将来其它注入器用），不影响。

## 行为效果

- 非 skill 场景：listing 在 system 后、历史前（首轮 user 之前）。和旧"最近 user 前"差别——首轮时旧也插在那条 user 前，新固定 system 后；多轮时旧插最后一条 user 前、新固定 system 后历史前。新更稳定、不随最近 user 跳。
- skill 触发那轮：listing 固定 system 后，①commandTag + ②正文紧挨不被劈开。✅
- skill 添加/删除：`_formatListing` 增量逻辑不变，新 skill → 推增量注入、删除 → 推全量修正注入，都经 useAfterSystem 固定位置注入。✅
- compact 后：listing 是临注入（assembler 每轮现算 `_currentListing`），compact 改的是 mm.messages 历史，listing 不受影响——下轮 assembler 仍注入 listing，位置 system 后历史前（即 compact 摘要之前）。✅ 不消失。
- compact 后是否重推全量 listing：保持现状（`reinvokeAfterCompact` 清快照重算全量）。你只要求"不消失"，重推全量满足；不对齐 cc 的"不重推"。

## 测试锚定

- `prompt-assembler.test.js` 加 `useAfterSystem` 槽位 case（system 后插独立消息、order 叠加、provider 空跳过）。
- `prompt-assembly-anchor.test.js` 或 `skills.test.js` 加 case：listing 注入位置在 system 后、history 前（不再在最近 user 前）；skill 触发连写两条 user 时 listing 不钻进它们中间。
- 现有 skills.test 改"assemble 临注入 listing 到最近 user 之前"那条为"listing 在 system 后历史前"。
- 全量 `npm test` + vite build 验证零回归。

## 不动

- prefix/suffix（useWrapLastUser）、roster（useWrapLastUser）、群聊行为（useSystemAppend）、末尾 append——位置不变。
- compact/microcompact/budget、持久化 meta、elf-002 budget 逻辑——不碰。
- PromptAssembler 其它 6 个 use 方法——不动。

## 顺序

1. PromptAssembler 加 useAfterSystem + 单测。
2. skillLister 改注册槽位。
3. 改 skills.test / anchor.test 断言位置。
4. 全量测试 + 前端 build。

每步独立验证、可回滚。