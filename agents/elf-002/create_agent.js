/**
 * elf-002 装配入口 —— 显式建器官 + new Agent（经 buildAgentFromConfig 完成通用装配）。
 *
 * 定制：Elf002MessageManager（perToolLimit/budgetWindow/microcompact 多层 compact）+ Read/Write/Edit/Bash/Glob/Grep/Agent/Skill
 *   + skills=true（SkillLister 由 helper 按 config 建）+ fileChangeDetection=true（helper 按 config 建 middleware）。
 * 场景不在此声明——由调用方经 run-level middleware 注入。
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

  // 显式 new mm 子类（多层 compact 定制；perToolLimit/budgetWindow/microcompact 由 mm 从 config 读）
  const messageManager = new MessageManager({
    systemPrompt: config.get('systemPrompt') || '',
    memoryTokenLimit: config.get('memoryTokenLimit') || 8000,
    compactSystemPrompt: config.get('compactSystemPrompt') || '',
    compactPrompt: config.get('compactPrompt') || '',
    dataDir: mmDataDir,
    config,
  });

  // skills / fileChangeDetection / tools 注册由 buildAgentFromConfig 按 config 处理
  return buildAgentFromConfig({ configDir, messageManager, runContext, model, toolManager, dataDir: mmDataDir });
}
