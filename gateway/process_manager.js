/**
 * Agent 进程管理器（v4：共享 agent-server 进程模型）
 *
 * 改造前：每 agent 一个独立进程（detached spawn agents/<id>/index.js），各自端口。
 * 改造后：一个共享 agent-server 进程承载 agents/* 全部 agent（engine/start.js --serve-all）。
 *   - server 进程懒起：首个 startAgent(id) 时 ensureServerUp() spawn 一次；之后 no-op。
 *   - startAgent(id) = ensureServerUp() + 标该 agent 'running'（实例首条消息才 materialize）。
 *   - stopAgent(id) = 标 'stopped'（不杀共享 server，兄弟 agent 还在用）。
 *   - 在线两层：agent.status ∈ {stopped,running,error}；server 挂时 getAgentStatus 派生 'server-down'。
 *   - 事件：仅连共享 server 一条 /events（N→1），事件按 _agentId 平铺路由（见 docs inprocess-agent-host §三/§4.2⑤）。
 * gateway 仍按 agent 为中心调用（getAgentPort(agentId) 等），server 只是 agent 身上的 port 属性。
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createLogger } from '../shared/logger.js';
import { probePort, findPidFromPort as probe_findPidFromPort, waitForReady as probe_waitForReady, httpShutdown as probe_httpShutdown, waitForPortFree as probe_waitForPortFree, PROBE_INTERVAL, STOP_PROBE_INTERVAL } from '../shared/agent_probe.js';
import { connectAgentEvents, disconnectAgentEvents, hasAgentEventsConnection } from './agent_events.js';
import { handlePrivateAgentEvent, forceFinishRoomsForAgent } from './private_room_stream.js';
import { rewindTo } from './snapshot.js';
import { loadGatewayConfig } from './config.js';

const logger = createLogger('process-manager', 'gateway.log');

/** 启动后探活超时 (ms) */
const PROBE_TIMEOUT = 10_000;
/** 停止后确认退出超时 (ms) */
const STOP_PROBE_TIMEOUT = 5_000;
/** 强制杀死前等待间隔 (ms) */
const FORCE_KILL_DELAY = 2_000;
/** 共享 server 的 /events 连接在 agent_events 中的 key（单条连接，承载全部 agent 事件） */
const SERVER_EVENTS_KEY = '__server__';
/** 停共享 server 时，确认 server 进程退出超时（比停单个 agent 长，因为有多个 agent） */
const SERVER_STOP_TIMEOUT = 8_000;

export class ProcessManager {
  constructor() {
    // agents: Map<agentId, { status: 'stopped'|'running'|'error', config }>（不再持 port/pid；那是共享 server 的）
    this.agents = new Map();
    this.agentsDir = path.join(process.cwd(), 'agents');
    // v3：privateRoomHistory 由 gateway/index.js 注入，供 _onAgentEvent 路由私聊房事件落 history。
    this.privateRoomHistory = null;
    // 端口整体偏移（测试用 ELF_PORT_OFFSET 注入）：server.port = agentServerPort + offset，与真实 gateway 端口隔离。
    this.portOffset = Number(process.env.ELF_PORT_OFFSET) || 0;
    // 共享 agent-server 进程（本期 M=1）：承载 agents/* 全部 agent。
    const gwCfg = loadGatewayConfig();
    this.server = {
      pid: null,
      port: (gwCfg.agentServerPort || 8180) + this.portOffset,
      status: 'stopped', // 'stopped' | 'running' | 'error'
      error: null,
      instanceErrors: {}, // { agentId: 原因 } —— 从 server /status 拉取，供探活区分实例级失败
    };
    // gateway base url，供 spawn 时经 --gateway-url 传给 agent-server（PrivateChatPlugin sync 用）。
    this._gatewayUrl = null;
  }

  /**
   * 初始化扫描：清空 Map 后扫描 agents/ 目录
   * @returns {Promise<{ added: string[], removed: string[], unchanged: string[] }>}
   */
  async discoverAgents() {
    this.agents.clear();
    return this._scanAgents();
  }

