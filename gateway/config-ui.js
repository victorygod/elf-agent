/**
 * 配置 UI 模块
 * 返回 Agent 的配置数据。布局信息由前端从 agent 的 ui/manifest.json 获取。
 * @deprecated config-ui.json 已被 ui/manifest.json 取代，此模块仅返回配置数据。
 */
import fs from 'fs';
import path from 'path';

/**
 * 读取 Agent 的配置数据
 * @param {string} configDir - Agent 配置目录
 * @param {function} readAgentConfig - 读取配置的函数
 * @returns {{ layout: null, config: object }}
 */
export function getConfigUI(configDir, readAgentConfig) {
  const config = readAgentConfig(configDir);
  return { layout: null, config };
}