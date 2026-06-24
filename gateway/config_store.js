/**
 * 配置存储模块
 * 封装 Agent 配置的读写逻辑（config.json / api_key.json / prompt 文件）
 * 从 gateway/server.js 提取，消除重复的配置读写逻辑
 *
 * 支持 config.json 中的 type:"path" 声明式路径字段
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';

let logFileName = null;

export function setConfigStoreLogFileName(name) {
  logFileName = name;
}

/** API Key 必填字段 */
const API_KEY_FIELDS = ['base_url', 'auth_token', 'model'];

/** API Key 空模板 */
const API_KEY_TEMPLATE = { base_url: '', auth_token: '', model: '' };

/**
 * 读取 Agent 配置（config.json + type:"path" 文件 + api_key.json）
 * @param {string} configDir - 配置目录路径
 * @returns {object} 合并后的完整配置，包含 model 和可选的 modelError
 */
export function readAgentConfig(configDir) {
  const logger = createLogger('config-store', logFileName);
  const configPath = path.join(configDir, 'config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // 遍历 config.json 的每个字段，发现 type:"path" 就读文件内容
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === 'object' && value.type === 'path') {
      const filePath = path.join(configDir, value.content);
      try {
        raw[key] = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        logger.warn(`无法读取 path 文件: ${filePath}, ${err.message}`);
        raw[key] = '';
      }
    }
  }

  // 从 api_key.json 读取模型连接配置
  const apiKeyPath = path.join(configDir, 'api_key.json');
  let apiKeyData;
  try {
    apiKeyData = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
  } catch (err) {
    apiKeyData = {};
  }

  raw.model = { provider: raw.provider || 'llm', ...apiKeyData };

  // 检查模型配置是否完整（仅非 mock provider 时检查）
  if (raw.model.provider !== 'mock') {
    const modelMissing = API_KEY_FIELDS.filter(k => !raw.model[k]);
    if (modelMissing.length > 0) {
      raw.modelError = `模型配置不完整，请在「模型配置」选项卡中填写：${modelMissing.join('、')}`;
    }
  }

  return raw;
}

/**
 * 更新 Agent 配置（写入 config.json / prompt 文件 / api_key.json）
 * 遇到 type:"path" 字段时，内容写入对应文件，config.json 中保留路径声明不变
 * @param {string} configDir - 配置目录路径
 * @param {object} update - 更新内容
 * @returns {object} 更新后的配置（重新读取）
 */
export function writeAgentConfig(configDir, update) {
  const logger = createLogger('config-store', logFileName);
  const configPath = path.join(configDir, 'config.json');

  // 读取现有配置
  const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  for (const [key, value] of Object.entries(update)) {
    // 检查原始 config.json 中该字段是否是 type:"path"
    if (existing[key] && typeof existing[key] === 'object' && existing[key].type === 'path') {
      // 路径字段：写内容到文件，config.json 中保留 { type: "path", content: ... } 不变
      const filePath = path.join(configDir, existing[key].content);
      try {
        fs.writeFileSync(filePath, value, 'utf-8');
      } catch (err) {
        logger.error(`写入文件 ${filePath} 失败: ${err.message}`);
      }
      // 不修改 config.json 中的路径声明
    } else if (key === 'model' && typeof value === 'object') {
      // model 字段：provider 写入 config.json，连接字段写入 api_key.json
      const apiKeyPath = path.join(configDir, 'api_key.json');
      let existingApiKey = {};
      try {
        existingApiKey = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
      } catch (err) {
        // api_key.json 不存在
      }

      const apiKeyUpdate = {};
      for (const apiKeyField of API_KEY_FIELDS) {
        if (value[apiKeyField] !== undefined) {
          apiKeyUpdate[apiKeyField] = value[apiKeyField];
        }
      }

      if (value.provider !== undefined) {
        existing.provider = value.provider;
      }

      if (Object.keys(apiKeyUpdate).length > 0) {
        const mergedApiKey = { ...existingApiKey, ...apiKeyUpdate };
        fs.writeFileSync(apiKeyPath, JSON.stringify(mergedApiKey, null, 2), 'utf-8');
      }
    } else {
      // 普通字段：直接合并写入 config.json
      if (value && typeof value === 'object' && !Array.isArray(value) && existing[key] && typeof existing[key] === 'object') {
        existing[key] = { ...existing[key], ...value };
      } else {
        existing[key] = value;
      }
    }
  }

  // 写入 config.json
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');

  return readAgentConfig(configDir);
}