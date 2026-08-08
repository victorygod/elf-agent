/**
 * Rewind 文件轴（file-history）测试 —— 方案 A（CC 复刻）
 *
 * 覆盖 docs/rewind-file-axis-design.md 的关键正确性：
 *  - track 写前抓改前内容；同轮二次不重存
 *  - makeSnapshot 边界重抓全部追踪文件；未变复用（方案 A 正确性来源）
 *  - restore 还原到边界；新建文件 unlink；孤立 backup 清理
 *  - ★ 方案 A 标志用例：Bash 在 agent 没动 F 的轮里改 F，rewind 正确回退 F（方案 B 会漏）
 *  - Write 工具写前钩子端到端（ctx.agent.messageManager.dataDir → track）
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { snapshotBeforeSend, rewindTo, clearCheckpoints, listCheckpoints } from '../gateway/snapshot.js';
import { track } from '../shared/file_history.js';
import { profilesRoot, agentRoomState } from '../shared/profiles_paths.js';
import { Write } from '../engine/tools/index.js';
import { markRead, reset as resetReadState } from '../engine/tools/read_state.js';

// ── 测试隔离 ──
const __profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-fh-test-'));
process.env.ELF_PROFILES_ROOT = __profilesRoot;

const aid = 'test-fh';
const rid = 'chat-u_test-test-fh';
const dataDir = () => agentRoomState(aid, rid);

// 模拟"项目工作目录"（被 Edit/Write 改的真实文件，在 dataDir 之外）
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-fh-proj-'));
const fp = (name) => path.join(projDir, name);

before(() => { try { fs.mkdirSync(profilesRoot(), { recursive: true }); } catch { /* ignore */ } });

after(() => {
  try { fs.rmSync(__profilesRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.ELF_PROFILES_ROOT;
});

afterEach(() => {
  clearCheckpoints(aid, rid); // 清 checkpoint + file-history
  resetReadState();
  for (const name of fs.readdirSync(projDir)) fs.rmSync(path.join(projDir, name), { force: true });
});

/** 模拟一轮：打 checkpoint → agent 改 file → 写入 newContent（走 track 写前钩子）。 */
function roundEdit(prompt, filePath, newContent) {
  snapshotBeforeSend(aid, rid, prompt);
  track(dataDir(), filePath);                 // 模拟 Edit/Write 写前钩子
  fs.writeFileSync(filePath, newContent);
}

// ========================================================================

describe('track / restore — 基本回退', () => {

  it('Edit 已存在文件：rewind 还原改前内容', () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    roundEdit('m1', fp('F.js'), 'v1');
    assert.equal(fs.readFileSync(fp('F.js'), 'utf-8'), 'v1', '改后应为 v1');

    const r = rewindTo(aid, rid);               // latest = cp1
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(fp('F.js'), 'utf-8'), 'v0', 'rewind 应回到改前 v0');
  });

  it('同轮同一文件二次 Edit 不重存改前快照', () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    snapshotBeforeSend(aid, rid, 'm1');
    track(dataDir(), fp('F.js')); fs.writeFileSync(fp('F.js'), 'v1');   // 第一次：备份 v0
    track(dataDir(), fp('F.js')); fs.writeFileSync(fp('F.js'), 'v2');   // 第二次：应跳过

    rewindTo(aid, rid);
    assert.equal(fs.readFileSync(fp('F.js'), 'utf-8'), 'v0', '同轮只存第一次改前 v0，回退到 v0 而非 v1');
  });

  it('新建文件：rewind 撤回创建（unlink）', () => {
    snapshotBeforeSend(aid, rid, 'm1');
    track(dataDir(), fp('new.js'));             // 文件不存在 → backup=null
    fs.writeFileSync(fp('new.js'), 'created');
    assert.ok(fs.existsSync(fp('new.js')));

    rewindTo(aid, rid);
    assert.ok(!fs.existsSync(fp('new.js')), '新建文件应被 unlink 撤回');
  });
});

