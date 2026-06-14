/**
 * Agent HTTP 服务
 * 接收 Gateway 请求，暴露 /chat, /config, /status 端点
 * 维护请求队列，保证串行处理
 */

import express from 'express';
import { createLogger } from '../../shared/logger.js';

let logFileName = null;

export function setServerLogFileName(name) {
  logFileName = name;
}

/**
 * 创建 Agent HTTP 服务
 */
export function createAgentServer(agent, config) {
  const logger = createLogger('agent-server', logFileName);
  const app = express();
  app.use(express.json());

  // 请求队列
  const requestQueue = [];
  let isProcessing = false;

  function enqueueRequest(req, res) {
    requestQueue.push({ req, res });
    if (!isProcessing) {
      processNext();
    }
  }

  async function processNext() {
    if (requestQueue.length === 0) return;
    isProcessing = true;

    const { req, res } = requestQueue.shift();
    try {
      const stream = agent.receive(req.body.message);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      for await (const event of stream) {
        res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
      res.end();
    } catch (err) {
      logger.error(`请求处理失败: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
          res.end();
        } catch (e) {
          // 流可能已关闭
        }
      }
    } finally {
      isProcessing = false;
      processNext();
    }
  }

  // POST /chat
  app.post('/chat', (req, res) => {
    if (!req.body || typeof req.body.message !== 'string') {
      return res.status(400).json({ error: 'Request body must include "message" field' });
    }

    // 仅在 provider 非 mock 时检查模型配置是否完整
    const modelConfig = config.getModelConfig();
    if (modelConfig.provider !== 'mock') {
      const missing = config.getModelMissingFields();
      if (missing) {
        // 重新加载 api_key.json 以确保拿到最新配置
        try { config.load(); } catch (e) { /* 忽略重载失败 */ }
        const missingAfterReload = config.getModelMissingFields();
        if (missingAfterReload) {
          // 通过 SSE error 事件返回，让错误信息透传到聊天区
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          const fieldLabels = { base_url: 'API Base URL', auth_token: 'Auth Token', model: '模型名称' };
          const labeled = missingAfterReload.map(k => fieldLabels[k] || k).join('、');
          res.write(`event: error\ndata: ${JSON.stringify({ message: `模型配置不完整，缺少以下字段：${labeled}。请在配置页面的「模型配置」选项卡中填写。` })}\n\n`);
          res.end();
          return;
        }
      }
    }

    enqueueRequest(req, res);
  });

  // GET /config
  app.get('/config', (req, res) => {
    const allConfig = config.getAll();
    // 仅在 provider 非 mock 时检查模型配置完整性
    const modelConfig = config.getModelConfig();
    if (modelConfig.provider !== 'mock') {
      const missing = config.getModelMissingFields();
      if (missing) {
        allConfig.modelError = `模型配置不完整，请在「模型配置」选项卡中填写：${missing.join('、')}`;
      }
    }
    res.json(allConfig);
  });

  // GET /status
  app.get('/status', (req, res) => {
    res.json({ status: 'ok', agentId: config.get('agentId') });
  });

  // POST /clear — 清空 Agent 记忆（context.json）
  app.post('/clear', (req, res) => {
    try {
      agent.messageManager.clear();
      logger.info('Agent 记忆已清空');
      res.json({ status: 'ok' });
    } catch (err) {
      logger.error(`清空记忆失败: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}