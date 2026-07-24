# Agent 的 Skill 支持设计规范

> 基于 Claude Code `cli.js` 源码行为逆向(详见 [skill-support-analysis.md](./skill-support-analysis.md)),提炼出一份"一个 Agent 要支持 Skill,应当如何设计"的实现规范。
> 面向读者:Agent / harness 实现方。每条规范附 cli.js 行为依据,但不堆行号(行号见 analysis 文档)。
> 日期:2026-07-02

---

## 0. 为什么要有 Skill

Skill 解决的核心矛盾:**能力要多,上下文要省**。

- 把"反复粘贴的指令 / 检查清单 / 多步流程"抽成可复用单元;
- 默认只让模型看到每个 skill 的**一句话描述**,真正用到时才展开正文 / 辅助文件 / 子代理;
- 相对 CLAUDE.md(全文常驻),用最小 token 预算覆盖尽可能多能力。

这套理念叫 **progressive disclosure(渐进式披露)**,是整个设计的灵魂(见 §11)。如果一个 Agent 想"挂几十个能力而不撑爆上下文",就该照这个思路做。

---

## 1. 术语

| 术语 | 含义 |
|:--|:--|
| Skill | 一个可复用能力单元,本质是目录 + `SKILL.md` |
| frontmatter | `SKILL.md` 顶部 `---` 之间的 YAML,声明元数据 |
| description | frontmatter 字段,模型据此判断是否触发,**是触发准确性的关键** |
| 正文 | frontmatter 之后的 Markdown,触发时才注入 |
| 触发 | 让 skill 正文进入对话(模型自主 or 用户 `/name`) |
| 注入 | 把文本放进模型可见的上下文(isMeta user 消息) |
| 来源(source) | skill 的来源级:`user` / `project` / `managed` / `plugin` / `bundled` |
| loadedFrom | skill 载入形态:`skills` / `commands_DEPRECATED` / `bundled` / `plugin` |

---

## 2. Skill 数据模型

Agent 内部应维护一个统一的 Skill 对象。cli.js 的字段(经 `NK4` 构造)是经过验证的最小完备集:

```ts
interface Skill {
  type: "prompt"                      // 固定,prompt 型 skill
  name: string                        // skill 名 = 目录名,也是 /命令名 + 权限匹配 key
  displayName?: string                // 来自 frontmatter.name,仅显示用
  description: string                 // 来自 frontmatter,模型触发依据
  hasUserSpecifiedDescription: boolean// description 是否用户显式写了(影响模型可见性)
  whenToUse?: string                  // 来自 when_to_use,追加到清单
  allowedTools?: ToolRule[]           // 该 skill 激活期间免确认的工具
  disallowedTools?: ToolRule[]        // 激活期间移除的工具
  argumentHint?: string               // /命令 自动补全提示
  argNames?: string[]                 // 命名位置参数
  version?: string
  model?: string                      // 激活时切换的模型("inherit"=继承)
  disableModelInvocation: boolean     // true=模型不可见,只能用户手动调
  userInvocable: boolean              // false=从 / 菜单隐藏,仅模型可调
  context?: "fork"                    // 子代理隔离执行
  agent?: string                      // fork 时的子代理类型
  paths?: string[]                    // glob,仅操作匹配文件时才激活
  hooks?: SkillHooks                  // 绑定该 skill 生命周期的 hooks
  contentLength: number               // 正文字符数(注意:不存正文本身)
  skillRoot: string                   // skill 所在目录绝对路径
  source: Source
  loadedFrom: LoadedFrom
  isHidden: boolean                   // = !userInvocable
  // 正文按需读取,不入常驻对象
  getPromptForCommand(args, ctx): Promise<ContentBlock[]>  // 触发时返回注入文本
}
```

**关键设计:对象常驻但极轻——只存 `contentLength`,不存正文。** 正文在 `getPromptForCommand` 触发时才从磁盘读。这是 progressive disclosure 在数据结构层面的体现。

---

## 3. SKILL.md 规范

### 3.1 文件格式

```markdown
---
name: my-skill                       # 可选,仅显示名;skill 名取目录名
description: 做什么 + 何时用。核心用法放最前,模型据此自动触发
when_to_use: 补充触发时机/示例          # 可选,追加到清单
allowed-tools: Bash(git add *) Bash(git status)   # 可选,空格或逗号分隔
disallowed-tools: AskUserQuestion    # 可选
user-invocable: true                 # 默认 true;false=从 / 菜单隐藏
disable-model-invocation: false      # 默认 false;true=模型不可见
model: sonnet                        # 可选,激活时切换;"inherit"=继承
effort: high                         # 可选
context: fork                        # 可选,子代理隔离执行
agent: Explore                       # 可选,context:fork 时的子代理类型
arguments: issue branch              # 可选,命名位置参数
paths: "src/**/*.py, tests/**/*.py"  # 可选,glob,条件激活
hooks: { ... }                       # 可选,生命周期 hooks
version: 1.0.0                       # 可选
---

## 正文
触发后才注入。可引用同目录文件:
- 模板:`${SKILL_DIR}/template.md`
- 脚本:`${SKILL_DIR}/scripts/validate.sh`
```

