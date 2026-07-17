# 记忆压缩(Compact)改造需求文档

> 基类 MessageManager 提供 **naive 第 4 层压缩**(最朴素可靠,不依赖模型输出格式);
> elf-002 等"对齐 CC 的严肃 agent" override 第 4 层加 CC 复杂特性(`<summary>` 解析、断路器、二次压缩等)+ 自留第 1/2 层工具治理。
> 设计原则:**基类只放通用最小能力,复杂增强由特化子类按需 override**。
> 与 subAgent 改造(`docs/subagent-design.md`)分离,可独立先行。

---

## 一、范围界定(先读这一节)

压缩能力分层归属:

| 层 | 功能 | 归属 | 理由 |
|---|---|---|---|
| 第 4 层(naive) | 超阈值 → 调 LLM 总结 → `SUMMARY_PREAMBLE + 回复` 替换历史 | **基类** | 通用横切能力,所有 agent 都可能需要;最朴素形态不依赖模型输出格式,可靠 |
| 第 4 层(CC 增强) | `<analysis>`/`<summary>` 解析、断路器、二次压缩、`_cleanupToolResults` | **elf-002 override** | 对齐 CC 的严肃编码 agent 特化需求;不强制所有 agent |
| 第 1 层 | 单工具结果超 `perToolLimit` → 持久化 `<persisted-output>` | **elf-002 专属** | 重度工具 agent 需求 |
| 第 2 层 | 单轮工具结果总量超 `budgetWindow` → 贪心淘汰最大、持久化 | **elf-002 专属** | 同上 |

→ 基类 L4 必须 **naive 且不依赖模型格式**:不解析 `<summary>` 标签、不要求 LLM 特定输出。LLM 返回啥,前缀 SUMMARY_PREAMBLE 直接用。这从根上消除"模型不产出预期标签 → 解析失败 → 连环失败 → 断路器"的失败链(此前 elf-001 实测踩过)。

> **关键纠偏**:本方案推翻了早期"把 elf-002 成熟 L4(含 `<summary>` 解析、断路器)上提基类"的设计。理由:成熟能力是 elf-002 特化需求,塞基类会强加给 elf-001 这类朴素 agent,且 `<summary>` 解析依赖模型配合、引入失败风险。基类只保留通用 naive L4。

> **第 1/2 层与第 4 层耦合**:elf-002 第 4 层压缩时手拼 summaryRequest 而不走 `getMessagesForLLM`(避免预算窗口误替换)。基类 naive L4 同样手拼(不调 `getMessagesForLLM`)——基类无第 1/2 层、`getMessagesForLLM` 本无副作用,但手拼保持与 elf-002 一致、且子类(elf-002)override 第 4 层时若调 `getMessagesForLLM` 会误触其预算窗口,故基类/elf-002 都手拼。无基类钩子。

---

## 二、现状(已核实)

三处 MessageManager:

| MM | 行数 | 压缩时机 | 压缩 prompt | 压缩产物 | 失败处理 |
|---|---|---|---|---|---|
| `shared/agent/message_manager.js`(基类,改造后) | ~280 | **循环内 + 循环后兜底** | 可配 `compactSystemPrompt`/`compactPrompt` | naive:`SUMMARY_PREAMBLE + LLM 回复`,`isCompactSummary:true` | 空回复/异常 → `yield compact_error`、不替换、loop 继续(无断路器) |
| `agents/elf-001/message_manager.js` | 43 | 继承基类 | 继承基类(从 config 读) | 继承基类 | 继承基类 |
| `agents/elf-002/message_manager.js` | ~372 | **循环内 + 循环后兜底**(走基类 reasoning) | **可配**(`compactSystemPrompt`/`compactPrompt`,基类装配) | **成熟产物**:`SUMMARY_PREAMBLE + "Summary:\n"+ <summary>`,`isCompactSummary` | 断路器:连续失败 3 次禁用 |

