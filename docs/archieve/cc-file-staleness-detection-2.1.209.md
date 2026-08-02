# CC 文件变更检测与陈旧读取防护（v2.1.209）

> 从 `claude.exe` 二进制反推。记录 CC 如何检测"读过的文件被外部修改"，以及 elf-002 的对齐方案。

---

## 0. 总览

| 层级 | 时机 | 行为 |
|:--|:--|:--|
| **L1** | 每轮推理前 | `ilp` 扫描 `readFileState`，mtime+哈希两级过滤，生成 diff 通知；**只产一次** |
| **L2** | Write/Edit 调用 | 校验 mtime+哈希，过期则拒绝；Edit 额外支持自动恢复 |
| **L3** | 模型重读已读文件 | Read 的 tool_result 内联 `<system-reminder>` 警告 |

---

## 1. readFileState：LRU Map

### 存储字段

| 字段 | 说明 |
|:--|:--|
| `content` | 文件内容。大文件(>4096字节)置空，仅留 hash |
| `contentHash` | `Bun.hash(content).toString(36)` |
| `timestamp` | `Math.floor(fs.statSync(path).mtimeMs)` |
| `offset`, `limit` | 部分读取时传，全文读取时为 `undefined` |
| `isPartialView` | `!!(offset \|\| limit)` |

### 写入时机

- **Read 工具**: 每次成功读取后写入
- **Write/Edit 工具**: 每次成功写入后写入（content=新内容，timestamp=写入时间）
- **ilp: `nS.call`**（L1 检测时调 Read）: 也会刷新 timestamp（这是不重复通知的关键）

### 关键函数

| 函数 | offset | 作用 |
|:--|:--|:--|
| `wsu` 类 | 217599478 | LRU Map，set 时按 `qdg=4096` 决定保留/清空 content |
| `IK(path)` | 213041879 | `Math.floor(fs.statSync(path).mtimeMs)` |
| `tYe(path)` | 213041879 | 异步版 `await fs.stat(path).mtimeMs` |
| `IOe(state, text)` | 217599478 | 哈希比较（有 hash 用 hash，否则字符串 ===） |
| `PCu(old, new)` | 219128069 | unified diff，context=8，超长截断 |
| `art(state)` | 217600615 | `Array.from(state.keys())` |
| `nRe(path, ctx)` | 225641914 | 排除无权限/UNC 路径 |

---

## 2. L1：每轮 changed_files 通知

### 2.1 入口

**offset 225611068**（`Qap` 内的 attachment producer 数组）:
```js
ab("changed_files", () => ilp(u))
```

### 2.2 ilp 实现

**offset 225624912**:
```js
async function ilp(e) {
  let t = art(e.readFileState);
  if (t.length === 0) return [];

  let o = (await Promise.all(t.map(async (s) => {
    let a = e.readFileState.get(s);
    if (!a || a.offset !== void 0 || a.limit !== void 0) return null;  // 跳过部分读取
    let l = Mi(s);
    if (nRe(l, An(e))) return null;                                     // 跳过无权限

    try {
      if (await tYe(l) <= a.timestamp) return null;                     // mtime 未变 → 跳过
      let u = { file_path: l };
      let p = await nS.call(u, e);                       // ★ 调用 Read 工具(刷新 readFileState)
      if (p.data.type === "text") {
        if (IOe(a, p.data.file.content)) return null;                    // 哈希相同 → 跳过
        let f = PCu(a.content, p.data.file.content);                    // 生成 diff
        if (f === "") return null;
        return { type: "edited_text_file", filename: l, snippet: f };
      }
      return null;
    } catch (c) {
      if (dr(c)) e.readFileState.delete(s);             // 文件不存在 → 清理
      return null;
    }
  }))).filter(s => s != null);

  // 总额限制 Cy_=16384
  let i = 0;
  for (let s of o) {
    if (s.type !== "edited_text_file") continue;
    if (i >= Cy_) s.snippet = "";
    else i += s.snippet.length;
  }
  return o;
}
```

### 2.3 为什么只产一次

`ilp` 内调用的 `nS.call`（Read 工具）会更新 `readFileState` 的 timestamp 到当前值。下一轮 `ilp` 再跑时 `tYe(file) <= recorded.timestamp` 直接跳过。

