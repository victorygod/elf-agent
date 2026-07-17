# Claude Code L4 compact 实现详解（2.1.209，附源码证据）

> 基于 `@anthropic-ai/claude-code` v2.1.209 原生二进制逆向。
> 证据来源：`/Users/wolf/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`（229MB，Bun 编译）。
> 提取方法：`strings <binary> | grep`。Bun 编译保留了内联函数体的可读 JS，故能拿到源码级证据。
> 日期：2026-07-16

---

## 0. 逆向前提与方法

**版本**：2.1.209（`BUILD_TIME: 2026-07-14T03:52:37Z`，`GIT_SHA: 0fe0485...`，二进制内 `VERSION:"2.1.209"`）。

**形态变化**：2.1.77 是单个 minified `cli.js`；2.1.209 改成 Bun 编译的原生二进制 `bin/claude.exe`（229MB）。控制流被编译，但**字符串常量 + 内联函数体**以明文嵌入，可被 `strings` 提取。

**可信度分层**：
- ✅ 高：`strings` 提取到的字面 prompt 文本、格式串、可读函数体（直接引用）。
- ⚠️ 中：函数语义推断（变量名已混淆为 `CHu`/`EHu`/`z6r` 等，靠上下文 + 2.1.77 逆向佐证）。
- ❌ 低：纯控制流分支（二进制读不到）。

下文每条结论附 `strings` 行号或代码片段。

---

## 1. L4 compact 的四条路径

2.1.209 的 L4 不再是单一"全量替换"，而是按触发场景分四条路径：

| 路径 | 函数（混淆名） | 触发 | 行为 |
|---|---|---|---|
| 全量自动 | `ZZn` → `CHu` | Agent Loop 内、每轮 LLM 前超阈值 | 经典全量摘要替换 |
| Reactive | `neo` → `aDg` | 阈值/413 错误 | 按 group 逐步淘汰、保留近期 |
| Partial (手动) | `EHu` | 用户手动选消息 | 只摘选中段、保留其余 |
| Precomputed | `BXi`/`$Hu`/`neo` | 后台预计算（实验 `tengu_sepia_moth`） | 提前算好、触发时零等待 swap |

**证据**（`strings` 行 399396，`EHu` 函数体可见）：
```js
async function EHu(e,t,r,n,o){
  let{userFeedback:i,direction:s="from",...}=o??{};
  ...
  let f = s==="up_to" ? e.slice(0,t) : e.slice(t);   // 选摘要段
  let m = ... e.slice(t).filter((z)=>z.type!=="progress"&&!(z.type==="user"&&z.isCompactSummary)); // 保留段
  ...
  let b = gHu(_,s), T = Br({content:b}), E = {preCompactTokenCount:g, direction:we(s), messagesSummarized:f.length};
  for(;;){
    k = await CHu({messages:w, summaryRequest:T, ...});  // 调 LLM 摘要
    H = wJ(k);
    if(!H?.startsWith(r6)) break;                        // r6 = Summary 前缀
    I++;
    let z = I<=THu ? SHu(w,k) : null;                    // THu=3 重试上限
    if(!z) throw M("tengu_partial_compact_failed",{reason:He("prompt_too_long"),...E,ptlAttempts:I});
    ...
  }
  ...
  let U = Q6r("manual", g??0, j, i, f.length);           // 构造 boundary marker
  let K = [Br({content: z6r(H,{...}), isCompactSummary:!0, ...})];  // 摘要 user 消息
  ...
  d = HH([U, ...K, ...m, ...O, ...N]);                   // 最终: [boundary, summary, 保留, 附件, hook]
}
```

---

## 2. 核心摘要请求 `CHu`（LLM 调用）

`CHu` 是所有路径最终调 LLM 的地方。**这是 elf-002 最该对照的部分。**

