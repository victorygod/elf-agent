# L4 压缩改造方案：保留近期 group（全 agent 通用）

> 目标：把 elf-002 的 L4 压缩从"全量替换"改成"保留最近一部分 group 原文 + 摘要更早的老历史"，对齐 Claude Code reactive compact 思路。本期只改 elf-002 子类，shared 基类不动。
> 状态：**待审阅**（2026-07-16 修订）。
> 依据：`docs/cc-compact-request-anatomy.md`（CC 2.1.209 reactive 源码逆向）。

---

## 1. 决策（已和用户确认）

| 项 | 决策 |
|---|---|
| 适用范围 | **仅 elf-002**（本期）。L4 留在 `agents/elf-002/message_manager.js` 子类 override，shared 基类不动；其他 agent 需要时再各自 override |
| 全量替换 | **下线**。不再保留全量替换路径，也不作失败回退 |
| 保留量 | **默认保留最近 1 个 group（s=1）**。摘要请求超长才重试，每次多匀 `memoryTokenLimit × 10%` token 预算的 group 进保留区，最多 3 次（对齐 CC `THu=3`，见 §4.2）|
| 失败处理 | 走断路器（连续 3 次失败禁用），**不回退全量** |
| 摘要范围 | 只送老历史、不送近期 group |
| `isCompactSummary`（老摘要） | **参与二次摘要**（对齐 CC 实情）。CC 的 `Ub.slice(r)` 含 boundary、老摘要紧跟 boundary 之后 → 老摘要进二次摘要请求，CC 不排除。elf-002 同样不排除（见 §4.3）|
| 续写指令 | **加**。摘要文本末尾追加 CC 全量自动路径的 continuationClause（"Continue the conversation...Resume directly..."）。⚠️ 注：CC reactive 路径 `suppressFollowUpQuestions:true` 实际不加；elf-002 选择加（混合行为，见 §4.4）|
| 压缩提示词 | 确认 elf-002 的 `compact_prompt.md` 对齐 CC 全量自动版（`$Hg` 9 段 + `hHu` REMINDER）。后面好改 |
| tool-results 清理 | **按 `tool_call_id` 绑定**：保留后消息里引用的 tool 文件留、其余删（见 §6） |
| group 切分 | **不需 message.id**：按 messages 里"每条 assistant 消息"切（见 §5） |

---

## 2. 为什么改

### 2.1 现状（全量替换）

`compactIfNeeded` 把所有消息摘要成一条，压缩后对话历史清零，模型从零重建、不知"刚才在干嘛"。

### 2.2 改完后

```
压缩前: [G0, G1, ..., G8, G9]   (10 个 group,超阈值)

              ↓ 默认只摘要老历史、保留最近 1 个 group

压缩后: [摘要(G0..G8), G9]   (最近 1 个 group 原文留着;若摘要超长则重试多留几个,§4.3)
```

远期靠摘要、近期靠原文，无缝衔接。

### 2.3 CC 的做法（对照，见 `cc-compact-request-anatomy.md`）

- 按 `xXt` 切 group；保留最近 s 个 group、摘要其余
- s 从 1 起二分试探；`prompt_too_long` 时按 token gap 加大 s
- **关键：CC 的 token gap 是事后的**——`dXt(errorDetails)` 从 LLM 返回的 `prompt_too_long` 错误取 `actualTokens − limitTokens`。先撞墙、再据此决定保留几个 group。**没有预设的保留预算常量**。

```js
// CC 源码证据(strings @23107204 / dXt 定义)
function dXt(e){
  if(!R5e(e) || !e.errorDetails) return;        // 必是 prompt_too_long
  let {actualTokens:t, limitTokens:r} = I6r(e.errorDetails);
  if(t===void 0||r===void 0) return;
  let n = t - r;                                 // gap = 实际超出量
  return n>0 ? n : void 0;
}
// initialTokenGap = dXt(上一次失败的 assistant 消息)  ← 事后值
// s = 1 + xHu(groupTokens, totalGroups-1, initialTokenGap)  ← 用 gap 填步长
```

→ elf-002 用 Qwen/OpenAI 兼容 API，**拿不到 `prompt_too_long` 的 actual/limit tokens**，所以抄不了 CC 的事后 gap 反推精确 step。改为默认 s=1（留最近 1 个 group）、超长重试时每次固定多匀 10% token 预算的 group 进保留区、最多 3 次（见 §4）。

