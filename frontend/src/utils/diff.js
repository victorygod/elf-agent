/**
 * diff.js — 行级 + 字符级 LCS diff（零依赖）
 *
 * 两者共用同一套 LCS DP + 回溯算法，仅输入单元不同（行 / 字符）。
 * 产出统一结构：[{ type: 'context' | 'del' | 'add', text }]
 *   - context: 公共部分（old、new 都有）
 *   - del:     仅 old（删除）
 *   - add:     仅 new（新增）
 */

/**
 * 通用 LCS diff：对任意 token 序列产出 context/del/add。
 * @param {any[]} a  old 序列
 * @param {any[]} b  new 序列
 * @param {(t:any)=>string} toString token → 字符串
 * @returns {{type:string,text:string}[]}
 */
function lcsDiff(a, b, toString) {
  const n = a.length;
  const m = b.length;

  // DP 表：dp[i][j] = a[0..i) 与 b[0..j) 的 LCS 长度
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 回溯
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: toString(a[i]) });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: toString(a[i]) });
      i++;
    } else {
      out.push({ type: 'add', text: toString(b[j]) });
      j++;
    }
  }
  while (i < n) { out.push({ type: 'del', text: toString(a[i++]) }); }
  while (j < m) { out.push({ type: 'add', text: toString(b[j++]) }); }
  return out;
}

/**
 * 行级 diff。
 * @param {string} oldStr
 * @param {string} newStr
 * @returns {{type:string,text:string}[]} 每项 text 为单行（不含 \n）
 */
export function lineDiff(oldStr, newStr) {
  // 用 split 保留空行；末尾换行造成的空行也会参与比较
  const a = oldStr.length ? oldStr.split('\n') : [];
  const b = newStr.length ? newStr.split('\n') : [];
  return lcsDiff(a, b, (t) => t);
}

/**
 * 字符级 diff，用于行内高亮。
 * @param {string} oldStr
 * @param {string} newStr
 * @returns {{type:string,text:string}[]} text 为单字符（合并连续同类型字符后可为多字符）
 */
export function charDiff(oldStr, newStr) {
  const a = Array.from(oldStr);
  const b = Array.from(newStr);
  const raw = lcsDiff(a, b, (t) => t);

  // 合并连续相同类型，减少渲染节点
  const merged = [];
  for (const part of raw) {
    const last = merged[merged.length - 1];
    if (last && last.type === part.type) {
      last.text += part.text;
    } else {
      merged.push({ type: part.type, text: part.text });
    }
  }
  return merged;
}
