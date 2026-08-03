/**
 * /rooms/* 群聊路由
 *
 * 挂载到 createGatewayApp，与 /agents/* 平行。依赖 RoomManager（gateway/room_bus.js）。
 * 见 docs/chat-room-design.md §7（协议）、§8（目录）。
 *
 * 发言统一走 POST /rooms/:rid/say,header X-Speaker-Id 决定身份(user/agentId)。
 * 副本需以 --mode room 启动以注册 /observe 路由（接收 gateway 推送）。
 */

import fs from 'fs';
import path from 'path';
import { loadGatewayConfig } from './config.js';
import { RoomManager } from './room_bus.js';
import { subscribePrivateRoom, startPrivateTurn, forceFinishPrivateTurn } from './private_room_stream.js';
import { rewindTo, listCheckpoints, snapshotBeforeSend, clearCheckpoints } from './snapshot.js';
import { agentMemory } from '../shared/profiles_paths.js';

export function registerRoomRoutes(app, roomManager, opts = {}) {
  const logger = console; // 简化，路由层错误直接 res.json
  const pm = opts.pm || roomManager.pm || null;
  const privateRoomHistory = opts.privateRoomHistory || null;
  // 私聊房 history 文件路径（v3：rewind 三件套外的第四处重建目标）。
  const privateRoomHistoryPath = (rid) =>
    privateRoomHistory ? path.join(privateRoomHistory.roomsDir, rid, 'history.jsonl') : null;

  /** 私聊房判定：roomId 以 chat- 开头。 */
  const isPrivateRoom = (rid) => typeof rid === 'string' && rid.startsWith('chat-');
  /** 私聊房 agentId = rid.slice('chat-'.length）。 */
  const privateAgentId = (rid) => rid.slice('chat-'.length);

  // 调 agent /observe（私聊/群聊统一入口），fire-and-forget。
  async function postObserve(agentId, payload) {
    const port = pm?.getAgentPort?.(agentId);
    if (!port) throw new Error(`agent ${agentId} 端口未知（未启动？）`);
    return fetch(`http://127.0.0.1:${port}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  }

  // 校验群存在（私聊房 chat-<id> 不在 RoomManager，放行由各自路由处理）
  function checkRoomExists(req, res, next) {
    const rid = req.params.rid;
    if (isPrivateRoom(rid)) return next(); // 私聊房不经 RoomManager
    const room = roomManager.getRoom(rid);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    next();
  }

  // POST /rooms — 建群 { name, members:[agentId] }
  app.post('/rooms', async (req, res) => {
    try {
      const { name, members } = req.body || {};
      if (!Array.isArray(members) || members.length === 0) {
        return res.status(400).json({ error: 'members 必须是非空数组' });
      }
      const room = await roomManager.createRoom(name, members);
      res.json(room);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /rooms — 列所有群
  app.get('/rooms', (req, res) => {
    res.json({ rooms: roomManager.listRooms() });
  });

  // GET /rooms/:rid — 群详情（成员 + 在线状态 + 当前用户名/uid）
  app.get('/rooms/:rid', checkRoomExists, (req, res) => {
    const room = roomManager.getRoom(req.params.rid);
    if (room) {
      const cfg = loadGatewayConfig();
      room.userName = cfg.userName || 'user';
      room.userUid = cfg.userUid || 'default_userid';   // 问题3：稳定用户身份供 roster 渲染
    }
    res.json(room);
  });

  // DELETE /rooms/:rid — 解散群（停所有副本 + 删目录）
  app.delete('/rooms/:rid', checkRoomExists, async (req, res) => {
    try {
      await roomManager.deleteRoom(req.params.rid);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /rooms/:rid/members — 加成员 { agentId }
  app.post('/rooms/:rid/members', checkRoomExists, async (req, res) => {
    try {
      const { agentId } = req.body || {};
      if (!agentId) return res.status(400).json({ error: 'agentId 必填' });
      const room = await roomManager.addMember(req.params.rid, agentId);
      res.json(room);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /rooms/:rid/members/:agentId — 移除成员
  app.delete('/rooms/:rid/members/:agentId', checkRoomExists, async (req, res) => {
    try {
      const room = await roomManager.removeMember(req.params.rid, req.params.agentId);
      res.json(room);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /rooms/:rid/history — 历史分页（私聊 schema 直返；群聊 name 版）
  app.get('/rooms/:rid/history', checkRoomExists, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const beforeId = req.query.before || null;
    const afterId = req.query.afterId || null;
    if (isPrivateRoom(req.params.rid)) {
      const raw = privateRoomHistory ? privateRoomHistory.getRecent(req.params.rid, limit, beforeId, afterId) : { messages: [], hasMore: false };
      return res.json(raw);
    }
    const history = roomManager.getHistory(req.params.rid);
    const raw = history.getRecent(limit, beforeId, afterId);
    const { membersWithNames, user } = roomManager._rosterForRewrite(req.params.rid);
    // 前端 history 不需要 mentions 字段
    const messages = raw.messages.map(m => roomManager._renderMessageForSend(m, membersWithNames, user, false));
    res.json({ messages, hasMore: raw.hasMore });
  });

  // GET /rooms/:rid/sync-history/:agentId — 副本消息同步（seq 游标分页）
  // seed=true 仅返回 latestSeq（首次启动种子）；afterSeq=<n> 返回 seq>n 的消息。
  // 返回 name 版（agent _parse 还会再 uid→name 拼前缀，content 已是 name 版）+ mentions。
  app.get('/rooms/:rid/sync-history/:agentId', checkRoomExists, (req, res) => {
    const rid = req.params.rid;
    const agentId = req.params.agentId;
    // 私聊房 sync-history（无 :agentId 语义，私聊单向 user 历史）
    if (isPrivateRoom(rid)) {
      const seed = req.query.seed === 'true';
      const afterSeq = parseInt(req.query.afterSeq, 10) || 0;
      if (!privateRoomHistory) return res.json({ messages: [], latestSeq: 0 });
      if (seed) {
        const last = privateRoomHistory._loadLastSeq(rid);
        return res.json({ messages: [], latestSeq: last });
      }
      const result = privateRoomHistory.getAfterSeq(rid, afterSeq);
      return res.json({ messages: result.messages, latestSeq: result.latestSeq });
    }
    const history = roomManager.getHistory(rid);
    const seed = req.query.seed === 'true';
    const afterSeq = parseInt(req.query.afterSeq, 10) || 0;

    // 首次种子：只返回 latestSeq，不返回消息
    if (seed) {
      const all = history._readAll();
      const last = all.length > 0 ? all[all.length - 1] : null;
      return res.json({ messages: [], latestSeq: last?.seq ?? 0 });
    }

    const result = history.getAfterSeq(afterSeq);
    const { membersWithNames, user } = roomManager._rosterForRewrite(req.params.rid);
    // sync-history 带 mentions（agent 填充空洞后判被@用）
    const messages = result.messages.map(m => roomManager._renderMessageForSend(m, membersWithNames, user, true));

    res.json({ messages, latestSeq: result.latestSeq });
  });

  // DELETE /rooms/:rid/history — 清空历史（私聊走 privateRoomHistory，群聊走 RoomHistory）
  app.delete('/rooms/:rid/history', checkRoomExists, (req, res) => {
    const rid = req.params.rid;
    if (isPrivateRoom(rid)) {
      if (privateRoomHistory) privateRoomHistory.clear(rid);
      // 清空历史连带清 rewind 栈：checkpoints 是对私聊房历史/记忆的快照，历史清了栈也整体作废。
      try { clearCheckpoints(privateAgentId(rid)); } catch (e) { /* 清栈失败不阻塞清历史 */ }
    } else {
      roomManager.getHistory(rid).clear();
    }
    res.json({ status: 'ok' });
  });

  // POST /rooms/:rid/clear-memory — 清空各成员记忆（调副本 /clear）
  app.post('/rooms/:rid/clear-memory', checkRoomExists, async (req, res) => {
    try {
      await roomManager.clearMemberMemory(req.params.rid);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /rooms/:rid/clear-all — 清空聊天记录 + 成员记忆（合一原子操作）
  app.post('/rooms/:rid/clear-all', checkRoomExists, async (req, res) => {
    try {
      roomManager.getHistory(req.params.rid).clear();
      await roomManager.clearMemberMemory(req.params.rid);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /rooms/:rid/subscribe — SSE 订阅（私聊 + 群聊统一）
  app.get('/rooms/:rid/subscribe', checkRoomExists, (req, res) => {
    const rid = req.params.rid;
    if (isPrivateRoom(rid)) {
      // 私聊房：常驻 SSE，token 经 agent /events → _onAgentEvent → private_room_stream 转发。
      if (!privateRoomHistory) return res.status(500).json({ error: '私聊房历史未配置' });
      subscribePrivateRoom(rid, res, privateRoomHistory);
      return;
    }
    // 群聊（必巡检非阻塞）：先返回 snapshot，保活在后台跑
    const history = roomManager.getHistory(rid);
    const recent = history.getRecent(50);
    const room = roomManager.getRoom(rid);
    const { membersWithNames, user } = roomManager._rosterForRewrite(rid);
    // snapshot 消息渲染成 name 版（与 SSE speak 事件一致），前端可直接显示
    const messages = recent.messages.map(m => roomManager._renderMessageForSend(m, membersWithNames, user, false));
    const snapshot = {
      roomId: rid,
      members: room.members,
      messages,
    };
    const bc = roomManager.getBroadcaster(rid);
    bc.add(res, snapshot);
    // 非阻塞保活：不 await，立即返回 snapshot
    roomManager.ensureReplicasAlive(rid).then(() => {
      roomManager.broadcastMemberStatus(rid);
    }).catch(() => { /* ignore */ });
  });

  // POST /rooms/:rid/say — 统一发言入口（用户 + agent）
  //   header X-Speaker-Id 决定身份:
  //     缺失 / 'user' → 用户发言,speakerUid = gateway.json userUid
  //     成员 agentId   → agent 发言,speakerUid = agentId
  //     其它           → 400 未知身份
  //   body: { content }
  //   落盘: speaker/speakerUid = uid,content @=uid
  //   发送: SSE/observe 给消费方的 content @=name
  app.post('/rooms/:rid/say', checkRoomExists, async (req, res) => {
    try {
      const { content } = req.body || {};
      if (typeof content !== 'string') return res.status(400).json({ error: 'content 必填' });
      // 私聊房：写 history + fire-and-forget /observe；token 经 /events 转发到 subscribe。
      if (isPrivateRoom(req.params.rid)) {
        const agentId = privateAgentId(req.params.rid);
        if (!pm?.getAgentStatus?.(agentId) || pm.getAgentStatus(agentId) !== 'running') {
          return res.status(503).json({ error: 'Agent 未运行' });
        }
        // rewind 快照：写 user 进 jsonl 前打一个"说话前"状态快照包（含 v3 私聊房 history）。
        try { snapshotBeforeSend(agentId, content, privateRoomHistoryPath(req.params.rid)); } catch (e) { /* 快照失败不阻塞 */ }
        let rec = null;
        if (privateRoomHistory) {
          rec = privateRoomHistory.addMessage(req.params.rid, 'user', content);
        }
        startPrivateTurn(req.params.rid, rec || { content });
        // seq 取 history 的；fire-and-forget
        postObserve(agentId, { roomId: req.params.rid, content, role: 'chat', seq: rec?.seq ?? null })
          .catch(err => logger.error && console.error?.(`/observe 失败 (${req.params.rid}): ${err.message}`));
        return res.json({ status: 'ok', id: rec?.id || null });
      }
      const speakerId = (req.headers['x-speaker-id'] || 'user').trim();
      let speakerUid;
      if (speakerId === 'user') {
        const gcfg = loadGatewayConfig();
        speakerUid = gcfg.userUid || 'default_userid';
      } else {
        const room = roomManager.getRoom(req.params.rid);
        const isMember = room?.members?.some(m => m.agentId === speakerId);
        if (!isMember) return res.status(400).json({ error: `未知身份: ${speakerId}` });
        speakerUid = speakerId;
      }
      const rec = await roomManager.processRoomMessage(req.params.rid, speakerUid, content);
      res.json({ status: 'ok', id: rec.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /rooms/:rid/notice — agent 直推的居中瞬态通知（LLM 重试/最终失败等），不入 history。
  //   仅群聊用（私聊 notice 经 agent /events→_onAgentEvent chat- 转发）。SSE-only 广播，不发 /observe。
  //   body: { kind, agentId, memberName?, attempt?, maxRetries?, error?, final?, roomId? }
  app.post('/rooms/:rid/notice', checkRoomExists, (req, res) => {
    try {
      const data = { ...(req.body || {}) };
      delete data._roomId;
      const bc = roomManager.getBroadcaster(req.params.rid);
      bc.broadcast('notice', data);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== 房间成员管理路由（B 阶段：控制副本生命周期） =====

  // POST /rooms/:rid/start-all — 启动房间所有成员副本
  app.post('/rooms/:rid/start-all', checkRoomExists, async (req, res) => {
    try {
      const results = await roomManager.startRoomAgents(req.params.rid);
      const running = results.filter(r => r && r.status === 'running');
      res.json({ status: 'ok', started: running.length, total: results.length, details: results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /rooms/:rid/stop-all — 停止房间所有成员副本
  app.post('/rooms/:rid/stop-all', checkRoomExists, async (req, res) => {
    try {
      await roomManager.stopRoomAgents(req.params.rid);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== v3 私聊房控制（按 roomId 路由到 agent 进程）=====
  // POST /rooms/:rid/abort — 中断私聊房推理
  app.post('/rooms/:rid/abort', checkRoomExists, async (req, res) => {
    const rid = req.params.rid;
    if (!isPrivateRoom(rid)) return res.status(400).json({ error: '仅私聊房支持此端点' });
    const agentId = privateAgentId(rid);
    const port = pm?.getAgentPort?.(agentId);
    let agentOk = false;
    if (port) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/abort/${rid}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
        await r.json().catch(() => ({}));
        agentOk = true;
      } catch (err) {
        // agent 调用失败不阻塞:下面 gateway 兜底仍会清状态(孤儿 streaming 场景 agent 可能已无回合)
      }
    }
    // gateway 兜底:若 streaming 仍 true(agent 未回 aborted / 孤儿状态),强制复位 + 广播 aborted。
    //   防 streaming 卡 true → 前端一直"生成中"、abort 无效。
    const forced = forceFinishPrivateTurn(rid);
    res.json({ status: 'ok', agentOk, forced });
  });

  // GET /rooms/:rid/checkpoints — 私聊房可回退的快照包
  app.get('/rooms/:rid/checkpoints', checkRoomExists, (req, res) => {
    const rid = req.params.rid;
    if (!isPrivateRoom(rid)) return res.status(400).json({ error: '仅私聊房支持此端点' });
    const agentId = privateAgentId(rid);
    try {
      const checkpoints = listCheckpoints(agentId);
      res.json({ checkpoints });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /rooms/:rid/rewind — 私聊房三处重建（history.jsonl + context.json + tool-results）+ /reload/:roomId
  app.post('/rooms/:rid/rewind', checkRoomExists, (req, res) => {
    const rid = req.params.rid;
    if (!isPrivateRoom(rid)) return res.status(400).json({ error: '仅私聊房支持此端点' });
    const agentId = privateAgentId(rid);
    const checkpointId = req.body?.checkpointId ?? null;
    const result = rewindTo(agentId, checkpointId, privateRoomHistoryPath(rid));
    if (!result.ok) return res.status(400).json({ error: result.error });
    const port = pm?.getAgentPort?.(agentId);
    if (port) {
      fetch(`http://127.0.0.1:${port}/reload/${rid}`, { method: 'POST' })
        .then(r => r.json().catch(() => ({})))
        .then(() => {})
        .catch(err => { /* reload 失败不语义阻塞，下条消息自然重载 */ });
    }
    const remaining = listCheckpoints(agentId);
    res.json({ status: 'ok', restoredPrompt: result.restoredPrompt, checkpoints: remaining });
  });

  // DELETE /rooms/:rid/memory — 清空私聊房记忆（context.json + 内存 + tool-results）+ 私聊房 history
  //   v3 经 agent /clear/:roomId 清内存（engine 已按房清 buffer/cursor/tool-results），未运行则清盘。
  app.delete('/rooms/:rid/memory', checkRoomExists, async (req, res) => {
    const rid = req.params.rid;
    if (!isPrivateRoom(rid)) return res.status(400).json({ error: '仅私聊房支持此端点' });
    const agentId = privateAgentId(rid);
    const status = pm?.getAgentStatus?.(agentId);
    if (status === 'running') {
      const port = pm?.getAgentPort?.(agentId);
      try { await fetch(`http://127.0.0.1:${port}/clear/${rid}`, { method: 'POST', signal: AbortSignal.timeout(5000) }); }
      catch (err) { /* 清内存失败不阻塞，盘上兜底 */ }
    } else {
      const dataDir = agentMemory(agentId);
      try {
        const ctx = path.join(dataDir, 'context.json');
        if (fs.existsSync(ctx)) fs.writeFileSync(ctx, '[]', 'utf-8');
      } catch (e) { /* ignore */ }
    }
    // 同时清私聊房 history
    if (privateRoomHistory) privateRoomHistory.clear(rid);
    res.json({ status: 'ok' });
  });
}