// ========================================================================

describe('makeSnapshot — 方案 A 边界重抓', () => {

  it('★ Bash 在 agent 没动 F 的轮里改 F，rewind 正确回退 F（方案 A 标志用例）', () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    fs.writeFileSync(fp('G.js'), 'g0');

    // round1：agent Edit F v0→v1
    snapshotBeforeSend(aid, rid, '加登录');       // cp1（makeSnapshot 跳过：尚无追踪文件）
    track(dataDir(), fp('F.js'));                 // 备份 F=v0
    fs.writeFileSync(fp('F.js'), 'v1');

    // round2：agent 只改 G；Bash 改 F（agent 没动 F，Bash 不入 tracked）
    snapshotBeforeSend(aid, rid, '加注册');       // cp2（makeSnapshot 跑：trackedFiles=[F]，重抓 F 当前=v1）
    track(dataDir(), fp('G.js'));                 // 备份 G=g0
    fs.writeFileSync(fp('G.js'), 'g1');
    fs.writeFileSync(fp('F.js'), 'v1B');          // ★ Bash 改 F，不经 track

    // 回退到 cp2（= 发"加注册"前 = round1 之后）
    //  期望：F=v1（Bash 的 v1B 在 round2 里、边界之后，该撤销）；G=g0
    const r = rewindTo(aid, rid);                 // latest = cp2
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(fp('F.js'), 'utf-8'), 'v1',
      'F 应回到 cp2 边界的 v1，Bash 的 v1B 被撤销（方案 B 会漏成 v1B）');
    assert.equal(fs.readFileSync(fp('G.js'), 'utf-8'), 'g0', 'G 应回到改前 g0');
  });

  it('未变文件复用旧 backup，不新增', () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    roundEdit('m1', fp('F.js'), 'v1');           // cp1：F 备份 v0@v1
    snapshotBeforeSend(aid, rid, 'm2');          // cp2：makeSnapshot 重抓 F（v0→v1 变了）→ v1@v2
    snapshotBeforeSend(aid, rid, 'm3');          // cp3：F 仍 v1，未变 → 复用 v1@v2
    const dir = path.join(dataDir(), 'file-history');
    assert.equal(fs.readdirSync(dir).length, 2, 'F 未变 → cp3 复用，仅 v0@v1 + v1@v2 两个 backup');
  });

  it('回退到最早轮：每文件回到该边界状态', () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    roundEdit('m1', fp('F.js'), 'v1');           // cp1 边界 F=v0；写后 F=v1
    roundEdit('m2', fp('F.js'), 'v2');           // cp2 边界 F=v1；写后 F=v2
    roundEdit('m3', fp('F.js'), 'v3');           // cp3 边界 F=v2；写后 F=v3

    const cps = listCheckpoints(aid, rid);       // [cp1,cp2,cp3] 升序
    const cp1 = cps[0].id;
    rewindTo(aid, rid, cp1);                      // 显式回退到最早
    assert.equal(fs.readFileSync(fp('F.js'), 'utf-8'), 'v0', '回退到 cp1（发 m1 前）F 应回到 v0');
  });
});

// ========================================================================

describe('清理 — clear / 孤立 backup', () => {

  it('clearCheckpoints 清掉 file-history 注册表与 backup 目录', () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    roundEdit('m1', fp('F.js'), 'v1');
    assert.ok(fs.existsSync(path.join(dataDir(), 'file-history.json')), '应有注册表');
    assert.ok(fs.existsSync(path.join(dataDir(), 'file-history')), '应有 backup 目录');

    clearCheckpoints(aid, rid);
    assert.ok(!fs.existsSync(path.join(dataDir(), 'file-history.json')), '注册表应被清');
    assert.ok(!fs.existsSync(path.join(dataDir(), 'file-history')), 'backup 目录应被清');
  });

  it('rewind 后孤立 backup 被清理', () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    roundEdit('m1', fp('F.js'), 'v1');           // cp1：F=v0@v1
    roundEdit('m2', fp('F.js'), 'v2');           // cp2：makeSnapshot 重抓 F=v1@v2
    const dir = path.join(dataDir(), 'file-history');
    assert.equal(fs.readdirSync(dir).length, 2, '应有 v0@v1 + v1@v2 两个 backup');

    rewindTo(aid, rid);                           // 回 cp2（latest）：弹 cp2，prune 孤立 v1@v2
    assert.equal(fs.readdirSync(dir).length, 1, 'cp2 弹掉 → v1@v2 孤立被清，只留 cp1 引用的 v0@v1');
  });
});

