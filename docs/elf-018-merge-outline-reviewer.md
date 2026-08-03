# elf-018：合并 outline loop 与 reviewer loop

把当前 3-loop（main 写大纲 → reviewer 审校+维护 → render 渲染）压成 2-loop（**outline** 产大纲+维护 → render 渲染）。reviewer 作为一个独立阶段消失，其维护职责并回产大纲的同一个 loop。

## 1. 动机

- reviewer 的"审校"职责在 LLM 自审场景下价值有限（同一模型第二轮重看，硬一致性收益不稳定），却付出一次独立 loop 的延迟与上下文重建成本。
- 真正稳定的产出信号只有"本轮大纲落盘"这一件事；lore/面板/state 的维护是衍生动作，不必单列阶段。
- 合并后：detect 收敛到单一条件（大纲 mtime），上下文构建只剩一套（base assemble + 注入器），删掉 reviewer 专用的 messages 重建与 Skip 短路。

## 2. 现状（3-loop）

```
LOOPS = [main, reviewer, render]
  main     : disableTools=[Write,Edit]  detect=outline/round-N.md 存在   产出大纲
  reviewer : disableTools=[Roll] extraTools=[Skip]  detect=面板mtime更新 OR Skip  审校+维护 lore/面板/state
  render   : disableTools=全部  isRender  渲染正文
```

- main 禁 Write/Edit 是为强制走 WriteOutline（避免指定路径/越权改历史轮）。
- reviewer 走 `_buildLLMRequest` override 自建 messages（摘要+近2轮大纲+待review大纲+面板+任务），改前 `_backupPanel`。
- reviewer 的维护指引在 `loop_reviewer_prompt.md`（覆盖性校验 + 更新 lore/角色卡/state.md）。

## 3. 目标（2-loop）

```
LOOPS = [outline, render]
  outline : disableTools=[]  detect=outline/round-N.md mtime>loopStart  产大纲 + 维护 lore/面板/state
  render  : disableTools=全部  isRender  渲染正文（不变）
```

- **主要目标 = 产大纲**；lore/面板/state 维护是同 loop 内的衍生动作，靠提示词引导，detect 不校验它。
- 合并后 outline loop 全工具开启：`WriteOutline`/`EditOutline` 写本轮大纲（落 outline 目录），`Write`/`Edit` 维护 lore（lore 作用域，物理上碰不到 outline 目录，故放开 Write/Edit 不会威胁大纲完整性——这正是当初 main 禁用它们的顾虑的消失条件），`Roll` 判定，`Read`/`Grep` 检索。

## 4. outline loop 设计

### 4.1 detect（唯一 completion 信号）

```js
detect: async (agent) => {
  const f = path.join(agent._roots.outline, agent._roundFile());
  const start = agent._loopStartMs || 0;
  return fs.existsSync(f) && fs.statSync(f).mtimeMs > start;
},
```

只看本轮大纲文件是否在本 loop 启动后被写过。不再看面板、不再有 Skip 短路。

### 4.2 工具视图

`disableTools: []`（不禁用任何工具）。render 仍 `disableTools: null`（禁全部）。

> 安全性：专版 `Write`/`Edit` 是 lore 作用域（`isInsideLore` 守卫），outline 目录在 lore 之外，LLM 即便想用 Write 改大纲也写不进去——所以无需禁用即可保证大纲只能经 `WriteOutline`/`EditOutline` 落盘。

### 4.3 上下文

沿用现 main 的 base assemble（`super._buildLLMRequest`）+ 两个注入器，仅把 `_currentLoop` 判定从 `'main'` 改为 `'outline'`：

- `useSystemReplace(-100)` → `_outlineSystem()`：总纲 prompt + canon（metadata 文件索引）。
- `useAfterLastUser(300)` → `_outlineContext()`：当前面板 + 大纲撰写 prompt + 任务指令（含维护提示）。

跨轮历史由 DNDMM 累积并按最近 user 压缩；`getBaseForLLM` 剪裁"最近 user 之前"的超长 tool_result。

