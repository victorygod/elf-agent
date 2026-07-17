# elf Skill 支持 vs Claude Code — 未对齐项清单

> 范围:首期实现 L0+L1+L2 + compact 恢复(**完全对齐 CC 的部分**),其余列为"未对齐项"。
> 本文档汇总:① 已对齐的部分(确认无误)② 还没和 CC 对齐的部分(按影响分级)③ 本期要改的文件总览。
> 日期:2026-07-08

---

## 1. 已对齐的部分(首期目标)

以下这些都已按 CC `cli.js` 真实行为实现/设计,不再调整:

| 项 | CC 行为 | elf 对齐点 |
|:--|:--|:--|
| L0 对象常驻只存 `contentLength` | `NK4` | `registry.js` Skill 对象 |
| L1 清单格式 `- name: desc - whenToUse` | `qC9`/`VN8` | `_formatSkillListing` |
| L1 清单注入 `<system-reminder>` + isMeta | `x5([p1(...)])` | `addMetaMessage` 已含 |
| **L1 增量推送 + `_pushedSkills` 去重** | `mhY` + `nT6` | `_formatSkillListing` 增量 |
| **compact 后不重推清单** | `qE1=true`→`return []` | `_pushedSkills` 不清 → 自然返回空 |
| Skills 工具门控(无 Skill 工具不产出清单) | `mhY` ① | 入口 `if(toolRegistry.get('Skill'))` |
| L2 触发两段消息 | `Fd4` ① `<command-*>` 非-isMeta + ② 正文裸 isMeta | `Skill.execute` 两段注入 |
| `<command-name>`/`<command-message>`/`<command-args>` 标签 | `ud4`/`PP`/`XP`/`dc1` | `Skill.execute` 内 `ud4` 等价 |
| Skill 工具 prompt 复刻 `OP1`(防重复契约) | `OP1` | `Skill.js` `TOOL_PROMPT` |
| 正文变量 `${CLAUDE_SKILL_DIR}`/`${CLAUDE_SESSION_ID}` | `getPromptForCommand` 行5352934 | `prompt.js`(+`${SKILL_DIR}` 别名) |
| `$ARGUMENTS` 整体透传 | `NW6` | `prompt.js` |
| compact 恢复 `invoked_skills` 全文重推(包 `<system-reminder>`) | `dAq` + dispatch `x5` | `_reinjectMetaMessages` |
| opt-in 门控(基类空壳,不支持 agent 零开销) | `mhY` ① 的精神 | `_skillRegistry=null` 守卫 |
| 可见性矩阵 `disableModelInvocation`/`userInvocable` 正交 | `hR`/`isHidden` | `registry.getVisible` |
| **热更新**(新增/删除/改动即时生效) | 文件变更即时 | 入口每轮 `loadAll` 重扫 + 签名集变化检测 | `_formatSkillListing` |

---

## 2. 未对齐项(按影响分级)

### 🔴 高影响 — 影响 skill 可用性,建议本期补或明确接受降级

| # | 项 | CC 行为 | elf 本期 | 影响 | 建议 |
|:--|:--|:--|:--|:--|:--|
| G1 | **目录约定** | `.claude/skills/` + `~/.claude/skills/` | `.elf/skills/` + `~/.elf/skills/` | CC skill 不能零成本复用,要复制目录 | **待定**:是否额外扫 `.claude/skills/` 双目录,由用户拍板 |
| G2 | **`!cmd` 动态预处理** | 正文内 `` !`cmd` `` 在送模型前执行,输出替换进文本(`QB`) | 原样保留,不执行 | 依赖动态上下文的 skill(`` !`git diff` ``)功能退化 | 接受降级,留后续;或挪进本期 |
| G3 | **`/name` 用户手动调用** | 用户输入 `/skill-name args` 直接触发,含补全 | 不做 | 用户无法主动触发 skill,只能等模型自主调 | 接受降级,留后续 |
| G4 | **命名参数 `$<argName>`** | 按 frontmatter `arguments` 顺序替换(`NW6`) | 不做,只 `$ARGUMENTS` 整体 | 用命名参数的 skill 取不到参数 | 接受降级 |
| G5 | **位置参数 `$0`/`$1`** | `NW6` 支持 | 不做 | 用位置参数的 skill 退化 | 接受降级 |