---

## 3. 与 CC 的差异（为何这么选）

| 项 | CC 2.1.209 | 本方案 | 理由 |
|---|---|---|---|
| 保留量 | s=1 起步 + 事后 gap_guided 试探（用 prompt_too_long 的 actual−limit token gap 反推 step） | **默认 s=1；摘要超长才重试，每次多匀 `memoryTokenLimit×10%` token 预算的 group 进保留区**，最多 3 次 | elf-002 API 拿不到 prompt_too_long 的 token 详情，无法 gap_guided 反推精确 step；改用固定 10% 预算作重试步长——每次重试保留区多塞一组约 10% 预算的 group，直到摘要能装下或 3 次用尽 |
| 全量替换 | 有（`ZZn` 全量自动路径） | **下线** | 用户明确：保留近期是核心，不退化 |
| 失败回退 | 无 | 走断路器，不回退 | 全量替换已下线，无处可退 |
| boundary 标记 | `compact_boundary` | **不加 boundary** | elf-002 不靠 boundary 裁剪；老摘要参与二次摘要（§4.3），无需 boundary 切 |
| 老摘要处理 | 进二次摘要（`Ub.slice(r)` 含 boundary+老摘要） | **对齐 CC：老摘要参与二摘要**（§4.3） | 源码事实，不再排除 |
| 续写指令 | 全量自动加、reactive 不加 | **加**（混合行为，§4.4） | 用户定 |
| media strip | `EXi` | 不抄 | elf-002 无多模态 |
| 提示词 | 多版本（`$Hg`/`BHg`/续写指令） | 本期统一 CC 全量自动版（`$Hg` + `hHu`） | 后续好改 |

---

## 4. 保留区算法

### 4.1 CC 的保留量逻辑（源码事实，对照用）

CC `neo` 的保留量 `s`（保留几个 group）是**最小化**语义：

```js
// neo(strings 行 399396)
async function neo(e,t,r){
  let n=Z6r(e), o=n.length;
  if(o<2) return {too_few_groups};
  let s=1;                              // ★ 起步:只保留最近 1 个 group(最大化摘要)
  // (initialTokenGap 种子:if 有 gap && o>3 → s=1+xHu(...),但仍从1起)
  while(s<o){
    let p=o-s, f=n.slice(0,p), m=n.slice(p);   // f=摘要区(老), m=保留区(近期 s 个)
    let y=await aDg(f.flat(), ...);             // 送摘要
    if(y.ok) return {summaryMessages, messagesToPreserve:m.flat()};
    if(y.reason==="prompt_too_long"){
      s += lDg(y.tokenGap,...).step;            // ★ 失败才加大保留、减少摘要
    }
  }
}
```

- s=1 起步、`prompt_too_long` 才加大（`lDg`/`xHu` 按 token gap 算步长）
- **CC 没有预设保留预算**——保留量纯靠事后 gap 试探
- CC 能试探是因为 `dXt` 从 LLM 的 `prompt_too_long` 错误取 `actualTokens−limitTokens`
- **关键语义**：保留 group 是 reactive 的**常驻行为**——成功（不超长）时也保留 s=1 个最近 group；`prompt_too_long` 只是临时把 s 从 1 调大。超长与否都保留，区别仅在保留几个

### 4.2 elf-002 方案（默认 s=1 + 超长重试每次扩 10% 预算）

elf-002 用 Qwen/OpenAI 兼容 API，**拿不到 `prompt_too_long` 的 actual/limit tokens**（CC 的 `dXt` 依赖 API 错误详情），抄不了 CC 的事后 gap 反推精确 step。改为：**默认就保留最近 1 个 group（s=1，和 CC 起步一致），摘要请求超长才重试，每次多匀 `memoryTokenLimit × 10%` token 预算的 group 进保留区**，最多 3 次（对齐 CC `THu=3`）。

| 项 | 值 |
|---|---|
| 默认保留 | **最近 1 个 group**（s=1，首轮不预算、直接留末尾 1 个） |
| 重试步长 | 每次重试，保留区**多匀 `memoryTokenLimit × 10%` token 预算的 group**（从保留区边界往老的方向贪心累加）|
| 重试上限 | **3 次**（对齐 CC `THu=3`；与断路器同数字，但语义不同：这里是单次压缩内的 prompt_too_long 重试，断路器是跨次压缩的连续失败累计）|
| 触发重试 | 摘要请求 LLM 返回超长类错误（prompt_too_long / context length exceeded 类）|
| 超过 3 次仍失败 | 计 1 次断路器失败，放弃本次压缩 |

