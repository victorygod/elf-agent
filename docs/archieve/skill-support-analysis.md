# Claude Code Skill 实现源码分析

> 分析对象:`@anthropic-ai/claude-code` 安装本体 `cli.js`(minified, 约 12MB)
> 分析方式:逆向精读,所有结论附 `cli.js` 行号证据
> 分析日期:2026-06-28

## 0. 说明

- 桌面那个 `claude-code-source-code-deobfuscation-main/claude-code` 反混淆源码是**老版本,完全没有 skill 逻辑**。Skill 是较新加入的特性,全部实现都在当前安装的 minified `cli.js` 里,行号为该文件行号。
- minified 代码单行很长,下文"改写"指补回变量名/注释帮助理解,逻辑保持不变;"原文"指直接引用。
- 文件统一路径:`/Users/wolf/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js`

---

## 1. Skill 的发现与加载

### 1.1 加载入口 `WN8`(行 1637)

`WN8` 是 skill 加载总入口,用 `Promise.all` 并行从 **5 个来源**加载,每个来源打 `source` 标签:

```js
// cli.js:1637  (改写)
let q = tt(d8(), "skills"),                   // user:    ~/.claude/skills
    K = tt(CW(), ".claude", "skills"),        // managed: <cwd>/.claude/skills
    Y = GN8("skills", A);                      // project: (插件/额外目录列表)
let [w, O, $, H, j] = await Promise.all([
    Gp6(K, "policySettings"),                                          // 企业级(managed)
    kH("userSettings") ? Gp6(q, "userSettings") : [],                  // 个人级
    _ ? Promise.all(Y.map(G => Gp6(G, "projectSettings"))) : [],        // 项目级(可多个)
    _ ? Promise.all(z.map(G => Gp6(tt(G,".claude","skills"),"projectSettings"))) : [], // 额外父目录
    ES9(A)                                                              // 旧版 commands(.claude/commands/*.md)
]);
```

来源标签:`userSettings` / `policySettings` / `projectSettings` / `plugin`。决定**优先级与权限策略**。

### 1.2 单目录解析 `Gp6(A, q)`(行 1637)

核心函数。遍历某 skills 目录下**每个子目录/符号链接**,读其 `SKILL.md`:

```js
// cli.js:1637  (改写)
async function Gp6(dirA, sourceQ){
  let entries = await fs.readdir(dirA)        // 异常吞掉(ENOENT/EACCES/EPERM 返回 [])
  return (await Promise.all(entries.map(async e => {
    if(!e.isDirectory() && !e.isSymbolicLink()) return null
    let w = join(dirA, e.name),
        O = join(w, "SKILL.md"),
        $ = await fs.readFile(O, "utf-8")     // 读不到就跳过
    let {frontmatter:H, content:j} = SH($, O) // SH: 拆 frontmatter + 正文
    let J = e.name                             // skillName = 目录名
    let M = SL(H.description, J)               // description(规范化)
    let D = M ?? qc(j, "Skill")                // 无 description 时从正文取标题兜底
    let X = II(H["allowed-tools"])             // 解析 allowed-tools
    let P = H["user-invocable"]===void 0 ? true : io(H["user-invocable"])
    let W = io(H["disable-model-invocation"])  // 两态布尔
    let Z = H.model==="inherit" ? void 0 : H.model ? M5(H.model) : void 0
    let G = vK4(H, J)                           // hooks(zod 校验)
    let f = H.context==="fork" ? "fork" : void 0 // executionContext
    let T = H.agent                             // 子代理类型
    let N = Wp6(H.arguments)                    // 命名参数
    let V = TS9(H)                              // paths(glob 条件激活)
    return { skill: NK4({...}), filePath: O }
  }))).filter(Boolean)
}
```

可见 frontmatter 支持字段:**`description` / `name`(displayName) / `allowed-tools` / `user-invocable` / `disable-model-invocation` / `model` / `context` / `agent` / `arguments` / `when_to_use` / `paths` / `hooks` / `version`**。

要点:
- `skillName` 永远取自**目录名**,不取 `name` 字段(`name` 仅显示名)。
- 无 `description` 时用 `qc(j, "Skill")` 从正文取标题兜底。

### 1.3 旧版 commands 也变成 skill:`ES9`(行 1637)

