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

### 4.2 description 的 token 统计:`l8z` / `EW6`(行 6517 / 1635)

```js
// cli.js:6517  (l8z)
let w = Y.map(O => ({name:O.userFacingName(), source:..., tokens: EW6(O)}))
return {skillTokens, skillInfo:{totalSkills, includedSkills, skillFrontmatter:w}}

// cli.js:1635  (EW6)
function EW6(A){
  let q = [A.name, A.description, A.whenToUse].filter(Boolean).join(" ")
  return X5(q)  // token 数
}
```

**注给模型的全部内容** = `name + description + when_to_use` 三段拼成字符串,**无正文**。多 skill 拼起来作为 system prompt 一部分,模型据此判断是否调 Skill 工具。

### 4.3 Skill 工具:模型如何触发

工具名常量 `dH = "Skill"`(行 1657)。模型决定调用时进入 `he(..., "skills", "Skill")`(行 2588)分支,最终调用 skill 的 `getPromptForCommand` 注入正文。模型侧看到的是**一个名为 `Skill` 的工具**(带 `skill` 参数指明触发哪个),而非每个 skill 一个工具。

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
| **L1 description 常驻模型** | `hR` 过滤(行6441)+ `EW6`/`l8z`(行6517)只拼 `name+description+whenToUse` | 每轮都在 system prompt |
| **L2 正文按需注入** | `getPromptForCommand`(行1637)触发时才读正文+替换+预处理 | 触发瞬间 |
| **L3 辅助文件更晚** | 正文里手动引用 `${CLAUDE_SKILL_DIR}/reference.md`,模型用 Read 读取 | 模型判断需要时 |
| **L4 fork 隔离** | `fWY`(行2795)独立子代理上下文 | context:fork 时 |
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
| `hR` | 6441 | 模型可见性筛选 |
| `l8z` / `EW6` | 6517 / 1635 | description token 统计/拼接 |
| `fWY` | 2795 | fork 子代理执行 |
| `RW6` | 1637 | conditional paths 激活 |
| `yW6` / `LW6` | 1637 | 动态目录发现(monorepo) |
| `dH="Skill"` | 1657 | Skill 工具名常量 |
| `zl4` | 2883 | 加载成功 UI 渲染 |

---

## 12. 可参考的官方文档

- Skill 主文档:https://code.claude.com/docs/en/skills.md
- Subagent:https://code.claude.com/docs/en/sub-agents.md
- Hooks:https://code.claude.com/docs/en/hooks.md
- Plugins:https://code.claude.com/docs/en/plugins.md
- Agent Skills 开放标准:https://agentskills.io
