/**
 * Skill 管理（平台级，跨 agent 共享）
 *
 * 单一 skill 目录 ~/.elf/skills/<name>/SKILL.md（无 project 级，所有项目共享一套）。
 *   所有路径操作限定在该根下，禁止逃逸（白名单校验）。
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

/** 唯一根目录：~/.elf/skills */
export function skillRoot() {
  return path.join(os.homedir(), '.elf', 'skills');
}

/** 校验 skill 名合法 */
function assertValidName(name) {
  if (!name || !NAME_RE.test(name)) {
    throw new Error(`invalid skill name: ${name}`);
  }
}

/**
 * 列出 ~/.elf/skills 下所有 skill。
 * @returns {Array<{name, description, skillRoot, contentLength}>}
 */
export function listSkills() {
  const root = skillRoot();
  const sub = new SkillRegistry();
  sub._loadDir(root);
  return sub.getAll().map(s => ({
    name: s.name,
    description: s.description || '',
    whenToUse: s.whenToUse || '',
    skillRoot: s.skillRoot,
    contentLength: s.contentLength,
  }));
}

/**
 * 读单个 skill 的 SKILL.md 全文（用于前端预览）。
 */
export function getSkillDetail(name) {
  assertValidName(name);
  const root = skillRoot();
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
export function deleteSkill(name) {
  assertValidName(name);
  const root = skillRoot();
  const dir = path.join(root, name);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error('path escape detected');
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`skill not found: ${name}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { name, deleted: true };
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
  const root = skillRoot();
  fs.mkdirSync(root, { recursive: true });

  const dest = path.join(root, name);
  const destResolved = path.resolve(dest);
  if (!destResolved.startsWith(path.resolve(root))) {
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