/**
 * 配置 UI 模块
 * 读取 Agent 目录下的 config-ui.json 布局描述文件，返回给前端。
 * 前端 React ConfigDrawer 根据 layout JSON 渲染配置面板。
 */
import fs from 'fs';
import path from 'path';

/**
 * 读取 Agent 的配置 UI 布局和配置数据
 * @param {string} configDir - Agent 配置目录
 * @param {function} readAgentConfig - 读取配置的函数
 * @returns {{ layout: object|null, config: object }}
 */
export function getConfigUI(configDir, readAgentConfig) {
  const layoutPath = path.join(configDir, 'config-ui.json');
  let layout = null;

  if (fs.existsSync(layoutPath)) {
    try {
      layout = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
    } catch (err) {
      // JSON 解析失败，视为无自定义布局
    }
  }

  const config = readAgentConfig(configDir);
  return { layout, config };
}