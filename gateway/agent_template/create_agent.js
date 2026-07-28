/**
 * Agent 装配入口（模板） —— 显式建器官 + new Agent（经 buildAgentFromConfig 完成通用装配）。
 *
 * 定制：base MessageManager + prefix/suffix prompt（经 PromptAssembler 注入器）+ Read/Bash/Grep/Glob + async compact。
 * 场景（群聊/私聊）不在此声明——由调用方经 run-level 注入（RoomPlugin/PrivateChatPlugin）。
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { Config } from '../../engine/config_loader.js';
import { buildAgentFromConfig } from '../../engine/build_agent.js';
import { MessageManager } from '../../engine/message_manager.js';
import { registerPrefixSuffixInjectors } from '../../engine/prompt/index.js';
import { agentMemory } from '../../shared/profiles_paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createAgent({ runContext, dataDir, model, toolManager } = {}) {
  const configDir = path.join(__dirname, 'config');
  const config = new Config(configDir);
  config.load();
  const mmDataDir = dataDir || agentMemory(runContext?.agentId || 'unknown');

  const messageManager = new MessageManager({
    systemPrompt: config.get('systemPrompt') || '',
    memoryTokenLimit: config.get('memoryTokenLimit') || 8000,
    compactSystemPrompt: config.get('compactSystemPrompt') || '',
    compactPrompt: config.get('compactPrompt') || '',
    dataDir: mmDataDir,
    config,
  });

  const agent = await buildAgentFromConfig({ messageManager, runContext, model, toolManager, dataDir: mmDataDir, config });
  registerPrefixSuffixInjectors(agent.promptAssembler, config);
  return agent;
}