`.claude/commands/foo.md` 被 `ES9` 加载,构造的 skill `loadedFrom: "commands_DEPRECATED"`。即官方文档说的"custom commands 合并进 skills"——代码把旧 command 与新 skill 统一成同一个 `type:"prompt"` 对象,**共用同一套触发/注入/路由路径**。

### 1.4 同文件去重 `fS9` + `vS9`(行 1635 / 1637)

两道去重:
- **`fS9`**(行1635):对每个 skill `filePath` 做 `fs.realpath`(解析符号链接)拿真实 inode,`WN8` 用真实路径做 key 去重。同文件被多来源引用只保留第一个,日志:`Skipping duplicate skill 'X' from Y (same file already loaded from Z)`。
- **`vS9`**(行1637):按目录分组,若一目录有多个 `SKILL.md`(大小写不敏感,`PN8 = /^skill\.md$/i`),取第一个并告警 `Multiple skill files found`。

```js
// cli.js:1637  (WN8 收尾)
let P = J.length - X.length
if(P > 0) k(`Deduplicated ${P} skills (same file)`)
```

---

## 2. Frontmatter 解析

### 2.1 `SH(A, q)`(行 524)

```js
function SH(text, filePath){
  let m = text.match(v_8)  // v_8 = /^---\s*\n([\s\S]*?)---\s*\n?/
  if(!m) return {frontmatter:{}, content:text}
  let fm = m[1] || "", body = text.slice(m[0].length)
  let obj = {}
  try { obj = YAML.parse(fm) }            // 标准 YAML
  catch { try { obj = YAML.parse(unescape(fm)) } catch(e){ warn(`Failed to parse YAML frontmatter in ${filePath}`) } }
  return {frontmatter:obj, content:body}
}
```

正则 `^---\s*\n...---\s*\n?`,**只在文件开头**生效。YAML 解析两层 fallback(直解失败→转义后解)。

### 2.2 description 规范化 `SL`(行 524)

```js
function SL(desc, name, ctxLabel){
  if(desc == null) return null
  if(typeof desc === "string") return desc.trim() || null
  if(typeof desc === "number" || typeof desc === "boolean") return String(desc)
  return null  // 否则告警并丢弃
}
```

`hasUserSpecifiedDescription` = `SL` 返回非 null。该标志后面决定"是否对模型可见"(见 §4.1)。

### 2.3 `allowed-tools` 解析 `II`

`II` 把字符串或列表形式的工具规则解析成结构化规则。`tz1`/`KX7`(行524)负责展开 `Tool(spec1,spec2){...}` 这种逗号+花括号复合语法。

### 2.4 hooks 校验 `vK4`(行 1635)

```js
function vK4(A, skillName){
  if(!A.hooks) return
  let r = _L().safeParse(A.hooks)  // zod schema 校验
  if(!r.success){ warn(`Invalid hooks in skill '${skillName}': ${r.error.message}`); return }
  return r.data
}
```

hooks 用 **zod** 严格校验,失败即丢弃该 skill 的 hooks(不致命)。

### 2.5 paths 解析 `TS9`(行 1635)

```js
function TS9(A){
  if(!A.paths || typeof A.paths !== "string") return
  let q = tz1(A.paths).map(K => K.endsWith("/**") ? K.slice(0,-3) : K).filter(K => K.length>0)
  if(q.length===0 || q.every(K => K === "**")) return  // 全匹配 = 不限制
  return q
}
```

`paths` 是逗号分隔 glob 字符串;尾部 `/**` 被裁掉,全 `**` 视为无限制。

---

## 3. Skill 对象构造 `NK4`(行 1635)

所有来源都走 `NK4` 构造统一对象。关键字段:

```js
{
  type: "prompt",
  name,                    // skillName(目录名)—— / 命令名 + 权限匹配 key
  description,
  hasUserSpecifiedDescription,
  allowedTools,
  argumentHint, argNames,
  whenToUse,               // 来自 when_to_use
  version, model,
  disableModelInvocation,  // bool
  userInvocable,           // bool
  context: Z,              // "fork" | undefined  (注意字段名是 context 不是 executionContext)
  agent: G,
  paths: f,
  contentLength: z.length, // 正文长度(不存正文本身)
  isEnabled: () => true,
  isHidden: !M,            // user-invocable:false → 从 / 菜单隐藏
  source, loadedFrom,      // "skills"|"commands_DEPRECATED"|"bundled"|"plugin"
  hooks,
  skillRoot: X,            // baseDir
  async getPromptForCommand(T, N){ ... }  // 正文注入(见 §5)
}
```

