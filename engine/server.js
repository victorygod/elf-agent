/**
 * Agent HTTP 服务（v3：单进程承载多 Room，Map<roomId, RoomState>）
 *
 * 两种装配形态：
 *   1) 旧版单 agent（agents/<id>/index.js 经 start.js 调）：createAgentServer(agent, config) →
 *      包装成默认私聊 RoomState（roomId = 'chat-<agentId>'），/chat、/events、/observe、/clear、
 *      /reload、/status、/shutdown 全部沿用旧语义，零回归。
 *   2) 多房（room_state 工厂）：createAgentServer({ config, configDir, dataRoot, gatewayUrl, port })
 *      → 按 roomId 懒创建 RoomState（私聊 / 群聊），/observe 按 body.roomId 路由。
 *
 * 并发：跨 room 完全并发（各 RoomState 独立 async 链 + 独立 observe 队列），同 room 串行（队列）。
 * AbortController per-room（每个 RoomState 自带 agent.abort）。/events 单端点、event data 带 _roomId。
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { createRoomState } from './room_state.js';
import { agentRoomState, agentMemory } from '../shared/profiles_paths.js';

let logFileName = null;

export function setServerLogFileName(name) {
  logFileName = name;
}

/**
 * 创建 Agent HTTP 服务。兼容两种调用：createAgentServer(agent, config) 或 createAgentServer({agent, config, configDir, dataRoot, gatewayUrl, port})。
 * @returns {express.Application}
 */
