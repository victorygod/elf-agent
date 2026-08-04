# elf-018 语言风格方案

## 1. 目标
移除 elf-018 现有的 render 描写样例（render_examples.md，拼在 render 的 system 末尾）与 loop_render_prompt 的「## 风格」节（拼在最近一条 user 末尾），替换为一套文件化、可被大纲点名、可在前端 CRUD 的语言风格机制。

- 默认语言风格 + 短例：render loop 的 system 末尾常驻（非最近一条 user 末尾）。
- config/styles/ 下若干风格文件（英文文件名，任意起名，含固定 default_style.md）；frontmatter 只写 description，name 即文件名。
- outline loop 的 system 附「## 语言风格 metadata」，列出 <文件名.md> - description；大纲末尾新增「## 语言风格」节，只写一个 <文件名.md>。
- render loop 解析大纲该节，命中 <文件名.md> 就在最近一条 user 消息末尾附加该风格正文（剥 frontmatter）。
- 前端 config 页新增「语言风格」tab：编辑 default_style.md，新增/删除其它任意名字的风格文件；编辑时 name + description 两个独立必填框（name = 文件名，不带 .md），正文单独可编辑。

## 2. 文件模型
- 目录 agents/elf-018/config/styles/，canon，引擎热读（每次读盘，前端改完即生效，无需重启；不进 seeds、不播种 runtime——风格为静态内容，前端写、引擎只读）。
- 文件名 = 风格名，英文、仅含字母数字下划线连字符点，不带 .md（后端补 .md）。对齐 skill 体系（skill 名=目录名、frontmatter 主要存 description），不存 name 字段。
- frontmatter 只写 description（即 metadata 里的简介，大纲 LLM 据此选风格）；正文跟在后，为可编辑的风格内容（规则 + 可选短例）。
- 解析统一复用 engine/skills/parser.js 的 parseFrontmatter（剥头取正文、读 description），不造新解析器。
- default_style.md：默认风格 + 一个短例，render system 末尾常驻。前端可编辑、名锁死、不可删。其它任意起名、可增可删。

## 3. 两个注入点（叠加，非替换）
- 默认（render system 末尾，常驻）：default_style.md 正文（voice 规则 + 短例），与大纲是否点名无关，是基底文风。替换原 renderExamples 在 system 末尾的拼法。
- 命名（最近一条 user 消息末尾，按轮点名）：大纲「## 语言风格」节写一个 <文件名.md>；解析该节首个 <...md>，命中且非默认时读该文件正文（剥 frontmatter）拼到最近一条 user 末尾（在 loop_render_prompt 之后）。命中默认 / 未命中 / 缺失 → 不重复注入（默认已兜底）。
- 关系：默认 = 永久基底文风，命名 = 本章场景调性覆盖（战斗凌厉、感情戏细腻），共存。

## 4. 后端改动
- 新增 config/styles/：default_style.md + 三个示例（combat_style / normal_plot_style / emotional_scene）。
- shared/agents/elf-018/buildMetadata.js：新增导出 buildStyleMetadata(stylesDir)，扫描 *.md，只输出 <文件名.md> - description，无绝对路径；复用 parseFrontmatter。
- agents/elf-018/agent.js：import buildStyleMetadata 与 parseFrontmatter，加常量 DEFAULT_STYLE_FILE；_outlineSystem 在 lore metadata 后追加风格 metadata；_buildRenderMessages 的 system 改为常驻默认正文、最近一条 user 末尾改为追加命中命名风格正文；新增 _loadStyleBody（读文件剥 frontmatter，缺失返空并告警）与 _resolveOutlineStyle（解析大纲「## 语言风格」节首个 <...md>，限定到该节防误命中）。
- agents/elf-018/create_agent.js：设 agent._stylesDir 指向 config/styles。
- config/config.json：删 renderExamples 字段。
- config/config-ui.json：删「render 描写样例」字段；tabs 加一项 { key: language-styles, label: 语言风格, type: language-styles, fields: [] }，仿 game-state tab。
- config/loop_outline_prompt.md：「## 大纲格式」末尾（选项方向之后）加「## 语言风格」节，要求只写一个 <文件名.md>，无需指定则写 <default_style.md>；「## 约束」补一条：该节只许一个 <文件名.md>，须取自 metadata，不得臆造。
- config/loop_render_prompt.md：删「## 风格」节，voice 迁入 default_style.md；其中两条结构性指令（开头衔接上轮不用 recap、结尾落实断章钩 + 2-4 具体措辞选项）留为新的「## 结构」节。
- 删 config/render_examples.md。

## 5. Gateway 新端点
风格文件在 canon config/styles/，gateway 直接读写。新增 4 个端点，模式取自 GET /agents/:id/game-state 的 scan、skill_store 的文件名校验与路径逃逸守卫、protagonist-name 的 frontmatter 重写；统一复用 parseFrontmatter。

