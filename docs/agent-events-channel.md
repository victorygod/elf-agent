# Agent 事件通道：解除 compact 事件与 /chat 生命周期绑定

> 目标：Agent 能**随时**向 Gateway 推送状态变更事件（如后台压缩完成），
> 不受单次 `/chat` HTTP 请求的 SSE 流生命周期限制。
> 状态：方案待评审。

---

## 0. 当前架构的死板之处

```
Agent 进程                    Gateway                       前端
  │                             │                            │
  │ POST /chat ──────────────→  │  SSE stream ────────────→  │
  │  reasoning() {               │                            │
  │    compactIfNeeded()         │                            │
  │      yield compact_start ─→  │  compact_start ────────→  │  建 loading 气泡
  │      start background        │                            │
  │      return                  │                            │
  │    chatStream() ─────────→   │  tokens ──────────────→   │
  │    done ─────────────────→   │  done ────────────────→   │
  │  }                           │                            │
  │  ~~~~ HTTP 响应结束 ~~~~     │  ~~~~ SSE 关闭 ~~~~       │  ← 通道消失
  │                              │                            │
  │  [后台压缩完成]               │                            │
  │  _bgDone = true               │  没有通道!!!               │  ← 卡在这里
  │  compact 事件发不出去          │                            │
  │                              │                            │
  │  等下次 /chat ────────────→   │  compact ──────────────→  │  ← 延迟到下一轮
```

**根本问题**:Agent 只能通过 `/chat` 的 HTTP 响应回传事件，而 `/chat` 是短命的请求-响应周期。没有独立于 `/chat` 的「Agent → Gateway」事件通道。

---

## 1. 方案：通用的 `GET /events` 端点

**核心**:Agent 暴露一个独立的 SSE 端点 `GET /events`，不在 `/chat` 生命周期内。Gateway 在 Agent 启动后建立到它的长连接，Agent 任何时候（包括后台压缩完成）都能往这个通道推事件，Gateway 转发给前端。

```
Agent 进程                      Gateway                        前端
  │                               │                             │
  │ ←─ GET /events (长连接) ──── │  (Agent 启动后建立)          │
  │                               │                             │
  │ POST /chat ────────────────→  │  SSE ──────────────────→   │
  │  compact_start → 启后台       │                             │
  │  return → 继续回复            │                             │
  │  done —————————————————————→  │  done ─────────────────→   │
  │  ~~~~ /chat 响应结束 ~~~~     │  ~~~~ SSE 关闭 ~~~~        │
  │                               │                             │
  │  [后台压缩完成]               │                             │
  │  eventsChannel.emit(           │                             │
  │    {event:'compact',           │                             │
  │     data:{compactId,...}}      │                             │
  │  ) ───────────────────────→   │  ← 独立通道，任何时候都能推  │
  │                               │  subscribedClients 转发 ─→ │  气泡更新 ✅
```

---

## 2. 详细设计

### 2.1 Agent 侧：`shared/agent/server.js` 新增 `GET /events`

```js
// createAgentServer 内新增

// /events 订阅者列表（SSE 长连接，独立于 /chat 生命周期）
const eventsClients = new Set();

// 挂到 agent 上，MessageManager 可通过 agent._pushEvent 推送
agent._pushEvent = (eventName, eventData) => {
  const chunk = `event: ${eventName}\ndata: ${JSON.stringify(eventData)}\n\n`;
  for (const res of eventsClients) {
    try { if (res.writable) res.write(chunk); } catch (e) { eventsClients.delete(res); }
  }
};

// GET /events — Gateway 连接此端点接收 Agent 状态变更事件
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();

  eventsClients.add(res);
  res.on('close', () => eventsClients.delete(res));
});
```

### 2.2 MessageManager 侧：后台完成时走完整 apply + 推事件

#### 2.2.1 为什么不能只推原始结果

`.then(r)` 拿到的 `r` 是 `{summary, anchorId}`，没有 `tokenEstimate`——它要在 `_applyBgResult` 里 swap messages 后才能算出。所以 `_onBgCompactDone` 必须自己走完整路径：`_applyBgResult()` → 拿到 `{tokenEstimate}` → 推 compact 事件。