**证据**（`strings` 行 399396，`CHu` 函数体）：
```js
async function CHu({messages:e, summaryRequest:t, appState:r, context:n,
                    preCompactTokenCount:o, cacheSafeParams:i, stripNonEssential:s=!1, ...}) {
  let l = !s && Qe("tengu_compact_cache_prefix", true);   // 缓存共享开关

  // (1) 先试 cache-sharing 路径 (Fv/z$)
  if (l) try {
    let E = await z$({
      promptMessages:[t],
      canUseTool: AXi(),            // ← 关键: 工具全 deny
      querySource:"compact",
      forkLabel:"compact",
      maxTurns:1,
      fallbackModel: YZn(...),
      skipCacheWrite:!0,
      skipTranscript:!0,
      ...
    });
    let w = LH(E.messages), x = zZn(E.messages);
    if (w && x && !w.isApiErrorMessage) {
      if (!x.startsWith(r6)) M("tengu_compact_cache_sharing_success", {...});
      return VZn(E.messages) ?? w;   // 缓存命中,直接用
    }
    // 没拿到文本,fallback
    M("tengu_compact_cache_sharing_fallback", {reason:He("no_text_response"), ...});
  } catch (E) { ... fallback }

  // (2) fallback: 直接流式调
  let d = !s && await J6r(...,"compact")
    ? xC([nS, j6r, ...n.options.tools.filter(E=>E.isMcp)], "name")   // tool-search 开: Read+ToolSearch+MCP
    : [nS];                                                           // 默认: 只带 Read (nS)

  let _ = HXt({
    messages: W$(m, s?[]:n.options.tools),
    systemPrompt: ld(["You are a helpful AI assistant tasked with summarizing conversations."]),  // ← 专用 system
    thinkingConfig: Y6r(n),                  // ← thinking 关
    tools: s ? [] : d,                        // ← 摘要时 tools = [Read]
    signal: n.abortController.signal,
    options: {
      model: E, fallbackModel: b[T+1],
      toolChoice: void 0,                     // ← 不强制
      querySource: "compact",
      enablePromptCaching: false,             // ← 摘要关缓存写
      promptTooLongIsHandled: true,
      effortValue: v_(n),
      ...
    }
  })[Symbol.asyncIterator]();
  ...
}
```

### 2.1 关键事实

| 项 | 值 | 证据 |
|---|---|---|
| system prompt | `"You are a helpful AI assistant tasked with summarizing conversations."` | `strings` 行 168068-168069（双份）+ `CHu` 内 `ld([...])` |
| thinking | 关（`Y6r(n)`） | `CHu` 函数体 `thinkingConfig: Y6r(n)` |
| tools | 默认 `[nS]`（Read）；tool-search 开时 `[Read, ToolSearch, ...MCP]` | `CHu` 函数体 `d = ... ? xC([nS, j6r, ...]) : [nS]` |
| toolChoice | `void 0`（不强制） | `CHu` options `toolChoice: void 0` |
| 工具能否真调用 | **不能**——`canUseTool: AXi()` 全 deny | `strings` 行 168040 `"Tool use is not allowed during compaction"`；`AXi` 定义见 §2.2 |
| enablePromptCaching | `false` | `CHu` options |

### 2.2 `AXi` —— 工具调用全 deny（关键证据）

**证据**（`strings` 行 399396 内）：
```js
function AXi(){
  return async()=>({
    behavior: "deny",
    message: "Tool use is not allowed during compaction",
    decisionReason: {type:"other", reason:"compaction agent should only produce text summary"}
  })
}
```
**证据**（`strings` 行 168040）：明文字符串 `"Tool use is not allowed during compaction"`。
**证据**（`strings` 行 399396 内）：`"compaction agent should only produce text summary"`。

> **结论**：2.1.209 证实了 2.1.77 的行为——摘要请求里 tools 字段带了 Read，但 `canUseTool` 钩子把任何工具调用硬拒绝。**Read 是摆设，模型调不了**。elf-002 用 `chat()` 的 `tools=null`（不带任何工具）效果等价、更简洁。

---

## 3. 摘要包装前缀 `z6r`（对齐 oF6）

**证据**（`strings` 行 399396 内）：
```js
function z6r(e, t) {
  let n = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n`
        + e;                                // e = 摘要正文(已加 Summary:\n 前缀)
  if (t.transcriptPath)
    n += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${t.transcriptPath}`;
  if (!t.suppressFollowUpQuestions)          // 自动压缩路径 = false → 追加续写指令
    n += continuationClause;
  if (t.replStateCleared)
    n += replStateClearedClause;
  return n.trim();
}
```

**证据**（`strings` 行 399396 内，continuationClause 定义 `'Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.'`）。

**证据**（`strings` 行 399396 内，preamble 常量）：
```
This session is being continued from a previous conversation that ran out of context.
The summary below covers the earlier portion of the conversation.
```

### 3.1 elf-002 缺失：续写指令

