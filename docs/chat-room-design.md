# 群聊系统设计(Agent 群聊)

> 状态:设计阶段。
> **当前里程碑:先做「实例化改造」(§11),这是群聊的地基,也是其它一切的前提。改造完再 review 连带简化与 bug 修复(§12)。暂不改代码,文档先行。**
> v1(已废弃,基于"借 gateway 透传流")见 `archieve/chat-room-design-v1-deprecated.md`。

## 0. 核心隐喻:微信式群聊

群聊 = 微信群。agent 是群成员,不是工具。

- 旁边是私聊(你跟 elf-001 一对一,现有 elf 体验不变),群里是多 agent 群聊。
- 群聊在 UI 里和私聊混排(像微信),不再是"选 agent"而是"选会话"。
- 群的"配置页"语义替换成**群管理页**:加谁退群、成员列表。同一抽屉组件按会话类型切换内容。
- 成员就是 `agents/` 下现存的 agent 目录(elf-001/elf-002…),不另造新 agent。

## 1. 根本认知:两种 agent「模型」,不能混用 gateway 透传

现有 elf gateway 整套设计建立在「agent 是用户的**透明工具**」假设上:流式逐字透传、工具调用全程可见、history/snapshot/rewind。

群聊的假设完全相反:agent 是**不透明人格**,有内心活动、自主选择说不说。两者 diff:

| 维度 | 现有 elf(工具型) | 群聊(人格型) |
|------|------------------|---------------|
| agent 内心 | 全透明 | 不可见 |
| token 流 | 流式透传打字 | 不进群聊 |
| 工具调用状态 | 全程可见(徽章/diff/status) | 不可见 |
| 发言出口 | reasoning 的 stream 本身 | 一个显式工具 `Speak` |
| 发言形态 | 流式逐字 | 一整块 |
| 触发 | 用户问→agent 答 | 群消息→agent 自主决定 Speak 与否 |
| agent 间 | 无 | 多对多自主 |

**结论**:不能把群聊硬塞进现有 gateway 的 chat 路由(被 snapshot/history/流式透传拦截,只能靠一堆 `if room-mode` 打补丁,丑且脆)。群聊需要新的交互通道,但**复用 shared 内核 + agent 目录 + UI 外壳**。

## 2. 核心机制:Speak-as-a-Tool

群聊 agent 的关键 —— 把"发言"从 agent loop 的 stream 出口,**挪成一个显式工具调用**:

- agent 的 reasoning 仍是经典 loop(LLM→tool→LLM→…),**内核完全复用** `shared/agent/`。
- agent 有一堆**内心工具**(思考/检索/读历史/subagent/skills…),不外露,只在 debug 面板可选。
- agent 有一个 `Speak({message})` 工具 —— **唯一对外出口**:
  - 调用 → `message` 整块进群聊,被所有人和 agent 看见。
  - 不调 → agent 沉默。
- LLM 的直接 content(非 tool_call)= 内心独白,**不进群聊**。

这一举解决全部诉求:
- 内心活动/其他工具不可见(只有 Speak 出口可见)。
- 主动选择发不发言(agent 自己决定调不调 Speak)。
- 整块、非流式(工具实参即完整字符串,一次性提交)。
- 可见性规则统一(只有一个出口)。

> 对齐 wolf:wolf 的 `ACTION.CHAT` decision 经 callback(`chatBroadcastFn`)进群聊,不是流式透传。elf 照搬这个语义,区别是 elf 用工具调用形式(更贴合 elf 现有 tool registry 架构)。

## 3. 入群 = "装备化"(Speak + intuitive 插件)

### 3.1 语义

- **入群** = 起一个复用该 agent `config` 的**副本进程**,在工具表里多注册一个 `Speak`、在 `receive` 外层套一层 intuitive 门控。这个"装备"是 `--room-mode` 启动时**动态加的运行时配置**,不改 agent 目录里任何文件。
- **退群** = 杀副本进程。agent 的私聊进程 + config 文件原封不动。
- **同一个 agent 在每个 room 里是独立副本**:独立进程、独立端口、独立 session(context/history),与它的私聊进程严格隔离。

### 3.2 装备包内容

入群自动获得:

1. **Speak 工具**:见 §2。唯一发言出口,整块提交。
2. **默认 intuitive 策略**:"被 @ 才回"。agent 没有自己的 intuitive 策略时套这个默认;agent 自带策略则用自带的(默认被覆盖)。
3. **群聊上下文累积**:agent 逐条"看到"群消息(进自己的 context),被 @ 才 Speak。

### 3.3 副本进程的身份与隔离

参照(已核实代码):

| | agent 自己(私聊) | 群聊副本 |
|---|---|---|
| 入口 | `agents/elf-001/index.js` | **同** `agents/elf-001/index.js`(复用) |
| 端口 | config.json 写死(8081/8082) | **动态新端口**,与自身不同 |
| config 目录 | `agents/elf-001/config` | **复用同一份** |
| data 目录 | `agents/elf-001/data`(私聊记忆) | `agents/<room>/data/elf-001/`(群聊独立) |
| 生命周期 | gateway 管 | room 管(待 §7 定形态) |

- 复用 config:agent 人设(el-f002 的 system_prompt "Coding Agent"、tools、api_key)不因进群而变 —— 进群只换"在哪说",不换"是谁"。
- 端口/data 分开:私聊进程和群聊副本是两个进程、两个端口、两份记忆,互不干扰。私聊里说的话群聊副本看不到,反过来也是。

### 3.4 兼容成员自定义类(关键工程点)

⚠️ elf-001/002 **不是裸默认 agent**:
- elf-001 `messageManagerClass: "message_manager"`(带 prefix/suffix 注入)。
- elf-002 还带 `subagents` + `skills` + `Agent` 工具。

所以"装备化"**不能简单换 agentClass**(会丢成员的 MessageManager 子类/subagents)。正确做法(参照 `shared/agent/tools/Agent.js:64` 用 `Object.getPrototypeOf(parentAgent.messageManager).constructor` 拿父类的模式):

- 群聊副本在**进程启动时**(`--room-mode`)拦截:保留成员自定义 agent 类 + 成员自定义 MessageManager 类,把 Speak 工具和 intuitive 门控**包装**在原有 `receive` 之外,而非替换。
- 即:不是"agentClass 为空→套默认",而是"任何 agent 进群→在它原有行为外层加 Speak + 门控"。

## 4. 默认 intuitive 策略:"被 @ 才回"

### 4.1 语义(对齐 wolf)

- **被 @ 才 Speak**:成员收到群消息,只有当消息 @ 了自己才触发 reasoning;否则只把消息累积进自己的 context,不 Speak。
- **上下文 = 上次自己说过话到现在被 @ 之间所有内容**:wolf 用"逐条 inject 累积 + 每次 decision 前 flush + 发言后 compact"等价实现(非显式切片)。elf 套用:副本逐条累积群消息,被 @ 时 reasoning,context 顶端天然是近期群聊(超阈值靠现有 `compactIfNeeded` 压)。语义吻合。

### 4.2 队列 + 打包(复用elf 现成队列)

用户诉求:某 agent reasoning 期间(可能 10min),群里又堆一堆消息(有人 @ 它、有人没 @),这些**不能各触发一次 reasoning**,要在 agent 当前轮结束后**打包成一份 input** 再回应;还没被 @ 就一直等。