```
第 N 轮:  tYe=1050 > recorded=1000 ✓ → nS.call(Read) → recorded 更新为 1050 → 产消息
第 N+1:   tYe=1050 <= recorded=1050 → 跳过
```

### 2.4 Dispatch 产出消息

**offset 225980420**（`ddp` 对象）:
```js
edited_text_file: (e) => Of([Br({
  content: e.snippet === ""
    ? `Note: ${e.filename} was modified... The diff was omitted because other modified files in this turn already exceeded the snippet budget; use the Read tool if you need the current content.`
    : `Note: ${e.filename} was modified... Here are the relevant changes (shown with line numbers):\n${e.snippet}`,
  isMeta: !0
})])
```

消息载体：`Br({content: "Note: ...", isMeta: true})` → `type: "user", message: {role: "user", content}, isMeta: true`。

**无 `<system-reminder>` 标签**。对比：

| | skill_listing | edited_text_file |
|:--|:--|:--|
| dispatch | `x5([p1({..., isMeta:true})])` | `Of([Br({content:"Note:", isMeta:true})])` |
| `<system-reminder>` | ✅ `x5` 内 `qT` 自动包 | ❌ 无 |
| API content | `<system-reminder>\n...\n</system-reminder>` | `Note: <filename> was modified...` |
| 语义 | 低权重背景 | 必须关注 |

### 2.5 消息位置

每轮 messages 拼装: `[...Ae, ...Ie, ...Oe]`。`edited_text_file` 进入 `Oe`，位置在"上一轮 tool_result"和"本轮用户输入"之间：

```
[tool_result: cat -n 文件内容...]        ← 上一轮
[user/isMeta: "Note: file was modified..."]  ← L1 通知在这里
[user: "帮我改一下 file"]                ← 本轮用户输入
```

消息留在历史里直到被 compact 掉，但**不会每轮重复注入**。

### 2.6 常量

| 常量 | 值 | 含义 |
|:--|:--|:--|
| `Cy_` (offset 225642090) | `16384` | 每轮所有文件 diff snippet 总长上限（字节） |

---

## 3. L2：Write/Edit 陈旧挡板

### 3.1 Write

**offset 219153317**:

```
① hasRead? 否 → errorCode 2 ("must Read first")
② mtime > recorded?
   是 → 全文读取? → 是 → IOe(recorded, diskContent)?
                    → 相同 → 通过
                    → 不同 → errorCode 3 ("File has been modified since read")
         → 部分读取 → errorCode 3
   否 → 通过
```

**成功后**: `a.set(p, {content:newContent, timestamp:writeTime, ...})`

### 3.2 Edit（含恢复尝试）

**offset 219138837**:

```
① hasRead? 否 → errorCode 6
② mtime > recorded?
   否 → 通过
   是 → 全文读取且哈希相同? → 通过
      → 否则 → J7i(oldString, newString, replaceAll) 尝试将 edit apply 到磁盘最新内容
              → applies → 静默恢复，用磁盘最新内容继续
              → 不 applies → errorCode 7 ("File has been modified since read")
```

**关键**：Edit 的恢复尝试比 Write 多一层——如果 old_string 在磁盘最新内容中仍然匹配，就能无感执行，不报错。

---

## 4. L3：Read 重读时的 system-reminder 警告

**仅在文件未变时触发**，是 Read 工具的**短路返回**，不是文件内容追加：

### 4.1 判定逻辑（Read 工具 `call` 入口）

**offset 225594638**（`nS.call` 内）:
```js
let y = Qe("tengu_read_dedup_killswitch", !1) ? void 0 : a.get(f);  // a = readFileState

// 分支 A：seeded 来源（nested_memory 从 context 注入的文件）+ 全文 + mtime 未变
if (y && y.seededFromContext && !y.isPartialView && t===1 && r===void 0) {
  if (await tYe(f) === y.timestamp)
    return { data: { type:"file_unchanged", file:{filePath:f}, source:"seeded" } };
}

// 分支 B：普通已读 + 完全相同的 offset/limit + mtime 未变
if (y && !y.isPartialView && y.offset !== void 0) {
  if (y.offset === t && y.limit === r) {
    if (await tYe(f) === y.timestamp)
      return { data: { type:"file_unchanged", file:{filePath:e} } };
  }
}

// 否则走Nap(f)（真正读盘 + 更新 readFileState）
```

