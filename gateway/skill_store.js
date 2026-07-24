/**
 * Skill 管理（平台级，跨 agent 共享）
 *
 * skill 目录是平台级而非 agent 级（agent 跑起来 cwd=项目根，所有 agent 共享）：
 *  - user:    ~/.elf/skills/<name>/SKILL.md
 *  - project:  <cwd>/.elf/skills/<name>/SKILL.md   （同名 project 覆盖 user）
 *
 * 所有路径操作都限定在这两个固定根下，禁止逃逸（白名单校验）。
 *
 * 列 skill 复用 engine/skills/registry.js 的 SkillRegistry；
 * 删除用 fs.rmSync，安装用 fs.cpSync（Node 18+）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { SkillRegistry } from '../engine/skills/registry.js';

// skill 名合法字符（防路径逃逸）
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** 两个固定根 */
export function skillRoots() {
  return {
    user: path.join(os.homedir(), '.elf', 'skills'),
    project: path.join(process.cwd(), '.elf', 'skills'),
  };
}

/** source → 根目录；非法 source 抛错 */
export function resolveSkillRoot(source) {
  const roots = skillRoots();
  const root = roots[source];
  if (!root) throw new Error(`invalid source: ${source}`);
  return root;
}

/** 校验 skill 名合法 */
function assertValidName(name) {
  if (!name || !NAME_RE.test(name)) {
    throw new Error(`invalid skill name: ${name}`);
  }
}

/**
 * 列出 user + project 两个目录下所有 skill。
 * 用 SkillRegistry 扫描（project 覆盖 user），但这里要分别列出两目录原始内容，
 * 故不直接用 registry 的去重结果，而是分别扫两个目录 + 分别 parse。
 * @returns {Array<{name, description, source, skillRoot, exists}>}
 */
export function listSkills() {
  const roots = skillRoots();
  const result = [];
  const reg = new SkillRegistry();
  for (const source of ['user', 'project']) {
    const root = roots[source];
    const sub = new SkillRegistry();
    sub._loadDir(root, source);
    for (const s of sub.getAll()) {
      result.push({
        name: s.name,
        description: s.description || '',
        whenToUse: s.whenToUse || '',
        source,
        skillRoot: s.skillRoot,
        contentLength: s.contentLength,
      });
    }
  }
  return result;
}

/**
 * 读单个 skill 的 SKILL.md 全文（用于前端预览）。
 */
export function getSkillDetail(source, name) {
  assertValidName(name);
  const root = resolveSkillRoot(source);
  const filePath = path.join(root, name, 'SKILL.md');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error('path escape detected');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`skill not found: ${name}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * 删除一个 skill 目录。
 */
export function deleteSkill(source, name) {
  assertValidName(name);
  const root = resolveSkillRoot(source);
  const dir = path.join(root, name);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error('path escape detected');
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`skill not found: ${name}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { name, source, deleted: true };
}

/**
 * 安装 skill：把一个目录复制到 ~/.elf/skills/<basename>。
 * @param {string} sourcePath - 待安装的源目录绝对路径
 * @returns {{name, skillRoot}}
 */
export function installSkill(sourcePath) {
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw new Error('sourcePath required');
  }
  const src = path.resolve(sourcePath);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new Error(`source directory not found: ${sourcePath}`);
  }
  // 源目录里必须有 SKILL.md（大小写不敏感），否则不是 skill
  const files = fs.readdirSync(src);
  if (!files.some(f => /^skill\.md$/i.test(f))) {
    throw new Error('source directory has no SKILL.md');
  }

  const name = path.basename(src);
  assertValidName(name);
  const userRoot = skillRoots().user;
  fs.mkdirSync(userRoot, { recursive: true });

  const dest = path.join(userRoot, name);
  const destResolved = path.resolve(dest);
  if (!destResolved.startsWith(path.resolve(userRoot))) {
    throw new Error('path escape detected');
  }
  if (fs.existsSync(dest)) {
    throw new Error(`skill already exists: ${name}`);
  }
  fs.cpSync(src, dest, { recursive: true });
  return { name, skillRoot: dest };
}

/**
 * 浏览目录：返回 dir 下的子项（仅目录，供前端选 skill 源目录）。
 * 安全：dir 必须是绝对路径且真实存在；不限制根（用户可浏览任意目录挑 skill）。
 * @param {string} dir
 * @returns {{current, entries: Array<{name, path, isDirectory}>}}
 */
export function browseDirs(dir) {
  // 空 dir 默认回退到 home（前端首次打开浏览弹窗时不传 dir）
  if (!dir || typeof dir !== 'string' || dir.trim() === '') {
    return { current: os.homedir(), entries: listSubDirs(os.homedir()) };
  }
  const target = path.resolve(dir);
  if (!path.isAbsolute(target)) {
    throw new Error('dir must be absolute');
  }
  // 不存在则回退到 home
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return { current: os.homedir(), entries: listSubDirs(os.homedir()) };
  }
  return { current: target, entries: listSubDirs(target) };
}

function listSubDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  // 目录优先排在前面，同类型按名字排序。文件也返回（前端标灰不可点），
  // 这样用户能直接看到哪个目录里有 SKILL.md。
  return entries
    .filter(e => e.isDirectory() || e.isFile())
    .map(e => ({
      name: e.name,
      path: path.join(dir, e.name),
      isDirectory: e.isDirectory(),
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}