要点:
- 入参叫 `executionContext`,构造后字段名是 `context`。后续路由判断 `H.context === "fork"`。
- 正文 `markdownContent` **未直接挂对象**,只存 `contentLength`。正文在 `getPromptForCommand` 里**按需从 `skillRoot` 读/拼装**。这是 progressive disclosure 在数据结构层面的体现——对象常驻但极轻。

---

## 4. 触发与可见性

### 4.1 哪些 skill 的 description 进模型上下文:`hR`(行 6441)

```js
// cli.js:6441
hR = A8(async A => {
  return (await h0(A)).filter(K =>
    K.type === "prompt"
    && !K.disableModelInvocation          // 关键1:disable-model-invocation:true → 不进模型上下文
    && K.source !== "builtin"
    && (K.loadedFrom === "bundled"
        || K.loadedFrom === "skills"
        || K.loadedFrom === "commands_DEPRECATED"
        || K.hasUserSpecifiedDescription  // 关键2:否则必须有用户写的 description 或 whenToUse
        || K.whenToUse)
  )
})
```

两条硬规则:
1. `disable-model-invocation: true` 的 skill,**description 完全不进模型上下文**——模型根本看不到,只能用户手动 `/name` 触发。
2. 无显式 description/whenToUse 的非内置非 skills 来源 skill 不进模型上下文(防垃圾 skill 污染)。

与 `user-invocable: false`(`isHidden:!M`)正交:后者只控 `/` 菜单显隐,不影响模型可见性。

### 4.2 description 的 token 估算:`l8z` / `EW6` / `X5`(行 6517 / 1635 / 6517)——**仅 UI 统计,不参与注入**

> ⚠️ 注意:`EW6`/`l8z` 不是注入逻辑,容易误读。真正注入见 §4.3。

```js
// cli.js:6517  X5 = 字符数/4 的粗估 token
function X5(A, q=4){ return Math.round(A.length/q) }

// cli.js:1635  EW6 = name+description+whenToUse 拼字符串后估 token 数(返回数字)
function EW6(A){
  let q = [A.name, A.description, A.whenToUse].filter(Boolean).join(" ")
  return X5(q)  // 即 q.length / 4
}

// cli.js:6517  l8z = 把每个 skill 的估算 token 数塞进 skillInfo 给 UI/预算展示
async function l8z(A, q, K){
  let Y = await yN8(T1())                         // 候选 skill 列表
  let z = O0q(A)                                  // 找 Skill 工具(sK(A, "Skill"))
  if(!z) return {skillTokens:0, skillInfo:{...}}
  let _ = await O86([z], q, K)                    // 工具自身 token
  let w = Y.map(O => ({name:O.userFacingName(), source:..., tokens: EW6(O)}))  // 每个 skill 估算
  return {skillTokens:_, skillInfo:{totalSkills, includedSkills, skillFrontmatter:w}}
}
```

`skillInfo.skillFrontmatter` 流向 UI 进度展示,**不进模型上下文**。`EW6` 返回的是数字(估算 token),不是字符串。

### 4.3 真正的注入:`qC9`/`VN8` 生成清单,经 `kN8` 裁剪,放进 system-reminder(行 1657)

模型每轮看到的 skill 清单来自这条链路,与 §4.2 无关:

**(a) 单行格式化** `VN8` + `qC9`(行 1657):

```js
function VN8(A){ return A.whenToUse ? `${A.description} - ${A.whenToUse}` : A.description }
function qC9(A){ ...; return `- ${A.name}: ${VN8(A)}` }   // 每行: "- <name>: <description>" (有 whenToUse 则追加 " - <whenToUse>")
```

**(b) 字符预算裁剪** `kN8`(行 1657):