  /**
   * 增量扫描：保留 agent 启用状态，发现新增/移除/变更
   * @returns {Promise<{ added: string[], removed: string[], unchanged: string[] }>}
   */
  async rediscoverAgents() {
    return this._scanAgents();
  }

  /**
   * 扫描 agents/ 目录：移除磁盘不存在的 agent，新增/重读 agent config。
   * 注意：共享 server 不因单个 agent 目录增删而启停。
   * @returns {Promise<{ added: string[], removed: string[], unchanged: string[] }>}
   */
  async _scanAgents() {
    const added = [];
    const removed = [];
    const unchanged = [];

    let entries;
    try {
      entries = fs.readdirSync(this.agentsDir, { withFileTypes: true });
    } catch (err) {
      logger.error(`无法扫描 agents 目录: ${err.message}`);
      return { added, removed, unchanged };
    }

    const diskAgentIds = new Set();
    for (const entry of entries) {
      if (entry.isDirectory()) diskAgentIds.add(entry.name);
    }

    // 移除磁盘上不存在的 agent（仅清内存；共享 server 不动）
    for (const [id, agent] of this.agents) {
      if (!diskAgentIds.has(id)) {
        removed.push(id);
        this.agents.delete(id);
      } else {
        unchanged.push(id);
      }
    }

    // 新增 agent
    for (const agentId of diskAgentIds) {
      const configPath = path.join(this.agentsDir, agentId, 'config', 'config.json');
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (this.agents.has(agentId)) {
          this.agents.get(agentId).config = config; // 重读 config（名称等变更可生效）
        } else {
          this.agents.set(agentId, { status: 'stopped', config });
          added.push(agentId);
          logger.info(`Rediscover: 发现新 Agent: ${agentId}`);
        }
      } catch (err) {
        logger.warn(`Rediscover: 跳过 Agent ${agentId}: 配置解析失败 - ${err.message}`);
      }
    }

    logger.info(`Rediscover 完成: 新增=${added.length}, 移除=${removed.length}, 不变=${unchanged.length}`);
    return { added, removed, unchanged };
  }

  /**
   * 探活共享 agent-server，更新 server 状态 + 重建 /events 通道。
   * @returns {Promise<boolean>} server 是否存活
   */
  async probeServer() {
    const r = await probePort(this.server.port);
    if (r.ok) {
      this.server.status = 'running';
      this.server.pid = r.pid ?? this.server.pid;
      this.server.error = null;
      // 拉取 server /status 的实例错误表，供 getAgentStatus 区分实例级失败（§4.3）。
      this.server.instanceErrors = await this._fetchInstanceErrors();
      logger.info(`Agent-server 探活成功 (port: ${this.server.port}, pid: ${this.server.pid})`);
      // 通道跟随存活：probe 成功但 /events 通道不在时立即重建（幂等）。
      if (!hasAgentEventsConnection(SERVER_EVENTS_KEY)) {
        connectAgentEvents(SERVER_EVENTS_KEY, this.server.port, this._makeEventHandler(), this._makeDisconnectHandler());
        logger.info(`Agent-server SSE /events 通道已重建`);
      }
      return true;
    }
    // server 不可达（未起 / 崩 / 退出）：清状态 + 断 /events，避免对死端口 5s 重连死循环刷日志。
    this.server.status = 'stopped';
    this.server.pid = null;
    disconnectAgentEvents(SERVER_EVENTS_KEY);
    return false;
  }

  /**
   * 对某 agent 探活（= 共享 server 在跑 + 该 agent 已启用）。提供给仍按 agent 调用的旧调用点。
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async probeAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) return false;
    const up = await this.probeServer();
    return up && agent.status === 'running';
  }

  /**
   * 通过 lsof 查找占用端口的进程 PID
   */
  findPidFromPort(port) {
    return probe_findPidFromPort(port);
  }

  /**
   * 确保共享 agent-server 在跑（懒起：没起才 spawn 一次，已起 no-op）。
   * 所有 startAgent 共用此入口 —— 第一个 startAgent 起 server，其余仅标 enable。
   * @returns {Promise<void>} 成功无返回；失败抛错并置 server.status='error'
   */
