# Chat Room 设计(多 Agent 群聊)

## 1. 目标

在 elf gateway 上支持「聊天室」:一个 room 把多个现有 agent(elf-001/elf-002/…)拉进同一个会话,各 agent 看到彼此的发言、自主决定是否回应。

核心约束(用户定义):

- **Room 是纯消息总线,不做调度**:room 只负责把消息同步给成员、把成员的回答广播出去。room 不决定「轮到谁说」「让谁说」。
- **Room 与成员的唯一耦合 = 成员的回答(SSE token 流)**:room 不读成员的 config 语义、不调成员的特化接口、不管成员怎么 compact。只要 agent 被 elf gateway 管理,就能被拉进任意 room。
- **每个 agent 在每个 room 里是独立 session**:各自的 `context.json` / `history.jsonl` 严格独立,不共享、无 checkpoint。
- **Room 自身零对话状态**:room 不 checkpoint,disk 上不存任何对话内容;只存「成员名单」(这是配置,不是 checkpoint)。
- **默认 intuitive 策略可注入**:room 给「自己没有 intuitive 策略」的 agent 默认注入「被 @ 才回答」;agent 自带策略则用自带的。

## 2. 非目标

- room 不做 LLM 调用、不做记忆压缩(room 不是 agent,不发请求)。
- room 不维护跨进程的「全局一致 transcript」——每个成员各自一份独立看到的对话。
- 不引入新的 gateway 层级。Room 走「Virtual-Agent」路线(见下),gateway 零改动即可挂载。

## 3. 整体架构

```
                         ┌─────────────────────────────────────────┐
   Web UI ──SSE──►  Gateway(:8080)  ──► agents/elf-room-001 (Room 进程)
                         │  现有 /agents/:id/* 路由全部复用          │  agentClass="room"
                         │                                          │  无 LLM、无 context
                         │                          spawn 副本      │
                         │                 ┌────────────────────────┼────────────────────────┐
                         │                 ▼                        ▼                        ▼
                         │        agents/elf-001 的副本      agents/elf-002 的副本      ...
                         │        (复用 elf-001 的 config)   (复用 elf-002 的 config)
                         │        --data <room>/data/elf-001  --data <room>/data/elf-002
                         │        --port <动态>                --port <动态>
                         │        RoomMemberAgent 门控          RoomMemberAgent 门控
                         │                 ▲                        ▲
                         └── POST /chat ───┴────────每条群聊消息转发给所有成员副本────────┘
                                          (成员内部 intuitive 判断:被 @ 才 reasoning)
```

要点:

- **Room 进程**被 gateway 当作一个普通 agent 管理(`/agents/:id/start|stop|status|chat|history`),靠 `config.json` 里 `agentClass: "room"` 指定。这样 start/stop/rediscover/config 全部现成可用——即「Room-as-Virtual-Agent、不动 gateway」。
- **成员副本进程**由 Room 进程自己 spawn(detached),**不**进 gateway 的 `/agents` 列表(否则和「disk 目录 = agent」的现有模型冲突)。成员名单写在 Room 的 `config.json`,Room 重启时按名单重建副本。
- **成员副本 = 复用成员自己的 config 目录**(`agents/elf-001/config`),只覆盖 `--data`(指到 room 的 data 子目录)和 `--port`(动态分配)。elf-001 自己的代码、tools、system_prompt 一行不改。

## 4. 数据目录布局

「data 每个 room 一份」成立,目录下按成员分(因为每个成员 × room 的 context/history 严格独立):

```
agents/elf-room-001/
  config/
    config.json          # room 自身配置:type:"room"、members:["elf-001","elf-002"]、port
  data/
    elf-001/
      context.json       # elf-001 在本 room 看到的对话(独立,与它私聊的那份隔离)
      history.jsonl
      member.pid         # 运行态:副本进程 {pid, port} —— 供 cleanup.sh / room 重启用
    elf-002/
      context.json
      history.jsonl
      member.pid
    room.log             # room 进程日志(可选)
```

- 通用性体现:room 不关心 `elf-001` 内部结构,只要 `agents/elf-001/config/config.json` 存在(知道入口 + 可用工具)就能拉副本。任何被 gateway 管理的 agent 都适用。
- 删除成员 = 停掉对应副本进程 + 删除 `data/<member>/` 目录(其 context/history 独立,删了不影响别的成员)。

