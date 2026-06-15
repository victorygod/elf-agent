/**
 * Agent HTTP 服务（共享版）
 * 接收 Gateway 请求，暴露 /chat, /config, /status, /abort, /clear 端点
 * 维护请求队列，保证串行处理
 *
 * 所有 Agent 共用此模块 — 业务逻辑差异在 agent.js 中实现，
 * server.js 只是 HTTP 适配层，调用 agent.receive() 获取事件流
 */

import express from 'express';
import { createLogger } from '../logger.js';

let logFileName = null;

export function setServerLogFileName(name) {
  logFileName = name;
}

/**
 * 创建 Agent HTTP 服务
 * @param {Agent} agent - Agent 实例（需提供 receive(message) async generator）
 * @param {Config} config - Config 实例（需提供 getModelConfig/getModelMissingFields/getAll/get）
 * @returns {express.Application}
 */
export function createAgentServer(agent, config) {
  const logger = createLogger('agent-server', logFileName);
  const app = express();
  app.use(express.json());

  // 请求队列 + 消息合并
  let isProcessing = false;
  let pendingMessage = null;       // Agent 忙碌期间积攒的合并消息
  let pendingResponses = [];       // 等待响应的 res 对象列表

  function enqueueRequest(req, res) {
    if (isProcessing) {
      // Agent 正忙，合并消息 + 收集 res
      if (pendingMessage !== null) {
        pendingMessage += '\n' + req.body.message;
      } else {
        pendingMessage = req.body.message;
      }
      pendingResponses.push(res);
    } else {
      pendingResponses = [res];
      processRequest(req.body.message);
    }
  }

  async function processRequest(message) {
    isProcessing = true;
    const currentResponses = [...pendingResponses];
    pendingResponses = [];
    pendingMessage = null;

    try {
      const stream = agent.receive(message);

      // 所有等待的 res 都设置 SSE 头
      for (const r of currentResponses) {
        r.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });

        // 禁用 Nagle 算法，确保 SSE 数据立即发送
        if (r.socket) {
          r.socket.setNoDelay(true);
        }
      }

      for await (const event of stream) {
        const data = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
        for (const r of currentResponses) {
          r.write(data);
        }
      }
      for (const r of currentResponses) {
        r.end();
      }
    } catch (err) {
      logger.error(`请求处理失败: ${err.message}`);
      for (const r of currentResponses) {
        if (!r.headersSent) {
          r.writeHead(500, { 'Content-Type': 'application/json' });
          r.end(JSON.stringify({ error: err.message }));
        } else {
          try {
            r.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
            r.end();
          } catch (e) {
            // 流可能已关闭
          }
        }
      }
    } finally {
      isProcessing = false;
      // 处理完检查是否有积攒的消息
      if (pendingMessage !== null && pendingResponses.length > 0) {
        processRequest(pendingMessage);
      }
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
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
          });

          if (res.socket) {
            res.socket.setNoDelay(true);
          }
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

  // POST /abort — 中断当前请求
  app.post('/abort', (req, res) => {
    if (isProcessing) {
      agent.abort();
      res.json({ status: 'ok', message: 'abort signal sent' });
    } else {
      res.json({ status: 'ok', message: 'no active request' });
    }
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
    res.json({ status: 'ok', agentId: config.get('agentId'), pid: process.pid });
  });

  // POST /shutdown — 优雅关闭 Agent 进程
  app.post('/shutdown', (req, res) => {
    res.json({ status: 'ok' });
    logger.info(`Agent ${config.get('agentId')} 收到 /shutdown 请求，即将退出`);
    process.exit(0);
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