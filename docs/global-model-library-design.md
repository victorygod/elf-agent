# 全局模型库设计方案

## 概述

将 Agent 的模型配置（base_url、auth_token、model）从单个 Agent 的 `api_key.json` 迁移到全局配置中，Agent 只需从 LLM API 管理中选择模型，并可选配置模型特定参数。

## 核心变更

### 1. 全局模型库（项目根目录 api_key.json）

新建项目根目录 `api_key.json`，存储所有模型配置：

```jsonc
{
  "models": [
    {
      "model_id": "gpt-4o",
      "base_url": "https://api.openai.com/v1",
      "auth_token": "sk-xxx...",
      "model": "gpt-4o",
      "params_schema": { ... }
    }
  ]
}
```

**字段**：
- `model_id`：唯一标识，作为索引
- `base_url`、`auth_token`、`model`：API 连接信息
- `params_schema`：该模型支持的额外参数定义（可选）

**注意**：文件已加入 `.gitignore`，不提交到版本控制。

### 2. Agent 配置简化

Agent 的 `config.json` 简化为：

```jsonc
{
  "agentId": "elf-001",
  "model_id": "gpt-4o",
  "model_params": { "effort": "high" }
}
```

**变更**：
- 移除 `agents/*/config/api_key.json` 文件（完全废弃）
- `model_id`（可选，引用 LLM API 管理中的模型）
- `model_params`（可选，配置模型特定参数）

### 3. 前端 UI 变化

#### Sidebar 全局设置 - LLM API 管理

新建「LLM API 管理」页面，功能布局：

**模型列表**：
- 表格展示：model_id、base_url、model、操作列
- 操作按钮：编辑、删除、测试连接

**新增/编辑模型**：
- 模态框或侧边抽屉
- 表单字段：
  - model_id（必填，唯一性校验）
  - base_url（必填）
  - auth_token（必填，密码类型显示）
  - model（必填）
  - params_schema（JSON 编辑器，可选）
- 底部按钮：取消、保存

**注意**：不提供测试连接功能（移除原设计中的测试连接按钮）

#### Agent 配置面板 - 模型配置 Tab

「模型配置」tab 重新设计：

**模型选择区域**：
- 下拉选择框：从 LLM API 管理中选择 model_id
- 显示选中模型的：base_url、model（只读）
- 「跳转到 LLM API 管理」链接

**参数配置区域**（条件渲染）：
- 仅当选中模型的 `params_schema` 存在时显示
- 根据选中模型的 `params_schema` 动态生成表单
- 支持字段类型：text、number、select、checkbox
- 显示标签、提示文本（hint）、默认值

**移除内容**：
- 删除原有的 base_url 输入框
- 删除原有的 auth_token 输入框
- 删除原有的 model 输入框

### 4. 后端变更

#### 新增全局配置模块

新建 `gateway/api_key_store.js`：
- `readGlobalModels()`：读取根目录 `api_key.json` 中的 `models` 数组
- `writeGlobalModels(models)`：写入 `models` 数组

#### config-store.js 调整

修改 `readAgentConfig()`：
- 支持 `model_id` 字段（可选）
- `model_id` 存在时：从 LLM API 管理查找对应配置
- `model_id` 不存在时：返回空的 model 对象（base_url、auth_token、model 均为 undefined）
- 仅 `provider === 'mock'` 或 `ELF_FORCE_MOCK_MODEL === '1'` 时强制使用 mock 模式
- 移除读取 `agents/*/config/api_key.json` 的逻辑

#### engine/models/llm.js 调整

在 `chatStream()` 中添加配置完整性检查：
- 检查 `base_url` 是否为空或空字符串
- 检查 `auth_token` 是否为空或空字符串
- 检查 `model` 是否为空或空字符串
- 任一字段为空时抛出错误：`LLM 配置不完整：{字段名} 未设置，请在 Agent 配置中选择模型或配置 {字段说明}`

#### Gateway API

