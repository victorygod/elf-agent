# AI 一键润色设定

## 1. 目标

在 Lore 实体编辑弹窗（角色/地点/物品/技能）中，name 下方加一个「✨ AI 润色」按钮，根据当前已填内容 + 上下文，生成符合世界观和风格的完整设定（description + 正文）。

## 2. 调用链路

```
┌─── 前端 ─────────────────────────────────────┐
│  name: 边境小镇  description: 玩家起始地...    │
│  [✨ AI 润色] → POST /polish-lore {type,name,description}
│  loading → 收到 { description, body } → 自动填充
└──────────────────┬───────────────────────────┘
                   ▼
┌─── gateway ─────────────────────────────────────┐
│  1. 读 config/system_prompt.md                  │
│  2. 读 runtime/lore/user_profile.md              │
│  3. 扫所有 lore 类型，每类型随机取 ≤2 文件       │
│  4. 组装单条 user 消息：                          │
│      世界观 + 主角面板 + 各类型交叉参考 + 当前条目 │
│  5. new LLMModel(config) → model.chat([sys,user])│
│  6. parseFrontmatter(body) 提取 {name,desc,body} │
│  7. 名前校验：name 不对则整条回退                 │
│  8. 返回 { ok, description, body }              │
└─────────────────────────────────────────────────┘
```

## 3. 上下文组装

### 3.1 数据来源

| 来源 | 路径 |
|---|---|
| 世界观基底 | `agents/<id>/config/system_prompt.md` 全文 |
| 主角面板 | `memory/runtime/lore/user_profile.md` 全文 |
| 各类型交叉参考（每类型 ≤2 个，随机） | `memory/runtime/lore/{characters,items,locations,skills}/` 排除自身 |
| 当前条目 | 请求体中的 name + description |

### 3.2 发给 LLM 的 messages

```
system:
你是一个 DND 跑团游戏的设定文档撰写助手。请根据以下上下文完善当前条目。

规则：
1. 不得修改条目名称——frontmatter 的 name 字段必须与已有 name 一致
2. 完善 description 和正文，使其充实、风格对齐
3. 包含外观、氛围、关键特征
4. 涉及其它 lore 条目时用其名提及
5. 与主角设定不冲突
6. 内容 200-800 字

输出格式：
- 完整的 Markdown 文件（含 frontmatter）
- frontmatter 含 name、description
- **正文直接写内容，不要标题行**
- 不额外解释

user:
## 世界观基底
[sysPrompt 全文]

## 主角面板
[userProfile 全文]

## 现存设定参考
### 角色
[characters/下随机 ≤2 个文件全文]

### 地点
[locations/下随机 ≤2 个文件全文]

### 物品
[items/下随机 ≤2 个文件全文]

### 技能
[skills/下随机 ≤2 个文件全文]

## ===== 当前要润色的条目 =====
名称：边境小镇
描述：玩家起始地，黄昏薄雾的边境小镇
```

### 3.3 返回值校验（后端）

```js
// 从 LLM 返回值 parse frontmatter
const { frontmatter, body } = parseFrontmatter(llmOutput);
// 名前校验：frontmatter name 必须与原名一致
if (frontmatter.name !== originalName) {
  // name 被改 → 整条结果不可信，返回原值
  return { ok: true, description: originalDescription, body: originalBody };
}
return { ok: true, description: frontmatter.description || '', body };
```

**name 被改即整条丢弃**——description 和正文全回退，防止连带污染。

## 4. 后端 API

### POST /agents/:id/polish-lore

请求体：`{ type, name, description }`

处理：见 §2 链路。读取 config 需 `fs.readFileSync`，非流式 LLM 调用。

响应：`{ ok, description, body }`

### import 路径

api.js 在 `agents/elf-018/ui/api.js`，LLMModel 在 `engine/models/llm.js`：

```js
import { LLMModel } from '../../../engine/models/llm.js';
```

路径与现有 `parseFrontmatter` import 同级。

模型配置从同目录 `config.json` 的 `model` 字段读取。

## 5. 前端改动（LoreEntityModal 新增）

| 改动点 | 说明 |
|---|---|
| name & description 之间加按钮 | `<button onClick={handlePolish}>✨ AI 润色</button>` |
| 调 API | `bridge.call('POST', '/polish-lore', { type, name, description })` |
| 加载态 | `[生成中…]` + disabled |
| 成功后 | `setDescription(res.description)` + `setBody(res.body)` |
| type 传递 | modal 已有 `type` prop（从父组件传入） |

## 6. 文件改动

| 文件 | 改动 |
|---|---|
| `agents/elf-018/ui/api.js` | 新增 POST /polish-lore handler + import LLMModel + 工具函数 |
| `agents/elf-018/ui/DnDChatView/GameSetupPanel.jsx` | LoreEntityModal 加按钮 + 调 API + 加载态 |
| `docs/elf-018-ai-polish-lore.md` | 本文 |