# "万物皆 Room" 架构愿景

> 版本：v0.2
> 日期：2026-07-19（v0.1 → v0.2 整合 RoomAgent 插件化目标）

---

## 核心理念

**万物皆 Room，Agent is Class，Room is Plugin，Gateway is Host。**

- **Room 是第一公民**：Room 是系统的基本坐标。所有消息、历史、事件、成员关系都以 Room 为维度组织。
- **Agent 是类，不是进程**：一个 Agent Class（如 elf-001）可以在不同 Room 里创建多个独立实例，各自有隔离的上下文、历史和工作空间。
- **Room 是插件，不是子类**：Agent 进入 Room 不应靠继承重写一个全新的 Agent，而是给基础 Agent 装上一些 Room 行为插件。基类 Agent 的核心推理引擎保持不变，Room 只修饰它的消息调度与输出渠道。
- **Gateway 是 Room 集合的载体**：统一管理 Room 生命周期、消息路由和 Agent 实例化。
- **私聊即 2 人 Room**：用户和 Agent 的一对一对话也是一个 Room，私聊和群聊不再有本质区别。

---

## 当前问题

1. **身份分裂**：Agent 通过 `runContext.mode` 在"私聊模式"和"群聊模式"之间切换，同一个代码要理解两套语义。`mode` 判断散落在各处，是持续的技术债务。

2. **历史分裂**：私聊用 `chat_history`（按 agentId），群聊用 `group-history`（按 roomId），两套存储、两套 API、无法统一检索。

3. **入口分裂**：用户发言走 `/chat`，群发言走 `/say`，Agent 发言走 `Speak→/say`，Agent 收消息走 `/observe`——本质都是"消息从 A 到 B"，却走了两套互不共享的数据流（私聊 SSE 透传 vs 群聊广播+observe）。

4. **Agent = 进程**：一个 Agent ID 绑定一个常驻进程，无法天然支持同一 Agent 同时存在于多个 Room。

5. **Room 行为靠继承而非插件**：当前 `RoomAgent` 作为 `Agent` 的子类，几乎整段覆盖了 `receive()`。这把"消息调度策略"（何时触发 reasoning）和"核心推理引擎"（LLM 循环、工具调度、压缩）耦合在了一起：
   - RoomAgent 与基类的真正差异只有两点：① 消息累积到 buffer、被 @ 才 flush（而非来一条处理一条）；② 输出走 Speak 工具（而非 SSE 流式回前端）。
   - 但这两点本质是「调度策略」和「输出渠道」的修饰，`reasoning()` 内部的 LLM 循环一行都不用改。用子类重载整个 `receive()` 是把修饰层和引擎层焊死，既不可复用也堵死了「同一 Agent 在不同 Room 有不同行为」的扩展口。

---

## 目标状态

### 统一后的世界

- **只有一个历史系统**：所有消息（无论私聊还是群聊）都以 `RoomMessage` 格式存在 `RoomHistory` 中，按 `roomId` 组织。

- **只有一个消息入口语义**：用户通过 `say` 发言，Agent 通过 `Speak` 工具发言，Agent 通过 `observe` 接收消息。格式统一，结构统一。私聊与群聊走同一套数据流（写历史 → 广播 SSE → 推 observe），不再有"私聊 SSE 透传 vs 群聊广播"两套并行实现。

- **Agent 按 Room 实例化**：同一个 Agent Class 在不同 Room 中有独立实例，各自有独立的上下文、历史和生命周期。Agent 的身份由"它属于哪个 Room"来定义。

- **Room 行为是插件而非子类**：基础 Agent 类不感知 Room；进入 Room 时给它派生一个带 Room 插件的实例。`RoomAgent` 不再作为独立子类重载 `receive()`，而是退化为「Room 行为插件集」，挂在基类暴露的 hook 上。

- **Gateway 成为一切的中心枢纽**：管理 Room 的创建/解散/成员变更、Agent 实例的 spawn/stop、消息的路由与持久化、事件的广播。

- **前端视角统一**：用户看到的不再是"私聊"和"群聊"两个产品，而是一个 Room 列表。每个 Room 有成员列表和共享历史。

### 核心推理引擎与 Room 插件的边界

这是本次（v0.2）新增的重点。目标是把 `reasoning()` 这个核心循环从 Room 修饰逻辑里剥离出来：