### 🟡 中影响 — 功能降级但不阻断基础使用

| # | 项 | CC 行为 | elf 本期 | 影响 |
|:--|:--|:--|:--|:--|
| G6 | **清单预算分档裁剪** | 三档:bundled 全文 > name+desc > 只 name(`kN8`) | 朴素整体截断到 16000 | skill 多了从行中间截断,不如 CC 精细 |
| G7 | **fork 子代理(`context: fork`)** | `fWY` 独立子代理执行 | 遇到直接报错跳过 | 研究类 skill 不可用 |
| G8 | **`allowed-tools` 免确认** | 激活期间注入 `alwaysAllowRules` | 忽略 | skill 内工具调用不享特殊权限 |
| G9 | **`paths` 条件激活** | 不操作匹配文件不进上下文(`RW6`/`kW6`) | 字段忽略,skill 恒可见 | 日常多占 description token |
| G10 | **`model:` 切换模型** | 激活 skill 时切模型 | 忽略 | skill 指定模型不生效 |
| G11 | **`hooks` 生命周期钩子** | `vK4` zod 校验 + 绑定 skill 执行 | 忽略 | skill 无确定性前后动作 |
| G12 | **`userInvocable:false` 的 `gd4` 标签** | `<command-name>`+`<command-message>`+`<skill-format>true` | 只做 `ud4` 常规格式 | 隐式 skill 标签格式不符 |
| G13 | **无配置 skill 自动 allow(`_GY`)** | 所有字段空→自动 allow 免确认 | 不做(无对应权限层) | 影响极小 |
| G14 | **`/permissions Skill(name)` 精细规则** | `allow Skill(review-pr)` 等 | 不做 | 无法按 skill 名精细控权 |

### 🟢 低影响 — 来源/分发/统计层,不影响功能正确性

| # | 项 | CC 行为 | elf 本期 | 影响 |
|:--|:--|:--|:--|:--|
| G15 | **来源数** | 5:managed/user/project/plugin(`plugin:name`)/bundled | 2:project + user | 无插件、无企业下发、无内置包 |
| G16 | **同名优先级** | managed > user > project > bundled | project > user(两层) | 仅两层覆盖,顺序也不同 |
| G17 | **去重** | `realpath` 解符号链接 + 多 SKILL.md 取一告警 | 仅按 name 做 project 覆盖 user | 符号链接多来源引用同一文件被算两次(边界) |
| G18 | **monorepo climb** | 向上爬到仓库根,每层 `.claude/skills/` 加载,跳 gitignore | 只扫 cwd 一层 + home | monorepo 父目录 skill 不被发现 |
| G19 | **commands 兼容** | `.claude/commands/foo.md` 自动升级 skill(`commands_DEPRECATED`) | 不做 | 旧斜杠命令不变 skill |
| G20 | **热更新** | 文件变更当前会话即时生效 | ⚠️ **已实现**(每轮入口重扫,纯新增推增量、删除/改动推全量修正清单) | 与 CC 对齐 |
| G21 | **分发渠道** | plugin 市场 / managed 设置 / 内置打包 | 纯手动放目录 | 无安装命令、无市场 |
| G22 | **统计层 (`EW6`/`l8z`)** | token 估算给 UI/预算展示 | 不做 | 纯 UI,无功能影响 |
| G23 | **加载成功 UI 提示** | `Successfully loaded skill · N tools allowed` | 不做 | 无 `zl4` UI 渲染 |

---

## 3. 本期要改的文件总览

### 新增(4 个)