例：`memoryTokenLimit=400000` → 每次重试扩 40000 token 预算的 group。
```
第 1 次: 保留最近 1 group,摘要其余 → 若超长
第 2 次: 保留区 +1 组(约 40000 token 预算),摘要其余 → 若仍超长
第 3 次: 保留区再 +1 组(再扩 40000 预算),摘要其余 → 若仍超长
第 4 次: 超过 3 次上限 → 计断路器失败,放弃
```

> **与 CC 的差异**：CC 用真实 token gap 反推精确 step（可能 step=3 一次到位）；elf 用固定 10% 预算作步长（每次扩一档、最多 3 档）。两者都是"超长才扩保留区"，elf 步长粗但实现简单、不依赖 API 错误详情。CC 能拿 gap 是因为直连 Anthropic；elf 网关拿不到。

### 4.3 算法

```
1. 按 §5 切 group(共 o 个)
2. 若 o < 2 → 跳过 + 计断路器(too_few_groups)
3. s = 1（保留最近 1 个 group，对齐 CC 起步）
4. 循环最多 3 次(prompt_too_long 重试上限 THu=3):
   a. 摘要区 = 前 o-s 个 group; 保留区 = 后 s 个 group
   b. 摘要区为空(全保留) → 跳过 + 计断路器(没东西可摘)
   c. 送 LLM 摘要(只送摘要区老历史、不送保留区近期，老摘要 isCompactSummary 作普通消息在摘要区参与，§4.4)
   d. 成功 → 包装 + 拼回 [摘要, ...保留区原文]，return
   e. 失败且是超长类错误(p prompt_too_long / context exceeded):
      - 从保留区边界往老的方向贪心累加 group 到 10 % 预算 → s 增大
      - 若 s 已达 o-1(摘要区耗尽,无可再匀)或本次是第 3 次重试 → 计断路器失败,放弃
      - 否则重试(回到 a)
   f. 失败且非超长(模型挂了/解析空等): 计断路器,放弃(不重试)
```

> **与 CC 的对齐**：默认 s=1 起步、超长才扩保留区、3 次上限——三点都和 CC `neo` 一致。差异仅步长算法：CC gap_guided 反推、elf 固定 10% 预算。保留 group 的常驻语义（成功也保留）和 CC 完全一致。

### 4.4 老摘要（isCompactSummary）参与二次摘要（对齐 CC 实情）

**源码事实**：CC reactive 二次摘要时，老摘要**进摘要请求**，CC **不排除**。

证据链（`strings`）：
```js
function FC(e){ return e?.type==="system" && e.subtype==="compact_boundary" }   // 判 boundary
function vHo(e){ for(let t=e.length-1;t>=0;t--){ if(FC(e[t])) return t } return -1 }
function Ub(e,t){ let r=vHo(e); return r===-1 ? e : e.slice(r) }   // ★ slice(r) 含 boundary 本身
function Z6r(e){ let t=Ub(e).filter(r=>r.type!=="progress"); return xXt(t) }
```
- 一次压缩后 history = `[boundary, 摘要, 近期 group]`（`HH([U,...K,...m])`，boundary 在前、摘要在后）
- `Ub.slice(r)` 含 boundary 本身 → 裁剪后 = `[boundary, 老摘要, ...后续]`
- `Z6r` 切的 group 含老摘要 → `neo` 送 `aDg` 摘要的 group 含老摘要
- **reactive 路径全程没有 `isCompactSummary` 排除判断**

**elf-002 对齐**：**不排除**老摘要。老摘要（isCompactSummary 消息）作为普通消息参与 §4.3 算法——它在保留区还是摘要区，由 10% 预算贪心决定（和普通 group 一样），不特殊对待。

> 作废之前"老摘要永远保留区"的说法——那是误读 CC（误以为 boundary 切掉老摘要）。事实是 slice(r) 含 boundary、老摘要进摘要。

### 4.5 续写指令（elf-002 选择加，混合行为）

