/**
 * elf-003 装配入口 —— 显式建器官 + new Agent（经 buildAgentFromConfig 完成通用装配）。
 *
 * 定制：base MessageManager + prefix/suffix prompt（经 PromptAssembler 注入器）+ Read/Bash/Grep/Glob + async compact。
 * 场景不在此声明——由调用方经 run-level 注入。
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
  // 注入器复用 create_agent 的 config 实例（= agent.config 全链路同一个），热更新自然一致
  registerPrefixSuffixInjectors(agent.promptAssembler, config);
  return agent;
}