elf 现成的请求队列(`shared/agent/server.js:30-104` 的 `enqueueRequest`/`pendingMessage`/`isProcessing`)已实现这个语义:
- agent 忙时新消息攒 `pendingMessage`,空闲后合并成一条再处理。
- 同一成员任意长 reasoning 期间收到的所有群消息,最终合并成一份、一次 reasoning、一条 Speak 回复。
- 未被 @ 也 POST 进来累积,等下次被 @ 统一打包回应。
- 不丢消息(队列无上限)。

必要小改:队列从"拼字符串"升级成"拼结构化 payload"(保留发言人前缀 + mentions 并集),保持私聊兼容。

### 4.3 注入规则

- `--room-mode` 启动时,套默认 intuitive(被@才回)+ 自消息过滤(不被自己发言触发)。
- 成员自带 intuitive 策略 → 用自带的,默认被覆盖。

## 5. 并发与活跃度:必须并行、必须允许死循环

(已与用户拍板,硬要求)

- **外层并行**:room 收到消息并发 POST 给所有成员副本(不 await)。对齐 wolf `AIManager.onMessage`(`controller.js:184` 不 await)。
- **内层串行**:成员副本内部靠 elf 现有 `isProcessing` 互斥串行(复用,无需新造并发原语)。
- **允许死循环**:A Speak→room 再分发→被 @ 的成员回应→又分发→… 允许 ping-pong,**不限深度、不设冷却、不设轮次上限**。这就是"活跃"的来源。
- **唯一兜底**:自消息过滤(成员不被自己的发言触发)。对齐 wolf `agent.js:182`。
- **收敛靠 LLM**:技术层不截断,靠成员 intuitive(LLM)在"无需再说"时自然不再 Speak。

> 可选熔断 `circuitBreaker`(默认 off):纯开放循环有烧 token/永停风险,留二期软限开关,默认不开满足"必须允许死循环"。

## 6. 共享与新建边界

### 6.1 复用(几乎不动)

- `shared/agent/` 整层内核:LLM model/mock、config_loader、ToolRegistry、MessageManager、compact、agent loop 主体、subagents、skills。
- agent 目录:`agents/elf-001`、`agents/elf-002`(config + data 原样),副本复用。
- 前端 UI 外壳:React + Vite 骨架、agent 目录树、配置抽屉组件。

### 6.2 新建(群聊专属)

- `Speak` 工具(唯一发言出口,整块)。
- 群聊 agent 包装层:intuitive 门控 + 自消息过滤 + Speak 注册(§3.4)。
- Room message bus:成员副本 spawn/stop、并发转发、广播、群聊历史。
- 群聊 UI 渲染层:多发言人气泡(头像/名字)、整块消息(无逐字)、群管理页(加人退人)、@提及。

### 6.3 不动

- 现有 elf gateway 的透明透传路由(`/agents/*` chat/history/snapshot/rewind/config-ui)。
- 现有工具型 UI(私聊 agent 的流式打字、工具徽章、diff、配置抽屉)。
- 即:你跟 elf-001/002 一对一那套原样保留。

## 7. gateway 形态 + agent-room 交互协议(已定)

### 7.1 形态:同进程加 `/rooms/*` 路由(方案 ②)

一个 elf gateway 进程、一个端口:
- `/agents/*` 仍是现有透明透传(私聊那套,流式/snapshot/history.jsonl/rewind 原样保留)。
- `/rooms/*` 新加群聊总线,与 `/agents/*` 平行不交叉。
- 前端私聊 + 群聊混排(像微信),一个前端连接。
- 共享 `process_manager`(进程池)和 process_manager 的探活/lsof 能力;配置抽屉组件按会话类型切换内容(私聊=配置页,群聊=群管理页)。

理由:群聊需要 agent 能直连一个 room message bus(见 §7.2)。同进程下 agent 直连 `127.0.0.1:<elfport>/rooms/:rid/...`,对 agent 而言只是 URL 不同,实现等价于独立进程;但避免了双进程起停、双端口、前端切连接的负担,且最贴合微信一体诉求。

### 7.2 agent ↔ room 交互协议(群聊模式,`--room-mode`)

现状 agent 是纯被动 HTTP 服务(7 端点,无主动 push),核心 `POST /chat` 是请求-响应 + SSE 流。群聊把这套假设全打破:agent 要能**主动**发言、发言整块非流、外部只看 Speak 一个出口。群聊模式**给 agent 换一套交互协议**,复用内核、不改私聊老路径(`/chat` 那条对私聊 agent 完全不动)。

入方向 —— room → agent(替代 `/chat` 的群聊版):

```
POST /observe { from, content, mentions }
  语义:一条群消息。agent 永远收下、累积进 context。
        被 @ → reason 一轮;没被 @ → 立即 ack(不 reason)。
  返回:普通 JSON ack(非 SSE 流)——群聊不流式。
  队列:复用现有 isProcessing/pendingMessage(server.js:30-104),
        忙时攒、空了合并打包成一份再触发(见 §4.2);
        仅小改:拼字符串 → 拼结构化 payload(带 from 前缀 + mentions 并集)。
```

出方向 —— agent 主动通知 room(唯一发言出口):

```
agent 调 Speak 工具 → 工具 execute 内部 fetch:
  POST /rooms/:rid/member-said { member, content }
  语义:整块 content 进群聊,room 广播全群 + 落群聊历史。
  agent 内核、loop、toolRegistry、compact 全部复用;
  token/tool_call/compact 等内部事件在 group 模式不外 yield(内心活动隔离)。
```

控制方向 —— room → agent(复用现状):

```
/abort /shutdown /clear 原样复用(HTTP,room_bus 直连 agent 副本端口)。
/clear 语义=成员在本群的记忆清空(只清 data/<member>/context,不影响私聊)。
```

### 7.3 进程模型:副本 detached 常驻 + room_bus 保活

关键区分(别混淆):
- **gateway(含 room_bus)是同一进程**(方案②,共享 listen,一个端口)。
- **agent 进程(私聊 + 副本)都是独立 detached 进程**(`process_manager.js:240` `detached:true`+`unref()`),gateway 关了它们还在。

副本进程模型对齐私聊 agent,**常驻、不看前端 UI 是否打开**:

- **建群/加成员**时 room_bus 就 spawn 各成员副本(detached 常驻),不等前端打开群聊 UI。原因:群聊是自发多对多,你没看 UI 时 agent 可能还在互 @ 聊(死循环允许);副本若只在"UI 打开"时存在,关了 UI 群聊就停了,不成立。
- 你打开群聊 UI(`POST /rooms/:rid/subscribe`)只是前端连上看流,不影响副本进程存亡。
- gateway/room_bus 重启后:`index.js:30` 那样的探活逻辑延伸——room_bus 扫 `rooms/<rid>/data/*/run.json`,按 port 探活:活的接管,死的重拉。

### 7.4 room_bus 保活职责(拉起 / 失败离线)

room bus 对群内每个成员副本"保证拉起状态",但**不是每次群聊操作都遍历探活**(那会给发言路径加串行酒吧,破坏并行流畅性)。保活分两类时机:

**A. 必巡检时机(主动遍历成员、确保拉起)**

