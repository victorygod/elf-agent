/**
 * room_bus 内核测试（RoomBroadcaster / RoomHistory / allocPort / RoomRegistry）
 * 全部纯逻辑/IO，不起真实 agent 子进程。
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'node:http';
import { RoomBroadcaster, RoomHistory, allocPort, RoomRegistry, RoomConfig, RoomManager, MEMBER_STATUS } from '../gateway/room_bus.js';

/** 造 mock res（捕获 write/end，模拟 close 事件）
 *  writeThrowsAfterN: 前 N 次 write 正常，第 N+1 次起抛错（模拟订阅后才断连）
 */
function mockRes({ writable = true, writeThrows = false, writeThrowsAfterN = Infinity } = {}) {
  const events = {};
  const writes = [];
  let ended = false;
  let writeCount = 0;
  const res = {
    writable,
    _headers: null,
    writeHead(status, headers) { this._headers = { status, headers }; },
    flushHeaders() {},
    socket: { setNoDelay() {} },
    write(chunk) {
      writeCount++;
      if (writeThrows || writeCount > writeThrowsAfterN) throw new Error('write failed');
      writes.push(chunk);
      return true;
    },
    end() { ended = true; },
    on(ev, fn) { (events[ev] = events[ev] || []).push(fn); },
    _emitClose() { (events.close || []).forEach(fn => fn()); },
    _writes: writes,
    _ended: () => ended,
  };
  return res;
}

// ============================================================
// RoomBroadcaster
// ============================================================

describe('RoomBroadcaster', () => {
  it('add 设置 SSE 头 + 推 snapshot + 注册订阅者', () => {
    const bc = new RoomBroadcaster('roomA');
    const res = mockRes();
    bc.add(res, { members: [], messages: [] });
    assert.equal(bc.size, 1);
    assert.equal(res._headers.status, 200);
    assert.match(res._writes[0], /event: snapshot/);
    assert.match(res._writes[0], /"members":\[\]/);
  });

  it('broadcast speak 事件产出正确 SSE 格式', () => {
    const bc = new RoomBroadcaster('roomA');
    const res = mockRes();
    bc.add(res);
    bc.broadcast('speak', { speaker: 'elf-001', content: 'hello' });
    const last = res._writes[res._writes.length - 1];
    assert.match(last, /event: speak\n/);
    assert.match(last, /data: \{"speaker":"elf-001","content":"hello"\}\n\n$/);
  });

  it('多订阅者都收到广播', () => {
    const bc = new RoomBroadcaster('roomA');
    const r1 = mockRes(), r2 = mockRes();
    bc.add(r1); bc.add(r2);
    assert.equal(bc.size, 2);
    bc.broadcast('speak', { speaker: 'u', content: 'hi' });
    assert.ok(r1._writes.length > 0);
    assert.ok(r2._writes.length > 0);
  });

  it('res close 触发剔除', () => {
    const bc = new RoomBroadcaster('roomA');
    const res = mockRes();
    bc.add(res);
    assert.equal(bc.size, 1);
    res._emitClose();
    assert.equal(bc.size, 0);
  });

  it('broadcast 时 write 抛错的订阅者被剔除，不影响其他', () => {
    const bc = new RoomBroadcaster('roomA');
    const good = mockRes();
    // bad: snapshot（add 时第1次 write）正常，broadcast（第2次 write）抛错
    const bad = mockRes({ writeThrowsAfterN: 1 });
    bc.add(good); bc.add(bad);
    assert.equal(bc.size, 2);
    bc.broadcast('speak', { speaker: 'u', content: 'x' });
    // bad 被 filter 掉
    assert.equal(bc.size, 1);
    // good 仍收到
    assert.ok(good._writes.length > 0);
  });

  it('writable=false 的订阅者被剔除', () => {
    const bc = new RoomBroadcaster('roomA');
    const dead = mockRes({ writable: false });
    bc.add(dead);
    bc.broadcast('speak', { speaker: 'u', content: 'x' });
    assert.equal(bc.size, 0);
  });

  it('removeAll 关闭所有订阅者', () => {
    const bc = new RoomBroadcaster('roomA');
    const r1 = mockRes(), r2 = mockRes();
    bc.add(r1); bc.add(r2);
    bc.removeAll();
    assert.equal(bc.size, 0);
    assert.ok(r1._ended());
    assert.ok(r2._ended());
  });
});

