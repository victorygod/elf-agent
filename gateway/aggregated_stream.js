/**
 * AggregatedBroadcaster —— 把所有私聊房 + 群聊房聚合到一条 SSE。
 *
 * 解决:前端常驻 fetch-SSE 从「每 running agent 一条」收敛为「全程 1 条」,
 *      解除浏览器 HTTP/1.1 单 origin 6 连接上限(7+ 条 SSE 占满池子 → 刷新转圈 / 上翻 Failed to fetch)。
 *
 * 机制:
 *  - attach(res):writeHead 一次后逐房发 snapshot(私聊 buildPrivateSnapshot / 群聊 buildRoomSnapshotData,
 *    均注入 {roomId, roomType}),并把 res 注册到各房 broadcaster(_sseSubs / RoomBroadcaster._sseSubscribers)。
 *  - 此后各房 broadcaster 的 _broadcast / broadcast / notifyAll 已注入 {roomId, roomType},
 *    事件直达本 res,前端聚合 dispatcher 按 roomId/roomType 路由到对应 store。
 *  - refresh():定时(1.5s)对比 pm.listAgents(running) + roomManager.listRooms 与已订阅房集合,
 *    差异部分加房(补发 snapshot + 注册)/移房(注销)。新 agent 启动 / 新建群聊在首个事件产生前即被纳入,无丢失。
 *  - res.close:从所有 broadcaster 注销该 res(反向索引 res→{roomId,handle});各 broadcaster 的 writable 检查兜底。
 *
 * 见 docs/sse-aggregation-design.md §4.2/§4.3/§6。
 */

import { createLogger } from '../shared/logger.js';
import {
  registerPrivateSubscriber,
  removePrivateSubscriber,
  buildPrivateSnapshot,
} from './private_room_stream.js';
import { isRoomEnabledForUser } from './auth.js';

const logger = createLogger('aggregated-stream', 'gateway.log');

const REFRESH_INTERVAL = 1500;

export class AggregatedBroadcaster {
  /**
   * @param {{ pm: object, roomManager: object, privateRoomHistory: object }} deps
   */
  constructor({ pm, roomManager, privateRoomHistory }) {
    this._pm = pm;
    this._roomManager = roomManager;
    this._history = privateRoomHistory;
    /** res → Map<roomId, { type:'chat'|'room', handle?: sub句柄 }> 反向索引 */
    this._resSubs = new Map();
    /** res → user（多用户：私聊房按该用户过滤） */
    this._resUsers = new Map();
    this._timer = setInterval(() => {
      try { this.refresh(); } catch (e) { logger.error(`refresh 失败: ${e.message}`); }
    }, REFRESH_INTERVAL);
  }

  /** 前端 POST /subscribe 调:建立一条聚合 SSE。user = 当前登录用户（auth 中间件注入）。 */
  attach(res, user) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    if (res.socket) res.socket.setNoDelay(true);

    this._resSubs.set(res, new Map());
    this._resUsers.set(res, user || null);
    res.on('close', () => this.detach(res));
    this.refresh(); // 立即全量发当前所有房 snapshot
  }

  /** res 关闭/出错时:从所有 broadcaster 注销。 */
  detach(res) {
    const subs = this._resSubs.get(res);
    if (!subs) return;
    for (const [roomId, info] of [...subs]) this._removeRoom(res, roomId, info);
    this._resSubs.delete(res);
    this._resUsers.delete(res);
  }

  /** 重算当前应订阅的房集合,同步差异到所有聚合 res。 */
  refresh() {
    for (const res of [...this._resSubs.keys()]) {
      const subs = this._resSubs.get(res);
      if (!subs) continue;
      const user = this._resUsers.get(res) || null;
      const current = this._currentRooms(user);
      const currentIds = new Set(current.map((r) => r.roomId));
      // 新增房
      for (const r of current) {
        if (!subs.has(r.roomId)) this._addRoom(res, r);
      }
      // 移除房(已不在 current:agent 停了 / 群聊删了 / 用户停用了私聊)
      for (const [rid, info] of [...subs]) {
        if (!currentIds.has(rid)) this._removeRoom(res, rid, info);
      }
    }
  }

  /**
   * 当前应订阅的房:该用户已启用的 running agent 私聊房 chat-<uid>-<id> + 所有群聊房。
   * 无用户（不应发生，中间件已挡）→ 只给群聊。
   */
  _currentRooms(user) {
    const rooms = [];
    try {
      const agents = this._pm.listAgents?.() || [];
      for (const a of agents) {
        if (a.status !== 'running') continue;
        if (!user) continue;
        if (!isRoomEnabledForUser(user.uid, a.agentId)) continue;   // 用户停用了自己的私聊 → 不订阅
        rooms.push({ roomId: `chat-${user.uid}-${a.agentId}`, type: 'chat' });
      }
    } catch (e) { /* ignore */ }
    try {
      const groupRooms = this._roomManager.listRooms?.() || [];
      for (const r of groupRooms) rooms.push({ roomId: r.roomId, type: 'room' });
    } catch (e) { /* ignore */ }
    return rooms;
  }

  /** 把某房加进某聚合 res:发 snapshot + 注册到该房 broadcaster。 */
  _addRoom(res, { roomId, type }) {
    const subs = this._resSubs.get(res);
    if (!subs || subs.has(roomId)) return;
    if (!res.writable) return;
    // 1. 补发该房 snapshot(注入 roomId/roomType)
    try {
      const snap =
        type === 'chat'
          ? buildPrivateSnapshot(roomId, this._history)
          : this._roomManager.buildRoomSnapshotData(roomId);
      if (snap) res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
    } catch (e) {
      logger.warn(`snapshot 失败 (${roomId}): ${e.message}`);
    }
    // 2. 注册 res 到该房 broadcaster,后续增量事件直达
    let info;
    if (type === 'chat') {
      registerPrivateSubscriber(roomId, res);
      info = { type: 'chat' };
    } else {
      const handle = this._roomManager.getBroadcaster(roomId).registerSubscriber(res);
      info = { type: 'room', handle };
    }
    subs.set(roomId, info);
  }

  /** 从某聚合 res 移除某房:注销 broadcaster(死 res 由各 broadcaster writable 检查兜底)。 */
  _removeRoom(res, roomId, info) {
    const subs = this._resSubs.get(res);
    if (!info) return;
    if (info.type === 'chat') {
      removePrivateSubscriber(roomId, res);
    } else if (info.handle) {
      try { this._roomManager.getBroadcaster(roomId)?.removeSubscriber(info.handle); } catch (e) { /* ignore */ }
    }
    subs?.delete(roomId);
  }
}