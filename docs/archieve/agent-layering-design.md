# Agent 分层与显式实例化重构

> 日期：2026-07-22
> 关联：`agent-yield-analysis.md`（已落地的 callback 化基础）、`agent-plugin-system-design.md`（middleware 机制）
> 状态：**阶段一+阶段二已落地**（445 测试绿 + 端到端冒烟通过）。阶段三（单进程多实例）未做，目标见九点五节。
>   - 阶段一：Harness 无状态机制 + constructor 接线 + create_agent.js 显式装配 + run-level 通道 + RoomMiddleware.flushLoop。
>   - 阶段二：chat 实例对称（data 迁 chat/<id>/data + 自动迁移回退）+ PrivateChatMiddleware（迁 _ensureSyncSource + 修 sync bug）+ 场景 middleware 走 run-level（_sceneMiddleware + server.js /chat /observe 传）+ shared/agent/→engine/ 重命名。

## 一、Context

callback 化（yield→emit）已落地、abortFlow/重试/canceled 状态就位。当前 `default_agent.js` 一个类背三份职责：**工厂**（fromConfigDir 反射加载 messageManagerClass）、**业务编排**（receive/reasoning/_roomFlushLoop）、**插件机制**（_runInjection/_dispatchGate/_emit）。三份混在一起，且 elf-00x 定制靠 config.json `messageManagerClass` 反射——语义糊（"莫名重载"）。

重构目标：elf-00x 自己建器官 + `new Agent` 显式组装，机制移出 agent.js，场景策略走 run-level middleware。**不要 createAgent 工厂函数**——ELF 的 middleware-带-工具（RoomMiddleware 注 Speak）是 run-level/invoke 时发生，不需 compile-time 扫结构，constructor 接线即可。

## 二、三层结构与职责

```
engine 层（shared/agent/，阶段一内部重组、不改目录名）
  Agent 基类（固定 agent loop，constructor 内部接线）+ Harness（middleware/callback 调度）+ abortFlow
  + prebuilt middleware（Room/PrivateChat/Skills/DetectChangedFiles）

agent 定义层（agents/elf-00x/，模板，无运行时 data）
  config.json + message_manager.js（mm 子类）+ create_agent.js（导出 createAgent，内部建器官 + new Agent）
  只声明固有定制（mm 子类 + 特有 middleware + tools），不含 data、不含场景策略

环境实例层（gateway，阶段二建；阶段一暂由 start.js 代理）
  代表"agent 此刻在什么场景"，invoke 时注入场景 middleware 作为 run-level
```

**核心原则**：
- 场景策略（群聊/私聊）= 环境加给 agent 的硬规则，跨 agent 通用，**不是 agent 自有** → 不进 create_agent.js/constructor，走 run-level middleware。
- run-level + agent-level middleware 都跑、按序合并（`[...agentLevel, ...runLevel]`）。
- elf-00x 用 `create_agent.js`（内部 `new Agent`）显式实例化，不再反射加载。

## 三、Agent 类（engine/agent.js，constructor 接线，无通用工厂）

