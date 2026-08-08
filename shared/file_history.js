/**
 * Rewind 文件轴 —— Edit/Write 改过的文件快照与回退（方案 A，复刻 CC v2.1.209 file-history）
 *
 * 设计见 docs/rewind-file-axis-design.md。机制三件：
 *   ① track     Edit/Write 写盘前抓"改前内容"备份（同轮只存第一次），塞进当前轮 checkpoint 的
 *                trackedFileBackups（对应 CC t5e/vvu）。
 *   ② makeSnapshot 每条 user 消息（snapshotBeforeSend）把【所有】追踪文件当前内容重抓一张自包含
 *                快照；未变复用旧 backup（对应 CC s0t/PJn）。这是方案 A 正确性的来源：边界重抓捕捉到
 *                Bash 等外部改动，回退能精确还原到"那句话之前"。
 *   ③ restore   rewindTo 取目标那张逐文件覆盖回 backup：null→unlink、变了→copyFile（对应 CC Q4r/sCg）。
 *
 * 落点：dataDir（= agentRoomState(agentId,roomId)）下
 *   dataDir/file-history/<sha16>@vN   备份本体（内容未变则复用，不重复拷）
 *   dataDir/file-history.json         注册表 { trackedFiles:[absPath], snapshots:[{cpId,seq,trackedFileBackups}] }
 *
 * 责任边界：通用 agent（engine/tools Edit/Write）才走这里。elf-018 自有 tools 写 dataDir/runtime/lore，
 *   已被 snapshot.js 整目录快照覆盖，不经此模块 → registry 永不创建 → makeSnapshot/restore 安全空跑。
 *
 * 全部 sync fs（与 gateway/snapshot.js 一致；in-process 且调用串行，无并发竞态）。
 * 不抛错：快照是可选增强，失败 log 后降级，绝不阻断用户的 Edit/Write。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from './logger.js';
import { listCheckpointDirs } from './checkpoint_meta.js';

const logger = createLogger('file-history', 'gateway.log');

// ── 路径 ──

function _regPath(dataDir) { return path.join(dataDir, 'file-history.json'); }
function _backupsDir(dataDir) { return path.join(dataDir, 'file-history'); }
function _checkpointsRoot(dataDir) { return path.join(dataDir, 'checkpoints'); }

/** 备份文件名：<filePath 的 sha16>@vN（CC cCg）。不同文件路径不撞；同文件按 version 区分内容版本。 */
function _backupName(filePath, version) {
  const h = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  return `${h}@v${version}`;
}

// ── 注册表读写 ──

function _initRegistry() {
  return { trackedFiles: [], snapshots: [], snapshotSequence: 0 };
}

function readRegistry(dataDir) {
  try {
    const raw = fs.readFileSync(_regPath(dataDir), 'utf-8');
    const reg = JSON.parse(raw);
    if (!Array.isArray(reg.trackedFiles)) reg.trackedFiles = [];
    if (!Array.isArray(reg.snapshots)) reg.snapshots = [];
    return reg;
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`读 file-history 注册表失败 (${dataDir}): ${e.message}`);
    return null; // 不存在/损坏 → 视为无注册表（首次或被清）
  }
}

function _writeRegistry(dataDir, reg) {
  try {
    fs.writeFileSync(_regPath(dataDir), JSON.stringify(reg, null, 2), 'utf-8');
  } catch (e) {
    logger.warn(`写 file-history 注册表失败 (${dataDir}): ${e.message}`);
  }
}

// ── 备份本体操作（CC vvu / PJn / dCg）──

/** 抓 filePath 当前内容到 file-history/<name>。文件不存在 → {backupFileName:null,version}（=新建文件的"改前空"）。 */
function _makeBackup(dataDir, filePath, version) {
  if (!fs.existsSync(filePath)) return { backupFileName: null, version };
  const name = _backupName(filePath, version);
  const dest = path.join(_backupsDir(dataDir), name);
  try {
    fs.mkdirSync(_backupsDir(dataDir), { recursive: true });
    fs.copyFileSync(filePath, dest);
  } catch (e) {
    logger.warn(`备份失败 (${filePath}): ${e.message}`);
    return { backupFileName: null, version }; // 退化为"无备份"，rewind 不动该文件
  }
  return { backupFileName: name, version };
}

