/**
 * agent_probe 探活工具测试
 * 用真实临时 http server 端到端验探活（不起真实 agent 子进程）。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  probePort,
  findPidFromPort,
  waitForReady,
  httpShutdown,
  waitForPortFree,
} from '../shared/agent_probe.js';

/** 起一个临时 http server，响应 /status 与 /shutdown */
function startMockAgent(port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agentId: 'mock', pid: process.pid }));
    } else if (req.url === '/shutdown' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      // 立即退出进程语义由测试用 server.close 模拟，这里不 process.exit
    } else {
      res.writeHead(404); res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** 拿一个空闲端口 */
function freePort() {
  return new Promise((res) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

describe('probePort', () => {
  it('对运行中的 server 返回 ok:true + pid', async () => {
    const port = await freePort();
    const server = await startMockAgent(port);
    try {
      const r = await probePort(port);
      assert.equal(r.ok, true);
      assert.equal(typeof r.pid, 'number');
      assert.equal(r.agentId, 'mock');
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  it('对空闲端口返回 ok:false', async () => {
    const port = await freePort(); // 拿到后立即释放，大概率空闲
    const r = await probePort(port, 500);
    assert.equal(r.ok, false);
  });
});

describe('findPidFromPort', () => {
  it('对运行中的 server 返回非空 pid', async () => {
    const port = await freePort();
    const server = await startMockAgent(port);
    try {
      const pid = findPidFromPort(port);
      assert.ok(pid, '应返回 pid');
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  it('对空闲端口返回 null', async () => {
    const port = await freePort();
    const pid = findPidFromPort(port);
    assert.equal(pid, null);
  });
});

describe('waitForReady', () => {
  it('已就绪的 server 立即返回 true', async () => {
    const port = await freePort();
    const server = await startMockAgent(port);
    try {
      const ok = await waitForReady(port, 2000);
      assert.equal(ok, true);
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  it('未就绪的端口超时返回 false', async () => {
    const port = await freePort();
    const ok = await waitForReady(port, 800);
    assert.equal(ok, false);
  });
});

describe('httpShutdown', () => {
  it('POST /shutdown 返回 200 不抛错', async () => {
    const port = await freePort();
    const server = await startMockAgent(port);
    try {
      await assert.doesNotReject(httpShutdown(port));
    } finally {
      await new Promise(r => server.close(r));
    }
  });

  it('对空闲端口抛错（fetch 失败）', async () => {
    const port = await freePort();
    await assert.rejects(httpShutdown(port, 500));
  });
});

describe('waitForPortFree', () => {
  it('端口已释放时立即 resolve', async () => {
    const port = await freePort(); // 已释放
    await assert.doesNotReject(waitForPortFree(port, 1000));
  });

  it('端口被占用且不释放时超时 reject', async () => {
    const port = await freePort();
    const server = await startMockAgent(port); // 一直占着
    try {
      await assert.rejects(waitForPortFree(port, 600));
    } finally {
      await new Promise(r => server.close(r));
    }
  });
});