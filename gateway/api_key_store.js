/**
 * 全局 LLM API 管理模块
 * 负责读写 config/api_key.json（包含 models 数组）。config/ 集中放平台级全局配置。
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';

let _rootDir = null;
export function setApiKeyStoreRootDir(dir) {
  _rootDir = dir;
}

function getApiKeyFile() {
  return path.join(_rootDir || process.cwd(), 'config', 'api_key.json');
}

/**
 * 一次性搬迁：旧根下 api_key.json → config/api_key.json（仅旧存在且新不存在时）。
 * 模块加载时调一次（生产启动搬迁）；测试 setApiKeyStoreRootDir(tmp) 后直接在 tmp/config 建文件，不触发。
 */
function migrateApiKeyFile() {
  const root = _rootDir || process.cwd();
  const old = path.join(root, 'api_key.json');
  const dir = path.join(root, 'config');
  const cur = path.join(dir, 'api_key.json');
  if (fs.existsSync(old) && !fs.existsSync(cur)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(old, cur);
      logger.info('已迁移 api_key.json → config/');
    } catch (e) {
      logger.warn(`迁移 api_key.json 失败: ${e.message}`);
    }
  }
}
migrateApiKeyFile();

let logFileName = null;
export function setApiKeyStoreLogFileName(name) {
  logFileName = name;
}

const logger = createLogger('api-key-store', logFileName);

/**
 * 读取全局模型库
 * @returns {Array} models 数组
 */
export function readGlobalModels() {
  try {
    const content = fs.readFileSync(getApiKeyFile(), 'utf-8');
    const data = JSON.parse(content);
    return data.models || [];
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn('api_key.json 不存在，返回空数组');
      return [];
    }
    logger.error(`读取 api_key.json 失败: ${err.message}`);
    throw err;
  }
}

/**
 * 写入全局模型库
 * @param {Array} models - models 数组
 */
export function writeGlobalModels(models) {
  const file = getApiKeyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ models }, null, 2), 'utf-8');
  logger.info(`已写入 ${models.length} 个模型配置`);
}

/**
 * 按 model_id 解析出可直接喂给 LLMModel 的 model 配置。
 * 单一真相源：gateway 的 readAgentConfig 与 engine 的 Config.load 共用，避免两套解析逻辑漂移。
 *
 * model_params 展平到 model 顶层（而非嵌套 params 对象），与 LLMModel.extractExtraParams 契约一致——
 * extraParams 会把 base_url/auth_token/model 之外的字段原样透传到请求 body 顶层。
 *
 * @param {object} opts
 * @param {string} [opts.model_id]   - 引用全局库的模型 id（可选）
 * @param {string} [opts.provider]   - 'llm' | 'mock'
 * @param {object} [opts.model_params] - 模型特定参数，展平进 model 顶层
 * @param {boolean} [opts.useMock]   - provider==='mock' 或 ELF_FORCE_MOCK_MODEL 时 true
 * @returns {{ model: object, modelError: string|null }}
 */
export function resolveModelConfig({ model_id, provider, model_params, useMock } = {}) {
  const params = model_params || {};

  if (useMock) {
    return { model: { provider: 'mock' }, modelError: null };
  }

  const baseProvider = provider || 'llm';

  if (!model_id) {
    // model_id 为空：返回空 model 对象，由 LLMModel.chatStream 在发起请求时检查完整性
    return {
      model: { provider: baseProvider, base_url: undefined, auth_token: undefined, model: undefined, ...params },
      modelError: null,
    };
  }

  const modelConfig = readGlobalModels().find(m => m.model_id === model_id);
  if (!modelConfig) {
    return {
      model: { provider: baseProvider, base_url: undefined, auth_token: undefined, model: undefined, ...params },
      modelError: `模型 ${model_id} 不存在于全局 LLM API 管理中`,
    };
  }

  return {
    model: {
      provider: baseProvider,
      base_url: modelConfig.base_url,
      auth_token: modelConfig.auth_token,
      model: modelConfig.model,
      ...params,
    },
    modelError: null,
  };
}