// ============================================================
// RoomHistory
// ============================================================

describe('RoomHistory', () => {
  let tmpDir, roomsDir, hist;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rh-'));
    roomsDir = path.join(tmpDir, 'rooms');
    hist = new RoomHistory(roomsDir, 'roomA');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('add 写入记录，含完整 schema', () => {
    const rec = hist.add('elf-001', '你好', 'speak');
    assert.equal(rec.roomId, 'roomA');
    assert.equal(rec.speaker, 'elf-001');
    assert.equal(rec.content, '你好');
    assert.equal(rec.event, 'speak');
    assert.ok(rec.id);
    assert.ok(rec.ts);
    assert.match(rec.id, /^rmsg_/);
  });

  it('add 默认 event 为 speak', () => {
    const rec = hist.add('user', 'hi');
    assert.equal(rec.event, 'speak');
  });

  it('add 带 speakerUid 落盘并被 getRecent 回读（问题3 用户稳定身份）', () => {
    const rec = hist.add('wolfgod', 'hi', 'speak', 'default_userid');
    assert.equal(rec.speakerUid, 'default_userid');
    const r = hist.getRecent(10);
    assert.equal(r.messages[0].speakerUid, 'default_userid');
    // 不传 speakerUid 时不出现该字段（向后兼容）
    const rec2 = hist.add('elf-001', 'yo');
    assert.equal('speakerUid' in rec2, false);
  });

  it('getRecent 返回正序（最旧在前）+ 分页', () => {
    for (let i = 0; i < 5; i++) hist.add('u', `m${i}`);
    const r = hist.getRecent(3);
    assert.equal(r.messages.length, 3);
    assert.equal(r.hasMore, true);
    assert.equal(r.messages[0].content, 'm2');
    assert.equal(r.messages[2].content, 'm4');
  });

  it('getRecent 不够 limit 时 hasMore=false', () => {
    hist.add('u', 'only');
    const r = hist.getRecent(10);
    assert.equal(r.messages.length, 1);
    assert.equal(r.hasMore, false);
  });

  it('getRecent beforeId 向前翻页', () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(hist.add('u', `m${i}`).id);
    // 以 ids[2] 为游标，取它之前的 2 条
    const r = hist.getRecent(2, ids[2]);
    assert.equal(r.messages.length, 2);
    assert.equal(r.messages[0].content, 'm0');
    assert.equal(r.messages[1].content, 'm1');
  });

  it('getRecent afterId 增量查询', () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(hist.add('u', `m${i}`).id);
    const r = hist.getRecent(100, undefined, ids[1]);
    assert.equal(r.messages.length, 2);
    assert.equal(r.messages[0].content, 'm2');
    assert.equal(r.messages[1].content, 'm3');
  });

  it('getRecent 对不存在文件返回空', () => {
    const fresh = new RoomHistory(roomsDir, 'roomEMPTY');
    const r = fresh.getRecent(10);
    assert.deepEqual(r.messages, []);
    assert.equal(r.hasMore, false);
  });

  it('clear 清空历史', () => {
    hist.add('u', 'a');
    hist.add('u', 'b');
    hist.clear();
    const r = hist.getRecent(10);
    assert.equal(r.messages.length, 0);
  });
});

// ============================================================
// allocPort
// ============================================================

describe('allocPort', () => {
  it('返回一个可 listen 的端口', async () => {
    const port = await allocPort();
    assert.ok(port > 0, 'port 应 > 0');
    // 再起 server 占用它，证明可 listen
    await new Promise((resolve) => {
      const srv = http.createServer();
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()));
    });
  });

  it('两次调用都能拿到有效端口', async () => {
    const p1 = await allocPort();
    const p2 = await allocPort();
    assert.ok(p1 > 0);
    assert.ok(p2 > 0);
  });
});

// ============================================================
// RoomRegistry
// ============================================================

