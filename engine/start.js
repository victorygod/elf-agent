/**
 * Agent 启动入口
 *
 * 从配置目录创建 Agent 并启动 HTTP 服务，监听配置热更新
 * 所有 Agent 共用此入口，Agent 目录只需提供 config/ 即可
 *
 * 用法: node engine/start.js --config agents/elf-001/config
 *
 * 启动流程：设置日志 → agents/<id>/create_agent.js 装配 → 启动 HTTP 服务 → 热加载监听
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setLogFileName as setConfigLogFileName } from './config_loader.js';
import { setAgentLogFileName } from './agent.js';
import { createAgentServer, setServerLogFileName } from './server.js';
import { setLogFileName as setMessageManagerLogFileName } from './message_manager.js';
import { buildRunContext } from './run_context.js';
import { createLogger, enableAgentLogRouting } from '../shared/logger.js';

/**
 * 启动 Agent（实例化改造后支持运行时身份注入）
 *
 * @param {string} configDir - 配置目录路径（类级人设来源）
 * @param {object} [runOpts] - 运行时身份选项（实例化改造第三层）。缺省=私聊默认形态。
 * @param {string} [runOpts.mode='private'] - 'private' | 'room'
 * @param {number} [runOpts.port] - 本实例监听端口；缺省回退 config.port（私聊默认）
 * @param {string} [runOpts.dataDir] - 本实例独占数据目录；缺省回退 agents/<id>/data
 * @param {string} [runOpts.roomId]   - 仅 room 模式：所在群 id
 * @param {string} [runOpts.memberName] - 仅 room 模式：群里名字
 * @param {string} [runOpts.roomBusUrl] - 仅 room 模式：room_bus base url（Speak 回调用）
 *
 * 私聊入口 agents/<id>/index.js 仍调 startAgent(configDir)（单参）→ runOpts 空 → 私聊默认形态，零回归。
 * 副本 spawn 调 startAgent(configDir, {mode:'room', port, dataDir, roomId, memberName, roomBusUrl})。
 */

