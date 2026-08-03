/**
 * agent_events SSE 通道管理测试：
 *   - 收到并解析 SSE 事件 → onEvent
 *   - SSE 连接关闭 / 读取错误 → onDisconnect 触发（孤儿 streaming 兜底入口）
 *   - 幂等：重复 connectAgentEvents 复用现有连接，不重建
 *   - 主动 disconnectAgentEvents 不触发 onDisconnect，并清连接标记
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connectAgentEvents, disconnectAgentEvents, hasAgentEventsConnection } from '../gateway/agent_events.js';

function startSSEServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();
    server._res = res; // 保留最近一次 SSE 响应，供测试控制
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const AGENT = 'elf-test-events';

describe('agent_events SSE 通道管理', () => {
  let server, port;

  beforeEach(async () => {
    server = await startSSEServer();
    port = server.address().port;
  });
  afterEach(async () => {
    disconnectAgentEvents(AGENT);
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    await sleep(40);
  });

  it('收到并解析 SSE 事件 → onEvent 触发', async () => {
    let received;
    connectAgentEvents(AGENT, port, (ev, data) => { received = { ev, data }; });
    await sleep(80);
    server._res.write(`event: token\ndata: ${JSON.stringify({ content: 'hi', _roomId: 'chat-x' })}\n\n`);
    await sleep(80);
    assert.equal(received?.ev, 'token');
    assert.equal(received?.data.content, 'hi');
  });

  it('SSE 连接关闭 → onDisconnect 触发（孤儿 streaming 兜底入口）', async () => {
    let disconnected = 0;
    connectAgentEvents(AGENT, port, () => {}, () => { disconnected++; });
    await sleep(80);
    server._res.end(); // client reader.read() → done
    await sleep(100);
    assert.equal(disconnected, 1);
  });

  it('SSE 读取错误（socket destroy）→ onDisconnect 触发', async () => {
    let disconnected = 0;
    connectAgentEvents(AGENT, port, () => {}, () => { disconnected++; });
    await sleep(80);
    server._res.socket.destroy(); // 底层 socket 断 → reader.read() reject
    await sleep(100);
    assert.equal(disconnected, 1);
  });

  it('幂等：重复 connectAgentEvents 复用现有连接，不重建', async () => {
    let evCount = 0;
    const c1 = connectAgentEvents(AGENT, port, () => { evCount++; });
    await sleep(80);
    const c2 = connectAgentEvents(AGENT, port, () => { evCount++; });
    assert.equal(c1, c2, '应返回同一 controller，不重建连接');
    assert.equal(hasAgentEventsConnection(AGENT), true);
    // 复用的旧连接仍在收事件（幂等未断流）
    server._res.write(`event: token\ndata: ${JSON.stringify({ content: 'x' })}\n\n`);
    await sleep(80);
    assert.equal(evCount, 1, '复用连接继续投递，不丢');
  });

  it('主动 disconnectAgentEvents 不触发 onDisconnect，并清连接标记', async () => {
    let disconnected = 0;
    connectAgentEvents(AGENT, port, () => {}, () => { disconnected++; });
    await sleep(80);
    disconnectAgentEvents(AGENT);
    await sleep(80);
    assert.equal(disconnected, 0, '主动断开不应触发兜底');
    assert.equal(hasAgentEventsConnection(AGENT), false);
  });

  it('hasAgentEventsConnection：连接存活 true / 主动断开后 false', async () => {
    connectAgentEvents(AGENT, port, () => {});
    await sleep(80);
    assert.equal(hasAgentEventsConnection(AGENT), true);
    disconnectAgentEvents(AGENT);
    assert.equal(hasAgentEventsConnection(AGENT), false);
  });
});