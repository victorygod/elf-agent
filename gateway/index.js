/**
 * Gateway 入口
 * 启动流程编排：加载配置 → 发现 Agent → 探活 → 启动 HTTP 服务
 */

import path from 'path';
import fs from 'fs';
import { loadGatewayConfig } from './config.js';
import { ProcessManager } from './process_manager.js';
import { ChatHistory } from './chat_history.js';
import { createGatewayApp } from './server.js';
import { RoomManager } from './room_bus.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('gateway-main', 'gateway.log');

async function main() {
  // 1. 加载配置
  const config = loadGatewayConfig();
  logger.info(`Gateway 配置: port=${config.port}`);

  // 2. 初始化进程管理器
  const pm = new ProcessManager();

  // 3. 初始化聊天记录管理器
  const chatHistory = new ChatHistory(pm.agentsDir);

  // 3. 扫描 agents/ 目录
  await pm.discoverAgents();

  // 4. 探活已有进程
  for (const [id] of pm.agents) {
    await pm.probeAgent(id);
  }

  // 通过 UI 手动点击启动 Agent，不再自动启动第一个
  {
    const runningCount = pm.listAgents().filter(a => a.status === 'running').length;
    logger.info(runningCount > 0
      ? `已有 ${runningCount} 个 Agent 在运行中（恢复态）`
      : '无运行中的 Agent，等待用户手动启动');
  }

  // 5. 初始化群聊管理器
  const roomsDir = path.join(process.cwd(), 'rooms');
  try { fs.mkdirSync(roomsDir, { recursive: true }); } catch (e) { /* ignore */ }
  const roomManager = new RoomManager(roomsDir, config.port);

  // 7. 启动 HTTP 服务
  const app = createGatewayApp(pm, chatHistory, roomManager);
  app.listen(config.port, () => {
    logger.info(`Gateway 监听端口: ${config.port}`);
    logger.info(`可用 Agent: ${pm.listAgents().map(a => `${a.agentId} (${a.status})`).join(', ')}`);
  });
}

main().catch(err => {
  logger.error(`Gateway 启动失败: ${err.message}`);
  process.exit(1);
});