```js
function kN8(skills, ctx){
  if(skills.length===0) return ""
  let budget = wP1(ctx)                       // wP1: 默认 16000 字符,或 maxTokens × 4(chars/token) × 0.02(2%)
  let lines = skills.map(s => ({cmd:s, full: qC9(s)}))
  let total = lines.reduce((a,x)=>a+x.full.length,0) + (lines.length-1)  // +换行
  if(total <= budget) return lines.map(x=>x.full).join("\n")             // 全装下直接全返回

  // 装不下:bundled skill 全文优先,其余按剩余预算均分
  //   单条预算 < KC9(=20 字符) → 降级为只列 `- <name>`
  //   否则 `- <name>: <desc…>`(描述超长截断加 …)
}
```

预算常量(行 1661):`aK4=0.02`(2% 上下文)、`oK4=4`(chars/token)、`sK4=16000`(默认字符兜底)、`KC9=20`(单条最小预算)。

意为装载分档:**bundled 全文 > name+截断 description > 只剩 name**。这解释了挂几十个 skill 也能装下——靠分档裁剪,不是无脑全拼。

**(c) Skill 工具自身只给静态说明,清单在 system-reminder**(`o66`,行 2883):

```js
o66 = {
  name: dH,                                            // "Skill"
  description: async ({skill:A}) => `Execute skill: ${A}`,   // 动态但极简,不含清单
  prompt: async () => OP1(qY()),                       // OP1 = 静态使用说明
  ...
}
```

`OP1`(行 1661)是纯静态文本,其中明确写道:

> **Available skills are listed in system-reminder messages in the conversation**

即工具 prompt 自己不列 skill,而是告诉模型清单在 system-reminder 消息里。`qC9`/`kN8` 产出的清单文本即注入为该 system-reminder(呼应 §10 的 L1 层)。

**修正结论**:模型每轮看到的 skill 清单 = `qC9` 格式化(``- <name>: <desc> - <whenToUse>``)、`kN8` 按预算(默认 16000 字符 / 上下文 2%)裁剪后,经 `mhY`(行3914)增量推送,在消费侧(行10610944)被 `x5([p1({content:"The following skills…",isMeta:true})])` 包裹——`x5` 调用 `qT` 给 content 包上 `<system-reminder>` 标签,最终格式是 **`<system-reminder>` + isMeta user 消息**(双重标记:`<system-reminder>` 标签让模型识别为系统元信息,`isMeta` 标记让 compaction 优先丢弃);Skill 工具自身 description 仅 `` `Execute skill: <名>` ``,prompt 为静态说明;`OP1`(行1661)里那句"Available skills are listed in system-reminder messages"是**准确描述**,清单确实在 `<system-reminder>` 标签里;`EW6`/`l8z` 的 `length÷4` token 估算仅给 UI 统计用,不参与注入。

### 4.3 Skill 工具:模型如何触发

工具名常量 `dH = "Skill"`(行 1657)。模型决定调用时进入 `he(..., "skills", "Skill")`(行 2588)分支,最终调用 skill 的 `getPromptForCommand` 注入正文。模型侧看到的是**一个名为 `Skill` 的工具**(带 `skill` 参数指明触发哪个),而非每个 skill 一个工具。

**触发后的副作用**：`$O6(name, path, content, agentId)` 把 skill 的 name + path + **正文全文**（`getPromptForCommand` 返回值——经过变量替换 + `` !`cmd` `` 预处理后）记录到进程内存(`N1.invokedSkills`)，供 compact 后 `dAq()` 读取并重新生成 `invoked_skills` attachment 注入 isMeta 消息。不是摘要——是全文。

### 4.4 用户手动调用路由(行 2797)

用户输入 `/skill-name args`,路由器(行 2797 附近):
- 查 `name`,找不到 → `Unknown skill: ${j}`
- 找到 → `case "prompt"` 分支:
  - `if(H.context === "fork") return await fWY(...)` → fork 子代理执行
  - 否则 `return await Fd4(...)` → 直接注入主对话

### 4.5 手动调用不受 disableModelInvocation 拦截

行 2883 有 `disableModelInvocation` 检查(返回 `Skill X can...` 提示)。确认:即使关闭模型触发,**用户手动调用仍可用**——字段只挡模型不挡用户。

---

## 5. 正文注入 `getPromptForCommand`(行 1637 开头)

触发后真正把正文喂给模型。拼接顺序:

