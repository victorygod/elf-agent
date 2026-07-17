# Claude Code 工具结果压缩与 group 切分（2.1.209，源码证据）

> 专门回答两个问题：**工具结果（tool_result）一般是怎么被压缩的**、**历史中的 group 都会经过哪些压缩**。
> 证据来源：`/Users/wolf/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`（v2.1.209，229MB Bun 二进制），`strings -n 6` 提取字面量与内联函数体。
> 方法：`strings -n 6 "$BIN" > /tmp/cc_strings.txt`（37 万行/32M），再 `grep -n` / `perl -ne` 截取上下文。行号均指 `strings -n 6` 输出行号。
> 日期：2026-07-16

---

## 0. 可信度分层

- ✅ 字面量 / 完整函数体直接抓到（strings 行号 + 片段）
- ⚠️ 据既有 2.1.77 逆向结论 + 本轮部分证据，未在本轮 100% 绑定到判定语句
- 下文每条结论标注证据来源

---

## 1. 全景：tool_result / group 要过的闸

| 闸 | 触发对象 | 作用域 | 机制 | 可回读 |
|---|---|---|---|---|
| **microcompact** | 老 tool_result 内容 | 进程级（按 keepRecent 计数） | 文本替换为 `[Old tool result content cleared]` | 可选落盘 |
| **L1** | 单条 tool_result | 单条 | >50000 字符 → 存盘 + `<persisted-output>` 预览（2KB） | ✅ Read filepath |
| **L2** | fresh tool_result | **单个 group 内** | 合计 >200000 → 贪心淘汰最大 fresh | ✅ 同 L1 |
| **L4** | 整段老 group | **按 group** | 送摘要 LLM → 摘要 + 保留近期 group 原文 | ✅ transcript |

L1/L2/L4 原文都留盘可回读；microcompact 默认纯文本替换（可选 persist）。L4 摘要请求解剖详见 `docs/cc-compact-request-anatomy.md`，本文只讲 tool_result/group 维度落到 L4 的部分。

### 1.1 设计取向：assistant 侧刻意不裁（只压 tool_result）

上表四闸**全部作用于 tool_result**——这是有意为之，不是遗漏。CC 对 assistant 自产内容（content 文本 / thinking 块 / tool_use 调用块）**几乎不主动剪裁**，源码核实：

> ⚠️ 本节早期版本对 thinking/tool_use 的描述有误，已按源码修正（2026-07-17）。

| assistant 侧内容 | CC 处理 | 证据 |
|---|---|---|
| content prose（回复正文） | 原样保留，无 `maxChars/truncate content` 类裁剪 | 二进制无"历史 assistant 文本超长就截"逻辑，`maxChars` 仅命中解构报错 |
| thinking 块 | **会主动过滤**：删 assistant 消息**末尾连续的 thinking 块**（`tengu_filtered_trailing_thinking_block`，全删空则占位 `[No message content]`）；删**孤立 thinking 消息**（message.id 已不在历史，`tengu_filtered_orphaned_thinking_message`）。另外**服务端拒绝签名**时全 strip 重试（错误恢复，非省 token） | `K6r` 判 thinking 块；`while(o>=0){...if(!K6r(a))break;o--}` 删末尾；`server rejected a thinking block; stripping all thinking blocks and retrying`（`tengu_thinking_signature_strip_retry`） |
| redacted_thinking 块 | API 原生加密块，不可改，原样回放 | `redacted_thinking` 命中多处，类型不可修改 |
| tool_use 块（含 input 参数） | **input 原样保留**，不裁剪；CC 会给 system/tools/cache_control/各 block 算 `Bun.hash` 指纹，维护一个容量 10 的 LRU（`Cle=new Map`、`oHg=10`），逐项比对指纹（systemHash/toolsHash/cacheControlHash/历史/模型/fastMode/betas）决定**本轮在哪打 `cache_control` 断点、能命中上轮哪段 prompt cache**。这是 **prompt cache 优化层**，**不减少上下文体积**，只省缓存命中 | `$Ji`/`dHg`/`gXt`/`pHg` 算指纹；`Cle` LRU + `oHg=10`；`oIu` 移 cache_control 算"去策略后的纯内容指纹"；`cacheControlChanged`/`"cache_control changed (scope or TTL)"` 事件 |

**唯一消化 assistant 内容的手段是 L4 摘要整体替换**——把老 group 的文本+thinking+tool_use 一起喂摘要 LLM，替换成一条摘要 user 消息。没有中间态裁剪。

