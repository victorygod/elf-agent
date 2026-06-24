/**
 * Gateway Express 路由与中间件
 * SSE 透传 Agent 响应
 */

import fs from 'fs';
import path from 'path';
import express from 'express';
import { createLogger } from '../shared/logger.js';
import { getConfigUI } from './config-ui.js';
import { readAgentConfig, writeAgentConfig } from './config_store.js';
import { handleAvatarUpload } from './avatar.js';
import { subscribeToStream, proxyChat } from './chat_proxy.js';

const logger = createLogger('gateway-server', 'gateway.log');

/**
 * 创建 Gateway Express 应用
 * @param {ProcessManager} pm - 进程管理器实例
 * @param {ChatHistory} chatHistory - 聊天记录持久化实例
 * @returns {express.Application}
 */
export function createGatewayApp(pm, chatHistory) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // 追踪正在进行的 SSE 流数量（agentId → 计数）
  const activeStreams = new Map();


  // 辅助：检查 Agent 是否存在
  function checkAgentExists(req, res, next) {
    const id = req.params.id;
    if (!pm.hasAgent(id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    next();
  }

  // GET /agents — 列出所有 Agent
  app.get('/agents', (req, res) => {
    const list = pm.listAgents();
    // 附加 streaming 状态
    for (const agent of list) {
      agent.streaming = (activeStreams.get(agent.agentId) || 0) > 0;
    }
    res.json(list);
  });

  // POST /agents/rediscover — 重新扫描文件系统，发现新增/变更的 Agent
  app.post('/agents/rediscover', async (req, res) => {
    try {
      const result = await pm.rediscoverAgents();
      // 重新探活所有 Agent 以更新运行状态
      for (const [id] of pm.agents) {
        await pm.probeAgent(id);
      }
      const list = pm.listAgents();
      for (const agent of list) {
        agent.streaming = (activeStreams.get(agent.agentId) || 0) > 0;
      }
      res.json({
        agents: list,
        discovery: result
      });
    } catch (err) {
      logger.error(`Agent 重新发现失败: ${err.message}`);
      res.status(500).json({ error: `Failed to rediscover agents: ${err.message}` });
    }
  });

  // GET /agents/:id — 获取单个 Agent 详情
  app.get('/agents/:id', checkAgentExists, (req, res) => {
    const id = req.params.id;
    const info = pm.getAgent(id);
    info.streaming = (activeStreams.get(id) || 0) > 0;
    res.json(info);
  });

  // POST /agents/:id/start — 启动 Agent
  app.post('/agents/:id/start', checkAgentExists, async (req, res) => {
    try {
      const result = await pm.startAgent(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // POST /agents/:id/stop — 停止 Agent
  app.post('/agents/:id/stop', checkAgentExists, async (req, res) => {
    try {
      const result = await pm.stopAgent(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // POST /agents/:id/abort — 中断 Agent 当前请求
  app.post('/agents/:id/abort', checkAgentExists, async (req, res) => {
    const id = req.params.id;
    const status = pm.getAgentStatus(id);
    const port = pm.getAgentPort(id);

    if (status !== 'running') {
      return res.status(503).json({ error: 'Agent not running' });
    }

    try {
      const abortRes = await fetch(`http://127.0.0.1:${port}/abort`, { method: 'POST' });
      const data = await abortRes.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /agents/:id/chat — 与 Agent 对话
  // Agent 正在回复中时拒绝新消息（同一 agent 不允许并发对话）
  app.post('/agents/:id/chat', checkAgentExists, (req, res) => {
    const id = req.params.id;
    const status = pm.getAgentStatus(id);
    const port = pm.getAgentPort(id);

    if (status !== 'running') {
      return res.status(503).json({ error: 'Agent unavailable' });
    }

    if (!req.body || typeof req.body.message !== 'string') {
      return res.status(400).json({ error: 'Request body must include "message" field' });
    }

    // ★ Agent 正在回复中，拒绝新消息
    if ((activeStreams.get(id) || 0) > 0) {
      return res.status(422).json({ error: 'Agent 正在回复中，请稍后再试' });
    }

    // 写 user 消息到 jsonl
    const msgRecord = chatHistory ? chatHistory.addMessage(id, 'user', req.body.message) : null;

    // 设置 SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    // 直接代理到 Agent（不经过队列）
    proxyChat({
      agentId: id,
      port,
      message: req.body.message,
      res,
      chatHistory,
      activeStreams,
      userMessageRecord: msgRecord,
    });
  });

  // GET /agents/:id/subscribe — 重新连接 SSE 流（页面刷新后恢复流式输出）
  app.get('/agents/:id/subscribe', checkAgentExists, (req, res) => {
    const id = req.params.id;
    subscribeToStream(id, res, chatHistory);
  });

  // GET /agents/:id/history — 获取聊天记录
  app.get('/agents/:id/history', checkAgentExists, (req, res) => {
    const id = req.params.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const beforeId = req.query.before || null;
    const afterId = req.query.afterId || null;

    if (!chatHistory) {
      return res.json({ messages: [], hasMore: false });
    }

    try {
      const result = chatHistory.getRecent(id, limit, beforeId, afterId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Failed to read history: ${err.message}` });
    }
  });

  // DELETE /agents/:id/history — 清空聊天记录
  app.delete('/agents/:id/history', checkAgentExists, (req, res) => {
    const id = req.params.id;
    try {
      if (chatHistory) {
        chatHistory.clear(id);
      }
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: `Failed to clear history: ${err.message}` });
    }
  });

  // DELETE /agents/:id/memory — 清空 Agent 记忆（context.json + 内存）
  app.delete('/agents/:id/memory', checkAgentExists, async (req, res) => {
    const id = req.params.id;

    // 通知运行中的 Agent 清空内存中的 messages
    const status = pm.getAgentStatus(id);
    if (status === 'running') {
      const port = pm.getAgentPort(id);
      try {
        await fetch(`http://127.0.0.1:${port}/clear`, { method: 'POST' });
      } catch (err) {
        logger.warn(`通知 Agent ${id} 清空内存失败（可能尚未就绪）: ${err.message}`);
      }
    } else {
      // Agent 未运行时，直接清空文件即可
      const contextPath = path.join(pm.agentsDir, id, 'data', 'context.json');
      try {
        if (fs.existsSync(contextPath)) {
          fs.writeFileSync(contextPath, '[]', 'utf-8');
        }
      } catch (err) {
        return res.status(500).json({ error: `Failed to clear memory file: ${err.message}` });
      }
    }

    res.json({ status: 'ok' });
  });

  // GET /agents/:id/config — 获取 Agent 配置
  app.get('/agents/:id/config', checkAgentExists, (req, res) => {
    const id = req.params.id;
    const configDir = path.join(pm.agentsDir, id, 'config');

    try {
      const raw = readAgentConfig(configDir);
      res.json(raw);
    } catch (err) {
      res.status(500).json({ error: `Failed to read config: ${err.message}` });
    }
  });

  // GET /agents/:id/config-ui — 获取配置 UI 布局和配置数据
  app.get('/agents/:id/config-ui', checkAgentExists, (req, res) => {
    const id = req.params.id;
    const configDir = path.join(pm.agentsDir, id, 'config');
    try {
      const result = getConfigUI(configDir, (dir) => readAgentConfig(dir));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Failed to get config UI: ${err.message}` });
    }
  });

  // PUT /agents/:id/config — 更新 Agent 配置
  app.put('/agents/:id/config', checkAgentExists, (req, res) => {
    const id = req.params.id;
    const configDir = path.join(pm.agentsDir, id, 'config');

    try {
      const existing = writeAgentConfig(configDir, req.body);

      // 同步 ProcessManager 中的 config
      const agentData = pm.agents.get(id);
      if (agentData) {
        agentData.config = existing;
      }

      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: `Failed to update config: ${err.message}` });
    }
  });

  // 头像上传 API — base64 格式，存入 agents/{id}/config/
  app.post('/agents/:id/avatar', checkAgentExists, (req, res) => {
    handleAvatarUpload(req, res, 'avatar', pm.agentsDir, pm.agents);
  });

  app.post('/agents/:id/user-avatar', checkAgentExists, (req, res) => {
    handleAvatarUpload(req, res, 'userAvatar', pm.agentsDir, pm.agents);
  });

  // 静态文件服务 — agent 配置目录（用于头像图片访问）
  app.use('/agents/:id/config', (req, res, next) => {
    const agentId = req.params.id;
    const filename = req.path.replace(/^\//, '');
    if (!filename) {
      return res.status(404).json({ error: 'File not found' });
    }
    const filePath = path.join(pm.agentsDir, agentId, 'config', filename);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
    res.status(404).json({ error: 'File not found' });
  });

  // 前端日志 API
  app.post('/api/log', (req, res) => {
    const logDir = path.join(process.cwd(), 'logs');
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (e) { /* ignore */ }
    const { level, message, timestamp } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: 'Missing message' });
    }
    const ts = timestamp || new Date().toISOString();
    const lvl = level || 'INFO';
    const line = `[${ts}] [${lvl}] [frontend] ${message}\n`;
    const logFile = path.join(logDir, 'frontend.log');
    try {
      fs.appendFileSync(logFile, line);
    } catch (e) { /* ignore */ }
    res.json({ status: 'ok' });
  });

  // 静态文件服务 — 前端页面（Vite 构建产物）
  const frontendPath = path.join(process.cwd(), 'frontend', 'dist');
  app.use(express.static(frontendPath));

  // 错误处理中间件
  app.use((err, req, res, next) => {
    logger.error(`未处理的错误: ${err.message}`);
    if (res.headersSent) {
      res.end();
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}
