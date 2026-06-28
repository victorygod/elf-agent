# 前端流式响应中断 Bug 分析（已修复）

**修复日期**：2026-06-24
**状态**：✅ 已修复
**修复方式**：所有 SSE 事件 handler 改为创建新对象引用，flushRaf 中 map 新 bubbles

## 现象

前端不再逐字输出文字（流式效果消失），而是等全部回复完成后一次性显示，或整个回复完全不显示。
用户消息发送后立即出现，但 Agent 的回复内容不会实时更新。

## 数据流

```
LLM API → agent.js (yield token) → agent server (SSE) → gateway chat_proxy (broadcast)
→ frontend api/index.js (SSE reader) → useChat._handleSSEEvent (事件处理)
→ zustand store (状态更新) → React 组件渲染
```

## 根因分析

### 核心问题

`frontend/src/hooks/useChat.js` 中**所有** SSE 事件处理器都从 Zustand store 取出 `activeTurn` 对象，**直接原地修改（mutate）其属性**，然后把同一个对象引用传回 `patchChat()`。Zustand 通过**引用相等（reference equality）** 判断状态是否变化，因引用没变，React 跳过重渲染。

### 受影响的 SSE 事件

| 事件 | 代码位置 | 问题 |
|------|---------|------|
| `token` | 第 98-123 行 | `at.assistantBubbles.push(...)` mutate 数组 + rAF 中 `bubble.content += ...` mutate 内容，`patchChat({ activeTurn: at })` 传同一引用 |
| `tool_call` | 第 126-149 行 | `at.assistantBubbles.push(...)` + `lastBubble.toolCalls.push(...)`，`patchChat({ activeTurn: at })` 传同一引用 |
| `tool_result` | 第 152-169 行 | 直接修改 `lastBubble.toolCalls[idx].status`，`patchChat({ activeTurn: at })` 传同一引用 |
| `compact_start` | 第 176-192 行 | `at.assistantBubbles.push(...)`，`patchChat({ activeTurn: at })` 传同一引用 |
| `compact` | 第 195-206 行 | 直接修改 `lastBubble2.compactSummary`，`patchChat({ activeTurn: at2 })` 传同一引用 |
| `compact_error` | 第 209-220 行 | 直接修改 `lastBubble3.compactError`，`patchChat({ activeTurn: at3 })` 传同一引用 |

### 为什么 UI 不更新

```js
// _patchChat（agentStore.js 第 130-136 行）
_patchChat: (agentId, updates) => {
  const chats = new Map(get().chats);
  const chat = chats.get(agentId);
  if (!chat) return;
  chats.set(agentId, { ...chat, ...updates });  // chat 对象是新引用
  set({ chats });                                // chats Map 也是新引用
},
```

`_patchChat` 确实产生了**新的 `chats` Map 和新的 chat 外层对象**，所以 Zustand 的 `set()` 会通知所有 subscriber 重新执行 selector。

但 `ChatPanel.jsx` 的 selector 提取的是深层字段：

```js
// ChatPanel.jsx 第 127 行
const activeTurn = useAgentStore(
  useCallback(state => state.chats.get(agentId)?.activeTurn ?? null, [agentId])
);
```

每次 `_patchChat` 调用后，这个 selector 重新执行：
- `state.chats` → 新 Map ✅（变了）
- `.get(agentId)` → 新 chat 对象 ✅（因为 `{ ...chat, ...updates }`）
- `?.activeTurn` → **同一个被 mutate 的对象** ❌（`updates.activeTurn` 就是原来那个 `at`）

React 用 `Object.is` 比较旧值和新值，发现引用相同，**跳过重渲染**。

此外，`TurnView` 被 `React.memo` 包裹（第 73 行），即使父组件渲染了，`React.memo` 对 `turn={activeTurn}` 做浅比较，发现 `turn` 引用没变，也**不会重渲染**。

### 旧代码同样有问题

经 git 确认，旧代码（53f15fa 之前）就已经有 rAF batching 和同样的 mutate 逻辑：

