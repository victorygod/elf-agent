/**
 * Rewind 快照包模块（整文件替换回退）
 *
 * 设计见 docs/rewind-design.md A.3-A.5。
 * 快照包 = 用户发消息「之前」的 data/ 会话状态整份副本：
 *   data/checkpoints/<checkpointId>/
 *     meta.json          { id, createdAt, prompt, restoredPrompt }
 *     context.json       快照时刻整份
 *     history.jsonl      快照时刻整份
 *     tool-results/      快照时刻整份（仅 Elf-002 等落盘 tool-result 的 agent 才有）
 *
 * 回退 = 把某个快照包整份覆盖回 data/，删掉其后所有快照包。
 * 全部责任在 gateway，agent 仅被动 /reload 内存。
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('snapshot', 'gateway.log');

/** 快照包保留上限（滑窗淘汰最旧的） */
const MAX_CHECKPOINTS = 10;

function _rand4() {
  return Math.random().toString(16).slice(2, 6);
}

/** data 目录路径 */
function _dataDir(agentsDir, agentId) {
  return path.join(agentsDir, agentId, 'data');
}

/** checkpoints 根目录 */
function _checkpointsDir(agentsDir, agentId) {
  return path.join(_dataDir(agentsDir, agentId), 'checkpoints');
}

/** 递归拷贝目录 */
function _copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      _copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/** 删除目录（递归，不存在则跳过） */
function _rmDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 在用户发消息前打一个快照包（说话前状态）
 * 必须在写 user 进 history.jsonl 之前调用。
 * @param {string} agentsDir
 * @param {string} agentId
 * @param {string} prompt - 本轮用户消息全文（菜单标题 + 回填输入框）
 * @param {string} [roomHistoryPath] - v3 私聊房 history 路径（rooms/chat-<id>/history.jsonl），
 *        传入则一并快照（与 memory 三件套同进同出），rewind 时同步恢复。
 * @returns {string|null} checkpointId，失败返回 null
 */
export function snapshotBeforeSend(agentsDir, agentId, prompt, roomHistoryPath) {
  const dataDir = _dataDir(agentsDir, agentId);
  const contextFile = path.join(dataDir, 'context.json');
  const jsonlFile = path.join(dataDir, 'history.jsonl');
  const toolResultsDir = path.join(dataDir, 'tool-results');

  // 没有任何会话数据，不打快照（首次对话前）
  const hasContext = fs.existsSync(contextFile);
  const hasJsonl = fs.existsSync(jsonlFile);
  if (!hasContext && !hasJsonl) {
    logger.info(`[snapshot 跳过 ${agentId}] 无 context.json/history.jsonl（首次对话前不打快照）`);
    return null;
  }

  const beforeCount = listCheckpoints(agentsDir, agentId).length;
  const cpId = `cp_${Date.now()}_${_rand4()}`;
  const cpDir = path.join(_checkpointsDir(agentsDir, agentId), cpId);
  fs.mkdirSync(cpDir, { recursive: true });
  logger.info(`[snapshot 开始 ${agentId}] 打快照前磁盘 ${beforeCount} 个；新建 ${cpId}；源存在 context=${hasContext} jsonl=${hasJsonl} tool-results=${fs.existsSync(toolResultsDir)}；prompt="${(prompt || '').slice(0, 30)}"`);

  try {
    if (hasContext) fs.copyFileSync(contextFile, path.join(cpDir, 'context.json'));
    if (hasJsonl) fs.copyFileSync(jsonlFile, path.join(cpDir, 'history.jsonl'));
    if (fs.existsSync(toolResultsDir) && fs.statSync(toolResultsDir).isDirectory()) {
      _copyDir(toolResultsDir, path.join(cpDir, 'tool-results'));
    }
    // v3 私聊房 history（rooms/chat-<id>/history.jsonl）一并快照（单独命名 room-history.jsonl 与 memory history 区分）
    if (roomHistoryPath && fs.existsSync(roomHistoryPath)) {
      fs.copyFileSync(roomHistoryPath, path.join(cpDir, 'room-history.jsonl'));
    }
    fs.writeFileSync(
      path.join(cpDir, 'meta.json'),
      JSON.stringify(
        { id: cpId, createdAt: new Date().toISOString(), prompt, restoredPrompt: prompt },
        null,
        2
      ),
      'utf-8'
    );
    // 滑窗淘汰：超过上限删掉最旧的快照包
    _evictOld(agentsDir, agentId);
    return cpId;
  } catch (err) {
    logger.error(`打快照失败 (${agentId}): ${err.message}`);
    _rmDir(cpDir); // 失败回滚，避免留半截快照
    return null;
  }
}