| 文件 | 职责 | 关键点 |
|:--|:--|:--|
| `shared/agent/skills/parser.js` | frontmatter 解析 | `parseFrontmatter(text)`→`{frontmatter,body}`;不引 npm 依赖,逐行 `key:value` |
| `shared/agent/skills/registry.js` | skill 加载器 | `SkillRegistry.loadAll(cwd)` 扫 `.elf/skills/`+`~/.elf/skills/`,project 覆盖 user;`get/getAll/getVisible`;对象只存 `contentLength` |
| `shared/agent/skills/prompt.js` | 正文注入 | `getPromptForCommand(skill,args)` 读正文+替换 `${CLAUDE_SKILL_DIR}`/`${SKILL_DIR}`/`${CLAUDE_SESSION_ID}`/`$ARGUMENTS`;前缀 `Base directory for this skill:` |
| `shared/agent/tools/Skill.js` | Skill 工具 | `TOOL_PROMPT` 复刻 `OP1`;`execute` 注入两段(① `<command-*>` 非-isMeta ② 正文裸 isMeta);记录 `_invokedSkills` |

### 修改(3 个)

| 文件 | 改动 | 行级细节 |
|:--|:--|:--|
| `shared/agent/tools/index.js` | 加一行导出 | `export { Skill } from './Skill.js';`(沿用现有 re-export 风格) |
| `shared/agent/default_agent.js` | 基类加空壳钩子 + opt-in | 见下方行级 |
| `agents/elf-002/config/config.json` | opt-in 开关 + 注册工具 | tools 数组加 `"Skill"`;加 `"skills": true` |

#### `default_agent.js` 行级改动

| 位置 | 改动 |
|:--|:--|
| 构造函数(行157-159 后) | 加 `this._skillRegistry=null; this._pushedSkills=null; this._invokedSkills=null;`(默认未启用) |
| `fromConfigDir()`(行117 `return agent` 前) | 读 `config.get('skills')`,为真调 `agent._enableSkills(dataDir/..)` |
| `reasoning()` 入口(行223 `addUserMessage` 前) | 守卫注入:`if(this._skillRegistry && this.toolRegistry.get('Skill')){ const l=this._formatSkillListing(); if(l) this.messageManager.addMetaMessage(l,'skill_listing')}` |
| 新增 `_enableSkills(cwd)` | 初始化三字段:`new SkillRegistry().loadAll(cwd)` + `new Set()` + `[]` |
| 新增 `_formatSkillListing()` | 增量:过滤 `!_pushedSkills.has`,推完 `add`;未启用/无 Skill 工具返回 `''`;`<system-reminder>` 包裹;16000 截断 |
| 覆写 `_reinjectMetaMessages()`(行473) | 只重推 `invoked_skills`(包 `<system-reminder>`),**不**重推清单 |
| import 区 | `import { SkillRegistry } from './skills/registry.js';` |

### 不动(复用现有)

| 文件 | 复用点 |
|:--|:--|
| `shared/agent/message_manager.js` | `addMetaMessage(content,tag)`、`addUserMessage(content,isMeta)`、`getMessagesForLLM()`(剥离 isMeta/metaTag)、`getCompactHappened()`、`_reinjectMetaMessages` 调用契约(行238/431)——一行不改 |

---

## 4. 待用户拍板的点

1. **G1 目录约定**:`.elf/skills/`(自成体系) vs 额外兼容 `.claude/skills/`(零成本复用 CC skill)。影响 skill 可移植性。
2. **G2/G3 是否挪进本期**:`!cmd` 预处理、`/name` 手动调,是两个最影响实际体验的缺口。是否要从"延迟项"提到"本期"。
3. **registry 扫描位置**:用 `process.cwd()` 还是 elf 的工作目录(dataDir 上层)。需确认 elf 启动时 cwd 语义。

---

> 关联文档:
> - 规范侧:[skill-agent-support-design.md](./skill-agent-support-design.md)
> - 源码侧:[skill-support-analysis.md](./skill-support-analysis.md)
> - isMeta 机制:[claude-code-system-reminder-injection.md](./claude-code-system-reminder-injection.md)
> - 实施计划:`plans/cached-launching-russell.md`