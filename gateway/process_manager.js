/**
 * Agent 进程管理器
 * 管理 Agent 子进程的生命周期：发现、启动、停止、探活
 *
 * Agent 以独立进程运行（detached spawn），与 Gateway 生命周期解耦。
 * Gateway 通过端口探测感知 Agent 状态，通过 HTTP /shutdown 控制其停止。
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('process-manager', 'gateway.log');

/** 启动后探活轮询间隔 (ms) */
const PROBE_INTERVAL = 300;
/** 启动后探活超时 (ms) */
const PROBE_TIMEOUT = 10_000;
/** 停止后确认退出轮询间隔 (ms) */
const STOP_PROBE_INTERVAL = 300;
/** 停止后确认退出超时 (ms) */
const STOP_PROBE_TIMEOUT = 5_000;
/** 强制杀死前等待间隔 (ms) */
const FORCE_KILL_DELAY = 2_000;

export class ProcessManager {
  constructor() {
    // agents: Map<agentId, { port, pid, status, config }>
    this.agents = new Map();
    this.agentsDir = path.join(process.cwd(), 'agents');
  }

  /**
   * 初始化扫描：清空 Map 后扫描 agents/ 目录
   * 首次启动时调用，此时 Map 为空，等价于全量发现
   * @returns {Promise<{ added: string[], removed: string[], unchanged: string[] }>}
   */
  async discoverAgents() {
    this.agents.clear();
    return this._scanAgents();
  }

  /**
   * 增量扫描：保留运行中的 Agent 状态，发现新增/移除/变更
   * 运行时热发现时调用
   * @returns {Promise<{ added: string[], removed: string[], unchanged: string[] }>}
   */
  async rediscoverAgents() {
    return this._scanAgents();
  }