```js
// shared/agent/agent.js（阶段二改名 engine/agent.js）
export class Agent {
  constructor({ config, model, toolManager, messageManager, middleware = [], callbacks = [], skillLister = null, runContext = null }) {
    this.config = config; this.model = model; this.toolManager = toolManager;
    this.messageManager = messageManager; this.skillLister = skillLister; this.runContext = runContext;
    this.toolManager._setMessageManager?.(messageManager);
    this.abortFlow = new AbortFlow({ messageManager }); this.abortFlow._setAgent(this);
    this._aborted = false; this._currentAbortController = null;
    this.syncSource = null;       // 阶段一仍留（_ensureSyncSource 暂不动，阶段二迁 PrivateChatMiddleware）
    this.agentLevel = middleware;       // agent-level middleware（构造时注入，agent 自持）
    this.callbacks = callbacks;
    this.harness = new Harness();       // 无状态调度器（先建）
    this.messageManager._eventSink = (event, data) => this.harness.emit(this.callbacks, event, data);  // 接线（harness 已就绪）
  }

  // 合并 agent-level + run-level，传无状态 harness 调度
  _mergedMiddleware(runMiddleware = []) { return [...this.agentLevel, ...runMiddleware]; }

  async receive(message, options = {}) {
    const emit = options.emit || (() => {});
    const middlewares = this._mergedMiddleware(options.middleware);
    try {
      const gate = await this.harness.dispatchGate(middlewares, 'preReceive', null, message);
      // gate==null → 私聊默认（阶段一 _ensureSyncSource 老路径；阶段二 PrivateChatMiddleware）
      // gate 非 null → room（RoomMiddleware 重新实现 flushLoop，调 this.agent.reasoning + 自家门控；阶段一做）
      await this.reasoning(message, { emit, middleware: options.middleware });
    } catch (err) {
      this.abortFlow.emitError(emit, err.message); this.abortFlow.emitDone(emit);
    }
  }

  async reasoning(message, opts = {}) {
    const middlewares = this._mergedMiddleware(opts.middleware);
    // Agent Loop：compact→llm→tools→兜底，4 段经 harness 跑 hook 点（preReason/shouldBreakAfterTools/onAssistantContent）。固定循环，不改拓扑。
  }

  // 控制接口（一行委托 harness）
  abort() { this.harness.abort(this); }
  updateModel(m) { this.model = m; }
  updateMessageManagerConfig(c) { this.messageManager.updateConfig(c); }
}
```

**elf-00x 示例**（elf-002，从反射 → 显式 new Agent；补真实 skillLister/detectChangedFiles，对齐 elf-002 config）：

```js
// agents/elf-002/create_agent.js
import { Agent } from '../../shared/agent/agent.js';
import { LLMModel, ToolManager, Config } from '../../shared/agent/...';
import { Read, Write, Edit, Bash, Glob, Grep, Agent, Skill } from '../../shared/agent/tools/index.js';
import { SkillLister } from '../../shared/agent/skills/lister.js';
import { Elf002MessageManager } from './message_manager.js';

export function createAgent({ runContext }) {
  const config = new Config(`${__dirname}/config`); config.load();
  const model = new LLMModel(config.getModelConfig());
  const toolManager = new ToolManager();
  [Read, Write, Edit, Bash, Glob, Grep, Agent, Skill].forEach(t => toolManager.register(t));
  const messageManager = new Elf002MessageManager({
    systemPrompt: config.get('systemPrompt') || '', memoryTokenLimit: config.get('memoryTokenLimit'),
    compactSystemPrompt: config.get('compactSystemPrompt') || '', compactPrompt: config.get('compactPrompt') || '',
    perToolLimit: config.get('perToolLimit'), budgetWindow: config.get('budgetWindow'),
    microcompactEnabled: config.get('microcompactEnabled'), config,
  });
  // agent-level 固有定制（非场景）：skillLister（skills=true）+ detectChangedFiles middleware（fileChangeDetection=true 且有 Read/Write/Edit）
  const middleware = [];
  if (config.get('fileChangeDetection') === true && ['Read','Write','Edit'].some(t => toolManager.get(t))) {
    middleware.push({ preReason(mm) { return detectChangedFiles(mm); } });
  }
  const skillLister = config.get('skills') === true ? (() => { const s = new SkillLister({ messageManager, toolManager, cwd: process.cwd() }); s.enable(); return s; })() : null;
  return new Agent({ config, model, toolManager, messageManager, middleware, skillLister, runContext });
}
```

**约定**：每个 elf-00x 目录下必须有 `create_agent.js`，导出 `createAgent({runContext})`（函数名统一）。start.js 按约定 import `agents/<id>/create_agent.js`。废弃 config 的 `agentClass`/`messageManagerClass` 两个字段（不再反射）。engine 只提供 `Agent` 类（无通用 createAgent 工厂），elf 每家 `create_agent.js` 是自己的装配脚本。