export function createAgentServer(agentOrOpts, legacyConfig) {
  const logger = createLogger('agent-server', logFileName);
  const app = express();
  app.use(express.json());

  // 归一化参数：
  //   旧版两参 createAgentServer(agent, config) → 默认房 = chat-<agentId>，无工厂（只认默认房）。
  //   多房 createAgentServer({ defaultAgent, config, configDir, dataRoot, gatewayUrl, defaultAgentId, port })
  //     → 默认房来自 defaultAgent + 工厂支持任意 roomId 懒建（私聊/群聊）。
  let defaultRoom = null;
  let config = legacyConfig;
  let factoryOpts = null;
  let defaultAgentId = null;
  // opts 形态判定：含 defaultAgent / configDir / dataRoot 任一即视为 opts（非裸 Agent 实例）。
  const isOptsObj = agentOrOpts && typeof agentOrOpts === 'object'
    && (agentOrOpts.defaultAgent || agentOrOpts.configDir || agentOrOpts.dataRoot)
    && typeof agentOrOpts.receive !== 'function';
  if (isOptsObj) {
    config = agentOrOpts.config || legacyConfig;
    defaultAgentId = agentOrOpts.defaultAgentId || null;
    // 默认房：用预构建的 defaultAgent（start.js 已建好私聊实例），或 lazy 建 chat-<agentId>。
    if (agentOrOpts.defaultAgent) {
      const a = agentOrOpts.defaultAgent;
      const aid = agentOrOpts.defaultAgentId || a.runContext?.agentId || a.config?.get?.('agentId') || 'unknown';
      defaultRoom = { agentId: aid, roomId: `chat-${aid}`, agent: a, runContext: a.runContext, plugin: a._scene, observeProcessing: false, pendingObserve: null };
    }
    if (agentOrOpts.configDir) {
      factoryOpts = agentOrOpts;
    }
  } else {
    const agent = agentOrOpts;
    const agentId = config?.get?.('agentId') || agent?.config?.get?.('agentId') || 'unknown';
    defaultAgentId = agentId;
    defaultRoom = { agentId, roomId: `chat-${agentId}`, agent, runContext: agent.runContext, plugin: agent._scene, observeProcessing: false, pendingObserve: null };
  }

  // ===== 共享：eventsClients（/events SSE 全局 Set）+ _pushEvent 通用写入（带 roomId）=====
  const eventsClients = new Set();
  /** 把事件推给所有 /events 订阅者。data 经归一化保证带 _roomId（路由用）。 */
  const serverPushEvent = (eventName, data) => {
    const base = (data && typeof data === 'object') ? data : {};
    const payload = { _agentId: '', _roomId: '', ...base };
    const chunk = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of eventsClients) {
      try {
        if (!res.writable) { eventsClients.delete(res); continue; }
        res.write(chunk);
      } catch (e) { eventsClients.delete(res); }
    }
  };

  /** 给某 RoomState 的 agent 接 events 写入（_pushEvent + compact callbacks），统一指向 serverPushEvent。 */
  function wireAgentEvents(room) {
    const rid = room.roomId;
    const a = room.agent;
    a._pushEvent = (eventName, data) => serverPushEvent(eventName, { ...(data || {}), _agentId: room.agentId, _roomId: rid });
    // compact 等异步事件经 callback 总线 → _pushEvent（与旧单 agent 同源）。避免重复注册。
    if (!a._wiredServerEvents) {
      a._wiredServerEvents = true;
      a.callbacks.push({
        onCompact(e) { a._pushEvent('compact', e); },
        onCompactError(e) { a._pushEvent('compact_error', e); },
      });
    }
  }

  if (defaultRoom) { defaultRoom._chatProcessing = false; wireAgentEvents(defaultRoom); }

  // ===== 房间表 + 懒创建 =====
  // rooms: Map<agentId, Map<roomId, RoomState>>（复合键，承载多 agent 共处；见 docs inprocess-agent-host §三）
  const rooms = new Map();
  // instanceErrors: Map<agentId, 原因> —— 实例化失败留痕，供 gateway 探活区分 server 失败 vs 实例失败（§4.3）。
  //   createRoomState 抛时记录后 re-throw（错误仍以 500 上送 observe，不吞错），成功则清除。
  const instanceErrors = new Map();
  function getRoom(aid, rid) { const m = rooms.get(aid); return m ? m.get(rid) : undefined; }
  function setRoom(room) { if (!rooms.has(room.agentId)) rooms.set(room.agentId, new Map()); rooms.get(room.agentId).set(room.roomId, room); }
  // 解析 agentId：显式 > 私聊 rid 编码(chat-) > 进程默认 agent
  function resolveAgentId(rid, explicit) {
    if (explicit) return explicit;
    if (typeof rid === 'string' && rid.startsWith('chat-')) return rid.slice('chat-'.length);
    return defaultAgentId || null;
  }
  if (defaultRoom) setRoom(defaultRoom);

  async function getOrCreateRoom(roomId, opts = {}) {
    const agentId = resolveAgentId(roomId, opts.agentId);
    const existing = agentId ? getRoom(agentId, roomId) : undefined;
    if (existing) return existing;
    if (!factoryOpts) {
      // 旧版单 agent 无工厂：只认默认房。群里非默认 roomId 不支持。
      throw new Error(`单 agent 模式不支持按需创建房间 ${roomId}`);
    }
    const mode = opts.mode || (roomId.startsWith('chat-') ? 'private' : 'room');
    // dataDir：私聊房用 agentMemory(<id>)（= profiles/agents/<id>/memory，与 snapshot/rewind 的记忆源对齐——
    //   snapshot.js 快照/rewind 读 memory/；旧 per-agent 进程的 defaultRoom 也落此）；群聊房用 agentRoomState(<id>,<rid>)
    //   （= profiles/agents/<id>/rooms/<rid>，同群两个共处成员各自落自己 agentId 目录，不串）。
    const dataDir = mode === 'private' ? agentMemory(agentId) : agentRoomState(agentId, roomId);
    fs.mkdirSync(dataDir, { recursive: true });
    let room;
    try {
      room = await createRoomState({
        configDir: factoryOpts.configDir(agentId),
        agentId,
        roomId,
        mode,
        dataDir,
        port: factoryOpts.port ?? null,
        gatewayUrl: factoryOpts.gatewayUrl || null,
        memberName: opts.memberName || agentId,
        roomBusUrl: opts.roomBusUrl || null,
      });
    } catch (err) {
      // 实例化失败：记录原因供探活区分（§4.3 实例级），**re-throw 不吞错**——/observe 仍返 500 带原因。
      instanceErrors.set(agentId, err.message);
      logger.error(`RoomState[${agentId}/${roomId}] 实例化失败: ${err.message}`);
      throw err;
    }
    instanceErrors.delete(agentId); // 成功：清除之前的失败留痕
    wireAgentEvents(room);
    setRoom(room);
    logger.info(`RoomState[${agentId}/${roomId}] 懒创建完成 (mode=${mode})`);
    return room;
  }

  function roomObserveQueue(room) {
    // room 自带 observeProcessing / pendingObserve（旧默认房已初化）。
    return room;
  }

  /** /observe 处理：按 body.roomId 取房（懒创建），per-room 串行队列（保留逐条还原投递语义）。 */
  async function handleObserve(req, res, isLegacy) {
    const body = req.body || {};
    if (typeof body.content !== 'string' && typeof body.message !== 'string') {
      return res.status(400).json({ error: 'content 必填' });
    }
    // 路由：多房优先 body.roomId；旧单 agent 默认房。
    let room;
    const rid = body.roomId;
    if (rid) {
      try { room = await getOrCreateRoom(rid, { mode: body.mode, agentId: body.agentId, memberName: body.memberName, roomBusUrl: body.roomBusUrl }); }
      catch (err) { logger.error(`/observe 取房失败: ${err.message}`); return res.status(400).json({ error: err.message }); }
    } else if (defaultRoom && defaultRoom.agent.runContext?.mode === 'room') {
      room = defaultRoom;
    } else if (defaultRoom) {
      room = defaultRoom;
    } else {
      return res.status(400).json({ error: 'roomId 必填（多房模式）' });
    }

    const payload = {
      from: body.from,
      content: body.content ?? body.message,
      mentions: Array.isArray(body.mentions) ? body.mentions : [],
      role: body.role || 'chat',
      seq: body.seq ?? null,
      ts: body.ts ?? null,
      roomId: room.roomId,
    };

    // per-room 串行队列
    if (room.observeProcessing) {
      if (!room.pendingObserve) {
        room.pendingObserve = { froms: [], contents: [], tses: [], mentions: new Set(payload.mentions), seq: payload.seq, roomId: room.roomId };
      }
      room.pendingObserve.froms.push(payload.from);
      room.pendingObserve.contents.push(payload.content);
      room.pendingObserve.tses.push(payload.ts);
      for (const m of payload.mentions) room.pendingObserve.mentions.add(m);
      if (payload.seq != null && (room.pendingObserve.seq == null || payload.seq > room.pendingObserve.seq)) {
        room.pendingObserve.seq = payload.seq;
      }
      return res.json({ ack: true, merged: true });
    }
    processObserve(room, payload, body.emit !== false).catch(err => logger.error(`processObserve 失败: ${err.message}`));
    res.json({ ack: true });
  }

  async function processObserve(room, payload, forwardEvents = false) {
    room.observeProcessing = true;
    try {
      // emit：forwardEvents=true → 把推理事件（token/tool_call/done...）经 _pushEvent 带 roomId 转发到 /events，
      //   供 gateway 路由到 room SSE。flag=false（旧 chat observe 群聊空 emit 兼容）。
      const emit = forwardEvents
        ? (event) => room.agent._pushEvent?.(event.event, { ...(event.data || {}), _roomId: room.roomId })
        : () => {};
      await room.agent.receive(payload, { emit });
    } catch (err) {
      logger.error(`/observe 处理失败: ${err.message}`);
    } finally {
      room.observeProcessing = false;
      if (room.pendingObserve) {
        const next = room.pendingObserve; room.pendingObserve = null;
        const mentions = [...next.mentions];
        const seq = next.seq ?? null;
        const tses = next.tses || [];
        (async () => {
          for (let i = 0; i < next.contents.length; i++) {
            const single = {
              from: next.froms[i] ?? next.froms[0] ?? null,
              content: next.contents[i],
              mentions,
              role: 'chat',
              seq,
              ts: tses[i] ?? null,
              roomId: next.roomId,
            };
            try { await room.agent.receive(single, { emit: forwardEvents ? (e)=>room.agent._pushEvent?.(e.event,{...(e.data||{}),_roomId:room.roomId}) : ()=>{} }); }
            catch (err) { logger.error(`/observe 出队处理失败: ${err.message}`); break; }
          }
        })();
      }
    }
  }

  // ===== /observe：私聊 + 群聊统一入口（v3）。多房按 body.roomId 路由。=====
  app.post('/observe', (req, res) => handleObserve(req, res, false));

  // ===== /abort/:roomId + 旧 /abort（默认房）=====
  app.post('/abort/:roomId', (req, res) => {
    const rid = req.params.roomId;
    const aid = resolveAgentId(rid, req.body?.agentId);
    const room = aid ? getRoom(aid, rid) : undefined;
    if (!room) return res.status(404).json({ error: `room 不存在: ${aid}/${rid}` });
    room.agent.abort();
    res.json({ status: 'ok', message: 'abort signal sent' });
  });
  app.post('/abort', (req, res) => {
    if (!defaultRoom) {
      const rid = req.body?.roomId;
      const room = rid && rooms.get(rid);
      if (room) { room.agent.abort(); return res.json({ status: 'ok' }); }
      return res.status(400).json({ error: 'roomId 必填' });
    }
    if (defaultRoom._chatProcessing) {
      defaultRoom.agent.abort();
      res.json({ status: 'ok', message: 'abort signal sent' });
    } else {
      res.json({ status: 'ok', message: 'no active request' });
    }
  });

  // ===== POST /chat — 旧版私聊流式 SSE（默认房）。v3：保留作 shim，gateway 改造后由 /observe+/events 承载。=====
  if (defaultRoom) {
    let isProcessing = false;
    let pendingMessage = null;
    let pendingResponses = [];

    function enqueueRequest(req, res) {
      const seq = req.body.seq ?? null;
      if (isProcessing) {
        if (pendingMessage !== null) pendingMessage += '\n' + req.body.message;
        else pendingMessage = req.body.message;
        pendingResponses.push(res);
      } else {
        pendingResponses = [res];
        processRequest(req.body.message, seq);
      }
    }

    async function processRequest(message, seq = null) {
      isProcessing = true;
      defaultRoom._chatProcessing = true;
      const currentResponses = [...pendingResponses];
      pendingResponses = [];
      pendingMessage = null;
      for (const r of currentResponses) {
        r.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (r.socket) r.socket.setNoDelay(true);
      }
      const emit = async (event) => {
        const data = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
        for (const r of currentResponses) {
          try { if (!r.write(data)) await new Promise(rs => r.once('drain', rs)); } catch (e) { /* 流可能已关闭 */ }
        }
        // 同时经 /events 转发（带 roomId），让 gateway 新路径也能收到，且不丢旧 SSE 直写。
        serverPushEvent(event.event, { ...(event.data || {}), _roomId: defaultRoom.roomId });
      };
      try {
        await defaultRoom.agent.receive(
          seq != null ? { content: message, seq, role: 'chat' } : message,
          { emit }
        );
        for (const r of currentResponses) r.end();
      } catch (err) {
        logger.error(`请求处理失败: ${err.message}`);
        for (const r of currentResponses) {
          if (!r.headersSent) { r.writeHead(500, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ error: err.message })); }
          else { try { r.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`); r.end(); } catch (e) {} }
        }
      } finally {
        isProcessing = false;
        defaultRoom._chatProcessing = false;
        if (pendingMessage !== null && pendingResponses.length > 0) processRequest(pendingMessage);
      }
    }

    app.post('/chat', (req, res) => {
      if (!req.body || typeof req.body.message !== 'string') return res.status(400).json({ error: 'Request body must include "message" field' });
      const modelConfig = config.getModelConfig();
      if (modelConfig.provider !== 'mock') {
        const missing = config.getModelMissingFields();
        if (missing) {
          try { config.load(); } catch (e) {}
          const missingAfterReload = config.getModelMissingFields();
          if (missingAfterReload) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
            if (res.socket) res.socket.setNoDelay(true);
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
  }

  // ===== GET /config =====
  app.get('/config', (req, res) => {
    // 多 agent server 模式无单一 config（各 agent 各自 config 在 agents/<id>/config,gateway 直读）。
    if (!config) return res.status(400).json({ error: '多 agent server 模式无单一 config，请经 gateway 的 /agents/:id/config 取' });
    const allConfig = config.getAll();
    const modelConfig = config.getModelConfig();
    if (modelConfig.provider !== 'mock') {
      const missing = config.getModelMissingFields();
      if (missing) allConfig.modelError = `模型配置不完整，请在「模型配置」选项卡中填写：${missing.join('、')}`;
    }
    res.json(allConfig);
  });

  // ===== GET /status =====
  const statusAgent = defaultRoom?.agent;
  app.get('/status', (req, res) => {
    res.json({
      status: 'ok',
      agentId: config?.get?.('agentId') || null,
      runKey: statusAgent?.runContext?.runKey || config?.get?.('agentId') || null,
      mode: statusAgent?.runContext?.mode || 'private',
      pid: process.pid,
      agentIds: [...rooms.keys()],
      instanceErrors: Object.fromEntries(instanceErrors), // { agentId: 原因 } —— 实例化失败的 agent（探活区分实例级）
      rooms: (function () { const a = []; for (const m of rooms.values()) for (const rid of m.keys()) a.push(rid); return a; })(),
    });
  });

  // ===== POST /shutdown =====
  app.post('/shutdown', (req, res) => {
    res.json({ status: 'ok' });
    logger.info(`Agent ${config.get('agentId')} 收到 /shutdown 请求，即将退出`);
    process.exit(0);
  });

  // ===== POST /clear — 清默认房记忆（旧语义）=====
  // ===== POST /clear/:roomId — 清指定房记忆（v3）=====
  function clearRoom(room) {
    const a = room.agent;
    // 观测式：清 timer（防 /clear 后幽灵回调），clear 后下次消息 onRoomEnter 重新 arm
    const scene = room.plugin || a._scene;
    scene?.dispose?.();
    a.messageManager.clear();
    if (a.skillLister) { a.skillLister.reset(); a.skillLister.inject(); }
    if (typeof a.messageManager._cleanupToolResults === 'function') a.messageManager._cleanupToolResults();
    else if (a.messageManager.dataDir) {
      const trDir = path.join(a.messageManager.dataDir, 'tool-results');
      try { if (fs.existsSync(trDir)) fs.rmSync(trDir, { recursive: true, force: true }); } catch (e) {}
    }
    if (a.runContext?.dataDir) {
      const cursorFile = path.join(a.runContext.dataDir, 'sync_cursor.json');
      try { if (fs.existsSync(cursorFile)) fs.unlinkSync(cursorFile); } catch (e) {}
    }
    if (scene && Array.isArray(scene._buffer)) { scene._buffer.length = 0; scene._bufferHasMention = false; }
    if (typeof a.clearRuntime === 'function') a.clearRuntime();   // DM agent 等清运行时文档（rm runtime + re-seed）
    logger.info(`RoomState[${room.roomId}] 记忆已清空`);
  }
  app.post('/clear/:roomId', (req, res) => {
    const rid = req.params.roomId;
    const aid = resolveAgentId(rid, req.body?.agentId);
    const room = aid ? getRoom(aid, rid) : undefined;
    if (!room) return res.status(404).json({ error: `room 不存在: ${aid}/${rid}` });
    try { clearRoom(room); res.json({ status: 'ok' }); }
    catch (err) { logger.error(`清空记忆失败: ${err.message}`); res.status(500).json({ error: err.message }); }
  });
  if (defaultRoom) {
    app.post('/clear', (req, res) => {
      try { clearRoom(defaultRoom); res.json({ status: 'ok' }); }
      catch (err) { logger.error(`清空记忆失败: ${err.message}`); res.status(500).json({ error: err.message }); }
    });
  }

  // ===== POST /reload/:roomId + 旧 /reload（默认房）— rewind 后重载 context.json + 清 tool-results =====
  function reloadRoom(room) {
    room.agent.messageManager.reloadFromDisk();
    // 观测式：rewind 后历史已变，清 timer 防幽灵回调；重启观测窗口（下次消息或心跳自然续上）
    const scene = room.plugin || room.agent._scene;
    scene?.dispose?.();
    // rewind 三处重建之 tool-results：清本 room 的 tool-results 目录（snapshot 已覆盖回写，清孤儿）。
    const dataDir = room.agent.messageManager.dataDir || room.runContext?.dataDir;
    if (dataDir) {
      const trDir = path.join(dataDir, 'tool-results');
      try { if (fs.existsSync(trDir)) fs.rmSync(trDir, { recursive: true, force: true }); } catch (e) {}
    }
    logger.info(`RoomState[${room.roomId}] 已 reload context + 清 tool-results`);
  }
  app.post('/reload/:roomId', (req, res) => {
    const rid = req.params.roomId;
    const aid = resolveAgentId(rid, req.body?.agentId);
    const room = aid ? getRoom(aid, rid) : undefined;
    if (!room) return res.status(404).json({ error: `room 不存在: ${aid}/${rid}` });
    try { reloadRoom(room); res.json({ status: 'ok' }); }
    catch (err) { logger.error(`reload 失败: ${err.message}`); res.status(500).json({ error: err.message }); }
  });
  if (defaultRoom) {
    app.post('/reload', (req, res) => {
      try { reloadRoom(defaultRoom); res.json({ status: 'ok' }); }
      catch (err) { logger.error(`reload 失败: ${err.message}`); res.status(500).json({ error: err.message }); }
    });
  }

  // ===== GET /rooms — 列本进程承载的 roomId（v3，诊断/路由用）=====
  app.get('/rooms', (req, res) => {
    const list = [];
    for (const m of rooms.values()) for (const room of m.values()) list.push({ agentId: room.agentId, roomId: room.roomId, mode: room.runContext?.mode || 'private' });
    res.json({ rooms: list });
  });

  // ===== GET /events — 通用异步事件通道（私有 + 多房共用，event data 带 _roomId 路由）=====
  app.get('/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();
    eventsClients.add(res);
    res.on('close', () => eventsClients.delete(res));
  });

  return app;
}
