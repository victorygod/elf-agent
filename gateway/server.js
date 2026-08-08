/**
 * Gateway Express 路由与中间件
 * SSE 透传 Agent 响应
 *
 * 多用户改造（docs/multi-user-auth-design.md）：
 *  - /auth/* 注册/登录/me（无鉴权）
 *  - 全局鉴权中间件：express.json 之后、一切业务路由之前（含 plugin-loader 注册的 agent 路由）
 *  - 写操作（config PUT / 建 agent / skill 管理 / 群管理）仅 admin；访客只读
 *  - start/stop 按角色分派：admin=全局启停；visitor=自己的私聊 room 开关
 *  - /settings 改为 per-user（读写 profiles/users/<uid>/user.json）
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
import { registerAgentAPIs } from './plugin-loader.js';
import { createAuthRouter, setJwtSecret, saveUser, setRoomEnabledForUser, changeUserPassword } from './auth.js';
import { createAuthMiddleware, requireAdmin } from './auth_middleware.js';
import { userDir } from '../shared/profiles_paths.js';
import { UsageStore } from './usage_store.js';
import {
  listSkills, getSkillDetail, deleteSkill, installSkill, browseDirs, skillRoot,
} from './skill_store.js';
import { readGlobalModels, writeGlobalModels } from './api_key_store.js';

const logger = createLogger('gateway-server', 'gateway.log');

/**
 * 创建 Gateway Express 应用
 * @param {ProcessManager} pm - 进程管理器实例
 * @param {object} [roomManager] - 群聊管理器实例（注入 /rooms/* 路由，含私聊 chat-<uid>-<id>）
 * @param {object} [opts] - { privateRoomHistory }
 * @returns {express.Application}
 */
