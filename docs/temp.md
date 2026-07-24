1. 提示词注入，可以就在system后面（和system提示词合）加一个当前场景的section
2. 然后提示词还有很多注入的场景，比如在最近一个user消息前注入、在最近一个user消息后注入（区分是合并消息还是单独一条，是否有类似is_meta等属性）
3. abort_flow可以放到harness里么？runAborable这种可否变成装饰器写起来简单一些，然后业务上语意明确一些？
4. _enterRunLevel放在哪里比较合适？harness？插件？
5. agent的_mw、_dispatchGate、_emit、_runInjection是否真的需要？可否直接内联？updateModel、updateMessageManagerConfig、abort等是否应该放到harness里？重新评估一下harness应该有什么作用吧
6. 群聊里怎么不按照agent的配置进行压缩呢？
7. 现在context和history分散在chat和room目录下，且解散群聊之后不知道删的哪个目录。我们这样吧：context、tool-results、checkpoints、sync_cursor都放在agent/data目录下，history.jsonl、room.json这种房间的专属配置可以放在rooms里，实际上这些都属于profiles，也就是说agents目录和rooms目录以及logs目录应该都放在profiles目录（需要新建）下。
8. 关于skills，我们不要再支持多目录了，就统一放在一个目录里好了，就是现在哪个~/.elf那里。
9. 群聊/私聊里llm请求失败为啥没有3次重试呀？怎么感觉只有compact有？这东西不应该在llm_model里流式/非流失都做3次重试吗？
10. 私聊里的history.jsonl的格式怎么改了？现在前端刷一下全都乱了。你翻一下git log，很早以前的agents/elf-002/data/history.jsonl的格式是什么样的。我大概给你讲一下，是具有高度时序性的，和流式聊天的前端渲染出来的顺序保持高度统一的，每条消息都是一行，然后需要更新的消息不重复存多行，比如多次重试的compact就只存一条，然后field里填写重试第几次。每个assistant消息都需要存独立的一条，即使content为null或“”也得存，tool call和tool result存在一起（你看看以前，应该是的）实在找不到的话可以看下docs/example/history.jsonl，是一个例子