**关键**：
- file 读取完后 `Nap` 会 `p.set(r,{content,timestamp,...})` 刷新 readFileState
- `file_unchanged` 短路分支**直接 return**，不调 `Nap`，**不重读盘、不刷新 timestamp**
- 判定靠 mtime 相等（`tYe(f) === y.timestamp`），不做内容哈希对比

### 4.2 tool_result 内容（offset 225596492）

```js
case "file_unchanged":
  return { tool_use_id:t, type:"tool_result",
    content: e.source==="seeded" ? m0c(e.file.filePath) : f0c() };
```

两种文案：
- **seeded 来源**（context 注入的）：`m0c(path)` →
  ```
  <system-reminder>This file is already in your context (see "Contents of <filename>" above) and has not changed on disk. Use that content instead of re-reading.</system-reminder>
  ```
- **普通重读**：`f0c()` = `d0c` →
  ```
  Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.
  ```

注意 `d0c` 文案**无** `<system-reminder>` 包裹，且语气更强（"Wasted call"）。只有 seeded 场景才用 system-reminder。

### 4.3 elf 实现差异（重要）

elf 的 Read.js L3 实现**不区分场景**，未变时统一追加 `<system-reminder>This file is already in your context...</system-reminder>` 到正常返回内容末尾，且**仍走完整读盘 + markRead 刷新 timestamp**。

与 CC 的两处行为差异：
1. **elf 总是返回文件内容**（cat-n 输出 + 末尾 system-reminder）；**CC 短路时不返回内容**，只返回提醒文本。elf 多读了盘、多刷了 timestamp。
2. **elf 用 mtime + 内容哈希双重判定**；CC 只判 mtime 相等。

### 4.3b 对齐方案：Read.js L3 改为短路返回

**目标**：未变时直接 return 提醒文本，不读盘、不返回内容、不刷新 timestamp。对齐 CC `file_unchanged` 分支。

**改动点**（Read.js 当前 94-117 行）：

把 L3 检测从"末尾追加"前置为"入口短路"。在读取文件内容之前、`stat` 之后插入判定：

```js
// stat 之后、readFileSync 之前
const mtimeMs = Math.floor(stat.mtimeMs);
const priorState = getReadState(filePath);

// L3 短路：全文重读且 mtime 未变 → 不读盘，直接返回提醒
if (priorState && !priorState.isPartialView && !args.offset && !args.limit
    && mtimeMs === Math.floor(priorState.timestamp)) {
  // 普通（非 seeded）重读：无 system-reminder，强语气文案
  return `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`;
}
// 注意：elf 无 seeded（nested_memory 注入）概念，省略 CC 的 m0c/system-reminder 分支

// 否则走完整读盘 + markRead（现有逻辑）
```

**关键约束**：
- `mtimeMs === priorState.timestamp` 用严格相等（CC 语义），不再做哈希对比
- 短路时 `return`，**不调用 markRead**（保持 timestamp 不动，下次重读仍能短路）
- 部分读取（offset/limit）不短路，走完整路径
- 文案对齐 CC `d0c`：无 `<system-reminder>` 包裹，"Wasted call…"

**副作用与取舍**：
- ✅ 省掉每次重读的磁盘 IO 与大段 cat-n 内容的上下文 token
- ✅ timestamp 不前进，行为语义清晰（"文件没变就一直提醒"）
- ⚠️ 返回值从"文件内容"变成"提示文本"，模型需理解这是"别读了"而非读到了新内容——文案明确告知"Refer to that earlier tool_result"，风险可控
- ⚠️ elf 没有 seeded（nested_memory）路径，不实现 CC 的 system-reminder 分支，普通重读用 `d0c` 文案即可

### 4.4 三种场景载体对比

