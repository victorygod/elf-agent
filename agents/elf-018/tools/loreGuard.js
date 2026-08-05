/**
 * lore 作用域守卫（elf-018 专用 Read/Write/Edit 共用）
 *
 * - isInsideLore：路径解析后须落在 lore 目录内（防 .. 逃逸、禁目录本身）
 * - validateFrontmatter：lore 文件须以 YAML frontmatter 开头且含 name 与 description
 *   （对齐 seeds：---\nname: ...\ndescription: ...\n---）
 * - applyEdit：预算 old_string→new_string 的替换结果（不写盘），供 Edit 做后置 frontmatter 校验
 */
import path from 'path';

export function isInsideLore(filePath, loreRoot) {
  if (!filePath || !loreRoot) return false;
  const resolved = path.resolve(filePath);
  const root = path.resolve(loreRoot);
  const rel = path.relative(root, resolved);
  // rel==='' 是 lore 目录本身（禁）；rel 以 ../ 开头是逃逸；绝对相对路径（盘符差异）也禁
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

export function validateFrontmatter(content) {
  if (typeof content !== 'string' || content.length < 8) return false;
  const lines = content.split('\n');
  if (lines[0] !== '---') return false;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end <= 1) return false;   // 闭合前须至少一行字段
  const fm = lines.slice(1, end).join('\n');
  return /^name:\s*\S/m.test(fm) && /^description:\s*\S/m.test(fm);
}

/** 从 frontmatter 提取 name 字段值 */
export function parseFrontmatterName(content) {
  if (typeof content !== 'string') return '';
  const lines = content.split('\n');
  if (lines[0] !== '---') return '';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const m = lines[i].match(/^name:\s*(.+)/);
    if (m) return m[1].trim();
  }
  return '';
}

/** 检查 filePath 是否落在 lore/characters 目录内 */
export function isUnderCharacters(filePath, loreRoot) {
  if (!filePath || !loreRoot) return false;
  const charsDir = path.join(path.resolve(loreRoot), 'characters');
  const fp = path.resolve(filePath);
  const rel = path.relative(charsDir, fp);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 预算替换结果（不写盘）。ok=false 时 error 给出原因；ok=true 时 result 为改后全文。 */
export function applyEdit(content, oldString, newString, replaceAll) {
  if (oldString === newString) return { ok: false, error: 'old_string and new_string are identical' };
  const escaped = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const count = (content.match(new RegExp(escaped, 'g')) || []).length;
  if (count === 0) return { ok: false, error: 'old_string not found' };
  if (count > 1 && !replaceAll) return { ok: false, error: `old_string matched ${count} times` };
  const result = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
  return { ok: true, result };
}