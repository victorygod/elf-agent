/**
 * Rewind 快照包模块（整文件替换回退）
 *
 * 设计见 docs/rewind-design.md A.3-A.5。
 * 快照包 = 用户发消息「之前」的会话状态整份副本（记忆源 profiles/agents/<id>/memory）：
 *   profiles/agents/<id>/memory/checkpoints/<checkpointId>/
 *     meta.json          { id, createdAt, prompt, restoredPrompt }
 *     context.json       快照时刻整份
 *     room-history.jsonl 私聊房 SSE 历史快照（profiles/rooms/chat-<id>/history.jsonl）
 *     tool-results/      快照时刻整份（仅 Elf-002 等落盘 tool-result 的 agent 才有）
 *
 * 回退 = 把某个快照包整份覆盖回 memory/（记忆）+ roomHistoryPath（房历史），删掉其后所有快照包。
 * 全部责任在 gateway，agent 仅被动 /reload 内存。
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { agentMemory } from '../shared/profiles_paths.js';

const logger = createLogger('snapshot', 'gateway.log');

/** 快照包保留上限（滑窗淘汰最旧的） */
const MAX_CHECKPOINTS = 10;

function _rand4() {
  return Math.random().toString(16).slice(2, 6);
}

/** agent 私聊记忆目录：profiles/agents/<id>/memory（snapshot 打包/还原的"记忆源"） */
function _dataDir(agentId) {
  return agentMemory(agentId);
}

/** checkpoints 根目录：profiles/agents/<id>/memory/checkpoints */
function _checkpointsDir(agentId) {
  return path.join(_dataDir(agentId), 'checkpoints');
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
 * 记忆源 = profiles/agents/<id>/memory（context/tool-results）。
 * @param {string} agentId
 * @param {string} prompt - 本轮用户消息全文（菜单标题 + 回填输入框）
 * @param {string} [roomHistoryPath] - 私聊房 history 路径（profiles/rooms/chat-<id>/history.jsonl），
 *        传入则一并快照（与 memory 三件套同进同出），rewind 时同步恢复。
 * @returns {string|null} checkpointId，失败返回 null
 */
export function snapshotBeforeSend(agentId, prompt, roomHistoryPath) {
  const dataDir = _dataDir(agentId);
  const contextFile = path.join(dataDir, 'context.json');
  const toolResultsDir = path.join(dataDir, 'tool-results');

  // 【改动1】首次对话也打快照：如果 context.json 不存在，先创建空文件再 snapshot
  //   （agent 记忆的 history.jsonl 已废用——room 模式聊天内容落 profiles/rooms/<id>/history.jsonl，
  //    memory 内不再有 history 这条腿，snapshot/rewind 不再触碰它。）
  const hasContext = fs.existsSync(contextFile);
  if (!hasContext) {
    fs.writeFileSync(contextFile, '[]', 'utf-8');
    logger.info(`[snapshot ${agentId}] 首次创建空 context.json`);
  }

  const before = listCheckpoints(agentId);
  const beforeCount = before.length;
  // 入栈定序：seq = 现存最大栈序 + 1（空则 0）——单调、重启安全、rewind 后续推也不与已删的撞。
  //   顺序在创建时定死，不靠毫秒墙钟/readdir 顺序（旧 bug：同毫秒两个快照 createdAt 相等，rewind 漏删）。
  const nextSeq = before.length ? before[before.length - 1].seq + 1 : 0;
  const cpId = `cp_${Date.now()}_${_rand4()}`;
  const cpDir = path.join(_checkpointsDir(agentId), cpId);
  fs.mkdirSync(cpDir, { recursive: true });
  logger.info(`[snapshot 开始 ${agentId}] 打快照前磁盘 ${beforeCount} 个；新建 ${cpId}；源存在 context=${hasContext} tool-results=${fs.existsSync(toolResultsDir)}；prompt="${(prompt || '').slice(0, 30)}"`);

  try {
    // context.json 此时一定存在（首次对话已在上方创建空文件）
    fs.copyFileSync(contextFile, path.join(cpDir, 'context.json'));
    if (fs.existsSync(toolResultsDir) && fs.statSync(toolResultsDir).isDirectory()) {
      _copyDir(toolResultsDir, path.join(cpDir, 'tool-results'));
    }
    // 运行时文档（dataDir/runtime：lore/stats/outline/scene 等 DM 产物）一并快照，rewind 时整份覆盖回退
    const runtimeDir = path.join(dataDir, 'runtime');
    if (fs.existsSync(runtimeDir) && fs.statSync(runtimeDir).isDirectory()) {
      _copyDir(runtimeDir, path.join(cpDir, 'runtime'));
    }
    // 私聊房 history（profiles/rooms/chat-<id>/history.jsonl）一并快照（单独命名 room-history.jsonl 与 memory history 区分）
    if (roomHistoryPath && fs.existsSync(roomHistoryPath)) {
      fs.copyFileSync(roomHistoryPath, path.join(cpDir, 'room-history.jsonl'));
    }
    fs.writeFileSync(
      path.join(cpDir, 'meta.json'),
      JSON.stringify(
        { id: cpId, createdAt: new Date().toISOString(), prompt, restoredPrompt: prompt, seq: nextSeq },
        null,
        2
      ),
      'utf-8'
    );
    // 滑窗淘汰：超过上限删掉最旧的快照包
    _evictOld(agentId);
    return cpId;
  } catch (err) {
    logger.error(`打快照失败 (${agentId}): ${err.message}`);
    _rmDir(cpDir); // 失败回滚，避免留半截快照
    return null;
  }
}

/** 滑窗淘汰：保留最近 MAX_CHECKPOINTS 个，删掉更旧的 */
function _evictOld(agentId) {
  const root = _checkpointsDir(agentId);
  if (!fs.existsSync(root)) return;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const cpDir = path.join(root, e.name);
      return { name: e.name, seq: _cpSeq(cpDir), cpDir };
    })
    .sort((a, b) => b.seq - a.seq); // 新→旧（按栈序）
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