/** origin(filePath) 是否相对 backup 改变（CC PJn/aCg：stat 快路径 + 内容比对兜底）。true=变了需还原。 */
function _originChanged(dataDir, filePath, backupEntry) {
  if (!backupEntry || backupEntry.backupFileName === null) return true; // 无备份（新建文件空版）→ 非空即"变"
  const bpath = path.join(_backupsDir(dataDir), backupEntry.backupFileName);
  let o = null, i = null;
  try { o = fs.statSync(filePath); } catch (e) { if (e.code !== 'ENOENT') { /* fallthrough */ } }
  try { i = fs.statSync(bpath); } catch (e) { if (e.code !== 'ENOENT') { /* fallthrough */ } }
  if ((o === null) !== (i === null)) return true;   // 一方缺失 → 变了
  if (o === null || i === null) return false;       // 都缺 → 视为未变（无可比对）
  if (o.size !== i.size) return true;
  if (o.mtimeMs < i.mtimeMs) return false;          // origin 早于 backup → 未动过（CC aCg mtime 快路径）
  try {
    return fs.readFileSync(filePath, 'utf-8') !== fs.readFileSync(bpath, 'utf-8');
  } catch (e) {
    return true;
  }
}

/** backup → origin 覆盖（CC dCg）。 */
function _applyBackup(dataDir, filePath, backupEntry) {
  const bpath = path.join(_backupsDir(dataDir), backupEntry.backupFileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.copyFileSync(bpath, filePath);
}

// ── 注册表查询 ──

/** 栈顶（最新）checkpoint 的 id；无 checkpoint 返回 null。track 用它定位"当前轮"。 */
function _latestCpId(dataDir) {
  const list = listCheckpointDirs(_checkpointsRoot(dataDir)); // seq 升序，末尾最新
  if (!list.length) return null;
  return path.basename(list[list.length - 1].cpDir);
}

/** 栈顶 checkpoint 的 seq（track 懒建 snapshot 时用，保证 pop-by-seq 一致）。 */
function _latestCpSeq(dataDir) {
  const list = listCheckpointDirs(_checkpointsRoot(dataDir));
  if (!list.length) return null;
  return list[list.length - 1].seq;
}

/** 文件 filePath 在注册表里最近的 backup 记录（自顶向下首个命中）。无 → undefined。 */
function _latestBackupFor(reg, filePath) {
  for (let i = reg.snapshots.length - 1; i >= 0; i--) {
    const b = reg.snapshots[i].trackedFileBackups[filePath];
    if (b) return b;
  }
  return undefined;
}

// ── 对外三件 + 清理 ──

/**
 * 写前钩子：Edit/Write 写盘前调。把 filePath 改前内容备份塞进当前轮 checkpoint 的 trackedFileBackups。
 * 同轮同一文件第二次起跳过（只存第一次改前）。无 checkpoint/无 dataDir → 安全跳过。
 */
export function track(dataDir, filePath) {
  if (!dataDir || !filePath) return;
  const curCpId = _latestCpId(dataDir);
  if (!curCpId) return; // 当前无 checkpoint（非对话中编辑）→ 无处挂载，跳过
  const reg = readRegistry(dataDir) || _initRegistry();
  let top = reg.snapshots[reg.snapshots.length - 1];
  if (!top || top.cpId !== curCpId) {
    // makeSnapshot 没跑过这轮（trackedFiles 曾空 / 首次编辑）→ 懒建一张当前轮 snapshot
    top = { cpId: curCpId, seq: _latestCpSeq(dataDir) ?? 0, trackedFileBackups: {} };
    reg.snapshots.push(top);
  }
  if (top.trackedFileBackups[filePath]) return; // 同轮已存改前 → 不覆盖
  const prev = _latestBackupFor(reg, filePath);
  const reuse = prev && prev.backupFileName !== null && !_originChanged(dataDir, filePath, prev);
  const backup = reuse ? prev : _makeBackup(dataDir, filePath, prev ? prev.version + 1 : 1);
  top.trackedFileBackups[filePath] = backup;
  if (!reg.trackedFiles.includes(filePath)) reg.trackedFiles.push(filePath);
  _writeRegistry(dataDir, reg);
}

/**
 * snapshotBeforeSend 内调：为 cpId 推一张自包含快照，把所有追踪文件当前内容重抓（未变复用）。
 * 这是方案 A 的边界重抓 —— 捕捉 Bash 等外部改动，保证 rewind 精确还原到该 checkpoint 边界。
 * 无注册表 / 无追踪文件（还没人编辑过文件）→ 跳过（首次编辑由 track 懒建）。
 */
export function makeSnapshot(dataDir, cpId, seq) {
  const reg = readRegistry(dataDir);
  if (!reg || reg.trackedFiles.length === 0) return; // 首轮或 elf-018：无文件可抓
  const top = { cpId, seq: seq ?? 0, trackedFileBackups: {} };
  for (const filePath of reg.trackedFiles) {
    const prev = _latestBackupFor(reg, filePath);
    const reuse = prev && prev.backupFileName !== null && !_originChanged(dataDir, filePath, prev);
    top.trackedFileBackups[filePath] = reuse ? prev : _makeBackup(dataDir, filePath, prev ? prev.version + 1 : 1);
  }
  reg.snapshots.push(top);
  reg.snapshotSequence = (reg.snapshotSequence ?? 0) + 1;
  _writeRegistry(dataDir, reg);
}

/**
 * rewindTo 内调：把目标 checkpoint 的 trackedFileBackups 还原回磁盘，并弹出 seq≥targetSeq 的 snapshot。
 * 无注册表 / 目标无 snapshot → 空跑（无文件可还原，如 elf-018 或目标早于首次编辑）。
 * @param {boolean} [options.applyFiles=true] - false=只回退对话不覆盖文件（保留当前代码），但仍弹栈。
 *   弹栈照常：对话栈与文件栈按 cpId/seq 耦合，"只对话"只是跳过文件覆盖，truncate 与"对话+文件"一致。
 * @returns {{ filesChanged: string[] }}
 */
export function restore(dataDir, targetCpId, targetSeq, { applyFiles = true } = {}) {
  const reg = readRegistry(dataDir);
  if (!reg) return { filesChanged: [] };
  const target = reg.snapshots.find(s => s.cpId === targetCpId);
  const filesChanged = [];
  if (target && applyFiles) {
    for (const [filePath, b] of Object.entries(target.trackedFileBackups)) {
      try {
        if (b.backupFileName === null) {
          // 快照时该文件不存在 → 还原成"没有它"
          if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); filesChanged.push(filePath); }
        } else if (_originChanged(dataDir, filePath, b)) {
          _applyBackup(dataDir, filePath, b); filesChanged.push(filePath);
        }
        // else 未变 → 跳过（省冗余写）
      } catch (e) {
        logger.warn(`还原 ${filePath} 失败: ${e.message}`);
      }
    }
  }
  // 弹出 seq >= targetSeq（含 target 本身，与 rewindTo 删 checkpoint 目录同步）——不论 applyFiles 都弹
  const tseq = targetSeq ?? (target ? target.seq : null);
  if (tseq !== null) {
    const before = reg.snapshots.length;
    reg.snapshots = reg.snapshots.filter(s => (s.seq ?? 0) < tseq);
    if (reg.snapshots.length !== before) _writeRegistry(dataDir, reg);
  }
  _pruneOrphanBackups(dataDir, reg);
  return { filesChanged };
}

