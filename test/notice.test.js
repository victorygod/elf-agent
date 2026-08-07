import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LLMModel } from '../engine/models/llm.js';
import { sendNotice } from '../engine/notice.js';

/** 简单 mock LLM 端点：前 cfg.failTimes 次回 503，之后回正常流式 SSE（空 delta 即可，只需建连成功）。 */
function startMockLLM(opts = {}) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    calls.push(req);
    let idx = calls.length; // 第几次
    if (idx <= (opts.failTimes || 0)) {
      res.writeHead(503);
      res.end('fail');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, addr: srv.address(), calls })));
}

describe('withRetry onRetry 钩子', () => {
  it('前 N 次失败时触发 onRetry，attempt=即将重试序号；耗尽前 final=true', async () => {
    const mock = await startMockLLM({ failTimes: 2 }); // attempt1、2 失败，attempt3 成功
    try {
      const port = mock.addr.port;
      const model = new LLMModel({ base_url: `http://127.0.0.1:${port}`, apiKey: 'x', model: 'test', connectTimeout: 1000, requestTimeout: 1000 });
      const retryInfos = [];
      const res = await model.chatStream([], null, {
        onRetry: (info) => retryInfos.push({ ...info }),
      });
      assert.equal(res.content, '');
      // attempt1 失败 → 即将第 2 次；attempt2 失败 → 即将第 3 次。共 2 条 onRetry，均 final=false。
      assert.equal(retryInfos.length, 2);
      assert.equal(retryInfos[0].attempt, 2);
      assert.equal(retryInfos[1].attempt, 3);
      assert.equal(retryInfos.every(i => i.final === false), true);
      assert.equal(retryInfos[0].maxRetries, 3);
      assert.ok(retryInfos[0].error);
    } finally {
      mock.srv.close();
    }
  });

  it('不传 onRetry 时行为不变（成功返回）', async () => {
    const mock = await startMockLLM({ failTimes: 0 });
    try {
      const port = mock.addr.port;
      const model = new LLMModel({ base_url: `http://127.0.0.1:${port}`, apiKey: 'x', model: 'test', connectTimeout: 1000, requestTimeout: 1000 });
      const res = await model.chatStream([], null, {});
      assert.equal(res.content, '');
    } finally {
      mock.srv.close();
    }
  });

  it('3 次全失败 → onRetry 最后一次 final=true，且 chatStream 抛出', async () => {
    const mock = await startMockLLM({ failTimes: 99 });
    try {
      const port = mock.addr.port;
      const model = new LLMModel({ base_url: `http://127.0.0.1:${port}`, apiKey: 'x', model: 'test', connectTimeout: 1000, requestTimeout: 1000 });
      const retryInfos = [];
      await assert.rejects(
        model.chatStream([], null, { onRetry: (info) => retryInfos.push({ ...info }) }),
        /LLM API error: 503/,
      );
      // attempt1 失败→即将2(final=false)，attempt2 失败→即将3(final=false)，attempt3 失败→final=true
      assert.equal(retryInfos.length, 3);
      assert.equal(retryInfos[2].attempt, 3);
      assert.equal(retryInfos[2].final, true);
    } finally {
      mock.srv.close();
    }
  });
});

describe('sendNotice 分流', () => {
  it('room 模式：POST 到 roomBusUrl/notice，携带 roomId/memberName', async () => {
    const received = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        received.push({ url: req.url, method: req.method, body: JSON.parse(body), speakerId: req.headers['x-speaker-id'] });
        res.writeHead(200); res.end('{}');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = srv.address().port;
      const url = `http://127.0.0.1:${port}`;
      const ctx = { runContext: { mode: 'room', roomId: 'r1', agentId: 'a1', memberName: '艾梵', roomBusUrl: url } };
      sendNotice(ctx, { kind: 'retry', agentId: 'a1', attempt: 2, maxRetries: 3, error: 'x' });
      for (let i = 0; i < 40 && received.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(received.length, 1);
      assert.equal(received[0].url, '/notice');
      assert.equal(received[0].method, 'POST');
      assert.equal(received[0].body.kind, 'retry');
      assert.equal(received[0].body.roomId, 'r1');
      assert.equal(received[0].body.memberName, '艾梵');
      assert.equal(received[0].speakerId, 'a1'); // header 用 ASCII agentId（中文 memberName 不进 header）
    } finally {
      srv.close();
    }
  });

  it('私聊（private/无 rc）：走 emit，事件名 notice', () => {
    const emitted = [];
    const ctx = { runContext: { mode: 'private', agentId: 'a1' }, emit: (e) => emitted.push(e) };
    sendNotice(ctx, { kind: 'retry', agentId: 'a1', attempt: 2, maxRetries: 3 });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, 'notice');
    assert.equal(emitted[0].data.kind, 'retry');
    assert.equal(emitted[0].data.memberName, 'a1'); // 兜底 agentId
  });

  it('群聊 fetch 失败时静默吞掉，不抛', () => {
    const ctx = { runContext: { mode: 'room', roomId: 'r1', agentId: 'a1', memberName: 'n', roomBusUrl: 'http://127.0.0.1:1/never' } };
    assert.doesNotThrow(() => sendNotice(ctx, { kind: 'retry', agentId: 'a1', attempt: 2 }));
  });
});