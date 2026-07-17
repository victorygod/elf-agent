/**
 * Gateway Express 路由与中间件
 * SSE 透传 Agent 响应
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import express from 'express';
import { createLogger } from '../shared/logger.js';
import { getConfigUI } from './config-ui.js';
import { readAgentConfig, writeAgentConfig } from './config_store.js';
import { loadGatewayConfig, saveGatewayConfig } from './config.js';
import { handleAvatarUpload } from './avatar.js';
import { subscribeToStream, proxyChat } from './chat_proxy.js';
import { snapshotBeforeSend, listCheckpoints, latestCheckpointId, rewindTo } from './snapshot.js';
import { registerRoomRoutes } from './room_routes.js';
import {
  listSkills, getSkillDetail, deleteSkill, installSkill, browseDirs, skillRoots,
} from './skill_store.js';

const logger = createLogger('gateway-server', 'gateway.log');

/**
 * 创建 Gateway Express 应用
 * @param {ProcessManager} pm - 进程管理器实例
 * @param {ChatHistory} chatHistory - 聊天记录持久化实例
 * @param {object} [roomManager] - 群聊管理器实例（可选，注入 /rooms/* 路由）
 * @returns {express.Application}
 */
export function createGatewayApp(pm, chatHistory, roomManager = null) {
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

  // GET /available-tools — 列出所有可用工具名（来自 shared/agent/tools/index.js 的 re-export）
  app.get('/available-tools', async (req, res) => {
    try {
      const tools = await getAvailableTools();
      res.json({ tools });
    } catch (err) {
      logger.error(`获取可用工具列表失败: ${err.message}`);
      res.status(500).json({ error: `Failed to get available tools: ${err.message}` });
    }
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

  // GET /agents/:id/checkpoints — 列出可回退的快照包
  app.get('/agents/:id/checkpoints', checkAgentExists, (req, res) => {
    const id = req.params.id;
    try {
      const checkpoints = listCheckpoints(pm.agentsDir, id);
      logger.info(`[GET /checkpoints ${id}] 返回 ${checkpoints.length} 个: ${checkpoints.map((c, i) => `[${i}]${c.id}@${c.createdAt}`).join(' ')}`);
      res.json({ checkpoints });
    } catch (err) {
      logger.error(`列出 checkpoint 失败 (${id}): ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /agents/:id/rewind — 回退到指定快照包（整文件替换）
  // body: { checkpointId? } 省略 = 最近一个
  app.post('/agents/:id/rewind', checkAgentExists, (req, res) => {
    const id = req.params.id;

    // 0. streaming 守卫：正在回复中拒绝，要求先中断
    if ((activeStreams.get(id) || 0) > 0) {
      return res.status(409).json({ error: 'Agent 正在回复中，请先中断（abort）再回退' });
    }

    const checkpointId = req.body?.checkpointId ?? null;
    logger.info(`[POST /rewind ${id}] 收到请求 checkpointId=${checkpointId || '(latest)'} activeStreams=${activeStreams.get(id) || 0}`);
    const result = rewindTo(pm.agentsDir, id, checkpointId);
    if (!result.ok) {
      logger.warn(`[POST /rewind ${id}] 失败: ${result.error}`);
      return res.status(400).json({ error: result.error });
    }

    // agent 运行中 → 转发 /reload 同步内存；未运行 → 跳过（文件已就绪）
    const status = pm.getAgentStatus(id);
    if (status === 'running') {
      const port = pm.getAgentPort(id);
      fetch(`http://127.0.0.1:${port}/reload`, { method: 'POST' })
        .then(r => r.json())
        .then(() => {
          logger.info(`rewind 后 reload 成功 (${id})`);
        })
        .catch(err => {
          logger.warn(`rewind 后 reload 失败 (${id}): ${err.message}`);
        });
    }

    const remaining = listCheckpoints(pm.agentsDir, id);
    logger.info(`[POST /rewind ${id}] 返回成功，发往前端的 checkpoints 剩余 ${remaining.length} 个: ${remaining.map((c, i) => `[${i}]${c.id}@${c.createdAt}`).join(' ')}`);
    res.json({ status: 'ok', restoredPrompt: result.restoredPrompt, checkpoints: remaining });
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

    // ★ rewind 快照：在写 user 进 jsonl 之前，打一个「说话前」状态快照包
    try {
      snapshotBeforeSend(pm.agentsDir, id, req.body.message);
    } catch (e) {
      logger.warn(`打 rewind 快照失败 (${id}): ${e.message}`);
      // 快照失败不阻塞对话
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

  // ========================
  // Skill 管理（平台级，不带 :id）
  // ========================

  // GET /skills — 列出 user + project 两目录下所有 skill
  app.get('/skills', (req, res) => {
    try {
      res.json({ skills: listSkills(), roots: skillRoots() });
    } catch (err) {
      logger.error(`列出 skill 失败: ${err.message}`);
      res.status(500).json({ error: `Failed to list skills: ${err.message}` });
    }
  });

  // GET /skills/:source/:name — 读单个 skill 的 SKILL.md 全文
  app.get('/skills/:source/:name', (req, res) => {
    try {
      const content = getSkillDetail(req.params.source, req.params.name);
      res.json({ content });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // DELETE /skills/:source/:name — 删除一个 skill 目录
  app.delete('/skills/:source/:name', (req, res) => {
    try {
      const result = deleteSkill(req.params.source, req.params.name);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /skills/install — body: { sourcePath } 把一个目录复制到 ~/.elf/skills/
  app.post('/skills/install', (req, res) => {
    try {
      const { sourcePath } = req.body || {};
      const result = installSkill(sourcePath);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /skills/browse?dir=... — 浏览目录子项（仅目录），供前端选 skill 源
  app.get('/skills/browse', (req, res) => {
    try {
      const result = browseDirs(req.query.dir);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
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
    const { level, message } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: 'Missing message' });
    }
    const frontendLogger = createLogger('frontend', 'frontend.log');
    const lvl = (level || 'INFO').toLowerCase();
    const fn = lvl === 'error' ? 'error' : lvl === 'warn' ? 'warn' : 'info';
    frontendLogger[fn](message);
    res.json({ status: 'ok' });
  });

  // 静态文件服务 — 前端页面（Vite 构建产物）
  const frontendPath = path.join(process.cwd(), 'frontend', 'dist');
  app.use(express.static(frontendPath));

  // 群聊路由（/rooms/*，可选注入）
  if (roomManager) {
    registerRoomRoutes(app, roomManager);
  }

  // 全局设置（用户名、用户头像等）
  // 问题3：同时返回 userUid（稳定身份，默认 default_userid），改名不影响历史归属。
  // sidebarOrder：侧栏手动排序，随 settings 一起返回。
  // userAvatar：全局用户头像，null 表示使用默认色块头像。
  app.get('/settings', (req, res) => {
    const { userName, userAvatar, userUid, sidebarOrder } = loadGatewayConfig();
    res.json({ userName, userAvatar, userUid, sidebarOrder });
  });
  app.put('/settings', (req, res) => {
    const { userName, userAvatar, userUid } = req.body || {};
    if (!userName && !userAvatar) {
      return res.status(400).json({ error: 'userName 或 userAvatar 必填其一' });
    }
    const updates = {};
    if (typeof userName === 'string' && userName.trim()) updates.userName = userName.trim();
    if (typeof userAvatar === 'string' || userAvatar === null) updates.userAvatar = userAvatar;
    if (typeof userUid === 'string' && userUid.trim()) updates.userUid = userUid.trim();
    const updated = saveGatewayConfig(updates);
    res.json({ userName: updated.userName, userAvatar: updated.userAvatar, userUid: updated.userUid });
  });

  // 侧栏排序：单独端点保存，避免与 PUT /settings 的 userName 必填校验耦合
  app.put('/settings/sidebar-order', (req, res) => {
    const so = req.body?.sidebarOrder;
    if (!so || typeof so !== 'object') {
      return res.status(400).json({ error: 'sidebarOrder 必填' });
    }
    const updated = saveGatewayConfig({ sidebarOrder: so });
    res.json({ sidebarOrder: updated.sidebarOrder });
  });

  // 用户头像保存（接收 base64，存为 uploads/user_avatar.{ext}，gateway.json 记录文件名）
  const EXT_MAP = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const uploadsDir = path.join(process.cwd(), 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  app.post('/settings/avatar', (req, res) => {
    try {
      const { data, type } = req.body || {};
      if (!data || !type) {
        return res.status(400).json({ error: '缺少 data 或 type 字段' });
      }
      const ext = EXT_MAP[type];
      if (!ext) {
        return res.status(400).json({ error: '不支持的图片类型，仅 png/jpg/gif/webp' });
      }
      // 清理旧头像（不同扩展名）
      for (const oldExt of ['png', 'jpg', 'gif', 'webp']) {
        const oldFile = path.join(uploadsDir, `user_avatar.${oldExt}`);
        if (fs.existsSync(oldFile)) {
          try { fs.unlinkSync(oldFile); } catch (e) { /* ignore */ }
        }
      }
      const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const filename = `user_avatar.${ext}`;
      fs.writeFileSync(path.join(uploadsDir, filename), buffer);

      const updated = saveGatewayConfig({ userAvatar: filename });
      res.json({ userAvatar: updated.userAvatar });
    } catch (err) {
      res.status(500).json({ error: `保存头像失败: ${err.message}` });
    }
  });

  // uploads 静态目录（用户头像文件访问）
  app.use('/uploads', (req, res) => {
    const filename = req.path.replace(/^\//, '');
    if (!filename) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(uploadsDir, filename);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return res.sendFile(filePath);
    }
    res.status(404).json({ error: 'File not found' });
  });

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

/**
 * 获取所有可用工具名（来自 shared/agent/tools/index.js 的 re-export）
 * 缓存结果，tools/index.js 改动需重启服务
 */
let _availableToolsCache = null;
async function getAvailableTools() {
  if (_availableToolsCache) return _availableToolsCache;
  const toolsPath = path.join(process.cwd(), 'shared', 'agent', 'tools', 'index.js');
  const mod = await import(pathToFileURL(toolsPath).href);
  _availableToolsCache = Object.keys(mod).sort();
  return _availableToolsCache;
}
