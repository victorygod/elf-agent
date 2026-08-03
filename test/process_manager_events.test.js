/**
 * process_manager ↔ private_room_stream 接线测试（方案3）：
 *   _makeDisconnectHandler(agentId) 触发时，若该 agent 名下私聊房 chat-<id> 仍
 *   streaming=true，应被 forceFinishPrivateTurn 清掉；非 streaming 房 no-op。
 *   锁定「SSE 通道断开 → 孤儿 streaming 兜底」的接线，防回归。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChatHistory } from '../gateway/chat_history.js';
import { ProcessManager } from '../gateway/process_manager.js';
import {
  subscribePrivateRoom, startPrivateTurn, forceFinishPrivateTurn, _testReset,
} from '../gateway/private_room_stream.js';

function fakeRes() {
  const chunks = [];
  return {
    writable: true, _chunks: chunks,
    write(c) { chunks.push(c); return true; },
    end() {}, on() {}, flushHeaders() {}, writeHead() {},
    socket: { setNoDelay() {} },
  };
}

describe('process_manager SSE 断开 → 孤儿 streaming 兜底接线', () => {
  let root, pm;

  beforeEach(() => {
    _testReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-pm-events-'));
    const history = new ChatHistory(root, root, { roomMode: true, roomsDir: root });
    // subscribe 建 SSE 订阅 + 注入 historyStore（forceFinishPrivateTurn 落盘需要）
    subscribePrivateRoom('chat-elf-x', fakeRes(), history);
    pm = new ProcessManager();
  });
  afterEach(() => {
    _testReset();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  });

  it('SSE 断开 handler 清掉该 agent 名下 streaming 中的私聊房', () => {
    const roomId = 'chat-elf-x';
    // 造一个 streaming=true 的孤儿回合（agent 已发不出 done 的场景）
    startPrivateTurn(roomId, { content: '1', id: 'u1' });
    assert.equal(forceFinishPrivateTurn(roomId), true, '前置：房间确实在 streaming');

    // 通道断开 → PM 的断开 handler 触发
    pm._makeDisconnectHandler('elf-x')();

    assert.equal(forceFinishPrivateTurn(roomId), false, '兜底后 streaming 已清，再 forceFinish no-op');
  });

  it('SSE 断开 handler 对非 streaming 房 no-op（不误造状态、不重复广播）', () => {
    const roomId = 'chat-elf-x';
    // 不 startTurn，房间无 streaming 回合
    const before = pm._makeDisconnectHandler('elf-x');
    before();
    assert.equal(forceFinishPrivateTurn(roomId), false, '本就非 streaming，兜底 no-op');
  });

  it('断开 handler 只清自己的 agent 房，不影响别的 agent', () => {
    // elf-x 有孤儿 streaming
    startPrivateTurn('chat-elf-x', { content: '1', id: 'u1' });
    // elf-y 也 subscribe 一房（非 streaming）
    const history = new ChatHistory(root, root, { roomMode: true, roomsDir: root });
    subscribePrivateRoom('chat-elf-y', fakeRes(), history);

    pm._makeDisconnectHandler('elf-x')();

    assert.equal(forceFinishPrivateTurn('chat-elf-x'), false, 'elf-x 已被清');
    assert.equal(forceFinishPrivateTurn('chat-elf-y'), false, 'elf-y 本就非 streaming，未受影响');
  });
});