/**
 * room_bus —— 群聊消息总线内核（A 阶段：可纯测部分）
 *
 * 本文件只实现不起真实子进程的内核：
 *   - RoomBroadcaster：per-room SSE 订阅者管理 + 广播 speak/member_status 事件
 *   - RoomHistory：群历史 history.jsonl（append+JSONL，room 维度 + speaker/event schema）
 *   - allocPort：动态分配空闲端口
 *   - RoomRegistry：副本注册表（run.json 读写，re-discover 用）
 *
 * 不含（留 B 阶段）：真实副本 spawn、保活巡检、observe 转发、/rooms 路由。
 *
 * 见 docs/chat-room-design.md §7（交互协议）、§8（目录）、§11（落盘）。
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { createLogger } from '../shared/logger.js';
import { probePort, waitForReady, httpShutdown } from '../shared/agent_probe.js';
import { loadGatewayConfig } from './config.js';

const logger = createLogger('room-bus', 'gateway.log');

// ============================================================
// RoomBroadcaster —— per-room 统一订阅者管理（SSE + agent）
// ============================================================

/**
 * 群聊广播器。统一管理前端 SSE 订阅者和 agent 副本订阅者，
 * 通过 notifyAll() 同时推送给两类消费者。
 *
 * subscribeSSE / unsubscribeSSE — 前端（SSE 长连接）
 * subscribeAgent / unsubscribeAgent — agent 副本（POST /observe）
 *
 * 见 docs/chat-room-design.md §7.2（交互协议）。
 */
export class RoomBroadcaster {
  constructor(roomId, opts = {}) {
    this.roomId = roomId;
    /** @type {{ res: object }[]} 前端 SSE 订阅者 */
    this._sseSubscribers = [];
    /** @type {Map<string, { port: number }>} agent 订阅者 agentId → { port } */
    this._agentSubscribers = new Map();
    /** @type {(agentId: string) => void} agent POST 失败回调 */
    this._onAgentOffline = opts.onAgentOffline || null;
    /** v3：gateway 端口，供 _broadcastToAgents 给 /observe body 带 roomBusUrl（agent Speak 回调用，懒建 RoomState 需此字段否则缺 roomBusUrl 无法发言）*/
    this._gatewayPort = opts.gatewayPort || null;
  }

  // ────────────── SSE 订阅者（前端）──────────────

  /** @deprecated 别名，用 subscribeSSE */
  add(res, snapshotData) { return this.subscribeSSE(res, snapshotData); }

