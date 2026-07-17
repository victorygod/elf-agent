/**
 * Skill 正文注入（L2）
 *
 * 触发时才读 SKILL.md 正文 + 变量替换。对齐 Claude Code `getPromptForCommand`
 * (cli.js:5352934)：
 *  1. 前缀 `Base directory for this skill: <skillRoot>\n\n<正文>`
 *  2. 路径变量 `${CLAUDE_SKILL_DIR}`（CC 原生名）/ `${SKILL_DIR}`（别名）→ skillRoot
 *  3. `${CLAUDE_SESSION_ID}` → 当前会话 ID
 *  4. `$ARGUMENTS` → argsStr 整体透传
 *
 * 本期不做：`!cmd` 动态预处理（QB）、命名参数 `$<argName>`、位置参数 `$0`/`$1`。
 */

import fs from 'fs';
import path from 'path';
import { parseFrontmatter } from './parser.js';

// 读 skill 正文（不含 frontmatter）。读不到返回空串。
function readBody(skill) {
  const filePath = path.join(skill.skillRoot, 'SKILL.md');
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return '';
  }
  const { body } = parseFrontmatter(text);
  return body;
}

/**
 * 取当前会话 ID。elf 没有 CC 的全局 session 概念，用进程级稳定 id 兜底。
 * 本期 ${CLAUDE_SESSION_ID} 主要供 skill 正文引用，无强语义要求。
 */
function sessionId() {
  if (typeof globalThis.__ELF_SESSION_ID__ === 'string') return globalThis.__ELF_SESSION_ID__;
  // 兜底：进程 pid + 启动时间戳，会话内稳定
  if (!globalThis.__ELF_SESSION_ID__) {
    globalThis.__ELF_SESSION_ID__ = `elf-${process.pid}`;
  }
  return globalThis.__ELF_SESSION_ID__;
}

/**
 * 生成 skill 触发后的注入正文。
 * @param {object} skill - Skill 对象（含 skillRoot）
 * @param {string} argsStr - 用户传入的参数字符串
 * @returns {string} 注入文本（已变量替换，含 Base directory 前缀）
 */
export function getPromptForCommand(skill, argsStr = '') {
  const skillRoot = skill.skillRoot || '';
  // win32 反斜杠转正斜杠，对齐 CC
  const dir = process.platform === 'win32' ? skillRoot.replace(/\\/g, '/') : skillRoot;

  let body = readBody(skill);

  // $ARGUMENTS 整体透传
  body = body.replace(/\$ARGUMENTS\b/g, argsStr);

  // 路径变量：CLAUDE_SKILL_DIR（CC 原生名）+ SKILL_DIR（别名）
  body = body.replace(/\$\{CLAUDE_SKILL_DIR\}/g, dir);
  body = body.replace(/\$\{SKILL_DIR\}/g, dir);

  // 会话 ID
  body = body.replace(/\$\{CLAUDE_SESSION_ID\}/g, sessionId());

  // 前缀：注明 skill 根目录
  const base = skillRoot ? `Base directory for this skill: ${skillRoot}\n\n` : '';
  return base + body;
}