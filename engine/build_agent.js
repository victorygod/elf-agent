/**
 * buildAgentFromConfig —— 通用装配 helper（engine 侧）
 *
 * 各 elf-00x 的 create_agent.js 显式建好自己的 MessageManager（继承基类或自定义）后，调本函数
 * 完成剩余通用装配：读 config 建 model、按 tools 注册、建 skillLister/fileChangeDetection、new Agent。
 *
 * 设计：收**已实例化的 mm**（不反射 mmClass 字符串）——指派权归 create_agent.js，本 helper 不反射。
 *   elf-00x 的 mm 子类定制（如 elf-002 多层 compact）在各自 create_agent.js 里 new 好传入。
 *
 * 不做兼容/不反射：废弃 fromConfigDir 的 messageManagerClass/agentClass 反射路径。
 */
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { LLMModel, MockModel } from './models/index.js';
import { ToolManager } from './tools/tool_manager.js';
import * as allTools from './tools/index.js';
import { SkillLister } from './skills/lister.js';
import { Agent } from './agent.js';

let logFileName = null;
export function setBuildAgentLogFileName(name) { logFileName = name; }

/**
 * @param {object} opts
 * @param {object} opts.config - 已实例化+load 的 Config（create_agent.js new 好传入，全链路单实例）
 * @param {object} opts.messageManager - 已实例化的 mm（create_agent.js 显式 new 好传入）
 * @param {object} [opts.runContext] - 运行时身份（mode/dataDir 等）
 * @param {object} [opts.model] - 自定义 model（测试用），缺省按 config.provider 建
 * @param {object} [opts.toolManager] - 自定义 toolManager（测试用），缺省按 config.tools 建
 * @param {Array} [opts.extraMiddleware] - 额外 agent-level middleware（create_agent.js 显式加）
 * @param {string} [opts.dataDir] - 数据目录，缺省 config.configDir/..
 * @returns {Promise<Agent>}
 */
export async function buildAgentFromConfig({ messageManager, runContext = null, model, toolManager, extraMiddleware = [], dataDir, config } = {}) {
  const logger = createLogger('agent-init', logFileName);
  if (!messageManager) throw new Error('buildAgentFromConfig: messageManager 必填（create_agent.js 显式 new 后传入）');
  if (!config) throw new Error('buildAgentFromConfig: config 必填（由 create_agent.js new 后传入，全链路单实例）');

  const mmDataDir = dataDir || path.join(config.configDir, '..', 'data');

  // 2. model（按 provider；mock 用 MockModel）
  if (!model) {
    const modelConfig = config.getModelConfig();
    model = modelConfig.provider === 'mock' ? new MockModel() : new LLMModel(modelConfig);
  }

  // 3. toolManager（按 config.tools 注册；未指定则全注册）
  if (!toolManager) {
    toolManager = new ToolManager();
    const toolNames = config.get('tools');
    if (Array.isArray(toolNames)) {
      for (const name of toolNames) {
        const tool = allTools[name];
        if (tool) { toolManager.register(tool); logger.info(`注册工具: ${name}`); }
        else logger.warn(`未知工具: ${name}，跳过`);
      }
    } else {
      logger.warn('config.json 未指定 tools 字段，注册所有可用工具');
      for (const [, tool] of Object.entries(allTools)) toolManager.register(tool);
    }
  }

  // mm 的 dataDir 若未设（create_agent.js new 时没传），补上（私聊回退 configDir/..）
  if (messageManager.dataDir == null) messageManager.dataDir = mmDataDir;

  // 4. new Agent（_eventSink 桥接/harness 在 constructor 内接线）
  const agent = new Agent({ config, model, toolManager, messageManager, middleware: [], runContext });

  // 5. agent-level 固有定制（非场景）：skillLister（skills=true）+ detectChangedFiles middleware
  if (config.get('skills') === true) {
    agent.skillLister = new SkillLister({ messageManager, toolManager, agent });
    agent.skillLister.enable();
    logger.info('已启用 skill 支持');
  }
  if (config.get('fileChangeDetection') === true) {
    if (['Read', 'Write', 'Edit'].some(t => toolManager.get(t))) {
      const { detectChangedFiles } = await import('./tools/file_change_detector.js');
      agent.middlewares.push({ preReason(mm) { return detectChangedFiles(mm); } });
      logger.info('已启用文件变更检测');
    } else {
      logger.warn('fileChangeDetection=true 但未注册 Read/Write/Edit 工具，跳过');
    }
  }
  for (const m of extraMiddleware) agent.middlewares.push(m);

  return agent;
}