> 取向总结：模型自产的东西里，**thinking 会被主动清理 trailing/orphaned 块**（但不是按体积截断），**content/tool_use 原样留**；工具返回的外部数据（tool_result）才是压缩大头，因为可重生（Read 回读 / 重新执行）。tool_use 的 hash 指纹服务的是 **prompt cache 命中**（省费用/延迟），**不是上下文压缩**。**elf 当前与"不主动裁 content/tool_use"一致；但 elf 不清理 thinking 块**——elf 不开 thinking（`enable_thinking:false`），历史里本就没有 thinking 块，无需此项清理。

> 取向总结：模型自产的东西（content/thinking/tool_use）视为必须完整保留的状态，不删；工具返回的外部数据（tool_result）才是压缩大头，因为可重生（Read 回读 / 重新执行）。**elf 当前与此取向一致**：elf 也只压 tool_result（L1/L2/microcompact），assistant content/tool_use 原样留，靠 L4 摘要消化——无需改动。

---

## 2. 工具结果（tool_result）是怎么被压缩的

### 2.1 microcompact —— 轻量第一道，只裁老 tool_result 内容

**触发**：`context_hint`（SSE 服务端提示 token 偏高），**非定时器**（虽然 telemetry 名带 `time_based`，但 trigger 字段为 `context_hint`）。

**字面量证据**（strings 行号）：
| 字面量 | 行号 |
|---|---|
| `context_hint_sse` | 136403 |
| `context_hint` | 161472 / 161495 / 222529 |
| `[KEEP-RECENT MC] context_hint trigger, cleared ` | 161474 |
| `toolsCleared` | 161479 |
| `tokensSaved` | 161486 / 161449 |
| `tengu_context_hint_reject` | 161446 |
| `tengu_context_hint_busy_fallback` | 161452 |
| `[Old tool result content cleared]` | 111571 |
| `microcompact_boundary` | 155349 |
| `keepRecent` / `keepRecent:r.keepRecent` / `keepRecent:A$d` | 多处 |

**机制**：`BLs(keepRecent)` 收集所有 tool_result，保留最后 `keepRecent` 个，其余加入 clearSet；被清的内容替换为：
```
[Old tool result content cleared]
```
image/document block 填占位（`kvo`）；可选 `persist` 把原文落盘成 `<persisted-output>` 供回查（`m4y` 标记可回查）。

**边界**：用 `microcompact_boundary`（UI 不渲染），区别于 full compact 的 `compact_boundary`。
**最小节省阈值**：≈20000 token，省不到不触发（⚠️ 据 2.1.77 逆向 `$Ls=20000`；本轮 strings 见常量组 `i=20000,gSl=500,Iui=500,ySl=5,_Sl=10,bSl=1`，未直接绑定到判定语句）。
**特点**：只动 tool_result 内容，user/assistant 文本全留；非递归。

### 2.2 L1 —— 单条超限，持久化 + 预览

**触发**：单条 `tool_result.content.length > 50000`（默认，per-tool）。
**证据**：help 文本明文（strings）：
```
...50000 characters by default. If the output exceeds...
...50000). Set to a higher value if your client...
```
> 代码常量名（混淆）本轮未定位，但 help 文本证实默认 50000。

**改写模板**（strings 132041–132043 + 模板串）：
```js
`Output too large (${Ma(e.originalSize)}). Full output saved to: ${e.filepath}`
`Preview (first ${Ma(xVt)}):`
```
**预览长度常量**：`xVt=2000`（✅ 直接抓到 `d]",iGh="tengu_velvet_ibis",xVt=2000`）。截预览函数 `gFr(o, xVt)`：`{preview:i,hasMore:s}=gFr(o,xVt`。

**包装标签**：`<persisted-output>`（strings 111569）/ `</persisted-output>`（111570）。

**机制**：原文写磁盘 `filepath`，content 改写成「2KB 预览 + filepath」，模型后续可 Read 回读全文。**在 `addToolResult` 写入前就跑**——被 L1 压的 tool_result 可能还没进过 LLM。

### 2.3 L2 —— group 内合计超 budget，贪心淘汰 fresh

**触发**：单个 group 内 tool_result 合计 > `budgetWindow`。
**budget 值**：200000（⚠️ 既有逆向 `budgetWindow=200000`；本轮 strings 见 `c=200000,ej=50,tqc=1e4` 常量组，未直接绑定 L2 判定语句。注意 200000 同时是 `cve` 标准窗口值 `t=200000,cve=200000,l0h=32000,c0h=128000,d0h=1e6`，二者数值同、语义不同）。

