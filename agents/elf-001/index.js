/**
 * elf-001 启动入口
 * 委托给 shared/agent/start.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { startAgent } from '../../shared/agent/start.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.join(__dirname, 'config');

startAgent(configDir).catch(err => {
  console.error(`Agent 启动失败: ${err.message}`);
  process.exit(1);
});