describe('RoomRegistry', () => {
  let tmpDir, reg;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rr-'));
    reg = new RoomRegistry(path.join(tmpDir, 'rooms'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('write 写入 run.json，read 读回字段正确', () => {
    reg.write('roomA', 'elf-001', {
      port: 9001, pid: 1234, memberName: 'elf-001', dataDir: '/tmp/x', roomBusUrl: 'http://x',
    });
    const r = reg.read('roomA', 'elf-001');
    assert.equal(r.runKey, 'roomA/elf-001');
    assert.equal(r.roomId, 'roomA');
    assert.equal(r.agentId, 'elf-001');
    assert.equal(r.port, 9001);
    assert.equal(r.pid, 1234);
    assert.equal(r.memberName, 'elf-001');
    assert.equal(r.dataDir, '/tmp/x');
    assert.equal(r.roomBusUrl, 'http://x');
  });

  it('list 列出某群所有副本', () => {
    reg.write('roomA', 'elf-001', { port: 9001, pid: 1, memberName: 'a', dataDir: '/x', roomBusUrl: 'http://x' });
    reg.write('roomA', 'elf-002', { port: 9002, pid: 2, memberName: 'b', dataDir: '/y', roomBusUrl: 'http://x' });
    const list = reg.list('roomA');
    assert.equal(list.length, 2);
    const agentIds = list.map(r => r.agentId).sort();
    assert.deepEqual(agentIds, ['elf-001', 'elf-002']);
  });

  it('remove 删除 run.json，list 不再含它', () => {
    reg.write('roomA', 'elf-001', { port: 9001, pid: 1, memberName: 'a', dataDir: '/x', roomBusUrl: 'http://x' });
    reg.remove('roomA', 'elf-001');
    assert.equal(reg.read('roomA', 'elf-001'), null);
    assert.equal(reg.list('roomA').length, 0);
  });

  it('list 对不存在群返回空', () => {
    assert.deepEqual(reg.list('nope'), []);
  });

  it('list 跳过缺 run.json 的成员目录', () => {
    // 造一个成员目录但没 run.json
    const dir = path.join(tmpDir, 'rooms', 'roomA', 'data', 'elf-003');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'other.txt'), 'junk');
    reg.write('roomA', 'elf-001', { port: 9001, pid: 1, memberName: 'a', dataDir: '/x', roomBusUrl: 'http://x' });
    const list = reg.list('roomA');
    assert.equal(list.length, 1); // 只 elf-001，elf-003 被跳过
  });

  it('read 对不存在的副本返回 null', () => {
    assert.equal(reg.read('roomA', 'ghost'), null);
  });
});

// ============================================================
// RoomConfig
// ============================================================

describe('RoomConfig', () => {
  let tmpDir, rc;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rc-'));
    rc = new RoomConfig(path.join(tmpDir, 'rooms'), 'roomA');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exists 对不存在返回 false', () => {
    assert.equal(rc.exists(), false);
  });

  it('create 写入完整 schema', () => {
    const rec = rc.create('测试群', ['elf-001', 'elf-002']);
    assert.equal(rec.roomId, 'roomA');
    assert.equal(rec.name, '测试群');
    assert.deepEqual(rec.members, ['elf-001', 'elf-002']);
    assert.ok(rec.createdAt);
    assert.equal(rc.exists(), true);
  });

  it('create name 缺省回退 roomId', () => {
    const rec = rc.create('', ['elf-001']);
    assert.equal(rec.name, 'roomA');
  });

  it('create members 非数组时落空数组', () => {
    const rec = rc.create('x', 'notarray');
    assert.deepEqual(rec.members, []);
  });

  it('read 读回字段', () => {
    rc.create('群', ['elf-001']);
    const cfg = rc.read();
    assert.equal(cfg.name, '群');
    assert.deepEqual(cfg.members, ['elf-001']);
  });

  it('read 对不存在返回 null', () => {
    assert.equal(rc.read(), null);
  });

  it('addMember 追加并去重', () => {
    rc.create('群', ['elf-001']);
    let cfg = rc.addMember('elf-002');
    assert.deepEqual(cfg.members, ['elf-001', 'elf-002']);
    cfg = rc.addMember('elf-001'); // 重复
    assert.deepEqual(cfg.members, ['elf-001', 'elf-002']);
  });

  it('addMember 对不存在的群返回 null', () => {
    assert.equal(rc.addMember('elf-001'), null);
  });

  it('removeMember 移除指定成员', () => {
    rc.create('群', ['elf-001', 'elf-002']);
    const cfg = rc.removeMember('elf-001');
    assert.deepEqual(cfg.members, ['elf-002']);
  });

  it('updateName 改群名', () => {
    rc.create('旧名', ['elf-001']);
    const cfg = rc.updateName('新名');
    assert.equal(cfg.name, '新名');
    assert.equal(rc.read().name, '新名');
  });

  it('updateName 对不存在的群返回 null', () => {
    assert.equal(rc.updateName('x'), null);
  });
});

