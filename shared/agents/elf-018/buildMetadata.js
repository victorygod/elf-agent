/**
 * buildMetadata — DM agent (elf-018) 专属：自动组装设定集 metadata。
 * 供 agent.js _buildMetadata() 和 gateway game-state API 共用，保证格式一致。
 *
 * 格式：按目录分组，路径用通配符写一遍，下列条目 name: description。
 */
import fs from 'fs';
import path from 'path';
import { parseFrontmatter } from '../../../engine/skills/parser.js';

/**
 * @param {string} loreDir — runtime/lore 绝对路径
 * @returns {string} metadata 文本（空则返回 ''）
 */
export function buildMetadata(loreDir) {
  const read = (p) => { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch (e) { console.warn(`[buildMetadata] 读 ${p} 失败: ${e.message}`); return ''; } };
  const parseMd = (txt) => {
    const fm = txt.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return null;
    const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    return name ? { name, desc: desc || '' } : null;
  };

  const scanDir = (sub, pattern) => {
    const dir = path.join(loreDir, sub);
    const items = [];
    try {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md') && !x.endsWith('.prev.md'))) {
        const e = parseMd(read(path.join(dir, f)));
        if (e) items.push(e);
      }
    } catch (e) { if (e?.code !== 'ENOENT') console.warn(`[buildMetadata] 扫 ${dir} 失败: ${e.message}`); }
    return { pattern, items };
  };

  const groups = [
    scanDir('characters', path.join(loreDir, 'characters', '<角色名>.md')),
    scanDir('locations', path.join(loreDir, 'locations', '<地点名>.md')),
    scanDir('quests', path.join(loreDir, 'quests', '<任务名>.md')),
    scanDir('items', path.join(loreDir, 'items', '<物品名>.md')),
    scanDir('skills', path.join(loreDir, 'skills', '<技能名>.md')),
  ];

  const single = (file) => {
    const e = parseMd(read(path.join(loreDir, file)));
    return e ? { pattern: path.join(loreDir, file), items: [e] } : null;
  };
  const prot = single('user_profile.md');
  const st = single('state.md');

  const lines = ['## 设定集 metadata'];
  if (prot) { lines.push(prot.pattern); lines.push(`- ${prot.items[0].name}: ${prot.items[0].desc}`); }
  for (const g of groups) {
    lines.push(g.pattern);
    if (g.items.length === 0) { lines.push('（暂无）'); continue; }
    for (const it of g.items) lines.push(`- ${it.name}: ${it.desc}`);
  }
  if (st) { lines.push(st.pattern); lines.push(`- ${st.items[0].name}: ${st.items[0].desc}`); }

  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * buildStyleMetadata — DM agent (elf-018) 专属：扫描 styles 目录，组装「语言风格 metadata」。
 * 供 agent.js _outlineSystem() 注入 outline loop system，让大纲 LLM 据简介选风格。
 *
 * 格式：<文件名.md> - description（不写绝对路径）。风格文件 frontmatter 只含 description（name 即文件名）。
 * @param {string} stylesDir — config/styles 绝对路径
 * @returns {string} metadata 文本（空则返回 ''）
 */
export function buildStyleMetadata(stylesDir) {
  const DEFAULT_STYLE_FILE = 'default_style.md';   // 默认风格恒在 render system 末尾常驻，不列入可选 metadata
  const read = (p) => { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch (e) { console.warn(`[buildStyleMetadata] 读 ${p} 失败: ${e.message}`); return ''; } };
  const items = [];
  try {
    const files = fs.readdirSync(stylesDir)
      .filter((f) => f.endsWith('.md') && !f.endsWith('.prev.md') && f !== DEFAULT_STYLE_FILE)
      .sort();
    for (const f of files) {
      const { frontmatter } = parseFrontmatter(read(path.join(stylesDir, f)));
      items.push({ file: f, desc: (frontmatter.description || '').trim() });
    }
  } catch (e) { if (e?.code !== 'ENOENT') console.warn(`[buildStyleMetadata] 扫 ${stylesDir} 失败: ${e.message}`); }
  if (!items.length) return '';
  const lines = ['## 语言风格 metadata（default_style 常驻 system 不在此列；大纲「语言风格」节点名一个 `<文件名.md>`，无契合则写「无」）'];
  for (const it of items) lines.push(`- <${it.file}> - ${it.desc || '（无简介）'}`);
  return lines.join('\n');
}