export function createGatewayApp(pm, roomManager = null, opts = {}) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const privateRoomHistory = opts.privateRoomHistory || null; // v3 私聊房历史（room 模式 ChatHistory）
  const aggregator = opts.aggregator || null; // 聚合 SSE(前端常驻 1 条,解 6 连接上限)
  const usageStore = new UsageStore();   // 用量聚合读取(只读 profiles/usage/*.jsonl,gateway 进程)
  // 私聊房需要调 agent /observe——pm 经 roomManager 持有，或直接 pm 引用。
  if (roomManager && !roomManager.pm) roomManager.pm = pm;

  // ===== 鉴权（/auth 公开；其余业务路由一律过中间件）=====
  const gwConfig = loadGatewayConfig();
  setJwtSecret(gwConfig.jwtSecret);
  app.use('/auth', createAuthRouter());
  app.use(createAuthMiddleware({ internalToken: gwConfig.internalToken }));

  // 辅助：检查 Agent 是否存在
  function checkAgentExists(req, res, next) {
    const id = req.params.id;
    if (!pm.hasAgent(id)) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    next();
  }

  /** 私聊 roomId：chat-<uid>-<agentId>（uid 不含 '-'，agentId 可含 '-'） */
  const privateRoomId = (uid, agentId) => `chat-${uid}-${agentId}`;

  /**
   * 按请求者视角输出 agent 列表/详情。
   * 访客的 status 反映「自己的私聊 room 可用性」：自己未停用 → running，否则 stopped。
   * （私聊实例完全用户自治：不再依赖全局 admin 启停，只要求共享 agent-server 进程在跑。）
   * 这样前端自动启停逻辑（status!=='running' 就 start）对两种角色都成立，无需分支。
   */
  function presentAgent(info, user) {
    if (!info || user?.role !== 'visitor') return info;
    const enabled = !(user.disabledAgents || []).includes(info.agentId);
    return { ...info, status: enabled ? 'running' : 'stopped' };
  }

  // GET /agents — 列出所有 Agent（按请求者视角）
  app.get('/agents', (req, res) => {
    res.json(pm.listAgents().map(a => presentAgent(a, req.user)));
  });

  // POST /agents — 从独立模板创建一个白板 Agent（admin）
  app.post('/agents', requireAdmin, async (req, res) => {
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

  // POST /agents/rediscover — 重新扫描文件系统，发现新增/变更的 Agent（admin）
  app.post('/agents/rediscover', requireAdmin, async (req, res) => {
    try {
      const result = await pm.rediscoverAgents();
      // 重新探活所有 Agent 以更新运行状态
      for (const [id] of pm.agents) {
        await pm.probeAgent(id);
      }
      const list = pm.listAgents();
      res.json({
        agents: list.map(a => presentAgent(a, req.user)),
        discovery: result
      });
    } catch (err) {
      logger.error(`Agent 重新发现失败: ${err.message}`);
      res.status(500).json({ error: `Failed to rediscover agents: ${err.message}` });
    }
  });

  // GET /agents/:id — 获取单个 Agent 详情（按请求者视角）
  app.get('/agents/:id', checkAgentExists, (req, res) => {
    const info = pm.getAgent(req.params.id);
    res.json(presentAgent(info, req.user));
  });

  // POST /agents/:id/start — 启动（admin=全局启停共享 server 上的 agent；visitor=启用自己的私聊 room）
  //   私聊实例用户自治：访客 start 只启用自己的 chat-<uid>-<id>，不依赖 admin 的全局开关；
  //   只需共享 agent-server 进程在跑（未起则懒起——共享资源，起一次所有人受益）。
  app.post('/agents/:id/start', checkAgentExists, async (req, res) => {
    try {
      if (req.user?.role === 'visitor') {
        // 确保共享 server 在跑（未起则懒起）
        if (pm.server.status !== 'running') await pm.ensureServerUp();
        setRoomEnabledForUser(req.user.uid, req.params.id, true);
        return res.json({ agentId: req.params.id, status: 'running' });
      }
      const result = await pm.startAgent(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // POST /agents/:id/stop — 停止（admin=全局；visitor=停用自己的私聊 room，不影响他人）
  app.post('/agents/:id/stop', checkAgentExists, async (req, res) => {
    try {
      if (req.user?.role === 'visitor') {
        setRoomEnabledForUser(req.user.uid, req.params.id, false);
        // 中断该用户在飞回合（其他用户的 room 不动）
        const port = pm.getServerPort?.();
        if (port) {
          const rid = privateRoomId(req.user.uid, req.params.id);
          fetch(`http://127.0.0.1:${port}/abort/${encodeURIComponent(rid)}`, { method: 'POST', signal: AbortSignal.timeout(3000) })
            .catch(() => { /* 无在飞回合或 server 未起，忽略 */ });
        }
        return res.json({ agentId: req.params.id, status: 'stopped' });
      }
      const result = await pm.stopAgent(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // v3：废弃旧私聊 HTTP 路由（/agents/:id/chat|subscribe|abort|rewind|checkpoints|history|sync-history|memory）。
  //   私聊统一为 Room，全走 /rooms/chat-<uid>-<id>/*（见 gateway/room_routes.js）。下面仅保留进程管理与配置路由。

  // GET /agents/:id/config — 获取 Agent 配置（访客可读，面板只读由前端按角色渲染）
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

  // GET /agents/:id/usage/summary — 单 agent 用量聚合(模型配置 tab 图 + 标题卡基线)。
  //   任意已登录用户可读(标题卡每用户都要显示自己 agent 的累计);维度 bucket/groupBy 由 query 控制。
  app.get('/agents/:id/usage/summary', checkAgentExists, (req, res) => {
    const { from, to, tz, bucket, groupBy } = req.query;
    res.json(usageStore.agentSummary(req.params.id, { from, to, tz, bucket, groupBy }));
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

  // 注册 agent 专属 API 路由（扫描 agents/{id}/ui/api.js）
  // 放在 config-ui 之后、通配路由之前，确保专属路由优先
  // 鉴权：全局中间件已覆盖（req.user 可用）；agent 插件内的写操作自行加 requireAdmin
  registerAgentAPIs(app, pm, pm.agentsDir, { requireAdmin }).catch(err => {
    logger.error(`Agent API 注册失败: ${err.message}`);
  });

  // PUT /agents/:id/config — 更新 Agent 配置（admin）
  app.put('/agents/:id/config', checkAgentExists, requireAdmin, (req, res) => {
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

  // DELETE /skills/:name — 删除一个 skill 目录（admin）
  app.delete('/skills/:name', requireAdmin, (req, res) => {
    try {
      const result = deleteSkill(req.params.name);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ========================
  // LLM API 管理（admin）
  // ========================

  // GET /models — 获取全局模型库
  app.get('/models', (req, res) => {
    try {
      const models = readGlobalModels();
      res.json(models);
    } catch (err) {
      logger.error(`读取模型库失败: ${err.message}`);
      res.status(500).json({ error: `Failed to read models: ${err.message}` });
    }
  });

  // PUT /models — 更新全局模型库（admin）
  app.put('/models', requireAdmin, (req, res) => {
    try {
      const { models } = req.body || {};
      if (!Array.isArray(models)) {
        return res.status(400).json({ error: 'models must be an array' });
      }

      // 校验 model_id 唯一性
      const modelIds = models.map(m => m.model_id).filter(Boolean);
      const uniqueIds = new Set(modelIds);
      if (modelIds.length !== uniqueIds.size) {
        return res.status(400).json({ error: 'model_id 必须唯一' });
      }

      // 校验每个模型的必填字段
      for (const model of models) {
        if (!model.model_id || !model.base_url || !model.auth_token || !model.model) {
          return res.status(400).json({ error: '每个模型必须包含 model_id、base_url、auth_token、model 字段' });
        }
      }

      writeGlobalModels(models);
      logger.info(`更新模型库成功，共 ${models.length} 个模型`);
      res.json({ status: 'ok', count: models.length });
    } catch (err) {
      logger.error(`更新模型库失败: ${err.message}`);
      res.status(500).json({ error: `Failed to write models: ${err.message}` });
    }
  });

  // POST /skills/install — body: { sourcePath } 把一个目录复制到 ~/.elf/skills/（admin）
  app.post('/skills/install', requireAdmin, (req, res) => {
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

  // 头像上传 API — base64 格式，存入 agents/{id}/config/（admin；agent 人设属平台共享资源）
  app.post('/agents/:id/avatar', checkAgentExists, requireAdmin, (req, res) => {
    handleAvatarUpload(req, res, 'avatar', pm.agentsDir, pm.agents);
  });

  app.post('/agents/:id/user-avatar', checkAgentExists, requireAdmin, (req, res) => {
    handleAvatarUpload(req, res, 'userAvatar', pm.agentsDir, pm.agents);
  });

  // 静态文件服务 — agent 配置目录（用于头像图片访问；图片免鉴权，见 auth_middleware 白名单）
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
    registerRoomRoutes(app, roomManager, { pm, privateRoomHistory, requireAdmin });
  }

  // POST /subscribe — 聚合 SSE:前端全程 1 条,收所有私聊房 + 群聊房事件(带 {roomId,roomType})。
  //   多用户：attach 带 req.user，私聊房按该用户启用态过滤（见 aggregated_stream.js）。
  app.post('/subscribe', (req, res) => {
    if (!aggregator) return res.status(503).json({ error: '聚合订阅未启用' });
    aggregator.attach(res, req.user);
  });

  // GET /usage/summary — 全局用量看板(admin):时间(天/小时)× 维度(agent/model)聚合 + KPI。
  app.get('/usage/summary', requireAdmin, (req, res) => {
    const { from, to, tz, bucket, groupBy } = req.query;
    res.json(usageStore.summary({ from, to, tz, bucket, groupBy }));
  });

  // ===== 全局设置（per-user：读写 profiles/users/<uid>/user.json）=====
  // 返回字段保持旧契约（userUid = uid），前端 roomStore 无需改结构。
  app.get('/settings', (req, res) => {
    const u = req.user;
    if (!u) return res.status(401).json({ error: '未登录' });
    res.json({
      userName: u.userName || u.username,
      userAvatar: u.userAvatar ?? null,
      userUid: u.uid,
      username: u.username,
      role: u.role,
      sidebarOrder: u.sidebarOrder || { rooms: [], agents: [] },
    });
  });
  app.put('/settings', (req, res) => {
    const u = req.user;
    if (!u) return res.status(401).json({ error: '未登录' });
    const { userName, sidebarOrder, userAvatar } = req.body || {};
    if (typeof userName === 'string' && userName.trim()) u.userName = userName.trim();
    // userAvatar === null → 移除头像（删文件 + 清字段）；上传走 POST /settings/avatar，不经这里
    if (userAvatar === null) {
      const dir = userDir(u.uid);
      for (const ext of ['png', 'jpg', 'gif', 'webp']) {
        const f = path.join(dir, `avatar.${ext}`);
        if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch (e) { logger.warn(`删旧头像失败 ${f}: ${e.message}`); } }
      }
      u.userAvatar = null;
    }
    if (sidebarOrder && typeof sidebarOrder === 'object') {
      const isStrArr = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');
      u.sidebarOrder = {
        rooms: isStrArr(sidebarOrder.rooms) ? sidebarOrder.rooms : [],
        agents: isStrArr(sidebarOrder.agents) ? sidebarOrder.agents : [],
      };
    }
    saveUser(u);
    res.json({ userName: u.userName, userAvatar: u.userAvatar ?? null, userUid: u.uid, role: u.role, sidebarOrder: u.sidebarOrder });
  });

  // 修改密码（校验旧密码；前端成功后清 token 强制重新登录）
  app.put('/settings/password', (req, res) => {
    const u = req.user;
    if (!u) return res.status(401).json({ error: '未登录' });
    const { oldPassword, newPassword } = req.body || {};
    const result = changeUserPassword(u.uid, oldPassword, newPassword);
    if (result.error) return res.status(result.statusCode || 400).json({ error: result.error });
    res.json({ status: 'ok' });
  });

  // 侧栏排序：单独端点保存，避免与 PUT /settings 的校验耦合
  app.put('/settings/sidebar-order', (req, res) => {
    const u = req.user;
    if (!u) return res.status(401).json({ error: '未登录' });
    const so = req.body?.sidebarOrder;
    if (!so || typeof so !== 'object') {
      return res.status(400).json({ error: 'sidebarOrder 必填' });
    }
    const isStrArr = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');
    u.sidebarOrder = {
      rooms: isStrArr(so.rooms) ? so.rooms : [],
      agents: isStrArr(so.agents) ? so.agents : [],
    };
    saveUser(u);
    res.json({ sidebarOrder: u.sidebarOrder });
  });

  // 用户头像保存（接收 base64，存 profiles/users/<uid>/avatar.<ext>，user.json 记录扩展名）
  const EXT_MAP = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

  app.post('/settings/avatar', (req, res) => {
    const u = req.user;
    if (!u) return res.status(401).json({ error: '未登录' });
    try {
      const { data, type } = req.body || {};
      if (!data || !type) {
        return res.status(400).json({ error: '缺少 data 或 type 字段' });
      }
      const ext = EXT_MAP[type];
      if (!ext) {
        return res.status(400).json({ error: '不支持的图片类型，仅 png/jpg/gif/webp' });
      }
      const dir = userDir(u.uid);
      fs.mkdirSync(dir, { recursive: true });
      // 清理旧头像（不同扩展名）
      for (const oldExt of ['png', 'jpg', 'gif', 'webp']) {
        const oldFile = path.join(dir, `avatar.${oldExt}`);
        if (fs.existsSync(oldFile)) {
          try { fs.unlinkSync(oldFile); } catch (e) { logger.warn(`删旧头像失败 ${oldFile}: ${e.message}`); }
        }
      }
      const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(path.join(dir, `avatar.${ext}`), buffer);

      u.userAvatar = ext;
      saveUser(u);
      res.json({ userAvatar: u.userAvatar });
    } catch (err) {
      res.status(500).json({ error: `保存头像失败: ${err.message}` });
    }
  });

  // 用户头像访问（公开：<img> 标签发不了 Authorization 头）
  app.get('/users/:uid/avatar', (req, res) => {
    const dir = userDir(req.params.uid);
    for (const ext of ['webp', 'png', 'jpg', 'gif']) {
      const p = path.join(dir, `avatar.${ext}`);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return res.sendFile(p);
      }
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