**mm 子类定制**：elf-00x 仍可写自己的 `message_manager.js`（继承基类 MessageManager，如 elf-002 的多层 compact）。区别只在**由谁实例化**——不再由基类反射加载 config 的 `messageManagerClass`，而由各自的 `create_agent.js` 显式 `import` + `new` 后传入 `new Agent({messageManager})`。指派权归装配脚本，基类只收已实例化的 mm。

## 四、Harness（机制层，无状态调度器）

Harness **不持状态**（不存 middleware/callbacks）——纯调度函数，每次收 middlewares/callbacks 参数跑。agent-level middleware 和 callbacks 存 agent 自己（`this.agentLevel`/`this.callbacks`），run-level 每次 invoke 传。这样 Harness 定位单一：只调度、不持有，避免"持状态对象 + 无状态调度"的定位模糊。

```js
// shared/agent/harness.js
export class Harness {
  async runInjection(middlewares, point, ...args) { /* 按序跑注入型 hook */ }
  async dispatchGate(middlewares, point, initAcc, ...args) { /* 链式合并门控型 */ }
  emit(callbacks, event, payload) { /* callback fan-out + 异常自吞，收 callbacks 参数 */ }
  abort(agent) { agent._aborted = true; agent._currentAbortController?.abort(); agent.messageManager.abortBackgroundCompact?.(); }  // 收 agent 参数操作其字段，无状态
}
```

middleware/callback 只声明 hook、**不自己调度**；调度在 Harness（agent.js 调 `this.harness.*` 传参，不实现、不持有）。abort 与 dispatchGate/emit 同为机制层控制面，放 Harness（收 agent 参数、无状态，和收 middlewares 参数同一形态）。

## 五、run-level middleware 通道

- `receive(message, { emit, middleware })`：`middleware` = 本次调用 run-level。
- 合并：`[...agentLevel, ...runLevel]`，按序 dispatch，两套都跑。
- 场景 middleware 是 engine prebuilt（RoomMiddleware/PrivateChatMiddleware），任何人注入，agent 不感知。
- 阶段一调用方：start.js 按 mode 注入；阶段二：chat/room 实例注入。

## 六、从 default_agent.js 迁出的清单

| 现状 | 迁去 | 阶段一 | 阶段二 |
|---|---|---|---|
| `_runInjection`/`_dispatchGate`/`_emit` | Harness（无状态） | ✅ | |
| `_loadModuleClass` | utils `load_module_class.js` | ✅ | |
| `fromConfigDir` 装配 | 拆解：解析→utils；装配→elf-00x `create_agent.js` 内部 new Agent | ✅ | |
| `_roomFlushLoop` | RoomMiddleware **重新实现** flushLoop（持 agent 调 reasoning + 自家门控） | ✅ | |
| `fromConfigDir` 内 skillLister/fileChangeDetection 注入 | `create_agent.js` 内显式建 | ✅ | |
| `_ensureSyncSource` + syncSource | PrivateChatMiddleware（新 prebuilt） | ⚠️ 不迁，留 agent.js | ✅ 迁 |
| data 存储 `agents/elf-00x/data` | 实例级 `chat-elf-00x/data` | 不动 | ✅ 迁 |
| shared→engine 目录重命名 | 物理重命名 + import 修 | 不做（内部重组） | ✅ 做 |
| config `agentClass`/`messageManagerClass` 字段 | 废弃（约定 `create_agent.js` 取代反射） | ✅ | |

**RoomMiddleware 重新实现 flushLoop**：现状是循环在基类 `_roomFlushLoop`、RoomMiddleware 经门控参与（room_middleware.js 注释明"循环上提到基类"）。阶段一把循环移回 RoomMiddleware——它本就持 flush 状态（_buffer/_replying/_pendingBuffer）+ constructor 收 agent，room 路径由 RoomMiddleware.preReceive 接管、flush 内调 `this.agent.reasoning` + 自家门控（mergeForReason/postReason）。"插件注入信息处理策略、自行编排循环"是合理的（你定）。迁出后 agent.js receive 只剩 `dispatchGate('preReceive')` hook 点，无 room 特殊处理。

## 七、阶段一（agent 层重组，每步可测、行为零变）