async ensureServerUp() {
    // 串行化：并发 startAgent（典型：ensureReplicasAlive Promise.all 多成员同时 ensureAgentPresent）
    //   共享同一次 spawn，否则多路同时进 spawn 分支抢 listen 同一端口 → EADDRINUSE 竞态。
    if (this._ensureServerUpInFlight) return this._ensureServerUpInFlight;
    this._ensureServerUpInFlight = this._ensureServerUpImpl().finally(() => { this._ensureServerUpInFlight = null; });
    return this._ensureServerUpInFlight;
  }

  async _ensureServerUpImpl() {
    // 已起：快速校验一下别是僵尸（probe 一次）。
    if (this.server.status === 'running') {
      const alive = await this.probeServer();
      if (alive) return;
      // 探活失败则继续走 spawn 分支（重起）。
    }

    // 端口被占用 → 试着清掉（可能是上次崩溃残留）。
    const occupiedPid = this.findPidFromPort(this.server.port);
    if (occupiedPid) {
      logger.warn(`端口 ${this.server.port} 被进程 PID ${occupiedPid} 占用，正在终止该进程`);
      try {
        process.kill(occupiedPid, 'SIGTERM');
        await this._waitForPortFree(this.server.port, 3000);
      } catch (e) {
        try { process.kill(occupiedPid, 'SIGKILL'); await this._waitForPortFree(this.server.port, 2000); }
        catch (e2) {
          this.server.status = 'error';
          this.server.error = `端口 ${this.server.port} 被占用且无法终止 (pid ${occupiedPid})`;
          throw Object.assign(new Error(this.server.error), { statusCode: 409 });
        }
      }
    }

    const entryFile = path.join(process.cwd(), 'engine', 'start.js');
    try {
      const child = spawn(process.execPath, [entryFile, '--serve-all', '--port', String(this.server.port), '--gateway-url', this._gatewayUrl || ''], {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELF_GATEWAY_URL: this._gatewayUrl || '', ELF_INTERNAL_TOKEN: loadGatewayConfig().internalToken || '' },
      });
      child.unref();

      this.server.status = 'running'; // 乐观先标，probe 兜底
      this.server.pid = child.pid;
      this.server.error = null;
      logger.info(`Agent-server 已启动 (pid: ${child.pid}, port: ${this.server.port})`);

      // 轮询确认 HTTP 就绪
      const probed = await probe_waitForReady(this.server.port, PROBE_TIMEOUT, PROBE_INTERVAL);
      if (!probed) {
        const fallbackPid = this.findPidFromPort(this.server.port);
        if (fallbackPid) {
          this.server.pid = fallbackPid;
          this.server.status = 'running';
          logger.info(`Agent-server 探活超时但端口已有进程响应 (pid: ${fallbackPid})`);
        } else {
          this.server.status = 'error';
          this.server.error = '探活超时（端口无响应）';
          logger.warn(`Agent-server 启动后探活超时，状态可能不准确`);
        }
      }

      if (this.server.status === 'running') {
        connectAgentEvents(SERVER_EVENTS_KEY, this.server.port, this._makeEventHandler(), this._makeDisconnectHandler());
      }
    } catch (err) {
      this.server.status = 'error';
      this.server.error = err.message;
      logger.error(`Agent-server 启动失败: ${err.message}`);
      throw Object.assign(new Error(`Failed to start agent-server: ${err.message}`), { statusCode: 500 });
    }
  }

  /**
   * 启动某 agent（= 确保共享 server 在跑 + 标该 agent 'running'）。不再 spawn 该 agent 自己的进程。
   * @param {string} id - Agent ID
   * @returns {Promise<object>} { agentId, status, pid }
   */
  async startAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) {
      throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
    }
    // 已在运行（agent 启用且 server 活着）→ 409
    if (agent.status === 'running') {
      const alive = await this.probeServer();
      if (alive) {
        throw Object.assign(new Error(`Agent ${id} 已在运行 (pid: ${this.server.pid})`), { statusCode: 409 });
      }
      // server 挂了 → 落到 ensureServerUp 重起
    }

    await this.ensureServerUp();
    if (this.server.status !== 'running') {
      // 进程级失败：该 agent 标 error，错误指明是 server 起不来（§4.3 进程级 vs 实例级）。
      agent.status = 'error';
      throw Object.assign(new Error(`Agent ${id} 启动失败：agent-server 起不来 — ${this.server.error || '未知'}`), { statusCode: 503 });
    }
    agent.status = 'running';
    return { agentId: id, status: 'running', pid: this.server.pid };
  }

  /**
   * 停止某 agent（= 标 'stopped'）。**不杀共享 server**（兄弟 agent 可能还在用）。
   * 实例的下线由 gateway 侧 enable 标志门控（不再路由 observe 给 stopped agent）。
   * 要杀共享 server 进程，用 stopServer()（全局停 / cleanup）。
   * @param {string} id
   * @returns {Promise<object>} { agentId, status }
   */
  async stopAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) {
      throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
    }
    if (agent.status !== 'running') {
      throw Object.assign(new Error('Agent already stopped'), { statusCode: 409 });
    }
    agent.status = 'stopped';
    // 私聊实例语义：标 disabled（私聊 /say 已 503 挡新消息）+ 中断在飞回合。
    //   私聊实例（PrivateChatPlugin）无自驱定时器，挡住新消息 + 中断在飞即 inert；不清 memory、不 dispose RoomState（start 后可续）。
    //   群聊实例独立生命周期（群成员退订管），私聊 stop 不碰。
    //   多用户：中断该 agent 名下全部用户私聊房的在飞回合（chat-<uid>-<id> 按 agent 批量 abort）。
    if (this.server.status === 'running' && this.server.port) {
      try {
        await fetch(`http://127.0.0.1:${this.server.port}/abort-agent/${encodeURIComponent(id)}`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      } catch (e) { logger.warn(`abort-agent 失败（server 未起或无在飞回合，忽略）: ${e.message}`); }
      // gateway 侧兜底：清所有该 agent 用户房的孤儿 streaming
      forceFinishRoomsForAgent(id);
    }
    logger.info(`Agent ${id} 已停用私聊实例（inert，共享 server 保留，群聊实例不受影响）`);
    return { agentId: id, status: 'stopped' };
  }

  /**
   * 全局停共享 agent-server 进程（cleanup / 重启用）。先优雅 /shutdown，超时强杀。
   * @returns {Promise<object>}
   */
  async stopServer() {
    const alive = await this.probeServer();
    if (!alive) {
      disconnectAgentEvents(SERVER_EVENTS_KEY);
      return { status: 'stopped', wasRunning: false };
    }
    try { await this._httpShutdown(this.server.port); }
    catch (err) { logger.warn(`Agent-server /shutdown 失败: ${err.message}，尝试强杀`); }
    const stopped = await this._waitForServerStopped(SERVER_STOP_TIMEOUT);
    if (!stopped) {
      const pid = this.server.pid || this.findPidFromPort(this.server.port);
      if (pid) {
        logger.warn(`Agent-server 优雅关闭超时，强制终止 (pid: ${pid})`);
        try { process.kill(pid, 'SIGKILL'); await this._waitForPortFree(this.server.port, FORCE_KILL_DELAY); }
        catch (e) { logger.error(`Agent-server 强制终止失败: ${e.message}`); }
      }
    }
    await this.probeServer();
    if (this.server.status === 'running') { this.server.status = 'stopped'; this.server.pid = null; }
    disconnectAgentEvents(SERVER_EVENTS_KEY);
    logger.info(`Agent-server 已停止`);
    return { status: 'stopped', wasRunning: true };
  }

  /**
   * 获取共享 server 端口（agent 视角：agent 身上的 port 属性，M=1 下全 agent 共享）。
   */
  getServerPort() {
    return this.server.status === 'running' ? this.server.port : null;
  }

  /** 获取单个 Agent 信息（对外字段保持旧契约：port/pid 现指共享 server） */
  getAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) return null;
    const status = this._effectiveStatus(id, agent);
    const failure = this.getAgentFailure(id);
    return {
      agentId: id,
      name: agent.config?.name || id,
      path: `agents/${id}`,
      port: this.server.status === 'running' ? this.server.port : null,
      status,
      pid: this.server.status === 'running' ? this.server.pid : null,
      // 失败层级 + 原因（status 为 error/server-down 时有意义，区分进程级 vs 实例级，§4.3）
      failureLevel: failure.level,
      failureReason: failure.reason,
      avatar: agent.config?.avatar || null,
      userAvatar: agent.config?.userAvatar || null,
    };
  }

  /** 列出所有 Agent */
  listAgents() {
    const result = [];
    for (const [id, agent] of this.agents) {
      const failure = this.getAgentFailure(id);
      result.push({
        agentId: id,
        name: agent.config?.name || id,
        path: `agents/${id}`,
        port: this.server.status === 'running' ? this.server.port : null,
        status: this._effectiveStatus(id, agent),
        pid: this.server.status === 'running' ? this.server.pid : null,
        failureLevel: failure.level,
        failureReason: failure.reason,
        avatar: agent.config?.avatar || null,
        userAvatar: agent.config?.userAvatar || null,
      });
    }
    return result;
  }

  hasAgent(id) {
    return this.agents.has(id);
  }

  /**
   * 获取 agent 端口（agent 启用且 server 在跑 → server.port；否则 null）。
   * gateway 路由用此判：null 则不投 observe（stopped/server-down agent 不收消息）。
   */
  getAgentPort(id) {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== 'running') return null;
    return this.server.status === 'running' ? this.server.port : null;
  }

  /**
   * 获取 agent 状态（两层：server 挂时已启用的 agent 派生 'server-down'）。
   */
  getAgentStatus(id) {
    const agent = this.agents.get(id);
    if (!agent) return null;
    return this._effectiveStatus(id, agent);
  }

  /** 计算对外状态：running 但 server 挂 → 'server-down'；server 在跑但该 agent 实例化失败 → 'error'（§4.3 两层）。 */
  _effectiveStatus(id, agent) {
    if (agent.status === 'running' && this.server.status !== 'running') return 'server-down';
    if (agent.status === 'running' && this.server.instanceErrors?.[id]) return 'error';
    return agent.status;
  }

  /**
   * 返回某 agent 的失败层级与原因（供 API/前端区分 server 失败 vs 实例失败）。
   * @returns {{ level: 'server'|'agent'|null, reason: string|null }}
   */
  getAgentFailure(id) {
    const agent = this.agents.get(id);
    if (!agent) return { level: null, reason: null };
    if (this.server.status !== 'running') return { level: 'server', reason: this.server.error || 'agent-server 未运行' };
    const ie = this.server.instanceErrors?.[id];
    if (ie) return { level: 'agent', reason: ie };
    return { level: null, reason: null };
  }

  /**
   * 拉取共享 server /status 的 instanceErrors（实例化失败表）。server 不可达返回 {}。
   * @returns {Promise<object>}
   */
  async _fetchInstanceErrors() {
    try {
      const resp = await fetch(`http://127.0.0.1:${this.server.port}/status`, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) return {};
      const body = await resp.json();
      return body?.instanceErrors || {};
    } catch (e) { return {}; }
  }

  /**
   * 收到共享 server /events 通道的事件。事件已带 _agentId（见 server.js wireAgentEvents），
   *   按 _agentId / _roomId 路由——**不**按连接绑定的 id（连接是共享的，承载全部 agent）。
   * 私聊房事件（_roomId 以 chat- 开头）→ private_room_stream 转发到常驻 SSE。
   * 群聊异步事件（compact 等）无前端订阅者，仅记日志。
   */
  _onAgentEvent(event, data) {
    const aid = (data && typeof data === 'object' && typeof data._agentId === 'string') ? data._agentId : '(unknown)';
    logger.info(`[events] _onAgentEvent: agentId=${aid} event=${event}`);

    // elf-018 abort 信号:复用 ⟲ rewind 的 rewindTo(latest) —— 删本轮 user + 整份还原
    //   runtime/tool-results/sync_cursor/history + 弹 checkpoint + 返回 restoredPrompt 回填输入框。
    //   仅 elf-018 会发此信号(作用域天然锁定);时序在 aborted+done 之后,agent 已停笔无写盘竞态。
    if (event === 'abortRewind' && data && typeof data._roomId === 'string' && data._roomId.startsWith('chat-')) {
      const rid = data._roomId;
      try {
        const roomHistoryPath = this.privateRoomHistory
          ? path.join(this.privateRoomHistory.roomsDir, rid, 'history.jsonl')
          : null;
        const result = rewindTo(aid, rid, null, roomHistoryPath);
        if (result?.ok) {
          data = { ...data, restoredPrompt: result.restoredPrompt ?? null };
          const port = this.getAgentPort(aid);
          if (port) {
            fetch(`http://127.0.0.1:${port}/reload/${rid}`, { method: 'POST' })
              .catch((err) => { /* reload 失败不语义阻塞,下条消息自然重载 */ });
          }
        } else {
          logger.warn(`[abortRewind] ${aid} rewindTo 失败: ${result?.error || 'no checkpoint'},不回填`);
        }
      } catch (err) {
        logger.error(`[abortRewind] ${aid} 异常: ${err.message}`);
      }
      handlePrivateAgentEvent('abortRewind', data, this.privateRoomHistory || null);
      return;
    }

    if (data && typeof data === 'object' && typeof data._roomId === 'string' && data._roomId.startsWith('chat-')) {
      handlePrivateAgentEvent(event, data, this.privateRoomHistory || null);
      return;
    }
    if (typeof event === 'string' && event.startsWith('compact')) {
      logger.info(`[compact] ${aid} event=${event} 内部已处理，前端无订阅者，不外露`);
    }
  }

  // ─── 私有方法 ───────────────────────────────────────────

  /**
   * 构造 /events 事件转发回调（共享连接，按事件内 _agentId 路由，不绑启动时的 id）。
   */
  _makeEventHandler() {
    return (event, data) => this._onAgentEvent(event, data);
  }

  /**
   * 构造 /events 通道断开兜底：共享连接断开 → 所有启用中 agent 的私聊房若仍 streaming，强制结束回合。
   * 防「server 活着但 SSE 静默断开，done 事件发进无人接的连接」沦为孤儿 streaming。
   */
  _makeDisconnectHandler(agentId) {
    // agentId 提供（按 agent 断开）：清该 agent 名下 chat-<id> 的孤儿 streaming。
    // agentId 缺省（共享 /events 通道断开）：清所有 running agent 的孤儿 streaming（v4 共享 server 语义）。
    return () => {
      const clear = (id) => {
        // 多用户：清该 agent 名下全部用户私聊房（chat-<uid>-<id>）的孤儿 streaming
        const done = forceFinishRoomsForAgent(id);
        for (const rid of done) {
          logger.warn(`[events] Agent-server SSE 断开，强制结束孤儿 streaming room=${rid}`);
        }
      };
      if (agentId) { clear(agentId); return; }
      for (const [id, agent] of this.agents) {
        if (agent.status === 'running') clear(id);
      }
    };
  }

  /**
   * 发送 HTTP /shutdown 请求（给共享 server 端口）
   */
  async _httpShutdown(port) {
    await probe_httpShutdown(port);
  }

  /**
   * 轮询等待共享 server 停止（HTTP 不可达）
   */
  async _waitForServerStopped(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const alive = await this.probeServer();
      if (!alive) return true;
      await new Promise(resolve => setTimeout(resolve, STOP_PROBE_INTERVAL));
    }
    return false;
  }

  /**
   * 等待端口释放（lsof 不再发现 LISTEN 进程）
   */
  async _waitForPortFree(port, timeout) {
    await probe_waitForPortFree(port, timeout);
  }
}