- GET /agents/:id/styles：列全部风格，返回 filename / name(去 .md) / description / body(剥头) / isDefault。
- POST /agents/:id/styles：新建，body { name, description, body }。校验 name 合法、不可为 default_style、description 与 body 必填；同名存在则 409；写入 frontmatter(只 description)+body。
- PUT /agents/:id/styles/:filename：更新含改名，body { name, description, body }。default 不可改名、不可改名为 default；name 变则写新删旧（rename）。
- DELETE /agents/:id/styles/:filename：删，default 不可删。

不动 engine/config_loader.js（引擎只读不写）；现有 PUT /agents/:id/config 无目录概念，故风格走独立端点。

## 6. 前端（React）
- frontend/src/api/index.js：加 getStyles / createStyle / updateStyle / deleteStyle 四接口。
- frontend/src/components/ConfigDrawer.jsx：tab 分发链加一支，type = language-styles 时渲染 <LanguageStylesPanel agentId=…/>。
- 新 frontend/src/components/LanguageStylesPanel.jsx：复合 GameStatePanel（列表+折叠）、SkillManager（新增/删除+确认弹窗+toast）、ConfigField 的 textarea。形态：刷新拉列表；每行 name（+默认标签）+ description 摘要 + 编辑 + 删除（default 无删）；「+ 新增」打开编辑面板，三个必填框（name = 文件名 stem 不带 .md、description、body）；编辑含 default，default 的 name 锁死、description/body 可改，其余 name 可改（改名）；保存（新建→POST、已有→PUT）后刷新；删除走确认弹窗。

字段语义严格对齐要求：name + description 两个独立必填输入框；name = 文件名（不带 .md）；正文就是可编辑正文，不含 name/description（保存时后端用 frontmatter 拼回）。

## 7. render 消息组装 before / after
before（4 条）：system = 总纲 + 描写样例；user = 历史摘要 + fresh 大纲；assistant = 上一轮正文；user = 当前指令 + 本轮大纲 + 面板 + loop_render_prompt（含 ## 风格）。

after（4 条，结构不变）：system = 总纲 + default_style 正文（含短例）；user 历史块不变；assistant 不变；user = 当前指令 + 本轮大纲 + 面板 + loop_render_prompt（无 ## 风格，有 ## 结构）+（命中且≠默认时）命名风格正文。

outline loop system：总纲 + 设定集 metadata + 语言风格 metadata。

## 8. 解析与回退
解析只从「## 语言风格」节正文里取首个 <...md>（限定到下一节前，不跨节误命中）。回退矩阵：

| 大纲「## 语言风格」节 | 命中文件 | user 末尾注入 | system 末尾 |
|---|---|---|---|
| 无 / 空 | — | 无 | 默认（常驻） |
| <default_style.md> | 默认 | 跳过（避免重复） | 默认（常驻） |
| <combat_style.md> | 存在 | combat_style 正文 | 默认（常驻） |
| <foo.md> | 不存在 | 无（warn） | 默认（常驻） |

默认永远兜底；命名失败/缺失不影响 render 出文，只 warn。

## 9. 迁移与兼容
- 历史轮大纲无该节 → 只走默认，等价于换了更克制的默认风格，无破坏。
- 删 render_examples.md 后存量 runtime 无引用。
- loop_render_prompt 文案改动，agent.js 拼法兼容。
- 建议发版随附 default_style.md 以保基底常驻；该文件缺失时 system 无默认兜底，但 render 仍可出文。

## 10. 测试
- test/dm-agent.test.js：现有用例（大纲无语言风格节 → user 末尾仍以 loop_render_prompt 结尾）仍成立；装配样板补 agent._stylesDir。新增：默认常驻（system 含默认正文、不含 frontmatter）；命名覆盖（大纲写 <combat_style.md>，user 末尾以 combat 正文结尾且在 loop_render_prompt 之后；命中 default 时 user 末尾不含默认正文）；缺失回退（<nope.md> 不抛、无注入、system 仍有默认）。
- buildStyleMetadata 单测：空目录 / 无 frontmatter 降级；有文件按 <file.md> - desc 列出、无绝对路径；default 也列出。
- test/gateway.test.js：styles CRUD + 校验（非法 name、改/删 default、路径逃逸、改名冲突、写后能读回 description/body）。

## 11. 落地顺序
1) 建 config/styles/ + 默认 + 示例；2) buildStyleMetadata + 单测；3) agent.js 改动；4) create_agent.js 设 _stylesDir；5) config.json / config-ui.json 删样例字段、加 tab；6) 两个 prompt 文件改 + 删 render_examples.md；7) gateway 4 端点；8) 前端 api + ConfigDrawer 分发 + LanguageStylesPanel；9) 串行跑 dm-agent / gateway 测试至全绿；10) 前端 build + 手测（编辑 default、新增/改名/删除、跑一轮战斗与一轮感情戏验 render 末尾加载对应正文）。

## 12. 确认点
1. 叠加 vs 替换：点名非默认时默认是否仍常驻 system 末尾？本方案取叠加。
2. 改名：编辑非默认时 name 可改（后端自动 rename）。只想要新增/删除则 name 编辑态设只读。
3. body 必填：description 必填（你要的）；body 我也设必填（空风格无意义）。要允许空 body 去掉该校验即可。
