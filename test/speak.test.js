import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Speak } from '../engine/tools/Speak.js';

/** 起一个 mock room_bus server，捕获 /say 请求（含 X-Speaker-Id header） */
function startMockRoomBus() {
  const received = [];
  let status = 200;
  const srv = http.createServer((req, res) => {
    if (req.url === '/say' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        received.push({ ...JSON.parse(body), _speakerId: req.headers['x-speaker-id'] });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    } else {
      res.writeHead(404); res.end();
    }
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, received, setStatus: (s) => { status = s; } }));
  });
}

describe('Speak 工具', () => {
  let mock;

  before(async () => {
    mock = await startMockRoomBus();
  });

  after(async () => {
    await new Promise((r) => mock.srv.close(r));
  });

  it('群聊模式 execute → fetch /say,header X-Speaker-Id + body {content}', async () => {
    mock.received.length = 0;
    const ctx = { agent: { runContext: { mode: 'room', roomBusUrl: mock.url, memberName: 'elf-001' } } };
    const r = await Speak.execute({ message: '你好' }, undefined, ctx);
    assert.match(r, /^\[\d{4} \d{2}:\d{2}\] 已发言$/);
    assert.equal(mock.received.length, 1);
    assert.equal(mock.received[0]._speakerId, 'elf-001');
    assert.equal(mock.received[0].content, '你好');
    assert.equal(mock.received[0].speaker, undefined, 'body 不应含 speaker(身份走 header)');
  });

  it('message 缺失 → Error', async () => {
    const ctx = { agent: { runContext: { mode: 'room', roomBusUrl: mock.url, memberName: 'x' } } };
    const r = await Speak.execute({}, undefined, ctx);
    assert.match(r, /message 必填/);
  });

  it('私聊无 runContext → Error: 仅群聊可用', async () => {
    const r = await Speak.execute({ message: 'hi' }, undefined, { agent: {} });
    assert.match(r, /仅群聊可用/);
  });

  it('子 agent 无 ctx.agent → Error: 仅群聊可用（双保险 §12.3）', async () => {
    const r = await Speak.execute({ message: 'hi' }, undefined, {});
    assert.match(r, /仅群聊可用/);
  });

  it('roomBusUrl 缺失 → Error', async () => {
    const ctx = { agent: { runContext: { mode: 'room', roomBusUrl: null, memberName: 'x' } } };
    const r = await Speak.execute({ message: 'hi' }, undefined, ctx);
    assert.match(r, /缺 roomBusUrl/);
  });

  it('room_bus 返回非 200 → Error', async () => {
    mock.setStatus(500);
    const ctx = { agent: { runContext: { mode: 'room', roomBusUrl: mock.url, memberName: 'x' } } };
    const r = await Speak.execute({ message: 'hi' }, undefined, ctx);
    assert.match(r, /发言失败/);
    mock.setStatus(200);
  });

  it('aborted signal → Error: aborted', async () => {
    const ctx = { agent: { runContext: { mode: 'room', roomBusUrl: mock.url, memberName: 'x' } } };
    const ac = new AbortController(); ac.abort();
    const r = await Speak.execute({ message: 'hi' }, ac.signal, ctx);
    assert.match(r, /aborted/);
  });
});