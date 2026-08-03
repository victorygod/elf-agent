/**
 * elf-018 装配入口 —— DNDAgent（2-loop workflow：outline → render）+ DNDMessageManager。
 * 运行时文档放 dataDir/runtime（rewind 整份回退）；config 留 canon（只读）+ seeds（首次种子）。
 * messages 组装：system 经 promptAssembler.useSystemReplace 注入 canon+metadata，append 经
 * useAfterLastUser 注入 state.md/面板/任务；render 由 DNDAgent._buildRenderMessages 自管。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Config } from '../../engine/config_loader.js';
import { buildAgentFromConfig } from '../../engine/build_agent.js';
import { MessageManager } from './message_manager.js';
import { DNDAgent } from './agent.js';
import { makeWriteOutline } from './tools/WriteOutline.js';
import { makeEditOutline } from './tools/EditOutline.js';
import { makeRead } from './tools/Read.js';
import { makeWrite } from './tools/Write.js';
import { makeEdit } from './tools/Edit.js';
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

  // 本轮大纲专用工具（有状态：持 agent 实例，按 _roundNumber/_roots 定位本轮文件）。工厂构造、
  // 需 agent 实例，故在此手动注册，不进 config.json tools 数组（自动注册路径在 new Agent 之前、拿不到 agent）。
  agent.toolManager.register(makeWriteOutline(agent));
  agent.toolManager.register(makeEditOutline(agent));

  // lore 作用域 Read/Write/Edit 专版（同名覆盖 build_agent 注册的通用版）：持 agent 实例做 lore 范围 +
  // frontmatter 守卫。config.json 的 tools 仍列其名（驱动通用版先注册），这里 register 同名覆盖成专版。
  agent.toolManager.register(makeRead(agent));
  agent.toolManager.register(makeWrite(agent));
  agent.toolManager.register(makeEdit(agent));

  // outline loop 用普通 agent 机制（base assemble + DNDMM tool_result 剪裁），canon/面板/任务经注入器在 _currentLoop='outline' 时注入
  const asm = agent.promptAssembler;
  asm.useSystemReplace(() => agent._currentLoop === 'outline' ? agent._outlineSystem() : null, { order: -100, name: 'outline-system' });
  asm.useAfterLastUser(() => agent._currentLoop === 'outline' ? agent._outlineContext() : null, { order: 300, name: 'outline-context' });

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