## 5. 方案 A:成员副本进程

现有 agent 是**彻底单 session**(`server.js` 一个进程一个 `isProcessing`/`MessageManager`/`context.json`;`default_agent.js:82` 把 `dataDir` 写死成 `configDir/..` 即 `agents/elf-001/data`)。所以「同个 elf-001 在多个 room 各开独立 session」走**多副本进程**而非单进程多 session——后者要把 server/MessageManager/history 全 session 化,与「独立一份、无 checkpoint」的简单诉求相悖。

### 5.1 唯一内核改动:放开 `--data` / `--port` 覆盖

现在 `start.js` / `default_agent.js` 把 `dataDir` 写死、`port` 从 config 读。放开成 CLI 覆盖后,「给 room 拉一个 elf-001 副本」退化成通用命令:

```bash
node agents/elf-001/index.js \
  --config agents/elf-001/config \
  --data   agents/elf-room-001/data/elf-001 \
  --port   <freeport>
```

改动点:

- `shared/agent/start.js`:解析 `--data` / `--port` / `--room-mode`(见 §7),透传给 `Agent.fromConfigDir(configDir, {...})`。
- `shared/agent/default_agent.js:82`:`dataDir` 优先用注入值,回退 `configDir/..`。
- `shared/agent/start.js:42`:`port` 优先用注入值。
- `shared/agent/server.js`:`/chat` body 扩展可选 `from`/`mentions`/`role` 元数据(见 §8);保持对旧 `{message:string}` 的兼容,确保现有私聊 agent 不受影响。

> 测试性:这些放开是纯增量(有默认回退),不影响任何现有 agent 行为。现有 `npm test` 套件应全绿。

### 5.2 成员副本的 lifecycle

由 Room 进程负责(参考 §10)。Room 持一张「memberId → {pid, port}」运行态表;副本作为 detached 进程,Room 挂了副本存活(对齐现有 gateway↔agent 关系)。

## 6. Room 进程职责

Room 是个 agentClass=`room` 的特殊 Agent,**不跑 LLM loop**(无 model、无 toolRegistry、无 messageManager、无 compact)。它的 `receive()` 不调用 LLM,而是驱动转发:

```
用户在 room 发一条消息 / 某成员产出发言
 → Room 把消息广播给所有成员副本的 /chat(SSE 拉流)
 → 每个成员副本内部 intuitive 判断:
      被 @（或自带策略命中）→ reasoning → yield token 流
      否则                  → 只静默累积上下文,yield done(无 token)
 → Room 收到一个成员的 token → 标注发言人〔memberId〕扇出给用户
 → Room 将该发言再注入其他成员副本(让它们感知到这条新发言)
```

### 并发模型(对齐 wolf 聊天室阶段,关键决策)

- **外层并行,内层串行**:room 收到一条群聊消息,对所有成员副本**并发** POST `/chat`(**不 await**);每个成员副本**内部串行**——elf 现有 `server.js:30-104` 的请求队列 + `isProcessing` 互斥天然就是 wolf 的"内层串行",复用即可,无需新造并发原语。这正是 wolf `AIManager.onMessage`(`controller.js:184` 不 await)的模型。
- **允许链式/死循环,不设技术界限**:A 发言 → room 再分发 → 被 @ 的成员回应 → 回应又分发 → … 允许 ping-pong。这就是「活跃」的来源。room 不做轮次上限、冷却、max-depth 截断。
- **唯一的兜底 = 自消息过滤**:成员**不会被自己的发言触发**(防最朴素自激),但可被其他成员 @。对齐 wolf(`agent.js:182` 自消息丢弃)。
- **收敛靠 LLM 自身**:技术层不截断循环;靠成员的 intuitive(LLM)在「无需再说」时自然不再 @ 人 / 不再发言。循环是**语义级**的,不是技术级硬截断。

> 可选熔断(默认关闭):纯开放循环有烧 token/永不停止的现实风险。room `config.json` 可配 `circuitBreaker`(off by default):如「连续 N 条发言无人类介入则暂停成员间触发」「单消息链式发言总数软上限」。默认 off 满足「必须允许死循环」;如需开列为二期开放项。

Room 进程需要实现:

- 成员副本的 spawn/stop/探活(复用 `process_manager.js` 的探活/lsof 思路,但副本本地管理,不走 gateway)。
- SSE 扇出:把用户消息 + 各成员发言合成一条流推回 gateway(借 `chat_proxy.js` 的 `StreamContext`/`broadcastChunk` 思路,room 自己实现一份多发言者聚合)。
- 成员发言的「并发再分发」:A 发言后,把 A 的发言当作新消息**并发**喂给所有成员(含 A,A 靠自消息过滤丢弃),触发它们的 intuitive 重新判断。

关键:room 视角下「成员流里有 token → 一条发言;流结束无 token → 该成员沉默」,room 自身不做任何调度判断、不做循环截断。

## 7. 默认 intuitive 策略注入(方案 X:未 @ 也 POST,成员自管 context)

### 7.0 决策:方案 X

成员副本的 context 由**成员副本自己**管理,room 纯转发:

- **未 @ 也 POST**:room 把每条群聊消息(带 `from/mentions`)都转发给所有成员副本;成员副本判断"没 @ 我"→ 只把消息累积进 context、立即 yield done(空转,不 reasoning)。
- **被 @ 才 reasoning**:成员副本判断"@ 我了"→ reasoning 回应。
- **不在 room 端维护积压缓冲**:room 没有任何 per-member 上下文,保持"room 零对话状态"。
- 这是 wolf 的等价模型(逐条 inject 累积,被 @ 才 decision),也是 elf 改动最小的路径。

### 7.1 语义:等 @ → 收集 → 打包 → 一次回复

用户的诉求(关键是排队 + 打包):

- 成员 elf-001 空闲时被 @ → 立即 reasoning 回复。
- 成员 elf-001 **正在 reasoning**(也许花 10 min)期间,群里又来一堆消息(有人 @ 它、有人没 @)。这些消息**不能丢、也不能各自触发 reasoning**(它一次只能回一个)。
- elf-001 当前轮 done 后,这 10 min 内收到的那堆消息要**统一累计进 context,作为一份 user input**,再判断"其中有没有 @ 我":有 → 针对这一整份 input reasoning 一条回复;无 → 只记不回,继续等。
- 还没被 @ 时,一直等;等到被 @ 了,把"上次看到的内容之后到现在能看到的全部内容"打包成一份 input,产生一次回复。

**关键:elf 现成的请求队列已经实现了这个"排队 + 合并 + 等下一次触发"语义**,无需新造队列。

### 7.2 复用 server.js 现有队列(`enqueueRequest` / `processRequest` / `pendingMessage`)

`shared/agent/server.js:30-104` 的机制:

- Agent **正在处理**(`isProcessing=true`)时,新进来的 `/chat` 请求:body.message 用 `\n` 拼接到 `pendingMessage`,res 挂 `pendingResponses`。
- 当前一轮 `processRequest` 跑完(`finally`,line 97-103)→ 把攒下的 `pendingMessage` 作为**一条合并消息**再 `processRequest`。

room 场景映射(elf-001 正在 10min 长回复):

```
elf-001 正在 reasoning(第1轮)
  t1 [B] 你怎么看 @elf-001   → pendingMessage += "\n〔B〕你怎么看 @elf-001"
  t2 [C] 补充一点 @elf-001     → pendingMessage += "\n〔C〕补充一点 @elf-001"
  t3 [D] 在群里说他想退出        → pendingMessage += "\n〔D〕... (没@也攒)"
  ... 以上全是走 /chat 进来,被 enqueueRequest 攒队列
elf-001 第1轮 done
  → pendingMessage = "〔B〕...@elf-001\n〔C〕...@elf-001\n〔D〕..."
  → 作为一条合并 user input 进 processRequest(第2轮)
  → RoomMemberAgent.receive 收到这份"合并 input"
```

**这正是"从上次看到之后到现在所有内容打包成一份 user input"。** 队列复用、不新造。

### 7.3 落地:RoomMemberAgent

引入 `shared/agent/room_member_agent.js`,继承默认 `Agent`。`receive()` 做累积 + 门控;`reasoning` 复用但**跳过它自己的重复 addUserMessage**(详见 §7.4)。