/** checkpoint 栈序号：meta.seq 权威（创建时入栈分配、单调），老数据无 seq 退化为 createdAt 毫秒 */
function _seqOf(meta) {
  if (meta && typeof meta.seq === 'number') return meta.seq;
  if (meta && meta.createdAt) { const t = Date.parse(meta.createdAt); if (!Number.isNaN(t)) return t; }
  return 0;
}

/** 读 cpDir 的栈序号（列表排序/滑窗淘汰/rewind 出栈删统一用此，不再用毫秒墙钟） */
function _cpSeq(cpDir) {
  return _seqOf(_readMeta(cpDir));
}

/**
 * 列出所有快照包（按 createdAt 升序，最旧在前）
 * @returns {Array<{ id, createdAt, prompt }>}
 */
export function listCheckpoints(agentId) {
  const root = _checkpointsDir(agentId);
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const cpDir = path.join(root, e.name);
      const meta = _readMeta(cpDir);
      const seq = _seqOf(meta);
      return meta
        ? { id: meta.id, createdAt: meta.createdAt, prompt: meta.prompt, seq }
        : { id: e.name, createdAt: null, prompt: null, seq };
    });
  entries.sort((a, b) => a.seq - b.seq);   // 按栈序升序（最旧在前）
  return entries;
}

/**
 * 解析「最近一个 checkpoint」的 id（空输入框双击 Esc / 回退按钮默认动作）
 */
export function latestCheckpointId(agentId) {
  const list = listCheckpoints(agentId);
  return list.length ? list[list.length - 1].id : null;
}

/**
 * 清空 rewind 栈：删掉该 agent 全部 checkpoint。
 * 清空历史（DELETE /rooms/:rid/history）调——历史清了，对历史/记忆的快照栈也整体作废。
 */
export function clearCheckpoints(agentId) {
  _rmDir(_checkpointsDir(agentId));
}

/**
 * 回退到指定 checkpoint：整文件替换 + 删其后快照包
 * 记忆还原回 profiles/agents/<id>/memory，房历史还原回 roomHistoryPath（profiles/rooms/chat-<id>/history.jsonl）。
 * @param {string} agentId
 * @param {string} [checkpointId] - 省略 = 最近一个
 * @returns {{ ok: boolean, restoredPrompt: string|null, error?: string }}
 */
