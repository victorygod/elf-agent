/**
 * elf-018 装配入口 —— DNDAgent（4-loop workflow）+ DNDMessageManager。
 * 运行时文档放 dataDir/runtime（rewind 整份回退）；config 留 canon（只读）+ seeds（首次种子）。
 * messages 组装由 DNDAgent._buildLoopMessages 自管（system 拼 loop_prompt+canon+file_index），不用注入器。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Config } from '../../engine/config_loader.js';
import { buildAgentFromConfig } from '../../engine/build_agent.js';
import { MessageManager } from './message_manager.js';
import { DNDAgent } from './agent.js';
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

  const agent = await buildAgentFromConfig({
    messageManager, runContext, model, toolManager, dataDir: mmDataDir, config, agentClass: DNDAgent,
  });

  const runtimeDir = path.join(mmDataDir, 'runtime');
  const seedsDir = path.join(configDir, 'seeds');
  _seedRuntime(seedsDir, runtimeDir);
  agent._roots = {
    lore: path.join(runtimeDir, 'lore'),
    outline: path.join(runtimeDir, 'outline'),
    scene: path.join(runtimeDir, 'scene'),
  };
  agent._protagonistFile = 'user_profile.md';
  agent._configDir = configDir;   // 供 clearRuntime 找 seeds 重新播种

  // main loop 用普通 agent 机制（base assemble + DNDMM tool_result 剪裁），canon/面板/任务经注入器在 _currentLoop='main' 时注入
  const asm = agent.promptAssembler;
  asm.useSystemReplace(() => agent._currentLoop === 'main' ? agent._mainSystem() : null, { order: -100, name: 'main-system' });
  asm.useAfterLastUser(() => agent._currentLoop === 'main' ? agent._mainContext() : null, { order: 300, name: 'main-context' });

  return agent;
}

/** 首次启动：把 config/seeds 下运行时文档种子拷到 dataDir/runtime（已存在则跳过）。 */
function _seedRuntime(seedsDir, runtimeDir) {
  for (const name of ['lore', 'outline', 'scene']) {
    const dst = path.join(runtimeDir, name);
    if (fs.existsSync(dst)) continue;
    const src = path.join(seedsDir, name);
    if (!fs.existsSync(src)) continue;
    try { _copyDir(src, dst); } catch (e) { /* 种子拷贝失败不阻断 */ }
  }
}

function _copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) _copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}