> 取舍：reviewer 原先自建的"摘要 + 近2轮大纲"聚焦上下文不再单独构建。合并 loop 依赖 MM 历史（含压缩摘要）+ 注入的当前面板；近1轮大纲作为上一轮 assistant/tool 产出已在 MM 内。聚焦度略降，但省掉一整套 messages 重建逻辑。

### 4.4 backupPanel 上移

`_backupPanel()` 从 reviewer loop 起点移到 outline loop 起点（改大纲/面板前先备份旧面板 → `user_profile.prev.md`，供 render 读"旧面板"）：

```js
if (loop.name === 'outline') this._backupPanel();
```

### 4.5 职责（提示词承载）

outline loop 在同一次 LLM 流里依次：
1. Read state.md + 相关角色卡/设定作基线（缺则 Grep）。
2. 构思本章 + 需判定处 Roll + 战斗推演。
3. `WriteOutline` 落本轮大纲（content 含 剧情节拍 + 数值结算 initial/changes/final + 设定信息节 + 涉及实体清单）。
4. **覆盖性校验 + 维护**（折自 reviewer_prompt，去掉"审校"框定，改为"作者自查"）：逐项确认大纲涉及实体已在 lore 登记齐全，用 `Write`/`Edit` 补登缺失、同步变化——
   - `lore/characters/*.md`、`lore/items|skills|locations|quests/*.md`：新登场实体补登、既有实体同步 final。
   - `lore/user_profile.md`：据 changes 更新主角面板到 final。
   - `lore/state.md`：更新篇章进度/主线·支线/伏笔埋设·回收/人物曲线/玩家所在。
5. 完成即给纯文本收尾（break）。

## 5. 删除项

| 删掉 | 位置 | 原因 |
|---|---|---|
| `LOOPS` reviewer 项 | `agent.js` | 阶段消失 |
| `REVIEWER_REMINDER` | `agent.js` | reviewer 专用 |
| `_buildLLMRequest` override | `agent.js` | 无 reviewer 分支，全部走 super |
| `_buildReviewerMessages` | `agent.js` | reviewer 专用上下文构建 |
| `_loopCalledSkip` | `agent.js` | 无 Skip |
| `_runToolExec` override | `agent.js` | 仅用于 Skip 短路 break |
| `Skip` import + `extraTools:[Skip]` | `agent.js` | 不再用 |
| `loop_reviewer_prompt` 配置项 + `loop_reviewer_prompt.md` | `config.json` / `config/` | 内容折进 outline prompt；文件可删或留空待删 |
| `REMINDER_MAIN` → `REMINDER_OUTLINE` 改名+改文案 | `agent.js` | 仅改名 |

> `Skip` 工具本体（`engine/tools/Skip.js`）保留，只是 elf-018 不再注册它。

## 6. 提示词改动

### `loop_outline_prompt.md`

- 流程 step 3 保持 `WriteOutline` 落大纲。
- **新增 step 4「自查与维护」**：把 `loop_reviewer_prompt.md` 的覆盖性校验 + 更新 lore/角色卡/state.md 指引搬入，去掉"审校/只审硬一致性/不重评"框定（同一作者无需自审语气），改为"落完大纲后逐项核对登记齐全并同步 final"。
- 其余（大纲格式、跨章节奏、约束）不变。

### `MAIN_TASK_INSTR`（`_outlineContext` 末尾任务指令）

```js
const MAIN_TASK_INSTR = (N) =>
  `本轮轮次 N=${N}。请调用 WriteOutline 写本轮大纲（content 含 剧情节拍 + 数值结算 initial/changes/final），需判定时调 Roll；` +
  `落完大纲后据 changes 用 Write/Edit 维护 lore（角色卡/设定）、user_profile.md（面板）、state.md（故事态）。`;
```

### `REMINDER_OUTLINE`（detect 失败时注入）

```js
const REMINDER_OUTLINE =
  '本轮尚未产出大纲（outline/round-N.md 未更新）。请用 WriteOutline 写本轮大纲（含 剧情节拍 + 数值结算 initial/changes/final）；' +
  '落完大纲后据 changes 用 Write/Edit 维护 lore/面板/state.md。';
```