export function rewindTo(agentId, checkpointId, roomHistoryPathOpt) {
  const list = listCheckpoints(agentId);
  logger.info(`[rewindTo 入口 ${agentId}] checkpointId=${checkpointId || '(latest)'} 删除前现有 ${list.length} 个快照包: ${_fmtList(list)}`);
  if (list.length === 0) return { ok: false, restoredPrompt: null, error: 'no checkpoint' };

  const idx = checkpointId
    ? list.findIndex(c => c.id === checkpointId)
    : list.length - 1;
  logger.info(`[rewindTo 解析目标 ${agentId}] 传入 id 在升序列表中的 idx=${idx}（升序列表末尾即最近一项，idx=${list.length - 1}）`);
  if (idx < 0) return { ok: false, restoredPrompt: null, error: 'checkpoint not found' };

  const target = list[idx];
  const targetSeq = target.seq;
  logger.info(`[rewindTo 目标 ${agentId}] 目标项 idx=${idx} id=${target.id} seq=${targetSeq} createdAt=${target.createdAt} prompt="${(target.prompt || '').slice(0, 30)}"`);

  const root = _checkpointsDir(agentId);
  const targetCpDir = path.join(root, list[idx].id);
  const meta = _readMeta(targetCpDir);
  if (!meta) return { ok: false, restoredPrompt: null, error: 'checkpoint meta missing' };

  const dataDir = _dataDir(agentId);
  const roomHistoryPath = roomHistoryPathOpt || null;
  try {
    // 1. 整份覆盖 context.json
    const cpContext = path.join(targetCpDir, 'context.json');
    if (fs.existsSync(cpContext)) {
      fs.copyFileSync(cpContext, path.join(dataDir, 'context.json'));
    }
    // 2. 整份覆盖 tool-results/（先清空再拷入，保证删掉快照后的产物）
    const cpToolResults = path.join(targetCpDir, 'tool-results');
    const liveToolResults = path.join(dataDir, 'tool-results');
    if (fs.existsSync(liveToolResults)) _rmDir(liveToolResults);
    if (fs.existsSync(cpToolResults)) _copyDir(cpToolResults, liveToolResults);
    // 3. 整份覆盖运行时文档 runtime/（lore/stats/outline/scene 等 DM 产物，rewind 整份回退）
    const cpRuntime = path.join(targetCpDir, 'runtime');
    const liveRuntime = path.join(dataDir, 'runtime');
    if (fs.existsSync(liveRuntime)) _rmDir(liveRuntime);
    if (fs.existsSync(cpRuntime)) _copyDir(cpRuntime, liveRuntime);
    // 4. 整份覆盖私聊房 room-history.jsonl
    //    快照里有 → 直接覆盖；快照里无（agent-side mid-turn checkpoint）→ 从 context.json 重建
    const cpRoomHistory = path.join(targetCpDir, 'room-history.jsonl');
    if (roomHistoryPath) {
      if (fs.existsSync(cpRoomHistory)) {
        fs.copyFileSync(cpRoomHistory, roomHistoryPath);
      } else {
        // 从刚恢复的 context.json 重建 room-history.jsonl，保持与 agent memory 一致
        const restoredCtx = path.join(dataDir, 'context.json');
        let reconstructed = '';
        try {
          const raw = fs.readFileSync(restoredCtx, 'utf-8');
          const msgs = JSON.parse(raw);
          let seq = 1;
          const lines = [];
          for (const m of msgs) {
            if (m.role === 'tool' || m.isMeta) continue;
            const record = {
              id: m.id || `msg_${Date.now()}_${seq}`,
              seq: seq++,
              role: m.role,
              content: m.content || '',
              ts: m.ts || new Date().toISOString(),
            };
            if (m.tool_calls) record.toolCalls = m.tool_calls;
            lines.push(JSON.stringify(record));
          }
          reconstructed = lines.join('\n') + (lines.length > 0 ? '\n' : '');
        } catch (e) {
          // context.json 读取失败 → 清空 room history
        }
        if (fs.existsSync(roomHistoryPath)) {
          fs.writeFileSync(roomHistoryPath, reconstructed, 'utf-8');
        }
      }
    }

    // 5. 删掉 target 及其之后的所有快照包
    //    target 本身也出栈：回退后栈顶下移到更旧那个，连续 rewind 才能一路往更旧走，
    //    否则会卡在原栈顶空转（连按 N 次只撤销 1 轮）。
    const deletedIds = [];
    const keptIds = [];
    // 出栈语义：栈顶=最大 seq；rewindTo(target)=弹出 target 及其之上全部（seq >= target）。
    //   按 seq（创建时入栈分配、单调）判删，不再用毫秒墙钟——同毫秒快照也不会漏删。
    for (const cp of list) {
      if (cp.seq >= targetSeq) {
        _rmDir(path.join(root, cp.id));
        deletedIds.push(cp.id);
      } else {
        keptIds.push(cp.id);
      }
    }
    const after = listCheckpoints(agentId);
    logger.info(`[rewindTo 删除 ${agentId}] 目标 seq=${targetSeq}，判定规则 seq>=目标=删（含目标本身出栈）。删除 ${deletedIds.length} 个: ${deletedIds.join(',') || '(无)'}；保留 ${keptIds.length} 个: ${keptIds.join(',')}`);
    logger.info(`[rewindTo 删除后回查 ${agentId}] 磁盘实际剩余 ${after.length} 个快照包: ${_fmtList(after)}`);

    return { ok: true, restoredPrompt: meta.restoredPrompt ?? meta.prompt ?? null };
  } catch (err) {
    logger.error(`rewind 失败 (${agentId}, ${checkpointId}): ${err.message}`);
    return { ok: false, restoredPrompt: null, error: err.message };
  }
}
