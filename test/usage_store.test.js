import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { UsageStore } from '../gateway/usage_store.js';
import { _resetProfilesRoot, usageDir } from '../shared/profiles_paths.js';

let _seq = 0;
function rec(overrides) {
  _seq++;
  return {
    id: `u_test_${_seq}`, ts: 0, agentId: 'x', userId: null, roomId: null,
    phase: 'turn', loop: null, iteration: null, model: 'gpt-4o',
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    cached_tokens: 0, reasoning_tokens: 0, cache_creation_tokens: 0,
    context_tokens: null, source: 'estimate', aborted: false,
    ...overrides,
  };
}

function writeJsonl(agentId, records) {
  fs.mkdirSync(usageDir(), { recursive: true });
  fs.writeFileSync(
    path.join(usageDir(), `${agentId}.jsonl`),
    records.map(r => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

function withTmpRoot(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-usage-store-'));
    process.env.ELF_PROFILES_ROOT = tmp;
    _resetProfilesRoot();
    try { await fn(); } finally {
      delete process.env.ELF_PROFILES_ROOT;
      _resetProfilesRoot();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

// 固定时间戳(UTC):2026-08-01 10:00 / 2026-08-02 11:00
const TS_AUG1_10 = Date.UTC(2026, 7, 1, 10);
const TS_AUG2_11 = Date.UTC(2026, 7, 2, 11);

test('全局按 agent 聚合:总量/分天/占比', withTmpRoot(async () => {
  writeJsonl('elf-001', [
    rec({ ts: TS_AUG1_10, agentId: 'elf-001', model: 'gpt-4o', total_tokens: 100, prompt_tokens: 60, completion_tokens: 40, source: 'provider' }),
    rec({ ts: TS_AUG2_11, agentId: 'elf-001', model: 'gpt-4o', total_tokens: 200, prompt_tokens: 120, completion_tokens: 80, source: 'provider' }),
  ]);
  writeJsonl('elf-002', [
    rec({ ts: TS_AUG1_10, agentId: 'elf-002', model: 'gpt-4o-mini', total_tokens: 50, prompt_tokens: 30, completion_tokens: 20, source: 'estimate' }),
  ]);

  const s = new UsageStore().summary({ tz: 'UTC', bucket: 'day', groupBy: 'agent' });
  assert.equal(s.kpi.total, 350);
  assert.equal(s.kpi.prompt, 210);
  assert.equal(s.kpi.completion, 140);
  assert.deepEqual(s.kpi.bySource, { provider: 300, estimate: 50 });
  assert.equal(s.byBucket.length, 2);
  assert.equal(s.byBucket[0].bucket, '2026-08-01');
  assert.equal(s.byBucket[0].total, 150);
  assert.equal(s.byBucket[1].bucket, '2026-08-02');
  assert.equal(s.byBucket[1].total, 200);
  assert.equal(s.kpi.peakBucket, '2026-08-02');
  assert.equal(s.kpi.peakBucketTotal, 200);
  const a1 = s.byGroup.find(g => g.key === 'elf-001');
  const a2 = s.byGroup.find(g => g.key === 'elf-002');
  assert.equal(a1.total, 300);
  assert.ok(Math.abs(a1.share - 300 / 350) < 1e-9);
  assert.equal(a2.total, 50);
}));

test('时间范围 from/to 过滤(YYYY-MM-DD 字典序)', withTmpRoot(async () => {
  writeJsonl('elf-001', [
    rec({ ts: TS_AUG1_10, agentId: 'elf-001', total_tokens: 100 }),
    rec({ ts: TS_AUG2_11, agentId: 'elf-001', total_tokens: 200 }),
  ]);
  const s = new UsageStore().summary({ from: '2026-08-02', to: '2026-08-02', tz: 'UTC' });
  assert.equal(s.kpi.total, 200);
  assert.equal(s.byBucket.length, 1);
  assert.equal(s.byBucket[0].bucket, '2026-08-02');
}));

test('groupBy=model', withTmpRoot(async () => {
  writeJsonl('elf-001', [
    rec({ ts: TS_AUG1_10, agentId: 'elf-001', model: 'gpt-4o', total_tokens: 100 }),
    rec({ ts: TS_AUG2_11, agentId: 'elf-001', model: 'gpt-4o-mini', total_tokens: 50 }),
  ]);
  const s = new UsageStore().summary({ tz: 'UTC', groupBy: 'model' });
  const m1 = s.byGroup.find(g => g.key === 'gpt-4o');
  const m2 = s.byGroup.find(g => g.key === 'gpt-4o-mini');
  assert.equal(m1.total, 100);
  assert.equal(m2.total, 50);
}));

test('bucket=hour 分时桶', withTmpRoot(async () => {
  writeJsonl('elf-001', [
    rec({ ts: TS_AUG1_10, agentId: 'elf-001', total_tokens: 100 }),
    rec({ ts: Date.UTC(2026, 7, 1, 14), agentId: 'elf-001', total_tokens: 30 }),
  ]);
  const s = new UsageStore().summary({ tz: 'UTC', bucket: 'hour' });
  assert.equal(s.byBucket.length, 2);
  assert.equal(s.byBucket[0].bucket, '2026-08-01 10');
  assert.equal(s.byBucket[1].bucket, '2026-08-01 14');
}));

test('agentSummary 单 agent(groupBy=model 默认)', withTmpRoot(async () => {
  writeJsonl('elf-001', [
    rec({ ts: TS_AUG1_10, agentId: 'elf-001', model: 'gpt-4o', total_tokens: 100 }),
    rec({ ts: TS_AUG2_11, agentId: 'elf-001', model: 'gpt-4o', total_tokens: 200 }),
  ]);
  writeJsonl('elf-002', [
    rec({ ts: TS_AUG1_10, agentId: 'elf-002', model: 'gpt-4o', total_tokens: 999 }),
  ]);
  const s = new UsageStore().agentSummary('elf-001', { tz: 'UTC' });
  assert.equal(s.kpi.total, 300);   // 不含 elf-002 的 999
  assert.equal(s.byGroup.length, 1);
  assert.equal(s.byGroup[0].key, 'gpt-4o');
  assert.equal(s.byGroup[0].total, 300);
}));

test('新写入后 mtime 变化 → 缓存失效重算', withTmpRoot(async () => {
  const store = new UsageStore();
  writeJsonl('elf-001', [rec({ ts: TS_AUG1_10, agentId: 'elf-001', total_tokens: 100 })]);
  const s1 = store.summary({ tz: 'UTC' });
  assert.equal(s1.kpi.total, 100);
  // 同进程内时间戳需区分 mtime:追加新文件后 mtime 变 → 失效
  writeJsonl('elf-001', [
    rec({ ts: TS_AUG1_10, agentId: 'elf-001', total_tokens: 100 }),
    rec({ ts: TS_AUG2_11, agentId: 'elf-001', total_tokens: 200 }),
  ]);
  const s2 = store.summary({ tz: 'UTC' });
  assert.equal(s2.kpi.total, 300, '缓存应失效重算');
}));

test('空数据目录:返回零值不抛', withTmpRoot(async () => {
  const s = new UsageStore().summary({ tz: 'UTC' });
  assert.equal(s.kpi.total, 0);
  assert.deepEqual(s.byBucket, []);
  assert.deepEqual(s.byGroup, []);
}));