**源码事实**：CC 三处 `z6r` 调用，`suppressFollowUpQuestions` 取值不同：
```js
// strings @18393664 — partial compact(EHu): suppressFollowUpQuestions:n (变量,取决于方向)
// strings @18399359 — 全量自动路径: suppressFollowUpQuestions:!1 (false → ★加续写指令)
// strings @18412942 — reactive 路径(aDg): suppressFollowUpQuestions:!0 (true → ★不加)
```
- **全量自动路径**：加续写指令（"Continue the conversation...Resume directly..."）
- **reactive 路径**：**不加**

**elf-002 选择**：**加**续写指令（用户定）。这是**混合行为**——保留近期（reactive 风格）+ 加续写指令（全量自动风格）。实现上在摘要文本末尾追加 continuationClause，不依赖路径。

### 4.3 老摘要（isCompactSummary）参与二次摘要（对齐 CC 实情）

**源码事实**：CC reactive 二次摘要时，老摘要**进摘要请求**，CC **不排除**。

证据链（`strings`）：
```js
function FC(e){ return e?.type==="system" && e.subtype==="compact_boundary" }   // 判 boundary
function vHo(e){ for(let t=e.length-1;t>=0;t--){ if(FC(e[t])) return t } return -1 }
function Ub(e,t){ let r=vHo(e); return r===-1 ? e : e.slice(r) }   // ★ slice(r) 含 boundary 本身
function Z6r(e){ let t=Ub(e).filter(r=>r.type!=="progress"); return xXt(t) }
```
- 一次压缩后 history = `[boundary, 摘要, 近期 group]`（`HH([U,...K,...m])`，boundary 在前、摘要在后）
- `Ub.slice(r)` 含 boundary 本身 → 裁剪后 = `[boundary, 老摘要, ...后续]`
- `Z6r` 切的 group 含老摘要 → `neo` 送 `aDg` 摘要的 group 含老摘要
- **reactive 路径全程没有 `isCompactSummary` 排除判断**

**elf-002 对齐**：**不排除**老摘要。老摘要（isCompactSummary 消息）作为普通消息参与——它在保留区还是摘要区，由 §4.2 的保留量算法决定（和普通 group 一样），不特殊对待。

> 作废之前"老摘要永远保留区"的说法——那是误读 CC（误以为 boundary 切掉老摘要）。事实是 slice(r) 含 boundary、老摘要进摘要。

### 4.4 续写指令（elf-002 选择加，混合行为）

**源码事实**：CC 三处 `z6r` 调用，`suppressFollowUpQuestions` 取值不同：
```js
// strings @18393664 — partial compact(EHu): suppressFollowUpQuestions:n (变量,取决于方向)
// strings @18399359 — 全量自动路径: suppressFollowUpQuestions:!1 (false → ★加续写指令)
// strings @18412942 — reactive 路径(aDg): suppressFollowUpQuestions:!0 (true → ★不加)
```
- **全量自动路径**：加续写指令（"Continue the conversation...Resume directly..."）
- **reactive 路径**：**不加**

**elf-002 选择**：**加**续写指令（用户定）。这是**混合行为**——保留近期（reactive 风格）+ 加续写指令（全量自动风格）。实现上在摘要文本末尾追加 continuationClause，不依赖路径。

---

## 5. group 切分（不需 message.id）

### 5.1 CC 用 message.id（API 返回）

CC 消息对象的 `message.id` 是 **Anthropic API 返回的字段**（`msg_xxx`），同回合流式块共享、不同回合不同。`xXt` 用"id 变了 → 新 group"切分。

**证据**（`strings` @24733367）：`V.message.id === U.message.id` 判同回合累积块。

### 5.2 elf-002 不用 id——消息结构天然是回合

elf-002 用 OpenAI 兼容 API，流式无整条 message 的 id。但 **elf-002 的消息历史是自己存的**——`addAssistantMessage` / `addAssistantToolCalls` 每次 push 一条 assistant 消息，已经是"累积好的单条"。

**所以 elf-002 的 group = 一条 assistant 消息 + 紧随其后到下一条 assistant 之前的所有消息**。直接按 `this.messages` 里"遇到 role===assistant 就切"即可，不判 id。

