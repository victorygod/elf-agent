/**
 * Agent 启动入口
 *
 * 从配置目录创建 Agent 并启动 HTTP 服务，监听配置热更新
 * 所有 Agent 共用此入口，Agent 目录只需提供 config/ 即可
 *
 * 用法: node shared/agent/start.js --config agents/elf-001/config
 *
 * 启动流程：设置日志 → Agent.fromConfigDir() → 启动 HTTP 服务 → 热加载监听
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setLogFileName as setConfigLogFileName } from './config_loader.js';
import { Agent, setAgentLogFileName } from './default_agent.js';
import { createAgentServer, setServerLogFileName } from './server.js';
import { setLogFileName as setMessageManagerLogFileName } from './message_manager.js';
import { createLogger } from '../logger.js';

/**
 * 启动 Agent
 * @param {string} configDir - 配置目录路径
 */
export async function startAgent(configDir) {
  // 1. 设置日志文件名（Agent 内部会创建 Config，这里先读 agentId 用于日志名）
  const configPreview = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'));
  const agentId = configPreview.agentId || 'unknown';
  const logFileName = `agent-${agentId}.log`;

  setConfigLogFileName(logFileName);
  setAgentLogFileName(logFileName);
  setServerLogFileName(logFileName);
  setMessageManagerLogFileName(logFileName);

  const logger = createLogger('agent-main', logFileName);

  // 2. 创建 Agent（内部自动完成 Config → Model → ToolRegistry → MessageManager）
  const agent = await Agent.fromConfigDir(configDir);

  // 3. 启动 HTTP 服务
  const port = agent.config.get('port');
  const app = createAgentServer(agent, agent.config);
  const server = app.listen(port, () => {
    logger.info(`Agent ${agentId} listening on port ${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`端口 ${port} 已被占用，Agent ${agentId} 无法启动`);
    } else {
      logger.error(`HTTP 服务错误: ${err.message}`);
    }
    process.exit(1);
  });

  // 4. 监听配置文件变化（始终启用热加载）
  try {
    fs.watch(configDir, (eventType, filename) => {
      logger.info(`配置文件变化: ${filename}, 重新加载...`);
      try {
        agent.reloadConfig();
      } catch (err) {
        logger.error(`配置热加载失败: ${err.message}`);
      }
    });
  } catch (err) {
    logger.warn(`无法监听配置目录: ${err.message}`);
  }

  return { agent, config: agent.config, server };
}

// 直接运行时执行启动
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 如果作为主模块运行（不是被 import）
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  let configDir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      configDir = path.resolve(args[i + 1]);
      i++;
    }
  }

  if (!configDir) {
    console.error('Usage: node start.js --config <config-dir>');
    process.exit(1);
  }

  startAgent(configDir).catch(err => {
    const logger = createLogger('agent-main', 'agent-error.log');
    logger.error(`Agent 启动失败: ${err.message}`);
    process.exit(1);
  });
}