1. **建群** —— 拉起所有初始成员。
2. **加成员** —— 拉起新成员。
3. **前端点开群聊**(`POST /rooms/:rid/subscribe`) —— 巡检该群全部成员,确保用户进去能看到活的群。**非阻塞**:subscribe 立即返回群历史(即使个别成员还在拉起),保活在后台并行跑,成员上线后前端 SSE 推"成员状态变更"事件刷新头像。进群体验快,断线重连不卡。
4. **room_bus/gateway 重启后** —— 扫所有 `rooms/<rid>/data/*/run.json`,按 port 探活:活的接管,死的重拉(对齐 `index.js:30` 现有 gateway 启动探活幸存 agent 的逻辑)。

**B. 反馈式感知(不主动遍历,靠信号)**

- **POST /observe 连接失败** → 该成员判离线/重拉;不阻塞其它成员的并发 observe。
- **周期性轻量健康检查**(可选,低频,兜底)。

**反复拉起失败 → 前端标离线**:连续 N 次拉起失败(或端口长时不可达)→ room_bus 标该成员 `offline`,前端群里该成员头像灰显/标"离线",不再向它 observe,其它成员照常。失败原因记 room 日志。
- 拉起幂等:副本已在跑则跳过(对齐 `probeAgent` 先探活再 spawn,process_manager.js:204)。
- 拉起失败上报对齐 `startAgent`(process_manager.js:271 throw statusCode 500)。

> **群内发言(SEND/member-said 回灌)不背保活负担** —— 它只管并发 `POST /observe` 给所有成员端口,谁连不上 room_bus 事后处理(反馈式 B),不阻塞发言流程。这贴合 §5"并行 + 允许死循环"。
>
> 保活是 room_bus 进程内职责(方案②下 room_bus = gateway 进程内模块)。gateway 自身重启后 room_bus 靠 run.json 重新接管所有群副本。

### 7.5 群聊操作:清空全部聊天记录 + agent 记忆;不支持 rewind

支持的群聊操作:

- **清空聊天记录**(群级):删 `rooms/<rid>/group-history.jsonl` 内容,前端群聊界面清空。
- **清空 agent 记忆**(每成员实例级):对每个成员副本调 `/clear`(现有端点,`server.js:181` → `messageManager.clear()` + 重置 skill 状态)。语义=该成员在本群的 context 归零,不影响其私聊记忆。
- 群聊操作常提供"一键清空全部"(记录 + 所有成员记忆):记录清群级 jsonl + 对每个副本 `/clear`。

**不支持 rewind**(群聊明确不加):
- 现 rewind 是 gateway 的 snapshot/rewind(`snapshot.js`),打 checkpoint、整份覆盖 data/。群聊走 `/observe` 新路径,不打 snapshot。
- 群聊语义上也不该 rewind:群消息是多人共见的客观流,单成员回退会造成成员间 context 不一致、各自视角错位。群聊只支持"清空重来",不支持"回到某点"。
- 相关端点(`/rooms/:rid/rewind`、checkpoints)**不提供**。

### 7.6 为什么这套最合理(对照 diff)

现状 `POST /chat` → agent SSE → gateway 逐 token 透传 + 写 history + snapshot,在群聊里全失效。新协议一一对应解决:

- agent 主动发言 → 靠 Speak **工具** execute 内 fetch room,不靠新基建(内核零改)。
- 入方向流式透传 → 退化为 `/observe` 的 JSON ack(群聊不要流)。
- 11 种内部事件 → 群聊只 yield/收 Speak 一个出口,其余内部消化(内心隔离天然)。
- snapshot/history.jsonl 污染 → 群聊不走 `/agents/:id/chat` 老路径,走 `/observe`,自然规避;故**不支持 rewind** 也无 checkpoint 可回。
- 历史维度 → 群聊历史由 room 的 `/member-said` 落 group-history.jsonl,维度是 room(而非 agentId)。

### 7.7 形态定后,落地点明确

- §3.3 生命周期:room bus 逻辑落在 elf gateway 进程内(模块 + `/rooms/*` 路由)。
- §3.4 包装层:`--mode=room` 时 agent 进程暴露 `/observe` 而非 `/chat`,Speak 工具经 `ctx.agent.runContext.roomBusUrl` 发言,reasoning 事件不外 yield。
- cleanup.sh:副本 detached,需扫 `run.json`(含动态 port)清副本进程(见 §7.8)。
- room 路由:创建群、加/退成员、`POST /rooms/:rid/send`(用户发言)→ 触发 §5 并发 `/observe` 给所有成员副本、`POST /rooms/:rid/subscribe`(前端 SSE,收整块 Speak 事件 + speaker 标记 + 成员在线状态)、`DELETE /rooms/:rid/history`(清群记录)、`POST /rooms/:rid/clear-memory`(清各成员记忆)。

### 7.8 cleanup.sh 清理副本实例

现状 `scripts/cleanup.sh` 只扫 `agents/*/config/config.json` 和 `gateway.json` 的**静态端口**(实测:line 19-31 扫 config.json 的 port)。副本进程的端口写在 `rooms/<rid>/data/<member>/run.json` 里(runContext 落盘),**现有脚本完全扫不到 → 漏清,端口残留**。

改造:cleanup.sh 增加第三段,扫所有副本 run.json 取端口:

```bash
# 3. 读取所有群聊副本端口(rooms/*/data/*/run.json 的 port 字段)
ROOMS_DIR="$PROJECT_DIR/rooms"
if [ -d "$ROOMS_DIR" ]; then
  for run_file in "$ROOMS_DIR"/*/data/*/run.json; do
    [ -f "$run_file" ] || continue
    INST_PORT=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$run_file" | grep -o '[0-9]*$' | head -1)
    [ -n "$INST_PORT" ] && PORTS="$PORTS $INST_PORT"
  done
fi
```

- 汇入已有的 `PORTS` 去重集合(现有 line 34 的 `sort -u`),后续 lsof 清理逻辑(line 43-51)**复用不动**。
- 静态可发现:run.json 随副本生命周期落盘/删除,与现有 config.json 扫描同范式。
- 兜底:即使 run.json 漏写/残留,现有 lsof 按端口清的逻辑仍能清掉残留进程(version of last resort)。
- 公文与私聊共存:清的是「端口占用」,不区分进程身份;副本端口和私聊 agent 端口一并清,无冲突。

> 注意:平时由 room_bus 保活巡检管理副本进程(§7.4);`cleanup.sh` 是**强力全清**(停服时用),直接 kill 占端口的进程,不走 /shutdown 优雅停。与 cleanup.sh 现有对私聊 agent 的处理一致(它也是 kill -9,不是 /shutdown)。

## 8. 文件与目录组织

### 8.1 两类东西分开:群数据 vs 群代码

群聊 = 群数据(动态、用户建) + 群代码(平台能力、固定)。两者组织方式不同。

### 8.2 群数据:新 `rooms/` 目录(动态,与 `agents/` 平级)

~~不放在 `agents/` 下~~。理由:
- room 不是普通 agent,不复用 `process_manager` 的"扫 config.json 拉进程"那套;放 `agents/` 会被 `_scanAgents` 误识别(config 不符 agent schema → 跳过/报警)。
- 语义上 room 是"会话容器"不是 agent",分目录清晰,且与独立的 `/rooms/*` 路由对齐。
- 群是用户建的(微信建群),动态创建,非预置。