```js
// 旧代码（53f15fa^）
pendingContentRef.current += data.content;
pendingUpdateRef.current = { activeTurn: at, queuedUserMessages: [...queuedUserMessagesRef.current] };
```

旧代码只是多传了一个 `queuedUserMessages` 新数组，`activeTurn` 本身也还是 mutate 后的同一引用。所以**旧代码应该也存在同样的问题**，并非 rAF 引入的新 bug。

### 为什么问题现在才暴露/变严重

可能的原因：

1. **API 调用链路变化**：旧版的 `_handleSSEEvent` 在 token handler 末尾没有特殊操作，但新版（53f15fa）将 token 事件的 patchChat 全部移到 rAF 回调中，使问题更明显。
2. **TyppingIndicator 被移除**：旧版 `send()` 中预先创建了 `typing: true` 的 bubble，让用户至少能看到"打字中"的动态效果。新版移除了 typing bubble（第 267-269 行注释明确说明"不预先创建 typing bubble"），所以第一个 token 到达前 UI 完全没有任何回复迹象。
3. **`finalizeActiveTurn` 触发时机**：旧版 `done` 事件后可能还有 `idle` 事件触发历史刷新，新版 `finalizeActiveTurn` 只读 `getChat()` 取到的 `activeTurn`，这个引用可能在被 React 渲染前就被覆盖。

但核心不变：**引用不可变性被违反是所有 SSE 事件都无法实时渲染的根本原因。**

## 涉及文件

- `frontend/src/hooks/useChat.js` — 所有 SSE 事件处理器 + flushRaf 函数
- `frontend/src/stores/agentStore.js` — _patchChat 函数
- `frontend/src/components/ChatPanel.jsx` — React.memo TurnView + useSelector
- `frontend/src/api/index.js` — SSE 解析层（无问题）
- `gateway/chat_proxy.js` — 代理层 broadcastChunk（无问题）
- `agents/elf-001/agent.js` — LLM token 生成 yield（无问题）

## 修复方案

### 方案一（推荐）：创建新对象引用

核心思路：不让 `patchChat` 拿到 mutate 后的同一引用，而是每次都构造新对象。

```js
// flushRaf
const flushRaf = useCallback(() => {
  if (rafIdRef.current) {
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = null;
  }
  const update = pendingUpdateRef.current;
  if (!update) return;

  const at = update.activeTurn;
  if (!at) {
    pendingContentRef.current = '';
    pendingUpdateRef.current = null;
    return;
  }

  // ★ 创建新的 assistantBubbles 数组，最后一个 bubble 包含累积的内容
  const newBubbles = at.assistantBubbles.map((b, i) => {
    if (i === at.assistantBubbles.length - 1 && pendingContentRef.current) {
      return { ...b, content: b.content + pendingContentRef.current };
    }
    return { ...b };
  });

  patchChat({
    activeTurn: { ...at, assistantBubbles: newBubbles },
  });

  pendingContentRef.current = '';
  pendingUpdateRef.current = null;
}, [patchChat]);
```

所有直接 mutate 的 SSE handler 同理，改为创建新对象：

```js
case 'tool_call': {
  // ...
  const newBubble = {
    ...lastBubble,
    toolCalls: [...(lastBubble.toolCalls || []), ...toolCallsSummary.map(tc => ({ ...tc, status: 'executing' }))],
  };
  const newBubbles = [...at.assistantBubbles.slice(0, -1), newBubble];
  patchChat({ activeTurn: { ...at, assistantBubbles: newBubbles } });
  break;
}
```

### 方案二：去掉 rAF batching，每次 token 直接 patch

去掉 rAF 积累，每个 token 事件立即构造新引用并 patch。简单直接，但高频渲染可能影响性能。

### 方案三：用 Zustand `replace` 强制更新

```js
useAgentStore.setState({ chats: newChats }, true);  // replace=true 完全替换
```
不推荐，治标不治本，且可能破坏其他依赖 immmer/reference 的特性。

## 排查时间

2026-06-24