#### 2.2.2 `.then()` 里走完整路径

```js
// 闭包捕获 compact 快照（async 分支 _beginCompactAttempt 之后）
this._bgPromise = this._doCompact(llmModel, { ...options, signal: this._bgAbortController.signal })
  .then(r => {
    logger.info(`[compact] 后台压缩完成 ${compactId}: result=...`);
    this._bgResult = r;
    this._bgDone = true;
    this._bgRunning = false;

    // ★ 后台压缩完成后立即 apply + 推事件给 Gateway（不等到下一轮 compactIfNeeded）
    // _onBgCompactDone 内部调 _applyBgResult() 走完整应用路径。
    // apply 成功 → _endCompactSuccess + _pushEvent('compact')，_bgDone 被清。
    // apply 失败 → _endCompactAbandoned + _pushEvent('compact_error')，气泡收尾。
    // 若回调未注入 → _bgDone 保持 true，下一轮 compactIfNeeded 作为 fallback 补 apply。
    this._onBgCompactDone?.(compactId);
  })
  .catch(err => {
    this._bgRunning = false;
    if (err?.name === 'AbortError') {
      logger.info(`[compact] 后台压缩被中止 ${compactId}`);
      // abort → 不通过 events 推（compact_abort 由 default_agent 的 _abortCompactBubble 推）
      return;
    }
    this._bgFailed = true;
    this._recordFailure();
    logger.error(`[compact] 后台压缩失败 ${compactId}: ${err.message}`);

    // ★ 失败立即推 compact_error 给 Gateway（不等到下一轮 _bgFailed 分支）。
    // 但 _bgFailed 已设——若 events 通道成功推送了，需清掉 _bgFailed
    // 避免下一轮 compactIfNeeded 的 _bgFailed 分支重复报（双重推送）。
    // 回调返回 true 表示 events 通道已报 → 清 _bgFailed。
    if (this._onBgCompactError?.(err.message)) {
      this._bgFailed = false;
    }
  });
```

> **JS 单线程安全**：`.then()` 可能在 chatStream 期间触发，这**安全**——`getMessagesForLLM()` 返回的是新数组（非引用），chatStream 拿到快照不会被 swap 影响；`_save` 落盘同步无并发。无需额外并发保护。

#### 2.2.3 `_onBgCompactDone` / `_onBgCompactError` 实现

```js
// default_agent fromConfigDir 内，创建 messageManager 后注入。

// 后台压缩完成后的成功回调
messageManager._onBgCompactDone = (compactId) => {
  // 1. 走完整 apply：swap messages，拿到 tokenEstimate
  const result = messageManager._applyBgResult();
  if (result) {
    // apply 成功：清 _pendingCompact + 推 compact 事件
    const compact = messageManager._pendingCompact;
    messageManager._endCompactSuccess();
    if (typeof this._pushEvent === 'function') {
      this._pushEvent('compact', {
        tokenEstimate: result.tokenEstimate,
        compactId: compactId,
      });
    }
    return;
  }
  // apply 失败：_applyBgResult 返回 null（anchor 丢失 / summary 为空）
  // _applyBgResult 内部已清 _bgDone/_bgResult/_bgRunning，但 _pendingCompact 还在、
  // 气泡还是 loading。必须收尾：_endCompactAbandoned + 推 compact_error。
  const compact = messageManager._pendingCompact;
  messageManager._endCompactAbandoned();
  if (typeof this._pushEvent === 'function') {
    this._pushEvent('compact_error', {
      compactId: compactId,
      attempt: compact?.attempt,
      error: '记忆压缩失败：无可压缩内容',
    });
  }
};

// 后台压缩异常（非 abort）的失败回调，返回 boolean：events 通道是否已推送。
messageManager._onBgCompactError = (msg) => {
  const compact = messageManager._pendingCompact;
  if (typeof this._pushEvent === 'function') {
    this._pushEvent('compact_error', {
      compactId: compact?.compactId,
      attempt: compact?.attempt,
      error: msg,
    });
    return true;   // ★ 返回 true 通知 messageManager 清 _bgFailed（避免下一轮 _bgFailed 分支重复报）
  }
  return false;    // 无 events 通道，_bgFailed 保留 → 下一轮 compactIfNeeded fallback 报
};
```

