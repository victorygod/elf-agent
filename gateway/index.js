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
  await pm.discoverAgents();

  // 4. 探活已有进程
  for (const [id] of pm.agents) {
    await pm.probeAgent(id);
  }

  // 5. 如果没有 Agent 在运行，默认启动第一个
  const runningCount = pm.listAgents().filter(a => a.status === 'running').length;
  if (runningCount === 0) {
    const firstAgent = pm.agents.keys().next().value;
    if (firstAgent) {
      logger.info(`无运行中的 Agent，默认启动第一个: ${firstAgent}`);
      await pm.startAgent(firstAgent);
    }
  } else {
    logger.info(`已有 ${runningCount} 个 Agent 在运行中，跳过自动启动`);
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