基类 naive L4 要点(本次落地形态):
- 触发:`estimateTokens() > memoryTokenLimit`
- 请求:手拼 `[{system}, ...messages, {user: compactPrompt}]`,`enable_thinking: false`
- system:`compactSystemPrompt` 非空用它(临时替换);留空沿用主 `systemPrompt`(退化,不发空 system)
- 产物:`this.messages = [{ role:'user', content: SUMMARY_PREAMBLE + LLM回复, isCompactSummary: true }]`
- 失败:LLM 回复空 / 非 Abort 异常 → `yield compact_error`、不替换、loop 继续(无断路器、无禁用)
- AbortError:抛给 agent 走中断(compact_abort)
- 二次压缩:不递归;仍超阈值留待下一轮 loop 顶部(对齐 CC)
- **无** `_parseSummaryResponse`/断路器/`_onCompactSuccess` 钩子(这些是 elf-002 特化,基类不背)

事实补充:
- `chatStream` 整批累积返回 tool_calls(llm_model.js:177/194),压缩触发点到达时上一轮工具必已全部 `addToolResult` 补齐 → 压缩请求合法配对,不会因孤立 tool 消息被接口拒(详见 §4.7)。
- 前端压缩渲染(useChat.js):`compact_start` 先 seal 当前气泡(若上一条是未收尾的 compactLoading,先标 error 收尾)、再开新气泡;`compact`/`compact_error` 收尾气泡;`token` 用 `lastBubble.sealed` 判定开新气泡。压缩后新输出接在压缩气泡后。

---

## 三、改造目标

1. 基类 L4 = naive(不依赖模型格式、无断路器、无解析、无钩子、无递归)。
2. 压缩时机:循环内 autocompact(`getMessagesForLLM` 之前) **+ 循环后兜底**(break/maxIterations 退出后补压一次)。
3. 压缩 prompt 可配:`compactSystemPrompt`/`compactPrompt` 进基类构造/updateConfig/reloadConfig(从 Config 实例取)。
4. compactSystemPrompt 退化:留空沿用主 systemPrompt。
5. 压缩调 LLM 带 `enable_thinking: false`。
6. elf-001 config-ui 加 `compactPrompt`/`compactSystemPrompt` 配置入口(hint 清晰)。
7. elf-002 保留 CC 特化 L4 override(`<summary>` 解析、断路器、`_cleanupToolResults`)+ L1/L2;删 reasoning 副本走基类 loop;去二次压缩递归(对齐 CC);删 compactPrompt 重复读取(继承基类装配)。

---

## 四、改动清单

### 4.1 基类 L4 重写为 naive

- 基类 `compactIfNeeded`:手拼请求 → LLM `chat`(enable_thinking:false)→ 空回复/异常 `compact_error`、否则 `SUMMARY_PREAMBLE + 回复` 替换为单条 `isCompactSummary` user。
- **删** `_parseSummaryResponse` / `_recordCompactFailure` / `_resolveCompactSystemPrompt`(inline 化)/ `_onCompactSuccess` 钩子 / 断路器字段(`_compactFailCount`/`_compactDisabled`)/ `COMPACT_FAIL_THRESHOLD` 常量。
- 二次压缩:不递归(对齐 CC)。
- system 退化 inline:`this.compactSystemPrompt || this.systemPrompt || ''`。

### 4.2 压缩时机:循环内 + 循环后兜底

- **循环内**:reasoning while 顶部、`getMessagesForLLM` 之前调 `compactIfNeeded`(对齐 CC autocompact,已核实 CC v2.1.77 bundle @offset 9076497:autocompact 在 callModel 前、含当前 user)。
- **循环后兜底**:loop 退出(break 纯文本回复 / 达 maxIterations)后、done 前再调一次 `compactIfNeeded`。覆盖"最后一轮 LLM 长回复撑爆、循环内顶部没压到"场景(elf reasoning 纯文本 break 后对话结束,无"下个 turn 顶部"机会,须兜底)。
- compactIfNeeded 内部不超阈值即 return,无副作用,故"循环内每轮 + 循环后"双调用安全。
- 失败(AbortError)走 compact_abort + aborted + done return;其他失败已被 MM 内部 yield compact_error,reasoning catch 仅记日志、loop 继续。