#### 2.2.4 `compactIfNeeded` 的 `_bgDone`/`_bgFailed` 分支降级为 fallback

- **`_bgDone` 成功路径**：`_onBgCompactDone` apply 成功 → `_bgDone` 被 `_applyBgResult` 清掉。下一轮 `compactIfNeeded` 的 `_bgDone` 检查 → false，跳过 ✅
- **`_bgDone` 失败路径**：`_onBgCompactDone` apply 返回 null(anchor 丢失等) → 回调内已 `_endCompactAbandoned` + 推 compact_error → 气泡已收尾。`_bgDone` 已被 `_applyBgResult` 清。下一轮 `compactIfNeeded` 不会进 `_bgDone` 分支 ✅
- **`_bgFailed` 路径**：`_onBgCompactError` 返回 true(events 通道已推) → `_bgFailed` 被清。下一轮 `compactIfNeeded` 不报 ✅。返回 false(无 events 通道) → `_bgFailed` 保留 → 下一轮 fallback 补报。
- **未注入回调**：`_bgDone`/`_bgFailed` 保持原值 → 下一轮 `compactIfNeeded` 的正常分支继续（完全向后兼容）。

> **compactIfNeeded 已有的 `_bgDone`/`_bgFailed` 分支不需要改**——它们就是 fallback：events 通道成功时状态已清（分支不触发）；失败/无通道时仍正常触发。

### 2.3 Gateway 侧：连接 Agent `/events` + 转发前端

#### 2.3.1 建立连接

`ProcessManager.startAgent` 成功后，建立到 Agent `/events` 的 SSE 长连接。独立于 StreamContext 生命周期——Agent 重启/断连时自动重连。

```js
// gateway/agent_events.js（新文件）
const eventConnections = new Map(); // agentId → { controller, port }

export function connectAgentEvents(agentId, port, onEvent) {
  disconnectAgentEvents(agentId); // 先清旧连接

  const controller = new AbortController();
  eventConnections.set(agentId, { controller, port });

  (function connect() {
    fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal })
      .then(res => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', currentEvent = '';
        function pump() {
          reader.read().then(({done, value}) => {
            if (done) { setTimeout(connect, 2000); return; }
            buffer += decoder.decode(value, {stream:true});
            const lines = buffer.split('\n'); buffer = lines.pop() || '';
            for (const line of lines) {
              const t = line.trim();
              if (t.startsWith('event: ')) currentEvent = t.slice(7);
              else if (t.startsWith('data: ')) {
                try { onEvent(currentEvent, JSON.parse(t.slice(6))); } catch(e){}
              } else if (t === '') currentEvent = '';
            }
            pump();
          }).catch(() => { setTimeout(connect, 2000); });
        }
        pump();
      })
      .catch(() => { setTimeout(connect, 5000); });
  })();

  return controller;
}

export function disconnectAgentEvents(agentId) {
  const conn = eventConnections.get(agentId);
  if (conn) { conn.controller.abort(); eventConnections.delete(agentId); }
}
```

#### 2.3.2 连接时机

`ProcessManager.startAgent` 的 `_waitForReady` 成功后：

```js
if (probed || fallbackPid) {
  connectAgentEvents(id, agent.port, (event, data) => {
    _onAgentEvent(id, event, data);
  });
}
```

`stopAgent` 内断开：`disconnectAgentEvents(id)`。

#### 2.3.3 转发前端

```js
_onAgentEvent(agentId, event, data) {
  // 遍历 subscribedClients（独立于 StreamContext 生命周期），广播事件
  const subscribers = subscribedClients.get(agentId) || [];
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of subscribers) {
    try { if (sub.res.writable) sub.res.write(chunk); } catch (e) { /* 移除 */ }
  }

  // 同时写入 history（chat_proxy 已有的 compact 事件处理逻辑也在这里走）
  if (event === 'compact') {
    const chatHistory = getChatHistory();  // 需注入或模块级获取
    chatHistory?.updateCompactRecord(agentId, data.compactId, { compactSummary: data.tokenEstimate });
  } else if (event === 'compact_error') {
    const chatHistory = getChatHistory();
    chatHistory?.updateCompactRecord(agentId, data.compactId, { compactError: data.error });
  }
}
```

