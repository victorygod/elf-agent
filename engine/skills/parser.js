/**
 * SKILL.md frontmatter 解析
 *
 * 拆分文件顶部的 YAML frontmatter（--- 之间）与正文。对齐 Claude Code `SH`
 * (cli.js:524) 的行为：正则只在文件开头匹配，抓不到则返回空 frontmatter。
 *
 * 不引 npm YAML 依赖：逐行 `key: value` 解析，处理 true/false 布尔与引号字符串。
 * 覆盖 SKILL.md 用到的字段（description / when_to_use / user-invocable /
 * disable-model-invocation / model / context / agent / arguments / paths / version 等）。
 */

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;

/**
 * 解析 frontmatter 文本为对象。逐行 key:value，处理布尔与引号。
 * @param {string} fm - frontmatter 原文（不含 --- 分隔行）
 * @returns {object}
 */
function parseYaml(fm) {
  const obj = {};
  for (const rawLine of fm.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();

    if (value === '') {
      obj[key] = '';
      continue;
    }

    // 布尔
    if (value === 'true') { obj[key] = true; continue; }
    if (value === 'false') { obj[key] = false; continue; }

    // 引号字符串：去掉首尾配对的引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      obj[key] = value.slice(1, -1);
      continue;
    }

    obj[key] = value;
  }
  return obj;
}

/**
 * 拆分 frontmatter 与正文。
 * @param {string} text - SKILL.md 全文
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(text) {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: text };
  const fm = m[1] || '';
  const body = text.slice(m[0].length);
  return { frontmatter: parseYaml(fm), body };
}