### 4.3 压缩提示词可配 + 装配修复

- 基类 MM 构造/updateConfig 读 `compactSystemPrompt`/`compactPrompt`(默认空串)。
- **装配修复(此前 bug 根因)**:`default_agent.js` 建 MM 的 `mmParams` 必须从 Config 实例 `.get()` 取出 compactSystemPrompt/compactPrompt 塞进去(此前漏塞 → 运行时为空);`reloadConfig()` 热加载时 updateConfig 也要传这俩字段。详见 §4.6 bug 记录。

### 4.4 compactSystemPrompt 退化语义

- `compactSystemPrompt` 非空 → 用它(临时替换主 system)。
- 留空 → 沿用主 `systemPrompt`(退化,不发空 system)。
- 理由:压缩请求仍需角色约束;messages 数组不含 system(getMessagesForLLM 拼接),手拼请求需自补 system,留空沿用主 system 补位。
- 都空 → `''`(极少见)。

### 4.5 elf-001 配置入口

- `agents/elf-001/config/config.json`:`compactPrompt`(现用「请简要总结以上对话的关键信息和待办事项，保留重要细节。」)+ `compactSystemPrompt`("")已配。
- `agents/elf-001/config/config-ui.json`:prompt tab 加 `compactPrompt`/`compactSystemPrompt` 字段,hint:
  - compactPrompt:「记忆压缩触发时,附加在历史末尾发给压缩 LLM 的指令(如"请简要总结以上对话")。留空则压缩请求不带此指令」
  - compactSystemPrompt:「记忆压缩请求使用的系统提示词,临时替换主系统提示词。留空则沿用主系统提示词(退化,不发送空 system)」

### 4.6 已修复 bug 记录(装配层 + UI)

**bug1:compactPrompt 配了却运行时为空**(根因,非掩盖式修复)
- 根因:`default_agent.js` mmParams 漏塞 compactSystemPrompt/compactPrompt(只塞了 systemPrompt/memoryTokenLimit);`reloadConfig()` updateConfig 也漏传。基类构造属性访问 `config.compactPrompt` 读到 undefined → 空 → 压缩请求末尾空 user → LLM 返回空 → 连环失败。
- 修复:mmParams 补两字段从 `config.get()` 取;reloadConfig updateConfig 补传。**不加默认值兜底,直击装配 bug**。
- 注:elf-002 MM 之前能读到,是它 override 构造用 `this._config.get('compactPrompt')`(Config 实例方法)绕过了基类装配 bug。

**bug2:压缩气泡连环 loading / 未收尾**
- 根因:压缩反复失败时,`compact_start` 连环开新气泡,上一条未收尾的 compactLoading 气泡被 seal 但 `compactLoading:true` 留着 → 永久转圈。
- 修复:`useChat.js` compact_start case 开新气泡前,若上一条是 `compactLoading && compactSummary==null && !compactError`(未收尾),先标 `compactError:'记忆压缩未完成'` 收尾。无永久 loading 悬空。

### 4.7 压缩请求合法性(已推演确认,无需清洗)

- 压缩触发点(循环内 while 顶部 / 循环后)到达时,上一轮整批 tool_calls 必已全部 `addToolResult` 补齐 → messages 末尾必为 `assistant(content:null, tool_calls:[整批]) + N 条 tool(逐一配对)`,配对完整无 dangling。
- 叠加 `chatStream` 整批累积返回 tool_calls(llm_model.js:177/194),无半个 tool_call 残留。
- → 压缩请求合法配对输入,不会被接口拒,无需"清孤立 tool"清洗。

---

## 五、落地步骤(已完成)