### 3.2 字段优先级与默认值(必守)

| 字段 | 默认 | 作用 |
|:--|:--|:--|
| `user-invocable` | `true` | `false` → 从 `/` 菜单隐藏,但模型仍可调 |
| `disable-model-invocation` | `false` | `true` → description 不进模型上下文,模型看不到,只能用户手动调 |

这两个开关**正交**:前者管 `/` 菜单显隐,后者管模型可见性。务必区分,不要混成一个"enabled"。

---

## 4. 发现与加载

### 4.1 多来源并行加载

Agent 应支持 4+ 来源,各自打 `source` 标签(决定优先级与权限):

| 来源 | 路径 | source 标签 |
|:--|:--|:--|
| 企业级(managed) | managed settings 部署 | `policySettings` |
| 个人级(user) | `~/.<agent>/skills/<name>/SKILL.md` | `userSettings` |
| 项目级(project) | `<cwd>/.<agent>/skills/<name>/SKILL.md` | `projectSettings` |
| 插件(plugin) | `<plugin>/skills/<name>/SKILL.md` | `plugin`,命令空间 `plugin:name` |
| 内置(bundled) | 打包内置 | `bundled` |

并行加载各来源,合并成候选列表。

### 4.2 单目录解析流程

遍历某 skills 目录下**每个子目录/符号链接**:

1. 读 `<子目录>/SKILL.md`(大小写不敏感),读不到跳过;
2. 用 frontmatter 解析器拆成 `frontmatter + content`;
3. `description` 规范化:字符串 trim,null/空 → 兜底从正文取第一个标题;
4. 解析各字段(见 §3),构造 Skill 对象;
5. 记录 `filePath`。

异常(目录不存在 / 权限不足)应**静默吞掉**返回空,不要中断加载。

### 4.3 旧版 commands 兼容(强烈建议)

`.<agent>/commands/foo.md` 也应被加载,标记 `loadedFrom: "commands_DEPRECATED"`,与 skill **共用同一套触发/注入/路由**。这降低迁移成本——旧的斜杠命令自动升级为 skill。同名时 **skill 优先于 command**。

### 4.4 去重(两道,必守)

1. **真实路径去重**:对每个 skill 的 `filePath` 做 `realpath()`(解析符号链接),同一物理文件被多来源引用时只保留第一个。否则会出现"同一 skill 被算两次"。
2. **多 SKILL.md 去重**:若一个目录内有多个 `SKILL.md`(大小写差异),取第一个并告警,不要都加载。

### 4.5 优先级

同名 skill 覆盖优先级:**managed > user > project > bundled**。项目级可覆盖内置(例:项目 `.claude/skills/code-review/` 覆盖内置 `/code-review`)。插件 skill 用 `plugin:name` 命名空间,不参与同名覆盖。

### 4.6 动态目录发现(monorepo 友好)

从工作目录向上 climb 到仓库根,**每一层**的 `.<agent>/skills/` 都应被发现并加载。被 `.gitignore` 忽略的 skills 目录应跳过(避免把依赖包里的 skill 误加载)。操作子目录文件时,该子目录下的 skills 也应按需加载。

### 4.7 热更新

skills 目录下的文件变更应**当前会话即时生效**,无需重启。实现上可在加载时缓存 + 监听变更失效缓存,或每次工具调用前重算可见集合(注意性能)。

---

## 5. 触发机制

### 5.1 两种触发方式

**(a) 模型自主触发(默认)**

每轮对话,Agent 把"模型可见的 skill 清单"注入上下文(见 §6)。模型据此判断是否调用 Skill 工具。触发成功后,skill 正文通过 `getPromptForCommand` 注入。

**(b) 用户显式调用**

用户输入 `/skill-name [args]`,Agent 直接路由到该 skill,跳过模型判断。支持 `argument-hint` 补全、`$ARGUMENTS` / `$0 $1` / 命名参数传参。

### 5.2 可见性矩阵(必守)

| 配置 | 用户可 `/` 调用 | 模型可自动调用 | description 进上下文 |
|:--|:--|:--|:--|
| 默认 | ✅ | ✅ | ✅ |
| `disable-model-invocation: true` | ✅ | ❌ | ❌(模型完全看不到) |
| `user-invocable: false` | ❌(从 / 菜单隐藏) | ✅ | ✅ |

### 5.3 模型可见性筛选规则

并非所有加载的 skill 都对模型可见。cli.js 的硬规则(实现方应照做):

