/**
 * /rooms/* 群聊路由
 *
 * 挂载到 createGatewayApp，与 /agents/* 平行。依赖 RoomManager（gateway/room_bus.js）。
 * 见 docs/chat-room-design.md §7（协议）、§8（目录）。
 *
 * 注意：B 阶段 send 转发的 /observe 端点副本尚无（C 阶段加），
 *       故 send 后副本不会真正回应；本路由本身 + 群管理 + 历史 + subscribe 可用。
 */

import fs from 'fs';
import { loadGatewayConfig } from './config.js';

export function registerRoomRoutes(app, roomManager) {
  const logger = console; // 简化，路由层错误直接 res.json

  // 校验群存在
  function checkRoomExists(req, res, next) {
    const rid = req.params.rid;
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

  // GET /rooms/:rid/history — 群历史分页
  app.get('/rooms/:rid/history', checkRoomExists, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const beforeId = req.query.before || null;
    const afterId = req.query.afterId || null;
    const history = roomManager.getHistory(req.params.rid);
    res.json(history.getRecent(limit, beforeId, afterId));
  });

  // DELETE /rooms/:rid/history — 清空群历史
  app.delete('/rooms/:rid/history', checkRoomExists, (req, res) => {
    roomManager.getHistory(req.params.rid).clear();
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

  // GET /rooms/:rid/subscribe — SSE 群聊流
  // 必巡检（非阻塞）：先返回 snapshot，保活在后台跑（设计 §7.4）
  app.get('/rooms/:rid/subscribe', checkRoomExists, (req, res) => {
    const rid = req.params.rid;
    const history = roomManager.getHistory(rid);
    const recent = history.getRecent(50);
    const room = roomManager.getRoom(rid);
    const snapshot = {
      roomId: rid,
      members: room.members,
      messages: recent.messages,
    };
    const bc = roomManager.getBroadcaster(rid);
    bc.add(res, snapshot);
    // 非阻塞保活：不 await，立即返回 snapshot
    roomManager.ensureReplicasAlive(rid).then(() => {
      roomManager.broadcastMemberStatus(rid);
    }).catch(() => { /* ignore */ });
  });

  // POST /rooms/:rid/send — 用户发言（observe 转发）
  app.post('/rooms/:rid/send', checkRoomExists, async (req, res) => {
    try {
      const { message } = req.body || {};
      if (typeof message !== 'string') return res.status(400).json({ error: 'message 必填' });
      const rid = req.params.rid;
      const gcfg = loadGatewayConfig();
      const userName = gcfg.userName || 'user';
      const userUid = gcfg.userUid || 'default_userid';
      // 写群历史（用户发言：speaker=显示名，speakerUid=稳定身份）
      const history = roomManager.getHistory(rid);
      const rec = history.add(userName, message, 'speak', userUid);
      // 广播给订阅者（用户发言回显）
      const bc = roomManager.getBroadcaster(rid);
      bc.broadcast('speak', { speaker: userName, content: message, ts: rec.ts, id: rec.id });
      // observe 转发给所有成员副本（from 用用户名,agent 看到"用户名: 内容"）
      if (typeof roomManager.broadcastObserve === 'function') {
        roomManager.broadcastObserve(rid, message, userName).catch(() => { /* 副本无 /observe 时 B 阶段会 404，忽略 */ });
      }
      res.json({ status: 'ok', id: rec.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /rooms/:rid/member-said — 副本发言回灌（Speak 工具调用此端点）
  // 收 {member, content} → 写群历史(speaker=member) → 广播给订阅者 →
  //   再 broadcastObserve 给所有成员(让其他成员感知此发言,链式触发,允许死循环 §5)。
  app.post('/rooms/:rid/member-said', checkRoomExists, async (req, res) => {
    try {
      const { member, content } = req.body || {};
      if (!member || typeof content !== 'string') {
        return res.status(400).json({ error: 'member 和 content 必填' });
      }
      const rid = req.params.rid;
      const history = roomManager.getHistory(rid);
      const rec = history.add(member, content, 'speak', member);   // 问题3：agent 以 agentId 为稳定身份,member 即 agentId
      const bc = roomManager.getBroadcaster(rid);
      bc.broadcast('speak', { speaker: member, content, ts: rec.ts, id: rec.id });
      // 链式：把这条发言转发给所有成员副本(含发言者自己,RoomAgent 自消息过滤会丢弃)。
      //   允许死循环(A→B→A),靠 LLM 语义收敛,唯一兜底自消息过滤。§5。
      if (typeof roomManager.broadcastObserve === 'function') {
        roomManager.broadcastObserve(rid, content, member).catch(() => { /* ignore */ });
      }
      res.json({ status: 'ok', id: rec.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}