```js
// 伪代码
class RoomMemberAgent extends Agent {
  // selfName = 成员名(name 或 agentId),启动时从 config 注入
  // _selfName 用于 mention 判断 + 自消息过滤

  async *receive(payload) {
    // payload 由 room 经扩展 /chat body 传入。
    // server.js 把 body 整个透传:可能含裸 message(私聊),也可能含 {from, content, mentions, role}
    const isChat = payload?.role === 'chat';
    const text = isChat ? payload.content : payload.message;   // 文本
    const mentions = payload?.mentions || [];                    // 被@的成员名列表
    const from = payload?.from || 'user';

    if (!isChat) {
      // 非群聊(降级为普通私聊):走默认 reasoning
      yield* super.receive(payload.message);
      return;
    }

    // 自消息过滤:自己刚发的发言,room 也会回灌给我,丢弃(防自激,对齐 wolf agent.js:182)
    if (from === this._selfName) {
      yield { event: 'done', data: { usage: {} } };
      return;
    }

    // 1. 累积进 context(无论是否 @ 都记)—— 格式带发言人前缀,合并后仍可读
    const formatted = `〔${from}〕${text}`;   // 〔elf-002〕你怎么看 @elf-001
    this.messageManager.addUserMessage(formatted);

    // 2. 门控:@ 我了吗?
    const mentionedMe = mentions.includes(this._selfName);
    if (!mentionedMe) {
      yield { event: 'done', data: { usage: {} } };   // 静默,只记不回
      return;
    }

    // 3. 被 @:reasoning 回应(context 已在 step1 累积好,reasoning 须跳过重复累积)
    yield* this._reasonAndReply();   // 见 §7.4,复用默认 reasoning 但不 addUserMessage
  }
}
```

> 关于"合并 input 也只产生一条回复":server.js 队列把 10 min 内那堆消息合并成**一条** `pendingMessage`,进 `processRequest` → 单次 `receive` → 单次 reasoning → 单次回复。天然满足"打包成一份 input 产生一次回复"。下一条新消息再触发新一轮队列。

### 7.4 避免 default_agent.reasoning 的双重 addUserMessage(关键坑)

`default_agent.reasoning()`(default_agent.js:247)一开头就 `this.messageManager.addUserMessage(message)`。但 RoomMemberAgent 在 receive step1 **已经累积过**了。若直接 `super.receive → reasoning`,会再追加一条裸 message,导致 context 里出现"单条版 + 合并版"两份,污染。

两种解法:

- **方案 1(推荐)**:RoomMemberAgent 实现 `_reasonAndReply()`,从"已累积好 context"起步,直接走 LLM 请求 + tool loop + done,跳过 reasoning 开头的 addUserMessage。尽量把 reasoning 内的 compact / tool 执行 / done 事件产出抽成可复用的 protected 方法(抽取时保留原行为,默认 agent 不受影响)。
- **方案 2**:给 MessageManager.addUserMessage 加 `skip`/幂等标记,reasoning 支持跳过累积。改动面稍广(动基类签名)。

倾向方案 1:新增子类、不动基类签名,默认 agent 与现有私聊行为完全不变。抽取复用段时对照 default_agent.js:233-478。

### 7.5 注入规则(agent 自带策略覆盖默认)

- `--room-mode` 启动标记下,`start.js` 决定 agentClass:
  - **成员 config 没有 `agentClass`**(策略为空)→ 用 `RoomMemberAgent`(注入默认「被 @ 才回答」)。
  - **成员 config 显式声明 `agentClass`**(成员自己实现 intuitive)→ 用成员自己的类(默认策略被覆盖)。
- 这就是「agent 自己的 intuitive 策略为空则用默认,非空则用自己的」在代码上的落点。成员的自定义 agent 类自行实现 intuitive 门控 + 自消息过滤(room 仍逐条转发 + 传 mentions)。

### 7.6 @ 检测与消息来源

- Room 在转发消息时计算 `mentions = [被@的成员名]`(基于消息文本里 `@<name>` 解析)。
- 成员名取自各成员 `config.json` 的 `name`(回退 `agentId`)。
- 人类消息也算"成员发言":用户发言 `from = "user"`,mentions 解析同样适用(用户 @ 某成员 → 该成员回答)。
- 自消息:成员自己刚发的会回灌给自己,`from === selfName` 时丢弃(§7.3 step1)。

## 8. 消息流转协议