> 自动压缩路径下，`suppressFollowUpQuestions=false`，摘要末尾追加：
> "Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with 'I'll continue' or similar. Pick up the last task as if the break never happened."

**作用**：压缩后模型直接续上任务，不输出"好的我继续""刚才我们在做 X"之类废话。**elf-002 当前 `SUMMARY_PREAMBLE` 没有这段，值得补。**

---

## 4. compact_boundary 标记 `Q6r`

**证据**（`strings` 行 399396 内）：
```js
let U = Q6r("manual" | "auto", g/*preTokens*/, j/*anchorUuid*/, i/*userContext*/, f.length/*summarized*/);
U.compactMetadata.durationMs = Math.round(performance.now() - p);
...
d = HH([U, ...K, ...m, ...O, ...N]);                  // 最终消息序列
U.compactMetadata.postTokens = d;
A6r(U, e);
```

**证据**（`strings` 行 143127, 143129, 185578 等）：`"compact_boundary"` 字面 + `compactMetadata` 字段名，共 48 处引用。

**证据**（`strings` 行 185578, 210869）：`"Conversation compacted (` / `"Conversation compacted"` —— boundary 的 content 文本。

> **boundary 的作用**：标记"这之前已被摘要"，给后续 `vN(A)` 裁剪、partial/reactive/precomputed 复用做锚点。2.1.209 用得很重（48 处）。
> **elf-002**：之前明确去掉了 boundary（全量替换、无近期保留）。全量替换场景下 boundary 确实非必需。

---

## 5. Reactive compact（保留近期，按 group 逐步淘汰）`neo`/`aDg`

这是 2.1.209 比 2.1.77 多的、改善压缩后体验的核心机制——**不全量替换，保留最近几个 group 原文**。

### 5.0 group 的定义（`Z6r` → `xXt`）

Reactive compact 按"group"保留/摘要，group 的切分由 `Z6r` → `xXt` 决定。

**证据**（`strings` 行 399396 内）：
```js
function Z6r(e) {
  let t = Ub(e).filter((r) => r.type !== "progress");  // Ub: 裁到最近 boundary 之后; 去掉 progress
  return xXt(t);
}

function xXt(e) {
  let t = [], r = [], n;                               // t=结果group数组, r=当前group, n=上个assistant.id
  for (let o of e) {
    if (o.type === "assistant" && o.message.id !== n && r.length > 0) {
      t.push(r);                                        // 遇到新 assistant(不同id) 且当前有内容 → 切新group
      r = [o];
    } else {
      r.push(o);                                        // 否则归入当前group
    }
    if (o.type === "assistant") n = o.message.id;
  }
  if (r.length > 0) t.push(r);
  return t;
}
```

**group 边界规则**：每遇到一条**新 assistant 消息**（`type==="assistant"` 且 `message.id` 不等于上一个）且当前 group 非空，就切一个新 group。

**所以**：
> **一个 group = 一条 assistant 消息 + 紧随其后、直到下一条不同 id 的 assistant 出现之前的所有消息**（tool 结果、user、isMeta 注入等）。

**要点**：
- 用 `message.id`（API 层 id）判断新 assistant，不是 `uuid`。同一 id 的 assistant 块（流式拼接）算同 group 起点。
- **user 消息不触发切分**。开头单独的 user（后面紧跟 assistant）会自成首 group（遍历到它时 r 为空、push；到 assistant 时 r 非空切走）。
- `progress` 类消息被先过滤掉，不参与切分。
- 至少要有 2 个 group 才能 reactive compact（`o < 2` → `too_few_groups`）。
- 一条 assistant 含多个 tool_call（一次回复里 Read + Grep）算**同 group 起点**（id 相同）。

---