/**
 * 该 checkpoint 回退【会不会动文件】——供前端决定要不要弹"对话+文件 / 只对话"二选一。
 * true = 至少一个追踪文件当前≠快照（会被覆盖）或有 null 备份且文件现存（会被删）。
 * 无注册表 / 该 cp 无 snapshot → false（如 elf-018 或目标早于首次编辑）。
 */
export function snapshotWouldChangeFiles(dataDir, cpId) {
  const reg = readRegistry(dataDir);
  if (!reg) return false;
  const snap = reg.snapshots.find(s => s.cpId === cpId);
  if (!snap) return false;
  for (const [filePath, b] of Object.entries(snap.trackedFileBackups)) {
    if (b.backupFileName === null) {
      if (fs.existsSync(filePath)) return true;   // 会删
    } else if (_originChanged(dataDir, filePath, b)) {
      return true;                                  // 会覆盖
    }
  }
  return false;
}

/** clearCheckpoints 调：删 file-history.json + file-history/ 目录。 */
export function clearFileHistory(dataDir) {
  if (!dataDir) return;
  try { fs.rmSync(_regPath(dataDir), { force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(_backupsDir(dataDir), { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * _evictOld 后调：丢掉 checkpoint 目录已不存在的 snapshot（滑窗淘汰的旧 cp），并删无人引用的 backup。
 */
export function onCheckpointsEvicted(dataDir) {
  const reg = readRegistry(dataDir);
  if (!reg) return;
  const root = _checkpointsRoot(dataDir);
  const surviving = new Set(listCheckpointDirs(root).map(e => path.basename(e.cpDir)));
  const before = reg.snapshots.length;
  reg.snapshots = reg.snapshots.filter(s => surviving.has(s.cpId));
  if (reg.snapshots.length !== before) _writeRegistry(dataDir, reg);
  _pruneOrphanBackups(dataDir, reg);
}

/** 删 file-history/ 里不被任何现存 snapshot 引用的 backup 文件（CC nCg）。 */
function _pruneOrphanBackups(dataDir, reg) {
  const dir = _backupsDir(dataDir);
  if (!fs.existsSync(dir) || !reg) return;
  const referenced = new Set();
  for (const s of reg.snapshots) {
    for (const b of Object.values(s.trackedFileBackups)) {
      if (b && b.backupFileName) referenced.add(b.backupFileName);
    }
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!referenced.has(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch (e) { /* ignore */ }
}