| 场景 | CC 内容 | 载体 | system-reminder | 频率 |
|:--|:--|:--|:--|:--|
| 文件**变了**（L1） | `Note: <file> was modified... <diff>` | 独立 `isMeta` user 消息 | ❌ 无 | 每次变更一次 |
| 普通重读未变（L3-B） | `Wasted call — file unchanged since your last Read...` | Read tool_result 内联 | ❌ 无 | 每次重读 |
| seeded 重读未变（L3-A） | `This file is already in your context...` | Read tool_result 内联 | ✅ 有 | 每次重读 |
| Compact 后（§5） | `Note: <file> was read before... Use Read to access it.` | 独立 `isMeta` user 消息 | ❌ 无 | compact 时 |

---

## 5. Compact 后：compact_file_reference

**offset 225980420**:
```js
compact_file_reference: (e) => Of([Br({
  content: `Note: ${e.filename} was read before the last conversation was summarized, but the contents are too large to include. Use ${nS.name} tool if you need to access it.`,
  isMeta: !0
})])
```

compact 压缩后大文件无法重新注入原文，改为一条引用提示。

---

## 5b. LSP 诊断（diagnostics / lsp_diagnostics）

CC 编辑文件后会自动收集语法/类型诊断并注入上下文。这是和 `changed_files` **平级的 attachment**，同批并行产出。elf **未实现**。

### 5b.1 两个诊断通道

| attachment type | producer | 来源 | offset |
|:--|:--|:--|:--|
| `diagnostics` | `Hy_(e)` | IDE / MCP 推送的诊断 | 225632809 |
| `lsp_diagnostics` | `Dy_(e)` | CC 内置 LSP server 的 `publishDiagnostics` | 225633015 |

```js
// Hy_：取"新"诊断（已投递的去重）
async function Hy_(e){
  if(!e.options.tools.some((r)=>pl(r,Yo)||pl(r,Hi))) return[];  // 门控：注册了 Edit/Write 才跑
  let t = await K6e.getNewDiagnostics();
  if(t.length===0) return[];
  return [{type:"diagnostics", files:t, isNew:!0}];
}

// Dy_：从 LSP 注册表取 pending，投递后清空
async function Dy_(e){
  if(!e.options.tools.some((t)=>pl(t,Yo)||pl(t,Hi))) return[];
  let t = ESu();            // 取 pending 诊断
  if(t.length===0) return[];
  let r = t.map(({files:n}) => ({type:"diagnostics", files:n, isNew:!0}));
  vSu();                    // 清空已投递
  return r;
}
```

### 5b.2 消息格式与载体

**dispatch**（offset 225945922）:
```js
case "diagnostics": {
  if(e.files.length===0) return[];
  return Of([Br({ content: hJ.formatDiagnosticsBlock(e.files), isMeta:!0 })]);
}
```

**格式**（`formatDiagnosticsBlock`，offset 218980106）:
```
<new-diagnostics>The following new diagnostic issues were detected:
<path>:
  ⨯ <message> (source)
  ⚠ <message> (source)
</new-diagnostics>
```

载体：`Br({content, isMeta:true})` → 独立 `role:user` + `isMeta` 消息，**`<new-diagnostics>` 标签**（非 `<system-reminder>`）。

### 5b.3 行为要点

| 点 | 行为 |
|:--|:--|
| 门控 | 仅注册 Edit/Write 工具（`Yo`/`Hi`）的 agent 才跑——只读 agent 不需要诊断 |
| 去重 | `gSu extends gAr`（去重集合），"已投递过的诊断不再投" |
| 限流 | `Volume limiting removed N diagnostic(s) (max ...)`，超上限丢弃 |
| 截断 | `mSu=4000`，单块超 4000 字符截断 |
| 触发 | 每轮推理前 attachment，和 `changed_files` 同批 |
| 依赖 | 需要跑 LSP server + `textDocument/publishDiagnostics` 监听 |

### 5b.4 典型流程

```
模型 Edit config.js → LSP 重分析
       ↓
下一轮推理前 attachment 同批产出两件事：
  changed_files  → "Note: config.js was modified... <diff>"
  lsp_diagnostics → "<new-diagnostics>config.js: ⨯ SyntaxError ...</new-diagnostics>"
       ↓
模型同时看到"改了什么" + "有没有报错"
```

### 5b.5 elf 现状