**证据**（`strings` 行 399396 内，`neo` 函数体）：
```js
async function neo(e, t, r) {
  let n = Z6r(e),                          // 按 group 切消息
      o = n.length;                        // group 总数
  if (o < 2) return {ok:!1, reason:"too_few_groups", ...};

  let s = 1, a = 0, l = void 0;            // s = 保留的 group 数(从1开始,逐步增)
  if (r?.initialTokenGap !== void 0 && o > 3) {
    let c = n.map((f)=>HH(f));             // 各 group token 数
    let p = r.initialTokenGap - (c[o-1]??0);
    if (p > 0) { let f = xHu(c, o-1, p); s = 1+f; l = {mode:"seeded", step:f, ...}; }
  }

  while (s < o) {
    let p = o - s,                         // p = 要摘要的 group 数
        f = n.slice(0, p),                 // 前 p 个 group → 摘要
        m = n.slice(p);                    // 后 s 个 group → 保留原文
    let g = f.flat();
    if (!g.some((b)=>b.type==="assistant")) return {ok:!1, reason:"exhausted", ...};

    let y = await aDg(g, t, r?.customInstructions, u);  // 摘要前 p 个
    if (y.ok) return {ok:!0, result:{summaryMessages:y.messages, summaryText:y.summaryText,
                                      messagesToPreserve:m.flat(), attempt:a, ...}};

    switch (y.reason) {
      case "aborted": return {...};
      case "error": return {...};
      case "media_too_large": if(!u){u=!0; continue} return {...};
      case "prompt_too_long": break;       // → 加大保留量重试
    }
    let _ = lDg(y.tokenGap, c, p);         // gap_guided: 按 token gap 算下一 step
    l = {..._, tokenGap:y.tokenGap};
    s += _.step;
  }
  return {ok:!1, reason:"exhausted", ...};
}
```

**要点**：
- 按 group 切，摘要靠前的、保留靠后的（近期原文不动）。
- `prompt_too_long` 时加大保留量（减摘要量）重试，step 由 token gap 动态算（`gap_guided`）。
- `aDg` 内同样调 `z6r` 包装、`isCompactSummary:true`。

**证据**（`aDg` 返回，行 399396 内）：
```js
return {ok:!0, summaryText:l, forkAssistantMessageCount:..., totalUsage:...,
        messages:[Br({content: z6r(l,{suppressFollowUpQuestions:!0, ...}), isCompactSummary:!0, isVisibleInTranscriptOnly:!0})]}
```
> 注意 reactive 路径 `suppressFollowUpQuestions:!0`（true）→ **不追加续写指令**（因为保留近期、模型本来就在续）。只有全量自动路径才追加。

---

## 6. Precomputed compact（后台预计算，`tengu_sepia_moth` 实验）

**证据**（`strings` 行 399396 内，`BXi`/`$Hu`/`mDg` 函数体 + 侧文件机制）：
```js
let PXi = 1, DXi = 8000000, kHu = ".precompact.json";   // 版本1, 8MB上限, 侧文件后缀
let pDg = 604800000, fDg = 150000;                       // 7天有效, 增长<150k才接受

function t5r(){  // 预计算是否启用
  if(!Gk()) return !1;
  if(!Age()) return !1;
  if(!Qe("tengu_sepia_moth", !1)) return !1;             // 实验开关
  return Tc("precomputeCompactionEnabled", !0).value;
}

// $Hu: 触发时校验侧文件能否复用
if (s.sessionId !== o) return l("session_mismatch");
if (s.model !== n) return l("model_mismatch");
if (a > pDg) return l("too_old");                        // >7天失效
if (r.every(p=>p.uuid !== s.precomputedAtUuid)) return l("boundary_missing");
let c = xv(r) - s.preCompactTokens;
if (c > fDg) return l("grew_too_much");                  // 增长>150k失效
if (c < -(s.preCompactTokens/2)) return l("shrank_too_much");
...
Fj.set(e, {status:"ready", result:PHu(s,d), ...});      // 复用成功

// mDg: 后台算好后持久化
await HHu({version:PXi, sessionId:e, agentKey:"main", model:n, cliVersion:FHu,
           createdAt:new Date().toISOString(), precomputedAtUuid:..., preCompactTokens:...,
           summaryText:r.result.summaryText, summaryMessages:r.result.summaryMessages,
           preserveUuids:r.result.messagesToPreserve.map(s=>s.uuid), ...}, t);
```

**要点**：用户打字/前台空闲时后台提前算摘要，写 `<sessionId>.precompact.json`；真触发时校验一系列条件（同 session、同 model、7 天内、边界 uuid 还在、增长 <150k）后直接 swap，零用户等待。

---

## 7. 断路器