```
模型可见 = type==="prompt"
         && !disableModelInvocation
         && source !== "builtin"
         && (loadedFrom ∈ {bundled, skills, commands_DEPRECATED}
             || hasUserSpecifiedDescription
             || whenToUse)
```

要点:
- `disable-model-invocation: true` 的 skill **完全排除**(description 都不进上下文);
- 来自非标准来源的 skill 必须有用户写的 description 或 whenToUse,否则不进上下文(防垃圾 skill 污染)。

### 5.4 Skill 工具的定义

模型侧不应"每个 skill 一个工具",而是**一个统一的 `Skill` 工具**,带参数指明要触发哪个:

```ts
SkillTool = {
  name: "Skill",
  description: async ({skill}) => `Execute skill: ${skill}`,  // 动态但极简
  prompt: async () => STATIC_USAGE_TEXT,                       // 静态使用说明
  inputSchema: { skill: string, args?: string },
  // ...
}
```

工具自身的 `description` 只表明"执行某个 skill",**不含 skill 清单**。清单通过 §6 的注入机制单独进上下文。这样无论挂多少 skill,工具定义恒定,不污染工具列表。

`prompt` 静态说明**必须复刻 CC `OP1`**(§6.7),其中"If you see a `<command-name>` tag... the skill has ALREADY been loaded"是防同轮重复调用的契约,不能省。触发后的注入结构见 §6.6(`<command-name>` 非-isMeta + 正文裸 isMeta,两段)。

---

## 6. 注入机制(最易踩坑的部分)

> ⚠️ 这是 cli.js 里最容易误读的地方。**注入 ≠ system prompt 字段**,也**≠ token 估算函数**。务必分清三层。

### 6.1 三层分清(踩坑警告)

| 层 | 函数(对应认知) | 实际作用 |
|:--|:--|:--|
| 注入层 | `qC9`/`VN8` + `kN8` | 生成清单文本,裁剪后**注入 system-reminder 消息** |
| 工具层 | `OP1` / Skill 工具 description | 静态使用说明,指向 system-reminder |
| 统计层 | `EW6`/`l8z`/`X5` | `length÷4` 估算 token,**给 UI/预算看,不进模型** |

**常见错误**:看到 `EW6` 把 name+description+whenToUse 拼起来,就以为是"注入 system prompt"。实际它只返回估算数字给 UI。注入是独立的 `qC9`/`kN8` 链路。

### 6.2 清单格式化(注入层)

每个可见 skill 格式化为一行:

```
- <name>: <description> - <when_to_use>
```

- 有 `when_to_use` 时追加 ` - <whenToUse>`,否则只有 description;
- 多行用 `\n` 拼接。

### 6.3 字符预算裁剪(必守,否则撑爆上下文)

清单不能无脑全拼,要有字符预算:

```
budget = env.SLASH_COMMAND_TOOL_CHAR_BUDGET
       || maxTokens × charsPerToken × budgetPercent   // cli.js: maxTokens × 4 × 0.02(2%)
       || 16000  (默认兜底)
```

裁剪分档(装不下时按此降级):

1. **全文优先**:`bundled` skill 全文保留(内置的核心能力不能被裁没);
2. **均分剩余**:其余 skill 按剩余预算均分单条额度;
3. **单条额度 < 阈值(20 字符)** → 降级为只列 `- <name>`;
4. **否则** `- <name>: <desc…>`(描述超长截断加 `…`)。

这套分档是"挂几十个 skill 也能装下"的关键。实现方必须做,不能省。

### 6.4 注入载体:`<system-reminder>` + isMeta user 消息

cli.js 的实际实现(消费侧行 10610944):

```js
case "skill_listing": {
  if (!A.content) return [];
  return x5([p1({
    content: `The following skills are available for use with the Skill tool:\n\n${A.content}`,
    isMeta: true
  })])
}
```

#### 6.4.1 增量推送 + 去重(`mhY`/`nT6`/`qE1`)——compact 后为何不重推清单

> ⚠️ 关键易错点。CC 的 skill 清单**不是每轮全量推**,而是**增量推送 + 会话内去重 Set**。这是 compact 后不重推清单的根本原因,实现方必须照做,否则 compact 后会重复推一遍已知 skill。

CC 的清单生产函数 `mhY`(行 9004538):

```js
function mhY(A){
  if(!A.options.tools.some(O=>K3(O,dH))) return [];   // ① 没注册 Skill 工具 → 不产出
  let K = await hR(qY());                               // 当前可见 skill 列表
  if(qE1){                                              // ② compact 刚发生(qE1=true)
    qE1 = false;
    for(let O of K) nT6.add(O.name);                    //    把当前所有 skill 标记"已推送"
    return [];                                          //    返回空!本轮不推清单
  }
  let Y = K.filter(O => !nT6.has(O.name));              // ③ 只推"没推过的"新 skill
  if(Y.length === 0) return [];                         //    无新增 → 不产出
  let z = nT6.size === 0;                               //    首推=true
  for(let O of Y) nT6.add(O.name);                      //    标记已推
  return [{type:"skill_listing", content:kN8(Y,_), skillCount:Y.length, isInitial:z}]
}
```