```
Agent.receive(payload)                      ← 基类，唯一实现
  │
  ├─ preReceive(payload) → {shouldBuffer, ...}   ← hook：Room 插件决定"先累积还是直接推理"
  │     私聊：shouldBuffer=false，直接进 reasoning
  │     Room 插件：push 到 buffer，被 @ 时才触发 flush
  │
  ├─ [shouldBuffer=true] 等待 flush 触发器
  │     Room 插件：监听 mention，被 @ 时触发 flush
  │
  └─ [shouldBuffer=false 或 flush 触发]
       addUserMessage(merged)
       reasoning()                          ← 基类，一行不改：LLM 循环 + 工具调度 + 压缩 + abort
         ├─ 注册了 Speak 工具 → 走 Speak（→ /say）
         └─ 未注册 Speak → 流式输出回前端
```

- 基类 `reasoning()` 内部的 LLM 循环、工具执行、记忆压缩、abort/stop 一律不动。
- Room 的全部差异收敛到两件事：**消息调度策略**（buffer + mention flush）与**输出渠道**（Speak 工具）。这两件都通过 hook + 工具注册表达，不需要重写 `receive()`。
- Speak 工具已是插件形态（`config.json` 的 tools 条目 + `runContext` 注入身份），证明"工具按需注册"机制已存在，只需把 buffer/mention 调度也提到同等高度的 hook。

### Room 插件所需的 hook 清单

以当前 `RoomAgent` 的行为反推，基类 Agent 需要暴露以下 hook（按触发时机分组）：

| hook | 触发时机 | Room 插件填什么 | 私聊默认 |
|---|---|---|---|
| `onDispatch(ctx)` | 进 Room 一次 | 注册 Speak、注入身份（roomBusUrl/memberName/roomId）、前缀群聊 prompt、init cursor | no-op |
| `preReceive(payload)` | 每条消息 | 自消息 `drop` / 累积 `buffer` / 解析前缀+mentions | `process`（立即推理） |
| `shouldFlush()` | buffer 入队后 | mention 命中才 flush | 不进入此路径 |
| `mergeForReason()` | flush 时 | `_buffer.join('\n')` | 单条 message |
| `preReason()` | 每轮 LLM 前 | `_refreshRoster()`、seq 对齐/补空洞 | seq 对齐（基类已有） |
| `postReason()` | 每轮 LLM 后 | drain `_pendingBuffer`，仍 mention 则再 flush 一轮 | no-op |
| `onAssistantContent(content)` | LLM 吐纯文本、未调工具 | Speak 门控：第1次注入提醒→第2次放弃 | content 即回复，break |
| `shouldBreakAfterTools(toolCalls)` | 一批工具执行后 | 含 Speak 则 break（发完言本轮结束） | continue（循环到纯文本） |

要点：

1. **8 个 hook 覆盖 RoomAgent 的全部行为**，且 `reasoning()` 内 LLM 调用、工具执行、压缩、abort 等核心循环一律不动。
2. **真正 Room 专属的只有 6 个**；`preReceive` 的 process 路径、`preReason` 的 seq 对齐私聊也用，只是默认实现不同——属于"通用调度能力"。
3. **Speak 工具本身不算 hook**，它已是 tools 条目，靠 `runContext` 拿身份；room 插件只需在 `onDispatch` 把它注册进去。
4. **最小可行子集**：先做 `preReceive`（buffer/drop/process）+ `onAssistantContent`（Speak 门控）+ `shouldBreakAfterTools`（Speak 后 break）三个，即可把 RoomAgent 覆盖 `receive()` 的部分还原成插件；其余 hook 随需求逐步加。

### 三个角色的关系

```
Agent Class（模板：代码、配置、工具）
    │ 实例化 + 装载 Room 插件
    ▼
Agent Instance（运行时：核心引擎不变 + Room 行为插件 + 独立上下文/历史/工作空间）
    │ belongs to
    ▼
Room（上下文：成员、历史、事件广播）
    │ managed by
    ▼
Gateway（载体：生命周期、路由、实例化工厂）
```

---

## 架构原则

1. **Room 优先**：新功能以 Room 为第一视角设计，而非 Agent。
2. **实例隔离**：同一 Agent Class 的不同实例完全隔离，不共享任何运行时状态。
3. **引擎与修饰分离**：核心推理引擎（`reasoning` 循环）保持唯一且稳定；Room 行为（调度、输出渠道）通过 hook + 插件表达，不用子类重载引擎。新增一个 Room 行为 = 写插件，不是写一个新 Agent。
4. **渐进演进**：不推翻重来，通过分阶段迁移逐步收敛到目标状态。
5. **对标 CC**：一个 Room 一个会话，一个 Agent Class 一个可执行程序，实例 = workspace + context + 进程。