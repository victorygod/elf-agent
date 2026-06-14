/**
 * Agent 进程管理器
 * 管理 Agent 子进程的生命周期：发现、启动、停止、重启、探活
 */

import fs from 'fs';
import path from 'path';
import { fork } from 'child_process';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('process-manager', 'gateway.log');

export class ProcessManager {
  constructor() {
    // agents: Map<agentId, { port, pid, status, childProcess, config }>
    this.agents = new Map();
    this.agentsDir = path.join(process.cwd(), 'agents');
  }

  /**
   * 扫描 agents/ 目录，发现所有 Agent
   * 读取每个子目录的 config/config.json，填充 agents Map
   */
  discoverAgents() {
    this.agents.clear();

    let entries;
    try {
      entries = fs.readdirSync(this.agentsDir, { withFileTypes: true });
    } catch (err) {
      logger.error(`无法扫描 agents 目录: ${err.message}`);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const agentId = entry.name;
      const configPath = path.join(this.agentsDir, agentId, 'config', 'config.json');

      try {
        const rawConfig = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(rawConfig);
        this.agents.set(agentId, {
          port: config.port,
          pid: null,
          status: 'stopped',
          childProcess: null,
          config
        });
        logger.info(`发现 Agent: ${agentId} (port: ${config.port})`);
      } catch (err) {
        logger.warn(`跳过 Agent ${agentId}: 配置解析失败 - ${err.message}`);
      }
    }
  }

  /**
   * 重新扫描 agents/ 目录，发现新增/变更的 Agent
   * 与 discoverAgents() 不同，此方法保留正在运行的 Agent 的 childProcess 引用
   * @returns {{ added: string[], removed: string[], unchanged: string[] }}
   */
  rediscoverAgents() {
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
        // 如果正在运行，先停止进程
        if (agent.childProcess) {
          agent.childProcess.kill();
          logger.info(`Rediscover: 停止已移除的 Agent ${id}`);
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
          childProcess: null,
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
        // 保留 childProcess/pid/status，仅更新 config 和 port
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
   * 对 Agent 探活
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
        agent.status = 'running';
        logger.info(`Agent ${id} 探活成功 (port: ${agent.port})`);
        return true;
      }
    } catch (err) {
      // 不可达
    }

    agent.status = 'stopped';
    return false;
  }

  /**
   * 启动 Agent 进程
   * @param {string} id - Agent ID
   * @returns {object} Agent 信息 { agentId, status, pid }
   */
  startAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) {
      throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
    }
    if (agent.status === 'running' && agent.childProcess) {
      throw Object.assign(new Error('Agent already running'), { statusCode: 409 });
    }

    const entryFile = path.join(this.agentsDir, id, 'index.js');

    try {
      const child = fork(entryFile, [], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      });

      agent.childProcess = child;
      agent.pid = child.pid;
      agent.status = 'running';

      // 监听子进程退出
      child.on('exit', (code, signal) => {
        agent.status = 'stopped';
        agent.pid = null;
        agent.childProcess = null;
        logger.info(`Agent ${id} 退出: code=${code}, signal=${signal}`);
      });


      logger.info(`Agent ${id} 已启动 (pid: ${child.pid})`);
      return { agentId: id, status: 'running', pid: child.pid };

    } catch (err) {
      agent.status = 'error';
      logger.error(`Agent ${id} 启动失败: ${err.message}`);
      throw Object.assign(new Error(`Failed to start agent: ${err.message}`), { statusCode: 500 });
    }
  }

  /**
   * 停止 Agent 进程
   * @param {string} id - Agent ID
   * @returns {object} Agent 信息 { agentId, status }
   */
  stopAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) {
      throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
    }
    if (agent.status !== 'running') {
      throw Object.assign(new Error('Agent already stopped'), { statusCode: 409 });
    }

    agent.childProcess?.kill();
    agent.status = 'stopped';
    agent.pid = null;
    agent.childProcess = null;

    logger.info(`Agent ${id} 已停止`);
    return { agentId: id, status: 'stopped' };
  }

  /**
   * 重启 Agent 进程
   * @param {string} id - Agent ID
   * @returns {object} Agent 信息 { agentId, status, pid }
   */
  restartAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) {
      throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
    }

    // 如果正在运行，先停止
    if (agent.status === 'running' && agent.childProcess) {
      agent.childProcess.kill();
      agent.status = 'stopped';
      agent.pid = null;
      agent.childProcess = null;
    }

    // 等一小会确保端口释放
    return new Promise((resolve) => {
      setTimeout(() => {
        try {
          const result = this.startAgent(id);
          resolve(result);
        } catch (err) {
          resolve({ agentId: id, status: 'error', pid: null });
        }
      }, 500);
    });
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
}