```
rooms/
  elf-room-001/              # 一个群 = 一个目录,群 id = 目录名
    room.json                # 群配置:成员列表 ["elf-001","elf-002"]、roomName
    data/
      elf-001/
        context.json         # elf-001 在本群的独立记忆(与私聊隔离)
        history.jsonl        # elf-001 视角历史(可选,member 实例级)
        tool-results/        # (elf-002 等才有)
        run.json             # 副本 runContext 落盘 {runKey, agentId, port, pid, dataDir, mode, roomBusUrl, memberName}
      elf-002/
        context.json
        run.json
    group-history.jsonl      # 群聊历史(room 维度,所有人看到的统一流——群级,见 §11.2)
```

> `member.pid` 已并入 `run.json`(从 `{pid,port}` 扩成完整 runContext,见 §10.2)。副本无独立 config.json,run.json 是副本 re-discover 的唯一依据。

### 8.3 群代码:`gateway/` + `shared/agent/`,与现有代码并列

群聊逻辑是平台能力,不是某 agent 特有,跟现有代码同级。

```
gateway/
  room_bus.js          # 新:room 消息总线(成员副本 spawn/stop、并发 observe、广播聚合、群历史落盘、保活巡检)
  room_routes.js       # 新:/rooms/* 路由(建群/加退成员/send/subscribe/clear 等)
  server.js            # 改:挂载 room_routes(现有 /agents/* 原样不动)

shared/agent/
  room_agent.js        # 新:群聊模式 agent 包装层(/observe 入口、intuitive 门控、内部事件裁剪)
  tools/
    Speak.js           # 新:发言工具(唯一对外出口,execute 内 fetch room /member-said)
    index.js           # 改:导出 Speak
  start.js             # 改:解析 --mode/--data/--port/--room-bus/--member 等,构造 runContext;群聊模式暴露 /observe 而非 /chat
  server.js            # 改:群聊模式加 /observe 端点(私聊 /chat 不动)

scripts/
  cleanup.sh           # 改:增加扫 rooms/*/data/*/run.json 的副本端口(见 §7.8)
```

### 8.4 成员 agent 目录:原样不动

`agents/elf-001/`、`agents/elf-002/` 这些 agent 目录**完全不动**:
- 它们是"人设来源",入群时 `room_bus` 用它们的 config 拉副本进程(复用 config、data 指到 `rooms/elf-room-001/data/elf-001/`、换动态端口)。
- 群聊不往 agent 目录写任何东西。私聊进程 + config 文件原封不动。
- `agents/` 保持"一个目录 = 一个独立 agent"的干净约定不被破坏。

### 8.5 一句话总结

- **群数据** → 新 `rooms/` 目录(动态,与 `agents/` 平级)。
- **群代码** → `gateway/`(总线+路由)和 `shared/agent/`(包装层+Speak 工具),与现有代码并列。
- **成员 agent 目录** → 现有 `agents/<id>` 原样不动,只作入群副本的 config 来源。
- room 与 agent 各走各的(`/rooms/*` ↔ `/agents/*`),互不污染。

## 9. 已定决策汇总

- ✓ 群聊 = 微信式群聊,UI 与私聊集成(混排,非分两个 app)。
- ✓ 成员是 `agents/` 下现存 agent(elf-001/elf-002…),不另造。
- ✓ 入群 = 装备化(Speak 工具 + 默认 intuitive"被@才回"),运行时动态加,不改 agent 目录文件。
- ✓ Speak-as-a-Tool:唯一发言出口,整块、非流式;内心活动/其他工具不外露。
- ✓ 成员自定义 agent/MM 类必须保留(装备是包装,非替换)。
- ✓ 必须并行(外层并发,内层串行复用 server.js 互斥)。
- ✓ 必须允许死循环(无深度/冷却/轮次上限),唯一兜底自消息过滤,收敛靠 LLM。
- ✓ 一个 agent 在每个 room = 独立副本进程 + 独立端口 + 独立 session(与私聊隔离)。
- ✓ 默认 intuitive 可被成员自带策略覆盖。
- ✓ 推倒 v1(借 gateway 透传流)方案。
- ✓ gateway 形态 = 同进程加 `/rooms/*` 路由(方案 ②)。
- ✓ agent↔room 交互 = 双向:`/observe`(room→agent,JSON ack) + Speak 工具回调 `/rooms/:rid/member-said`(agent→room,整块)。控制通道复用 /abort /shutdown /clear。
- ✓ 实例化改造先行(§10):引入 runContext 第三层(类级/实例级/群级分层),多数群聊坑的共同根因。
- ✓ runContext **必须落盘**(run.json),非纯内存——agent 进程 detached,gateway/room_bus 关了要靠 run.json re-discover。
- ✓ port:config.json 的 port **留作私聊默认不动**;副本端口进 runContext,由 room_bus 注入。agentId **留 config.json 不动**(回归类名,运行身份交 runKey)。
- ✓ 进程模型:gateway(含 room_bus)同进程;**副本 agent 进程独立 detached 常驻**,不看前端 UI 是否打开(群聊自发多对多)。
- ✓ room_bus 保活:每成员副本保证拉起,未拉起则拉起,反复失败标 `offline` 前端灰显。
- ✓ 群聊操作:**清空全部聊天记录**(群级 group-history)+ **清空各成员记忆**(副本 /clear,实例级);**不支持 rewind**(群消息多人共见,单成员回退致视角错位;且 /observe 不打 snapshot)。

## 9. 待办

1. 补 `/rooms/*` 完整路由表 + 前端 SSE 契约(整块 Speak 事件、speaker 标记、成员在线状态变更、群历史)。
2. room 消息总线模块(gateway 内):副本 spawn/stop、并发 observe、广播聚合、群历史落盘/schema、保活巡检(§7.4)。
3. `RoomAgent`(group 模式包装层)落地:`/observe` 入口、Speak 工具、intuitive 门控、事件裁剪。
4. ~~cleanup.sh pidfile 方案~~ → 已定:扫 `rooms/*/data/*/run.json` 取 port(§7.8),落代码时实现。
5. 群聊 UI:多发言人气泡、整块消息、群管理页、@提及、成员离线灰显、状态变更刷新。
6. 代码层面细化 §3.4 的"包装而非替换"实现(对照 `Agent.js:64` 模式)。
7. §12 四条 review 真问题(行号证据见 §12):`/observe` 队列重写(§12.1)、prefix/suffix 群聊过滤(§12.2)、子 agent 剔除 Speak(§12.3)、clear 清 tool-results(§12.4)。

---

## 10. 里程碑:实例化改造先行

> 群聊的所有后续设计(Speak、RoomAgent、/observe、room_bus)都建立在"同一份 agent config 能派生 N 个独立实例"之上。当前代码是单实例假设,实例化改造是地基,**必须先做**。本节先落文档、不改代码。

### 10.1 根因:identity 焊死在 Agent 实例上

当前模型是两层,且身份与实例焊死:

```
Config(静态人设) → Agent 实例(人设 + 进程身份合一,单实例假设)
```

焊死在三个地方:
- **agentId 当全局唯一身份**:日志名(start.js:28)、/status、history/context 落盘都按它。假设"elf-001 这个名字全世界只有一个进程认领"。
- **工具拿 agent 引用靠 `this`**:`default_agent.js:403` `{ agent: this }`,工具从 `this` 读运行时信息。假设"`this` 就是身份的载体"。
- **fromConfigDir 只会"从零造一个实例"**:5 步全是 `new`,没有"基于已有实例派生/包装"的口子。