三个状态:
- **`nT6: Set<string>`**(行 9013199):会话内常驻的"已推送 skill 名"集合。会话内**只增不减**,compact 不清空,只有会话重开(`Pc()`,行 9004477)才清空。
- **`qE1: boolean`**:`gc4()`(行 9004510)在 compact 时设 `true`,作为下一轮 `mhY` 的"compact 刚发生"信号。
- **`hR`**:计算当前可见 skill 列表(`getVisible` 的 CC 对应)。

**为何 compact 后不重推清单**:
- compact 把旧清单消息(连同其他历史)摘掉换成摘要文本
- 但 `nT6` 是进程内 Set,**不在消息里,compact 不动它**——旧 skill 仍标记"已推过"
- 下一轮 `mhY` 进 `Y = K.filter(!nT6.has)`→ 都已推过 → `Y` 为空 → `return []`
- `qE1` 分支是**兜底保险**:即使某情况导致 `nT6` 状态与历史消息不一致,`qE1=true` 时也显式把当前全部 skill 标进 `nT6` 后返回空,**确保不重推**

**模型在 compact 后靠什么知道有哪些 skill**:① Skill 工具**永远在工具列表里**(不受 compact 影响);② 摘要文本里可能保留了 skill 描述;③ 不靠重推清单。

**对接 elf 的含义**:
- 清单注入必须改**增量模型**(进程内 `_pushedSkills: Set`,会话常驻,compact 不清),首推全量、之后只推新增
- compact 后**不要重推清单**(对齐 CC)。`_reinjectMetaMessages` 只重推 `invoked_skills`(触发过的 skill 全文,见 §6.6.1),**不**重推 `skill_listing`
- 清单注入加门控:**未注册 Skill 工具则不产出**(对齐 ①)——呼应 §15 的 opt-in 设计

关键细节:**`x5` 包了 `p1`**。`x5` 的作用是对每条消息的 content 调用 `qT`,即自动包裹 `<system-reminder>` 标签:

```js
function qT(A) { return `<system-reminder>\n${A}\n</system-reminder>` }

function x5(A) {
  return A.map(q => {
    if (typeof q.message.content === "string")
      return {...q, message: {...q.message, content: qT(q.message.content)}}
    // array case: 每 text block 包 qT
  })
}
```

所以 skill 清单的最终格式是:

```
role: "user"
content: "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n- name: desc\n- name2: desc2\n</system-reminder>"
isMeta: true
```

**双重机制**:
- **`<system-reminder>` 标签**:在内容层面标记为系统元信息,模型被训练识别并"不主动提及";
- **`isMeta: true`**:在消息层面标记为元消息,不计入用户实际对话轮次。compact 时**参与摘要**（和其他 user 消息一起被摘要文本替代），compact 后不主动重推。各 producer 按自身条件重新判断是否产出新消息。但有一个例外：CC 的 `dAq()`→`invoked_skills` attachment 在 compact 后**重建**本会话已触发过的 skill 的**正文全文**（`$O6` 记录了 `getPromptForCommand` 返回的完整内容），以 `<system-reminder>` + isMeta 消息重新注入（`invoked_skills` dispatch 也走 `x5`,故同样被 `<system-reminder>` 包裹，见 §6.6），保证模型知道之前用过哪些 skill 及其完整上下文。

`OP1`(Skill 工具的 prompt)里那句"Available skills are listed in system-reminder messages in the conversation"是**准确的描述**——清单确实在 `<system-reminder>` 标签里。

同时有一个去重保护 `Gqz`:如果某条消息的 content 已经以 `<system-reminder>` 开头,`x5`/`Gqz` **不会重复包裹**——检查 `q.startsWith("<system-reminder>")`,已包裹的直接返回原消息。

**`<system-reminder>` 在 cli.js 中的整体用法**(不只是 skill):

| 用途 | 函数 | 方式 |
|:--|:--|:--|
| Skill 清单 | `x5`(`qT`) 包裹 `p1` isMeta 消息 | `<system-reminder>...content...</system-reminder>` + isMeta |
| Context 注入(CLAUDE.md 等) | `vE1` 直接手写 `<system-reminder>` + `p1` isMeta | 同上 |
| Memory 时间戳 | `pJ7` 返回 `<system-reminder>timestamp</system-reminder>` | 内联,不被 `x5` 再包 |
| 团队上下文(team_context) | 直接手写 `<system-reminder>` + `p1` isMeta | 同上 |
| Read 工具返回 | 空文件/偏移量警告 | 内联在 tool_result 里 |
| deferred tools 提示 | 纯文本说明 | 不包裹,只提"appears in `<system-reminder>` messages" |
| MCP 变更通知 | `gmq` 变量预写 `<system-reminder>...` | 内联 |