### 8.1 扩展 /chat body(向后兼容)

成员副本的 `/chat` 接受扩展 body:

```jsonc
// 旧(私聊,保持兼容)
{ "message": "你好" }

// 新(room 转发)
{ "content": "你好 @elf-001",  // 群聊文本
  "from": "elf-002",          // 发言者(成员名或 "user")
  "mentions": ["elf-001"],    // 被@的成员名列表
  "role": "chat" }            // 标识群聊消息(role 缺省时退化为普通私聊)
```

> server.js `/chat` 路由把整个 body 透传给 `agent.receive(payload)`。RoomMemberAgent 收到 `payload`:有 `role:"chat"` 走群聊门控(读 `content/mentions/from`);否则降级读 `payload.message` 走私聊。合并队列攒的也是整个 payload/server.js 当前只拼 `message` 字符串——见 §8.4 的必要小改)。

`server.js` 的 `/chat` 路由读取这些字段透传给 `agent.receive()`;只有 `RoomMemberAgent`(及成员自定义类)消费它们,默认 agent 不管(私聊场景没有这些字段)。**现有私聊 agent 零影响。**

### 8.2 Room → 成员转发(并发 + 开放链式)

Room 收到一条新发言(用户或某成员),**并发**对所有成员副本:

1. POST `http://127.0.0.1:<成员副本port>/chat`(并发,不等彼此),body = `{content, from, mentions, role:"chat"}`。
2. 各成员副本拉流是**并行的**;成员副本内部靠自身 `isProcessing` 互斥串行(`server.js`)。同一成员上一轮没答完,新请求进 `pendingMessage` 队列合并(现有 `enqueueRequest`),不丢消息 —— 见 §8.4 合并语义。
3. 某成员流中有 `token` → 这是一条该成员的发言;流结束无 token → 该成员本轮静默(只记不回)。
4. 该成员发言文本完成 → 立即作为**新发言**重新触发 §8.2 全流程(再次并发广播给所有成员,含发言者自己——后者靠自消息过滤丢弃),递归触发其它成员的 intuitive —— **不设深度上限**,允许 A→B→A 链式。
5. 每个 agent 一次 `/chat` 产出**一条**发言(对齐 wolf `_agentLoop`,拿到回复即 return);发言结束后若想再说,需被再次 @/主动判断,触发新的 `/chat`。

### 8.3 Room → 用户扇出

Room 给 gateway 的 SSE 流里,成员发言用发言人标记包裹/token 携带发言人字段,例如:

```
event: token
data: {"speaker": "elf-001", "content": "..."}
```

gateway 的现有事件类型是 `token`(无 speaker)。Room 聚合多发言者时需在 `data` 里追加 `speaker`,前端按发言人区分气泡(前端改动见 §9,不在本设计核心范围)。Room 转发给 gateway 的流仍走标准 `proxyChat` 等价的 SSE 契约,只是 `token.data` 多了 `speaker`。

### 8.4 队列合并语义与 server.js 的必要小改(关键)

elf 现有队列(`server.js:30-104`)在 Agent 忙时,**只把 `req.body.message` 字符串用 `\n` 拼接**进 `pendingMessage`,下一轮作为单一 string 再 `processRequest`。room 场景下两件事要保证:

1. **合并后的 user input 必须保留发言人/被@结构**,否则 RoomMemberAgent 无法判断"合并 input 里有没有 @ 我"。→ 两条路:
   - **(推荐)room 转发的每个 payload,把发言人前缀直接拼进 `content` 文本**(`` `〔${from}〕${text}` ``),合并后仍是"〔B〕…\n〔C〕…"的可读多行文本。mentions 不靠文本解析、而在合并时保留为数组(见下)。这样 server.js 队列**几乎不用改字符串拼接逻辑**(它本来就拼 message)。
   - 但 server.js 现在只拼 `body.message`,而 room 转发用 `body.content`。需让 enqueueRequest 在 `role:"chat"` 时改拼 `content`,并把 `mentions`(各条 mentions 取并集)合并到下一轮 payload。**这是 server.js 的必要小改**(见下)。
2. **合并后触发 reasoning 的门控判断**:RoomMemberAgent 收到合并 payload,mentions 是"这几条里所有被 @ 的成员的并集"。若并集含我 → reasoning;否则只记不回。语义正确:10 min 内任何一条 @ 了我,我都该回。