export async function startAgent(configDir, runOpts = {}) {
  // 1. 预读 agentId（类身份）用于构造 runContext + 日志名
  const configPreview = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'));
  const agentId = configPreview.agentId || 'unknown';

  // 2. 构造 runContext（运行时身份）
  //    port 缺省回退 config.port（私聊默认）；dataDir 缺省回退 fromConfigDir 内的 configDir/..
  //    ELF_PORT_OFFSET：私聊实例监听端口整体偏移（测试用，与真实 gateway 端口隔离）；
  //      真实 gateway 不设此 env → offset 0 → 端口不变。
  const offset = Number(process.env.ELF_PORT_OFFSET) || 0;
  const basePort = typeof configPreview.port === 'number' ? configPreview.port : null;
  const defaultPort = basePort != null ? basePort + offset : null;
  // v4：startAgent 仅私聊。dataDir 优先 ELF_DATA_DIR env（gateway spawn 时设 profiles/agents/<id>/memory），
  //   回退 null（create_agent 再回退 agentMemory(<id>)，开发直跑 index.js 用）。
  let dataDir = runOpts.dataDir ? path.resolve(runOpts.dataDir) : null;
  if (!dataDir && process.env.ELF_DATA_DIR) {
    dataDir = path.resolve(process.env.ELF_DATA_DIR);
  }
  const runContext = buildRunContext({
    agentId,
    mode: runOpts.mode,
    port: runOpts.port ?? defaultPort,
    dataDir,
    // 私聊也是 Room，roomId = chat-<agentId>（PrivateChatPlugin 据此拼 /rooms/<rid>/sync-history）。
    roomId: runOpts.roomId || `chat-${agentId}`,
    memberName: runOpts.memberName,
    roomBusUrl: runOpts.roomBusUrl,
  });

  // 3. 设置日志文件名 —— 按 runKey 区分（私聊 runKey=agentId → 日志名不变；副本带 roomId/agentId）
  //    runKey 含 '/'（roomId/agentId）需转成 '-'，否则 logger 把它当路径分隔符写入不存在的子目录会静默失败。
  const logFileName = `agent-${runContext.runKey.replace(/\//g, '-')}.log`;
  setConfigLogFileName(logFileName);
  setAgentLogFileName(logFileName);
  setServerLogFileName(logFileName);
  setMessageManagerLogFileName(logFileName);

  const logger = createLogger('agent-main', logFileName);

  // 4. 创建 Agent —— 经 agents/<id>/create_agent.js 显式装配入口（不再 fromConfigDir 反射）。
  //    约定：每个 agent 目录下必须有 create_agent.js，导出 createAgent({runContext, dataDir, ...})。
  const createAgentPath = path.join(configDir, '..', 'create_agent.js');
  const { createAgent } = await import(pathToFileURL(createAgentPath).href);
  const agent = await createAgent({
    dataDir: runContext.dataDir,
    runContext,
  });

  // 场景插件走 agent._scene（v3：单一 ScenePlugin，主权 owner）。不 push 进 agent.middlewares（那是
  //   agent-level 横切定制）。实例复用（持状态：RoomPlugin 的 buffer/replying、PrivateChatPlugin 的 syncSource）。
  //   阶段三多实例时 _scene 升 per-instance（RoomState map）。
  // v4：startAgent 仅起私聊（单 agent 进程入口）。群聊实例由共享 agent-server 内 createRoomState 懒建，不经 start.js。
  {
    const gwUrl = runOpts.gatewayUrl || process.env.ELF_GATEWAY_URL;
    if (gwUrl) agent._gatewayUrl = gwUrl;
    const { PrivateChatPlugin, setPrivateChatLogFileName } = await import('./plugins/private_chat_plugin.js');
    setPrivateChatLogFileName(logFileName);
    agent._scene = new PrivateChatPlugin(agent);
    logger.info(`私聊模式：注入 PrivateChatPlugin(run-level) (runKey=${runContext.runKey})`);
  }

  // 5. 启动 HTTP 服务 —— port 读 runContext（兜底 config）
  //    v3：用 options 形态注入 defaultAgent + 工厂参数，支持本进程按 roomId 懒建任意 RoomState
  //    （群聊 /observe 带 roomId → 懒建该群 RoomState，无需 spawn 副本）。
  const port = runContext.port ?? agent.config.get('port');
  const gwUrl = runOpts.gatewayUrl || process.env.ELF_GATEWAY_URL || null;
  // 群聊 RoomState 懒建的数据根：profiles/agents/<id>（dataDir=memory，上一级即 agent 根）。
  //   群聊 RoomState 经 server.js 落 profiles/agents/<id>/rooms/<rid>/，与私聊 memory 隔离。
  const dataRoot = runContext.dataDir ? path.join(runContext.dataDir, '..') : null;
  const agentConfigDirFn = (id) => path.join(process.cwd(), 'agents', id, 'config');
  const app = createAgentServer({
    defaultAgent: agent,
    config: agent.config,
    configDir: agentConfigDirFn,
    dataRoot,
    gatewayUrl: gwUrl,
    defaultAgentId: agentId,
    port,
  });
  const server = app.listen(port, () => {
    logger.info(`Agent ${agentId} (runKey=${runContext.runKey}) listening on port ${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`端口 ${port} 已被占用，Agent ${agentId} 无法启动`);
    } else {
      logger.error(`HTTP 服务错误: ${err.message}`);
    }
    process.exit(1);
  });

  // 6. 监听配置文件变化（热加载）—— room 模式禁用（避免私聊改配触发副本 reload，见 docs §12.5）
  if (runContext.mode !== 'room') {
    try {
      fs.watch(configDir, (eventType, filename) => {
        logger.info(`配置文件变化: ${filename}, 重新加载...`);
        try {
          agent.reloadConfig();
        } catch (err) {
          logger.error(`配置热加载失败: ${err.message}`);
        }
      });
    } catch (err) {
      logger.warn(`无法监听配置目录: ${err.message}`);
    }
  } else {
    logger.info(`room 模式：禁用 config 热加载（runKey=${runContext.runKey}）`);
  }

  return { agent, config: agent.config, server };
}

/**
 * 启动多 agent 的 agent-server（一个进程承载 agents/* 全部 agent，工厂懒建 RoomState）。
 * 与 startAgent（单 agent）对应：经 createAgentServer 工厂模式（configDir fn 覆盖全部 agentId），
 *   无 defaultAgent；/observe 按 (agentId, roomId) 路由（见 server.js 复合键）。
 * gateway 经此模式 spawn 一个 server 进程托管全部 agent（本期 M=1）。
 * 用法：node engine/start.js --serve-all --port 8090 [--gateway-url http://127.0.0.1:8080]
 */
export async function startAgentServer({ port, gatewayUrl } = {}) {
  if (!port || !Number.isFinite(port)) throw new Error('startAgentServer: port 必填');
  const agentsDir = path.join(process.cwd(), 'agents');
  const agentIds = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(id => fs.existsSync(path.join(agentsDir, id, 'config', 'config.json')));
  if (agentIds.length === 0) throw new Error(`未发现 agent：${agentsDir}/*/config/config.json`);

  const logFileName = 'agent-server.log';
  setConfigLogFileName(logFileName);
  setAgentLogFileName(logFileName);
  setServerLogFileName(logFileName);
  setMessageManagerLogFileName(logFileName);
  // 启用 per-agent 日志路由：receive() 经 withAgentLog(agentId) 进上下文后，所有 logger 写 agent-<agentId>.log；
  //   上下文外（建房/生命周期/compact 异步等）仍落 agent-server.log。
  enableAgentLogRouting();
  const logger = createLogger('agent-server-main', logFileName);

  const configDirFn = (id) => path.join(process.cwd(), 'agents', id, 'config');
  // config:null → 多 agent 模式无单一 config（/config、/status 已 guard）；configDir fn 覆盖全部 agentId 供懒建。
  const app = createAgentServer({
    config: null,
    configDir: configDirFn,
    defaultAgentId: null,
    gatewayUrl: gatewayUrl || null,
    port,
  });
  const server = app.listen(port, () => {
    logger.info(`Agent-server 承载 ${agentIds.length} 个 agent [${agentIds.join(', ')}] listening on port ${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') logger.error(`端口 ${port} 已被占用，agent-server 无法启动`);
    else logger.error(`HTTP 服务错误: ${err.message}`);
    process.exit(1);
  });
  return { app, server, agentIds };
}

// 直接运行时执行启动
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 如果作为主模块运行（不是被 import）
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  const runOpts = {};
  let configDir = null;
  let serveAll = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) { configDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--serve-all') { serveAll = true; }
    else if (args[i] === '--port' && args[i + 1]) {
      // parseInt 非数字返回 NaN,会穿透 ??(NaN 非 null/undefined)直达 app.listen(NaN) 抛错。
      // fail-fast:解析失败立即报错,避免下游 listen 失败时错误信息不提 --port(#3)。
      const p = parseInt(args[i + 1], 10);
      if (!Number.isFinite(p) || p < 1 || p > 65535) {
        console.error(`--port 非法: "${args[i + 1]}"(应为 1-65535 整数)`);
        process.exit(1);
      }
      runOpts.port = p; i++;
    }
    else if (args[i] === '--data' && args[i + 1]) { runOpts.dataDir = args[i + 1]; i++; }
    else if (args[i] === '--gateway-url' && args[i + 1]) { runOpts.gatewayUrl = args[i + 1]; i++; }
  }

  // --serve-all：多 agent 的 agent-server（一个进程承载 agents/* 全部 agent）。
  if (serveAll) {
    if (!runOpts.port) {
      console.error('Usage: node start.js --serve-all --port N [--gateway-url http://127.0.0.1:8080]');
      process.exit(1);
    }
    startAgentServer({ port: runOpts.port, gatewayUrl: runOpts.gatewayUrl }).catch(err => {
      const logger = createLogger('agent-server-main', 'agent-error.log');
      logger.error(`Agent-server 启动失败: ${err.message}`);
      process.exit(1);
    });
  } else {
    if (!configDir) {
      console.error('Usage: node start.js --config <config-dir> [--port N] [--data <dir>] [--gateway-url <url>]  |  --serve-all --port N');
      process.exit(1);
    }
    startAgent(configDir, runOpts).catch(err => {
      const logger = createLogger('agent-main', 'agent-error.log');
      logger.error(`Agent 启动失败: ${err.message}`);
      process.exit(1);
    });
  }
}