```js
// cli.js:1637  (改写)
async getPromptForCommand(argStr, ctx){
  let V = skillRoot ? `Base directory for this skill: ${skillRoot}\n...` : ...
  V = NW6(V, argStr, true, argumentNames)   // $0/$1/$ARGUMENTS 参数替换
  if(/* win32 路径处理 */){ V = V.replace(/\$\{CLAUDE_SKILL_DIR\}/g, baseDir) }
  V = V.replace(/\$\{CLAUDE_SESSION_ID\}/g, currentSessionId())
  V = await QB(V, ctx, `/name`)             // !`cmd` 动态命令预处理
  return [{type:"text", text:V}]
}
```

关键点:
- **`NW6`**(行1633):参数替换。支持命名 `$name`、位置 `$0 $1`、`$ARGUMENTS`、`$ARGUMENTS[n]`、`$ARGUMENTS`(整体)。
- **`${CLAUDE_SKILL_DIR}`**:替换为 skill 所在目录绝对路径(win32 反斜杠转正斜杠)。正文可引用同目录 `template.md`、`scripts/x.sh` 等辅助文件。
- **`${CLAUDE_SESSION_ID}`**:替换为当前会话 ID。
- **`QB(V, ctx, toolName)`**:`!`command`` 动态注入预处理。**在发给模型之前**执行 shell 命令,把输出替换进文本——模型看到结果而非命令。并把 skill 自己的 `allowed-tools` 注入 `alwaysAllowRules`(行1637中段),使正文里的 `!`cmd`` 享有该 skill 免确认权限。

> 注:`getPromptForCommand` 真实位置在行 5352934(NK4 对象方法),上文"行 1637"为旧标注。

### 5.1 触发后的多条消息结构 `Fd4`(行 8236640)——关键易漏点

无论模型调 Skill 工具还是用户 `/name`,最终都走 `Fd4`(= `processPromptSlashCommand` 的注入器)产出**多条消息**,不是单条 isMeta。逐条:

```js
// cli.js:8236640  (改写)
async function Fd4(skill, args, ctx, ...){
  let w = await skill.getPromptForCommand(args, ctx)   // 正文(含变量替换、!cmd 预处理)
  let O = skill.source ? `${skill.source}:${skill.name}` : skill.name
  let $ = w.filter(t=>t.type==="text").map(t=>t.text).join("\n\n")
  $O6(skill.name, O, $, agentId)                       // 1. 记录全文供 compact 恢复
  let H = NWY(skill, args)                              // 2. <command-*> 标签段
  let J = /* 正文拼接,含额外 messages */
  let M = await gP1(gf6(正文, ctx, ...))               // 3. !cmd 动态预处理产物
  return {
    messages: [
      p1({content: H, uuid}),                           // ① 非 isMeta!<command-name>/<command-message>/<command-args>
      p1({content: J, isMeta: true}),                   // ② isMeta 裸正文(不经 x5,不包 <system-reminder>)
      ...M,                                              // ③ !cmd 预处理产物
      G4({type:"command_permissions", allowedTools, model}) // ④ 权限 attachment
    ],
    shouldQuery: true, allowedTools, model, command: skill
  }
}
```

**① `H = NWY(skill, args)`** 行 8236461:
- `userInvocable !== false`(常规 skill)→ `ud4(name, args)`(行 8236321):
  ```
  <command-name>hello</command-name>
  <command-message>/hello</command-message>
  <command-args>你好</command-args>      ← 仅当 args 非空,否则整行省略
  ```
  标签常量:`PP="command-message"`、`XP="command-name"`、`dc1="command-args"`。
- `userInvocable === false`(隐式 skill)→ `gd4(name, progressMessage)`:`<command-name>`+`<command-message>`+`<skill-format>true</skill-format>`,无 `command-args`。

**② 正文 J**:`getPromptForCommand` 产出,前缀 `Base directory for this skill: <root>`。经 `p1({content:J, isMeta:true})`,`isMeta` 但**不经 `x5`**——故不包 `<system-reminder>`(与清单 `skill_listing` 经 `x5`、`invoked_skills` 经 `x5` 形成对照)。

**防重复调用契约**:`OP1`(Skill 工具 prompt,行 1661)明确——
> "If you see a `<command-name>` tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again"