// ========================================================================

// ========================================================================

describe('只回退对话（restoreFiles=false）+ hasFileChanges', () => {

  it('restoreFiles=false：文件保持当前，弹栈照常', () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    roundEdit('m1', fp('F.js'), 'v1');           // cp1：F 备份 v0，写后 v1
    roundEdit('m2', fp('F.js'), 'v2');           // cp2：F 备份 v1，写后 v2

    const cp1 = listCheckpoints(aid, rid)[0].id;
    const r = rewindTo(aid, rid, cp1, undefined, { restoreFiles: false });  // 只对话回 cp1
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(fp('F.js'), 'utf-8'), 'v2', '只对话 → 文件保持当前 v2，不覆盖回 v0');
    assert.equal(listCheckpoints(aid, rid).length, 0, '弹栈照常：cp1/cp2 都弹');
  });

  it('restoreFiles=true（默认）：文件一并回退', () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    roundEdit('m1', fp('F.js'), 'v1');
    roundEdit('m2', fp('F.js'), 'v2');

    const cp1 = listCheckpoints(aid, rid)[0].id;
    rewindTo(aid, rid, cp1);                      // 默认 restoreFiles=true
    assert.equal(fs.readFileSync(fp('F.js'), 'utf-8'), 'v0', '对话+文件 → F 回到 cp1 边界 v0');
  });

  it('hasFileChanges：文件相对快照改了→true，改回快照→false', () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    roundEdit('m1', fp('F.js'), 'v1');            // cp1：F 备份 v0，当前 v1
    assert.equal(listCheckpoints(aid, rid)[0].hasFileChanges, true, '当前 v1 ≠ 快照 v0 → 会动文件');

    fs.writeFileSync(fp('F.js'), 'v0');           // 手动改回 = 快照内容
    assert.equal(listCheckpoints(aid, rid)[0].hasFileChanges, false, '当前 v0 == 快照 v0 → 不会动文件');
  });

  it('无文件编辑的 checkpoint：hasFileChanges=false', () => {
    snapshotBeforeSend(aid, rid, 'm1');           // cp1，无 track → 无注册表
    assert.equal(listCheckpoints(aid, rid)[0].hasFileChanges, false, '无文件追踪 → 不会动文件');
  });
});

// ========================================================================

describe('Write 工具写前钩子端到端', () => {

  it('经 ctx.agent.messageManager.dataDir 落到 file-history，rewind 可回退', async () => {
    fs.writeFileSync(fp('F.js'), 'v0');
    markRead(fp('F.js'), { content: 'v0', timestamp: Math.floor(Date.now()) }); // 满足 Write"先 Read"守卫
    snapshotBeforeSend(aid, rid, 'm1');

    const ctx = { agent: { messageManager: { dataDir: dataDir() } } };
    const res = await Write.execute({ file_path: fp('F.js'), content: 'v1' }, undefined, ctx);
    assert.ok(!/Error/.test(res), `Write 应成功: ${res}`);
    assert.equal(fs.readFileSync(fp('F.js'), 'utf-8'), 'v1', 'Write 写入 v1');

    rewindTo(aid, rid);
    assert.equal(fs.readFileSync(fp('F.js'), 'utf-8'), 'v0', '钩子已备份 v0，rewind 回到 v0');
  });
});