1. ✅ 基类 L4 重写 naive(删解析/断路器/钩子/递归,inline 退化)。
2. ✅ 基类 reasoning 压缩时机:循环内 + 循环后兜底。
3. ✅ 装配修复:mmParams + reloadConfig 传 compactSystemPrompt/compactPrompt。
4. ✅ elf-001 config-ui 加压缩提示词入口。
5. ✅ bug2 前端 compact_start 收尾未结束 loading 气泡。
6. ✅ 测试对齐 naive 基类(删断路器/解析相关测试,改产物断言为 SUMMARY_PREAMBLE+回复)。
7. ✅ 全量测试 179/179 pass。
8. ✅ elf-002 收敛(§六):删 reasoning 副本走基类 loop、L4 override 保留为特化增强、去二次压缩递归、删 compactPrompt 重复读取。

---

## 六、elf-002 收敛(已完成)

- ✅ **删 `agents/elf-002/agent.js` reasoning 副本**:副本与基类 reasoning 100% 等价(循环内 autocompact + 循环后兜底 + compact 失败处理),纯冗余。删文件 + config 去 `agentClass` → 走基类 Agent。基类 reasoning 调 `this.messageManager.*` 时 elf-002 MM override(L1/L2 + CC 增强 L4)多态生效。协同 subAgent §3.0。
- ✅ **elf-002 MM L4 override 保留为特化增强**:`<summary>` 解析、断路器、`_cleanupToolResults` 内联调用(不经基类钩子,基类钩子已删,自管)。L1/L2(`addToolResult` 持久化、`getMessagesForLLM` 预算窗口、`estimateTokens` override)保留。
- ✅ **二次压缩去递归**:删 `yield* this.compactIfNeeded` 本轮递归,改对齐 CC(压一次返回,留待下轮 loop 顶部)。消除此前 RangeError 隐患。
- ✅ **删 compactSystemPrompt/compactPrompt 重复读取**:构造/updateConfig 不再 `this._config.get(...)` 自读,继承基类从 mmParams 装配(`start.js` 装配修复后值一致)。
- ✅ 全量测试 179/179 pass;config 验证 agentClass 已去、messageManagerClass 保留、compactPrompt 从 md 文件读到。

> elf-002 现状:走基类 reasoning(循环内 + 循环后兜底)+ 自有 MM(L4 CC 增强 + L1/L2)。memoryTokenLimit=4000(用户调小用于测试压缩触发)。

---

## 七、测试

### 7.1 现状

- `npm test` 跑 shared/agent/gateway/config-store/integration 五文件。`elf001-message-manager.test.js` 未在脚本(孤儿)。
- compact 测试在 shared.test.js + agent.test.js 两处(基类 MM)。
- elf-002 MM 零测试。

### 7.2 基类 naive 测试(已对齐)

基类 L4 naive 后分支:
1. 成功:Mock 纯文本回复 → 产物 `SUMMARY_PREAMBLE + 回复`、`isCompactSummary`、yield compact ✅
2. 空回复:Mock 返回空白 → yield compact_error、不替换 messages ✅
3. 无断路器:反复失败仍每次尝试(无 _compactDisabled)✅
4. AbortError:抛出给调用方 ✅
5. 不递归:仍超阈值只压一次 ✅
6. compactPrompt/compactSystemPrompt 可配:请求含配置值 ✅
7. compactSystemPrompt 留空退化:沿用主 systemPrompt ✅
8. enable_thinking:false ✅

### 7.3 待补(elf-002 + 装配层)

- elf-002 L4 override 特性测试:`<summary>` 解析、断路器、`_cleanupToolResults` 触发(二次压缩已去递归)。
- 装配层集成测试(Config → mmParams → MM 读到 compactPrompt)——防 bug1 再现(此前因测试用普通对象构造 MM、绕过装配路径而漏网)。
- 注:elf-002 删 reasoning 副本已靠"副本与基类等价"论证 + 全量测试 + 多态验证,未单独补行为回归测试(后续若有 elf-002 专属测试文件可补)。
