# 工具注册统一收口计划

## 目标

`config.json` 的 `tools` 数组成为**唯一真源**：列入即注册、未列入则不可用；一个 agent 的所有工具都能在配置里看到。消灭 `create_agent.js` 内散落的手动注册。

## 现状问题

| # | 问题 | 位置 |
|---|------|------|
| 1 | **双通道注册**：仅部分工具走 config.json 自动注册，另一部分在 create_agent.js 手动 `toolManager.register()` | `engine/build_agent.js:49-68` vs `agents/elf-018/create_agent.js:56-63` |
| 2 | **有状态工具无法走配置**：`WriteOutline`/`EditOutline`/专版 `Read/Write/Edit` 是工厂构造、闭包持有 agent 实例，而自动注册发生在 `new Agent` 之前、拿不到 agent | `build_agent.js:74` |
| 3 | **同名覆盖隐式、依赖顺序**：本地专版覆盖中央通用，靠"先注册通用、后 register 同名覆盖"实现（Map 同 key `set`，见 `tool_manager.js:40`），读配置看不出有覆盖 | `create_agent.js:61-63` |
| 4 | **配置可读性失真**：tools 数组读起来只有 5 个工具，实际在线 10 个，日志/调试心智负担大 | `elf-018/config/config.json:37-43` |

## 方案

### 1. tools 数组升级为唯一入口

```jsonc
// agents/elf-018/config/config.json
"tools": [
  "Read",         // 本地专版（makeRead）自动覆盖中央 Read
  "Grep",         // 中央通用，无本地版
  "Write",
  "Edit",
  "Roll",         // 本地专属（静态导出对象）
  "WriteOutline", // 本地专属（makeWriteOutline 工厂）
  "EditOutline"
]
```

**语义：** 数组里写什么就是什么，未列入的一律不注册、不暴露给 LLM。手动注册调用全部删除。

### 2. build_agent 统一解析（单份列表、两阶段自动分流）

按名字查找顺序（**优先级：本地 > 中央**）：

```
agents/<id>/tools/<name>.js
    ① 存在 make<Name>(agent) 工厂函数  → 阶段 2（new Agent 后传 agent 注册）
    ② 存在 <Name> 静态工具对象         → 阶段 1 注册（覆盖中央同名）
    ③ 都没有
engine/tools/index.js
    ③ 存在 <Name>                      → 阶段 1 注册（通用）
    ④ 都没有                           → warn 跳过（未注册不可用）
```

- **阶段 1（new Agent 前）：** 静态工具。保持现状路径，但解析顺序改为"本地优先、中央回退"。
- **阶段 2（new Agent 后、返回前）：** 收集到的工厂统一 `register(make<Name>(agent))`。
- 同名覆盖天然成立：阶段 1 注册了中央 `Read`，阶段 2 的 `makeRead(agent)` 用 Map 同 key 覆盖成专版，`getAll` 只返回一份（现有 `tool_manager.js` 语义不用改）。

### 3. 导出约定（本地工具文件统一二选一）

| 产物 | 形态 | 何时用到 |
|------|------|----------|
| 静态工具 | `export const <Name> = { name, description, parameters, execute }` | 无状态，如 `Roll` |
| 工厂工具 | `export function make<Name>(agent) { return { ... } }` | 有状态，需要 agent（路径/轮次），如 `WriteOutline` |

两个符号同时导出则工厂优先（有状态版总是能 hold agent）。

## 落地步骤

1. `engine/build_agent.js`：把 tools 解析改成"本地优先两阶段"（先扫本地 `<name>.js` 的 `make<Name>`/`<Name>`，再回退中央）；收集工厂，new Agent 后注册。
2. `agents/elf-018/create_agent.js`：删除第 56-63 行手动注册，移除对应 import。
3. `agents/elf-018/config/config.json`：tools 数组补 `WriteOutline`、`EditOutline`。
4. 检查其它 agent 的 `create_agent.js`（目前仅 elf-018 有手动注册，无遗留）。
5. 测试：
   - 新增断言：**未列入 config.json 的工具不出现在 getAll / execute 返回 `[错误: 工具不存在]`**。
   - 回归：`test/dm-agent.test.js` 里 outline loop 的 WriteOutline→Write 维护用例应零改动通过（注册时序与本地优先级一致）。
6. 验证：`node --test` 全量回归。

## 影响与收益

- **单一真源**：想给 agent 加工具 = 改配置；删工具 = 从配置移除（`CLAUDE.md` "No backward compatibility" 吻合）。
- **优先级语义显式**：本地专版 > 中央通用，写在解析逻辑里，不再靠手动 register 顺序。
- **消除"迷之在线工具"**：配置即全量清单，LLM 拿到的 tools（`getAll`）永远 ⊂ config.tools。
- 代价：build_agent 需维护两阶段注册，但工厂汇总表只有一张（本地目录扫描）。

## 边界（本期不做）

- 不动 run-level 临时工具（`registerRunLevel`/`withDisabled`）语义，非持久注册不属此范围。
- 不做 tools 注册表的运行期热重载（如需另外单列）。