  /**
   * 前端加入 SSE 订阅：设置 SSE 头 + 推 snapshot + 注册订阅者
   */
  subscribeSSE(res, snapshotData = { members: [], messages: [] }) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    if (res.socket) res.socket.setNoDelay(true);

    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshotData)}\n\n`);

    const sub = { res };
    this._sseSubscribers.push(sub);

    res.on('close', () => {
      const idx = this._sseSubscribers.indexOf(sub);
      if (idx !== -1) this._sseSubscribers.splice(idx, 1);
    });

    return sub;
  }

  // ────────────── agent 订阅者（副本）──────────────

  /** agent 副本加入广播 */
  subscribeAgent(agentId, port) {
    this._agentSubscribers.set(agentId, { port });
  }

  /** agent 副本退出广播 */
  unsubscribeAgent(agentId) {
    this._agentSubscribers.delete(agentId);
  }

  // ────────────── 统一的广播 ──────────────

  /**
   * SSE-only 广播（member_status 等不需要推给 agent 的事件）
   */
  broadcast(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this._sseSubscribers = this._sseSubscribers.filter(sub => {
      try {
        if (sub.res.writable) {
          sub.res.write(chunk);
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    });
  }

  /**
   * 统一通知所有订阅者（SSE + agent）。
   * 前端 SSE：speaker=name，content=name 版（@ 已改写成 name）。
   * agent /observe：from=speakerUid（agent 自消息过滤靠 uid），content=name 版。
   * @param {string} event - 事件名（speak）
   * @param {{speakerUid,speakerName,contentNames,ts,id,seq,mentions}} data
   */
  notifyAll(event, data) {
    // SSE 给前端（name 版）
    const sseData = {
      speaker: data.speakerName,
      speakerUid: data.speakerUid,
      content: data.contentNames,
      ts: data.ts, id: data.id, seq: data.seq,
    };
    const chunk = `event: ${event}\ndata: ${JSON.stringify(sseData)}\n\n`;
    this._sseSubscribers = this._sseSubscribers.filter(sub => {
      try {
        if (sub.res.writable) { sub.res.write(chunk); return true; }
        return false;
      } catch (e) { return false; }
    });

    // POST /observe 给 agent 副本（from=uid，content=name 版）
    this._broadcastToAgents(data);
  }

  /**
   * Fire-and-forget POST /observe 给所有 agent 订阅者
   * from=speakerUid（agent 自消息过滤靠 uid），content=name 版（gateway 已改写）
   */
  async _broadcastToAgents(data) {
    const body = {
      roomId: this.roomId,          // v3：带 roomId 供 agent 进程路由到该群 RoomState
      mode: 'room',
      from: data.speakerUid,
      content: data.contentNames,
      mentions: Array.isArray(data.mentions) ? data.mentions : [],
      role: 'chat',
      seq: data.seq ?? null,
      // v3：懒建群 RoomState 时 buildRunContext 需 roomBusUrl，否则 Speak 报"缺 roomBusUrl,无法发言"。
      roomBusUrl: this._gatewayPort ? `http://127.0.0.1:${this._gatewayPort}/rooms/${this.roomId}` : null,
    };
    const bodyStr = JSON.stringify(body);
    const failed = [];

    await Promise.all([...this._agentSubscribers].map(async ([agentId, sub]) => {
      try {
        const resp = await fetch(`http://127.0.0.1:${sub.port}/observe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr,
          signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) failed.push(agentId);
      } catch (err) {
        failed.push(agentId);
      }
    }));

    // 失败回调
    if (this._onAgentOffline) {
      for (const agentId of failed) this._onAgentOffline(agentId);
    }
  }

  /** 关闭所有订阅者连接 */
  removeAll() {
    for (const sub of this._sseSubscribers) {
      try { if (sub.res.writable) sub.res.end(); } catch (e) { /* ignore */ }
    }
    this._sseSubscribers = [];
    this._agentSubscribers.clear();
  }

  /** @type {{ res: object }[]} @deprecated 兼容旧引用，用 _sseSubscribers */
  get subscribers() { return this._sseSubscribers; }
  set subscribers(v) { this._sseSubscribers = v; }

  get size() { return this._sseSubscribers.length + this._agentSubscribers.size; }
}

// ============================================================
// RoomHistory —— 群历史 history.jsonl（append + JSONL）
// ============================================================

/**
 * 群聊历史持久化。抄 chat_history.js 的 append+JSONL+游标分页模式，
 * 换成 room 维度（rooms/<rid>/history.jsonl）+ 扩展 schema（speaker/event）。
 * 不含 chat_history 的 _mergeCompactRecords（私聊压缩特有，群聊不需要）。
 */
export class RoomHistory {
  /**
   * @param {string} roomsDir - rooms 根目录（绝对路径）
   * @param {string} roomId
   */
  constructor(roomsDir, roomId) {
    this.roomsDir = roomsDir;
    this.roomId = roomId;
    this.filePath = path.join(roomsDir, roomId, 'history.jsonl');
    this._nextSeq = this._loadLastSeq() + 1;
  }

  /** 从文件最后一条记录恢复 seq 计数器 */
  _loadLastSeq() {
    try {
      if (!fs.existsSync(this.filePath)) return 0;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return 0;
      const last = JSON.parse(lines[lines.length - 1]);
      return last.seq ?? 0;
    } catch (err) {
      return 0;
    }
  }

  _generateId() {
    return `rmsg_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  }

  _ensureDir() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      logger.warn(`创建群历史目录失败: ${err.message}`);
    }
  }

  /**
   * 追加一条群消息
   * @param {string} speaker - 发言者（agent 成员名或 'user'）—— 显示名，向后兼容
   * @param {string} content
   * @param {string} [event='speak'] - 事件类型（speak/member_join/member_leave/member_status）
   * @param {string} [speakerUid] - 发言者稳定身份（问题3）：user 消息传 userUid，agent 消息传 agentId。
   *        username/agent name 可改，speakerUid 不变，历史归属据此连续。
   * @returns {{id,roomId,speaker,content,event,ts,speakerUid?}}
   */
  add(speaker, content, event = 'speak', speakerUid = null) {
    const seq = this._nextSeq++;
    const record = {
      id: this._generateId(),
      seq,
      roomId: this.roomId,
      speaker,
      content,
      event,
      ts: new Date().toISOString(),
    };
    if (speakerUid) record.speakerUid = speakerUid;
    this._ensureDir();
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      logger.error(`写入群历史失败 (${this.roomId}): ${err.message}`);
    }
    return record;
  }

  /** 读全部记录（内部用） */
  _readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return raw.split('\n')
        .filter(line => line.trim())
        .map(line => { try { return JSON.parse(line); } catch (e) { return null; } })
        .filter(Boolean);
    } catch (err) {
      return [];
    }
  }

  /** 返回指定 seq 之后的全部消息。seq=0 返回所有；seq>0 返回 seq 严格大于该值的记录。 */
  getAfterSeq(seq = 0) {
    const all = this._readAll();
    const messages = seq > 0 ? all.filter(m => (m.seq ?? 0) > seq) : all;
    const lastMsg = all.length > 0 ? all[all.length - 1] : null;
    return { messages, latestSeq: lastMsg?.seq ?? 0 };
  }

  /**
   * 分页读取。游标语义对齐 chat_history.getRecent：最旧在前正序、beforeId 向前翻、afterId 增量。
   * 不做 _mergeCompactRecords 后处理。
   */
  getRecent(limit = 30, beforeId, afterId) {
    if (!fs.existsSync(this.filePath)) {
      return { messages: [], hasMore: false };
    }

    let records;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      records = raw.split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line); }
          catch (e) { return null; }
        })
        .filter(Boolean);
    } catch (err) {
      logger.error(`读取群历史失败 (${this.roomId}): ${err.message}`);
      return { messages: [], hasMore: false };
    }

    // afterId：返回 afterId 之后的所有消息（增量查询）
    if (afterId) {
      const idx = records.findIndex(r => r.id === afterId);
      if (idx >= 0 && idx < records.length - 1) {
        records = records.slice(idx + 1);
      } else {
        return { messages: [], hasMore: false };
      }
      return { messages: records, hasMore: false };
    }

    // beforeId：向前翻页
    if (beforeId) {
      const idx = records.findIndex(r => r.id === beforeId);
      if (idx > 0) {
        records = records.slice(0, idx);
      } else if (idx === 0) {
        return { messages: [], hasMore: false };
      } else {
        // idx === -1：游标未命中，返回空让前端停翻（对齐 chat_history 语义）
        logger.warn(`beforeId 未命中群历史 (${this.roomId}): ${beforeId}`);
        return { messages: [], hasMore: false };
      }
    }

    // 取最新 limit 条，正序（最旧在前）
    const total = records.length;
    const start = Math.max(0, total - limit);
    const messages = records.slice(start);
    const hasMore = start > 0;
    return { messages, hasMore };
  }

  /** 清空群历史 + 重置 seq 计数器 */
  clear() {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, '', 'utf-8');
      }
    } catch (err) {
      logger.error(`清空群历史失败 (${this.roomId}): ${err.message}`);
    }
    this._nextSeq = 1;
  }
}