1. **建 Harness（无状态）**：抽 _runInjection/_dispatchGate/_emit + abort 进 Harness（纯调度，不持状态）。agent.js 调 `this.harness.*` 传 middleware/callbacks/agent 参数；agent 的 `abort()` 委托 `this.harness.abort(this)`。443 绿。
2. **constructor 内部接线**：fromConfigDir 的接线（_eventSink 桥接）收进 constructor；harness 在 constructor 内 new。绿。
3. **_loadModuleClass → utils**（`load_module_class.js`）。绿。
4. **_roomFlushLoop 重新实现进 RoomMiddleware**（RoomMiddleware.flushLoop 持 flush 逻辑、调 this.agent.reasoning + 自家门控）。agent.js receive 去 room 特殊处理（按 gate 路由调 rm.flushLoop）。绿。
5. **elf-00x 各写 create_agent.js + buildAgentFromConfig**：elf-001/002/003 三家 `create_agent.js` 导出 `createAgent({runContext,dataDir,model,toolManager})`，内部显式 new mm 子类 + 调 `buildAgentFromConfig`（engine 侧通用装配 helper，收已实例化 mm）完成 model/toolManager/skillLister/fileChangeDetection + new Agent。start.js 改按约定动态 import `agents/<id>/create_agent.js`。**删 fromConfigDir + _loadModuleClass 委托**（不兼容、不留壳）。`agentClass`/`messageManagerClass` 废弃。绿 + 三家装配链冒烟通过。
6. **run-level 通道**：receive/reasoning 收 `options.middleware`，与 agent-level 按序合并（`_mw` getter 读 `_activeMiddleware`，receive/reasoning 开头设、receive finally 清）。`_dispatchGate`/`_runInjection` 用 `_mw`。**阶段一 start.js 的 RoomMiddleware 仍 push 进 agent.middlewares（agent-level，未走 run-level）**——通道就绪，调用方迁 run-level 留阶段二实例层。绿。
7. **文档化定制优先级**（见下）。

**定制优先级**（从轻到重，能早不用晚）：
1. **config.json**：tools/skills/fileChangeDetection/compactMode/memoryTokenLimit 等声明式开关——最轻，零代码。
2. **agent-level middleware**：`create_agent.js` 的 `buildAgentFromConfig({extraMiddleware})` 或直接 `agent.middlewares.push(...)` 挂固有定制中间件（preReason/shouldBreakAfterTools 等 hook）。
3. **mm 子类**：`agents/<id>/message_manager.js` 继承基类 MessageManager，重写 getMessagesForLLM/compactIfNeeded/addToolResult 等（elf-002 多层 compact、elf-001/003 prefix/suffix）。由 `create_agent.js` 显式 import 实例化。
4. **（阶段二）实例层场景注入**：chat/room 实例 invoke 时注 run-level 场景 middleware（PrivateChatMiddleware/RoomMiddleware）。阶段一场景仍 start.js agent-level push。

**阶段一过渡**：mode 仍由 start.js 按进程定。agent 不知场景（new Agent 不收 mode）；RoomMiddleware 阶段一仍 agent-level push（start.js），通道就绪但未走 run-level；私聊阶段一走 _ensureSyncSource 老路径（PrivateChatMiddleware 阶段二补）。run-level 通道机制就绪，阶段二实例层把场景注入迁到 run-level。

**阶段一风险（仅执行风险，非架构回避）**：第 5 步三家 agent 配置各异（elf-002 的 subagents/perToolLimit/budgetWindow/microcompact 要从 config 读进 Elf002MessageManager），改写易漏参数 → 逐家对照 config.json。

## 八、阶段二（实例对称：chat 与 room 同级）

**动机**：现状 chat（私聊）的 data 黏在 agents/elf-00x/，和 agent 定义混；room 已是 gateway 实例。把 chat 升格成与 room 同级的环境实例，agent 定义与运行时 data 彻底分离。这也是"场景策略是环境实例的、非 agent 共享"的落地，顺带解决工具注册污染。