```js
// 应回放到 shared 基类的切分
_groupByAssistantTurn() {
  const groups = [];
  let current = [];
  for (const msg of this.messages) {
    const isNewTurn = msg.role === 'assistant' && current.length > 0;
    if (isNewTurn) { groups.push(current); current = [msg]; }
    else current.push(msg);
  }
  if (current.length) groups.push(current);
  return groups;
}
```

> 比 CC 的 `xXt` 更简单（CC 要判同 id 多块；elf-002 一条就是一回合）。

### 5.3 group 含 user 消息（重要）

**user 消息不触发切分**，所以它归在前一个 assistant 的 group 末尾；若开头还没有 assistant，则自成首 group。

```
[G0] user: 帮我重构 auth               ← 首个 user(尚无 assistant)自成 group
[G1] assistant(tool_calls:[Read])
     tool: 文件内容
     user: 改一下 line45               ← ★ 归在 G1(G1 的 assistant 之后、G2 之前)
[G2] assistant(tool_calls:[Edit])
     tool: 修改成功
     user: 再看看登录                  ← ★ 归在 G2
[G3] assistant(tool_calls:[Read])
     ...
```

**对保留区的影响**：保留的是**完整 group**（user/assistant/tool 一起留）。

**边界**：L4 在每轮 LLM 调用前触发，此时 `messages` 末尾是**刚加的 user（还没配 assistant）**。按切分规则它归在前一个 assistant 的 group 里（或自成末 group）。保留区从末尾往回贪心——**这条未配 assistant 的 user 一定在保留区**，不会被摘掉。 ✅ 不会把用户最新输入摘要掉。

> 若末 group 只有这条未配 user（前面无 assistant），保留区第一个就是它——此时保留区"没近期工作可留"是合理的（用户刚发新消息、还没干活）。

---

## 6. tool-results 清理（按 tool_call_id 绑定）

### 6.1 现状问题

现 `_cleanupToolResults()` 清空整个 tool-results 目录。保留近期 group 后，近期 group 里若有 `<persisted-output>` 引用文件——全清会**引用悬空**。

### 6.2 方案（用户定的，比扫 filepath 干净）

摘要成功后，扫**保留后**的 `this.messages`（含近期 group）里所有 tool 消息的 `tool_call_id`，这些 id 对应的 tool-results 文件**保留**，其余删。

```
保留后消息里的 tool_call_id: [t1, t3, t7]
tool-results/ 目录文件: [t1.txt, t2.txt, t3.txt, t4.txt, t7.txt]
→ 删 t2.txt, t4.txt（未绑定），留 t1/t3/t7
```

**天然防悬空**：凡消息里还引用的 tool，文件都留着。L1/L2 持久化用的是 `toolCallId`（elf-002 现状），绑定键已对齐。

### 6.3 CC 对照

CC 清理 old tool result 用 `[Old tool result content cleared]`（字符串证据已在二进制确认）——改 content 而非删文件。本方案不抄这套，按 elf-002 的 tool-results 文件删除机制。

---

## 7. 实现提纲

### 7.1 改动文件

| 文件 | 改动 |
|---|---|
| `shared/agent/message_manager.js` | **不动** |
| `agents/elf-002/message_manager.js` | 改 `compactIfNeeded`（保留近期 group + 摘要其余 + 老摘要参与 + 续写指令）；新增 `_groupByAssistantTurn`/`_groupTokens`/`_referencedToolCallIds`；改 `_cleanupToolResults(keepIds)` 为按 tool_call_id 绑定删；L1/L2/microcompact override 不动 |
| `agents/elf-002/config/compact_prompt.md` | 确认对齐 CC 全量自动版（已基本对齐，可能微调） |
| `agents/elf-002/config/config.json` | 无新增（10% 是 `memoryTokenLimit` 派生、硬编码比例） |

### 7.2 改造后 `compactIfNeeded`（elf-002 子类 override，伪代码）