单实例下这些自洽;群聊要派生实例,缺口全暴露。

### 10.2 引入第三层:runContext(运行时身份,落盘)

改成三层:

```
Config(静态人设,类级) → Agent 实例(人设 + 内核) → runContext(运行时身份,实例级,落盘)
```

runContext 是"这个实例以什么身份运行"。**必须落盘,不能纯内存**——因为 agent 进程是 detached(`process_manager.js:240` `detached:true` + `unref()`),gateway/room_bus 关了 agent 还在;重启后要靠 runContext 文件 re-discover 副本(像 `index.js:30` gateway 启动探活幸存 agent 那样)。

```js
// 内存镜像(agent 进程启动时从 run.json 注入)
agent.runContext = {
  runKey:    'elf-room-001/elf-001',   // 复合身份,全局唯一运行单元
  agentId:   'elf-001',                // 来源 agent(类身份,只读)
  port:      9001,                     // 本实例监听端口(落盘,副本 detached 需 re-discover)
  pid:       12345,                    // 本实例进程 pid
  dataDir:   'rooms/elf-room-001/data/elf-001',  // 本实例独占数据目录
  mode:      'room',                   // 'private' | 'room'
  roomBusUrl: 'http://127.0.0.1:8080/rooms/elf-room-001',  // 仅 room 模式
  memberName: 'elf-001',               // 仅 room 模式(群里的名字)
}
```

落盘位置(实例目录内,每个实例一份):

```
agents/<id>/data/run.json              # 私聊实例(可选,私聊 agent 现不强制)
rooms/<rid>/data/<member>/run.json      # 副本实例(必须,room_bus 要 re-discover)
```

`run.json` 即之前记的 `member.pid` 的扩展(从 `{pid,port}` 扩成完整 runContext)。gateway/room_bus 启动时扫 `rooms/<rid>/data/*/run.json`,按 port 探活:活的接管,死的重拉(见 §7 生命周期)。

- 私聊实例:`runKey = agentId`,`mode='private'`,dataDir = `agents/<id>/data`,无 roomBusUrl。私聊 agent 现状不强制写 run.json(port 仍在 config.json 作私聊默认,gateway 扫 config.json),实例化改造对私聊**最小化**。
- 副本实例:`runKey = <roomId>/<agentId>`,`mode='room'`,dataDir = `rooms/<roomId>/data/<agentId>`,带 roomBusUrl/memberName。**必须写 run.json**(副本无独立 config.json)。
- 工具拿运行时身份**统一走 `ctx.agent.runContext.xxx`**,不再焊在 config 或 `this` 闭包上。

### 10.3 类级 vs 实例级归属表(基于实测代码)

**类级(Class-level)**——所有实例共享、不可变的"人设":改一个,所有实例行为都该变。

| 项 | 位置 | 类级原因 |
|---|---|---|
| `system_prompt.md` / `prefix_prompt.md` / `suffix_prompt.md` | config/ | 人格指令,私聊副本共享 |
| `compact_prompt.md` / `compact_system_prompt.md` | config/(elf-002) | 压缩时人设指令 |
| `avatar.png` / `user_avatar.webp` | config/ | 同一 agent 视觉身份 |
| config.json 人设字段:`name`/`provider`/`systemPrompt`/`prefix_prompt`/`memoryTokenLimit`/`maxIterations`/`tools`/`skills`/`subagents`/`messageManagerClass`/`agentClass`/`_ui` | config.json | 定义"是什么 agent、能干什么" |
| `config-ui.json` | config/ | 配置页 UI 布局,纯类描述 |
| **`api_key.json`**(base_url/auth_token/model) | config/ | **关键修正**:用哪个 LLM 后端,是人设属性。私聊副本共享同一 key(非会话级凭证) |
| 自定义类文件 `message_manager.js`/`agent.js` | agents/\<id\>/ | **类定义本身**(elf-001 prefix/suffix MM、elf-002 压缩 MM),副本实例化复用同一份类 |

**实例级(Instance-level)**——每个实例独立、互不可见的"会话状态/运行时身份":

| 项 | 位置 | 实例级原因 |
|---|---|---|
| `context.json`(LLM messages) | data/ | 各实例对话上下文独立 |
| `history.jsonl`(展示层记录) | data/ | 各实例可见历史独立(注:gateway 写) |
| `tool-results/`(elf-002 工具产物) | data/(`dataDir/tool-results`) | 各实例调工具产物,绑各自 context。源码已走实例注入(elf-002/message_manager.js:48)✅ |
| `checkpoints/`(rewind 快照) | data/ | 各实例回退点,绑自己会话 |
| **runContext**(runKey/port/pid/dataDir/roomBusUrl/…) | **内存,不落盘** | 进程启动注入的运行时身份。这是实例化的核心,之前不存在 |
| 日志文件 | logs/ | 应按 runKey 落(如 `agent-elf-room-001-elf-001.log`),实例级 |

### 10.4 关键修正:config.json 里的"错放实例级字段"

`config.json` 现在是**混合体**:大部分类级,但两字段实际是实例级,被错放在类配置里(单实例遗留):

- **`port`**:实例级(私聊 8081、副本 9001,不同实例端口不同)。现写 config.json → 多实例必须抽出来由启动参数注入。
- **`agentId`**:语义上是类级(这叫 elf-001),但作为**运行实体身份**是实例级(群里的 elf-001 ≠ 私聊 elf-001)。身份冲突在此。

实例化改造:`config.json` 回归纯人设(去掉 port 运行语义,或保留作私聊默认),`port`/`dataDir`/`runKey` 统一抽成 runContext 由启动注入。

### 10.5 改造后文件目录组织(一实例一 data 目录)

**类级目录(不变,实例共享的来源)**:

```
agents/
  elf-001/
    config/        # 类级人设:config.json(去 port 运行语义)、api_key.json、system_prompt.md、…
    message_manager.js   # 类定义(elf-001 自定义 MM)
    index.js       # 入口,仍调 startAgent(现改为接受 runContext)
  elf-002/
    ...
```
> agents/ 目录每子目录 = 一种 agent 类。实例不往这里写任何东西。

**实例级目录(一实例一份,改造后组织)**:

```
# 私聊实例(沿用现状,runKey = agentId)
agents/elf-001/data/
  context.json
  history.jsonl
  tool-results/      # elf-002 才有
  checkpoints/

# 群聊副本实例(新,runKey = roomId/agentId)
rooms/
  elf-room-001/
    room.json                 # 群配置:成员列表、roomName(不是 agent config,见 §8.2)
    group-history.jsonl       # 群聊历史(room 维度)
    data/
      elf-001/                # ← 一实例一目录,runKey=elf-room-001/elf-001
        context.json          # elf-001 在本群的独立上下文
        history.jsonl         # elf-001 视角历史(如保留 member 级)
        tool-results/
        member.pid            # 运行态:{pid, port}(给 cleanup.sh,见 §待补)
      elf-002/
        context.json
        ...
```