// ============================================================
// RoomManager（fakeSpawn，不起真实进程）
// ============================================================

describe('RoomManager', () => {
  let tmpDir, roomsDir, agentsDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-rm-'));
    roomsDir = path.join(tmpDir, 'rooms');
    agentsDir = path.join(tmpDir, 'agents');
    // 造两个假 agent config 目录，让 agentConfigDir 能找到 config.json
    for (const id of ['elf-001', 'elf-002']) {
      const cfgDir = path.join(agentsDir, id, 'config');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
        agentId: id, name: id, port: 0, provider: 'mock', systemPrompt: 't', tools: [],
      }));
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** fake spawn：返回带 _fakeReady=true 的假 child，记录调用 */
  function fakeSpawnFactory(calls = []) {
    return (args) => {
      calls.push(args);
      return { pid: 10000 + calls.length, _fakeReady: true };
    };
  }

  function newManager(calls) {
    return new RoomManager(roomsDir, 8080, {
      spawnFn: fakeSpawnFactory(calls),
      agentConfigDir: (id) => path.join(agentsDir, id, 'config'),
      startTimeout: 500, // fake 不真等
    });
  }

  it('createRoom 写 RoomConfig + 拉起所有成员副本 + 状态 running', async () => {
    const calls = [];
    const mgr = newManager(calls);
    const r = await mgr.createRoom('群', ['elf-001', 'elf-002']);
    assert.ok(r.roomId);
    assert.equal(r.members.length, 2);
    assert.equal(calls.length, 2); // 两个成员都 spawn
    // run.json 已写
    const list = mgr.registry.list(r.roomId);
    assert.equal(list.length, 2);
    // 成员状态 running
    const room = mgr.getRoom(r.roomId);
    assert.ok(room.members.every(m => m.status === MEMBER_STATUS.RUNNING));
  });

  it('createRoom 成员不存在时不 spawn，该成员 offline', async () => {
    const calls = [];
    const mgr = newManager(calls);
    const r = await mgr.createRoom('群', ['elf-001', 'ghost']);
    assert.equal(calls.length, 1); // 只 elf-001 被 spawn
    const room = mgr.getRoom(r.roomId);
    const ghost = room.members.find(m => m.agentId === 'ghost');
    assert.equal(ghost.status, MEMBER_STATUS.OFFLINE);
  });

  it('addMember 改 config + spawn 新副本', async () => {
    const calls = [];
    const mgr = newManager(calls);
    const r = await mgr.createRoom('群', ['elf-001']);
    assert.equal(calls.length, 1);
    await mgr.addMember(r.roomId, 'elf-002');
    assert.equal(calls.length, 2);
    const room = mgr.getRoom(r.roomId);
    assert.equal(room.members.length, 2);
  });

  it('addMember 对不存在的群抛错', async () => {
    const mgr = newManager([]);
    await assert.rejects(mgr.addMember('nope', 'elf-001'), /群不存在/);
  });

  it('removeMember 停副本 + 改 config + 删 data', async () => {
    const calls = [];
    const mgr = newManager(calls);
    const r = await mgr.createRoom('群', ['elf-001', 'elf-002']);
    await mgr.removeMember(r.roomId, 'elf-002');
    const room = mgr.getRoom(r.roomId);
    assert.equal(room.members.length, 1);
    assert.equal(room.members[0].agentId, 'elf-001');
    // data 目录已删
    const dataDir = path.join(roomsDir, r.roomId, 'data', 'elf-002');
    assert.equal(fs.existsSync(dataDir), false);
  });

  it('listRooms 列出所有群', async () => {
    const mgr = newManager([]);
    await mgr.createRoom('群1', ['elf-001']);
    await mgr.createRoom('群2', ['elf-002']);
    const list = mgr.listRooms();
    assert.equal(list.length, 2);
  });

  it('getRoom 对不存在返回 null', () => {
    const mgr = newManager([]);
    assert.equal(mgr.getRoom('nope'), null);
  });

  it('ensureReplicasAlive：存活成员标 running，死的重拉', async () => {
    const calls = [];
    const mgr = newManager(calls);
    const r = await mgr.createRoom('群', ['elf-001']);
    assert.equal(calls.length, 1);
    // 模拟副本死掉：把端口改成一个空闲端口，probePort 返回 ok:false → 重拉
    const room = mgr.rooms.get(r.roomId);
    const m = room.members.get('elf-001');
    const freePort = await allocPort(); // 空闲
    room.members.set('elf-001', { ...m, port: freePort });
    await mgr.ensureReplicasAlive(r.roomId);
    // 重拉会再调一次 spawn
    assert.equal(calls.length, 2);
    const after = mgr.getRoom(r.roomId);
    assert.equal(after.members[0].status, MEMBER_STATUS.RUNNING);
  });

  it('ensureReplicasAlive：内存态丢失(模拟重启)+进程死 → re-discover 重拉(问题4)', async () => {
    const calls = [];
    const mgr = newManager(calls);
    const r = await mgr.createRoom('群', ['elf-001']);
    assert.equal(calls.length, 1);
    // 模拟 gateway 重启：清空内存 members Map，但保留落盘 run.json
    const room = mgr.rooms.get(r.roomId);
    const deadPort = await allocPort(); // 拿一个端口立即释放 → 进程不存活
    room.members.clear();
    // run.json 仍在(createRoom 时 spawnReplica 写过)；但 port 已死 → 重拉
    await mgr.ensureReplicasAlive(r.roomId);
    assert.equal(calls.length, 2, '内存缺失且进程死应重拉一次');
    const after = mgr.getRoom(r.roomId);
    assert.equal(after.members[0].status, MEMBER_STATUS.RUNNING, '重拉后回填 running');
  });

  it('ensureReplicasAlive：内存态丢失但 run.json 无记录 → 直接重拉(问题4)', async () => {
    const calls = [];
    const mgr = newManager(calls);
    const r = await mgr.createRoom('群', ['elf-001']);
    assert.equal(calls.length, 1);
    const room = mgr.rooms.get(r.roomId);
    room.members.clear();
    mgr.registry.remove(r.roomId, 'elf-001'); // 抹掉 run.json
    await mgr.ensureReplicasAlive(r.roomId);
    assert.equal(calls.length, 2, 'run.json 也无记录,直接重拉');
  });

  it('clearMemberMemory：内存无 port 且副本不可达 → 删盘兜底清 context.json(问题2)', async () => {
    const calls = [];
    const mgr = newManager(calls);
    const r = await mgr.createRoom('群', ['elf-001']);
    // 造一份 context.json + tool-results 在副本 data 目录
    const dataDir = path.join(roomsDir, r.roomId, 'data', 'elf-001');
    fs.writeFileSync(path.join(dataDir, 'context.json'), JSON.stringify([{ role: 'user', content: 'x' }]), 'utf-8');
    fs.mkdirSync(path.join(dataDir, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'tool-results', 'a.json'), '{}', 'utf-8');
    // 模拟副本离线：清空内存 port（fake spawn 没起真服务,/clear fetch 必失败）
    const room = mgr.rooms.get(r.roomId);
    room.members.set('elf-001', { port: null, pid: null, status: MEMBER_STATUS.OFFLINE });
    await mgr.clearMemberMemory(r.roomId);
    // context.json 被清空成 []
    const ctx = JSON.parse(fs.readFileSync(path.join(dataDir, 'context.json'), 'utf-8'));
    assert.deepEqual(ctx, []);
    // tool-results 目录被删
    assert.equal(fs.existsSync(path.join(dataDir, 'tool-results')), false);
  });

  it('clearMemberMemory：内存无 port 但 registry 有 → 用 run.json 端口兜底(问题2)', async () => {
    const calls = [];
    const mgr = newManager(calls);
    const r = await mgr.createRoom('群', ['elf-001']);
    const dataDir = path.join(roomsDir, r.roomId, 'data', 'elf-001');
    fs.writeFileSync(path.join(dataDir, 'context.json'), JSON.stringify([{ role: 'user', content: 'x' }]), 'utf-8');
    // 内存 Map 完全清空(模拟重启)，但 run.json 仍在
    const room = mgr.rooms.get(r.roomId);
    room.members.clear();
    await mgr.clearMemberMemory(r.roomId);
    const ctx = JSON.parse(fs.readFileSync(path.join(dataDir, 'context.json'), 'utf-8'));
    assert.deepEqual(ctx, [], 'registry 回退取端口,fetch 失败后仍删盘兜底清空');
  });

  it('spawnFn 可注入且收到正确参数', async () => {
    const calls = [];
    const mgr = newManager(calls);
    const r = await mgr.createRoom('群', ['elf-001']);
    const c = calls[0];
    assert.equal(c.agentId, 'elf-001');
    assert.equal(c.roomId, r.roomId);
    assert.equal(c.mode, undefined); // mode 由 defaultSpawnFn 内部加，fake 收不到
    assert.ok(c.port > 0);
    assert.ok(c.dataDir.includes('data/elf-001'));
    assert.match(c.roomBusUrl, /http:\/\/127.0.0.1:8080\/rooms\//);
  });
});