> **`connectAgentEvents` 只在 `_onAgentEvent` 里调 `chatHistory.updateCompactRecord`**——因为 `/chat` 的 pump 已经处理了同 turn compact，events 通道只处理跨 turn compact。不会重复写。

### 2.4 subscribe 连接的生命周期修复（必要）

当前 `subscribeToStream`（chat_proxy.js:298-308）：

```js
// 现状
if (ctx && !ctx.closed && !ctx.streamEnded) {
  ctx.subscribers.push({ res });
} else {
  res.end();  // ← 无活跃流时立即关闭连接！compact 事件到来时没有前端连接可转发
}
```

**修复**：把 subscribe 连接提升到模块级，**不依赖 ctx 是否存在**——连接保持打开，直到前端主动断开。

```js
// gateway/chat_proxy.js 模块级
const subscribedClients = new Map(); // agentId → [{res}]

export function subscribeToStream(agentId, res, chatHistory) {
  const ctx = streamContexts.get(agentId);

  res.writeHead(200, { ... });
  const snapshot = buildSnapshot(agentId, ctx, chatHistory);
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  // ★ 注册到独立于 ctx 的 subscribedClients（不管是否有活跃流）
  if (!subscribedClients.has(agentId)) subscribedClients.set(agentId, []);
  subscribedClients.get(agentId).push({ res });
  res.on('close', () => {
    const list = subscribedClients.get(agentId) || [];
    subscribedClients.set(agentId, list.filter(s => s.res !== res));
  });

  // 有活跃流时 ctx 仍在本轮广播 token/tool_call 等（不做改动）
  if (ctx && !ctx.closed && !ctx.streamEnded) {
    ctx.subscribers.push({ res });
    res.on('close', () => {
      const idx = ctx.subscribers.findIndex(s => s.res === res);
      if (idx !== -1) ctx.subscribers.splice(idx, 1);
    });
  }
  // ★ 无活跃流时不再 close 连接——保持开放，等 events 通道推送 compact/其他事件
}
```

> **双注册的原因**：ctx.subscribers 收 `/chat` 流内事件（token/tool_call/同 turn compact）；subscribedClients 收 events 通道的跨 turn compact/compact_error。同一 res 注册进两个列表，前端断开时两边都要移除。

### 2.5 compact_event 通过 Gateway events channel + history 更新

Gateway `_onAgentEvent` 收到 compact 事件时写 history。但注意：`updateCompactRecord` 要能访问 `ChatHistory` 实例。目前 `ChatHistory` 是 gateway-index 创建后传给 `createGatewayApp` → `proxyChat`。`_onAgentEvent` 在 ProcessManager 上，需要能拿到 ChatHistory 实例。两种方式：

- 把 ChatHistory 注入 ProcessManager（或模块级 export）
- 或由 gateway/server.js 的 `createGatewayApp` 在 processManager 上设引用

选后者——`server.js` 已有对 pm 和 chatHistory 的引用，加一行 `pm.chatHistory = chatHistory` 即可。`_onAgentEvent` 内通过 `this.chatHistory` 访问。

---

## 3. 改动文件清单

| 文件 | 改动 |
|---|---|
| `shared/agent/server.js` | 新增 `GET /events` 端点（eventsClients Set）；给 agent 挂 `_pushEvent(eventName, data)` 方法 |
| `shared/agent/message_manager.js` | `.then(r)` + `.catch(err)` 各加回调 `_onBgCompactDone`/`_onBgCompactError`；回调可选（未注入时走原有 _bgDone/_bgFailed fallback 路径） |
| `shared/agent/default_agent.js` | `fromConfigDir` 内注入 `_onBgCompactDone`（调 `_applyBgResult`→`_pushEvent('compact')`）和 `_onBgCompactError`（`_pushEvent('compact_error')`） |
| `gateway/agent_events.js` | **新文件**：`connectAgentEvents`/`disconnectAgentEvents` 建立到 Agent `/events` 的 SSE 长连接 + 自动重连 |
| `gateway/process_manager.js` | `startAgent` 探活后调 `connectAgentEvents`；`stopAgent` 时 `disconnectAgentEvents`；新增 `_onAgentEvent` 转发 + history 更新；注入 `chatHistory` 引用 |
| `gateway/chat_proxy.js` | 新增模块级 `subscribedClients`；`subscribeToStream` 改为不依赖 ctx 关闭连接（注册到 subscribedClients） |
| `gateway/server.js` | `createGatewayApp` 内 `pm.chatHistory = chatHistory` 注入引用 |