**三态分类函数 `dGh`（✅ 本轮拿到函数体片段）**：
```js
// 分类逻辑：
// .seenIds.has(n.toolUseId)) r.frozen.push(n); else r.fresh.push(n); return r
// {mustReapply:[], frozen...}
// 调用侧：
// let {mustReapply:g, frozen:y, fresh:_} = dGh(m,t);
//   if(g.forEach((H)=>a.set(H.toolUseId,H.r...
```
三态：
- **frozen**：`seenIds` 命中（已经发给过模型的 tool_result）→ **保留不动**（CC 用 seenIds 保护老结果）
- **fresh**：未见过 → **可淘汰**
- **mustReapply**：已被 L1 持久化的（replacements map 里有）→ 保留并重放

**淘汰机制**：只对 fresh，按体积降序贪心淘汰最大的，淘汰方式同 L1（存盘 + 预览），淘汰条数最小化（只淘汰够达标的最少条数）。（⚠️ 排序淘汰那段函数体本轮未抓到，"按体积降序贪心"为据 2.1.77 逆向结论。）
**特点**：只看 tool_result 体积，不看 user/assistant 文本；只算单 group，不算全消息。

### 2.4 L4 送摘要前的 EXi media strip

reactive 路径把老历史送摘要 LLM 前，`EXi` 把 image/document 块（含 tool_result 内部的媒体块）替换成 `[image]`/`[document]` 文本占位——减小摘要请求体积，摘要不需要看图。详见 `docs/cc-compact-request-anatomy.md` §5.4。

---

## 3. group 怎么切 —— `xXt` 完整函数体（✅ 本轮拿到）

```js
for(let o of e){
  if(o.type==="assistant" && o.message.id!==n && r.length>0) t.push(r), r=[o];
  else r.push(o);
  if(o.type==="assistant") n=o.message.id
}
if(r.length>0) t.push(r); return t
```
（相邻函数 `gHu`、上层入口 `Z6r`：`Ub(e).filter(r=>r.type!=="progress")` 先裁到最近 boundary 之后、去 progress，再 `xXt` 切。）

**规则**：每遇到一条**新 assistant 消息**（`type==="assistant"` 且 `message.id` 不同于上一条）且当前 group 非空 → 切一个新 group。

→ **一个 group = 一条 assistant 消息 + 紧随其后、直到下一条不同 id 的 assistant 出现之前的所有消息**（tool_result / user / 注入等）。

**要点**：
- 用 `message.id`（API 层 id）判新 assistant，不是 uuid。同一 id 的 assistant 块（流式拼接）算同 group 起点。
- **user 消息不触发切分**。开头单独的 user（后跟 assistant）自成首 group。
- `progress` 类先过滤，不参与切分。
- 至少 2 个 group 才能 reactive compact（`o < 2` → `too_few_groups`）。
- 一条 assistant 含多个 tool_call（一次回复 Read + Grep）算**同 group 起点**（id 相同）。

---

## 4. group 会经过哪些压缩

### 4.1 L2 —— group 是 L2 的 budget 计量单元

§2.3 的 200000 budget 检查**逐 group 算**：group 内 fresh tool_result 合计超限才淘汰。group 在这里是"计量单元"，不跨 group 累加。

### 4.2 L4 —— group 最核心的压缩：按 group 摘要 / 保留

四条路径都落到 group 上。**字段证据**（strings 141527–141693）：

| 字段 | 行号 |
|---|---|
| `messagesSummarized` | 141527 |
| `too_few_groups` | 141669 / 141783 |
| `exhausted` | 141675 |
| `groupsToSummarize` | 141686 |
| `messagesToPreserve` | 141692 |
| `groupsPreserved` | 141693 |
| `isCompactSummary` | 121146 |

四路径：
- **全量自动 `ZZn→CHu`**：全部老消息送 LLM 摘要，全量替换成 `[boundary, summary]`，无近期保留。
- **reactive `neo→aDg`**（2.1.209 改善体验的核心）：按 xXt 切 group，**摘要靠前的、保留靠后的近期 group 原文**。保留数 `s` 从 1 起二分：
  - 前 `p=o-s` 个 group → 送 `aDg` 摘要（`groupsToSummarize`）
  - 后 `s` 个 group → `messagesToPreserve` 原样保留，**不进摘要请求**
  - `prompt_too_long` → 加大 s（减摘要量）重试，step 由 token gap 动态算
  - group 太少 → `too_few_groups` 放弃；二分到头 → `exhausted`
- **partial `EHu`**：手动选段摘要，保留其余。
- **precomputed**（`tengu_sepia_moth` 实验）：后台预计算，触发时校验（同 session/model、7 天内、增长<150k）后零等待 swap。