即模型看到本轮已有 ① 的 `<command-name>` 就不再调 Skill 工具。**所以 ① 是不能省的**:既让 transcript 把 skill 触发渲染成用户命令(体验一致),又是防同轮重复调用的标记。

---

## 6. Fork 子代理执行 `fWY`(行 2795)

`context: fork` 的 skill 走此路:

```js
// cli.js:2795
async function fWY(skill, ...){
  let agentId = gI()
  d("tengu_slash_command_forked", {command_name: skill.name})
  let {skillContent, modifiedGetAppState, baseAgent, promptMessages} = await $N1(skill, ...)
  k(`Executing forked slash command /${skill.name} with agent ${baseAgent.agentType}`)
  // 在独立上下文跑子代理,正文 skillContent 作为 prompt
  ... parentToolUseID: `forked-command-${skill.name}`
}
```

- `baseAgent.agentType` 来自 frontmatter `agent` 字段(`Explore`/`Plan`/`general-purpose`/自定义)。
- 正文变子代理 prompt,**独立上下文窗口**执行,不占主对话。
- 结果以进度消息/摘要回传,主对话只见 fork 产出。
- 加载状态渲染 `zl4`(行2883):fork 完成 `status==="forked"` → 显示 "Done"。

---

## 7. 权限控制

### 7.1 allowed-tools(免确认)

`allowed-tools` 两处生效:
- 注入正文 `!`cmd`` 时,挂到 `toolPermissionContext.alwaysAllowRules`(行1637)。
- 加载成功后 `zl4` 显示 `Successfully loaded skill · N tools allowed · <model>`(行2883)。

### 7.2 permissions 规则匹配 Skill(name)(行 2792 / 7316)

`/permissions` 支持 `allow Skill(review-pr)`、`deny Skill(deploy *)` 这类规则,匹配 skill 的 `name`(目录名)。是对单个 skill 的开关级控制。

---

## 8. Conditional skills(paths 条件激活)`RW6`(行 1637)

带 `paths` 的 skill 不立即激活,先存入 `kW6` 待命 Map:

```js
// cli.js:1637  (WN8 结尾)
let Z = []  // conditional
for(let G of X) if(G.paths && !oX1.has(G.name)) Z.push(G); else W.push(G)
for(let G of Z) kW6.set(G.name, G)
k(`[skills] ${Z.length} conditional skills stored (activated when matching files are touched)`)
```

用户操作文件时 `RW6`(行1637)被调用:

```js
function RW6(touchedFiles, cwd){
  for(let [name, skill] of kW6){
    if(!skill.paths?.length) continue
    let matcher = glob().add(skill.paths)
    for(let f of touchedFiles){
      let rel = isAbsolute(f) ? relative(cwd, f) : f
      if(matcher.ignores(rel)){
        ed.set(name, skill)          // 激活:待命池 → 正式池
        kW6.delete(name)
        oX1.add(name)                // 标记已激活,避免重复
        k(`[skills] Activated conditional skill '${name}' (matched path: ${rel})`)
        break
      }
    }
  }
}
```

即 `paths` 字段实现:**仅当用户操作了匹配 glob 的文件,该 skill 才激活并进入模型可见列表**。日常不占 description token。

### 动态目录发现(monorepo)`yW6`(行 1637)

从工作目录向上 climb 到仓库根,每层 `.claude/skills/` 加入候选(`LW6` 判 `projectSettings` 开关后才真正加载)。被 `.gitignore` 忽略的 skills 目录跳过(`Skipped gitignored skills dir`)。

---

## 9. Hooks 字段

skill 级 `hooks` 经 `vK4` zod 校验后挂 `skill.hooks`(`NK4` 的 `hooks:W`,行1635)。生命周期**绑定该 skill 执行**(与全局 hooks 区分),用于 skill 触发前后确定性动作。底层复用全局 hooks 机制(`_L()` 共享 schema)。

---

## 10. 设计总结:Progressive Disclosure 的代码证据

