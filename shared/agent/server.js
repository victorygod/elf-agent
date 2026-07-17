/**
 * Agent HTTP 服务
 *
 * 暴露 /chat, /config, /status, /abort, /clear, /shutdown 端点
 * 维护请求队列，保证串行处理
 * 纯 HTTP 适配层，调用 agent.receive() 获取事件流
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
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
  // 实例化改造：新增 runKey（运行时身份，区分副本）；保留 agentId（类身份）向后兼容。
  // 注意：gateway process_manager.probeAgent 只读 data.pid（process_manager.js:157），
  //       test/agent.test.js:815 硬断言 data.agentId，故 agentId 必须保留。
  app.get('/status', (req, res) => {
    res.json({
      status: 'ok',
      agentId: config.get('agentId'),
      runKey: agent.runContext?.runKey || config.get('agentId'),
      mode: agent.runContext?.mode || 'private',
      pid: process.pid,
    });
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
      // 清空记忆 = 会话重开：重置 skill 清单去重快照 + 清触发记录（会话重开，触发历史也归零）
      if (typeof agent._resetSkillPushState === 'function') {
        agent._resetSkillPushState();
      }
      if (Array.isArray(agent._invokedSkills)) {
        agent._invokedSkills.length = 0;
      }
      // 立即把全量 skill 清单重新注入空 messages——会话重开就该有 listing 在场，
      // 不必等用户发下一条消息再补。门控在 _injectSkillListing 内（未启用 skill 则跳过）。
      if (typeof agent._injectSkillListing === 'function') {
        agent._injectSkillListing();
      }
      // §12.4：清记忆时一并清 tool-results/（elf-002 类 MM 有 _cleanupToolResults 用它;
      //   其它 agent 若 dataDir 下有 tool-results 目录也删,避免孤儿）。
      if (typeof agent.messageManager._cleanupToolResults === 'function') {
        agent.messageManager._cleanupToolResults();
      } else if (agent.messageManager.dataDir) {
        const trDir = path.join(agent.messageManager.dataDir, 'tool-results');
        try { if (fs.existsSync(trDir)) fs.rmSync(trDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
      logger.info('Agent 记忆已清空');
      res.json({ status: 'ok' });
    } catch (err) {
      logger.error(`清空记忆失败: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /reload — rewind 后从 context.json 重新加载 messages
  // 由 gateway /agents/:id/rewind 转发，整文件覆盖回 data/ 后调本端点同步内存。
  app.post('/reload', (req, res) => {
    // streaming 中拒绝（应由 gateway streaming 守卫保证不会到这，双保险）
    if (isProcessing) {
      return res.status(409).json({ error: 'Agent 正在处理，无法 reload' });
    }
    try {
      agent.messageManager.reloadFromDisk();
      logger.info('Agent 已从 context.json reload');
      res.json({ status: 'ok' });
    } catch (err) {
      logger.error(`reload 失败: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ===== 群聊 /observe 端点（仅 room 模式）=====
  // 设计见 docs/chat-room-design.md §7.2、§12.1。
  // 与 /chat 的差异：结构化 payload（{from,content,mentions,role}）+ JSON ack（非 SSE）+
  //   独立队列（不依赖 pendingResponses,避免 JSON ack 模式队列不动坑）。
  //   RoomAgent.receive 内部判 mentions 决定 reason 还是只累积。
  if (agent.runContext?.mode === 'room') {
    let observeProcessing = false;
    let pendingObserve = null; // {from, contents:string[], mentions:Set}

    async function processObserve(payload) {
      observeProcessing = true;
      try {
        // drain：内部事件不转发（群聊只 Speak 出口,内心隔离），消耗完即可
        for await (const _evt of agent.receive(payload)) { /* swallow */ }
      } catch (err) {
        logger.error(`/observe 处理失败: ${err.message}`);
      } finally {
        observeProcessing = false;
        if (pendingObserve) {
          const next = pendingObserve; pendingObserve = null;
          processObserve(next);
        }
      }
    }

    app.post('/observe', (req, res) => {
      const body = req.body || {};
      if (typeof body.content !== 'string' && typeof body.message !== 'string') {
        return res.status(400).json({ error: 'content 必填' });
      }
      const payload = {
        from: body.from,
        content: body.content ?? body.message,
        mentions: Array.isArray(body.mentions) ? body.mentions : [],
        role: body.role || 'chat',
      };

      if (observeProcessing) {
        // 忙：合并进 pendingObserve（保留 from/mentions,content 追加）
        if (!pendingObserve) {
          pendingObserve = { from: payload.from, contents: [], mentions: new Set(payload.mentions) };
        }
        pendingObserve.contents.push(payload.content);
        for (const m of payload.mentions) pendingObserve.mentions.add(m);
        return res.json({ ack: true, merged: true });
      }

      // 空闲：直接处理
      processObserve(payload).catch(err => logger.error(`processObserve 失败: ${err.message}`));
      res.json({ ack: true });
    });
  }

  return app;
}