**完全未实现**。elf 无 LSP 集成、无诊断 attachment。`detectChangedFiles` 只管内容 diff，不管语义诊断。要补需先接 LSP（启动 server / 文件追踪 / publishDiagnostics 监听），投入大、elf 作为纯 CLI 无 IDE 依托，暂不做。

---

## 6. 完整数据流

```
用户/外部修改文件
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ 每轮推理前 Qap/KhY: ab("changed_files", ()=>ilp(u))       │
│                                                          │
│  for each file in readFileState:                         │
│    tYe.mtime > recorded.timestamp? ─否→ skip             │
│    IOe(recorded, diskContent)? ──相同→ skip               │
│    nS.call(Read) → 刷新 readFileState.timestamp          │
│    PCu(old,new) → unified diff                           │
│                                                          │
│  → [{type:"edited_text_file", filename, snippet}]        │
└──────────────────┬───────────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────────┐
│ ddp dispatcher → Br({content: "Note: ...", isMeta:true}) │
│ → 独立 role:user + isMeta 消息                           │
│ → 无 <system-reminder> 标签                              │
│ → 位置: 上轮 tool_result 与本轮 user 之间                 │
└──────────────────┬───────────────────────────────────────┘
                   ▼
           模型收到通知（只此一次）
```

---

## 6b. 其他功能 vs CC 源码 review

> 除文件变更检测外，逐功能对比 elf 与 CC（v2.1.209 二进制）的差异。仅列 **DIFF**，已对齐的不写。CC 证据如无标注 offset 为二进制字符串反查。

### 6b.1 Read 工具

| 差异点 | CC | elf (Read.js) | 影响 |
|:--|:--|:--|:--|
| 二进制文件防护 | 有（`validateInput` errorCode 4，按扩展名 `Fap`/`lWt` 集合判定 + magic number） | 无 | elf 会把二进制文件当 utf-8 读，返回乱码、不报错 |
| 设备文件防护 | 有（`Gg_` 检测，errorCode 9 "would block or produce infinite output"） | 无 | elf 读 `/dev/zero` 等会挂起/OOM |
| L3 重读短路 | 短路返回提醒文本，不读盘、不刷 timestamp（见 §4） | 读盘+返回内容+刷 timestamp | 见 §4.3b 对齐方案 |
| 分页截断提示 | `<system-reminder>Warning: the file is shorter than the provided offset</system-reminder>` | 无（空数组返回空字符串） | elf 对越界 offset 静默返回空 |

### 6b.2 Bash 工具

| 差异点 | CC | elf (Bash.js) | 影响 |
|:--|:--|:--|:--|
| 默认超时 | `jDi=30000`（30s） | `DEFAULT_TIMEOUT=120000`（2min） | elf 默认放更长，行为偏离 |
| 超时上限 | `qDi=150000`（150s） | `MAX_TIMEOUT=600000`（10min） | 同上 |
| 工作目录持久化 | 每次 spawn 前缀 `cd ${cwd} &&`，`CLAUDE_CODE_BASH_MAINTAIN_PROJECT_WORKING_DIR` 控制 | description 声称"persists"但每次新 spawn，**不持久** | elf description 与实现不符，cd 不跨调用保留 |
| `run_in_background` | 真实后台任务 + 完成通知（`async_launched` 状态） | 声明参数但**未实现**，前台执行 | elf 该参数无效 |
| `dangerouslyDisableSandbox` | 真实 sandbox 切换 | 声明参数但**未实现** | elf 该参数无效 |
| 输出超限 | 落盘 `Full output saved to: <path>`，可回读（`TaskOutput.#readStdoutFromFile`） | 简单截断 `[truncated: N bytes omitted]` | elf 大输出直接丢失，不可回读 |
| 输出上限 | `BASH_MAX_OUTPUT_LENGTH`（可配，默认较大） | 固定 `MAX_OUTPUT=100KB` | elf 不可配 |

### 6b.3 Glob 工具