// ============================================================
// RoomManager.broadcastObserve（mock 副本 http server）
// ============================================================

describe('RoomManager.broadcastObserve', () => {
  let tmpDir, roomsDir, agentsDir, mockServers = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-bo-'));
    roomsDir = path.join(tmpDir, 'rooms');
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const id of ['elf-001', 'elf-002']) {
      const cfgDir = path.join(agentsDir, id, 'config');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
        agentId: id, name: id, port: 0, provider: 'mock', systemPrompt: 't', tools: [],
      }));
    }
    mockServers = [];
  });

  afterEach(async () => {
    for (const s of mockServers) { try { await new Promise(r => s.close(r)); } catch (e) {} }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 起一个 mock 副本 http server，observeStatus 决定 /observe 行为 */
  function startMockReplica(observeStatus = 200) {
    const srv = http.createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', agentId: 'mock', pid: process.pid }));
      } else if (req.url === '/observe' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => body += c);
        req.on('end', () => {
          res.writeHead(observeStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ack: true }));
          srv._lastObserve = body; // 捕获供断言
        });
      } else {
        res.writeHead(404); res.end();
      }
    });
    return new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        srv._port = srv.address().port;
        resolve(srv);
      });
    });
  }

  it('parseMentions 解析消息里 @成员名', () => {
    const m = RoomManager.parseMentions('你好 @elf-001 看', ['elf-001', 'elf-002']);
    assert.deepEqual(m, ['elf-001']);
    const none = RoomManager.parseMentions('你好', ['elf-001']);
    assert.deepEqual(none, []);
  });

  it('parseMentions 最长匹配: elf 与 elf-001 同存,@elf-001 只匹配 elf-001 不误匹配 elf', () => {
    const m = RoomManager.parseMentions('喂 @elf-001 你好', ['elf', 'elf-001']);
    assert.deepEqual(m, ['elf-001']);
    const m2 = RoomManager.parseMentions('喂 @elf 你好', ['elf', 'elf-001']);
    assert.deepEqual(m2, ['elf']);
  });

  it('parseMentions 多个@/去重', () => {
    const m = RoomManager.parseMentions('@elf-001 和 @elf-002', ['elf-001', 'elf-002']);
    assert.deepEqual(m.sort(), ['elf-001', 'elf-002']);
    const dup = RoomManager.parseMentions('@elf-001 @elf-001', ['elf-001']);
    assert.deepEqual(dup, ['elf-001']);
  });

  it('parseMentions @name 同样命中且归一到 agentId', () => {
    const members = [{ agentId: 'elf-001', name: 'Alice' }, { agentId: 'elf-003', name: 'Star' }];
    assert.deepEqual(RoomManager.parseMentions('@Star 你好', members), ['elf-003']);
    assert.deepEqual(RoomManager.parseMentions('@elf-003 你好', members), ['elf-003']);
    assert.deepEqual(RoomManager.parseMentions('@Alice 和 @elf-003', members).sort(), ['elf-001', 'elf-003']);
    // name 与 id 重叠时不重复
    const same = [{ agentId: 'elf-001', name: 'elf-001' }];
    assert.deepEqual(RoomManager.parseMentions('@elf-001 hi', same), ['elf-001']);
  });

  it('broadcastObserve 并发给所有成员,200 的保持 running', async () => {
    const replica1 = await startMockReplica(200);
    const replica2 = await startMockReplica(200);
    mockServers = [replica1, replica2];
    const mgr = new RoomManager(roomsDir, 8080, {
      spawnFn: () => ({ _fakeReady: true, pid: 1 }),
      agentConfigDir: (id) => path.join(agentsDir, id, 'config'),
    });
    const r = await mgr.createRoom('群', ['elf-001', 'elf-002']);
    // 把成员端口指向 mock 副本
    const room = mgr.rooms.get(r.roomId);
    room.members.set('elf-001', { port: replica1._port, pid: 1, status: MEMBER_STATUS.RUNNING });
    room.members.set('elf-002', { port: replica2._port, pid: 2, status: MEMBER_STATUS.RUNNING });

    await mgr.broadcastObserve(r.roomId, '你好 @elf-001', 'user');

    // 两个副本都收到 observe（elf-002 未被@也收到,用于累积上下文）
    assert.ok(replica1._lastObserve);
    assert.ok(replica2._lastObserve);
    const body1 = JSON.parse(replica1._lastObserve);
    assert.deepEqual(body1.mentions, ['elf-001']);
    assert.equal(body1.from, 'user');
    // 收到的成员保持 running
    assert.equal(room.members.get('elf-001').status, MEMBER_STATUS.RUNNING);
    assert.equal(room.members.get('elf-002').status, MEMBER_STATUS.RUNNING);
  });

  it('broadcastObserve 404 的成员标 offline', async () => {
    const ok = await startMockReplica(200);
    const bad = await startMockReplica(404);
    mockServers = [ok, bad];
    const mgr = new RoomManager(roomsDir, 8080, {
      spawnFn: () => ({ _fakeReady: true, pid: 1 }),
      agentConfigDir: (id) => path.join(agentsDir, id, 'config'),
    });
    const r = await mgr.createRoom('群', ['elf-001', 'elf-002']);
    const room = mgr.rooms.get(r.roomId);
    room.members.set('elf-001', { port: ok._port, pid: 1, status: MEMBER_STATUS.RUNNING });
    room.members.set('elf-002', { port: bad._port, pid: 2, status: MEMBER_STATUS.RUNNING });

    await mgr.broadcastObserve(r.roomId, 'hi', 'user');
    assert.equal(room.members.get('elf-001').status, MEMBER_STATUS.RUNNING);
    assert.equal(room.members.get('elf-002').status, MEMBER_STATUS.OFFLINE);
  });

  it('broadcastObserve 连不上的成员标 offline', async () => {
    const mgr = new RoomManager(roomsDir, 8080, {
      spawnFn: () => ({ _fakeReady: true, pid: 1 }),
      agentConfigDir: (id) => path.join(agentsDir, id, 'config'),
    });
    const r = await mgr.createRoom('群', ['elf-001']);
    const room = mgr.rooms.get(r.roomId);
    // 指向一个空闲端口（连接失败）
    const free = await allocPort();
    room.members.set('elf-001', { port: free, pid: 1, status: MEMBER_STATUS.RUNNING });
    await mgr.broadcastObserve(r.roomId, 'hi', 'user');
    assert.equal(room.members.get('elf-001').status, MEMBER_STATUS.OFFLINE);
  });
});