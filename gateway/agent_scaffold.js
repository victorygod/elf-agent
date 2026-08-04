/**
 * Agent 工厂：从独立模板创建一个白板 Agent。
 *
 * 关键约束：创建流程完全不读写 agents/elf-001。模板自包含于 gateway/agent_template/，
 * 复制后仅覆写 config.json 的 agentId/name/port 三字段。
 *
 * 新 Agent 是白板：三个 prompt 文件为空、头像留空；compactPrompt/compactSystemPrompt
 * 及运行字段（provider/tools/interaction/compactMode/memoryTokenLimit/...）来自模板（值同 elf-001）。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, 'agent_template');

/**
 * 自增生成下一个 agentId：扫 agents/ 下 elf-<N> 取最大序号 +1，补零对齐到 3 位。
 * @param {string} agentsDir
 * @returns {string} 如 elf-013
 */
function nextAgentId(agentsDir) {
  let max = 0;
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = /^elf-(\d+)$/.exec(entry.name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {
    /* agents 目录不存在则从 1 开始 */
  }
  return `elf-${String(max + 1).padStart(3, '0')}`;
}

/**
 * 递归复制目录（文件用 copyFileSync，保留原始字节）。
 * @param {string} src
 * @param {string} dest
 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 创建白板 Agent。
 * @param {object} opts
 * @param {string} opts.agentsDir - agents 根目录（pm.agentsDir）
 * @param {string} opts.name - 必填，Agent 名称
 * @returns {Promise<{ agentId: string, name: string, port: number }>}
 */
export async function createAgentFromTemplate({ agentsDir, name }) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    throw Object.assign(new Error('name 必填'), { statusCode: 400 });
  }
  if (!fs.existsSync(TEMPLATE_DIR)) {
    throw Object.assign(new Error(`模板目录不存在: ${TEMPLATE_DIR}`), { statusCode: 500 });
  }

  const agentId = nextAgentId(agentsDir);
  const targetDir = path.join(agentsDir, agentId);
  if (fs.existsSync(targetDir)) {
    throw Object.assign(new Error(`Agent 目录已存在: ${agentId}`), { statusCode: 409 });
  }

  // v4：共享 agent-server 模型下 config.port 不再用于 spawn（agent 跑在共享 server 的 agentServerPort）。
  //   保留 config.port=0 占位（兼容 config schema；standalone 直跑 agents/<id>/index.js 时 listen(0) 自分配）。
  const port = 0;

  // 从模板复制整套文件
  copyDir(TEMPLATE_DIR, targetDir);

  // 仅覆写 config.json 的三个占位字段
  const configPath = path.join(targetDir, 'config', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  config.agentId = agentId;
  config.name = trimmed;
  config.port = port;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  return { agentId, name: trimmed, port };
}