| 差异点 | CC | elf (Glob.js) | 影响 |
|:--|:--|:--|:--|
| 结果排序 | 按修改时间排序（mtime desc） | 无排序（readdir 顺序） | elf 结果顺序不稳定，不符合 CC"最近修改优先"语义 |
| .gitignore | 默认遵守 `.gitignore`（ripgrep/ignore 规则） | 仅硬编码 `DEFAULT_EXCLUDES`，不读 .gitignore | elf 会列出被 ignore 的文件 |
| 超时 | `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` | 无超时 | 大目录 walk 可能卡住 |
| 结果上限 | 可配 | 固定 `MAX_RESULTS=500` | elf 不可配 |

### 6b.4 Grep 工具

基本对齐（都优先 ripgrep + Node 回退）。已知小差异：
- elf 纯 Node 回退用 `new RegExp(pattern)`，CC ripgrep 用 Rust regex 语法——**正则方言不同**，部分 PCRE 特性（lookbehind 等）在 elf 回退路径可能行为不一致
- elf 固定 `MAX_FILES=1000` 扫描上限、`FILE_SIZE_LIMIT=1MB`，CC 无此硬上限（靠输出截断控制）

### 6b.5 Write/Edit 工具

已对齐文件 staleness 检测（见 §3、§5）。残留差异：
- Write 新文件不要求 Read（对齐 CC）；但 elf Write 对**已存在文件**的 stale 检查在 `isPartialView` 分支直接拒绝，CC 同样如此——一致
- Edit recovery（§3.2）已对齐 `J7i` 语义

### 6b.6 Agent 工具（子 agent）

需进一步核查（本次 review 未覆盖 subagents/ 目录 vs CC 的 Task/Agent 工具实现）。

### 6b.7 Skill 工具

已实现 skill 清单增量推送 + compact 后重推 invoked_skills（`skills/lister.js`），与 CC `mhY`/`dAq` 语义对齐。残留差异需核查：
- CC skill 有 `dynamic_skill`（运行时发现）、`deferred_tools_delta` 等机制，elf 是否对齐

### 6b.8 Compact 机制（agent 层）

| 差异点 | CC | elf (message_manager.js) | 影响 |
|:--|:--|:--|:--|
| 三级压缩 | microcompact（裁 tool_result）+ reactive（预计算）+ auto（摘要） | **仅单级 auto 摘要** | elf 无轻量裁剪，tool_result 大时直接走全量摘要，比 CC 更易触发、更昂贵 |
| 触发口径 | `xv`（最近 usage + 新增消息 token）≈167k | `estimateTokens`（全部消息 token）vs `memoryTokenLimit`（默认 4000-8000） | elf 阈值口径不同，更早触发 |
| tool_result 裁剪 | microcompact `keepRecent=5` 最小节省 20000 token | 无 | elf 老的 tool_result 永远全文保留直到 compact 摘要 |
| 断路器 | 连续失败禁用 | 有（`COMPACT_FAIL_THRESHOLD=3`） | ✅ 对齐 |
| compact 后重推 | `invoked_skills` + `compact_file_reference` | 仅 `invoked_skills` | elf 缺 `compact_file_reference`（见 §9） |

**microcompact 机制详解**（详见 [`cc-microcompact-2.1.209.md`](./cc-microcompact-2.1.209.md)）：

CC 的 microcompact 是**全量摘要（L4）之前的轻量省 token 闸**，不调 LLM、不摘要，只把偏老的 `tool_result` 内容清成短占位：

- **触发**：服务端 `context_hint` SSE 提示 token 偏高（elf 无服务端信号，需改用客户端 `estimateTokens()` 阈值）
- **动作** `BLs(messages, keepRecent)`：收集所有 tool_result，保留最后 `keepRecent=5` 个，其余 content → `[Old tool result content cleared]`（媒体块用 `kvo` 占位，可选落盘 `<persisted-output>` 可回读）
- **守卫**：可省 token < `$Ls=20000` 则不触发（省不到不裁）
- **只动 tool_result 内容**，user/assistant 文本全留；非递归
- **参数**：`keepRecent=5`（写死 `A$d=5`）、`minSavings=20000`（`$Ls`）、替换文本 `[Old tool result content cleared]`
- **与 L4 的关系**：在 L4 之前跑，清完重估 token，可能避免本轮 L4；不调 LLM 故不受断路器连坐

