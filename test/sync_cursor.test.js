/**
 * SyncCursor 单元测试
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SyncCursor } from '../engine/sync_source.js';

describe('SyncCursor', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-sc-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('get() 返回 null（无 cursor 文件）', () => {
    const sc = new SyncCursor(tmpDir);
    assert.equal(sc.get(), null);
  });

  it('hasCursor() 返回 false（无 cursor 文件）', () => {
    const sc = new SyncCursor(tmpDir);
    assert.equal(sc.hasCursor(), false);
  });

  it('advance() 后 get() 返回上次写入的 seq', () => {
    const sc = new SyncCursor(tmpDir);
    sc.advance(3);
    assert.equal(sc.get(), 3);
    assert.equal(sc.hasCursor(), true);
  });

  it('advance() 写盘：重新加载后 get() 一致', () => {
    const sc1 = new SyncCursor(tmpDir);
    sc1.advance(5);
    const sc2 = new SyncCursor(tmpDir);
    assert.equal(sc2.get(), 5);
  });

  it('多次 advance 覆盖旧值', () => {
    const sc = new SyncCursor(tmpDir);
    sc.advance(1);
    sc.advance(2);
    sc.advance(3);
    assert.equal(sc.get(), 3);
  });

  it('不存在的 cursor 文件目录自动创建', () => {
    const subDir = path.join(tmpDir, 'nested', 'data');
    const sc = new SyncCursor(subDir);
    sc.advance(7);
    assert.ok(fs.existsSync(path.join(subDir, 'sync_cursor.json')));
    assert.equal(sc.get(), 7);
  });

  it('非法 JSON 内容：静默重置为 null', () => {
    const corruptDir = path.join(tmpDir, 'corrupt');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, 'sync_cursor.json'), 'not-json{{{');
    const sc = new SyncCursor(corruptDir);
    assert.equal(sc.get(), null);
    assert.equal(sc.hasCursor(), false);
  });

  it('advance(0) 保存 seq=0', () => {
    const sc = new SyncCursor(tmpDir);
    sc.advance(0);
    assert.equal(sc.get(), 0);
  });
});