## 7. 改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `agents/elf-018/agent.js` | `LOOPS` 压成 [outline, render]；outline 的 detect/工具/reminder；`_backupPanel` 移到 outline 起点删除项见 §5；`_currentLoop` 判定 `'main'`→`'outline'`；`_mainSystem/_mainContext` 改名 `_outlineSystem/_outlineContext`（含 `MAIN_TASK_INSTR` 扩维护提示）；`REMINDER_MAIN`→`REMINDER_OUTLINE` |
| 2 | `agents/elf-018/config/loop_outline_prompt.md` | 新增 step 4 自查与维护（折入 reviewer_prompt 内容） |
| 3 | `agents/elf-018/config/loop_reviewer_prompt.md` | 删除（内容已折进 outline prompt） |
| 4 | `agents/elf-018/config/config.json` | 删 `loop_reviewer_prompt` 项 |
| 5 | `agents/elf-018/create_agent.js` | 注入器条件 `'main'`→`'outline'`（跟随 agent.js 改名） |
| 6 | `test/dm-agent.test.js` | 两个 workflow 用例：把 reviewer 的 Read char→Write char 合并进 outline loop；mock responses 序列由 6 条压成 5 条（outline: WriteOutline→Read char→Write char→finalize；render: 正文）；detect 改 outline mtime；`backupPanel` 现在 outline 起点备份，prev.md 仍 = 初始面板，断言不变 |
| 7 | `docs/dm-agent-design.md` | §5 workflow 表、§7 时序、§1 装配注释从 4-loop/3-loop 更新为 2-loop（后续可一并修，非阻塞） |

## 8. 测试调整要点

现 `dm-agent.test.js` 两个用例的 mock 响应序列（以"4 loop 顺序跑通"为例）：

```
改前（6 条）：
  WriteOutline(大纲初稿) | '大纲完成'            ← main
  Read(char) | Write(char, final) | '审校维护完成' ← reviewer
  '剧情正文内容'                                ← render

改后（5 条）：
  WriteOutline(大纲初稿) | Read(char) | Write(char, final) | '完成'  ← outline
  '剧情正文内容'                                                   ← render
```

- outline loop detect 看大纲 mtime：WriteOutline 一旦落盘 mtime 即 > loopStart，但 `_runAgentLoop` 继续跑到纯文本 break 才回 detect，故 LLM 仍会接着 Read/Write char 做维护再收尾，detect 通过。
- `_backupPanel` 在 outline 起点（WriteOutline 之前）把 `user_profile.md`（初始）拷成 `user_profile.prev.md`；随后 Write char 覆盖成 final。render 读 prev=初始 / current=final，与现有断言一致。
- "reasoning 入口重置 _aborted" 用例同步把 reviewer 两步并入 outline。

## 9. 风险与 trade-off

- **维护变为 best-effort**：detect 只认大纲，LLM 可能落完大纲就纯文本收尾、跳过 lore/面板/state 维护。缓解：提示词把维护写成 step 4 明确动作 + 任务指令点名三处文件；接受此松弛（符合"主要目标=产大纲"的定位）。若后续发现维护遗漏率高，可加一个**软提醒**（detect 通过后再判面板/state mtime 是否动过，没动过则追加一条 meta 提醒再跑一轮——但这超出本次范围，列待决策）。
- **失去 reviewer 的聚焦上下文**：reviewer 原重建"摘要+近2轮大纲+待review大纲"独立 messages，合并后靠 MM 累积。MM 压缩后老区进摘要、近区原文保留，信息不丢但聚焦度下降；outline prompt 的"章节定位/跨章节奏"节仍要求从全局视角落笔，部分补偿。
- **正面收益**：少一次 LLM 大请求（延迟与 token 减半于中间阶段）；删一套 messages 构建 + Skip 机制 + 一份 prompt；detect 从"面板mtime OR Skip"简化为"大纲mtime"。

## 10. 待决策

- 维护松弛是否需要软提醒兜底（见 §9），还是纯提示词引导即可——本次先做后者，跑一轮看遗漏率再定。
- `loop_reviewer_prompt.md` 是直接删文件，还是留空改名备用——倾向直接删，内容已折进 outline prompt。
- loop 名 `main`→`outline` 是否同步改 `message_manager` 里 `_currentLoop` 相关分支（若有）——需 grep 确认无其他 `'main'` 字面量依赖后一并改。