新增路由：
- `GET /api/models`：获取 LLM API 管理中的模型列表
- `PUT /api/models`：更新 LLM API 管理中的模型列表

### 5. 参数定义 Schema

`params_schema` 定义模型支持的额外参数：

**字段类型**：`text` | `number` | `select` | `checkbox`
**可选字段**：`hint`（提示文本）、`default`（默认值）、`options`（select 选项）

## 配置要求

| 场景 | 行为 |
|------|------|
| `model_id` 为空 | 返回空的 model 对象（base_url、auth_token、model 均为 undefined），不报错 |
| `model_id` 存在但引用不存在的模型 | 返回 `modelError` |
| `model_id` 必须全局唯一 | 添加模型时校验，重复则拒绝 |
| `provider === 'mock'` | 强制使用 MockModel，忽略 model_id |
| `ELF_FORCE_MOCK_MODEL === '1'` | 强制使用 MockModel，用于测试 |
| 发起 LLM 请求时配置不完整 | 在 `chatStream` 中抛出错误，提示用户在 Agent 配置中选择模型 |
| `agents/*/config/api_key.json` 完全废弃 | 不再读取，可直接删除 |
| 根目录 `api_key.json` 可选 | 不存在时 Agent 可正常运行（但无法发起 LLM 请求） |

## 当前实现状态

### 已完成

1. ✅ **后端基础设施**
   - 新建 `gateway/api_key_store.js`：全局模型库读写
   - 修改 `gateway/config-store.js`：支持 `model_id`，移除 `api_key.json` 逻辑
   - 添加 Gateway API：`GET /models`、`PUT /models`
   - 修改 `engine/models/llm.js`：在 `chatStream` 中添加配置完整性检查
   - 新建 `api_key.json` 示例文件（项目根目录，已 gitignore）

2. ✅ **测试覆盖**
   - `api_key_store.test.js`：5/5 通过
   - `gateway.config-store.test.js`：12/12 通过
   - 测试覆盖了所有关键场景

3. ✅ **前端 UI**
   - `LLMManager.jsx`：Sidebar 的 LLM API 管理组件
   - `LLMManager.module.css`：样式文件
   - 修改 `ConfigDrawer.jsx`：
     - 模型选择下拉框（从全局模型库加载）
     - 显示选中模型的 base_url、model（只读）
     - 参数区域条件渲染（`params_schema` 存在时才显示）
     - 移除旧的 base_url、auth_token、model 输入框
   - 修改 `useConfig.js`：
     - 初始化 `formData` 时加载 `model_id` 和 `model_params.*`
     - 保存时处理 `model_id` 和 `model_params`
   - 修改 `Sidebar.jsx`：
     - 添加「LLM API 管理」入口（仅 admin 可见）
     - 集成 LLMManager 组件
   - 前端构建成功

### 待完成

1. ⏳ **Gateway 测试**：23/24 通过，有 1 个测试失败（需要排查）
2. ⏳ **文档更新**：更新 README 和配置文档
3. ⏳ **升级指南**：提供从旧配置迁移到新配置的步骤
4. ⏳ **前端功能验证**：完整测试模型管理、参数配置等功能
5. ⏳ **清理旧文件**：删除 `agents/*/config/api_key.json` 文件

### 关键设计决策

1. **`model_id` 可选而非必填**：
   - 允许系统在没有 `api_key.json` 时正常运行
   - Agent 可以正常启动，只是在 LLM 调用时才检查配置

2. **配置检查延迟到 LLM 调用时**：
   - 不在配置读取时报错（`readAgentConfig`）
   - 在 `LLMModel.chatStream()` 中检查配置完整性
   - 错误提示具体且清晰

3. **错误提示清晰**：
   - `LLM 配置不完整：base_url 未设置，请在 Agent 配置中选择模型或配置 API 地址`
   - `LLM 配置不完整：auth_token 未设置，请在 Agent 配置中选择模型或配置 API 密钥`
   - `LLM 配置不完整：model 未设置，请在 Agent 配置中选择模型或配置模型名称`