| 层级 | 代码证据 | 何时加载 |
|:--|:--|:--|
| **L0 对象常驻** | `NK4`(行1635)只存 `contentLength` 不存正文 | 加载即常驻,但极轻 |
| **L1 description 常驻模型** | `hR` 过滤(行6441)+ `qC9`/`VN8`(行1657)格式化 + `kN8`(行1657)预算裁剪 → `mhY`(行9004538)**增量推送**(只推 `!nT6.has` 新 skill;未注册 Skill 工具→`return []`)→ 消费侧(行10610944) `x5([p1({content:"The following skills…",isMeta:true})])` → `qT` 包裹 `<system-reminder>` 标签 → **`<system-reminder>` + isMeta user 消息**;`OP1`(行1661)静态指引"清单见 system-reminder"是**准确描述**;`EW6`/`l8z`(行6517)仅 UI 统计,不入上下文 | **首推全量、之后只推新增**(`<system-reminder>` + isMeta);无新增则不产出 |
| **L2 正文按需注入** | `getPromptForCommand`(行5352934)触发时读正文+替换+预处理;经 `Fd4`(行8236640)注入**两段消息**:① `NWY`(行8236461)= `<command-name>`/`<command-message>`/`<command-args>` 非-isMeta(`ud4`/`gd4`,行8236321/8236195)模拟 /命令;② 正文裸 isMeta(`p1({content:J,isMeta:true})`,**不经 `x5`、不包 `<system-reminder>`**),前缀 `Base directory for this skill: <root>`。防重复靠 `OP1`(行1661)里"看到 `<command-name>` 说明已加载"契约 | 触发瞬间 |
| **L3 辅助文件更晚** | 正文里手动引用 `${CLAUDE_SKILL_DIR}/reference.md`,模型用 Read 读取 | 模型判断需要时 |
| **L4 fork 隔离** | `fWY`(行2795)独立子代理上下文 | context:fork 时 |
| **compact 后 skill 恢复** | `dAq`(行9027944,compact 回调)→ `G4({type:"invoked_skills"})` → dispatch `case "invoked_skills"` → `x5([p1({content:"The following skills were invoked in this session. Continue to follow these guidelines:\n\n### Skill: name\nPath: path\n\n...full content...",isMeta:true})])` 重新注入本会话已触发过的 skill **正文全文**（含变量替换+预处理后结果）。关键链条：skill 触发时 `$O6(name,path,content)` 记录全文 → compact 时 `dAq()` 读取 → dispatch 转 isMeta 消息。**清单不重推**:compact 时 `gc4()` 设 `qE1=true` → 下一轮 `mhY` 把全部 skill 标进 `nT6` 后 `return []`,且 `nT6` 进程内未清 → 后续也无新增 → 清单不产出。只重推 `invoked_skills`,不重推 `skill_listing` | compact 时 |
| **paths 条件激活** | `kW6` 待命池 + `RW6`(行1637) | 操作匹配文件时 |

核心思想:**默认只让模型看到每个 skill 一句话(descriptions),用最小 token 预算覆盖尽可能多能力;真正用到的瞬间才展开正文、辅助文件、子代理**。这是 skill 相对 CLAUDE.md(全文常驻)的根本优势,也是本环境能挂几十个 skill 而不撑爆上下文的原因。

---

## 11. 关键符号速查表

