# 多轮拆分方案：assistant 消息按产出分条记录

## 目标

Agent Loop 多轮迭代时，每轮 LLM 产出存为独立的 JSONL 记录。
前端将相邻 assistant 记录合并渲染到同一个气泡，内部元素按记录顺序排列（先到先排）。
tool_result 的成功/失败/错误信息持久化在对应轮次记录的 toolCalls 里。
刷新后渲染效果和实时流一致。

## 改动清单

### agent.js — 0改动
不改 agent，不加额外事件。利用 SSE 流里已有的自然边界。

### chat_proxy.js — 改 flush 逻辑（不发 round_end）
- 删掉 `hasFlushed` 保护，允许多次 flush
- 加 `pendingToolCount` 计数器：
  - `tool_call` push N 个工具 → += N
  - `tool_result` 到达 → -= 1
  - `pendingToolCount` 降到 0 且 `assistantToolCalls.length > 0` → flush 当前轮产出为一条 JSONL，清空内存变量
- 不向客户端发送 `round_end` SSE 事件（前端用 tool_result 语义自行判断轮次边界）
- `compact` / `compact_error` → 存 assistantExtraFields
- `done` → 最终 flush（带 compactSummary）
- 无 tool_call 的纯文本轮 → 不触发中途 flush，done 时统一 flush

### useChat.js — 加 allToolResultsReceivedRef（不依赖 round_end 事件）
- 加 `allToolResultsReceivedRef = useRef(false)`
- `tool_result` case：更新 toolCalls[idx].status 后检查所有 tool 是否都不是 executing → ref = true
- `token` / `tool_call` case：if ref=true → 重置 streamingStartedRef=false 和 allToolResultsReceivedRef=false，正常处理会自动创建新消息壳
- 不依赖 chat_proxy 发送的 `round_end` 事件——即使 tool_result 和下一轮的 tool_call 在同一个 chunk 里到达，前端也能正确处理（先处理 tool_result 标记 ref=true，然后处理 tool_call 时切壳）
- 其他 case 不变

### ChatPanel.jsx — 分组渲染
- 遍历 history 时将连续 assistant 消息合并为一个 AssistantGroup（一个 avatar + 多个渲染段）
- user / system 照旧单独渲染

### MessageBubble.jsx — 微调
- 单条消息渲染不变（content + toolCalls + compact）
- Group 内的 assistant 消息不带 avatar

### chat_history.js — 删废弃方法
删除 `appendToolResult` 和 `updateLastMessage`，保留 `addMessage`（已支持 toolCalls + extraFields）

### 测试
- 修 agent.test.js 2个旧 failure
- 新增多轮 flush 测试
- 确保 100% pass

## JSONL 记录示例

```jsonl
{"id":"msg_1","role":"user","content":"帮我写个文件","ts":"..."}
{"id":"msg_2","role":"assistant","content":"正在帮你读取文件","toolCalls":[{"name":"Read","args":{...},"description":"读取 /tmp/a","status":"success"}],"ts":"..."}
{"id":"msg_3","role":"assistant","toolCalls":[{"name":"Write","args":{...},"description":"写入 /tmp/a","status":"success"}],"ts":"..."}
{"id":"msg_4","role":"assistant","content":"文件已写入完毕","compactSummary":500,"ts":"..."}
```

## 场景验证清单

1. 回复到一半刷新 → 轮询恢复，JSONL 里已有 user + 已完成轮次的 assistant 记录，后续轮次追加
2. 回复前刷新 → 没有进行中的流，JSONL 里的历史完整加载
3. 回复后刷新 → 所有轮次记录完整，compactSummary 在最后一条
4. 多条消息场景 → 两次 send 产出两组 JSONL 记录，前端正确分组
5. 回复中用户输入新消息 → pendingMessages 排队，当前流结束后递归发送
6. abort 中途 → 未完成的内容留在当前 streaming 消息里，JSONL flush 第一轮已完成的
7. 纯文本轮（无 tool call）→ 不触发中途 flush，done 时统一写一条记录
8. 工具失败 → toolCalls 带 status:error + message，刷新后正确红色显示
9. compact 在最后一轮 → compactSummary 附着在最后一条 JSONL 记录
