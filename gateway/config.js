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
 * 加载 gateway.json 配置
 * @returns {{ port: number }}
 */
export function loadGatewayConfig() {
  const configPath = path.join(__dirname, '..', 'gateway.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return {
      port: config.port || 8080
    };
  } catch (err) {
    logger.warn(`无法加载 gateway.json: ${err.message}, 使用默认配置`);
    return { port: 8080 };
  }
}