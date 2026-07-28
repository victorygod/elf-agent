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
import { registerRoomRoutes } from './room_routes.js';
import { createAgentFromTemplate } from './agent_scaffold.js';
import {
  listSkills, getSkillDetail, deleteSkill, installSkill, browseDirs, skillRoot,
} from './skill_store.js';

const logger = createLogger('gateway-server', 'gateway.log');

/**
 * 创建 Gateway Express 应用
 * @param {ProcessManager} pm - 进程管理器实例
 * @param {object} [roomManager] - 群聊管理器实例（注入 /rooms/* 路由，含私聊 chat-<id>）
 * @param {object} [opts] - { privateRoomHistory }
 * @returns {express.Application}
 */
export function createGatewayApp(pm, roomManager = null, opts = {}) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const privateRoomHistory = opts.privateRoomHistory || null; // v3 私聊房历史（room 模式 ChatHistory）
  // 私聊房需要调 agent /observe——pm 经 roomManager 持有，或直接 pm 引用。
  if (roomManager && !roomManager.pm) roomManager.pm = pm;


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
    res.json(pm.listAgents());
  });

  // POST /agents — 从独立模板创建一个白板 Agent（body: { name }，不读写 elf-001）
  app.post('/agents', async (req, res) => {
    try {
      const { name } = req.body || {};
      const created = await createAgentFromTemplate({ agentsDir: pm.agentsDir, name });
      // 增量扫描，把新目录发现进 ProcessManager 内存
      await pm.rediscoverAgents();
      await pm.probeAgent(created.agentId).catch(() => {});
      res.json(created);
    } catch (err) {
      logger.error(`创建 Agent 失败: ${err.message}`);
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // GET /available-tools — 列出所有可用工具名（来自 engine/tools/index.js 的 re-export）
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
    const info = pm.getAgent(req.params.id);
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

  // v3：废弃旧私聊 HTTP 路由（/agents/:id/chat|subscribe|abort|rewind|checkpoints|history|sync-history|memory）。
  //   私聊统一为 Room，全走 /rooms/chat-<id>/*（见 gateway/room_routes.js）。下面仅保留进程管理与配置路由。

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

  // GET /skills — 列出 ~/.elf/skills 下所有 skill
  app.get('/skills', (req, res) => {
    try {
      res.json({ skills: listSkills(), root: skillRoot() });
    } catch (err) {
      logger.error(`列出 skill 失败: ${err.message}`);
      res.status(500).json({ error: `Failed to list skills: ${err.message}` });
    }
  });

  // GET /skills/:name — 读单个 skill 的 SKILL.md 全文
  app.get('/skills/:name', (req, res) => {
    try {
      const content = getSkillDetail(req.params.name);
      res.json({ content });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // DELETE /skills/:name — 删除一个 skill 目录
  app.delete('/skills/:name', (req, res) => {
    try {
      const result = deleteSkill(req.params.name);
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
    registerRoomRoutes(app, roomManager, { pm, privateRoomHistory });
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
 * 获取所有可用工具名（来自 engine/tools/index.js 的 re-export）
 * 缓存结果，tools/index.js 改动需重启服务
 */
let _availableToolsCache = null;
async function getAvailableTools() {
  if (_availableToolsCache) return _availableToolsCache;
  const toolsPath = path.join(process.cwd(), 'engine', 'tools', 'index.js');
  if (!fs.existsSync(toolsPath)) return [];
  const mod = await import(pathToFileURL(toolsPath).href);
  _availableToolsCache = Object.keys(mod).sort();
  return _availableToolsCache;
}
