/**
 * Checkpoint 元信息纯函数(无 gateway/engine 依赖,供 gateway/snapshot.js 与
 * shared/checkpoint_restore.js 共用,避免 seq 排序逻辑两处实现而漂移)。
 *
 * seq 权威 = meta.seq(创建时入栈分配、单调);老数据无 seq 退化为 createdAt 毫秒。
 */
import fs from 'fs';
import path from 'path';

/** 读 cpDir/meta.json,失败/缺失返回 null。 */
export function readCpMeta(cpDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cpDir, 'meta.json'), 'utf-8'));
  } catch (e) {
    console.warn(`[checkpoint-meta] 读 ${cpDir}/meta.json 失败: ${e.message}`);
    return null;
  }
}

/** checkpoint 栈序号:meta.seq 权威,缺则 createdAt 毫秒,再缺 0。 */
export function seqOf(meta) {
  if (meta && typeof meta.seq === 'number') return meta.seq;
  if (meta && meta.createdAt) {
    const t = Date.parse(meta.createdAt);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/** 读 cpDir 的栈序号(列表排序/滑窗淘汰/rewind 出栈删统一用此,不再用毫秒墙钟)。 */
export function cpSeq(cpDir) {
  return seqOf(readCpMeta(cpDir));
}

/**
 * 列出 checkpointsRoot 下所有 checkpoint 目录,按 seq 升序(最旧在前)。
 * @returns {Array<{cpDir: string, meta: object|null, seq: number}>}
 */
export function listCheckpointDirs(checkpointsRoot) {
  if (!fs.existsSync(checkpointsRoot)) return [];
  const entries = fs.readdirSync(checkpointsRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const cpDir = path.join(checkpointsRoot, e.name);
      const meta = readCpMeta(cpDir);
      return { cpDir, meta, seq: seqOf(meta) };
    });
  entries.sort((a, b) => a.seq - b.seq);
  return entries;
}