**8.1 chat 实例层**
- gateway 引入 chat 实例（与 room instance 同级）：`chat-elf-00x/` 持私聊 data、注入 PrivateChatMiddleware。
- room 和 chat 都是"环境实例"，invoke 时由实例注入场景 middleware（RoomMiddleware/PrivateChatMiddleware）。
- 私聊路由 /chat（现在直连 agent 进程）改走 chat 实例。

**8.2 data 迁移**
- `agents/elf-00x/data`（context.json/history.jsonl/sync_cursor/checkpoints）→ `chat-elf-00x/data`。
- **自动迁移 + 回退**：新路径无则读老路径，首次启动搬过去，平滑。
- agents/elf-00x/ 只剩定义（config/mm/create_agent.js），无 data。

**8.3 私聊对称化**
- `_ensureSyncSource` 迁 PrivateChatMiddleware（与 RoomMiddleware 对称：room 走 RoomMiddleware.preReceive，私聊走 PrivateChatMiddleware.preReceive）。
- runContext 的 dataDir/port/mode 按 chat/room 实例对称重想（chat 实例 identity = chat-elf-00x，room 副本 identity = roomId/agentId，二者同级）。
- agent.js receive 的 _ensureSyncSource 老路径删除，私聊/群聊统一经 PrivateChatMiddleware/RoomMiddleware。

**8.4 工具注册污染（阶段二顺带解决）**
- 问题：RoomMiddleware run-level 注 Speak 改的是 agent **共享** toolManager，同 agent 多场景/多 invoke 会污染（room invoke 后私聊 invoke 仍带 Speak）。
- 阶段一 mode 进程恒定不触发。
- 正解（阶段二）：实例级 toolManager——chat/room 实例各持独立 toolManager，run-level middleware 注入工具进实例 toolManager，互不污染。和"场景是实例的、非 agent 共享"一致。

**8.5 目录重命名**
- `shared/agent/` → `engine/` 物理重命名 + 修所有 import。
- 作为独立机械步骤（与逻辑重构风险隔离），阶段二或其前置子步骤做。

## 九、阶段二迁移顺序（每步可测、行为零变）

阶段二在**一进程一实例**模型下做 chat/room 对称（不碰多实例——留阶段三）。

1. **建 chat 实例层骨架**：chat 实例 = chat-elf-00x 一个进程（与 room 副本进程对称），data 暂不迁（仍读 agents/老路径）。绿。
2. **data 自动迁移 + 回退**：chat 实例 data 优先读 `chat-elf-00x/data`，回退 `agents/elf-00x/data`，首次搬移；gateway 侧 ChatHistory 路径同迁。绿。
3. **建 PrivateChatMiddleware + 迁 _ensureSyncSource**：私聊 receive 经 PrivateChatMiddleware.preReceive（align/addUser/advance），删 agent.js 老路径；**顺手修 syncPrivateHistory 不存在的 bug**（start.js 调用了 Agent 类上不存在的方法，被吞）。绿。
4. **场景 middleware 注入方换实例**：chat/room 实例 invoke 时注入对应场景 middleware（取代 start.js 进程级 agent.middlewares.push）。绿。
5. **shared→engine 物理重命名** + import 修。绿。
6. runContext dataDir/port/mode 按 chat/room 实例对称重想（chat 实例 identity = chat-elf-00x，room 副本 identity = roomId/agentId，同级）。

> 阶段二**不做**：实例级 toolManager（一进程一实例下无污染、无收益，留阶段三多实例时做）；单进程多实例 routing（留阶段三）。

## 九点五、阶段三目标（单进程多实例，本次不做，仅写明方向）

**终极形态**（用户定）：
- **一个 agent 一个进程**（elf-00x 各一个进程），config/model/systemPrompt 用 agent 自己的（定义层，跨实例共享）。
- **gateway 一个进程** handle 多个 chat 实例 + 多个 room 实例（实例 = 会话/环境的运行单元）。
- **agent 进程同时服务多个实例**：同一 elf-001 进程既对接它的私聊 chat 实例、又对接它参加的各 room 实例。每次对接不同实例时，agent 进程接受**该实例特有的**运行时：插件（run-level middleware）、工具（per-instance toolManager）、上下文（per-instance mm/data）——**config 共享、运行时 per-instance 隔离**。