---

## 4. 消息流程（修复后）

```
1. 用户发消息 → reasoning → compactIfNeeded → compact_start(建气泡) → 启后台 → 主流程继续
2. /chat 响应结束（SSE 关闭）
3. Gateway GET /events 长连接仍在 ✅
   前端 subscribe 连接仍在（subscribedClients）✅
4. 后台压缩完成：
   .then(r) → _onBgCompactDone() → _applyBgResult(swap messages)
     → _endCompactSuccess + _pushEvent('compact', {tokenEstimate, compactId})
     → Agent→Gateway→subscribedClients→前端 ✅
5. 前端收到 compact(compactId) → _applyCompactResult → 找到 loading 气泡 → 更新 ✅
6. 后台压缩失败：
   .catch(err) → _onBgCompactError(msg) → _pushEvent('compact_error', {compactId, error})
     → Agent→Gateway→subscribedClients→前端 ✅
     → 前端气泡立即变失败（不等下一轮）
```

---

## 5. 边界情况

1. **后台压缩在 `/chat` 流内先完成**：`.then()` 在同 turn 内触发。`_pushEvent` 推到 Gateway，Gateway 的 `subscribedClients` 广播。但同 turn compact 可能已在 compactIfNeeded yield 过——此时 `_bgDone` 已被 `_onBgCompactDone` 内部 `_applyBgResult` 清掉，compactIfNeeded 不会再 yield 一次。subscriptedClients 广播一次 ✅
2. **`_onBgCompactDone` apply 成功 + events 推送，但前端没 subscribe**：前端下次刷新读 history.jsonl（已被 updateCompactRecord 写过）拿到终态 ✅
3. **`_onBgCompactDone` Apply 结果为空（NULL）** ：返回 null 时不做任何事情 → `_bgDone`/`_bgResult` 仍有效 → 下一轮 compactIfNeeded fallback 路径正常 apply ✅
4. **`_onBgCompactDone` 未注入（没有 events 通道 / 没有 agent._pushEvent）** ：返回 null → `_bgDone` / `_bgResult` 仍有效 → 下一轮 移动式compactIfNeeded 路径 正常 apply + yield。完全向后兼容 ✅
5. **Gateway 重启**：Agent 仍运行，GET /events 仍在。Gateway 重新 startAgent 探活后重新 connectAgentEvents ✅
6. **Agent 重启**：Gateway 的 GET /events 断开，connectAgentEvents 自动重连。中间丢失的 compact 事件靠 `_bgDone` fallback 在下一轮 compactIfNeeded 补报 ✅
7. **subscribeToStream 在无活跃流时保持连接**：不受 ctx.close 影响。前端断开时从 subscribedClients 移除。心跳靠 TCP keepalive ✅

---

## 6. 实现顺序

1. `shared/agent/server.js` 加 `GET /events` + `agent._pushEvent`
2. `gateway/chat_proxy.js` 加 `subscribedClients` + `subscribeToStream` 改为不关闭连接
3. `gateway/agent_events.js` 新文件：`connectAgentEvents`/`disconnectAgentEvents` + 自动重连
4. `gateway/process_manager.js`：注入 chatHistory 引用、startAgent 后 connect、_onAgentEvent 转发 + history
5. `shared/agent/message_manager.js`：`.then(r)` 加 `_onBgCompactDone`、`.catch` 加 `_onBgCompactError`
6. `shared/agent/default_agent.js`：`fromConfigDir` 注入两个回调
7. 手测：elf-001/003 后台压缩完成时前端气泡实时更新（无需刷新/无需等下一轮对话）
8. 回归全测试套