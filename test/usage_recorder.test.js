import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { UsageRecorder } from '../engine/usage_recorder.js';
import { _resetProfilesRoot, usageDir } from '../shared/profiles_paths.js';

/** 临时 profiles 根隔离 + 用完清理。 */
function withTmpRoot(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-usage-'));
    process.env.ELF_PROFILES_ROOT = tmp;
    _resetProfilesRoot();
    try {
      await fn(tmp);
    } finally {
      delete process.env.ELF_PROFILES_ROOT;
      _resetProfilesRoot();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

test('record 写入 profiles/usage/<agentId>.jsonl 且字段完整', withTmpRoot(async () => {
  const r = new UsageRecorder({ agentId: 'elf-001' });
  const rec = r.record({
    model: 'gpt-4o', phase: 'turn',
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    cached_tokens: 3, reasoning_tokens: 1, source: 'provider',
    context_tokens: 100, userId: 'u1', roomId: 'chat-elf-001',
  });
  assert.equal(rec.agentId, 'elf-001');
  assert.ok(rec.id.startsWith('u_'), `id 应以 u_ 开头, got ${rec.id}`);
  assert.equal(typeof rec.ts, 'number');
  assert.equal(rec.source, 'provider');

  const fp = path.join(usageDir(), 'elf-001.jsonl');
  assert.ok(fs.existsSync(fp), 'usage.jsonl 应已创建');
  const lines = fs.readFileSync(fp, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.total_tokens, 15);
  assert.equal(parsed.cached_tokens, 3);
  assert.equal(parsed.reasoning_tokens, 1);
  assert.equal(parsed.context_tokens, 100);
  assert.equal(parsed.roomId, 'chat-elf-001');
}));

test('append 多条不覆盖(每行一条)', withTmpRoot(async () => {
  const r = new UsageRecorder({ agentId: 'elf-002' });
  r.record({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  r.record({ prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 });
  const fp = path.join(usageDir(), 'elf-002.jsonl');
  const lines = fs.readFileSync(fp, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).total_tokens, 4);
}));

test('缺 agentId 抛错(不静默)', () => {
  assert.throws(() => new UsageRecorder({}), /agentId/);
});

test('缺失字段填默认值(0/null)', withTmpRoot(async () => {
  const r = new UsageRecorder({ agentId: 'elf-003' });
  const rec = r.record({});
  assert.equal(rec.prompt_tokens, 0);
  assert.equal(rec.completion_tokens, 0);
  assert.equal(rec.source, 'estimate');
  assert.equal(rec.phase, 'turn');
  assert.equal(rec.aborted, false);
  assert.equal(rec.context_tokens, null);
  assert.equal(rec.cached_tokens, 0);
}));

test('不同 agent 写各自文件(写无竞争)', withTmpRoot(async () => {
  new UsageRecorder({ agentId: 'a' }).record({ total_tokens: 1 });
  new UsageRecorder({ agentId: 'b' }).record({ total_tokens: 2 });
  assert.ok(fs.existsSync(path.join(usageDir(), 'a.jsonl')));
  assert.ok(fs.existsSync(path.join(usageDir(), 'b.jsonl')));
}));