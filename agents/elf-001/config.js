/**
 * Agent 配置加载 + 热加载
 * 读取 config/ 目录下的 config.json 和 api_key.json
 *
 * config.json — Agent 业务配置（含 provider）
 * api_key.json — 模型连接配置（base_url, auth_token, model）
 *
 * 若 api_key.json 不存在，自动创建空模板，不阻止启动；
 * 请求时若字段为空则拦截并提示。
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../../shared/logger.js';

let logFileName = null;

/**
 * 设置日志文件名（由 index.js 在启动时调用）
 */
export function setLogFileName(name) {
  logFileName = name;
}

/** api_key.json 必填字段 */
const API_KEY_REQUIRED_FIELDS = ['base_url', 'auth_token', 'model'];

/** api_key.json 空模板 */
const API_KEY_TEMPLATE = {
  base_url: '',
  auth_token: '',
  model: '',
};

export class Config {
  constructor(configDir) {
    this.configDir = configDir;
    this.data = {};
  }

  /**
   * 加载配置：读取 config.json 和 api_key.json
   * api_key.json 不存在时自动创建空模板
   * provider 由 config.json 提供
   */
  load() {
    try {
      const configPath = path.join(this.configDir, 'config.json');
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // 处理 systemPromptPath：读取 system prompt 文件内容
      if (raw.systemPromptPath) {
        const promptPath = path.join(this.configDir, raw.systemPromptPath);
        try {
          raw.systemPrompt = fs.readFileSync(promptPath, 'utf-8');
        } catch (err) {
          const logger = createLogger('config', logFileName);
          logger.warn(`无法读取 system prompt 文件: ${promptPath}, ${err.message}`);
          raw.systemPrompt = '';
        }
      }

      // 从 api_key.json 读取模型连接配置
      const apiKeyPath = path.join(this.configDir, 'api_key.json');
      let apiKeyData;
      try {
        apiKeyData = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
      } catch (err) {
        // 文件不存在或解析失败，自动创建空模板
        const logger = createLogger('config', logFileName);
        logger.warn(`api_key.json 不存在或解析失败，已自动创建空模板，请填写模型配置`);
        apiKeyData = { ...API_KEY_TEMPLATE };
        try {
          fs.writeFileSync(apiKeyPath, JSON.stringify(apiKeyData, null, 2), 'utf-8');
          logger.info(`已自动创建 ${apiKeyPath}`);
        } catch (writeErr) {
          logger.error(`自动创建 api_key.json 失败: ${writeErr.message}`);
        }
      }

      // 合并：provider 来自 config.json，连接信息来自 api_key.json
      raw.model = {
        provider: raw.provider || 'llm',
        ...apiKeyData,
      };

      const logger = createLogger('config', logFileName);
      logger.info(`模型配置已加载 (model=${apiKeyData.model || '(未配置)'})`);

      this.data = raw;
      logger.info(`配置已加载: agentId=${raw.agentId}`);
    } catch (err) {
      const logger = createLogger('config', logFileName);
      logger.error(`配置加载失败: ${err.message}`);
      throw err;
    }
  }

  /**
   * 检查 api_key.json 必填字段是否全部填写
   * @returns {string[]|null} 缺失字段列表，全部填写则返回 null
   */
  getModelMissingFields() {
    const model = this.data.model || {};
    const missing = API_KEY_REQUIRED_FIELDS.filter(k => !model[k]);
    return missing.length > 0 ? missing : null;
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
}