要点:
- **一实例一 data 目录**,路径由 runContext.dataDir 决定,不写死(`default_agent.js:82` 的 `configDir/..` 改读 runContext.dataDir,回退到私聊默认)。
- 私聊实例继续用 `agents/<id>/data`(现状不变,零迁移)。
- 副本实例用 `rooms/<roomId>/data/<agentId>/`,与私聊天然隔离。
- `agents/` 保持"一个目录 = 一种 agent 类"的干净约定;实例数据另放。`rooms/` 是动态创建的实例容器。

### 10.6 实例化改造的代码改动点(落代码时再动,此处先记录)

内核:
- `start.js`:`startAgent(configDir, runContext)` 增第二参;解析 `--port`/`--data`/`--mode`/`--room-bus`/`--member` 等启动参数构造 runContext;私聊默认 `{runKey:agentId, mode:'private', port: config.port, dataDir: agents/<id>/data}`。
- `default_agent.js:82`:`dataDir` 改读 runContext.dataDir(回退原 `configDir/..`,兼容私聊)。
- `default_agent.js`:`Agent` 实例挂 `this.runContext`;`reloadConfig` 时保留 runContext 不重置。
- `server.js`:`/status` 返回 runContext.runKey(而非裸 agentId);日志名按 runKey。
- `loadModuleClass`(default_agent.js:136):configDir 来源不变(副本复用类目录),类加载路径不受实例化影响 ✅。
- 工具:运行时身份统一 `ctx.agent.runContext.xxx`(Speak 的 roomBusUrl/minor 走此),不再依赖环境变量或 config。

带出但暂不动的:
- §3.4 包装(RoomAgent):实例化后,fromConfigDir 仍造原生实例;RoomAgent 在其上挂 runContext(mode='room'),可不"自己跑 reasoning"——因为工具已能经 ctx.agent.runContext 拿到群身份,内层 reasoning 可复用(见 §11.3)。

## 11. 实例化后 Review:哪些自动简化 / bug 消失

实例化改造落地后,之前 review 出的坑大多自动消解(因为它们是同一根:identity 焊死)。逐条对照:

| # | 之前的问题 | 实例化后状态 |
|---|---|---|
| 坑3 | 副本 agentId=elf-001 → /status、history 按 agentId 误判 | **消解**:runKey 区分副本(`elf-room-001/elf-001`),/status 返回 runKey;副本与私聊天然分清,不必引入额外 runKey 抽象——runContext 就是它 |
| 坑2 | 副本与私聊同 agentId → 同一日志文件并发写 | **消解**:日志按 runKey 落(`agent-elf-room-001-elf-001.log`),实例级,无冲突 |
| 坑5 | Speak 拿 roomBusUrl 用环境变量(错) | **修正**:统一走 `ctx.agent.runContext.roomBusUrl`,与现有工具拿 ctx.agent 的约定一致 |
| 坑7 | RoomAgent 须包装 fromConfigDir 产物,不能走 agentClass | **大幅简化**:runContext 是注入字段,非"换类"。fromConfigDir 造原生实例后挂 runContext(mode='room')即可;工具经 ctx.agent.runContext 拿群身份,内层 reasoning **可直接复用**,RoomAgent 不必自己重写 reasoning、不必抽 protected 方法。从"包装层重写"降级为"挂字段 + 门控" |
| 坑1 | 副本 fs.watch 热加载私聊 config | 仍需处理:`--mode=room` 下不挂 fs.watch(或监听独立 config 副本)。实例化不直接解决,但改造时顺手 |
| 坑4 | /observe vs 现有队列 | 不变:进程隔离已解,实例化无关。/observe 用平行队列 |
| 坑6 | 端口分配竞争 | 简化:端口进 runContext,由 room_bus/process_manager 统一分配器注入,天然集中 |

**净结论**:实例化改造(runContext)一次性消解坑 2/3/5,并把坑 7 从"重写包装层"降为"挂字段+门控"。剩坑 1(顺手禁 fs.watch)。**这是为什么实例化必须先做**——它是多数坑的共同根因。

### 11.1 仍需在实例化阶段单独处理的

1. **fs.watch 门控**:`--mode=room` 下 start.js 不挂 config 热加载(或副本读独立 config 拷贝)。
2. **port 注入**:config.json 的 port 字段去运行语义(保留作私聊默认),副本端口由 room_bus 分配器注入 runContext.port。
3. **内存目录 / tool-results**:确认 elf-002 toolResultsDir 已走 `dataDir/tool-results`(实例注入)✅,实例化后自动指向各自实例目录,无需额外改。
4. **group-history 维度**:实例化让 member 级 data 独立;但群聊"所有人可见的统一历史"是 room 维度,放 `rooms/<rid>/group-history.jsonl`,由 room_bus 写(非 member 实例)。这是实例级之外的"群级"第四类,单独管。

### 11.2 新引入的"第四类:群级(Group-level)"数据

实例化引入了 member×room 独立实例,但群聊还有"全群统一、所有成员可见"的数据,既非类也非 member 实例:

| 项 | 位置 | 群级原因 |
|---|---|---|
| 群成员名单、roomName | `rooms/<rid>/room.json` | 群的组成,所有成员共享一份 |
| 群聊历史(统一流) | `rooms/<rid>/group-history.jsonl` | 所有人看到的同一份群消息流,非某成员视角 |
| 成员端口表(运行态) | `rooms/<rid>/data/<member>/run.json`(成员实例级落盘) | room_bus 调度 / re-discover / cleanup.sh 清理用 |

> member 实例的 `context.json` 是"该成员视角的会话状态"(实例级),`group-history.jsonl` 是"群客观历史"(群级),二者不同。前端按 group-history 渲染群聊界面;member context 仅供该成员 LLM 用。

## 12. Review 真问题(实例化之外,群聊新交互引入的坑)

> §11 的坑靠实例化(runContext)解。本节是**实例化也解不了的**、由"群聊新交互方式"引入的真问题。每条均用真实代码行号证据锚定(经对抗性 review + 我亲自读码复核,非推断)。落代码时一并处理。

### 12.1 `/observe` 队列需重写(非"复用 + 小改") — 中高

**证据**(`shared/agent/server.js`):
- `server.js:38` 合并写死 `pendingMessage += '\n' + req.body.message`,假设 body 有 `message:string`。`/observe` body 是 `{from,content,mentions}` → `req.body.message` 是 `undefined` → 拼成字面量 `"undefined"`。
- `server.js:56` `processRequest(message)` 入参 string,`agent.receive(message)` 也吃 string(单 string)。结构化 mentions 并集贯不下去。
- `server.js:100` 触发再处理条件 `pendingMessage !== null && pendingResponses.length > 0`。`pendingResponses` 只在 `enqueueRequest`(server.js:42/44)收集,为 SSE 多 res 合并设计。
- 整段(server.js:30-104)`pendingMessage`/`processRequest`/`pendingResponses` 全为"单 message 字符串 + SSE 响应"设计。

**结论**:文档原说"复用 server.js 队列仅小改"是**错的**。`/observe` 要**重写一套专属队列**:存 `{from,content,mentions}[]`,出队时判 `mentions.includes(runContext.memberName)` 决定 reasoning 还是 ack,触发条件不依赖 `pendingResponses`。

**注意"恒 false"论据已撤**:早先 reviewer 称"JSON ack 不填 pendingResponses → 触发条件恒 false",此论据依赖"`/observe` handler 绕过 enqueueRequest 自己攒消息"这一尚未确定的设计,非现有 bug。真问题是"队列结构不匹配",无论 handler 怎么写都得重写。