elf 接入要点（无 context_hint）：
1. `compactIfNeeded` 开头插入 `_microcompactIfNeeded()`，在 `_compactDisabled` 检查之前（不调 LLM、不受断路器）
2. 触发 threshold = `memoryTokenLimit * 0.6`（低于 L4，留提前量）
3. 复用 elf 现有 `_persistToolResult` 落盘基建 → 清理时落盘 + 带 filepath 占位，**可回读**（比 CC 默认纯清理更安全）
4. 跳过已 `<persisted-output>` 的 result，不与 L1/L2 重复处理

### 6b.9 优先级建议

**本轮决策**：P1 只做 Read L3 短路；P2 做 Bash 落盘 / Glob 排序+gitignore / detectChangedFiles hook 化；microcompact 已实现不重做；其余暂缓。

> **修订**：microcompact 已在 `agents/elf-002/message_manager.js` 实现并启用（`microcompactEnabled:true`），符合预期，**不在本轮待办**。

| 优先级 | 项 | 理由 | 状态 |
|:--|:--|:--|:--|
| **P1（本轮）** | Read L3 短路对齐（§4.3b） | 省 IO + token | 待做 |
| **P2（本轮）** | detectChangedFiles hook 化（见 §6b.11，最终方案 agent hook 注入） | 仅 coding agent 需要，不该写死基类 | 待做 |
| **P2（本轮）** | Bash 输出落盘可回读 | 大命令输出不丢失 | 待做 |
| **P2（本轮）** | Glob 按修改时间排序 + .gitignore | 结果质量 | 待做 |
| ✅ 已完成 | Compact microcompact | 见 elf-002/message_manager.js | 已实现 |
| 暂缓 | Read 二进制/设备文件防护 | 安全性，非本轮 | — |
| 暂缓 | Bash 工作目录持久化 | 需重设计，非本轮 | — |
| 暂缓 | Bash `run_in_background` 真实实现 | 工作量大 | — |

### 6b.10 detectChangedFiles hook 化（最终方案：通用 pre-reasoning hook 数组）

**问题**：当前 `detectChangedFiles` 硬编码在基类 `default_agent.js` reasoning 入口（第 17 行 import + 第 337 行 await），所有 agent 每轮都跑。但文件变更检测只有 coding agent（有 Read/Write/Edit）需要，普通对话 agent 无意义浪费 IO，且基类不应感知文件检测这个具体概念。

**决策**：基类提供**通用 `_preReasoningHooks` 数组**——可塞任意 `(messageManager) => Promise<void>` 函数，基类零感知塞的是什么。`detectChangedFiles` 只是 coding agent 往里注入的"一个函数"之一。文件检测不再叫"文件检测 hook"，它是通用扩展点的一个用例。

**CC 对照**：CC 的 `ilp` 是 `Qap` 里 opt-in 的 attachment producer（`ab("changed_files", ()=>ilp(u))`），且门控为"注册了 Edit/Write 工具才跑"（`if(!e.options.tools.some(r=>pl(r,Yo)||pl(r,Hi))) return[]`）。通用 hook 数组 + 装配处门控完美对应这个 opt-in 形态。

**方案**：

1. **基类 `default_agent.js`** — 纯通用 hook 点，零业务感知：
   - 构造器加 `this._preReasoningHooks = []`
   - `reasoning()` 入口改为：
     ```js
     for (const hook of this._preReasoningHooks) {
       await hook(this.messageManager);
     }
     ```
   - **删掉**第 17 行 `import { detectChangedFiles }` 和第 337 行硬编码 `await detectChangedFiles(...)`

2. **`fromConfigDir`** — 按需求装配具体能力，门控由装配方负责（对齐 CC `Yo`/`Hi` 检查放 producer 里）：
   ```js
   // 紧接现有 skills 注入块之后
   if (config.get('fileChangeDetection') === true) {
     const codingTools = ['Read', 'Write', 'Edit'];
     if (codingTools.some(t => agent.toolRegistry.get(t))) {
       const { detectChangedFiles } = await import('./tools/file_change_detector.js');
       agent._preReasoningHooks.push(detectChangedFiles);
       logger.info('已启用文件变更检测');
     }
   }
   ```
   门控由装配处决定（有读写工具才注入），`detectChangedFiles` 签名保持 `(messageManager)` 不变——符合"hook 是任意函数，具体能力自己装配"，hook 函数本身不做工具判定。

