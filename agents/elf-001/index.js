/**
 * Agent 入口
 * 启动流程编排：解析配置 → 初始化组件 → 启动 HTTP 服务
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Config, setLogFileName as setConfigLogFileName } from './config.js';
import { LLMModel } from '../../shared/agent/llm_model.js';
import { MockModel } from '../../shared/agent/mock_model.js';
import { ToolRegistry } from './tools/registry.js';
import { readFileTool } from './tools/read_file.js';
import { MessageManager, setMessageManagerLogFileName } from './message_manager.js';
import { Agent, setAgentLogFileName } from './agent.js';
import { createAgentServer, setServerLogFileName } from './server.js';
import { createLogger } from '../../shared/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // 1. 解析命令行参数
  const args = process.argv.slice(2);
  let configDir = path.join(__dirname, 'config');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
      configDir = path.resolve(args[i + 1]);
      i++;
    }
  }

  // 2. 加载配置（先加载一次获取 agentId，用于日志文件名）
  const config = new Config(configDir);
  config.load();

  const agentId = config.get('agentId') || 'unknown';
  const logFileName = `agent-${agentId}.log`;
  const dataDir = path.join(configDir, '..', 'data');

  // 3. 设置所有模块的日志文件名
  setConfigLogFileName(logFileName);
  setAgentLogFileName(logFileName);
  setServerLogFileName(logFileName);
  setMessageManagerLogFileName(logFileName);

  const logger = createLogger('agent-main', logFileName);

  // 4. 初始化模型
  const modelConfig = config.getModelConfig();
  let model;
  if (modelConfig.provider === 'mock') {
    model = new MockModel();
  } else {
    model = new LLMModel(modelConfig);
  }

  // 5. 初始化工具注册表
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(readFileTool);

  // 6. 初始化 MessageManager
  const messageManager = new MessageManager({
    systemPrompt: config.get('systemPrompt') || '',
    memoryTokenLimit: config.get('memoryTokenLimit') || 8000,
    dataDir
  });

  // 7. 初始化 Agent
  const agent = new Agent({ config, model, toolRegistry, messageManager });

  // 8. 启动 HTTP 服务
  const port = config.get('port');
  const app = createAgentServer(agent, config);
  app.listen(port, () => {
    logger.info(`Agent ${agentId} listening on port ${port}`);
  });

  // 9. 监听配置文件变化（始终启用热加载）
  try {
    fs.watch(configDir, (eventType, filename) => {
      logger.info(`配置文件变化: ${filename}, 重新加载...`);
      try {
        config.load();
        messageManager.updateConfig({
          systemPrompt: config.get('systemPrompt'),
          memoryTokenLimit: config.get('memoryTokenLimit')
        });
        const newModelConfig = config.getModelConfig();
        if (newModelConfig.provider === 'mock') {
          agent.updateModel(new MockModel());
        } else {
          agent.updateModel(new LLMModel(newModelConfig));
        }
        logger.info('配置热加载完成');
      } catch (err) {
        logger.error(`配置热加载失败: ${err.message}`);
      }
    });
  } catch (err) {
    logger.warn(`无法监听配置目录: ${err.message}`);
  }
}

main().catch(err => {
  const logger = createLogger('agent-main', 'agent-error.log');
  logger.error(`Agent 启动失败: ${err.message}`);
  process.exit(1);
});