```js
// 续写指令常量（对齐 CC continuationClause，全量自动路径用；elf-002 选择加，见 §4.5）
const CONTINUATION_CLAUSE =
  'Continue the conversation from where it left off without asking the user any further questions. ' +
  'Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface ' +
  'with "I\'ll continue" or similar. Pick up the last task as if the break never happened.\n\n';

async *compactIfNeeded(llmModel, options = {}) {
  if (this._compactDisabled) return;
  if (this.estimateTokens() <= this.memoryTokenLimit) return;
  yield { event: 'compact_start', data: {} };

  const groups = this._groupByAssistantTurn();   // §5 切 group（含 user/isCompactSummary，不特殊处理）
  const o = groups.length;
  if (o < 2) { this._recordCompactFailure(); return; }   // too_few_groups

  const MAX_RETRY = 3;                            // 对齐 CC THu=3（prompt_too_long 重试上限）
  const reserveBudgetPerStep = Math.floor(this.memoryTokenLimit * 0.1);  // 每次重试扩 10% 预算的 group

  let s = 1;                                      // ★ 默认保留最近 1 个 group（对齐 CC 起步）
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const summaryCount = o - s;
    if (summaryCount < 1) { this._recordCompactFailure(); return; }  // 摘要区空 → 跳过+断路器

    const summaryGroups = groups.slice(0, summaryCount);   // 老(送摘要,含老摘要 isCompactSummary,不排除)
    const preserveGroups = groups.slice(summaryCount);     // 近期(保留)

    // 摘要请求:只送老 history、不送近期
    const summaryRequest = [
      { role: 'system', content: this.compactSystemPrompt },
      ...summaryGroups.flat().map(m => ({ ...m })),
      { role: 'user', content: this.compactPrompt }
    ];

    let response;
    try {
      response = await llmModel.chat(summaryRequest, { enable_thinking: false, ...options });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (this._isPromptTooLongErr(err) && attempt < MAX_RETRY && s < o - 1) {
        // 超长类错误:多匀 10% 预算的 group 进保留区、重试
        s = this._growPreserve(groups, s, reserveBudgetPerStep);
        continue;
      }
      this._recordCompactFailure(); return;      // 非超长 / 已达上限 → 断路器,放弃
    }

    const summary = this._parseSummaryResponse(response);
    if (summary) {
      // 包装:preamble + 续写指令 + Summary:\n + 内容（elf-002 选择加续写指令，§4.4）
      const wrapped = SUMMARY_PREAMBLE + CONTINUATION_CLAUSE + 'Summary:\n' + summary;
      this.messages = [
        { role: 'user', content: wrapped, isCompactSummary: true },
        ...preserveGroups.flat()
      ];
      this._compactHappened = true;
      this._save();
      this._cleanupToolResults(this._referencedToolCallIds());  // 按 tool_call_id 绑定删
      this._compactFailCount = 0;
      yield { event: 'compact', data: { tokenEstimate: this.estimateTokens() } };
      return;
    }
    // summary 解析空 → 非超长失败,断路器,不重试
    this._recordCompactFailure(); return;
  }
  // 3 次重试仍超长 → 计断路器失败
  this._recordCompactFailure();
}

/** 判错误是否为摘要请求超长类（prompt_too_long / context length exceeded） */
_isPromptTooLongErr(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return /prompt.*too.*long|context.*length|maximum.*context|too many tokens|exceeds.*context/.test(msg);
}

/** 从保留区边界往老的方向贪心累加 group 到 budget 预算 → s 增大（至少 +1） */
_growPreserve(groups, s, budget) {
  let acc = 0, grew = 0;
  for (let i = groups.length - 1 - s; i >= 0; i--) {
    const g = this._groupTokens(groups[i]);
    if (acc + g > budget && grew > 0) break;     // 达预算且至少扩了 1 个 → 停
    acc += g; grew++;
    if (acc >= budget) break;
  }
  return s + Math.max(1, grew);
}
```

> **与 CC 的对齐说明**：
> - 保留量：默认 s=1 + 超长重试扩 10% 预算（对齐 CC s=1 起步 + prompt_too_long 扩保留；步长用 10% 预算代替 CC 的 gap_guided，§4.2/§4.3）
> - 重试上限：3 次（对齐 CC `THu=3`）；超长重试与断路器语义不同——重试是单次压缩内、断路器是跨次累计
> - 老摘要（isCompactSummary）：**不排除**，作为普通消息参与（对齐 CC `Ub.slice(r)` 含老摘要）
> - 续写指令：**加**（elf-002 混合行为；CC reactive 实际不加，§4.5）
> - boundary：**不加**（CC 用 boundary 裁剪；elf-002 无 boundary，靠保留量算法 + 不排除老摘要）

---

## 8. 改动范围（已定：L4 留 elf-002 子类、不下沉）

