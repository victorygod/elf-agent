/**
 * Gateway 配置加载
 * 加载 gateway.json 并缓存
 *
 * 多用户改造后：gateway.json 只存平台级配置（端口）。
 * 用户信息（userName/userAvatar/sidebarOrder）全部移到 profiles/users/<uid>/user.json，见 auth.js。
 *
 * 密钥（jwtSecret / internalToken）持久化在 profiles/auth.json（gitignore 内的运行时目录，
 *   不入库），首次运行自动生成。可用 env ELF_JWT_SECRET / ELF_INTERNAL_TOKEN 覆盖（测试用，
 *   覆盖时不写盘）。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createLogger } from '../shared/logger.js';
import { profilesRoot } from '../shared/profiles_paths.js';

const logger = createLogger('gateway-config', 'gateway.log');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function _configPath() {
  return path.join(__dirname, '..', 'gateway.json');
}

/** 密钥持久化文件：profiles/auth.json */
function _authPath() {
  return path.join(profilesRoot(), 'auth.json');
}

function _readAuthFile() {
  try {
    return JSON.parse(fs.readFileSync(_authPath(), 'utf-8'));
  } catch (err) {
    return {};
  }
}

/**
 * 取一个持久化密钥：env 覆盖 > auth.json 已有 > 生成并写盘。
 * @param {string} key - 'jwtSecret' | 'internalToken'
 * @param {string} envName - 对应的环境变量名
 */
function _ensureSecret(key, envName) {
  if (process.env[envName]) return process.env[envName];
  const existing = _readAuthFile();
  if (typeof existing[key] === 'string' && existing[key].length >= 32) return existing[key];
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(profilesRoot(), { recursive: true });
    fs.writeFileSync(_authPath(), JSON.stringify({ ...existing, [key]: generated }, null, 2), 'utf-8');
    logger.info(`已生成 ${key} 并写入 profiles/auth.json`);
  } catch (err) {
    logger.warn(`写入 ${key} 失败（本次仅内存生效）: ${err.message}`);
  }
  return generated;
}

/**
 * 加载 gateway.json 配置
 * @returns {{ port: number, agentServerPort: number, jwtSecret: string, internalToken: string }}
 */
export function loadGatewayConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(_configPath(), 'utf-8'));
  } catch (err) {
    logger.warn(`无法加载 gateway.json: ${err.message}, 使用默认配置`);
  }
  return {
    port: raw.port || 8080,
    // agent-server（承载全部 agent 的共享 server 进程）端口；本期 M=1 单 server。默认 8180 避开 agents 80xx 段。
    agentServerPort: raw.agentServerPort || 8180,
    // JWT 签名密钥（用户 token）+ 内部服务 token（agent-server 回调 gateway 用）
    jwtSecret: _ensureSecret('jwtSecret', 'ELF_JWT_SECRET'),
    internalToken: _ensureSecret('internalToken', 'ELF_INTERNAL_TOKEN'),
  };
}

/**
 * 保存 gateway.json 平台级配置（合并写回，保留未传字段）
 * @param {object} updates - 要更新的平台级字段（如 port/agentServerPort）
 */
export function saveGatewayConfig(updates = {}) {
  const merged = { ...(() => {
    try { return JSON.parse(fs.readFileSync(_configPath(), 'utf-8')); }
    catch (e) { logger.warn(`读 gateway.json 失败，按空配置合并: ${e.message}`); return {}; }
  })(), ...updates };
  fs.writeFileSync(_configPath(), JSON.stringify(merged, null, 2), 'utf-8');
  return loadGatewayConfig();
}
