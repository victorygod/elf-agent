/**
 * /rooms/* 群聊路由
 *
 * 挂载到 createGatewayApp，与 /agents/* 平行。依赖 RoomManager（gateway/room_bus.js）。
 * 见 docs/chat-room-design.md §7（协议）、§8（目录）。
 *
 * 发言统一走 POST /rooms/:rid/say：
 *   - 用户发言：要求 req.user（JWT），speakerUid = req.user.uid
 *   - agent 发言：要求 req.service（内部服务 token）+ X-Speaker-Id = 成员 agentId
 *
 * 多用户改造（docs/multi-user-auth-design.md）：
 *   - 私聊 roomId = chat-<uid>-<agentId>（uid 不含 '-'，按首个 '-' 分割）
 *   - 私聊路由仅房主可访问（req.user.uid 与 roomId 中 uid 匹配）；agent 回调（sync-history）走 req.service
 *   - 群聊所有注册用户可见可说；建群/解散/成员管理/清记忆仅 admin
 */

import fs from 'fs';
import path from 'path';
import { loadGatewayConfig } from './config.js';
import { RoomManager } from './room_bus.js';
import { subscribePrivateRoom, startPrivateTurn, forceFinishPrivateTurn } from './private_room_stream.js';
import { rewindTo, listCheckpoints, snapshotBeforeSend, clearCheckpoints } from './snapshot.js';
import { agentRoomState } from '../shared/profiles_paths.js';
import { isRoomEnabledForUser } from './auth.js';

/** 私聊房判定：roomId 以 chat- 开头。 */
const isPrivateRoom = (rid) => typeof rid === 'string' && rid.startsWith('chat-');

/**
 * 解析私聊 roomId → { uid, agentId }；非法返回 null。
 * 格式 chat-<uid>-<agentId>：uid 生成规则保证不含 '-'，按首个 '-' 分割（agentId 可含 '-'）。
 */
export function parsePrivateRoom(rid) {
  if (!isPrivateRoom(rid)) return null;
  const rest = rid.slice('chat-'.length);
  const idx = rest.indexOf('-');
  if (idx <= 0 || idx === rest.length - 1) return null;
  return { uid: rest.slice(0, idx), agentId: rest.slice(idx + 1) };
}

/** 私聊房 agentId（非法房名返回 null）。 */
const privateAgentId = (rid) => parsePrivateRoom(rid)?.agentId ?? null;