`<system-reminder>` 的**消费侧**:
- `tI9` 正则 `/<system-reminder>\n?([\s\S]*?)\n?<\/system-reminder>/` 用于解析/提取标签内容;
- `tZq` 把 tool_result 消息中夹带的 `<system-reminder>` text blocks 提取出来,插到 tool_result 后面(避免被模型忽略);
- 行 3781:从 tool_result 中 **strip 掉** `<system-reminder>` 标签(用于文件内容去噪/缓存 key 计算)。

### 6.5 正文注入(触发后)

触发(模型调 Skill 工具 or 用户 `/name`)后,`getPromptForCommand(args, ctx)` 返回正文文本块,经 §7 变量替换 + 动态预处理后,按 §6.6 的**多条消息结构**注入(关键:不是单条 isMeta)。

### 6.6 触发后的消息结构(必守,完全对齐 CC)

> ⚠️ 这是易踩第二坑。CC 触发 skill 后**注入的不是一条 isMeta**,而是多条消息,语义各不同。漏掉 `<command-name>` 那条会丢失"防同轮重复调用"能力(见 §6.7)。

CC 的 `Fd4` 函数(`processPromptSlashCommand` 的最终注入器,行 8236640)每次触发产出 4 类消息:

```
① p1({content: H, uuid})          ← 非 isMeta!模拟"用户敲了 /命令"的可见消息
② p1({content: J, isMeta: true})   ← isMeta,裸正文(不包 <system-reminder>)
③ ...M                             ← !cmd 动态预处理产物(本期不做,留空)
④ G4({type:"command_permissions"}) ← allowedTools 权限 attachment(本期不做)
```

**① H = NWY(skill, args) = `<command-*>` 标签段**,对 `userInvocable !== false` 的常规 skill(`ud4`):

```
<command-name>hello</command-name>
<command-message>/hello</command-message>
<command-args>你好</command-args>      ← 仅当有 args 时才加这行;无 args 则整行省略
```

> `userInvocable === false` 的隐式 skill 走 `gd4`:`<command-name>` + `<command-message>` + `<skill-format>true</skill-format>`,无 `<command-args>`。本期仅做常规 skill(`userInvocable:true`,默认)。

**② J = 正文**(已变量替换、!cmd 预处理):
```
Base directory for this skill: <skillRoot>

<正文全文>
```
**裸 isMeta,经 `p1({content:J, isMeta:true})` 构造,不走 `x5`,所以不包 `<system-reminder>`。** 与清单(§6.4,走 `x5` 故包 `<system-reminder>`)和 `invoked_skills`(§6.6.1,走 `x5` 故包 `<system-reminder>`)形成对照——只有触发瞬间的正文这条是裸的。

**关键:item ① 必须用 `addUserMessage(..., isMeta=false)`(非 isMeta)**,因为它语义是"用户敲了 /命令",要计入对话可见性、让 transcript 把 skill 触发渲染成用户命令行(使用体验一致性靠这一条)。item ② 才用 `addMetaMessage(裸正文, 'skill_invocation')`。

#### 6.6.1 invoked_skills(compact 恢复全文重注)

compact 后 `dAq()` 重新注入已触发过的 skill 正文全文,**走 `x5`(包 `<system-reminder>`)+ isMeta**:

```
<system-reminder>
The following skills were invoked in this session. Continue to follow these guidelines:

### Skill: hello
Path: /path/to/.elf/skills/hello

<正文全文>

---

### Skill: another
Path: ...
<正文全文>
</system-reminder>
```

注意与 §6.6 ② 的区别:**触发瞬间**的正文是裸 isMeta;**compact 恢复**的正文是 `<system-reminder>` 包裹 isMeta。CC 代码侧:`Fd4` 的 J 不经 `x5`,`invoked_skills` dispatch 经 `x5`。

### 6.7 Skill 工具的静态说明(防重复调用)

Skill 工具 `prompt`(复刻 CC `OP1`,行 1661)必须含这段,否则模型会在同轮重复触发同一 skill:

```
- invoke using fully qualified name

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
```

最后一条是防重复的契约:模型看到本轮已有 `<command-name>`(来自 §6.6 ①)就不再调 `Skill` 工具。**所以 §6.6 ① 那条 `<command-name>` 消息不能省**——它既是"模拟用户命令"的体验一致,也是防重复调用的标记。

---

## 7. 正文处理:变量替换 + 动态预处理

`getPromptForCommand` 的处理顺序(cli.js 行 5352934 验证过的可靠流程):