// ============================================================
// allocPort —— 动态分配空闲端口
// ============================================================

/**
 * 用 net.createServer().listen(0) 让 OS 分配一个空闲端口，立即 close 返回。
 * 注意竞态：拿到端口到副本 listen（B 阶段）有窗口；本阶段只保证返回可 listen 端口。
 * @returns {Promise<number>}
 */
export function allocPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ============================================================
// RoomRegistry —— 副本注册表（run.json 读写）
// ============================================================

/**
 * 管理 rooms/<rid>/data/<agentId>/run.json。re-discover / cleanup.sh 用。
 * 路径用 roomId+agentId 拼（不把 runKey 整体当文件名，避免 / 当路径分隔符的坑）。
 */
export class RoomRegistry {
  /**
   * @param {string} roomsDir - rooms 根目录
   */
  constructor(roomsDir) {
    this.roomsDir = roomsDir;
  }

  /** 某副本的 run.json 路径 */
  _path(roomId, agentId) {
    return path.join(this.roomsDir, roomId, 'data', agentId, 'run.json');
  }

  /**
   * 写入副本注册信息
   * @param {string} roomId
   * @param {string} agentId
   * @param {{port:number, pid:number, memberName:string, dataDir:string, roomBusUrl:string}} info
   */
  write(roomId, agentId, info) {
    const filePath = this._path(roomId, agentId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const record = {
      runKey: `${roomId}/${agentId}`,
      roomId,
      agentId,
      port: info.port,
      pid: info.pid,
      memberName: info.memberName ?? agentId,
      dataDir: info.dataDir ?? null,
      roomBusUrl: info.roomBusUrl ?? null,
    };
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    return record;
  }

  /** 读单副本，不存在返回 null */
  read(roomId, agentId) {
    const filePath = this._path(roomId, agentId);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  /**
   * 列出某群所有副本注册信息（跳过缺 run.json 的成员目录）
   * @returns {Array<object>}
   */
  list(roomId) {
    const dataDir = path.join(this.roomsDir, roomId, 'data');
    if (!fs.existsSync(dataDir)) return [];
    let entries;
    try {
      entries = fs.readdirSync(dataDir, { withFileTypes: true });
    } catch (err) {
      return [];
    }
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rec = this.read(roomId, entry.name);
      if (rec) result.push(rec);
    }
    return result;
  }

  /** 删除单副本 run.json（不删目录，保留 context/history） */
  remove(roomId, agentId) {
    const filePath = this._path(roomId, agentId);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      logger.warn(`删除 run.json 失败 (${roomId}/${agentId}): ${err.message}`);
    }
  }
}

// ============================================================
// RoomConfig —— 群配置 room.json（成员名单持⽌化）
// ============================================================

/**
 * 群配置读写。路径 rooms/<rid>/room.json。
 * schema: { roomId, name, members:[agentId], createdAt }。
 * 加退成员 = 改 members 并写回。
 *
 * 见 docs/chat-room-design.md §8.2。
 */
export class RoomConfig {
  /**
   * @param {string} roomsDir - rooms 根目录
   * @param {string} roomId
   */
  constructor(roomsDir, roomId) {
    this.roomsDir = roomsDir;
    this.roomId = roomId;
    this.filePath = path.join(roomsDir, roomId, 'room.json');
  }

  /** 是否存在 */
  exists() {
    return fs.existsSync(this.filePath);
  }

  /** 读；不存在返回 null */
  read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  /**
   * 创建群配置
   * @param {string} name - 群名
   * @param {string[]} members - 成员 agentId 列表
   * @returns {{roomId,name,members,createdAt}}
   */
  create(name, members) {
    const record = {
      roomId: this.roomId,
      name: name || this.roomId,
      members: Array.isArray(members) ? [...members] : [],
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(record, null, 2), 'utf-8');
    return record;
  }

  /** 改名 */
  updateName(name) {
    const cfg = this.read();
    if (!cfg) return null;
    cfg.name = name;
    fs.writeFileSync(this.filePath, JSON.stringify(cfg, null, 2), 'utf-8');
    return cfg;
  }

  /** 加成员（去重） */
  addMember(agentId) {
    const cfg = this.read();
    if (!cfg) return null;
    if (!cfg.members.includes(agentId)) cfg.members.push(agentId);
    fs.writeFileSync(this.filePath, JSON.stringify(cfg, null, 2), 'utf-8');
    return cfg;
  }

  /** 移除成员 */
  removeMember(agentId) {
    const cfg = this.read();
    if (!cfg) return null;
    cfg.members = cfg.members.filter(m => m !== agentId);
    fs.writeFileSync(this.filePath, JSON.stringify(cfg, null, 2), 'utf-8');
    return cfg;
  }
}

// ============================================================
// RoomManager —— 副本生命周期 + 保活（per-room 状态聚合）
// ============================================================

/** 副本运行态 */
const MEMBER_STATUS = { RUNNING: 'running', OFFLINE: 'offline', STARTING: 'starting', STOPPED: 'stopped' };