server.js 必要小改(伪代码,保持私聊兼容):

```js
// enqueueRequest 当前:pawn pendingMessage = req.body.message（字符串拼接）
// 改为:累积结构化 payload
//   idle 时:pendingPayload = req.body; processRequest(req.body)
//   busy 时:
if (pendingPayload === null) {
  pendingPayload = clone(req.body);
} else {
  if (req.body.role === 'chat') {
    // 群聊:合并 content（带发言人前缀,可读）+ mentions 取并集
    pendingPayload.content = pendingPayload.content + '\n' + `〔${req.body.from}〕${req.body.content}`;
    pendingPayload.mentions = union(pendingPayload.mentions || [], req.body.mentions || []);
    // from 不再有意义（多发言人），保留第一个或置 'multi'
  } else {
    // 私聊:沿用旧字符串拼接（保持兼容）
    pendingPayload.message = (pendingPayload.message || '') + '\n' + req.body.message;
  }
}
pendingResponses.push(res);
```

> 关键性质:**同一成员在任意长 reasoning 期间收到的所有群聊消息,最终合并成一份 payload、一次 receive、一次 reasoning、一条回复**。完美匹配用户的"10 min 内一大堆消息和 at 打包成一份 input 再回复"。未被 @ 的消息也被合并进这份 input 的 content(只记不回的语义靠 mentions 不含我来体现)。
>
> 不丢消息:队列攒的是结构化 payload,无上限;Agent 慢只是延后处理,不会丢。

## 9. history.jsonl 落盘(member × room 独立)

现状:`gateway/chat_history.js` 按 `agentId` 维度落盘,room 场景下 gateway 默认只认 room 一个 id → 记不到成员级。

方案:history 下沉到**成员副本进程自己的 context/history**,而非 gateway:

- `agentId`/`name` 在 chat_proxy 里携带 speaker;room 不存历史。
- 每个成员副本把自己的发言写入 `data/<member>/history.jsonl`(自身 context.json 已有 messages,history.jsonl 作为 append-only 日志,与私聊 agent 行为一致)。
- 用户视角的 room 历史由前端聚合各成员 history(或由 room 提供一个 `GET /agents/<room-id>/history` 聚合接口,遍历 `data/<member>/history.jsonl` 合并按时间序)。

待定项:聚合接口放 room 还是 gateway。倾向 room 进程提供 `GET /history` 聚合(它持有成员名单),gateway 透传。详见 §12。

## 10. Room 生命周期与成员管理

- **创建 room**:在 `agents/` 下建 `elf-room-xxx/`,写 `config/config.json`(`type:"room"`、`members`、`port`),灰尘目录 `data/`。`POST /agents/rediscover` 自动发现(现有机制)。
- **启动 room**:`POST /agents/<room-id>/start`。Room 进程拉起后扫描 `members`,为每个成员 spawn 副本(`--config members/<id>/config --data data/<id> --port <动态> --room-mode`),写 `data/<id>/member.pid`。
- **添加成员**:改 room `config.json` 的 `members`(或新增 `POST /agents/<room-id>/members` 接口),room 热检测 → spawn 新成员副本。
- **删除成员**:停副本进程 + 删 `data/<member>/`。其 context/history 独立,不影响其它成员。
- **停止 room**:Room 先逐个 `/shutdown` 成员副本,再自己退出。detached 副本若残留,gateway/cleanup 兜底。
- **重启 room**:Room 按 `members` + `member.pid` 重拉副本(`data/<member>/` 持久,副本 reload 即恢复 session——符合「无 checkpoint 但 data 独立持久」)。

## 11. cleanup.sh 更新

**问题**:`scripts/cleanup.sh` 现在只扫 `agents/*/config/config.json` 的 port + `gateway.json`。room 成员副本是动态端口、复用成员 config(不在任何 config.json 里),cleanup **扫不到** → 漏清,端口残留。

### 更新方案(推荐 pidfile 驱动)

成员副本进程启动时写 `data/<member>/member.pid`(`{pid, port}`)。cleanup.sh 增加:

```bash
# 3. 扫描 room 成员副本端口(动态端口,从 pidfile 读)
for pidfile in "$AGENTS_DIR"/*/data/*/member.pid; do
  [ -f "$pidfile" ] || continue
  PORT=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$pidfile" | grep -o '[0-9]*$' | head -1)
  [ -n "$PORT" ] && PORTS="$PORTS $PORT"
done
```

- 优点:静态可发现、和副本生命周期一致(副本退出时 room 删 pidfile)。
- 兜底:cleanup 保留 lsof 按端口清理(现有逻辑),pidfile 漏写时仍能按成员副本端口残留清掉(pidfile 主要是把动态端口「暴露」给 cleanup,pid 清理用现有 lsof)。

### 备选(不推荐,列出权衡)

- 扩展 cleanup 扫 `agents/*/config/config.json` 里 `type:"room"` 的 room,再连接 room 的 `GET /members` 拿成员副本端口 → 依赖 room 进程在线,room 已挂时清不掉。
- 用进程命令行匹配(`node ... --room-mode`)→ 跨平台/可靠性别差。pidfile 更稳。

## 12. 改动清单

内核(必须):

- `shared/agent/start.js` — 解析 `--data` / `--port` / `--room-mode` 并透传。
- `shared/agent/default_agent.js` — `dataDir`/`port` 支持注入覆盖(回退默认)。
- `shared/agent/server.js` — `/chat` body 解析 + 透传给 `receive`(payload 整体);**关键小改**:`enqueueRequest` 的 `pendingMessage` 由纯字符串拼接升级为结构化 payload 合并(群聊合并 `content` + mentions 并集,私聊保持旧字符串拼接)——见 §8.4。向后兼容。
- `shared/agent/room_member_agent.js`(新) — `RoomMemberAgent`,默认 intuitive 门控 + 累积上下文。

Room 进程:

- `shared/agent/room_agent.js`(新,agentClass=`room`) — 成员副本 spawn/stop、消息转发、SSE 聚合扇出、成员再分发。
- 可选 `room_server.js` 或复用 `server.js`,提供 `GET /members`、`GET /history`(聚合)。

Gateway(尽量不动):

- room 经现有 `process_manager`/`chat_proxy` 挂载,零改动。若做成员管理 UI 需 `gateway/server.js` 加 `POST /agents/:id/members` 透传,可二期。

前端(二期):

- room 聊天区按 `speaker` 分气泡/头像;sidebar 选 room;成员增删 UI。

脚本:

- `scripts/cleanup.sh` — 扫 `agents/*/data/*/member.pid` 动态端口(§11)。

## 13. 已定决策 & 待定项

### 已定(本轮拍板)

- **并行**:room 外层并发触发所有成员副本(不 await),成员副本内部串行(server.js 现有互斥)。对齐 wolf `onMessage` 模型。
- **死循环允许**:不限递归深度、不设轮次上限、不设冷却。唯一兜底是自消息过滤(不被自己触发)。循环靠 LLM 语义收敛,不靠技术硬截断。「必须允许死循环、必须并行」= 活跃性的硬要求。

### 待定项

1. **可选熔断 `circuitBreaker`**(§6,默认 off):纯开放循环的烧 token / 永停兜底。默认不开;二期评估是否需要「连续 N 条无人类介入则暂停」之类软限。
2. **history 聚合接口**放 room 还是 gateway(§9),待定。
3. **`@ 检测`** 是否支持中文/别名/多个名,规则待定。
4. **room 副本端口分配**策略:顺序扫空闲口 vs 记录上次端口。倾向顺序扫 + pidfile 记录(配合 cleanup §11)。

## 附:与 wolf 实现的差异对照

| 维度 | wolf | elf(本设计) |
|------|------|------|
| intuitive 决策位置 | `Agent.derive()` switch 硬编码 | `RoomMemberAgent.receive()` 可注入、可被成员自带覆盖 |
| 上下文切片 | 逐条 inject 累积 + compact(无水位线) | 同(逐条累积 + 现有 compact),无显式切片 |
| agent 隔离 | 单进程内对象,无隔离 | 独立副本进程,`data/<member>/` 目录级隔离 |
| 「默认策略」机制 | 无(行为写死) | 有(--room-mode 下 agentClass 为空则套 RoomMemberAgent) |
| 调度 | controller 遍历广播 | room 纯转发,成员自带 intuitive 决定回不回;room 不调度 |