**证据**（`strings` 行 399396 内）：
```js
let qHu = 3;                              // 连续失败 3 次禁用(同 2.1.77)

function UHu(e, t, r) {
  let n = (e?.consecutiveFailures ?? 0) + 1;
  if (n >= qHu)
    C(`autocompact: circuit breaker tripped after ${n} consecutive failures...`);
  return {kind:"failed", consecutiveFailures:n, routedThroughReactive:t, ...};
}

// 新增: rapid-refill breaker —— 短时间内反复触发也禁用
let {consecutiveRapidRefills:p} = PZn(o);
if (d.action === "trip") return {kind:"rapid_refill_breaker_tripped"};
```

> 2.1.209 比 2.1.77 多了 rapid-refill 断路器（防反复压缩-膨胀-压缩抖动）。elf-002 现在只有连续失败 3 次。

---

## 8. 摘要 prompt 文本（9 段模板）

**证据**（`strings` 行 399396 内，`$Hg` 常量 + 9 段标题，行 39-50）：
```
Your task is to create a detailed summary of the conversation so far, paying close attention
to the user's explicit requests and your previous actions.
...
1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections... include full code snippets...
4. Errors and fixes: List all errors... Pay special attention to specific user feedback...
6. All user messages: List ALL user messages that are not tool results... Preserve any security-relevant
   instructions or constraints verbatim so they remain in effect after compaction.   ← 2.1.209 新增
7. Pending Tasks: Outline any pending tasks...
8. Current Work: Describe in detail precisely what was being worked on...
9. Optional Next Step: List the next step...
```

> **2.1.209 新增**：第 6 段加了 "Preserve any security-relevant instructions or constraints verbatim so they remain in effect after compaction." —— 让安全约束在摘要中保留原文。elf-002 的 `compact_prompt.md` 没这句。

**证据**（`strings` 行 399396 内，另一条 `BHg` 变体）：
```
Your task is to create a detailed summary of this conversation. This summary will be placed at
the start of a continuing session; newer messages that build on this context will follow after
your summary (you do not see them here). Summarize thoroughly so that someone reading only your
summary and then the newer messages can fully understand what happened and continue the work.
```
> 这是 partial/reactive 路径用的变体（强调"新消息会跟在后面"）。

---

## 9. 触发时机：循环内、每轮 LLM 前

**证据**（2.1.77 时已由 agent 查实为 `iSY` 的 `while` 顶部 `autocompact`；2.1.209 的 `VXi` generator 在消息准备好后、callModel 前调用）：
```js
async function* VXi(e, t, r, n, o, i, s) {
  if (Se.DISABLE_COMPACT) return {kind:"not_needed"};
  if (o?.consecutiveFailures !== void 0 && o.consecutiveFailures >= qHu)
    return {kind:"failure_breaker_open"};
  ...
  if (!await vDg(e, a, l, n, i)) return {kind:"not_needed"};   // vDg = 阈值判定
  ...
  // 走 reactive 或全量
}
```
> 与 2.1.77 一致：每轮 LLM 调用前检查、压缩。elf-002 已对齐（`agent.js` 把 `compactIfNeeded` 移到循环内）。

---

## 10. elf-002 对照表（带证据）

| 项 | 2.1.209 | 证据 | elf-002 | 处理建议 |
|---|---|---|---|---|
| 摘要 system prompt | `"You are a helpful AI assistant tasked with summarizing conversations."` | 行 168068 + `CHu` | ✅ 一致 | — |
| thinking | 关（`Y6r(n)`） | `CHu` options | ✅ 一致（`enable_thinking:false`） | — |
| tools | `[Read]` + `canUseTool:AXi()` 全 deny | `CHu` + 行 168040 | `tools=null`（不带） | ✅ 等价，不必改 |
| toolChoice | `void 0` | `CHu` options | n/a（无 tools） | — |
| 摘要包装前缀 | `z6r` = preamble + (可选)transcriptPath + (可选)续写指令 | `z6r` 函数体 | ⓘ `SUMMARY_PREAMBLE` 只有 preamble | **⚠️ 缺续写指令** |
| 续写指令 | 自动路径追加 "Continue the conversation... Resume directly..." | `continuationClause` 常量 | ❌ 无 | **建议补** |
| 第6段安全约束 | "Preserve any security-relevant instructions... verbatim" | `$Hg` 第6段 | ❌ 无 | 可选补 |
| compact_boundary | `Q6r` + 48 处引用 | 行 143127 等 | ❌ 去掉了 | 保持（全量替换不需要） |
| 触发时机 | 循环内每轮 LLM 前 | `VXi` + 2.1.77 `iSY` | ✅ 已对齐（`agent.js`） | — |
| 全量替换 vs 保留近期 | reactive 保留近期 group | `neo` | 全量替换 | 保持（你明确要全量） |
| 断路器 | 3 次连续失败 + rapid-refill | `qHu=3` + `PZn` | 3 次连续失败 | 可选加 rapid-refill |
| 预计算 | 后台预算（`tengu_sepia_moth`） | `BXi`/`$Hu`/`mDg` | ❌ 无 | 不需要（单 agent） |
| PreCompact hook | `kge` 可阻塞/注入指令 | `EHu`/`deo` 内 `kge` | ❌ 无 | 不需要（无 hooks） |
| PostCompact 附件重建 | `eeo`（memory/skill/plan 恢复） | `eeo` 函数体 | ❌ 无 | 不需要 |
| prompt caching | `enablePromptCaching:false` | `CHu` options | n/a | — |