**与现状/阶段二的差别**：
| | 进程模型 | 实例隔离 |
|---|---|---|
| 现状 | 一进程一实例（私聊1进程、room每成员1进程） | 进程隔离 |
| 阶段二 | 仍一进程一实例，chat/room 对称 + data 分离 + 场景 run-level | 进程隔离 |
| 阶段三 | 一 agent 进程多实例 routing，gateway 统管实例 | 进程内 per-instance 隔离（runContext/mm/toolManager/队列/emit 路由），config 共享 |

**阶段三要做**（阶段二为其预留）：
1. **agent 进程从"单实例服务"改成"多实例容器"**：agent.server.js 从"单 agent HTTP 服务"改成"实例路由层"——请求按 instanceId 分发到对应实例。
2. **per-instance 运行时隔离**：每个实例独立 runContext、mm(data)、syncSource、isProcessing 队列、emit 路由（谁的事件给谁）、**toolManager**（实例级，RoomMiddleware 注 Speak 进实例 toolManager，污染消除）；config/model 跨实例共享。
3. **实例生命周期**：gateway 维护实例→agent 进程的映射，实例创建/销毁经 gateway 调度 agent 进程的实例 API（不再 spawn 新进程，进程内起实例）。
4. **room 副本进程合并**：现状 room 每成员一副本进程→阶段三同 agent 进程内多 room 实例（一个 elf-001 进程跑它参加的所有 room 的实例 + 私聊 chat 实例）。
5. **emit/事件路由 per-instance**：/events、/chat SSE、/observe 按实例路由，不串实例。

**阶段二对阶段三的预留**（阶段二要按此做，免得阶段三推倒重来）：
- chat 实例身份用 `chat-elf-00x`（非裸 agentId）——阶段三多实例时天然 `chat-elf-00x-a`/`-b` 扩展。
- 场景 middleware 走 run-level 通道（阶段一已建 `_mw`）——阶段三每实例 invoke 注入自己的场景 middleware，通道就绪。
- PrivateChatMiddleware/RoomMiddleware 作为 engine prebuilt，实例注入用——阶段三多实例时每实例注自己的。
- 单进程一实例下 toolManager 暂共享（无污染），阶段三引实例级 toolManager 时再隔离。
- runContext identity 模型按实例对称（阶段二做）——阶段三复用。

**阶段三不在本设计稿展开细节**，届时单独出文档。本稿只写明方向 + 阶段二预留点。

## 十、风险与不做（分清阶段一临时 vs 二期要做）

**阶段一执行风险**：
- elf-00x 各写 `create_agent.js` 易漏配置参数 → 逐家对照 config.json。

**阶段一临时回避、阶段二必做**（不是"永远不做"，是"本期不动"）：
- 不迁 _ensureSyncSource → 阶段二 步3 迁 PrivateChatMiddleware。
- 不动 data 存储 → 阶段二 步2 迁 chat-elf-00x/data。
- 不建 chat 实例层 → 阶段二 步1 建。
- 不改目录名 shared→engine → 阶段二 步5。

**阶段一/二都暂不做、阶段三必做**（留阶段三多实例时）：
- 不解工具注册污染（实例级 toolManager）→ 阶段三（一进程一实例下无污染、无收益）。
- 不做单进程多实例 routing → 阶段三（见九点五）。

**不做（永久，架构决策）**：
- engine **不引入通用 createAgent 工厂**（constructor 接线即可，ELF 无 compile-time middleware-带-结构约束）。注意：elf 每家的 `create_agent.js` 是**该 agent 的装配脚本**（每家自己写、不是 engine 通用工厂），二者不冲突。
- 不上 LangGraph 图引擎/checkpoint（reasoning 固定循环、不要 mid-node checkpoint、不要图拓扑可变；取"显式组装 + middleware hook + run-level 注入"语义，不取图框架）。