**L4 不下沉 shared 基类**。改动集中在 `agents/elf-002/message_manager.js` 子类：

- `shared/agent/message_manager.js` 基类：**不动**
- elf-002 子类 `agents/elf-002/message_manager.js`：改 `compactIfNeeded`（加 group 切分 + 10% 保留 + 老摘要参与 + 续写指令）、新增 `_groupByAssistantTurn`/`_groupTokens`/`_referencedToolCallIds`、改 `_cleanupToolResults(keepIds)` 为按 tool_call_id 绑定删；L1/L2/microcompact override 不动
- `agents/elf-002/config/compact_prompt.md`：统一 CC 全量自动版（已基本对齐，可能微调）
- `agents/elf-002/config/config.json`：无新增参数（10% 是 `memoryTokenLimit` 派生、硬编码比例）

> 其他 agent 想要保留近期 group 的 L4，各自 override（本期不做）。

---

## 9. 风险

1. **摘要区超长已有重试兜底**——默认 s=1 时摘要区最大（老 history 全送）。若摘要请求超长，按 §4.3 重试扩保留区（每次 10% 预算、最多 3 次）。3 次仍超长 → 计断路器失败。极端超长对话可能连断路器禁用，但已比"无重试直接失败"稳健。
2. **改动局限 elf-002 子类**——L4 不下沉基类，只改 `agents/elf-002/message_manager.js` 的 `compactIfNeeded` + 辅助方法；L1/L2/microcompact 不动。
3. **老摘要参与二次摘要**——对齐 CC，但"摘要的摘要"有信息衰减（CC 自己也接受）。多次压缩后远期记忆会被层层压缩。
4. **Qwen 摘要质量**——保留近期后摘要范围变小，实测验证。
5. **触发后仍超阈值**——单次压不到位可能连续触发，断路器兜底。

---

## 10. 测试要点

- 保留区原样保留（近期 group 一字不改）
- 摘要请求不含近期 group、含老摘要（isCompactSummary 不排除）
- 至少保留 1 group、至少摘要 1 group
- 失败走断路器、不回退全量、不试探加大（若选 §4.2 选项 a/b）
- tool-results 清理只删未绑定的（构造近期含 `<persisted-output>` 场景验证不悬空）
- 二次压缩：老摘要进摘要区被再摘要（对齐 CC，不保留排除）
- elf-002 提示词生效
- 热更新提示词生效

---

## 11. 已定汇总

| 点 | 决策 |
|---|---|
| 保留量 | **默认保留最近 1 个 group（s=1）**；摘要超长才重试，每次多匀 `memoryTokenLimit × 10%` token 预算的 group 进保留区，最多 3 次（对齐 CC `THu=3`，§4.2/§4.3） |
| 下沉范围 | **L4 留 elf-002 子类、不下沉**（shared 基类不动；L1/L2/microcompact 也不动） |
| 续写指令 | **加**（CONTINUATION_CLAUSE 追加到摘要文本末尾。混合行为——CC reactive 实际不加，elf-002 选择加） |
| 全量替换 | 下线，不回退 |
| 失败处理 | 断路器 3 次（跨次连续失败禁用） + 单次内超长重试 3 次（§4.3） |
| 摘要范围 | 只送老 history、不送近期 |
| 老摘要(isCompactSummary) | **参与二次摘要**（对齐 CC，不排除） |
| boundary | 不加 |
| tool-results 清理 | 按 tool_call_id 绑定删 |
| 提示词 | 统一 CC 全量自动版（$Hg 9 段 + hHu） |
| group 切分 | 按 messages 每条 assistant 切（不需 id） |

### 与 CC 的已知差异（明确接受、非对齐 CC）

| 点 | elf-002 | CC | 原因 |
|---|---|---|---|
| 重试步长 | 每次扩 10% 预算的 group | gap_guided 反推精确 step | elf-002 拿不到 prompt_too_long 的 token 详情，改固定步长 |
| 续写指令 | 加 | reactive 不加 | 用户选择加（混合行为） |
| boundary | 不加 | 有 | elf-002 不靠 boundary 裁剪 |

其余（老摘要参与二次摘要、触发时机、摘要请求结构、断路器、≥1 保留、tool-results 清理）对齐 CC。

**方案已完整，可开始实现 §7。**