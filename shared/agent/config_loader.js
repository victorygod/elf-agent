/**
 * 配置加载器
 *
 * 读取 config/ 目录下的 config.json 和 api_key.json
 * - config.json 中 type:"path" 字段自动读取对应文件内容
 * - api_key.json 单独固定加载，合并到 model 配置中
 * - 支持热重载: load() 可重复调用
 * - 支持写回: writeAgentConfig() 保留 path 声明，内容写文件
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger.js';

let logFileName = null;

/**
 * 设置日志文件名（由 start.js 在启动时调用）
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
    this._pathFields = new Set();  // 记录哪些字段是 type:"path"，用于 writeAgentConfig
  }

  /**
   * 加载配置：读取 config.json 和 api_key.json
   * - config.json 中值为 { type: "path", content: "filename" } 的字段，自动读取文件内容
   * - api_key.json 不存在时自动创建空模板
   * - provider 由 config.json 提供
   */
  load() {
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
            const logger = createLogger('config', logFileName);
            logger.warn(`无法读取 path 文件: ${filePath}, ${err.message}`);
            raw[key] = '';
          }
        }
      }

      // 从 api_key.json 读取模型连接配置
      const apiKeyPath = path.join(this.configDir, 'api_key.json');
      let apiKeyData;
      try {
        apiKeyData = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
      } catch (err) {
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

  /**
   * 写入配置项（热更新用）
   * 遇到路径字段时写内容到文件，config.json 中保留 {type:"path", content:...} 声明不变
   * 非路径字段直接合并写入 config.json
   */
  writeAgentConfig(updates) {
    const configPath = path.join(this.configDir, 'config.json');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      const logger = createLogger('config', logFileName);
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
            const logger = createLogger('config', logFileName);
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
      const logger = createLogger('config', logFileName);
      logger.error(`写入 config.json 失败: ${err.message}`);
    }
  }
}