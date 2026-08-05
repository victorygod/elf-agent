/**
 * shared/checkpoint_restore 纯 FS 单测：findLatestCheckpoint + restoreRuntimeFromCheckpoint。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { findLatestCheckpoint, restoreRuntimeFromCheckpoint } from '../shared/checkpoint_restore.js';

let tmp;

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeFile(p, content) { mkdir(path.dirname(p)); fs.writeFileSync(p, content); }

/** 造一个 checkpoint 目录,含 meta.json 及指定子产物。 */
function makeCp(checkpointsRoot, cpId, { seq, createdAt, runtime, toolResults, syncCursor } = {}) {
  const cpDir = path.join(checkpointsRoot, cpId);
  mkdir(cpDir);
  const meta = { id: cpId, createdAt: createdAt || new Date(2020, 0, 1).toISOString(), prompt: `prompt-${cpId}` };
  if (typeof seq === 'number') meta.seq = seq;
  writeFile(path.join(cpDir, 'meta.json'), JSON.stringify(meta));
  if (runtime) for (const [rel, content] of Object.entries(runtime)) writeFile(path.join(cpDir, 'runtime', rel), content);
  if (toolResults) for (const [rel, content] of Object.entries(toolResults)) writeFile(path.join(cpDir, 'tool-results', rel), content);
  if (syncCursor !== undefined) writeFile(path.join(cpDir, 'sync_cursor.json'), JSON.stringify(syncCursor));
  return cpDir;
}

function dataDir() { return path.join(tmp, 'memory'); }
function checkpointsRoot() { return path.join(dataDir(), 'checkpoints'); }

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-restore-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('findLatestCheckpoint', () => {
  it('无 checkpoints 目录 → null', () => {
    assert.strictEqual(findLatestCheckpoint(dataDir()), null);
  });

  it('空 checkpoints 目录 → null', () => {
    mkdir(checkpointsRoot());
    assert.strictEqual(findLatestCheckpoint(dataDir()), null);
  });

  it('按 seq 最大取最近(seq 1 > seq 0)', () => {
    const cp0 = makeCp(checkpointsRoot(), 'cp_a', { seq: 0, createdAt: '2020-01-01T00:00:00.000Z' });
    const cp1 = makeCp(checkpointsRoot(), 'cp_b', { seq: 1, createdAt: '2019-01-01T00:00:00.000Z' }); // createdAt 更早但 seq 更大
    assert.strictEqual(findLatestCheckpoint(dataDir()), cp1);
    assert.notStrictEqual(findLatestCheckpoint(dataDir()), cp0);
  });

  it('无 seq 退化为 createdAt 毫秒,较晚的胜出', () => {
    const cpOld = makeCp(checkpointsRoot(), 'cp_old', { createdAt: '2020-01-01T00:00:00.000Z' });
    const cpNew = makeCp(checkpointsRoot(), 'cp_new', { createdAt: '2021-06-01T00:00:00.000Z' });
    assert.strictEqual(findLatestCheckpoint(dataDir()), cpNew);
  });
});

describe('restoreRuntimeFromCheckpoint', () => {
  it('整份还原 runtime + tool-results + sync_cursor', () => {
    const cp = makeCp(checkpointsRoot(), 'cp_pre', {
      seq: 0,
      runtime: { 'lore/state.md': 'old', 'outline/round-1.md': 'old-outline' },
      toolResults: { 'old.json': 'old-tr' },
      syncCursor: { a: 1 },
    });
    // live 脏写
    writeFile(path.join(dataDir(), 'runtime/lore/state.md'), 'dirty');
    writeFile(path.join(dataDir(), 'tool-results/old.json'), 'dirty-old');
    writeFile(path.join(dataDir(), 'tool-results/new.json'), 'orphan');
    writeFile(path.join(dataDir(), 'sync_cursor.json'), JSON.stringify({ a: 2 }));

    const r = restoreRuntimeFromCheckpoint(dataDir(), cp);
    assert.deepStrictEqual(r, { runtime: true, toolResults: true, syncCursor: true });
    assert.strictEqual(fs.readFileSync(path.join(dataDir(), 'runtime/lore/state.md'), 'utf-8'), 'old');
    assert.strictEqual(fs.readFileSync(path.join(dataDir(), 'runtime/outline/round-1.md'), 'utf-8'), 'old-outline');
    // tool-results:仅留 checkpoint 内的旧文件,孤儿删除
    const trFiles = fs.readdirSync(path.join(dataDir(), 'tool-results'));
    assert.deepStrictEqual(trFiles.sort(), ['old.json']);
    assert.strictEqual(fs.readFileSync(path.join(dataDir(), 'tool-results/old.json'), 'utf-8'), 'old-tr');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir(), 'sync_cursor.json'), 'utf-8')), { a: 1 });
  });

  it('cp 缺 runtime/ → 不爆删,live runtime 保留', () => {
    const cp = makeCp(checkpointsRoot(), 'cp_pre', { seq: 0, toolResults: { 'old.json': 'x' } });
    writeFile(path.join(dataDir(), 'runtime/lore/state.md'), 'keep-me');
    const r = restoreRuntimeFromCheckpoint(dataDir(), cp);
    assert.strictEqual(r.runtime, false);
    assert.strictEqual(r.toolResults, true);
    assert.strictEqual(fs.readFileSync(path.join(dataDir(), 'runtime/lore/state.md'), 'utf-8'), 'keep-me');
  });

  it('cp 缺 tool-results/ → 不爆删,live tool-results 保留', () => {
    const cp = makeCp(checkpointsRoot(), 'cp_pre', { seq: 0, runtime: { 'lore/state.md': 'old' } });
    writeFile(path.join(dataDir(), 'tool-results/keep.json'), 'keep-tr');
    const r = restoreRuntimeFromCheckpoint(dataDir(), cp);
    assert.strictEqual(r.toolResults, false);
    assert.strictEqual(fs.readFileSync(path.join(dataDir(), 'tool-results/keep.json'), 'utf-8'), 'keep-tr');
    assert.strictEqual(fs.readFileSync(path.join(dataDir(), 'runtime/lore/state.md'), 'utf-8'), 'old');
  });

  it('cp 目录不存在 → 全 false,不抛', () => {
    const r = restoreRuntimeFromCheckpoint(dataDir(), path.join(checkpointsRoot(), 'nope'));
    assert.deepStrictEqual(r, { runtime: false, toolResults: false, syncCursor: false });
  });

  it('不碰 context.json / room-history', () => {
    const cp = makeCp(checkpointsRoot(), 'cp_pre', { seq: 0, runtime: { 'lore/state.md': 'old' } });
    writeFile(path.join(dataDir(), 'context.json'), JSON.stringify([{ role: 'user', content: 'hi' }]));
    const r = restoreRuntimeFromCheckpoint(dataDir(), cp);
    assert.strictEqual(r.runtime, true);
    // context.json 原样保留(restore 不应读写它)
    const ctx = JSON.parse(fs.readFileSync(path.join(dataDir(), 'context.json'), 'utf-8'));
    assert.deepStrictEqual(ctx, [{ role: 'user', content: 'hi' }]);
  });
});