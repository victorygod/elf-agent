/**
 * Gateway 入口
 * 启动流程编排：加载配置 → 发现 Agent → 探活 → 启动 HTTP 服务
 */

import { loadGatewayConfig } from './config.js';
import { ProcessManager } from './process_manager.js';
import { ChatHistory } from './chat_history.js';
import { createGatewayApp } from './server.js';
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
  pm.discoverAgents();

  // 4. 探活已有进程
  for (const [id] of pm.agents) {
    await pm.probeAgent(id);
  }

  // 5. 默认启动第一个 Agent（如果有且为 stopped 状态）
  const firstAgent = pm.agents.keys().next().value;
  if (firstAgent && pm.getAgentStatus(firstAgent) === 'stopped') {
    logger.info(`默认启动第一个 Agent: ${firstAgent}`);
    pm.startAgent(firstAgent);
  }

  // 6. 启动 HTTP 服务
  const app = createGatewayApp(pm, chatHistory);
  app.listen(config.port, () => {
    logger.info(`Gateway 监听端口: ${config.port}`);
    logger.info(`可用 Agent: ${pm.listAgents().map(a => `${a.agentId} (${a.status})`).join(', ')}`);
  });
}

main().catch(err => {
  logger.error(`Gateway 启动失败: ${err.message}`);
  process.exit(1);
});