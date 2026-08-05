/**
 * Gateway 插件加载器
 *
 * 启动时扫描 agents/{id}/ui/api.js，将 agent 专属 API 路由注册到 Express app。
 * 从此每个 agent 可携带自己的后端路由，不再写死在 gateway/server.js。
 *
 * 加载时机：在 createGatewayApp 内顺序调用，保证 agent 路由先于 fallback 注册。
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const logger = console; // 复用 gateway logger，无额外依赖

/**
 * 注册所有 agent 的专属 API 路由
 * @param {express.Application} app
 * @param {object} pm - ProcessManager 实例
 * @param {string} agentsDir - agent 目录（如 profiles/agents）
 */
export async function registerAgentAPIs(app, pm, agentsDir) {
  if (!fs.existsSync(agentsDir)) return;
  let count = 0;

  for (const agentId of fs.readdirSync(agentsDir)) {
    const agentDir = path.join(agentsDir, agentId);
    if (!fs.statSync(agentDir).isDirectory()) continue;

    const apiPath = path.join(agentDir, 'ui', 'api.js');
    if (!fs.existsSync(apiPath)) continue;

    try {
      const mod = await import(pathToFileURL(apiPath).href);
      const registerFn = mod.default || mod;
      if (typeof registerFn !== 'function') {
        logger.warn(`[plugin-loader] ${agentId} api.js 未导出函数`);
        continue;
      }

      const routes = registerFn(pm, agentId);
      if (!Array.isArray(routes)) {
        logger.warn(`[plugin-loader] ${agentId} api.js register() 未返回数组`);
        continue;
      }

      for (const r of routes) {
        const method = r.method.toLowerCase();
        const routePath = `/agents/${agentId}${r.path}`;
        // 中间件：检查 agent 存在（复用 gateway 逻辑）
        const checkAgent = (req, res, next) => {
          if (!pm.hasAgent(agentId)) {
            return res.status(404).json({ error: 'Agent not found' });
          }
          next();
        };
        app[method](routePath, checkAgent, r.handler);
        logger.log(`[plugin-loader] ${method.toUpperCase()} ${routePath} ← ${agentId}`);
      }
      count++;
    } catch (e) {
      logger.error(`[plugin-loader] 加载 ${agentId} api.js 失败: ${e.message}`);
    }
  }

  logger.log(`[plugin-loader] 已加载 ${count} 个 agent API 模块`);
  return count;
}