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
import { resolveModelConfig } from './api_key_store.js';

let logFileName = null;

export function setConfigStoreLogFileName(name) {
  logFileName = name;
}

/**
 * 读取 Agent 配置（config.json + type:"path" 文件 + model_id 解析）
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

  const useMock = raw.provider === 'mock' || process.env.ELF_FORCE_MOCK_MODEL === '1';
  const { model, modelError } = resolveModelConfig({
    model_id: raw.model_id,
    provider: raw.provider,
    model_params: raw.model_params,
    useMock,
  });
  raw.model = model;
  if (modelError) raw.modelError = modelError;

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
    } else if (key === 'model_id') {
      // model_id 字段：直接写入 config.json
      existing.model_id = value;
    } else if (key === 'model_params') {
      // model_params 整体替换（切换模型时清空旧参数）
      existing.model_params = value;
    } else if (key.startsWith('model_params.')) {
      // model_params 字段：解析嵌套字段
      const paramKey = key.replace('model_params.', '');
      if (!existing.model_params) existing.model_params = {};
      existing.model_params[paramKey] = value;
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