/** 滑窗淘汰：保留最近 MAX_CHECKPOINTS 个，删掉更旧的 */
function _evictOld(agentsDir, agentId) {
  const root = _checkpointsDir(agentsDir, agentId);
  if (!fs.existsSync(root)) return;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const cpDir = path.join(root, e.name);
      return { name: e.name, ts: _cpTimestamp(cpDir), cpDir };
    })
    .sort((a, b) => b.ts - a.ts); // 新→旧
  for (let i = MAX_CHECKPOINTS; i < dirs.length; i++) {
    _rmDir(dirs[i].cpDir);
  }
}

/** 把 checkpoint 列表格式化成紧凑字符串（idx|createdAt|prompt 摘要），用于诊断日志 */
function _fmtList(list) {
  return list.map((c, i) => `\n    [${i}] ${c.id} ${c.createdAt || '(no-ts)'} "${(c.prompt || '').slice(0, 24)}"`).join('');
}

/**
 * 读 meta.json
 */
function _readMeta(cpDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cpDir, 'meta.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/** 快照创建时间（用于排序） */
function _cpTimestamp(cpDir) {
  const m = _readMeta(cpDir);
  return m?.createdAt ? Date.parse(m.createdAt) : 0;
}

/**
 * 列出所有快照包（按 createdAt 升序，最旧在前）
 * @returns {Array<{ id, createdAt, prompt }>}
 */
export function listCheckpoints(agentsDir, agentId) {
  const root = _checkpointsDir(agentsDir, agentId);
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const cpDir = path.join(root, e.name);
      const meta = _readMeta(cpDir);
      return meta
        ? { id: meta.id, createdAt: meta.createdAt, prompt: meta.prompt }
        : { id: e.name, createdAt: null, prompt: null };
    });
  entries.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return ta - tb;
  });
  return entries;
}

/**
 * 解析「最近一个 checkpoint」的 id（空输入框双击 Esc / 回退按钮默认动作）
 */
export function latestCheckpointId(agentsDir, agentId) {
  const list = listCheckpoints(agentsDir, agentId);
  return list.length ? list[list.length - 1].id : null;
}

/**
 * 回退到指定 checkpoint：整文件替换 + 删其后快照包
 * @param {string} agentsDir
 * @param {string} agentId
 * @param {string} [checkpointId] - 省略 = 最近一个
 * @returns {{ ok: boolean, restoredPrompt: string|null, error?: string }}
 */