**进程隔离兜底**:副本是独立进程,`--mode=room` 下不挂 `/chat` 路由(避免共享 `isProcessing`/`pendingMessage` 闭包互相阻塞),`/observe` 单写一套队列,与私聊 `/chat` 进程级隔离。

### 12.2 elf-001 的 prefix/suffix 在群聊会包错消息 + 语义错位 — 中

**证据**:
- `agents/elf-001/message_manager.js:37-43` `getMessagesForLLM` 从**尾部**找最后一条 `role==='user'` 消息包 `prefix + content + suffix`。
- `shared/agent/tools/Skill.js:92` `agent.messageManager.addUserMessage(commandTag(name, argStr), false)` —— Skill 工具追加一条**非 meta 的 user 消息**(`<command-*>` 段)。
- `shared/agent/message_manager.js:85-88` `addMetaMessage` 也 push `role:'user'`(isMeta:true)。

**结论**:群聊里成员被 @ 后若调了 Skill,`<command-name>` 段(Skill.js:92)成了最后一条 user 消息 → elf-001 MM 把 prefix/suffix 包到了 command-tag 段上,**不是那条被 @ 的群消息**。且 prefix/suffix 是私聊 1:1 语境(如"你正在与用户对话")套进群聊语义错位。

**处理**:装备包在群聊模式关掉/过滤 elf-001 的 prefix/suffix 注入(子类化跳过,或给 prefix_prompt 声明 `modes:['private']` 过滤)。

### 12.3 子 agent 调 Speak 越界(抛错污染 reasoning) — 中,易修

**证据**:
- `shared/agent/subagents/registry.js:46` general-purpose `'tools': ['*']`(全开)。
- `shared/agent/tools/Agent.js:76-78` general-purpose 子工具 = 父工具全集(Explore 才用 `disallowedTools` 剔除,registry.js:40)。
- `tools/Agent.js:88` `new ParentAgentClass({...})` 构造子 agent;`shared/agent/default_agent.js:160-174` 构造器**不设 runContext** → 子 agent 无 runContext。
- 子 agent context 落 `/tmp` 临时目录(`Agent.js:65` `mkdtempSync`),跑完清(`Agent.js:114`)——**这点不污染副本 dataDir,OK**。

**结论**:若 Speak 进 toolRegistry,general-purpose 子 agent 拿到 Speak → 调用时 `ctx.agent` 是子 agent(`Agent.js:50`)→ 读 `ctx.agent.runContext` 得 `undefined` → Speak 抛错/no-op,污染副本 reasoning。边界违反。

**处理**:Agent 工具子工具过滤时**显式剔除 Speak**(对齐 Explore 剔除 Agent 的写法,registry.js:40),或在 room 装备时给子 agent 工具表打 `disallowedTools:['Speak']`。

### 12.4 `/clear` 不清 elf-002 的 tool-results/ 孤儿 — 低

**证据**(经"awk 列全方法名"复核,非依赖 grep 退出码):
- `shared/agent/server.js:181-194` `/clear` → `agent.messageManager.clear()`。
- **awk 列全 `agents/elf-002/message_manager.js` 方法名**:constructor / updateConfig / _getThreshold / addToolResult / getMessagesForLLM / estimateTokens / _enforceBudgetWindow / _groupToolResultsByTurn / _recordCompactFailure / _parseSummaryResponse / _ensureToolResultsDir / _persistToolResult / _extractPreview / _buildPersistedOutput / _formatSize / reloadFromDisk / _cleanupToolResults。**无 `clear()` 方法** → `/clear` 调到基类。
- 基类 `clear()`(`shared/agent/message_manager.js:198-200`):只 `this.messages = []; this._save()`,无 tool-results 操作。
- elf-002 清 tool-results 的唯一方法 `_cleanupToolResults()`(`agents/elf-002/message_manager.js:381`),**仅 compact 成功路径 line 231 调用**(awk/grep 调用点仅此一处)。

**结论**:副本(若复用 elf-002 MM)被 `/clear` 时 tool-results/ 目录不清。孤儿 .txt 文件累积。不影响 context 正确性(只占磁盘),低严重度。

**处理**:群聊 clear-memory 时,room_bus 调副本 `/clear` **后**额外删它的 `tool-results/` 整个目录(实例级,删整个即可,不误伤私聊)。

> 复核方法笔记:本节证据用"读全方法清单(awk)"而非"grep 退出码=1"做存在性判断,避免 BSD grep `\s` 假阴性等工具语义陷阱。

### 12.5 已验证为非问题(不列待办)

- **group-history 并发写**:room_bus 是 gateway 同进程(node 单线程),`appendFileSync` 天然串行,无撕裂。约束:必须用同步 API 或 `await` 链串行化,不用并发 in-flight `fs.promises.appendFile`。
- **room_bus 重启探活误判**:副本内 `isProcessing` 互斥已是原语,room_bus 不需知副本忙不忙,发 `/observe` 进副本队列等即可。`/status` 不返回 busy 仅影响 UX("正在思考"气泡),非正确性,可选加 `busy: isProcessing`(server.js:170 单行)。
- **RoomAgent 门控位置**:runContext 直接挂内层 agent 实例(`agent.runContext = {...}`,非外层包装类),则 `ctx.agent.runContext`(`default_agent.js:398/419` 的 `this`)链通,Speak 读得到。门控须包在 `receive`(不是纯挂字段),但不必重写 reasoning。§11 坑7 的"挂字段+门控"方向对,门控位置是 `receive`。
- **reloadConfig 不破坏 runContext**:`reloadConfig`(`default_agent.js:188-208`)只动 model + messageManager.updateConfig,不重置 runContext;messageManager 的 toolResultsDir 构造时定死,updateConfig 不重置。fs.watch 仍需 `--mode=room` 禁用(已是 §11 条目)。

## 13. 实例化改造的验证清单(改代码后逐项验)

- [ ] 私聊 agent 启动行为完全不变(runContext 默认 = 私聊形态,回归现有 npm test)。
- [ ] 起两个 elf-001 实例(私聊 + 副本),日志分文件、端口不同、data 隔离。
- [ ] 副本 /status 返回 runKey,前端/gateway 不误判为私聊 elf-001。
- [ ] 工具经 ctx.agent.runContext 拿身份,Speak 能 fetch 到 room bus(占位测)。
- [ ] 副本改成员 config 不影响副本(等 fs.watch 门控);改副本 runContext 不影响私聊。
- [ ] elf-002 的 tool-results/checkpoints 落到副本自己的 data 目录,不污染私聊。
- [ ] §12 各真问题已处理:`/observe` 队列重写、prefix/suffix 群聊过滤、子 agent 剔除 Speak、clear 清 tool-results。

---

## 14. 前端群聊 UI 设计

> 本节落群聊前端设计。当前前端完全为"私聊工具型"设计(Sidebar 选 agent、ChatPanel 单人流式、ConfigDrawer 编辑 agent 配置),无任何 room 概念。本节定义如何**复用现有组件骨架 + 新增群聊组件**,实现"私聊+群聊混排(微信群式)"。

### 14.1 现状(已核实代码)