4. **不提供测试连接功能**：
   - 简化 LLM API 管理界面
   - 移除原设计中的测试连接按钮

5. **完全移除向后兼容**：
   - 不再读取 `agents/*/config/api_key.json`
   - 不提供迁移工具（直接新配置）

6. **Mock 模式仅限特定场景**：
   - `provider === 'mock'`：使用 MockModel
   - `ELF_FORCE_MOCK_MODEL === '1'`：强制使用 MockModel（测试环境）
   - `model_id` 为空时不自动使用 mock（保持 llm provider）

## 实施步骤

### 阶段 1：后端基础设施

1. 新建项目根目录 `api_key.json`（示例数据）
2. 新建 `gateway/api_key_store.js`：全局模型库读写
3. 调整 `config-store.js`：支持 `model_id`，移除旧逻辑
4. 添加 Gateway API：模型管理路由
5. 更新 `.gitignore`：确认 `api_key.json` 已加入

### 阶段 2：前端 UI

1. Sidebar 扩展：添加「LLM API 管理」入口和对应页面组件
2. ConfigDrawer 调整：修改「模型配置」tab，移除旧输入框，新增模型选择和参数配置
3. API 集成：添加前端调用模型管理 API 的函数

### 阶段 3：测试

测试场景：
- 新增模型（model_id 唯一性校验）
- 编辑/删除模型
- params_schema 为空时不显示参数配置区域
- params_schema 存在时正确渲染参数表单
- Agent 选择模型并配置参数
- `model_id` 为空时返回空的 model 对象（不报错）
- `model_id` 为空且发起 LLM 请求时抛出配置不完整错误
- `model_id` 引用不存在的模型时设置 modelError
- `ELF_FORCE_MOCK_MODEL=1` 强制使用 mock 模式
- `provider === 'mock'` 使用 MockModel
- 没有 `api_key.json` 时 Agent 可正常启动（但无法调用 LLM）

### 阶段 4：清理与文档

1. 前端清理：移除旧的 API 配置输入框
2. 清理旧文件：删除 `agents/*/config/api_key.json`
3. 文档更新：更新 README 和配置文档
4. 升级指南：说明如何从旧配置迁移

## 优势

1. **配置集中化**：API 凭据统一管理，方便更新和审计
2. **安全性提升**：敏感信息集中存储并 gitignore
3. **用户体验提升**：新增 Agent 无需重复填写 API 配置
4. **参数扩展性**：模型可定义特定参数，无需修改核心代码
5. **简洁清晰**：model_id 即索引，无冗余字段

## 后续扩展

1. **权限控制**：基于用户角色限制可用模型
2. **模型分组**：支持模型标签或分类
3. **使用统计**：记录各模型调用次数
4. **自动降级**：模型不可用时自动切换备用模型
5. **密钥加密**：对 `auth_token` 进行加密存储

## 实施总结

### 核心设计变更

1. **集中化配置**：所有模型配置存储在项目根目录的 `api_key.json` 中
2. **Agent 简化**：Agent 只需引用 `model_id`，不再维护独立的 `api_key.json`
3. **延迟检查**：配置完整性检查推迟到 LLM 调用时，允许 Agent 正常启动
4. **清晰提示**：配置缺失时给出具体的错误信息和操作指引

### 技术实现

- **后端**：新增 `api_key_store.js`，修改 `config_store.js` 和 `llm.js`
- **前端**：新增 `LLMManager.jsx`，修改 `ConfigDrawer.jsx`、`useConfig.js`、`Sidebar.jsx`
- **测试**：17/17 测试通过（2 个测试文件）

### 兼容性

- **不向后兼容**：完全移除对 `agents/*/config/api_key.json` 的读取
- **渐进式升级**：可以在没有 `api_key.json` 时正常运行，只是无法调用 LLM

---

**文档版本**：1.1  
**创建日期**：2025-08-07  
**最后更新**：2025-08-07  
**作者**：Elf Team