  /**
   * 扫描 agents/ 目录的核心逻辑
   * - 移除磁盘上不存在的 Agent（如果正在运行则通过 /shutdown 停止）
   * - 新增磁盘上的 Agent
   * - 重新读取不变 Agent 的配置
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
      if (entry.isDirectory()) {
        diskAgentIds.add(entry.name);
      }
    }

    // 找出已移除的 Agent（在内存中但磁盘上不存在）
    for (const [id, agent] of this.agents) {
      if (!diskAgentIds.has(id)) {
        removed.push(id);
        // 如果正在运行，通过 HTTP 停止
        if (agent.status === 'running') {
          try {
            await this._httpShutdown(agent.port);
            logger.info(`Rediscover: 停止已移除的 Agent ${id}`);
          } catch (err) {
            logger.warn(`Rediscover: 停止已移除的 Agent ${id} 失败: ${err.message}`);
          }
        }
        this.agents.delete(id);
      } else {
        unchanged.push(id);
      }
    }

    // 发现新增的 Agent（磁盘上存在但内存中没有）
    for (const agentId of diskAgentIds) {
      if (this.agents.has(agentId)) continue;

      const configPath = path.join(this.agentsDir, agentId, 'config', 'config.json');
      try {
        const rawConfig = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(rawConfig);
        this.agents.set(agentId, {
          port: config.port,
          pid: null,
          status: 'stopped',
          config
        });
        added.push(agentId);
        logger.info(`Rediscover: 发现新 Agent: ${agentId} (port: ${config.port})`);
      } catch (err) {
        logger.warn(`Rediscover: 跳过 Agent ${agentId}: 配置解析失败 - ${err.message}`);
      }
    }

    // 对不变的 Agent 重新读取配置（名称/端口变更可生效）
    for (const id of unchanged) {
      const configPath = path.join(this.agentsDir, id, 'config', 'config.json');
      try {
        const rawConfig = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(rawConfig);
        const agent = this.agents.get(id);
        // 保留 pid/status，仅更新 config 和 port
        agent.config = config;
        agent.port = config.port;
      } catch (err) {
        logger.warn(`Rediscover: 无法重新读取 Agent ${id} 配置: ${err.message}`);
      }
    }

    logger.info(`Rediscover 完成: 新增=${added.length}, 移除=${removed.length}, 不变=${unchanged.length}`);
    return { added, removed, unchanged };
  }

  /**
   * 对 Agent 探活，并更新 PID
   * @param {string} id - Agent ID
   * @returns {Promise<boolean>} 是否存活
   */
  async probeAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) return false;

    try {
      const response = await fetch(`http://127.0.0.1:${agent.port}/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) {
        const data = await response.json();
        agent.status = 'running';
        agent.pid = data.pid || agent.pid;
        logger.info(`Agent ${id} 探活成功 (port: ${agent.port}, pid: ${agent.pid})`);
        return true;
      }
    } catch (err) {
      // 不可达
    }

    agent.status = 'stopped';
    agent.pid = null;
    return false;
  }

  /**
   * 通过 lsof 查找占用端口的进程 PID
   * @param {number} port - 端口号
   * @returns {number|null} PID 或 null
   */
  findPidFromPort(port) {
    try {
      const result = execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 5000
      }).trim();
      if (result) {
        // 取第一行（可能有多个 PID，取最相关的一个）
        const pids = result.split('\n').filter(Boolean).map(Number);
        return pids[0] || null;
      }
    } catch (err) {
      // lsof 未找到或执行失败
    }
    return null;
  }

  /**
   * 启动 Agent 进程（detached spawn，独立于 Gateway 生命周期）
   * @param {string} id - Agent ID
   * @returns {Promise<object>} Agent 信息 { agentId, status, pid }
   */
  async startAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) {
      throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
    }

    // 先探活，已运行则返回冲突
    const alive = await this.probeAgent(id);
    if (alive) {
      throw Object.assign(
        new Error(`Agent ${id} 已在运行 (pid: ${agent.pid})，请先停止再重新启动`),
        { statusCode: 409 }
      );
    }

    // 端口被其他进程占用 → 尝试查找并杀掉
    const occupiedPid = this.findPidFromPort(agent.port);
    if (occupiedPid) {
      logger.warn(`端口 ${agent.port} 被进程 PID ${occupiedPid} 占用，正在终止该进程`);
      try {
        process.kill(occupiedPid, 'SIGTERM');
        // 等待端口释放
        await this._waitForPortFree(agent.port, 3000);
        logger.info(`端口 ${agent.port} 已释放`);
      } catch (killErr) {
        // SIGTERM 失败则 SIGKILL
        try {
          process.kill(occupiedPid, 'SIGKILL');
          await this._waitForPortFree(agent.port, 2000);
        } catch (e) {
          throw Object.assign(
            new Error(`端口 ${agent.port} 被进程 PID ${occupiedPid} 占用且无法终止，请手动处理`),
            { statusCode: 409 }
          );
        }
      }
    }

    const entryFile = path.join(this.agentsDir, id, 'index.js');

    try {
      const child = spawn(process.execPath, [entryFile], {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        env: { ...process.env }
      });
      child.unref();

      // 立即标记为 running（detached 后无法追踪 PID 变化）
      agent.status = 'running';
      agent.pid = child.pid;

      logger.info(`Agent ${id} 已启动 (pid: ${child.pid})`);

      // 轮询确认 HTTP 就绪
      const probed = await this._waitForReady(id, PROBE_TIMEOUT);
      if (!probed) {
        // 超时但进程已启动，做兜底检查
        const fallbackPid = this.findPidFromPort(agent.port);
        if (fallbackPid) {
          agent.pid = fallbackPid;
          agent.status = 'running';
          logger.info(`Agent ${id} 探活超时但端口已有进程响应 (pid: ${fallbackPid})`);
        } else {
          logger.warn(`Agent ${id} 启动后探活超时，状态可能不准确`);
        }
      }

      return { agentId: id, status: agent.status, pid: agent.pid };

    } catch (err) {
      agent.status = 'error';
      logger.error(`Agent ${id} 启动失败: ${err.message}`);
      throw Object.assign(new Error(`Failed to start agent: ${err.message}`), { statusCode: 500 });
    }
  }

  /**
   * 停止 Agent 进程（通过 HTTP /shutdown 优雅关闭）
   * @param {string} id - Agent ID
   * @returns {Promise<object>} Agent 信息 { agentId, status }
   */
  async stopAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) {
      throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
    }

    // 先探活确认是否在运行
    const alive = await this.probeAgent(id);
    if (!alive) {
      throw Object.assign(new Error('Agent already stopped'), { statusCode: 409 });
    }

    // 通过 HTTP /shutdown 优雅关闭
    try {
      await this._httpShutdown(agent.port);
    } catch (err) {
      logger.warn(`Agent ${id} /shutdown 请求失败: ${err.message}，尝试强杀`);
    }

    // 轮询确认已退出
    const stopped = await this._waitForStopped(id, STOP_PROBE_TIMEOUT);
    if (!stopped) {
      // 超时，强制杀进程
      const pid = agent.pid || this.findPidFromPort(agent.port);
      if (pid) {
        logger.warn(`Agent ${id} 优雅关闭超时，强制终止进程 (pid: ${pid})`);
        try {
          process.kill(pid, 'SIGKILL');
          // 等待进程退出
          await this._waitForPortFree(agent.port, FORCE_KILL_DELAY);
        } catch (killErr) {
          logger.error(`Agent ${id} 强制终止失败: ${killErr.message}`);
        }
      }
    }

    // 再次探活确认
    await this.probeAgent(id);

    // 如果仍然 running（极端情况），强制标记为 stopped
    if (agent.status === 'running') {
      agent.status = 'stopped';
      agent.pid = null;
    }

    logger.info(`Agent ${id} 已停止`);
    return { agentId: id, status: 'stopped' };
  }

  /**
   * 获取单个 Agent 信息
   */
  getAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) return null;
    return {
      agentId: id,
      name: agent.config?.name || id,
      path: `agents/${id}`,
      port: agent.port,
      status: agent.status,
      pid: agent.pid,
      avatar: agent.config?.avatar || null,
      userAvatar: agent.config?.userAvatar || null
    };
  }

  /**
   * 列出所有 Agent
   */
  listAgents() {
    const result = [];
    for (const [id, agent] of this.agents) {
      result.push({
        agentId: id,
        name: agent.config?.name || id,
        path: `agents/${id}`,
        port: agent.port,
        status: agent.status,
        pid: agent.pid,
        avatar: agent.config?.avatar || null,
        userAvatar: agent.config?.userAvatar || null
      });
    }
    return result;
  }

  /**
   * 检查 Agent 是否存在
   */
  hasAgent(id) {
    return this.agents.has(id);
  }

  /**
   * 获取 Agent 端口
   */
  getAgentPort(id) {
    const agent = this.agents.get(id);
    return agent ? agent.port : null;
  }

  /**
   * 获取 Agent 状态
   */
  getAgentStatus(id) {
    const agent = this.agents.get(id);
    return agent ? agent.status : null;
  }

  // ─── 私有方法 ───────────────────────────────────────────

  /**
   * 发送 HTTP /shutdown 请求
   * @param {number} port
   * @returns {Promise<void>}
   */
  async _httpShutdown(port) {
    const response = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      throw new Error(`/shutdown 返回 ${response.status}`);
    }
  }

  /**
   * 轮询等待 Agent HTTP 就绪
   * @param {string} id - Agent ID
   * @param {number} timeout - 超时毫秒
   * @returns {Promise<boolean>}
   */
  async _waitForReady(id, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const alive = await this.probeAgent(id);
      if (alive) return true;
      await new Promise(resolve => setTimeout(resolve, PROBE_INTERVAL));
    }
    return false;
  }

  /**
   * 轮询等待 Agent 停止（HTTP 不可达）
   * @param {string} id - Agent ID
   * @param {number} timeout - 超时毫秒
   * @returns {Promise<boolean>} 是否确认已停止
   */
  async _waitForStopped(id, timeout) {
    const agent = this.agents.get(id);
    if (!agent) return true;

    const start = Date.now();
    while (Date.now() - start < timeout) {
      const alive = await this.probeAgent(id);
      if (!alive) return true;
      await new Promise(resolve => setTimeout(resolve, STOP_PROBE_INTERVAL));
    }
    return false;
  }

  /**
   * 等待端口释放（lsof 不再发现 LISTEN 进程）
   * @param {number} port
   * @param {number} timeout - 超时毫秒
   * @returns {Promise<void>}
   */
  async _waitForPortFree(port, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const pid = this.findPidFromPort(port);
      if (!pid) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`端口 ${port} 在 ${timeout}ms 内未释放`);
  }
}