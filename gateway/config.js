/**
 * Gateway 配置加载
 * 加载 gateway.json 并缓存
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('gateway-config', 'gateway.log');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 规范化 sidebarOrder：必须是 { rooms: [...], agents: [...] } 且元素为字符串
 */
function normalizeSidebarOrder(raw) {
  const isStrArr = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');
  const so = (raw && typeof raw === 'object') ? raw : {};
  return {
    rooms: isStrArr(so.rooms) ? so.rooms : [],
    agents: isStrArr(so.agents) ? so.agents : [],
  };
}

/**
 * 加载 gateway.json 配置
 * @returns {{ port: number, userName: string, userUid: string, sidebarOrder: {rooms:string[], agents:string[]} }}
 */
export function loadGatewayConfig() {
  const configPath = path.join(__dirname, '..', 'gateway.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return {
      port: config.port || 8080,
      // agent-server（承载全部 agent 的共享 server 进程）端口；本期 M=1 单 server。默认 8180 避开 agents 80xx 段。
      agentServerPort: config.agentServerPort || 8180,
      userName: config.userName || 'user',
      userAvatar: config.userAvatar || null,
      // 稳定用户身份（问题3）：username 可改，uid 不变，历史归属据此连续。现阶段默认固定值。
      userUid: config.userUid || 'default_userid',
      // 侧栏手动排序：{ rooms: [roomId...], agents: [agentId...] }，区段内各自排序
      sidebarOrder: normalizeSidebarOrder(config.sidebarOrder),
    };
  } catch (err) {
    logger.warn(`无法加载 gateway.json: ${err.message}, 使用默认配置`);
    return { port: 8080, agentServerPort: 8180, userName: 'user', userAvatar: null, userUid: 'default_userid', sidebarOrder: { rooms: [], agents: [] } };
  }
}

/**
 * 保存 gateway.json 配置（合并写回，保留未传字段）
 * @param {object} updates - 要更新的字段，如 { userName, userUid, sidebarOrder }
 */
export function saveGatewayConfig(updates = {}) {
  const configPath = path.join(__dirname, '..', 'gateway.json');
  try {
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) { /* 文件不存在则从空开始 */ }
    const merged = { ...existing, ...updates };
    // sidebarOrder 规范化后再落盘，避免脏结构污染配置文件
    if (updates.sidebarOrder !== undefined) {
      merged.sidebarOrder = normalizeSidebarOrder(updates.sidebarOrder);
    }
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
    return {
      port: merged.port || 8080,
      agentServerPort: merged.agentServerPort || 8180,
      userName: merged.userName || 'user',
      userAvatar: merged.userAvatar || null,
      userUid: merged.userUid || 'default_userid',
      sidebarOrder: normalizeSidebarOrder(merged.sidebarOrder),
    };
  } catch (err) {
    logger.error(`保存 gateway.json 失败: ${err.message}`);
    throw err;
  }
}