/** 真实 spawn 副本进程：调 engine/start.js --mode room ... */
function defaultSpawnFn({ configDir, roomId, agentId, port, dataDir, roomBusUrl }) {
  const child = spawn(process.execPath, [
    'engine/start.js',
    '--config', configDir,
    '--mode', 'room',
    '--port', String(port),
    '--data', dataDir,
    '--room-id', roomId,
    '--member', agentId,
    '--room-bus', roomBusUrl,
  ], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  return child; // 调用方读 child.pid
}

/**
 * 群管理器。聚合 RoomConfig + RoomRegistry + RoomBroadcaster + 副本运行态。
 * spawnFn 可注入用于测试（默认真实 spawn）。
 */
export class RoomManager {
  /**
   * @param {string} roomsDir
   * @param {number} gatewayPort - 给副本 --room-bus 用
   * @param {object} [opts]
   * @param {Function} [opts.spawnFn] - 注入 fake spawn（测试用）
   * @param {Function} [opts.agentConfigDir] - 纯函数 (agentId)=>configDir，默认 agents/<id>/config
   * @param {string} [opts.chatRoot] - 成员 agent 记忆根（chat/），默认 cwd/chat；解散/移除成员清 chat/<id>/<rid>/ 用
   */
  constructor(roomsDir, gatewayPort, opts = {}) {
    this.roomsDir = roomsDir;
    this.gatewayPort = gatewayPort;
    this.registry = new RoomRegistry(roomsDir);
    this.spawnFn = opts.spawnFn || defaultSpawnFn;
    this.agentConfigDir = opts.agentConfigDir || ((id) => path.join(process.cwd(), 'agents', id, 'config'));
    this.startTimeout = opts.startTimeout || 10_000;
    /** v3：注入 ProcessManager（pm）。有 pm 时 ensureAgentPresent 直接复用已运行的 agent 进程，
     *   通过 POST /observe（payload 带 roomId）路由到该 agent 进程内的 RoomState，不再 spawn 副本。
     *   无 pm 时（旧测试注入 spawnFn）回退 spawnReplica。 */
    this.pm = opts.pm || null;
    this.gatewayUrl = opts.gatewayUrl || null;
    this.chatRoot = opts.chatRoot || path.join(process.cwd(), 'chat');   // 成员记忆根
    /** roomId → { config: RoomConfig, broadcaster: RoomBroadcaster, history: RoomHistory, members: Map<agentId, {port,pid,status}> } */
    this.rooms = new Map();
  }

  /**
   * v3：确保某 agent 进程在场并订阅本群广播。有 pm 时复用 pm.startAgent（不再 spawn 副本），
   *   /observe 经 payload.roomId 路由到该 agent 进程内的 RoomState[roomId]（懒建）。
   *   无 pm 时回退 spawnReplica（旧 spawnFn 测试路径）。
   * @returns {Promise<{port, pid, status}>}
   */
  async ensureAgentPresent(roomId, agentId) {
    const room = this._ensureRoom(roomId);
    if (!this.pm) {
      return this.spawnReplica(roomId, agentId);
    }
    const configDir = this.agentConfigDir(agentId);
    if (!fs.existsSync(path.join(configDir, 'config.json'))) {
      room.members.set(agentId, { port: null, pid: null, status: MEMBER_STATUS.OFFLINE });
      throw new Error(`agent 不存在: ${agentId}`);
    }
    // 复用已运行的 agent 进程（pm.startAgent 幂等：已运行直接返回）。
    if (this.pm.getAgentStatus?.(agentId) !== 'running') {
      await this.pm.startAgent(agentId);
    }
    const port = this.pm.getAgentPort(agentId);
    const pid = this.pm.getAgent?.(agentId)?.pid ?? null;
    room.members.set(agentId, { port, pid, status: MEMBER_STATUS.RUNNING });
    room.broadcaster.subscribeAgent(agentId, port);
    // 落盘 run.json 仍供 cleanup.sh 兼容（v3 不再 spawn，但保留记录）。
    const dataDir = path.join(this.roomsDir, roomId, 'data', agentId);
    const roomBusUrl = `http://127.0.0.1:${this.gatewayPort}/rooms/${roomId}`;
    this.registry.write(roomId, agentId, { port, pid, memberName: agentId, dataDir, roomBusUrl });
    logger.info(`ensureAgentPresent ${roomId}/${agentId} 复用进程 (port ${port})`);
    return { port, pid, status: MEMBER_STATUS.RUNNING };
  }

  /** 确保群在内存态（懒加载） */
  _ensureRoom(roomId) {
    if (this.rooms.has(roomId)) return this.rooms.get(roomId);
    const cfg = new RoomConfig(this.roomsDir, roomId);
    const entry = {
      config: cfg,
      broadcaster: new RoomBroadcaster(roomId, {
        gatewayPort: this.gatewayPort,
        onAgentOffline: (agentId) => {
          const m = entry.members.get(agentId);
          if (m) entry.members.set(agentId, { ...m, status: MEMBER_STATUS.OFFLINE });
        },
      }),
      history: new RoomHistory(this.roomsDir, roomId),
      members: new Map(),
    };
    this.rooms.set(roomId, entry);
    return entry;
  }

  /**
   * 创建群
   * @returns {Promise<{roomId, name, members}>}
   */
  async createRoom(name, members) {
    const roomId = `room_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    const cfg = new RoomConfig(this.roomsDir, roomId);
    const rec = cfg.create(name, members);
    this._ensureRoom(roomId);
    for (const agentId of rec.members) {
      await this.ensureAgentPresent(roomId, agentId).catch(err => {
        logger.warn(`建群时拉起 ${agentId} 失败: ${err.message}`);
      });
    }
    return { roomId, name: rec.name, members: rec.members };
  }

  /**
   * 拉起一个副本
   * @returns {Promise<{port, pid, status}>}
   */
  async spawnReplica(roomId, agentId) {
    const room = this._ensureRoom(roomId);
    if (!room.config.exists()) throw new Error(`群不存在: ${roomId}`);
    const configDir = this.agentConfigDir(agentId);
    if (!fs.existsSync(path.join(configDir, 'config.json'))) {
      // 成员 agent 不存在
      room.members.set(agentId, { port: null, pid: null, status: MEMBER_STATUS.OFFLINE });
      throw new Error(`agent 不存在: ${agentId}`);
    }
    const port = await allocPort();
    const dataDir = path.join(this.roomsDir, roomId, 'data', agentId);
    const roomBusUrl = `http://127.0.0.1:${this.gatewayPort}/rooms/${roomId}`;
    room.members.set(agentId, { port, pid: null, status: MEMBER_STATUS.STARTING });
    try {
      const child = this.spawnFn({ configDir, roomId, agentId, port, dataDir, roomBusUrl });
      const pid = child.pid;
      // 等待就绪（fake spawn 测试时 child._fakeReady 已 true，跳过等待）
      const ready = child._fakeReady === true ? true : await waitForReady(port, this.startTimeout);
      if (!ready) {
        room.members.set(agentId, { port, pid, status: MEMBER_STATUS.OFFLINE });
        logger.warn(`副本 ${roomId}/${agentId} 拉起超时，标 offline`);
        return { port, pid, status: MEMBER_STATUS.OFFLINE };
      }
      this.registry.write(roomId, agentId, { port, pid, memberName: agentId, dataDir, roomBusUrl });
      room.members.set(agentId, { port, pid, status: MEMBER_STATUS.RUNNING });
      room.broadcaster.subscribeAgent(agentId, port);
      logger.info(`副本 ${roomId}/${agentId} 已起 (port ${port}, pid ${pid})`);
      return { port, pid, status: MEMBER_STATUS.RUNNING };
    } catch (err) {
      room.members.set(agentId, { port, pid: null, status: MEMBER_STATUS.OFFLINE });
      logger.error(`spawn 副本失败 ${roomId}/${agentId}: ${err.message}`);
      return { port, pid: null, status: MEMBER_STATUS.OFFLINE };
    }
  }

  /** 停一个副本。
   *  v3：有 pm 时 agent 进程被多 room（含私聊 chat-<id>）复用，绝不能因退群/停某房而 shutdown 它——
   *    仅退订本房广播。无 pm（旧 spawn 模式）才 shutdown 副本进程。 */
  async stopReplica(roomId, agentId) {
    const room = this._ensureRoom(roomId);
    const m = room.members.get(agentId);
    if (this.pm) {
      // 共享进程：只退订，不动进程
      this.registry.remove(roomId, agentId);
      room.broadcaster.unsubscribeAgent(agentId);
      room.members.set(agentId, { port: null, pid: null, status: MEMBER_STATUS.STOPPED });
      logger.info(`副本 ${roomId}/${agentId} 退订（pm 共享进程保留）`);
      return;
    }
    if (m && m.port) {
      try { await httpShutdown(m.port); } catch (err) { /* 进程可能已不在 */ }
    }
    this.registry.remove(roomId, agentId);
    room.broadcaster.unsubscribeAgent(agentId);
    room.members.set(agentId, { port: null, pid: null, status: MEMBER_STATUS.STOPPED });
    logger.info(`副本 ${roomId}/${agentId} 已停`);
  }

  /** 加成员：改 config + spawn */
  async addMember(roomId, agentId) {
    const room = this._ensureRoom(roomId);
    if (!room.config.exists()) throw new Error(`群不存在: ${roomId}`);
    room.config.addMember(agentId);
    await this.ensureAgentPresent(roomId, agentId).catch(err => {
      logger.warn(`加成员时拉起 ${agentId} 失败: ${err.message}`);
    });
    return this.getRoom(roomId);
  }

  /** 移除成员：停副本 + 改 config + 删 data */
  async removeMember(roomId, agentId) {
    const room = this._ensureRoom(roomId);
    await this.stopReplica(roomId, agentId);
    room.config.removeMember(agentId);
    // v3：清该成员对本群的记忆目录 chat/<agentId>/<rid>/（旧 rooms/<rid>/data/<agentId>/ 已不用）
    const chatRoot = this.chatRoot;
    const memberRoomDir = path.join(chatRoot, agentId, roomId);
    try { fs.rmSync(memberRoomDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    return this.getRoom(roomId);
  }

  /**
   * 解散群：停所有成员副本 + 关广播订阅 + 删 rooms/<rid>/ 整目录 + 清内存态。
   * @param {string} roomId
   */
  async deleteRoom(roomId) {
    const room = this._ensureRoom(roomId);
    const cfg = room.config.read();
    if (!cfg) throw new Error(`群不存在: ${roomId}`);
    // 停所有副本（v3 pm 模式仅退订，不动共享 agent 进程）
    for (const agentId of cfg.members) {
      await this.stopReplica(roomId, agentId).catch(() => { /* ignore */ });
    }
    // 关订阅者
    room.broadcaster.removeAll();
    // 删 rooms/<rid>/ 整目录（含 room.json / history.jsonl）
    const roomDir = path.join(this.roomsDir, roomId);
    try { fs.rmSync(roomDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    // v3：各成员 agent 对该群的 RoomState 记忆目录 chat/<agentId>/<rid>/（context/tool-results）一并清，
    //   否则解散后成员对该群的记忆残留。路径来源 pm.chatDir（gateway/index.js 设 chat/）。
    const chatRoot = this.chatRoot;
    for (const agentId of cfg.members) {
      const memberRoomDir = path.join(chatRoot, agentId, roomId);
      try { fs.rmSync(memberRoomDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
    // 清内存态
    this.rooms.delete(roomId);
    logger.info(`群 ${roomId} 已解散（ rooms/<rid>/ + 各成员 chat/<id>/<rid>/ 已清）`);
  }

  /** 读取某 agent config.json 的 name（失败/无则回退 agentId，容错不抛） */
  _readAgentName(agentId) {
    try {
      const cfgDir = this.agentConfigDir(agentId);
      const cfgFile = path.join(cfgDir, 'config.json');
      if (fs.existsSync(cfgFile)) {
        const raw = fs.readFileSync(cfgFile, 'utf-8');
        const data = JSON.parse(raw);
        return data?.name || agentId;
      }
    } catch (err) { /* 容错：回退 agentId */ }
    return agentId;
  }

  /** 读取某 agent config.json 的 avatar 字段（失败返回 null） */
  _readAgentAvatar(agentId) {
    try {
      const cfgDir = this.agentConfigDir(agentId);
      const cfgFile = path.join(cfgDir, 'config.json');
      if (fs.existsSync(cfgFile)) {
        const raw = fs.readFileSync(cfgFile, 'utf-8');
        const data = JSON.parse(raw);
        return data?.avatar || null;
      }
    } catch (err) { /* 容错 */ }
    return null;
  }

  /** 取群状态（含成员运行态 + 显示名 name + avatar） */
  getRoom(roomId) {
    const room = this._ensureRoom(roomId);
    const cfg = room.config.read();
    if (!cfg) return null;
    const members = cfg.members.map(agentId => {
      const m = room.members.get(agentId);
      return { agentId, name: this._readAgentName(agentId), avatar: this._readAgentAvatar(agentId), status: m?.status || MEMBER_STATUS.OFFLINE, port: m?.port || null };
    });
    return { roomId, name: cfg.name, members, createdAt: cfg.createdAt };
  }

  /** 列所有群 */
  listRooms() {
    if (!fs.existsSync(this.roomsDir)) return [];
    const ids = fs.readdirSync(this.roomsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    const result = [];
    for (const roomId of ids) {
      const cfg = new RoomConfig(this.roomsDir, roomId).read();
      if (cfg) result.push({ roomId, name: cfg.name, members: cfg.members, createdAt: cfg.createdAt });
    }
    return result;
  }

  /**
   * 保活巡检：遍历成员探活，死的重拉，反复失败标 offline。
   * 必巡检时机由路由调（建群/加成员/subscribe）。
   * @returns {Promise<void>}
   */
  async ensureReplicasAlive(roomId) {
    const room = this._ensureRoom(roomId);
    const cfg = room.config.read();
    if (!cfg) return;
    // v3：有 pm 时直接 ensureAgentPresent（复用已运行 agent 进程），跳过 run.json/probe re-discover 逻辑。
    if (this.pm) {
      await Promise.all(cfg.members.map((agentId) =>
        this.ensureAgentPresent(roomId, agentId).catch(err => logger.warn(`ensureReplicasAlive ${agentId}: ${err.message}`))
      ));
      return;
    }
    await Promise.all(cfg.members.map(async (agentId) => {
      const m = room.members.get(agentId);
      if (m?.status === MEMBER_STATUS.STOPPED) {
        // 已停的不管（可能正被移除）
        return;
      }
      // 问题4：!m 表示内存态丢失（典型场景 gateway 重启，detached 副本仍在跑或已死）。
      //   原来直接 return → 重启后不探活不重拉，全员永远显示离线。
      //   现在按落盘 run.json re-discover：探活活着就回填内存态，死了就 spawnReplica 重拉。
      if (!m) {
        const rec = this.registry.read(roomId, agentId);
        if (rec?.port) {
          const r = await probePort(rec.port);
          if (r.ok) {
            room.members.set(agentId, { port: rec.port, pid: rec.pid ?? r.pid ?? null, status: MEMBER_STATUS.RUNNING });
            room.broadcaster.subscribeAgent(agentId, rec.port);
            logger.info(`副本 ${agentId} re-discover 成功 (port ${rec.port} 存活),回填内存态`);
            return;
          }
        }
        // run.json 没有 / 进程死了 → 重拉（spawnReplica 内部 allocPort + waitForReady + 写 run.json + 回填 Map）
        logger.info(`副本 ${agentId} 内存态缺失且不存活，重拉`);
        await this.spawnReplica(roomId, agentId).catch(err => {
          logger.warn(`重拉 ${agentId} 失败: ${err.message}`);
        });
        return;
      }
      // m 存在：原有探活重拉逻辑
      const r = await probePort(m.port);
      if (r.ok) {
        room.members.set(agentId, { ...m, status: MEMBER_STATUS.RUNNING, pid: r.pid ?? m.pid });
        room.broadcaster.subscribeAgent(agentId, m.port);
      } else {
        // 死了，重拉
        logger.info(`副本 ${agentId} 不存活，重拉`);
        await this.spawnReplica(roomId, agentId).catch(err => {
          logger.warn(`重拉 ${agentId} 失败: ${err.message}`);
        });
      }
    }));
  }

  /** 广播成员状态变更给订阅者 */
  broadcastMemberStatus(roomId) {
    const room = this._ensureRoom(roomId);
    const r = this.getRoom(roomId);
    if (!r) return;
    for (const m of r.members) {
      room.broadcaster.broadcast('member_status', { agentId: m.agentId, status: m.status });
    }
  }

  /** 取某群的 broadcaster（路由 subscribe 用） */
  getBroadcaster(roomId) {
    return this._ensureRoom(roomId).broadcaster;
  }

  /** 取某群历史（路由用） */
  getHistory(roomId) {
    return this._ensureRoom(roomId).history;
  }

  /**
   * 处理一条群消息的完整流水线：写历史 → 统一通知所有订阅者（SSE + agent）。
   * 被 /say 路由复用。
   *
   * 落盘层（A 方案）：speaker/speakerUid 都存 uid；content 里的 @ 统一存 uid。
   * 发送层：SSE 给前端用 name 版（speaker=name，content @=name）；/observe 给 agent
   *   from=uid（agent 自消息过滤靠 uid），content @=name。
   *
   * @param {string} roomId - 群 id
   * @param {string} speakerUid - 发言者 uid（用户用 userUid，agent 用 agentId）
   * @param {string} content - 消息原文（@ 可能是 id 或 name）
   * @returns {{id: string, seq: number}} 写入的历史记录
   */
  async processRoomMessage(roomId, speakerUid, content) {
    const room = this._ensureRoom(roomId);
    const history = room.history;
    const bc = room.broadcaster;
    const { membersWithNames, user } = this._rosterForRewrite(roomId);

    // 1. 写群历史（落盘 uid 版：speaker=uid，content @=uid）
    const contentUids = RoomManager.rewriteMentions(content, membersWithNames, user, 'uid');
    const rec = history.add(speakerUid, contentUids, 'speak', speakerUid);

    // 2. 解析 mentions（uid 列表，给 agent 判被@用）
    const mentions = RoomManager.parseMentions(content, membersWithNames);

    // 3. 发送层 name 版（content @=name）
    const contentNames = RoomManager.rewriteMentions(contentUids, membersWithNames, user, 'name');
    const speakerName = this._speakerName(speakerUid, membersWithNames, user);

    // notifyAll 内部给 SSE 传 name 版、给 agent observe 传 from=uid + name 版 content
    bc.notifyAll('speak', {
      speakerUid, speakerName, contentNames,
      ts: rec.ts, id: rec.id, seq: rec.seq, mentions,
    });

    return rec;
  }

  /**
   * 启动某个房间的所有成员副本
   * 只启动当前状态为 stopped/offline 的成员
   */
  async startRoomAgents(roomId) {
    const cfg = this._ensureRoom(roomId).config.read();
    if (!cfg?.members?.length) return;
    const results = await Promise.allSettled(
      cfg.members.map(agentId =>
        this.spawnReplica(roomId, agentId).catch(err => {
          logger.warn(`启动房间 ${roomId} 的成员 ${agentId} 失败: ${err.message}`);
          return { agentId, status: 'failed', reason: err.message };
        })
      )
    );
    return results.map(r => (r.status === 'fulfilled' ? r.value : { status: 'failed', reason: r.reason }));
  }

  /**
   * 停止某个房间的所有成员副本
   */
  async stopRoomAgents(roomId) {
    const cfg = this._ensureRoom(roomId).config.read();
    if (!cfg?.members?.length) return;
    await Promise.all(cfg.members.map(agentId =>
      this.stopReplica(roomId, agentId).catch(() => {})
    ));
  }

  /**
   * 解析消息文本里的 @<成员名>，返回被@的成员 agentId 列表。
   * 候选同时认 id 和显示名(name)：@elf-003 与 @Star 都能命中同一成员，结果归一到 agentId。
   * 候选按长度降序取最长匹配，避免短名误触发（如 elf 被当成 elf-001 的一部分）。
   *
   * @param {string} message
   * @param {Array<string|{agentId:string,name?:string}>} members - 成员列表（id 字符串数组，
   *        或 {agentId,name} 对象数组，后者用于 @name 也能命中）
   * @returns {string[]} 被命中的成员 agentId 列表（去重、归一到 id）
   */
  static parseMentions(message, members) {
    if (!message || !members?.length) return [];
    // 候选:{value,agentId} —— 同时收录每个成员的 id 和 name(若有且不同于 id)
    const candidates = [];
    const seenVals = new Set();
    for (const m of members) {
      const obj = (typeof m === 'string') ? { agentId: m } : m;
      if (!obj?.agentId) continue;
      for (const v of [obj.agentId, obj.name]) {
        if (v && !seenVals.has(v)) { seenVals.add(v); candidates.push({ value: v, agentId: obj.agentId }); }
      }
    }
    // 最长匹配优先:按 value 长度降序,每处 @ 取最先命中的(即最长)
    candidates.sort((a, b) => b.value.length - a.value.length);
    const mentionedIds = new Set();
    let pos = 0;
    while ((pos = message.indexOf('@', pos)) !== -1) {
      const after = message.slice(pos + 1);
      let hit = null;
      for (const c of candidates) {
        if (after.startsWith(c.value)) { hit = c; break; }
      }
      if (hit) {
        mentionedIds.add(hit.agentId);
        pos += 1 + hit.value.length;
      } else if (!after || candidates.some(c => after.startsWith(c.value))) {
        pos++;
      } else {
        pos++;
      }
    }
    return [...mentionedIds];
  }

  /**
   * 改写 content 里的 @<成员> 为指定方向（uid 或 name）。
   * 候选同时认 id 和 name，按长度降序最长匹配，逐处 @ 替换。
   * 用户 uid 也参与（用户可能被 @）：user 候选 = { uid, name: userName }。
   *
   * @param {string} content
   * @param {Array<{agentId:string,name?:string}>} membersWithNames - 含 name 的成员列表
   * @param {object} [user] - { uid, name }，可选（用户也参与改写）
   * @param {'uid'|'name'} [target='uid'] - 改写方向
   * @returns {string}
   */
  static rewriteMentions(content, membersWithNames, user, target = 'uid') {
    if (!content) return content;
    // 候选:{value, to} —— value 是待匹配的 id/name，to 是改写目标值
    const candidates = [];
    const seenVals = new Set();
    const push = (value, to) => {
      if (!value || seenVals.has(value)) return;
      seenVals.add(value); candidates.push({ value, to });
    };
    for (const m of (membersWithNames || [])) {
      if (!m?.agentId) continue;
      const name = m.name || m.agentId;
      const to = target === 'uid' ? m.agentId : name;
      push(m.agentId, to);
      push(name, to);
    }
    if (user?.uid) {
      const uname = user.name || user.uid;
      const to = target === 'uid' ? user.uid : uname;
      push(user.uid, to);
      push(uname, to);
    }
    // 最长匹配优先
    candidates.sort((a, b) => b.value.length - a.value.length);
    let result = '';
    let i = 0;
    while (i < content.length) {
      if (content[i] === '@') {
        const after = content.slice(i + 1);
        let hit = null;
        for (const c of candidates) {
          if (after.startsWith(c.value)) { hit = c; break; }
        }
        if (hit) {
          result += `@${hit.to}`;
          i += 1 + hit.value.length;
          continue;
        }
      }
      result += content[i];
      i++;
    }
    return result;
  }

  /**
   * 读取房间成员（含 name）+ 用户身份，供改写工具用。
   * @param {string} roomId
   * @returns {{membersWithNames: Array, user: {uid, name}}}
   */
  _rosterForRewrite(roomId) {
    const room = this._ensureRoom(roomId);
    const cfg = room.config.read();
    const membersWithNames = (cfg?.members || []).map(agentId => ({ agentId, name: this._readAgentName(agentId) }));
    const gcfg = loadGatewayConfig();
    const user = { uid: gcfg.userUid || 'default_userid', name: gcfg.userName || 'user' };
    return { membersWithNames, user };
  }

  /** uid → 显示名（成员优先 name，回退 agentId；用户返回 userName）。失败回退 uid 本身 */
  _speakerName(uid, membersWithNames, user) {
    if (user && uid === user.uid) return user.name || uid;
    for (const m of (membersWithNames || [])) {
      if (m.agentId === uid) return m.name || m.agentId;
    }
    return uid;
  }

  /**
   * 把落盘的 uid 版消息渲染成发送给消费方（前端/agent）的 name 版。
   * - speaker（uid）→ name
   * - content 里 @uid → @name
   * - 附带 mentions（uid 列表，基于原文 uid 解析）
   * @param {object} msg - history 记录（speaker/content 为 uid 版）
   * @param {Array<{agentId,name}>} membersWithNames
   * @param {{uid,name}} user
   * @param {boolean} [withMentions=true] - 是否附带 mentions 字段
   * @returns {object} 渲染后的消息
   */
  _renderMessageForSend(msg, membersWithNames, user, withMentions = true) {
    const out = {
      ...msg,
      speaker: this._speakerName(msg.speaker, membersWithNames, user),
      content: RoomManager.rewriteMentions(msg.content, membersWithNames, user, 'name'),
    };
    if (withMentions) {
      out.mentions = RoomManager.parseMentions(msg.content, membersWithNames);
    }
    return out;
  }

  /**
   * 清空各成员在本群的记忆（调副本 /clear）。
   */
  async clearMemberMemory(roomId) {
    const room = this._ensureRoom(roomId);
    const cfg = room.config.read();
    if (!cfg?.members?.length) return;
    const results = await Promise.all(cfg.members.map(async (agentId) => {
      let ok = false;
      let reason = null;
      // 1) 取 port：内存态优先，缺失(gateway 重启后)回退落盘 run.json（问题2）
      let port = room.members.get(agentId)?.port;
      if (!port) {
        const rec = this.registry.read(roomId, agentId);
        port = rec?.port || null;
      }
      // 2) 有 port → 调副本 /clear；不可达/非 200 走删盘兜底
      if (port) {
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/clear`, { method: 'POST', signal: AbortSignal.timeout(5000) });
          if (resp.ok) {
            ok = true;
            logger.info(`清理记忆成功 ${roomId}/${agentId} (副本 /clear)`);
          } else {
            reason = `http-${resp.status}`;
            logger.warn(`清理记忆 ${roomId}/${agentId}: 副本 /clear 返回 ${resp.status},转删盘兜底`);
          }
        } catch (err) {
          reason = err.message;
          logger.warn(`清理记忆 ${roomId}/${agentId}: 副本不可达(${err.message}),转删盘兜底`);
        }
      } else {
        reason = 'no-port';
      }
      // 3) 兜底：副本未确认清理 → 直接清记忆本体。v3 记忆目录 = chat/<agentId>/<rid>/（context+tool-results）。
      //    旧 rooms/<rid>/data/<agentId>/ 已废；此处整目录删（context/tool-results 一起）。
      if (!ok) {
        const chatRoot = this.chatRoot;
        const dataDir = path.join(chatRoot, agentId, roomId);
        const ctxFile = path.join(dataDir, 'context.json');
        try {
          if (fs.existsSync(ctxFile)) {
            fs.writeFileSync(ctxFile, '[]', 'utf-8');
            ok = true;
            logger.info(`清理记忆成功 ${roomId}/${agentId} (删盘兜底 context.json)`);
          } else if (port) {
            // 端口活着但无 context.json(to-string 新副本) → 视为已清
            ok = true;
          }
        } catch (err) {
          reason = `del-context:${err.message}`;
          logger.error(`删 context.json 失败 ${roomId}/${agentId}: ${err.message}`);
        }
        // tool-results 目录一并清(对齐副本 /clear 的 _cleanupToolResults)
        const trDir = path.join(dataDir, 'tool-results');
        try { if (fs.existsSync(trDir)) fs.rmSync(trDir, { recursive: true, force: true }); }
        catch (e) { /* ignore */ }
      }
      return ok ? { agentId, ok: true } : { agentId, ok: false, reason: reason || 'unknown' };
    }));
    const failed = results.filter(r => !r.ok);
    if (failed.length) {
      logger.warn(`清理记忆完成 ${roomId}: ${results.length - failed.length}/${results.length} 成功,失败: ${failed.map(f => `${f.agentId}(${f.reason})`).join(', ')}`);
    } else {
      logger.info(`清理记忆完成 ${roomId}: 全部 ${results.length} 个成员成功`);
    }
  }
}

export { MEMBER_STATUS };