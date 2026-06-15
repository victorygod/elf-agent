/**
 * elf-002 Agent HTTP 服务 — re-export 共享版本
 * server.js 是纯 HTTP 适配层，不含 agent 特有业务逻辑
 * 如果需要额外的 HTTP 端点，在此文件中扩展
 */

export { createAgentServer, setServerLogFileName } from '../../shared/agent/server.js';