---

## 11. 建议补进 elf-002 的两项

### 11.1 续写指令（强烈建议）

elf-002 `message_manager.js` 的 `SUMMARY_PREAMBLE` 后追加自动路径的续写指令：
```
Continue the conversation from where it left off without asking the user any further questions.
Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface
with "I'll continue" or similar. Pick up the last task as if the break never happened.
```
**收益**：压缩后模型直接续上，不输出"好的，我继续...""刚才我们在做 X"等冗余开头，体验更自然、省 token。

### 11.2 第6段安全约束 verbatim（可选）

elf-002 `compact_prompt.md` 第 6 段补："Preserve any security-relevant instructions or constraints verbatim so they remain in effect after compaction."

**收益**：安全相关约束（如"不要删文件""不要 push"）在摘要中保留原文，不被模型意译稀释。

---

## 12. 证据可复现命令

```bash
BIN=/Users/wolf/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe

# 验证版本
strings "$BIN" | grep 'VERSION:"2.1.209"'

# 摘要 system prompt
strings "$BIN" | grep -n "You are a helpful AI assistant tasked with summarizing conversations"

# 工具全 deny
strings "$BIN" | grep -n "Tool use is not allowed during compaction"

# 续写指令
strings "$BIN" | grep -n "Resume directly"

# compact_boundary
strings "$BIN" | grep -c "compact_boundary"   # ~48

# 9 段安全约束
strings "$BIN" | grep -n "security-relevant instructions or constraints verbatim"
```

> 所有 `strings` 行号针对 2.1.209 build（`GIT_SHA 0fe0485`）。后续 CC 升级后行号会变，但**字面字符串稳定**——用字符串内容 grep 最可靠，行号仅本次参考。
---

## 13. 完整例子：5 层压缩串讲（一条消息队列的完整生命）

下面用**一个真实对话场景**串讲 5 层压缩各自何时、如何介入。先看 5 层总览：

| 层 | 触发 | 作用对象 | 机制 | 可逆性 |
|---|---|---|---|---|
| L1 | 单条 tool 结果 > 50000 字符 | 单条 `tool_result` | 存磁盘 + content 改写成 `<persisted-output>` 预览 | 原文留磁盘、可 Read 回读 |
| L2 | 单轮 group 内 tool 结果合计 > 200000 字符 | 一个 group 的 fresh tool 结果 | 按体积降序贪心淘汰最大的 → 同 L1 持久化 | 同 L1 |
| L3 | image/document block 太大 | 图片/PDF block | 替换成文本占位 | 当前版本基本空操作 |
| L4 | 累计 token 超 auto-compact 阈值 | 整段历史（老 group） | 送 LLM 摘要 → 替换成 1 条摘要 + boundary + 保留近期 | 原文留 transcript、可回读 |
| L5 | 达到 blocking limit（窗口 - 3000） | 整个请求 | 强制裁断/拒服 | 兜底，正常不触发 |

### 13.1 初始对话（无压缩触发的状态）

假设用户让 elf-002 CC 改一个大项目。逐步累积的消息队列（按 `xXt` group 边界标注）：

