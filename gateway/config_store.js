/**
 * 配置存储模块
 * 封装 Agent 配置的读写逻辑（config.json / api_key.json / prompt 文件）
 * 从 gateway/server.js 提取，消除重复的 prompt 文件字段定义
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';

let logFileName = null;

export function setConfigStoreLogFileName(name) {
  logFileName = name;
}

/** Prompt 文件字段映射（统一常量，消除 server.js 中的 3 处重复定义） */
export const PROMPT_FILE_FIELDS = [
  { pathKey: 'systemPromptPath', contentKey: 'systemPrompt', defaultFile: 'system_prompt.md' },
  { pathKey: 'prefixPromptPath', contentKey: 'prefix_prompt', defaultFile: 'prefix_prompt.md' },
  { pathKey: 'suffixPromptPath', contentKey: 'suffix_prompt', defaultFile: 'suffix_prompt.md' },
];

/** API Key 必填字段 */
const API_KEY_FIELDS = ['base_url', 'auth_token', 'model'];

/** API Key 空模板 */
const API_KEY_TEMPLATE = { base_url: '', auth_token: '', model: '' };

/**
 * 读取 prompt 文件内容，注入到 config 对象中
 * @param {object} raw - config.json 解析后的对象
 * @param {string} configDir - 配置目录路径
 */
function readPromptFiles(raw, configDir) {
  for (const { pathKey, contentKey, defaultFile } of PROMPT_FILE_FIELDS) {
    const fileName = raw[pathKey] || defaultFile;
    const filePath = path.join(configDir, fileName);
    try {
      raw[contentKey] = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      raw[contentKey] = '';
    }
  }
}

/**
 * 读取 api_key.json
 * @param {string} configDir - 配置目录路径
 * @param {boolean} autoCreate - 不存在时是否自动创建空模板，默认 false
 * @returns {object} api_key.json 的内容
 */
export function readApiKey(configDir, autoCreate = false) {
  const apiKeyPath = path.join(configDir, 'api_key.json');
  try {
    return JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
  } catch (err) {
    if (autoCreate) {
      const apiKeyData = { ...API_KEY_TEMPLATE };
      try {
        fs.writeFileSync(apiKeyPath, JSON.stringify(apiKeyData, null, 2), 'utf-8');
        const logger = createLogger('config-store', logFileName);
        logger.info(`已自动创建 ${apiKeyPath}`);
      } catch (writeErr) {
        const logger = createLogger('config-store', logFileName);
        logger.error(`自动创建 api_key.json 失败: ${writeErr.message}`);
      }
      return apiKeyData;
    }
    return {};
  }
}

/**
 * 读取 Agent 配置（config.json + prompt 文件 + api_key.json）
 * @param {string} configDir - 配置目录路径
 * @returns {object} 合并后的完整配置，包含 model 和可选的 modelError
 */
export function readAgentConfig(configDir) {
  const configPath = path.join(configDir, 'config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // 读取 prompt 文件内容
  readPromptFiles(raw, configDir);

  // 从 api_key.json 读取模型连接配置，合并 provider
  const apiKeyData = readApiKey(configDir);
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
 * @param {string} configDir - 配置目录路径
 * @param {object} update - 更新内容
 * @returns {object} 更新后的 config.json 内容
 */
export function writeAgentConfig(configDir, update) {
  const configPath = path.join(configDir, 'config.json');

  // 读取现有配置
  const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // 如果更新中包含 prompt 内容字段，写入对应的 .md 文件
  for (const { contentKey, pathKey, defaultFile } of PROMPT_FILE_FIELDS) {
    if (update[contentKey] !== undefined) {
      const fileName = existing[pathKey] || defaultFile;
      const filePath = path.join(configDir, fileName);
      // 置空时也写入空内容（清空文件），不跳过
      fs.writeFileSync(filePath, update[contentKey], 'utf-8');
      existing[pathKey] = fileName;
      delete update[contentKey];
    }
  }

  // 如果更新中包含 model，将模型连接字段写入 api_key.json
  if (update.model !== undefined) {
    const apiKeyPath = path.join(configDir, 'api_key.json');
    let existingApiKey = {};
    try {
      existingApiKey = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
    } catch (err) {
      // api_key.json 不存在
    }

    const modelUpdate = update.model;
    const apiKeyUpdate = {};
    for (const key of API_KEY_FIELDS) {
      if (modelUpdate[key] !== undefined) {
        apiKeyUpdate[key] = modelUpdate[key];
      }
    }

    // provider 写入 config.json
    if (modelUpdate.provider !== undefined) {
      existing.provider = modelUpdate.provider;
    }

    if (Object.keys(apiKeyUpdate).length > 0) {
      const mergedApiKey = { ...existingApiKey, ...apiKeyUpdate };
      fs.writeFileSync(apiKeyPath, JSON.stringify(mergedApiKey, null, 2), 'utf-8');
    }

    delete update.model;
  }

  // 合并其余更新到 config.json
  for (const [key, value] of Object.entries(update)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && existing[key] && typeof existing[key] === 'object') {
      existing[key] = { ...existing[key], ...value };
    } else {
      existing[key] = value;
    }
  }

  // 写入 config.json
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');

  return existing;
}