/**
 * Skill 注册表（L0：对象常驻但极轻）
 *
 * 扫描 skills 目录，为每个子目录的 SKILL.md 构造一个轻量 Skill 对象。
 * 对齐 Claude Code `WN8`/`Gp6`（cli.js:1637）：
 *  - skill 名永远取目录名（不取 frontmatter.name）
 *  - 对象只存 contentLength，不存正文（progressive disclosure）
 *  - description 缺失时从正文取第一个 # 标题兜底
 *  - 目录不存在 / 读不到 → 静默跳过，不中断加载
 *
 * 来源（本期 2 个，对齐 CC 的 user/project 概念）：
 *  - user：    ~/.elf/skills/<name>/SKILL.md
 *  - project：  <cwd>/.elf/skills/<name>/SKILL.md   （同名 project 覆盖 user）
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFrontmatter } from './parser.js';

// description 规范化：对齐 CC `SL`(cli.js:524) —— 字符串 trim，空→null
function normalizeDescription(desc) {
  if (desc == null) return null;
  if (typeof desc === 'string') return desc.trim() || null;
  if (typeof desc === 'number' || typeof desc === 'boolean') return String(desc);
  return null;
}

// 从正文取第一个 markdown 标题作 description 兜底，对齐 CC `qc(j, "Skill")`
function fallbackDescription(body) {
  const m = body.match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

// 两态布尔：对齐 CC `io()`，缺省返回 defaultValue
function parseBool(v, defaultValue) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return defaultValue;
}

export class SkillRegistry {
  constructor() {
    this.skills = new Map(); // name -> Skill 对象
  }

  /**
   * 扫描并加载所有 skill。project 覆盖 user。
   * 扫描并加载所有 skill。project 覆盖 user。
   * 每次调用都先清空再重扫——支持热更新（入口每轮重扫时，已删除的 skill 不会残留）。
   * @param {string} cwd - 工作目录
   */
  loadAll(cwd) {
    this.skills.clear();   // 热更新：重扫前清空，删除的 skill 不残留
    // ELF_SKILLS_USER_DIR 覆盖用户级目录（测试隔离用，生产留空走默认 ~/.elf/skills）
    const home = process.env.ELF_SKILLS_USER_DIR || os.homedir();
    const userDir = path.join(home, '.elf', 'skills');
    const projectDir = path.join(cwd, '.elf', 'skills');

    // 先 user 后 project，后者同名覆盖前者
    this._loadDir(userDir, 'user');
    this._loadDir(projectDir, 'project');
  }

  /**
   * 解析单个 skills 目录。异常静默吞掉（ENOENT/EACCES 返回空）。
   */
  _loadDir(dir, source) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = err?.code;
      if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
        // 非"目录不存在/无权限"的异常不静默，但仍不打断
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      this._loadOne(path.join(dir, entry.name), entry.name, source);
    }
  }

  _loadOne(dir, name, source) {
    // 大小写不敏感找 SKILL.md，取第一个
    let fileName;
    try {
      const files = fs.readdirSync(dir);
      fileName = files.find(f => /^skill\.md$/i.test(f));
    } catch (err) {
      return;
    }
    if (!fileName) return;

    const filePath = path.join(dir, fileName);
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      return;
    }

    const { frontmatter, body } = parseFrontmatter(text);
    const description = normalizeDescription(frontmatter.description) ?? fallbackDescription(body) ?? '';
    const contentLength = body.length;

    const skill = {
      type: 'prompt',
      name,                       // 目录名 = /命令名 + 权限 key
      displayName: frontmatter.name || undefined,
      description,
      hasUserSpecifiedDescription: normalizeDescription(frontmatter.description) != null,
      whenToUse: frontmatter.when_to_use ? String(frontmatter.when_to_use).trim() || undefined : undefined,
      userInvocable: frontmatter['user-invocable'] === undefined
        ? true
        : parseBool(frontmatter['user-invocable'], true),
      disableModelInvocation: parseBool(frontmatter['disable-model-invocation'], false),
      contentLength,
      skillRoot: dir,             // skill 所在目录绝对路径
      source,
      loadedFrom: 'skills',
      context: frontmatter.context === 'fork' ? 'fork' : undefined,
      // 高级字段本期记录但不生效：allowedTools / model / agent / arguments / paths / hooks / version
      filePath,
    };

    this.skills.set(name, skill);
  }

  /** 按名取 skill */
  get(name) {
    return this.skills.get(name);
  }

  /** 全部 skill */
  getAll() {
    return Array.from(this.skills.values());
  }

  /**
   * 模型可见 skill：对齐 CC `hR`(cli.js:6441)
   *  可见 = type==='prompt' && !disableModelInvocation && (hasUserSpecifiedDescription || whenToUse || loadedFrom==='skills')
   *  本期所有 skill loadedFrom 都是 'skills'，故简化为：!disableModelInvocation
   */
  getVisible() {
    return this.getAll().filter(s =>
      s.type === 'prompt' && !s.disableModelInvocation
    );
  }
}