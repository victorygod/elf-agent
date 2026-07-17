/**
 * Agent 启动入口
 *
 * 从配置目录创建 Agent 并启动 HTTP 服务，监听配置热更新
 * 所有 Agent 共用此入口，Agent 目录只需提供 config/ 即可
 *
 * 用法: node shared/agent/start.js --config agents/elf-001/config
 *
 * 启动流程：设置日志 → Agent.fromConfigDir() → 启动 HTTP 服务 → 热加载监听
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setLogFileName as setConfigLogFileName } from './config_loader.js';
import { Agent, setAgentLogFileName } from './default_agent.js';
import { createAgentServer, setServerLogFileName } from './server.js';
import { setLogFileName as setMessageManagerLogFileName } from './message_manager.js';
import { buildRunContext } from './run_context.js';
import { RoomAgent } from './room_agent.js';
import { Speak } from './tools/Speak.js';
import { createLogger } from '../logger.js';

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
  const defaultPort = typeof configPreview.port === 'number' ? configPreview.port : null;
  // room 模式 port fail-fast(防 #5):副本不显式传 port 会回退 config.port(私聊端口),
  // 与常驻私聊实例抢端口 EADDRINUSE 崩溃。room 模式必须显式 port,不回退私聊端口。
  // 注意:buildRunContext 拿到的 port 已是"runOpts.port ?? defaultPort",无法区分来源,故在此判定。
  if (runOpts.mode === 'room' && (runOpts.port === undefined || runOpts.port === null)) {
    throw new Error('room 模式必须显式提供 port(否则回退私聊端口导致冲突)');
  }
  const runContext = buildRunContext({
    agentId,
    mode: runOpts.mode,
    port: runOpts.port ?? defaultPort,
    dataDir: runOpts.dataDir ? path.resolve(runOpts.dataDir) : null,
    roomId: runOpts.roomId,
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

  // 4. 创建 Agent（注入 dataDir + runContext）
  const agent = await Agent.fromConfigDir(configDir, {
    dataDir: runContext.dataDir,
    runContext,
  });

  // 群聊模式：实例升级成 RoomAgent（门控）+ 注册 Speak 工具。
  // setPrototypeOf 升级（保留 fromConfigDir 造的成员自定义 MM/tools/runContext,只换 receive 行为,对齐 §11 坑7 包装而非替换）。
  if (runContext.mode === 'room') {
    Object.setPrototypeOf(agent, RoomAgent.prototype);
    agent.toolRegistry.register(Speak);
    logger.info(`群聊模式：升级 RoomAgent + 注册 Speak (runKey=${runContext.runKey})`);
  }

  // 5. 启动 HTTP 服务 —— port 读 runContext（兜底 config）
  const port = runContext.port ?? agent.config.get('port');
  const app = createAgentServer(agent, agent.config);
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

// 直接运行时执行启动
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 如果作为主模块运行（不是被 import）
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  const runOpts = {};
  let configDir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) { configDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--mode' && args[i + 1]) { runOpts.mode = args[i + 1]; i++; }
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
    else if (args[i] === '--room-id' && args[i + 1]) { runOpts.roomId = args[i + 1]; i++; }
    else if (args[i] === '--member' && args[i + 1]) { runOpts.memberName = args[i + 1]; i++; }
    else if (args[i] === '--room-bus' && args[i + 1]) { runOpts.roomBusUrl = args[i + 1]; i++; }
  }

  if (!configDir) {
    console.error('Usage: node start.js --config <config-dir> [--mode private|room] [--port N] [--data <dir>] [--room-id <id>] [--member <name>] [--room-bus <url>]');
    process.exit(1);
  }

  startAgent(configDir, runOpts).catch(err => {
    const logger = createLogger('agent-main', 'agent-error.log');
    logger.error(`Agent 启动失败: ${err.message}`);
    process.exit(1);
  });
}