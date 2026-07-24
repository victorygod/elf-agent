/**
 * 文件工具补充测试 — 覆盖本轮 4 项改造：
 *  1. Read L3 短路（未变重读返回 Wasted call，不读盘/不刷新 ts）
 *  2. detectChangedFiles + hook 注入（变更产 isMeta 消息 + 只产一次 + 工具门控）
 *  3. Bash 输出落盘可回读（超阈值落盘、可 Read）
 *  4. Glob mtime 排序 + .gitignore
 *
 * 独立文件，自建临时目录 + registry，不依赖 shared.test.js 的共享状态。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Read, Write, Edit, Bash, Glob } from '../engine/tools/index.js';
import { ToolManager } from '../engine/tools/tool_manager.js';
import { reset as resetReadState, getReadState } from '../engine/tools/read_state.js';
import { detectChangedFiles } from '../engine/tools/file_change_detector.js';
import { MessageManager } from '../engine/message_manager.js';

// 各测试各建自己的临时目录，互不干扰
function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

// ============================================================
// Read L3 短路
// ============================================================
describe('Read L3 短路对齐', () => {
  let registry, dir, file, origCwd;

  beforeEach(() => {
    resetReadState();
    dir = makeTmpDir('elf-read-l3-');
    file = path.join(dir, 'sample.txt');
    fs.writeFileSync(file, 'hello\nworld\n');
    registry = new ToolManager();
    registry.register(Read);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('首次读取返回内容并写 readFileState', async () => {
    const r1 = await registry.execute('Read', { file_path: file });
    assert.match(r1, /^1\thello/);
    assert.ok(getReadState(file), '应写入 readFileState');
    assert.equal(getReadState(file).isPartialView, false);
  });

  it('重读未变文件 → 返回 Wasted call，不含文件内容', async () => {
    const r1 = await registry.execute('Read', { file_path: file });
    const ts1 = getReadState(file).timestamp;

    const r2 = await registry.execute('Read', { file_path: file });
    assert.match(r2, /Wasted call — file unchanged/);
    assert.ok(!r2.includes('hello'), '不应返回文件内容');
    // ts 不应前进
    assert.equal(getReadState(file).timestamp, ts1, 'timestamp 不刷新');
  });

  it('重读已变文件 → 正常返回新内容', async () => {
    await registry.execute('Read', { file_path: file });
    // 修改文件（mtime 推进）
    await new Promise(res => setTimeout(res, 20));
    fs.writeFileSync(file, 'hello\nCHANGED\n');

    const r2 = await registry.execute('Read', { file_path: file });
    assert.match(r2, /CHANGED/);
    assert.ok(!r2.includes('Wasted call'), '变了的文件不应短路');
  });

  it('部分读取(offset/limit)不短路 → 正常返回', async () => {
    await registry.execute('Read', { file_path: file });
    const r2 = await registry.execute('Read', { file_path: file, offset: 1, limit: 1 });
    assert.match(r2, /^1\thello/);
    assert.ok(!r2.includes('Wasted call'), '部分读取不应短路');
  });
});

// ============================================================
// detectChangedFiles + hook 注入
// ============================================================
describe('detectChangedFiles + hook 注入', () => {
  let dir, file, mm;

  beforeEach(() => {
    resetReadState();
    dir = makeTmpDir('elf-detect-');
    file = path.join(dir, 'tracked.txt');
    fs.writeFileSync(file, 'v1\n');
    mm = new MessageManager({
      systemPrompt: '', memoryTokenLimit: 99999, dataDir: null,
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 辅助：先把文件置入 readFileState（模拟曾 Read 过）
  async function seedRead(content, ts) {
    const { markRead } = await import('../engine/tools/read_state.js');
    markRead(file, { content, timestamp: ts });
  }

  it('文件未变 → 不产消息', async () => {
    const mtime = Math.floor(fs.statSync(file).mtimeMs);
    await seedRead('v1\n', mtime);
    await detectChangedFiles(mm);
    assert.equal(mm.messages.length, 0, '未变不应产消息');
  });

  it('文件被外部修改 → 产 file_changed isMeta 消息且带 diff', async () => {
    await seedRead('v1\n', 1);  // 旧 ts
    await new Promise(res => setTimeout(res, 20));
    fs.writeFileSync(file, 'v2\n'); // mtime 推进 + 内容变

    await detectChangedFiles(mm);
    assert.equal(mm.messages.length, 1, '应产 1 条消息');
    const m = mm.messages[0];
    assert.equal(m.role, 'user');
    assert.equal(m.isMeta, true);
    assert.equal(m.metaTag, 'file_changed');
    assert.match(m.content, /Note:.*was modified/);
    assert.match(m.content, /v1|v2/, '应含 diff 片段');
  });

  it('产消息后 readFileState 刷新 → 再跑不重复产', async () => {
    await seedRead('v1\n', 1);
    await new Promise(res => setTimeout(res, 20));
    fs.writeFileSync(file, 'v2\n');

    await detectChangedFiles(mm);
    assert.equal(mm.messages.length, 1, '第一次产 1 条');

    await detectChangedFiles(mm);
    assert.equal(mm.messages.length, 1, '第二次不重复产');
  });

  it('文件被删 → 清理 readFileState', async () => {
    await seedRead('v1\n', 1);
    fs.unlinkSync(file);
    await detectChangedFiles(mm);
    assert.equal(mm.messages.length, 0, '删除不产变更消息');
    assert.equal(getReadState(file), null, '应清理 readFileState');
  });

  it('部分读取文件跳过变更检测', async () => {
    const { markRead } = await import('../engine/tools/read_state.js');
    await new Promise(res => setTimeout(res, 20));
    fs.writeFileSync(file, 'v2\n');
    markRead(file, { content: 'v1\n', timestamp: 1, offset: 1, limit: 5 });

    await detectChangedFiles(mm);
    assert.equal(mm.messages.length, 0, '部分读取不被检测');
  });
});

// ============================================================
// Bash 输出落盘可回读
// ============================================================
describe('Bash 输出落盘可回读', () => {
  let registry;
  beforeEach(() => {
    registry = new ToolManager();
    registry.register(Bash);
  });

  it('小输出 → 直接返回，不落盘', async () => {
    const r = await registry.execute('Bash', { command: 'echo hello' });
    assert.ok(r.includes('hello'));
    assert.ok(!r.includes('saved to'), '小输出不应落盘');
  });

  it('大输出 → 落盘并提示路径', async () => {
    const r = await registry.execute('Bash', {
      command: 'head -c 40000 /dev/zero | tr "\\0" "x"'
    });
    assert.match(r, /saved to:/, '应含 saved to 提示');
    const m = r.match(/saved to:\s*(\S+)/);
    assert.ok(m, '应能提取路径');
    const savedPath = m[1].replace(/—.*$/, '').trim();
    assert.ok(fs.existsSync(savedPath), '落盘文件应存在');
    const content = fs.readFileSync(savedPath, 'utf-8');
    assert.ok(content.length > 30000, '落盘文件含完整输出');
    assert.match(content, /# Command:/, '落盘文件含 Command banner');
  });

  it('落盘文件可被 Read 回读', async () => {
    const bashR = await registry.execute('Bash', {
      command: 'head -c 40000 /dev/zero | tr "\\0" "y"'
    });
    const m = bashR.match(/saved to:\s*(\S+)/);
    const savedPath = m[1].replace(/—.*$/, '').trim();

    resetReadState();
    const readReg = new ToolManager();
    readReg.register(Read);
    const readR = await readReg.execute('Read', { file_path: savedPath });
    assert.match(readR, /# Command:/, 'Read 能读回落盘文件');
    assert.ok(readR.includes('yyyy'), '含输出内容');
  });

  it('exit code 非0 → stderr 也落盘', async () => {
    const r = await registry.execute('Bash', {
      command: 'head -c 40000 /dev/zero | tr "\\0" "z" >&2; exit 3'
    });
    assert.match(r, /^Exit code 3/);
    assert.match(r, /saved to:/);
    const m = r.match(/saved to:\s*(\S+)/);
    const savedPath = m[1].replace(/—.*$/, '').trim();
    const content = fs.readFileSync(savedPath, 'utf-8');
    assert.match(content, /STDERR/, '落盘含 STDERR 段');
  });
});

// ============================================================
// Glob mtime 排序 + .gitignore
// ============================================================
describe('Glob mtime 排序 + .gitignore', () => {
  let dir, origCwd;
  const now = Date.now();

  beforeEach(() => {
    dir = makeTmpDir('elf-glob-extra-');
    origCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function touch(p, content, mtimeOffset) {
    fs.writeFileSync(p, content);
    const st = mtimeOffset != null ? new Date(now + mtimeOffset) : new Date();
    fs.utimesSync(p, st, st);
  }

  it('结果按 mtime 倒序（最近修改优先）', async () => {
    touch(path.join(dir, 'old.js'), 'x', -10000);
    touch(path.join(dir, 'new.js'), 'x', 0);
    touch(path.join(dir, 'mid.js'), 'x', -5000);

    const registry = new ToolManager();
    registry.register(Glob);
    const r = await registry.execute('Glob', { pattern: '*.js' });
    const names = r.split('\n').map(l => l.split(' ')[0]);
    assert.equal(names[0], 'new.js', '最新文件排第一');
    assert.equal(names[1], 'mid.js');
    assert.equal(names[2], 'old.js');
  });

  it('.gitignore 命中文件 → 排除', async () => {
    touch(path.join(dir, 'keep.js'), 'x');
    touch(path.join(dir, 'ignored.js'), 'x');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.js\n');

    const registry = new ToolManager();
    registry.register(Glob);
    const r = await registry.execute('Glob', { pattern: '*.js' });
    const names = r.split('\n').map(l => l.split(' ')[0]);
    assert.ok(names.includes('keep.js'));
    assert.ok(!names.includes('ignored.js'), 'gitignore 命中的应排除');
    // .gitignore 自身不应匹配 *.js
    assert.ok(!names.includes('.gitignore'));
  });

  it('.gitignore 命中目录 → 整棵子树排除', async () => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    touch(path.join(dir, 'dist', 'bundle.js'), 'x');
    touch(path.join(dir, 'src.js'), 'x');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');

    const registry = new ToolManager();
    registry.register(Glob);
    const r = await registry.execute('Glob', { pattern: '**/*.js' });
    assert.ok(r.includes('src.js'));
    assert.ok(!r.includes('dist/bundle.js'), 'gitignore 目录应整树排除');
  });

  it('! 取反规则可恢复匹配', async () => {
    touch(path.join(dir, 'a.log'), 'x');
    touch(path.join(dir, 'keep.log'), 'x');
    fs.writeFileSync(path.join(dir, '.gitignore'), '*.log\n!keep.log\n');

    const registry = new ToolManager();
    registry.register(Glob);
    const r = await registry.execute('Glob', { pattern: '*.log' });
    assert.ok(r.includes('keep.log'), '取反规则应保留');
    assert.ok(!r.includes('a.log'), '普通规则应排除');
  });

  it('嵌套子目录 .gitignore 叠加', async () => {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    touch(path.join(dir, 'sub', 'a.js'), 'x');
    touch(path.join(dir, 'sub', 'b.js'), 'x');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'b.js\n');          // 根级排除所有 b.js
    fs.writeFileSync(path.join(dir, 'sub', '.gitignore'), '!a.js\n');  // 子级恢复 a.js?

    const registry = new ToolManager();
    registry.register(Glob);
    const r = await registry.execute('Glob', { pattern: '**/*.js' });
    // 简化语义：根级 b.js 排除 a.js 不受影响
    assert.ok(!r.includes('sub/b.js'), '根级 gitignore 排除 b.js');
  });

  it('无 .gitignore → 回退 DEFAULT_EXCLUDES（node_modules）', async () => {
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    touch(path.join(dir, 'node_modules', 'dep.js'), 'x');
    touch(path.join(dir, 'main.js'), 'x');

    const registry = new ToolManager();
    registry.register(Glob);
    const r = await registry.execute('Glob', { pattern: '**/*.js' });
    assert.ok(r.includes('main.js'));
    assert.ok(!r.includes('node_modules'), 'node_modules 默认排除');
  });
});