export function registerRoomRoutes(app, roomManager, opts = {}) {
  const logger = console; // 简化，路由层错误直接 res.json
  const pm = opts.pm || roomManager.pm || null;
  const privateRoomHistory = opts.privateRoomHistory || null;
  const requireAdmin = opts.requireAdmin || ((req, res, next) => next());
  // 私聊房 history 文件路径（v3：rewind 三件套外的第四处重建目标）。
  const privateRoomHistoryPath = (rid) =>
    privateRoomHistory ? path.join(privateRoomHistory.roomsDir, rid, 'history.jsonl') : null;

  // 调 agent /observe（私聊/群聊统一入口），fire-and-forget。
  // 私聊实例用户自治后，agent 全局开关不再作为 gate——只要共享 server 进程在跑，
  //   任何用户启用了自己的私聊 room 就能收消息。取 server 端口（对所有 agent 生效）。
  async function postObserve(agentId, payload) {
    const port = pm?.getServerPort?.();
    if (!port) throw new Error(`agent-server 未运行`);
    // ② observe body 显式带 agentId：host（多 agent 共处一 server）按 (agentId,roomId) 路由所需。
    return fetch(`http://127.0.0.1:${port}/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, agentId }),
      signal: AbortSignal.timeout(30_000),
    });
  }

  // 校验群存在（私聊房 chat-<uid>-<id> 不在 RoomManager，放行由各自路由处理）
  function checkRoomExists(req, res, next) {
    const rid = req.params.rid;
    if (isPrivateRoom(rid)) return next(); // 私聊房不经 RoomManager
    const room = roomManager.getRoom(rid);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    next();
  }

  /**
   * 私聊房访问门：房主（req.user.uid 与 roomId 中 uid 一致）或内部服务（agent 回调）。
   * 通过则把 { uid, agentId } 挂到 req.privateRoom。
   */
  function checkPrivateAccess(req, res, next) {
    const p = parsePrivateRoom(req.params.rid);
    if (!p) return res.status(400).json({ error: '非法私聊房 ID' });
    if (req.service || req.user?.uid === p.uid) {
      req.privateRoom = p;
      return next();
    }
    return res.status(403).json({ error: '无权访问该私聊' });
  }

  /** 仅房主（用户本人），服务身份不够（abort/rewind/memory 等用户动作） */
  function checkPrivateOwner(req, res, next) {
    const p = parsePrivateRoom(req.params.rid);
    if (!p) return res.status(400).json({ error: '非法私聊房 ID' });
    if (req.user?.uid === p.uid) {
      req.privateRoom = p;
      return next();
    }
    return res.status(403).json({ error: '无权访问该私聊' });
  }

  // POST /rooms — 建群 { name, members:[agentId] }（admin）
  app.post('/rooms', requireAdmin, async (req, res) => {
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

  // GET /rooms — 列所有群（所有注册用户可见）
  app.get('/rooms', (req, res) => {
    res.json({ rooms: roomManager.listRooms() });
  });

  // GET /rooms/:rid — 群详情（成员 + 在线状态 + 当前请求用户的 name/uid + 全量用户目录）
  app.get('/rooms/:rid', checkRoomExists, (req, res) => {
    const room = roomManager.getRoom(req.params.rid);
    if (room) {
      room.userName = req.user?.userName || req.user?.username || 'user';
      room.userUid = req.user?.uid || null;
      // 多用户：agent 拼群成员 roster 需要全部注册用户（谁都可能发言），服务/用户调用都返回
      room.users = roomManager._userDirectory?.() || [];
    }
    res.json(room);
  });

  // DELETE /rooms/:rid — 解散群（停所有副本 + 删目录）（admin）
  app.delete('/rooms/:rid', requireAdmin, checkRoomExists, async (req, res) => {
    try {
      await roomManager.deleteRoom(req.params.rid);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /rooms/:rid/members — 加成员 { agentId }（admin）
  app.post('/rooms/:rid/members', requireAdmin, checkRoomExists, async (req, res) => {
    try {
      const { agentId } = req.body || {};
      if (!agentId) return res.status(400).json({ error: 'agentId 必填' });
      const room = await roomManager.addMember(req.params.rid, agentId);
      res.json(room);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /rooms/:rid/members/:agentId — 移除成员（admin）
  app.delete('/rooms/:rid/members/:agentId', requireAdmin, checkRoomExists, async (req, res) => {
    try {
      const room = await roomManager.removeMember(req.params.rid, req.params.agentId);
      res.json(room);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /rooms/:rid/history — 历史分页（私聊 schema 直返，仅房主；群聊 name 版，所有用户）
  app.get('/rooms/:rid/history', checkRoomExists, (req, res, next) => {
    if (isPrivateRoom(req.params.rid)) return checkPrivateAccess(req, res, next);
    next();
  }, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const beforeId = req.query.before || null;
    const afterId = req.query.afterId || null;
    if (isPrivateRoom(req.params.rid)) {
      const raw = privateRoomHistory ? privateRoomHistory.getRecent(req.params.rid, limit, beforeId, afterId) : { messages: [], hasMore: false };
      return res.json(raw);
    }
    const history = roomManager.getHistory(req.params.rid);
    const raw = history.getRecent(limit, beforeId, afterId);
    const { membersWithNames, users } = roomManager._rosterForRewrite(req.params.rid);
    // 前端 history 不需要 mentions 字段
    const messages = raw.messages.map(m => roomManager._renderMessageForSend(m, membersWithNames, users, false));
    res.json({ messages, hasMore: raw.hasMore });
  });

  // GET /rooms/:rid/sync-history/:agentId — 副本消息同步（seq 游标分页）
  // seed=true 仅返回 latestSeq（首次启动种子）；afterSeq=<n> 返回 seq>n 的消息。
  // 返回 name 版（agent _parse 还会再 uid→name 拼前缀，content 已是 name 版）+ mentions。
  // 私聊房：agent 经 req.service 同步自己的房历史（房主用户也可）。
  app.get('/rooms/:rid/sync-history/:agentId', checkRoomExists, (req, res, next) => {
    if (isPrivateRoom(req.params.rid)) return checkPrivateAccess(req, res, next);
    next();
  }, (req, res) => {
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
    const { membersWithNames, users } = roomManager._rosterForRewrite(req.params.rid);
    // sync-history 带 mentions（agent 填充空洞后判被@用）
    const messages = result.messages.map(m => roomManager._renderMessageForSend(m, membersWithNames, users, true));

    res.json({ messages, latestSeq: result.latestSeq });
  });

  // DELETE /rooms/:rid/history — 清空历史（私聊仅房主；群聊 admin）
  app.delete('/rooms/:rid/history', checkRoomExists, (req, res, next) => {
    if (isPrivateRoom(req.params.rid)) return checkPrivateOwner(req, res, next);
    return requireAdmin(req, res, next);
  }, (req, res) => {
    const rid = req.params.rid;
    if (isPrivateRoom(rid)) {
      if (privateRoomHistory) privateRoomHistory.clear(rid);
      // 清空历史连带清 rewind 栈：checkpoints 是对私聊房历史/记忆的快照，历史清了栈也整体作废。
      const p = req.privateRoom;
      try { clearCheckpoints(p.agentId, rid); } catch (e) { logger.warn(`清 rewind 栈失败 (${rid}): ${e.message}`); }
    } else {
      roomManager.getHistory(rid).clear();
    }
    res.json({ status: 'ok' });
  });

  // POST /rooms/:rid/clear-memory — 清空各成员记忆（调副本 /clear）（admin）
  app.post('/rooms/:rid/clear-memory', requireAdmin, checkRoomExists, async (req, res) => {
    try {
      await roomManager.clearMemberMemory(req.params.rid);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /rooms/:rid/clear-all — 清空聊天记录 + 成员记忆（合一原子操作）（admin）
  app.post('/rooms/:rid/clear-all', requireAdmin, checkRoomExists, async (req, res) => {
    try {
      roomManager.getHistory(req.params.rid).clear();
      await roomManager.clearMemberMemory(req.params.rid);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /rooms/:rid/subscribe — SSE 订阅（私聊仅房主；群聊所有用户）
  app.get('/rooms/:rid/subscribe', checkRoomExists, (req, res, next) => {
    if (isPrivateRoom(req.params.rid)) return checkPrivateAccess(req, res, next);
    next();
  }, (req, res) => {
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
    const { membersWithNames, users } = roomManager._rosterForRewrite(rid);
    // snapshot 消息渲染成 name 版（与 SSE speak 事件一致），前端可直接显示
    const messages = recent.messages.map(m => roomManager._renderMessageForSend(m, membersWithNames, users, false));
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
  //   用户发言：req.user（JWT）→ speakerUid = req.user.uid
  //   agent 发言：req.service（内部 token）+ X-Speaker-Id = 成员 agentId → speakerUid = agentId
  //   落盘: speaker/speakerUid = uid,content @=uid
  //   发送: SSE/observe 给消费方的 content @=name
  app.post('/rooms/:rid/say', checkRoomExists, (req, res, next) => {
    if (isPrivateRoom(req.params.rid)) return checkPrivateOwner(req, res, next);
    next();
  }, async (req, res) => {
    try {
      const { content } = req.body || {};
      if (typeof content !== 'string') return res.status(400).json({ error: 'content 必填' });
      // 私聊房：写 history + fire-and-forget /observe；token 经 /events 转发到 subscribe。
      if (isPrivateRoom(req.params.rid)) {
        const { agentId, uid } = req.privateRoom;
        // 私聊实例用户自治：只要求共享 agent-server 进程在跑 + 该用户未停用自己的私聊 room，
        //   不再依赖 admin 的全局 agent 开关（用户启停私聊与管理员无关）。
        if (!pm?.getServerPort?.()) {
          return res.status(503).json({ error: 'Agent 服务未运行' });
        }
        if (!isRoomEnabledForUser(uid, agentId)) {
          return res.status(503).json({ error: '你已停用与该 Agent 的私聊' });
        }
        // rewind 快照：写 user 进 jsonl 前打一个"说话前"状态快照包（含 v3 私聊房 history）。
        try { snapshotBeforeSend(agentId, req.params.rid, content, privateRoomHistoryPath(req.params.rid)); }
        catch (e) { logger.warn(`打快照失败 (${req.params.rid})，本轮无可回退项: ${e.message}`); }
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
      // 群聊：身份判定（X-Speaker-Id 声明意图，凭证证明授权）
      const speakerId = (req.headers['x-speaker-id'] || '').trim();
      let speakerUid;
      if (!speakerId || speakerId === 'user') {
        // 用户发言：身份以 JWT 为准
        if (!req.user) return res.status(401).json({ error: '未登录' });
        speakerUid = req.user.uid;
      } else {
        // agent 发言（Speak 工具回调）：仅内部服务，且必须是本群成员
        if (!req.service) return res.status(403).json({ error: 'agent 发言仅内部服务可用' });
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
  //   仅内部服务（agent-server 回调）可调。
  app.post('/rooms/:rid/notice', checkRoomExists, (req, res) => {
    if (!req.service) return res.status(403).json({ error: '仅内部服务可用' });
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

  // ===== 房间成员管理路由（admin：控制副本生命周期） =====

  // POST /rooms/:rid/start-all — 启动房间所有成员副本
  app.post('/rooms/:rid/start-all', requireAdmin, checkRoomExists, async (req, res) => {
    try {
      const results = await roomManager.startRoomAgents(req.params.rid);
      const running = results.filter(r => r && r.status === 'running');
      res.json({ status: 'ok', started: running.length, total: results.length, details: results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /rooms/:rid/stop-all — 停止房间所有成员副本
  app.post('/rooms/:rid/stop-all', requireAdmin, checkRoomExists, async (req, res) => {
    try {
      await roomManager.stopRoomAgents(req.params.rid);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== v3 私聊房控制（按 roomId 路由到 agent 进程；仅房主）=====
  // POST /rooms/:rid/abort — 中断私聊房推理
  app.post('/rooms/:rid/abort', checkRoomExists, checkPrivateOwner, async (req, res) => {
    const rid = req.params.rid;
    const { agentId } = req.privateRoom;
    const port = pm?.getAgentPort?.(agentId);
    let agentOk = false;
    if (port) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/abort/${encodeURIComponent(rid)}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
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
  app.get('/rooms/:rid/checkpoints', checkRoomExists, checkPrivateOwner, (req, res) => {
    const rid = req.params.rid;
    const { agentId } = req.privateRoom;
    try {
      const checkpoints = listCheckpoints(agentId, rid);
      res.json({ checkpoints });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /rooms/:rid/rewind — 私聊房三处重建（history.jsonl + context.json + tool-results）+ /reload/:roomId
  app.post('/rooms/:rid/rewind', checkRoomExists, checkPrivateOwner, (req, res) => {
    const rid = req.params.rid;
    const { agentId } = req.privateRoom;
    const checkpointId = req.body?.checkpointId ?? null;
    const result = rewindTo(agentId, rid, checkpointId, privateRoomHistoryPath(rid));
    if (!result.ok) return res.status(400).json({ error: result.error });
    const port = pm?.getAgentPort?.(agentId);
    if (port) {
      fetch(`http://127.0.0.1:${port}/reload/${encodeURIComponent(rid)}`, { method: 'POST' })
        .then(r => r.json().catch(() => ({})))
        .then(() => {})
        .catch(err => { logger.warn(`rewind 后 reload 失败 (${rid}): ${err.message}（下条消息自然重载）`); });
    }
    const remaining = listCheckpoints(agentId, rid);
    res.json({ status: 'ok', restoredPrompt: result.restoredPrompt, checkpoints: remaining });
  });

  // DELETE /rooms/:rid/memory — 清空私聊房记忆（context.json + 内存 + tool-results）+ 私聊房 history
  //   v3 经 agent /clear/:roomId 清内存（engine 已按房清 buffer/cursor/tool-results），未运行则清盘。
  app.delete('/rooms/:rid/memory', checkRoomExists, checkPrivateOwner, async (req, res) => {
    const rid = req.params.rid;
    const { agentId } = req.privateRoom;
    const status = pm?.getAgentStatus?.(agentId);
    if (status === 'running') {
      const port = pm?.getAgentPort?.(agentId);
      try { await fetch(`http://127.0.0.1:${port}/clear/${encodeURIComponent(rid)}`, { method: 'POST', signal: AbortSignal.timeout(5000) }); }
      catch (err) { logger.warn(`清内存失败 (${rid})，走盘上兜底: ${err.message}`); }
    } else {
      // 私聊房记忆目录 = profiles/agents/<id>/rooms/chat-<uid>-<id>/
      const dataDir = agentRoomState(agentId, rid);
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        const ctx = path.join(dataDir, 'context.json');
        if (fs.existsSync(ctx)) fs.writeFileSync(ctx, '[]', 'utf-8');
      } catch (e) { logger.warn(`清盘上 context.json 失败 (${rid}): ${e.message}`); }
    }
    // 同时清私聊房 history
    if (privateRoomHistory) privateRoomHistory.clear(rid);
    res.json({ status: 'ok' });
  });
}
