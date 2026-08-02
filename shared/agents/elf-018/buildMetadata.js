/**
 * buildMetadata — DM agent (elf-018) 专属：自动组装设定集 metadata。
 * 供 agent.js _buildMetadata() 和 gateway game-state API 共用，保证格式一致。
 *
 * 格式：按目录分组，路径用通配符写一遍，下列条目 name: description。
 */
import fs from 'fs';
import path from 'path';

/**
 * @param {string} loreDir — runtime/lore 绝对路径
 * @returns {string} metadata 文本（空则返回 ''）
 */
export function buildMetadata(loreDir) {
  const read = (p) => { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch { return ''; } };
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
    } catch {}
    return { pattern, items };
  };

  const groups = [
    scanDir('characters', 'lore/characters/<角色名>.md'),
    scanDir('locations', 'lore/locations/<地点名>.md'),
    scanDir('quests', 'lore/quests/<任务名>.md'),
    scanDir('items', 'lore/items/<物品名>.md'),
    scanDir('skills', 'lore/skills/<技能名>.md'),
  ];

  const single = (file) => {
    const e = parseMd(read(path.join(loreDir, file)));
    return e ? { pattern: `lore/${file}`, items: [e] } : null;
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
