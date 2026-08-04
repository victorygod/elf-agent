/**
 * Gateway 入口
 * 启动流程编排：加载配置 → 发现 Agent → 探活 → 启动 HTTP 服务
 */

import path from 'path';
import fs from 'fs';
import { loadGatewayConfig } from './config.js';
import { ProcessManager } from './process_manager.js';
import { ChatHistory } from './chat_history.js';
import { createGatewayApp } from './server.js';
import { RoomManager } from './room_bus.js';
import { AggregatedBroadcaster } from './aggregated_stream.js';
import { createLogger } from '../shared/logger.js';
import { profilesRoot, roomsRoot } from '../shared/profiles_paths.js';

const logger = createLogger('gateway-main', 'gateway.log');

async function main() {
  // 1. 加载配置
  const config = loadGatewayConfig();
  logger.info(`Gateway 配置: port=${config.port}`);

  // 2. 初始化进程管理器
  const pm = new ProcessManager();

  // profiles 布局：agent 记忆落 profiles/agents/<id>/memory，房间数据落 profiles/rooms/<rid>。
  //   snapshot/rewind 直接用 profiles_paths 的 agentMemory(id)，无需借 pm 字段拼路径。
  try { fs.mkdirSync(profilesRoot(), { recursive: true }); } catch (e) { /* ignore */ }

  // 3. 扫描 agents/ 目录
  await pm.discoverAgents();

  // 4. 探活共享 agent-server（一个进程承载全部 agent，探一次即可；在跑则重建 /events 通道）
  await pm.probeServer();

  // 通过 UI 手动点击启动 Agent，不再自动启动第一个
  {
    const runningCount = pm.listAgents().filter(a => a.status === 'running').length;
    logger.info(runningCount > 0
      ? `已有 ${runningCount} 个 Agent 在运行中（恢复态）`
      : '无运行中的 Agent，等待用户手动启动');
  }

  // 5. 初始化群聊管理器 + 私聊 room 历史管理器（房间数据落 profiles/rooms/<rid>）
  const roomsRootDir = roomsRoot();
  try { fs.mkdirSync(roomsRootDir, { recursive: true }); } catch (e) { /* ignore */ }
  const roomManager = new RoomManager(roomsRootDir, config.port, { pm, gatewayUrl: `http://127.0.0.1:${config.port}` });
  // 私聊房历史（room 模式 ChatHistory：写 profiles/rooms/chat-<id>/history.jsonl，schema 与私聊同）。
  const privateRoomHistory = new ChatHistory(roomsRootDir, roomsRootDir, { roomMode: true, roomsDir: roomsRootDir });
  pm.privateRoomHistory = privateRoomHistory;
  // 聚合 SSE broadcaster:前端全程 1 条收所有私聊+群聊房,解 6 连接上限。
  const aggregator = new AggregatedBroadcaster({ pm, roomManager, privateRoomHistory });

  // 6. 恢复已有房间的成员副本（gateway 重启后，探活并拉起之前注册在 run.json 中的 agent）
  //    这一步让 B 阶段的真实 spawn 进程在 gateway 重启后自动恢复
  const roomList = roomManager.listRooms();
  for (const room of roomList) {
    await roomManager.ensureReplicasAlive(room.roomId);
    logger.info(`房间 ${room.roomId} 已恢复 ${room.members.filter(m => m.status === 'running').length}/${room.members.length} 个成员`);
  }

  // 设置 gateway URL 供私聊 agent 同步回查
  pm._gatewayUrl = `http://127.0.0.1:${config.port}`;

  // 7. 启动 HTTP 服务
  const app = createGatewayApp(pm, roomManager, { privateRoomHistory, aggregator });
  app.listen(config.port, () => {
    logger.info(`Gateway 监听端口: ${config.port}`);
    logger.info(`可用 Agent: ${pm.listAgents().map(a => `${a.agentId} (${a.status})`).join(', ')}`);
  });
}

main().catch(err => {
  logger.error(`Gateway 启动失败: ${err.message}`);
  process.exit(1);
});