| 符号 | 行号 | 作用 |
|:--|:--|:--|
| `WN8` | 1637 | skill 加载总入口(5 来源并行) |
| `Gp6` | 1637 | 单目录解析(读子目录 SKILL.md) |
| `NK4` | 1635 | skill 对象构造 |
| `ES9` | 1637 | 旧版 commands → skill(loadedFrom:commands_DEPRECATED) |
| `fS9` / `vS9` | 1635 / 1637 | 文件去重(realpath / 多 SKILL.md 取一) |
| `SH` | 524 | frontmatter + 正文拆分 |
| `SL` | 524 | description 规范化 |
| `II` | — | allowed-tools 解析 |
| `vK4` | 1635 | hooks zod 校验 |
| `TS9` | 1635 | paths glob 解析 |
| `getPromptForCommand` | 1637 | 正文注入入口 |
| `NW6` | 1633 | 参数替换($0/$1/$ARGUMENTS) |
| `QB` | — | `!`cmd`` 动态命令预处理 |
| `hR` | 6441 | 模型可见 skill 筛选 |
| `qC9` / `VN8` | 1657 | skill 清单单行格式化(`- name: desc - whenToUse`) |
| `kN8` / `wP1` | 1657 | 字符预算裁剪(默认 16000 / 上下文 2%,分档) |
| `OP1` | 1661 | Skill 工具静态使用说明(指向 system-reminder) |
| `o66` | 2883 | Skill 工具定义(`name:dH`, description/prompt/call) |
| `mhY` | 9004538 | skill_listing attachment 生产:**增量推送**(只推 `!nT6.has` 的新 skill;首推 `isInitial=true`);入口先判**未注册 Skill 工具→return []**;`qE1=true`(compact 后)时把当前全部 skill 标进 `nT6` 后 `return []`——**compact 后不重推清单** |
| `gc4` | 9004510 | 设 `qE1=true`，compact 后调用，通知 `mhY` compact 已发生 |
| `Pc` | 9004477 | 清空 `nT6` + 重置 `qE1`（仅会话重开时调用，rewind 不调） |
| `nT6` | 9013199 | `Set<string>`，记录已推送过的 skill 名，用于增量推送去重。会话内常驻，compact 不清 |
| `NZY` | 2835 | 回放历史 transcript 中的 attachment：遇 `skill_listing` → 调 `gc4()` |
| 消费侧(行10610944) | 10610944 | `case"skill_listing"` → `x5([p1({content:"The following skills...",isMeta:true})])` → `qT` 包 `<system-reminder>` |
| `qT` | 6836 | `` `<system-reminder>\n${A}\n</system-reminder>` `` 包裹函数 |
| `x5` | 6838 | 批量给消息 content 包 `<system-reminder>`(调用 `qT`);已包裹的不重复包(`Gqz` 保护) |
| `Gqz` | 6829 | 检测 content 是否已以 `<system-reminder>` 开头,已包裹则跳过 |
| `tI9` | 1780 | `/<system-reminder>\n?([\s\S]*?)\n?<\/system-reminder>/` 正则,用于解析/提取 |
| `tZq` | 6829 | 把 tool_result 中夹带的 `<system-reminder>` text blocks 提取并重排到 tool_result 后面 |
| `vE1` | 6546 | context 注入(CLAUDE.md 等),手写 `<system-reminder>` + isMeta |
| `_GY` | 2883 | skill 无配置时自动 allow(所有可枚举属性为空 → true) |
| `l8z` / `EW6` / `X5` | 6517 / 1635 / 6517 | token 估算(length÷4),仅 UI 统计,**不注入** |
| `fWY` | 2795 | fork 子代理执行 |
| `RW6` | 1637 | conditional paths 激活 |
| `yW6` / `LW6` | 1637 | 动态目录发现(monorepo) |
| `dH="Skill"` | 1657 | Skill 工具名常量 |
| `$O6` | skill 触发回调 | 每次 skill 触发成功时记录（name + path + content），供 `dAq` compact 后读取 |
| `dAq` | compact 回调 | compact 后重新注入已触发过的 skill **正文全文**（`invoked_skills` attachment，dispatch 走 `x5` 故包 `<system-reminder>`） |
| `Fd4` | 8236640 | 触发后的注入器:产出 ①`<command-*>` 非-isMeta + ②正文裸 isMeta + ③!cmd 预处理产物 + ④`command_permissions` attachment 多种消息 |
| `VWY` | 8236640 | `processPromptSlashCommand`,模型/用户触发的最终入口,内部调 `Fd4` |
| `NWY` | 8236461 | 按 `userInvocable` 选择 `ud4`(常规)或 `gd4`(隐式)生成 `<command-*>` 标签段 |
| `ud4` | 8236321 | 常规 skill 的 `<command-name>`/`<command-message>`/`<command-args>` 标签段(args 空则省略 `command-args`) |
| `gd4` | 8236195 | 隐式 skill 的 `<command-name>`/`<command-message>`/`<skill-format>true</skill-format>` |
| `PP`/`XP`/`dc1` | — | 标签常量: `"command-message"`/`"command-name"`/`"command-args"` |
| `zl4` | 2883 | 加载成功 UI 渲染 |

---

## 12. 可参考的官方文档

- Skill 主文档:https://code.claude.com/docs/en/skills.md
- Subagent:https://code.claude.com/docs/en/sub-agents.md
- Hooks:https://code.claude.com/docs/en/hooks.md
- Plugins:https://code.claude.com/docs/en/plugins.md
- Agent Skills 开放标准:https://agentskills.io
