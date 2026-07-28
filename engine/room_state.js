/**
 * RoomState —— v3 单 Agent 进程内 per-room 运行单元（docs §三）
 *
 * 一个 Agent 进程承载多个 RoomState（Map<roomId, RoomState>），每个 RoomState = 该 room 的
 *   独立 Agent 实例（隔离上下文/历史/工具/buffer）+ 场景插件（私聊 PrivateChatPlugin / 群聊 RoomPlugin）
 *   + 独立 AbortController + 独立 observe 调度队列。
 *
 * 并发：跨 room 完全并发（各自的 async 链），同 room 串行（observeQueue）。AbortController per-room。
 *
 * 构造复用：调 agents/<agentId>/create_agent.js::createAgent({runContext, dataDir, ...})，
 *   再注入 _scene（与 engine/start.js 原内联逻辑同源，搬到此工厂供多房复用）。
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createLogger } from '../shared/logger.js';
import { buildRunContext } from './run_context.js';

/**
 * 创建一个 RoomState。
 * @param {object} opts
 * @param {string} opts.configDir - agent 配置目录（agents/<id>/config）
 * @param {string} opts.agentId - agent 类身份
 * @param {string} opts.roomId - room id（私聊 = chat-<agentId>，群聊 = room_xxx）
 * @param {'private'|'room'} opts.mode - 场景模式
 * @param {string} opts.dataDir - 本 room 独占数据目录（<dataRoot>/<roomId>）
 * @param {number} [opts.port] - 进程端口（私聊默认房用）
 * @param {string} [opts.gatewayUrl] - gateway base url（PrivateChatPlugin 拼 sync URL 用）
 * @param {string} [opts.memberName] - 群聊成员名
 * @param {string} [opts.roomBusUrl] - 群聊 room_bus base url（Speak 回调）
 * @returns {Promise<{roomId, agent, runContext, plugin, observeProcessing:boolean, pendingObserve:null}>}
 */
export async function createRoomState({ configDir, agentId, roomId, mode, dataDir, port = null, gatewayUrl = null, memberName = null, roomBusUrl = null }) {
  const logger = createLogger('room-state');
  if (!agentId) throw new Error('createRoomState: agentId 必填');
  if (!roomId) throw new Error('createRoomState: roomId 必填');
  if (!dataDir) throw new Error('createRoomState: dataDir 必填');

  // runContext：private 模式保留 roomId（v3：私聊也是 Room），room 模式 fail-fast 已在 buildRunContext。
  const runContext = buildRunContext({ agentId, mode, port, dataDir, roomId, memberName, roomBusUrl });

  // 调 agent 装配入口（与 start.js 同源约定：agents/<id>/create_agent.js 导出 createAgent）。
  const createAgentPath = path.join(configDir, '..', 'create_agent.js');
  if (!fs.existsSync(createAgentPath)) {
    throw new Error(`createRoomState: 缺装配入口 ${createAgentPath}`);
  }
  const { createAgent } = await import(pathToFileURL(createAgentPath).href);
  const agent = await createAgent({ dataDir, runContext });

  // 场景插件注入（从 start.js 搬出，多房通用）。
  let plugin;
  if (mode === 'room') {
    const { RoomPlugin } = await import('./plugins/room_plugin.js');
    const { Speak } = await import('./tools/Speak.js');
    plugin = new RoomPlugin(agent);
    agent._scene = plugin;
    agent.toolManager.register(Speak);
    // 观测式策略：按 config.interaction.strategy 注册 Skip + SetObserveConfig
    const strategy = plugin._interactionStrategy();
    if (strategy === 'observe' || strategy === 'both') {
      const { Skip } = await import('./tools/Skip.js');
      const { SetObserveConfig } = await import('./tools/SetObserveConfig.js');
      agent.toolManager.register(Skip);
      agent.toolManager.register(SetObserveConfig);
      logger.info(`RoomState[${roomId}] 注入 RoomPlugin + Speak + Skip + SetObserveConfig (strategy=${strategy})`);
    } else {
      logger.info(`RoomState[${roomId}] 注入 RoomPlugin + Speak (strategy=${strategy})`);
    }
    try {
      await plugin.syncMissingHistory();
    } catch (err) {
      logger.warn(`RoomState[${roomId}] 历史同步失败(非致命): ${err.message}`);
    }
  } else {
    if (gatewayUrl) agent._gatewayUrl = gatewayUrl;
    const { PrivateChatPlugin } = await import('./plugins/private_chat_plugin.js');
    plugin = new PrivateChatPlugin(agent);
    agent._scene = plugin;
    logger.info(`RoomState[${roomId}] 注入 PrivateChatPlugin`);
  }

  return {
    roomId,
    agent,
    runContext,
    plugin,
    observeProcessing: false,
    pendingObserve: null,
  };
}