1. **拼装 base**:开头注明 skill 根目录 —— `` `Base directory for this skill: ${skillRoot}\n\n${正文}` ``;
2. **参数替换**(`NW6`):
   - 命名参数 `$<argName>` —— 按 frontmatter `arguments` 顺序替换;
   - 位置参数 `$0 $1 ...`、`$ARGUMENTS[n]`、`$ARGUMENTS`(整体);
3. **路径变量**(顺序:先 dir 后 session):
   - `${CLAUDE_SKILL_DIR}` → skill 所在目录绝对路径(win32 反斜杠转正斜杠);**这是 CC 原生变量名**,elf 应支持;同时兼容 `${SKILL_DIR}` 别名
   - `${CLAUDE_SESSION_ID}` → 当前会话 ID;
4. **动态命令预处理 `` !`<cmd>` ``**(`QB`):在发给模型**之前**执行 shell 命令,把**输出**替换进文本——模型看到的是结果,不是命令。预处理时,该 skill 的 `allowed-tools` 应注入免确认规则,使正文里的 `` !`cmd` `` 享有该 skill 权限。**本期 L2 不做 !cmd 预处理**(正文里的 `` !`cmd` `` 原样保留,留到后续)。

要点:第 4 步是**预处理**,不是模型执行的。这是 skill 能"自带动态上下文"(如 `` !`git diff` ``)的基础。

---

## 8. Fork 子代理执行

`context: fork` 的 skill 在**独立子代理上下文**执行,不占主对话:

1. 从 frontmatter `agent` 字段取子代理类型(如 `Explore` / `Plan` / `general-purpose` / 自定义);
2. 正文经 §7 处理后作为**子代理的 prompt**;
3. 起独立子代理运行,主对话只看到进度消息 + 最终摘要;
4. 加载状态应明确告知用户("Done" / forked);
5. 结果以摘要回传主对话。

适用场景:研究类、批量操作类、上下文消耗大的 skill。代价是结果压缩,适合"只要结论不要过程"的任务。

---

## 9. 权限模型

### 9.1 allowed-tools(免确认,激活期间有效)

skill 的 `allowed-tools` 在该 skill 执行期间生效:
- 正文 `` !`cmd` `` 预处理时,挂到 `alwaysAllowRules`;
- 直接工具调用时,注入到该 skill 的 tool permission context;
- 加载成功后应向用户展示 `Successfully loaded skill · N tools allowed`。

### 9.2 权限规则匹配单 skill

`/permissions` 应支持按 skill 名精细控制(匹配 `name` / 目录名):

- `allow Skill(review-pr)` —— 允许该 skill;
- `allow Skill(deploy *)` —— 允许 deploy 及其子命令;
- `deny Skill(deploy *)` —— 禁止。

匹配规则支持精确名 + `prefix:*` 通配。默认行为:skill 首次执行应 `ask`,用户允许后可写回 local settings(`Skill(name)` + `Skill(name:*)` 两条规则)。

### 9.3 无配置 skill 自动 allow

cli.js 的 `_GY` 函数:如果 skill 对象的所有可枚举属性都是空值(void / null / [] / {} / 空字符串),则视为"无配置 skill",自动 allow 免确认。一组内部元数据字段(如 `zGY` 集合)不参与判断。

这意味着:一个什么额外配置都没有的纯 prompt skill(无 allowedTools、无 model、无 hooks 等),首次执行直接通过,不弹权限确认。有配置的 skill 则走 `ask` + 建议写回 `Skill(name)` + `Skill(name:*)` 两条 allow 规则。

### 9.4 disable-model-invocation 是权限的补充

`disable-model-invocation: true` 是"模型不可见"的硬隔离;`permissions` 的 `deny Skill()` 是"可见但不让执行"的运行时拦截。两者互补,都应支持。

---

## 10. Conditional Skills(paths 条件激活)

带 `paths` 的 skill **不立即激活**,先放入待命池。当用户**操作了匹配 glob 的文件**时,才激活进入可见列表:

```
待命池: paths skill(描述不进上下文,省 token)
   ↓ 用户 Read/Edit/Write 匹配 paths 的文件
激活: 移入正式池(描述进上下文,模型可见)
```

实现要点:
- `paths` 是逗号分隔 glob,尾部 `/**` 裁掉,全 `**` 视为无限制(等同不写 paths);
- 激活后标记,避免重复激活;
- 激活应记录遥测/日志(`Activated conditional skill 'X' (matched path: Y)`)。

价值:把"只在操作某类文件时才相关"的 skill(如 `python-lint` 仅在改 `.py` 时)按需浮现,日常零成本。

---

## 11. Progressive Disclosure 分层(设计哲学)

这是整个 Skill 机制的灵魂,Agent 实现应严格分层:

| 层 | 内容 | 何时加载 | token 成本 |
|:--|:--|:--|:--|
| **L0** | Skill 对象常驻(只存 contentLength,不存正文) | 加载即常驻 | 极低 |
| **L1** | description 清单(name+desc+whenToUse,裁剪后) | 每轮 `<system-reminder>` + isMeta user 消息 | 受预算控制(2% 上下文) |
| **L2** | SKILL.md 正文(变量替换) | 触发瞬间,**两段消息**(`<command-name>` 非-isMeta + 正文裸 isMeta,见 §6.6) | 按需 |
| **L3** | 辅助文件(template.md / reference.md) | 模型判断需要,主动 Read | 按需 |
| **L4** | fork 子代理(独立上下文) | context:fork 时 | 不占主对话 |
| **Compact 恢复** | `invoked_skills` — compact 后重新注入本会话已触发过的 skill **正文全文**，**`<system-reminder>` 包裹 + isMeta**(走 `x5`,见 §6.6.1)。`$O6` 记录触发状态 → compact 回调 `dAq()` 读取 → dispatch 转为 `<system-reminder>The following skills were invoked in this session. Continue to follow these guidelines:\n\n### Skill: name\nPath: path\n\n...full content...\n\n---\n\n...</system-reminder>` | compact 时 | 按需（仅已触发过的 skill） |
| **条件** | paths skill 激活 | 操作匹配文件时 | 激活前为零 |

**核心原则:默认只让模型看到每个 skill 一句话。** 任何"加载即全文注入"的设计都违背此原则,会让多 skill 场景崩溃。

---

## 12. Hooks

skill 级 `hooks`(frontmatter `hooks` 字段)绑定该 skill 生命周期,用于触发前后确定性动作:

- 用 zod(或等价 schema)严格校验,失败即丢弃该 skill 的 hooks(不致命,不影响 skill 本身);
- 与全局 hooks 区分:全局 hooks 绑定工具事件,skill hooks 绑定 skill 执行事件;
- 底层复用全局 hooks 执行机制。

**何时用 hooks 而非 skill**:某行为**必须执行**用 hooks(确定性);"最好这样做"的指导用 skill(模型决策)。

---

## 13. 实现检查清单

实现一个符合规范的 Skill 支持,逐项打勾:

- [ ] Skill 对象只存 `contentLength`,正文按需读(L0)
- [ ] 多来源并行加载(user/project/managed/plugin/bundled)+ source 标签
- [ ] 旧版 commands 兼容(loadedFrom: commands_DEPRECATED)
- [ ] 两道去重:realpath + 多 SKILL.md
- [ ] 优先级:managed > user > project > bundled,插件用命名空间
- [ ] monorepo 向上 climb 发现每层 skills,跳过 gitignore
- [ ] 热更新(文件变更即时生效)
- [ ] 触发双通道:模型自主(Skill 工具)+ 用户 `/name`
- [ ] 可见性矩阵:user-invocable / disable-model-invocation 正交
- [ ] 模型可见性筛选(disableModelInvocation 排除 + 必须有 description)
- [ ] 统一一个 `Skill` 工具,description 动态极简,prompt **复刻 CC `OP1`**(含 `<command-name>` 防重复契约,见 §6.7)
- [ ] 清单格式化 `- name: desc - whenToUse`(`qC9`/`VN8`)
- [ ] 字符预算裁剪(bundled 全文 > name+desc > 只 name),分档降级
- [ ] 清单注入 system-reminder(**走 `x5` 包裹**),**不**注入 system prompt 字段
- [ ] **清单增量推送**(§6.4.1):进程内 `_pushedSkills: Set` 会话常驻(compact 不清、rewind 不清,对齐 `nT6`/`Pc`);"首推全量、之后只推新增、无新增则不产出";**未注册 Skill 工具则不产出**(门控对齐 `mhY` ①)
- [ ] 注入层 / 工具层 / 统计层分离(不要拿 token 估算函数当注入)
- [ ] **触发后两段消息**(§6.6):① `<command-name>`/`<command-message>`/`<command-args>` 非-isMeta(`addUserMessage`)模拟 /命令;② 正文裸 isMeta(`addMetaMessage`,**不走 `x5`、不包 `<system-reminder>`**),前缀 `Base directory for this skill: <root>`
- [ ] 正文处理:参数替换 + `${CLAUDE_SKILL_DIR}`/`${SKILL_DIR}` 兼容 + `${CLAUDE_SESSION_ID}`(本期不做 `` !`cmd` `` 预处理)
- [ ] context:fork 子代理隔离执行
- [ ] allowed-tools 激活期间免确认 + UI 提示
- [ ] permissions 支持 `Skill(name)` / `Skill(prefix:*)` 精细规则
- [ ] conditional paths 待命池 + 文件操作触发激活
- [ ] skill 级 hooks schema 校验
- [ ] compact 后 skill 恢复：记录已触发 skill 全文（`$O6`）→ compact 后重新注入正文全文（**仅** `invoked_skills`，**走 `x5` 包 `<system-reminder>` + isMeta**,见 §6.6.1）。注意:与触发瞬间的裸 isMeta 正文不同,这里要包 `<system-reminder>`
- [ ] **compact 后不重推 `skill_listing` 清单**(§6.4.1):靠 `_pushedSkills` 未清空 → 下一轮 `_formatSkillListing` 自然返回空。只重推 `invoked_skills`,不重推清单——对齐 CC
- [ ] progressive disclosure 五层(L0–L4 + Compact 恢复 + 条件)齐全