3. **`file_change_detector.js`** — 签名不变，无需内部再判工具（门控已上移到装配处）。

4. **`agents/elf-002/config/config.json`** 加 `"fileChangeDetection": true`。

5. 其他 agent（elf-001/003）不配 → 不注入 → hook 数组空 → reasoning 循环不执行，零回归。

**改动文件**：
| 文件 | 改动 |
|:--|:--|
| `shared/agent/default_agent.js` | 构造加 `_preReasoningHooks=[]`；reasoning 循环调用；删 import + 硬编码；fromConfigDir 加装配块（含工具门控） |
| `agents/elf-002/config/config.json` | 加 `"fileChangeDetection": true` |

**为什么不新建 elf-002/agent.js**：现有 `fromConfigDir` 已有 `config.get('skills')` 注入 `skillLister` 的现成模式，文件检测照搬即可，0 新文件。

**语义分层**：通用 hook 数组（基类，任意能力可注入） × 具体能力装配（fromConfigDir，per-agent config + 工具门控决定塞什么）。`detectChangedFiles` 只是第一个用例，未来 todo 提醒、date change 等每轮例行任务都可往这个数组塞，无需改基类。

---

## 7. elf-002 对齐方案

### 7.1 现状 vs 目标

| 机制 | CC | elf 现状 |
|:--|:--|:--|
| readFileState 带 content/hash/timestamp | LRU Map | `Set<string>` 仅路径 |
| L1: 每轮 changed_files 通知 | `ilp` → diff → isMeta 消息 | ❌ |
| L2: Write staleness 挡板 | mtime+hash → errorCode 3 | 仅 hasRead |
| L2: Edit staleness 挡板 | mtime+hash+恢复尝试 → errorCode 7 | 仅 hasRead |
| L3: Read 重读 system-reminder | tool_result 内联 | ❌ |
| Compact file_reference | isMeta 引用提示 | ❌ |

### 7.2 改动文件

```
shared/agent/tools/read_state.js      ← 重写：Set→Map<path, {content,hash,ts,offset,limit}>
shared/agent/tools/Read.js            ← markRead 新签名 + L3 system-reminder
shared/agent/tools/Write.js           ← L2 陈旧挡板
shared/agent/tools/Edit.js            ← L2 陈旧挡板+恢复尝试
shared/agent/tools/file_change_detector.js  ← 新增：ilp 等价物
shared/agent/default_agent.js        ← reasoning 入口加一行 await
```

### 7.3 优先级

| 序 | 模块 | 理由 |
|:--|:--|:--|
| P0 | read_state 升级 + Read 适配 | 所有后续步骤的依赖 |
| P1 | Write/Edit 陈旧挡板 | 核心安全性 |
| P2 | file_change_detector + default_agent 挂载 | 通知模型 |
| P3 | L3 already_read system-reminder + compact_file_reference | 体验优化 |

### 7.4 消息注入对齐

| 场景 | CC | elf |
|:--|:--|:--|
| 文件变了 | `Br({content:"Note:", isMeta:true})` | `addMetaMessage(msg, 'file_changed')` |
| 文件没变重读 | Read tool_result 内联 `<system-reminder>` | Read.js return 末尾追加 |
| Compact 引用 | `Br({content:"Note:", isMeta:true})` | `_reinjectMetaMessages` 扩展（延后） |

### 7.5 elf 与 CC 的关键差异

- **hash 算法**: CC 用 `Bun.hash()` → elf 用 `crypto.createHash('sha1')`
- **diff 算法**: CC 用 native diff 库(context=8) → elf 用简易 LCS(context=3)，后续可换 npm `diff`
- **keepContent 阈值**: CC `qdg=4096` 字节，elf 同值
- **snippet 总额**: CC `Cy_=16384` 字节，elf 同值

---

## 附录：关键常量

| 常量 | CC 值 | 说明 |
|:--|:--|:--|
| `qdg` (offset 217599478) | `4096` | LRU 单条 content 保留阈值（字节） |
| `Cy_` (offset 225642090) | `16384` | 每轮 diff snippet 总额（字节） |
| PCu context | `8` | unified diff 上下文行数 |