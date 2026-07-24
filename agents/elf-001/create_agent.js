/**
 * elf-001 装配入口 —— 显式建器官 + new Agent（经 buildAgentFromConfig 完成通用装配）。
 *
 * 定制：Elf001MessageManager（prefix/suffix prompt）+ Read/Bash/Grep/Glob 工具 + async compact。
 * 场景（群聊/私聊）不在此声明——由调用方经 run-level middleware 注入（阶段二实例层；阶段一 start.js）。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { Config } from '../../engine/config_loader.js';
import { buildAgentFromConfig } from '../../engine/build_agent.js';
import { MessageManager } from './message_manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createAgent({ runContext, dataDir, model, toolManager } = {}) {
  const configDir = path.join(__dirname, 'config');
  const config = new Config(configDir);
  config.load();
  const mmDataDir = dataDir || path.join(__dirname, 'data');

  // 显式 new mm 子类（不再经 messageManagerClass 反射；指派权在本文件）
  const messageManager = new MessageManager({
    systemPrompt: config.get('systemPrompt') || '',
    memoryTokenLimit: config.get('memoryTokenLimit') || 8000,
    compactSystemPrompt: config.get('compactSystemPrompt') || '',
    compactPrompt: config.get('compactPrompt') || '',
    dataDir: mmDataDir,
    config,
  });

  return buildAgentFromConfig({ configDir, messageManager, runContext, model, toolManager, dataDir: mmDataDir });
}
