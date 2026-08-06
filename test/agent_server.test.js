/**
 * 多 agent agent-server 测试：一个 createAgentServer（工厂模式，无 defaultAgent）进程内
 *   承载多个不同 agentId，验证复合键 (agentId,roomId) 下实例独立、dataDir 按 agentId 隔离。
 *
 * 对应 docs inprocess-agent-host §三"实例路由键复合 (agentId,roomId)"——同群两个共处成员不 alias。
 * MockModel（ELF_FORCE_MOCK_MODEL=1）+ 真实 agents/elf-001、agents/elf-002 装配。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createAgentServer } from '../engine/server.js';
import { profilesRoot } from '../shared/profiles_paths.js';

before(() => { process.env.ELF_FORCE_MOCK_MODEL = '1'; });
after(() => { delete process.env.ELF_FORCE_MOCK_MODEL; });

describe('多 agent agent-server（一进程承载多 agentId）', () => {
  let app, server, baseUrl;
  before(async () => {
    app = createAgentServer({
      config: null,
      configDir: (id) => path.join(process.cwd(), 'agents', id, 'config'),
      gatewayUrl: null,
      defaultAgentId: null,
      port: null,
    });
    await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
  });
  after(async () => { if (server) await new Promise(r => server.close(r)); });

  it('两个不同 agent 的私聊房共处一 server，实例独立、dataDir 按 agentId 隔离', async () => {
    const [a, b] = await Promise.all([
      fetch(`${baseUrl}/observe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: 'chat-u_test-elf-001', content: 'hi', role: 'chat', seq: 1 }) }),
      fetch(`${baseUrl}/observe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: 'chat-u_test-elf-002', content: 'hi', role: 'chat', seq: 1 }) }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    await new Promise(r => setTimeout(r, 250));
    const res = await fetch(`${baseUrl}/rooms`);
    const data = await res.json();
    const pair = data.rooms.map(r => `${r.agentId}/${r.roomId}`).sort();
    assert.ok(pair.includes('elf-001/chat-u_test-elf-001'), 'elf-001 私聊房实例存在');
    assert.ok(pair.includes('elf-002/chat-u_test-elf-002'), 'elf-002 私聊房实例存在');
    // 多用户：私聊房 dataDir = agentRoomState(<id>, chat-<uid>-<id>) = profiles/agents/<id>/rooms/chat-<uid>-<id>，
    //   各用户各 agent 独立目录（与 snapshot/rewind 对齐）。
    assert.ok(fs.existsSync(path.join(profilesRoot(), 'agents', 'elf-001', 'rooms', 'chat-u_test-elf-001')), 'elf-001 私聊 dataDir 落 per-room 目录');
    assert.ok(fs.existsSync(path.join(profilesRoot(), 'agents', 'elf-002', 'rooms', 'chat-u_test-elf-002')), 'elf-002 私聊 dataDir 落 per-room 目录');
  });

  it('同一群 room 两个共处成员不 alias：两个独立实例 + dataDir 各自隔离', async () => {
    const r1 = await fetch(`${baseUrl}/observe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: 'room_zz', mode: 'room', agentId: 'elf-001', memberName: 'elf-001', from: 'user', content: 'hi', mentions: [], role: 'chat', seq: 1 }) });
    const r2 = await fetch(`${baseUrl}/observe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: 'room_zz', mode: 'room', agentId: 'elf-002', memberName: 'elf-002', from: 'user', content: 'hi', mentions: [], role: 'chat', seq: 1 }) });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    await new Promise(r => setTimeout(r, 150));
    const res = await fetch(`${baseUrl}/rooms`);
    const data = await res.json();
    const zz = data.rooms.filter(r => r.roomId === 'room_zz');
    assert.equal(zz.length, 2, 'room_zz 下两个 agent 各一个实例（复合键不 alias）');
    assert.deepEqual(zz.map(r => r.agentId).sort(), ['elf-001', 'elf-002']);
    assert.ok(fs.existsSync(path.join(profilesRoot(), 'agents', 'elf-001', 'rooms', 'room_zz')));
    assert.ok(fs.existsSync(path.join(profilesRoot(), 'agents', 'elf-002', 'rooms', 'room_zz')));
  });
});
