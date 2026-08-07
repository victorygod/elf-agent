/**
 * 配置加载器
 *
 * 读取 config/ 目录下的 config.json：
 * - config.json 中 type:"path" 字段自动读取对应文件内容
 * - model 配置按 model_id 从全局 LLM API 管理（项目根 api_key.json）解析
 *   （解析逻辑收口在 api_key_store.resolveModelConfig，与 gateway 共用同一真相源）
 * - model_params 展平进 model 顶层，LLMModel.extractExtraParams 据此透传到请求 body
 * - 支持热重载: load() 可重复调用
 * - 支持写回: writeAgentConfig() 保留 path 声明，内容写文件
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { resolveModelConfig } from '../gateway/api_key_store.js';

let logFileName = null;

/**
 * 设置日志文件名（由 start.js 在启动时调用）
 */
export function setLogFileName(name) {
  logFileName = name;
}

/** model 必填字段（用于 LLM 调用前的完整性检查） */
const MODEL_REQUIRED_FIELDS = ['base_url', 'auth_token', 'model'];

export class Config {
  constructor(configDir) {
    this.configDir = configDir;
    this.data = {};
    this._pathFields = new Set();  // 记录哪些字段是 type:"path"，用于 writeAgentConfig
  }

  /**
   * 加载配置：读取 config.json，按 model_id 解析全局模型
   * - config.json 中值为 { type: "path", content: "filename" } 的字段，自动读取文件内容
   * - model_id 为空时返回空 model 对象（base_url/auth_token/model 均为 undefined），由 LLMModel.chatStream 检查
   * - model_id 引用不存在的模型时设置 modelError
   */
  load() {
    const logger = createLogger('config', logFileName);
    try {
      const configPath = path.join(this.configDir, 'config.json');
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // 遍历 config.json 的每个字段，发现 type:"path" 就读文件内容
      this._pathFields.clear();
      for (const [key, value] of Object.entries(raw)) {
        if (value && typeof value === 'object' && value.type === 'path') {
          this._pathFields.add(key);
          const filePath = path.join(this.configDir, value.content);
          try {
            raw[key] = fs.readFileSync(filePath, 'utf-8');
          } catch (err) {
            logger.warn(`无法读取 path 文件: ${filePath}, ${err.message}`);
            raw[key] = '';
          }
        }
      }

      // 全局 api_key.json 的根目录由 api_key_store 解析：回退到 process.cwd()（生产 cwd=项目根），
      // 或由 gateway/测试启动时显式 setApiKeyStoreRootDir 设定。这里不再覆盖，避免与 gateway 冲突。
      // ELF_FORCE_MOCK_MODEL=1（测试用）强制 provider=mock，不起真实 LLM 请求、不校验必填。
      const useMock = raw.provider === 'mock' || process.env.ELF_FORCE_MOCK_MODEL === '1';
      const { model, modelError } = resolveModelConfig({
        model_id: raw.model_id,
        provider: raw.provider,
        model_params: raw.model_params,
        useMock,
      });
      raw.model = model;
      if (modelError) raw.modelError = modelError;

      logger.info(`模型配置已加载 (model=${model.model || '(未配置)'})`);
      this.data = raw;
      logger.info(`配置已加载: agentId=${raw.agentId}`);
    } catch (err) {
      logger.error(`配置加载失败: ${err.message}`);
      throw err;
    }
  }

  /**
   * 检查 model 必填字段是否全部填写
   * @returns {string[]|null} 缺失字段列表，全部填写则返回 null
   */
  getModelMissingFields() {
    const model = this.data.model || {};
    const missing = MODEL_REQUIRED_FIELDS.filter(k => !model[k]);
    return missing.length > 0 ? missing : null;
  }

  /**
   * 配置解析时的错误（如 model_id 引用不存在的模型）
   * @returns {string|null}
   */
  getModelError() {
    return this.data.modelError || null;
  }

  /**
   * 获取配置项
   */
  get(key) {
    return this.data[key];
  }

  /**
   * 获取完整的 Model 配置
   */
  getModelConfig() {
    return this.data.model || {};
  }

  /**
   * 获取完整配置数据
   */
  getAll() {
    return { ...this.data };
  }

  /**
   * 写入配置项（热更新用）
   * 遇到路径字段时写内容到文件，config.json 中保留 {type:"path", content:...} 声明不变
   * 非路径字段直接合并写入 config.json
   */
  writeAgentConfig(updates) {
    const logger = createLogger('config', logFileName);
    const configPath = path.join(this.configDir, 'config.json');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      logger.error(`读取 config.json 失败: ${err.message}`);
      return;
    }

    for (const [key, value] of Object.entries(updates)) {
      if (this._pathFields.has(key)) {
        // 路径字段：写内容到文件，config.json 中保留 { type: "path", content: ... } 不变
        const pathValue = raw[key];
        if (typeof pathValue === 'object' && pathValue.type === 'path') {
          const filePath = path.join(this.configDir, pathValue.content);
          try {
            fs.writeFileSync(filePath, value, 'utf-8');
          } catch (err) {
            logger.error(`写入文件 ${filePath} 失败: ${err.message}`);
          }
        }
        // config.json 中不改动路径声明
      } else {
        raw[key] = value;
      }
    }

    try {
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`写入 config.json 失败: ${err.message}`);
    }
  }
}