| 文件 | 现状 | 群聊需改 |
|---|---|---|
| `stores/agentStore.js` | 会话模型 = `activeAgentId` + `chats: Map<agentId, chatState>` | 抽象成"会话 = agent(私聊)或 room(群聊)" |
| `components/Sidebar.jsx` | 列 `agents.map(a => <item>)`,点选 → `selectAgent(agentId)` | 改列"会话"(私聊条目+群聊条目混排) |
| `components/ChatPanel.jsx` + `MessageBubble.jsx` | 单人对话流式气泡(token 逐字) | 群聊面板:多发言人气泡、整块消息、speaker 头像 |
| `components/ConfigDrawer.jsx` | 编辑单 agent 配置(system_prompt/tools/...) | 按会话类型切换:私聊=agent 配置,群聊=群管理页(加退成员) |
| `hooks/useChat.js` | SSE 流 `/agents/:id/chat`,逐 token | 群聊用 `/rooms/:id/subscribe`(整块 Speak 事件) |
| `api/index.js` | `/agents/*` 调用 | 新增 `/rooms/*` 调用 |

工具型 UI 组件(`ToolCallBadge`/`EditDiff`/`CompactBadge`/`RewindMenu`)**群聊不用**(内心活动不外露、整块非流式、不支持 rewind)——群聊面板不复用这些。

### 14.2 会话模型重构(agentStore)

把"会话"从 agent 维度抽象成统一的 session 概念:

```js
// store 新增 sessions 概念,与 agents 并列
{
  agents: [...],                          // 现有:私聊 agent 列表(类)
  rooms: [...],                           // 新:群聊列表 [{ roomId, name, members:[agentId], avatar }]
  activeSession: { type:'agent'|'room', id: string },  // 取代 activeAgentId
  chats: Map<sessionId, chatState>,       // key 从 agentId 改成 sessionId
}
// sessionId 编码:type:id(如 'agent:elf-001' / 'room:elf-room-001'),与后端 runKey 对齐
// 向后兼容:selectAgent(agentId) 内部转 selectSession({type:'agent',id:agentId})
```

- `selectSession({type,id})` 取代 `selectAgent`,内部按 type 走不同加载(私聊 `/agents/:id/history`,群聊 `/rooms/:id/history`)。
- Sidebar 列表改成 `sessions = [...agents.map(→agent session), ...rooms.map(→room session)]` 混排,按更新时间排序(微信群式)。

### 14.3 新增组件

**`RoomChatPanel.jsx`**(群聊面板,与私聊 ChatPanel 平行,不复用):
- 多发言人气泡:每条消息按 `speaker` 渲染(头像+名),用户=user,各 agent=各自头像。
- **整块消息**:Speak 产出的消息一次性渲染(非逐 token 流式)。后端 `/rooms/:id/subscribe` SSE 推 `event: speak {speaker, content}`(整块),前端收到直接成块。
- **成员在线状态条**:顶部显示成员列表 + 在线/离线/思考中(`busy`)灰显。
- 无 ToolCallBadge/EditDiff/RewindMenu 内心活动控件(§7.5 群聊不支持 rewind,内心不外露)。

**`RoomConfigDrawer.jsx`**(群管理页,替代私聊 ConfigDrawer 的群聊形态):
- **成员管理区**:列出当前群成员(头像+名+在线状态)+ "添加成员"按钮。
- "添加成员"= 从既存 agent 列表(`agents`)勾选未入群的 agent → `POST /rooms/:id/members {agentId}`。
- 成员旁"移除"按钮 → `DELETE /rooms/:id/members/:agentId`。
- **群信息区**:群名(可改)、群 ID、创建时间。
- **清空操作**:`清空聊天记录`(`DELETE /rooms/:id/history`)+ `清空所有成员记忆`(`POST /rooms/:id/clear-memory`)(§7.5)。无 rewind 入口。

**会话切换**:ConfigDrawer 按 `activeSession.type` 渲染——`agent` 用现有 `ConfigDrawer`,`room` 用 `RoomConfigDrawer`。同一抽屉容器,内容按会话类型切换。

**`Sidebar` 会话项**:私聊条目(已有 agent 头像)+ 群聊条目(群头像/多头像叠加 + 群名 + 最后一条消息预览)。顶部"+ 新建群聊"按钮 → 弹窗选初始成员 → `POST /rooms {name, members}`。

### 14.4 数据流(群聊 SSE 契约)

群聊前端订阅 `/rooms/:id/subscribe`(SSE),事件:

| event | data | 前端处理 |
|---|---|---|
| `snapshot` | `{members:[{agentId,online,busy}], messages:[...]}` | 初始化:渲染历史 + 成员状态条 |
| `speak` | `{speaker, content, ts}` | 新增一条整块消息(非流式),按 speaker 渲染气泡 |
| `member_status` | `{agentId, status:'online'\|'offline'\|'busy'}` | 更新成员状态条(灰显/思考中) |
| `user_echo` | `{content, ts}` | 用户自己发的消息回显(发送即乐观渲染,此事件确认) |
| `error` | `{message}` | 错误提示 toast |

发送:`POST /rooms/:id/send {message}`(用户发言)→ room_bus 并发 `/observe` 给成员 → 成员 Speak → 回灌成 `speak` 事件给所有订阅者。

> 与私聊 SSE(`/agents/:id/chat` 推 token/tool_call/...)完全不同的契约:群聊只有 `speak` 一个内容出口(对齐 §2 Speak-as-tool)。`useChat.js` 不能复用,新写 `useRoomChat.js`。

### 14.5 复用 vs 新建边界

**复用**:
- `agentStore` 的 zustand 骨架、`chats` Map 结构(改 key 语义)。
- 现有 `ConfigDrawer` 组件(私聊形态不动,群聊走新 `RoomConfigDrawer`)。
- 既存 agent 列表(`agents`)——群管理"添加成员"从这里选。
- 头像/Markdown 渲染等纯展示组件。

**新建**:
- `RoomChatPanel.jsx`(群聊面板)、`RoomConfigDrawer.jsx`(群管理页)、`useRoomChat.js`(群聊 SSE hook)、`RoomSidebarItem`(群聊条目,或 Sidebar 内分支)。
- `api/rooms.js`(`/rooms/*` 调用)。
- store 的 `rooms`/`activeSession`/`selectSession` 状态。

**不改/不用**:工具型 UI(ToolCallBadge/EditDiff/CompactBadge/RewindMenu)群聊不渲染;私聊 `/agents/*` 路径与 ChatPanel 原样保留(私聊零回归)。

### 14.6 落地顺序(前端,依赖后端 room_bus)

1. 后端 `/rooms/*` 路由 + room_bus 先行(否则前端无 API 可调)。
2. `api/rooms.js` + store 的 session 抽象(`activeSession`/`selectSession`),Sidebar 混排私聊+群聊条目(此时群聊条目可空,先打通 session 模型)。
3. `RoomConfigDrawer`(群管理页:建群、加退既存 agent)——**这是你能"在 room config 加退 agent"的入口**。
4. `RoomChatPanel` + `useRoomChat`(群聊面板 + SSE 订阅)——"两人 @ 互聊"最小闭环前端。
5. 成员在线状态、@提及高亮等增强。

> 关键:前端群聊 UI 完全依赖后端 `/rooms/*` 路由 + room_bus。后端第一块(room_bus + 路由 + RoomAgent)做完,前端 §14.3-14.5 才能接上。前端无法先于后端独立验证。