/**
 * Checkpoint 还原(整份覆盖 runtime/tool-results/sync_cursor)——供 agent 进程在
 * abort/弃轮时把运行时产物回退到最近 checkpoint(pre-round)状态。
 *
 * 与 gateway/snapshot.js#rewindTo 的差异:不碰 context.json / room-history(由
 * MessageManager.rewindToLastUser 与 gateway SSE 层分别处理),也不出栈 checkpoint
 * (保留 pre-round 快照供后续 ⟲ rewind)。seq 选取复用 shared/checkpoint_meta.js,避免漂移。
 *
 * 安全约定:runtime / tool-results 两个子目录**只在 cp 侧存在时才 rm live 再 copy**
 * (比 rewindTo 的无条件 rm 更保守),杜绝 cp 缺该子目录却把 live 清空的爆删。
 */
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { listCheckpointDirs } from './checkpoint_meta.js';

const logger = createLogger('checkpoint_restore', 'gateway.log');

/** 递归拷贝目录 */
function _copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) _copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/** 删除目录(递归,不存在则跳过) */
function _rmDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * 最近一个 checkpoint 目录(seq 最大),无则 null。
 * @param {string} dataDir - agent 记忆目录(profiles/agents/<id>/memory)
 * @returns {string|null}
 */
export function findLatestCheckpoint(dataDir) {
  if (!dataDir) return null;
  const dirs = listCheckpointDirs(path.join(dataDir, 'checkpoints'));
  return dirs.length ? dirs[dirs.length - 1].cpDir : null;
}

/**
 * 从 checkpoint 整份还原 runtime/tool-results/sync_cursor(不碰 context.json/room-history)。
 * runtime、tool-results:cp 存在才 rm live 再 copy(防爆删);sync_cursor:cp 存在则 copy。
 * @returns {{ runtime: boolean, toolResults: boolean, syncCursor: boolean }}
 */
export function restoreRuntimeFromCheckpoint(dataDir, cpDir) {
  const result = { runtime: false, toolResults: false, syncCursor: false };
  if (!dataDir || !cpDir || !fs.existsSync(cpDir)) return result;

  // runtime/(lore/outline/scene 等 DM 产物)
  const cpRuntime = path.join(cpDir, 'runtime');
  const liveRuntime = path.join(dataDir, 'runtime');
  if (fs.existsSync(cpRuntime) && fs.statSync(cpRuntime).isDirectory()) {
    _rmDir(liveRuntime);
    _copyDir(cpRuntime, liveRuntime);
    result.runtime = true;
  } else {
    logger.warn(`[restore] cp 缺 runtime/,跳过(保留 live): ${cpDir}`);
  }

  // tool-results/(先清空再拷入,删掉快照后的孤儿产物)
  const cpToolResults = path.join(cpDir, 'tool-results');
  const liveToolResults = path.join(dataDir, 'tool-results');
  if (fs.existsSync(cpToolResults) && fs.statSync(cpToolResults).isDirectory()) {
    _rmDir(liveToolResults);
    _copyDir(cpToolResults, liveToolResults);
    result.toolResults = true;
  } else {
    logger.warn(`[restore] cp 缺 tool-results/,跳过(保留 live): ${cpDir}`);
  }

  // sync_cursor.json(cp 存在则覆盖,缺则不动)
  const cpSyncCursor = path.join(cpDir, 'sync_cursor.json');
  const liveSyncCursor = path.join(dataDir, 'sync_cursor.json');
  if (fs.existsSync(cpSyncCursor)) {
    fs.copyFileSync(cpSyncCursor, liveSyncCursor);
    result.syncCursor = true;
  }

  logger.info(`[restore] dataDir=${path.basename(dataDir)} cp=${path.basename(cpDir)} → ${JSON.stringify(result)}`);
  return result;
}