**摘要请求结构**（reactive `aDg`，字面量证实）：`[system] + forkContextMessages(老group, 媒体已 EXi strip) + compactPrompt(末尾 user)`。近期 s 个 group **不在请求里**。
- ✅ system prompt：`You are a helpful AI assistant tasked with summarizing conversations.`（strings 141557/141558）
- ✅ 包装前缀：`This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.`（141352）
- ✅ 工具全 deny：`Tool use is not allowed during compaction`（AXi），maxTurns=1

**压缩后最终 history**：
```
[compact_boundary, 摘要user(isCompactSummary:true, isVisibleInTranscriptOnly:true),
 ...messagesToPreserve(近期 s 个 group 原文)]
```
→ 下次正常 LLM 调用：远期靠摘要、近期靠 group 原文，衔接工作上下文。

### 4.3 microcompact —— 也在 group 作用域内裁 tool_result

microcompact 按 keepRecent 计数裁的是各 group 里偏老的 tool_result 内容，与 group 切分无直接绑定，但实际裁掉的都落在历史 group 里。

---

## 5. 串联：一条 tool_result 的完整压缩生命

```
tool_result 产生
  │
  ├─ 单条 > 50000 字符?          → L1: 存盘 + 2KB 预览 (xVt=2000, 标签 <persisted-output>)
  ├─ 所属 group 合计 > 200000?   → L2: dGh 三态分类, 贪心淘汰最大 fresh (frozen/seenIds 不动)
  │   (L1/L2 都只压 tool_result, 可 Read 回读)
  │
  ├─ context_hint 触发?          → microcompact: 最近 keepRecent 个保留, 其余 → [Old tool result content cleared]
  │
  └─ 累计 token ≥ ~167k?         → L4: 按 group(xXt) 送摘要 LLM
        ├─ reactive: 保近期 s 个 group 原文、摘要老的 (s 从 1 二分, messagesToPreserve)
        └─ 全量: 全部摘要替换
      (L4 原文留 transcript, 可回读; 摘要前 EXi 把媒体块 strip 成 [image]/[document])
```

---

## 6. 可复现命令

```bash
BIN=/Users/wolf/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
strings -n 6 "$BIN" > /tmp/cc_strings.txt   # 372494 行 / 32M

# microcompact
grep -nE "Old tool result content cleared|microcompact_boundary|KEEP-RECENT MC|context_hint" /tmp/cc_strings.txt

# L1 预览模板 + 预览长度
grep -nE "Output too large|Full output saved to|Preview \(first|persisted-output" /tmp/cc_strings.txt
perl -ne 'while(/(.{0,28}xVt[^,;)]{0,50})/g){print "$1\n"}' /tmp/cc_strings.txt | head
grep -nE "50000 characters by default" /tmp/cc_strings.txt

# L2 三态分类 dGh
perl -ne 'while(/(.{0,30}frozen[A-Za-z]*.{0,60})/g){print "$1\n"}' /tmp/cc_strings.txt | grep -iE "tool|result|seen|id"
grep -nE "mustReapply" /tmp/cc_strings.txt

# group 切分 xXt（完整函数体）
perl -ne 'while(/(.{0,60}\.message\.id.{0,140})/g){print "$1\n"}' /tmp/cc_strings.txt | head

# L4 group 字段 + 摘要 system
grep -nE "too_few_groups|messagesSummarized|groupsToSummarize|messagesToPreserve|groupsPreserved|isCompactSummary" /tmp/cc_strings.txt
grep -nE "summarizing conversations|This session is being continued" /tmp/cc_strings.txt

# 工具全 deny
grep -nE "Tool use is not allowed during compaction" /tmp/cc_strings.txt
```

> 行号针对 2.1.209 build（`GIT_SHA 0fe0485`），后续 CC 升级行号会变、但**字面字符串稳定**，用字符串内容 grep 最可靠。

---

## 7. 与既有文档的关系

- `docs/claude-code-l4-compact-2.1.209.md`：L4 四路径 + 摘要 prompt + 五层总览（结论性）。本文补的是其中 L1/L2/microcompact/xXt 的**源码级函数体证据**。
- `docs/cc-compact-request-anatomy.md`：L4 摘要请求的完整参数与消息结构。本文 §4.2 引用其结论，不重复。
- 本文新增硬证据：**`xXt` 切分完整函数体**、**`dGh` 三态分类函数体**（`seenIds`→frozen/fresh、replacements→mustReapply）、**`xVt=2000` 预览长度绑定**、**50000 阈值 help 证实**。