```
── G0 ──
  [user] 帮我重构 auth 模块

── G1 ──  (assistant#1 起的 group)
  [assistant#1] 我先看下 auth.js （tool_use: Read auth.js）
  [tool_result] const auth = require('express')...（约 12000 字符）
  [assistant#1] #同一条 assistant，但流式续: 问题在 line 45
  [assistant#1] （tool_use: Grep "password"）
  [tool_result] auth.js:45:  const pwd = ...
  [assistant#1] 我来改

── G2 ──  (assistant#2 新 group)
  [assistant#2] （tool_use: Edit auth.js  line45）
  [tool_result] 修改成功
  [assistant#2] 已更新

── G3 ──  (assistant#3 新 group)
  [assistant#3] （tool_use: Bash "cat /var/log/app.log"）
  [tool_result] ← 这里假设返回 80000 字符的日志!  ★单条超 50000
  [assistant#3] 看到关键报错...
```

此刻对话还没触发任何压缩。token 还在算。逐层看接下来怎么介入。

### 13.2 L1 介入：G3 的 80000 字符日志（单条超限）

G3 的 `Bash` 返回 80000 字符日志 > `50000`（`$q4`）。`Xq4`（L1 入口）在 `addToolResult` 写入前跑：

```
触发判定: tool_result.content.length > $q4(50000)?  80000 > 50000 → 是
  ↓
CX1: 写 80000 字符到磁盘 tool-results/<toolUseId>.txt
  ↓
IX1: content 改写为:
  <persisted-output>
  Output too large (78.1KB). Full output saved to: <filepath>
  Preview (first 2.0KB):
  <前2000字符,换行处截断>
  ...
  </persisted-output>
```

**消息队列变化**：G3 的 tool_result 从 80000 字符 → ~2100 字符的预览。**省了约 77000 字符**。

> 关键：L1 在 `addToolResult` 写入前就跑，所以 L1 淘汰的 tool_result **可能还没进过 LLM**（见之前 §"被剪掉的 fresh 是否进过 LLM" 的讨论——CC 和 elf-002 都允许淘汰未看过的，靠预览+filepath 让模型后续可 Read 回读）。

### 13.3 L2 介入：G3 同轮又读了几个大文件（合计超限）

假设 G3 的 assistant#3 接着连读了 5 个文件，每个 40000 字符（都没超 L1 的 50000，L1 不管），但 G3 这个 group 内 tool 结果合计：

```
G3 内 tool 结果合计 = 预览2100 + 5×40000 = ~202100 字符 > budgetWindow(200000)
```

L2（`Tq4`/`Hh9`/`wh9`）在 `getMessagesForLLM` 构建请求前、对 G3 这个 group 跑：

```
_h9 三态分类 G3 内 tool 结果:
  fresh     = 5 个 40000 字符的(都没被持久化、本轮首见)   ← 可淘汰
  mustReapply= L1 持久化的那条(content 已是 <persisted-output>) ← 保留
  frozen    = (本轮首见无,CC 有 seenIds 保护老结果;elf-002 无)

体积: frozen + fresh = 2100 + 200000 = 202100 > 200000

wh9 贪心淘汰(按体积降序,从最大开始):
  fresh 排序: 都是 40000,任选
  淘汰 1 个 → 总量 162100 ≤ 200000? 是 → 停
  (淘汰 = 同 L1: 存磁盘 + content 改 <persisted-output>)
```

**结果**：G3 里最大的一条 40000 字符结果被持久化成预览，总量压到 162100。L2 淘汰的数量最小化（只淘汰够达标的最少条数）。

> 注意：L2 **只看 tool_result 体积，不看 user/assistant 文本**；**只算单 group，不算全消息**（见之前 §"budget 检查是 group 还是整体" 的讨论）。

### 13.4 L3：基本不触发

2.1.209 的 L3（image/document 替换）当前基本是空操作——CC 的多模态走别的机制。本例无图片/PDF，跳过。

### 13.5 L4 介入：对话很长，累计 token 超阈值

假设对话继续到 G10，积累了大量历史。某轮 LLM 调用前，`vDg` 判定累计 token 超 `auto-compact threshold`（`GF(model) - 13000`）。L4 触发，走 **reactive compact**（`neo`）。

首先 `Z6r` 把 `Ub` 裁后的消息按 `xXt` 切成 group：

```
groups = [G0, G1, G2, G3, G4, G5, G6, G7, G8, G9, G10]   o = 11 个 group
```

`neo` 开始二分试探，保留量 `s=1` 起步：