---

## 14. 常见反模式(不要这么做)

| 反模式 | 问题 | 正解 |
|:--|:--|:--|
| 把所有 skill 正文都塞 system prompt | 上下文瞬间爆炸 | 只进 description 清单,正文触发时注入 |
| 用 token 估算函数当注入逻辑 | 清单根本没进上下文 | 注入是独立的格式化+裁剪链路 |
| 每个 skill 一个工具 | 工具列表随 skill 数膨胀 | 统一一个 `Skill` 工具 |
| 清单无预算裁剪 | skill 多了撑爆 | 字符预算 + 分档降级 |
| user-invocable 和 disable-model-invocation 合成一个开关 | 无法表达"只模型可调"或"只用户可调" | 两个正交开关 |
| 对象常驻时连带正文 | 内存浪费,违背 L0 | 只存 contentLength |
| 把清单放 system prompt 字段 | 清单变动破坏 prompt cache | 放 `<system-reminder>` + isMeta user 消息 |
| 同名 skill 不去重 | 同一能力算两次 | realpath 去重 |
| 触发后只塞一条 isMeta 正文、漏掉 `<command-name>` 段 | transcript 不像用户命令;**模型同轮重复触发同一 skill**(无防重复标记) | 严格按 §6.6 两段:`<command-*>` 非-isMeta + 正文裸 isMeta,且 Skill 工具 prompt 含 `OP1` 防重复契约 |
| 正文与 invoked_skills 包裹方式用反 | 与 CC 不一致,影响训练对齐的识别 | 触发瞬间正文**裸** isMeta;compact 恢复 invoked_skills **包 `<system-reminder>`** isMeta |
| **每轮全量推清单 / compact 后重推清单** | 上下文膨胀、与已知 skill 重复(违反 CC 增量推送);compact 后重复推已被摘要吸收的清单 | 增量推送 `_pushedSkills` 去重(§6.4.1):首推全量、之后只推新增;compact 后**不重推清单**,只重推 `invoked_skills` |
| 把 skill 清单注入写进基类让所有 agent 受影响 | 不支持 skill 的 agent(如 elf-001)被强塞清单 + 每轮扫目录 | 基类只留空壳钩子;skill 逻辑 opt-in(门控:注册了 Skill 工具 + registry 在线才产出清单),见 §15 |

---

## 15. 给 elf 的落地建议

基于本仓库已有子代理机制与 [skill-support-analysis.md](./skill-support-analysis.md)(源码侧),建议按此优先级落地:

1. **先做 L0 + L1 + L2**:对象模型、description 清单注入(带预算裁剪)、正文触发注入。L1 必须**增量推送**(`_pushedSkills` 去重,§6.4.1),L2 必须按 §6.6 做**两段消息**(`<command-name>` 非-isMeta + 正文裸 isMeta),否则丢失"模拟 /命令"体验和"防同轮重复调用"能力。这三层就能跑起"挂多 skill 不爆上下文"。
2. **Skill 工具 prompt 复刻 `OP1`**(§6.7):与 L2 同期做,防重复契约依赖它。
3. **opt-in 门控**(§14 反模式末行):skill 逻辑只在声明启用 skill 的 agent 上挂;基类仅留空壳钩子。未注册 Skill 工具的 agent(如 elf-001)零开销、零清单。
4. **再做触发双通道**:Skill 工具(模型)+ `/name`(用户),含可见性矩阵。
5. **fork 复用现有 subagent**:`context: fork` 直接对接已有子代理机制,正文当 prompt。投资小,收益大(研究类 skill)。
6. **conditional paths 与 hooks 可后置**:这俩是优化项,不影响主流程。
7. **Compact 恢复**:`$O6` 记录全文 + `invoked_skills` 重推全文(注意**包 `<system-reminder>`**,与触发瞬间的裸正文不同,§6.6.1)。**清单不重推**(compact 后 `_pushedSkills` 仍在 → 自然返回空,§6.4.1)——只重推 `invoked_skills`。当 skill 数量多时 invoked_skills token 消耗大，初期可先用参与摘要的方式覆盖。
7. **统计层(`EW6` 类)可选**:纯 UI 展示用,不影响功能,可最后做或不做。

> 注:本文档是规范侧,源码行号证据见 [skill-support-analysis.md](./skill-support-analysis.md)。