export function rewindTo(agentsDir, agentId, checkpointId, roomHistoryPathOpt) {
  const list = listCheckpoints(agentsDir, agentId);
  logger.info(`[rewindTo 入口 ${agentId}] checkpointId=${checkpointId || '(latest)'} 删除前现有 ${list.length} 个快照包: ${_fmtList(list)}`);
  if (list.length === 0) return { ok: false, restoredPrompt: null, error: 'no checkpoint' };

  const idx = checkpointId
    ? list.findIndex(c => c.id === checkpointId)
    : list.length - 1;
  logger.info(`[rewindTo 解析目标 ${agentId}] 传入 id 在升序列表中的 idx=${idx}（升序列表末尾即最近一项，idx=${list.length - 1}）`);
  if (idx < 0) return { ok: false, restoredPrompt: null, error: 'checkpoint not found' };

  const target = list[idx];
  const targetTs = target.createdAt ? Date.parse(target.createdAt) : 0;
  logger.info(`[rewindTo 目标 ${agentId}] 目标项 idx=${idx} id=${target.id} createdAt=${target.createdAt} ts=${targetTs} prompt="${(target.prompt || '').slice(0, 30)}"`);

  const root = _checkpointsDir(agentsDir, agentId);
  const targetCpDir = path.join(root, list[idx].id);
  const meta = _readMeta(targetCpDir);
  if (!meta) return { ok: false, restoredPrompt: null, error: 'checkpoint meta missing' };

  const dataDir = _dataDir(agentsDir, agentId);
  const roomHistoryPath = roomHistoryPathOpt || null;
  try {
    // 1. 整份覆盖 context.json
    const cpContext = path.join(targetCpDir, 'context.json');
    if (fs.existsSync(cpContext)) {
      fs.copyFileSync(cpContext, path.join(dataDir, 'context.json'));
    }
    // 2. 整份覆盖 history.jsonl
    const cpJsonl = path.join(targetCpDir, 'history.jsonl');
    const liveJsonl = path.join(dataDir, 'history.jsonl');
    if (fs.existsSync(cpJsonl)) {
      fs.copyFileSync(cpJsonl, liveJsonl);
    } else {
      // 快照里没有 jsonl（首次对话前打的），清空当前 jsonl
      if (fs.existsSync(liveJsonl)) fs.writeFileSync(liveJsonl, '', 'utf-8');
    }
    // 3. 整份覆盖 tool-results/（先清空再拷入，保证删掉快照后的产物）
    const cpToolResults = path.join(targetCpDir, 'tool-results');
    const liveToolResults = path.join(dataDir, 'tool-results');
    if (fs.existsSync(liveToolResults)) _rmDir(liveToolResults);
    if (fs.existsSync(cpToolResults)) _copyDir(cpToolResults, liveToolResults);
    // 4. 整份覆盖 v3 私聊房 room-history.jsonl（快照里无则清空）
    const cpRoomHistory = path.join(targetCpDir, 'room-history.jsonl');
    if (roomHistoryPath) {
      if (fs.existsSync(cpRoomHistory)) {
        fs.copyFileSync(cpRoomHistory, roomHistoryPath);
      } else if (fs.existsSync(roomHistoryPath)) {
        fs.writeFileSync(roomHistoryPath, '', 'utf-8');
      }
    }

    // 4. 删掉该点及其之后的快照包（被回退项也删，回到「发这条消息之前」）
    //    target 关注的是「回到该点之前」，故该点本身（含 prompt 回填用的那份）一并删除；
    //    注意覆盖用的 meta.restoredPrompt 已在上文读入内存，删目录不影响返回值。
    const deletedIds = [];
    const keptIds = [];
    for (const cp of list) {
      const ts = cp.createdAt ? Date.parse(cp.createdAt) : 0;
      if (ts >= targetTs) {
        _rmDir(path.join(root, cp.id));
        deletedIds.push(cp.id);
      } else {
        keptIds.push(cp.id);
      }
    }
    const after = listCheckpoints(agentsDir, agentId);
    logger.info(`[rewindTo 删除 ${agentId}] 目标 ts=${targetTs}，判定规则 ts>=目标=删（含被回退项）。删除 ${deletedIds.length} 个: ${deletedIds.join(',') || '(无)'}；保留 ${keptIds.length} 个: ${keptIds.join(',')}`);
    logger.info(`[rewindTo 删除后回查 ${agentId}] 磁盘实际剩余 ${after.length} 个快照包: ${_fmtList(after)}`);

    return { ok: true, restoredPrompt: meta.restoredPrompt ?? meta.prompt ?? null };
  } catch (err) {
    logger.error(`rewind 失败 (${agentId}, ${checkpointId}): ${err.message}`);
    return { ok: false, restoredPrompt: null, error: err.message };
  }
}
