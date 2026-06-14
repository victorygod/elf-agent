/**
 * Gateway Express 路由与中间件
 * SSE 透传 Agent 响应
 */

import fs from 'fs';
import path from 'path';
import express from 'express';
import { createLogger } from '../shared/logger.js';
import { generateDefaultConfigUI } from './config-ui.js';

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

  // GET /agents/:id — 获取单个 Agent 详情
  app.get('/agents/:id', checkAgentExists, (req, res) => {
    res.json(pm.getAgent(req.params.id));
  });

  // POST /agents/:id/start — 启动 Agent
  app.post('/agents/:id/start', checkAgentExists, (req, res) => {
    try {
      const result = pm.startAgent(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // POST /agents/:id/stop — 停止 Agent
  app.post('/agents/:id/stop', checkAgentExists, (req, res) => {
    try {
      const result = pm.stopAgent(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // POST /agents/:id/restart — 重启 Agent
  app.post('/agents/:id/restart', checkAgentExists, async (req, res) => {
    try {
      const result = await pm.restartAgent(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  // POST /agents/:id/chat — 与 Agent 对话（SSE 解析转发 + 写 history）
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

    const userMessage = req.body.message;

    // 写入用户消息到 history
    if (chatHistory) {
      chatHistory.addMessage(id, 'user', userMessage);
    }

    // 设置 SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // 向 Agent 发起请求
    const agentUrl = `http://127.0.0.1:${port}/chat`;

    // 用于拼接 assistant 完整回复
    let assistantContent = '';

    fetch(agentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    }).then(agentRes => {
      if (!agentRes.ok) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: `Agent returned ${agentRes.status}` })}\n\n`);
        res.end();
        return;
      }

      // 解析 SSE 流，同时转发给客户端
      const reader = agentRes.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let currentEvent = '';

      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) {
            // 流结束，写入 assistant 完整回复到 history
            if (chatHistory && assistantContent) {
              chatHistory.addMessage(id, 'assistant', assistantContent);
            }
            res.end();
            return;
          }
          const chunk = decoder.decode(value, { stream: true });

          // 原样转发给客户端
          res.write(chunk);

          // 解析 SSE 事件以拼接 assistant 内容
          sseBuffer += chunk;
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('event: ')) {
              currentEvent = trimmed.slice(7).trim();
            } else if (trimmed.startsWith('data: ')) {
              if (currentEvent === 'token') {
                try {
                  const data = JSON.parse(trimmed.slice(6));
                  if (data.content) {
                    assistantContent += data.content;
                  }
                } catch (e) {
                  // 忽略解析错误
                }
              } else if (currentEvent === 'error') {
                // error 事件也写入已有内容（partial）
                if (chatHistory && assistantContent) {
                  chatHistory.addMessage(id, 'assistant', assistantContent);
                  assistantContent = '';  // 避免重复写入
                }
              }
              currentEvent = '';
            } else if (trimmed === '') {
              currentEvent = '';
            }
          }

          pump();
        }).catch(err => {
          logger.error(`SSE 透传错误: ${err.message}`);
          // 流错误时也写入已有内容
          if (chatHistory && assistantContent) {
            chatHistory.addMessage(id, 'assistant', assistantContent);
            assistantContent = '';
          }
          try {
            res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
          } catch (e) {
            // 流可能已关闭
          }
          res.end();
        });
      }
      pump();

    }).catch(err => {
      logger.error(`Agent 请求失败: ${err.message}`);
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Agent unavailable' })}\n\n`);
      } catch (e) {
        // 流可能已关闭
      }
      res.end();
    });

    // 客户端断开连接时，写入已有内容
    req.on('close', () => {
      if (chatHistory && assistantContent) {
        chatHistory.addMessage(id, 'assistant', assistantContent);
        assistantContent = '';
      }
    });
  });

  // GET /agents/:id/history — 获取聊天记录
  app.get('/agents/:id/history', checkAgentExists, (req, res) => {
    const id = req.params.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const beforeId = req.query.before || null;

    if (!chatHistory) {
      return res.json({ messages: [], hasMore: false });
    }

    try {
      const result = chatHistory.getRecent(id, limit, beforeId);
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
        // Agent 正在处理请求时可能暂时无法响应，仍然清除文件
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
    const configPath = path.join(configDir, 'config.json');

    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // 读取 system prompt 文件内容
      if (raw.systemPromptPath) {
        const promptPath = path.join(configDir, raw.systemPromptPath);
        try {
          raw.systemPrompt = fs.readFileSync(promptPath, 'utf-8');
        } catch (err) {
          raw.systemPrompt = '';
        }
      }

      // 从 api_key.json 读取模型连接配置，合并 provider
      const apiKeyPath = path.join(configDir, 'api_key.json');
      let apiKeyData = {};
      try {
        apiKeyData = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
      } catch (err) {
        // api_key.json 不存在
      }
      raw.model = { provider: raw.provider || 'llm', ...apiKeyData };

      // 检查模型配置是否完整（仅非 mock provider 时检查）
      if (raw.model.provider !== 'mock') {
        const requiredKeys = ['base_url', 'auth_token', 'model'];
        const modelMissing = requiredKeys.filter(k => !raw.model[k]);
        if (modelMissing.length > 0) {
          raw.modelError = `模型配置不完整，请在「模型配置」选项卡中填写：${modelMissing.join('、')}`;
        }
      }

      res.json(raw);
    } catch (err) {
      res.status(500).json({ error: `Failed to read config: ${err.message}` });
    }
  });

  // GET /agents/:id/config-ui — 获取配置页面 HTML
  // 优先读 config/config-ui.html，没有则根据 config.json 自动生成
  app.get('/agents/:id/config-ui', checkAgentExists, (req, res) => {
    const id = req.params.id;
    const configDir = path.join(pm.agentsDir, id, 'config');
    const customUiPath = path.join(configDir, 'config-ui.html');

    // 优先使用自定义模板
    if (fs.existsSync(customUiPath)) {
      try {
        const html = fs.readFileSync(customUiPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } catch (err) {
        // 读取失败，fallback 到自动生成
      }
    }

    // 自动生成
    try {
      const configPath = path.join(configDir, 'config.json');
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // 展开 systemPrompt
      if (raw.systemPromptPath) {
        const promptPath = path.join(configDir, raw.systemPromptPath);
        try { raw.systemPrompt = fs.readFileSync(promptPath, 'utf-8'); } catch (e) { raw.systemPrompt = ''; }
      }

      // 从 api_key.json 读取模型连接配置（单独传递，用于模型选项卡）
      const apiKeyPath = path.join(configDir, 'api_key.json');
      const API_KEY_TEMPLATE = { base_url: '', auth_token: '', model: '' };
      let apiKeyData = null;
      try {
        apiKeyData = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
      } catch (err) {
        // api_key.json 不存在，自动创建空模板
        apiKeyData = { ...API_KEY_TEMPLATE };
        try {
          fs.writeFileSync(apiKeyPath, JSON.stringify(apiKeyData, null, 2), 'utf-8');
        } catch (writeErr) {
          // 创建失败不影响 UI 展示
        }
      }

      const html = generateDefaultConfigUI(id, raw, apiKeyData);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      res.status(500).json({ error: `Failed to generate config UI: ${err.message}` });
    }
  });

  // PUT /agents/:id/config — 更新 Agent 配置
  app.put('/agents/:id/config', checkAgentExists, (req, res) => {
    const id = req.params.id;
    const configDir = path.join(pm.agentsDir, id, 'config');
    const configPath = path.join(configDir, 'config.json');

    try {
      // 读取现有配置
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const update = req.body;

      // 如果更新中包含 systemPrompt，写入 system_prompt.md
      if (update.systemPrompt !== undefined) {
        const promptPath = path.join(configDir, 'system_prompt.md');
        fs.writeFileSync(promptPath, update.systemPrompt, 'utf-8');
        existing.systemPromptPath = 'system_prompt.md';
        delete update.systemPrompt;
      }

      // 如果更新中包含 model，将模型连接字段写入 api_key.json（provider 留在 config.json）
      if (update.model !== undefined) {
        const apiKeyPath = path.join(configDir, 'api_key.json');
        let existingApiKey = {};
        try {
          existingApiKey = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
        } catch (err) {
          // api_key.json 不存在，创建新文件
        }
        // 从 model 中提取属于 api_key.json 的字段（excludes provider）
        const modelUpdate = update.model;
        const apiKeyFields = ['base_url', 'auth_token', 'model'];
        const apiKeyUpdate = {};
        for (const key of apiKeyFields) {
          if (modelUpdate[key] !== undefined) {
            apiKeyUpdate[key] = modelUpdate[key];
          }
        }
        // provider 写入 config.json
        if (modelUpdate.provider !== undefined) {
          existing.provider = modelUpdate.provider;
        }
        if (Object.keys(apiKeyUpdate).length > 0) {
          const mergedApiKey = { ...existingApiKey, ...apiKeyUpdate };
          fs.writeFileSync(apiKeyPath, JSON.stringify(mergedApiKey, null, 2), 'utf-8');
        }
        delete update.model;
      }

      // 合并其余更新到 config.json（不再包含 model）
      for (const [key, value] of Object.entries(update)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && existing[key] && typeof existing[key] === 'object') {
          existing[key] = { ...existing[key], ...value };
        } else {
          existing[key] = value;
        }
      }

      // 写入 config.json
      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');

      // 同步 ProcessManager 中的 config
      const agentData = pm.agents.get(id);
      if (agentData) {
        agentData.config = existing;
      }

      // Agent 的 fs.watch 会自动检测变化并重载
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: `Failed to update config: ${err.message}` });
    }
  });

  // 头像上传 API — base64 格式，存入 agents/{id}/config/
  app.post('/agents/:id/avatar', checkAgentExists, (req, res) => {
    uploadAvatar(req, res, 'avatar');
  });

  app.post('/agents/:id/user-avatar', checkAgentExists, (req, res) => {
    uploadAvatar(req, res, 'userAvatar');
  });

  function uploadAvatar(req, res, fieldName) {
    const id = req.params.id;
    const { data, type } = req.body || {};

    if (!data || !type) {
      return res.status(400).json({ error: 'Missing data or type' });
    }

    // type: "image/png", "image/jpeg", "image/gif", "image/webp"
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    const ext = extMap[type];
    if (!ext) {
      return res.status(400).json({ error: 'Unsupported image type, use png/jpg/gif/webp' });
    }

    // 解码 base64
    const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const configDir = path.join(pm.agentsDir, id, 'config');
    const filename = fieldName === 'avatar' ? `avatar.${ext}` : `user_avatar.${ext}`;
    const filePath = path.join(configDir, filename);

    try {
      // 删除旧头像（不同扩展名的）
      for (const oldExt of ['png', 'jpg', 'gif', 'webp']) {
        const oldFile = path.join(configDir, fieldName === 'avatar' ? `avatar.${oldExt}` : `user_avatar.${oldExt}`);
        if (oldFile !== filePath && fs.existsSync(oldFile)) {
          fs.unlinkSync(oldFile);
        }
      }

      fs.writeFileSync(filePath, buffer);

      // 更新 config.json 中的字段
      const configPath = path.join(configDir, 'config.json');
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      existing[fieldName] = filename;
      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');

      // 同步 ProcessManager
      const agentData = pm.agents.get(id);
      if (agentData) {
        agentData.config = existing;
      }

      res.json({ status: 'ok', path: `/agents/${id}/config/${filename}` });
    } catch (err) {
      res.status(500).json({ error: `Failed to save avatar: ${err.message}` });
    }
  }

  // 静态文件服务 — agent 配置目录（用于头像图片访问）
  // /agents/{id}/config/{filename}
  app.use('/agents/:id/config', (req, res, next) => {
    const agentId = req.params.id;
    // req.path 已经剥离了挂载前缀和 query string，形如 "/avatar.jpg"
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

  // 前端日志 API — 接收前端日志并写入 logs/frontend.log
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

  // 静态文件服务 — 前端页面
  const frontendPath = path.join(process.cwd(), 'frontend');
  app.use(express.static(frontendPath));

  // 错误处理中间件
  app.use((err, req, res, next) => {
    logger.error(`未处理的错误: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}