#### 尝试 1（s=1, a=1）
```
保留 m = [G10]                      ← 只留最近 1 个 group 原文
摘要 f = [G0..G9]                   ← 前 10 个 group
g = f.flat() → G0..G9 所有消息展平

aDg(g):
  KZn(customPrompt) → compactPrompt(9 段模板)
  z$(messages=[g.toString + compactPrompt],
     canUseTool:AXi() → 全 deny 工具,
     thinkingConfig: disabled,
     systemPrompt: "You are a helpful AI assistant...",
     maxTurns: 1)
  → LLM 返回 <analysis>...</analysis><summary>...</summary>
```

- **若 LLM 成功**（G0..G9 内容能装下、摘要返回）：
  ```
  解析(lL9): 去 <analysis>、提 <summary> 加 "Summary:\n"
  包装(z6r): "This session is being continued..." + Summary + 续写指令

  最终消息队列:
    [compact_boundary marker {preTokens, trigger:"auto", messagesSummarized:10}],
    [user: "This session is being continued...Summary:\n S(G0..G9)" + 续写指令, isCompactSummary:true],
    [G10 原文]                           ← 近期 group 保留
  → 一次成功,返回,压缩结束
  ```

- **若 prompt_too_long**（G0..G9 太多、摘要请求本身超模型上限）：
  ```
  lDg(tokenGap) → 算 step（按 LLM 返回的差多少 token）
  s = 1 + step（比如 step=3）→ s=4, 下次保留 4 个、摘要 7 个
  ```

#### 尝试 2（s=4, a=2）
```
保留 m = [G7, G8, G9, G10]          ← 留最近 4 个
摘要 f = [G0..G6]                    ← 前 7 个送 LLM
```
成功 → 队列变成 `[boundary, 摘要(S of G0..G6), G7原文, G8原文, G9原文, G10原文]`。

**核心**：不是逐 group 预压缩、不是后台预算（那是 precomputed），而是**触发时同步、一次性把保护区外整段打包送 LLM 摘要、保留量从 1 起二分试探到 LLM 能吃下为止**。

#### 另一情况：全量自动路径（`ZZn`/`CHu`，非 reactive）
若没走 reactive、走经典全量：把 gHu 的全部消息送 LLM，摘要后**全量替换**成 `[boundary, summary]`，无近期保留。2.1.77 就是这套；elf-002 也是这套。

### 13.6 L5：兜底，正常不触发

若 L4 失败（断路器开、LLM 摘不了）、且 token 继续涨到 `blocking limit`（`GF(model) - 3000`），L5 强制裁断当前请求 / 拒服。这是最后防线——正常流程 L4 应该已经消化掉，L5 不该亮。

### 13.7 五层串起来的完整图景

```
对话增长 → 消息累积
  │
  ├─ 单条 tool 结果 > 50000?         → L1: 存磁盘+预览化(单条)
  ├─ 单轮 group 合计 > 200000?       → L2: 淘汰最大 fresh(同 L1)
  │   (L1/L2 都只压 tool_result,可回读)
  │
  ├─ 累计 token 超 auto-compact?     → L4: 送 LLM 摘要
  │     ├─ reactive: 保近期 s 个 group、摘要老的(s 从1 二分试探)
  │     └─ 全量: 全部摘要替换
  │   (L4 原文留 transcript,可回读)
  │
  └─ 达 blocking limit?              → L5: 强制裁断(兜底)
```

### 13.8 elf-002 的简化对照

| 层 | CC 2.1.209 | elf-002 当前 |
|---|---|---|
| L1 | ✅ 单条 > perToolLimit 持久化预览 | ✅ 一致（50000/你现在改成 10000） |
| L2 | ✅ group 合计 > budgetWindow 淘汰最大 fresh | ✅ 一致（200000；无 seenIds/frozen 保护） |
| L3 | 空操作 | 无（无多模态） |
| L4 | reactive（保近期）+ 全量 + precomputed + 断路器+rapid-refill | **全量替换**、循环内触发、断路器 3 次（无 reactive/无近期保留/无预计算） |
| L5 | 兜底裁断 | 无（靠 L4 + 断路器兜底） |
| 回读 | 持久化文件/Read + transcript | tool-results 文件 + 摘要成功即清理（零孤儿） |

**elf-002 的取舍**：L1/L2/L4 全量替换 + 摘要成功即清 tool-results——比 CC 简单（无 reactive 的近期保留、无 precomputed 预算、无 L5）。代价是压缩后无近期原文保留（直接进摘要），但单 agent 场景下够用，且 context.json 镜像 + 摘要清理比 CC 更干净。
