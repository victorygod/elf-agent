import React, { useMemo } from 'react';
import { lineDiff, charDiff } from '../utils/diff.js';
import styles from './EditDiff.module.css';

/**
 * 给相邻的 del/add 块做字符级高亮。
 * 把相同「形状」的 del 行与紧随其后的 add 行配对（取较长/较短补齐），
 * 对每对跑 charDiff，把行内真正改动的字符高亮出来。
 *
 * 返回与 lineRows 同长度的数组，元素为：
 *   context 行 → { type:'context', segs:null }
 *   del/add 行 → { type, segs:[{type,text}] }（charDiff 分段）
 *   未配对的孤立 del/add 行 → { type, segs:null }（整行无高亮）
 */
function withInlineHighlight(lineRows) {
  const decorated = lineRows.map(r => ({ ...r, segs: null }));
  for (let i = 0; i < lineRows.length; i++) {
    if (lineRows[i].type !== 'del') continue;

    // 收集从 i 开始的连续 del 块
    let j = i;
    while (j < lineRows.length && lineRows[j].type === 'del') j++;
    const delBlock = lineRows.slice(i, j);

    // 紧跟的 add 块
    let k = j;
    while (k < lineRows.length && lineRows[k].type === 'add') k++;
    const addBlock = lineRows.slice(j, k);

    if (addBlock.length === 0) continue; // 纯删除块，无 add 可配对 → 不高亮

    const pairCount = Math.max(delBlock.length, addBlock.length);
    for (let p = 0; p < pairCount; p++) {
      const dl = delBlock[p] ? delBlock[p].text : null;
      const al = addBlock[p] ? addBlock[p].text : null;

      if (dl !== null && al !== null) {
        const segs = charDiff(dl, al);
        decorated[i + p].segs = segs.filter(s => s.type === 'del' || s.type === 'context');
        decorated[j + p].segs = segs.filter(s => s.type === 'add' || s.type === 'context');
      } else if (dl !== null) {
        // del 比 add 多，多出的 del 整行删除，不高亮
      } else {
        // add 比 del 多，多出的 add 整行新增，不高亮
      }
    }
    i = k - 1;
  }
  return decorated;
}

function SegmentedLine({ segs, className }) {
  return (
    <span className={className}>
      {segs.map((s, k) => {
        if (s.type === 'context') return <span key={k}>{s.text}</span>;
        return <span key={k} className={s.type === 'del' ? styles.delInline : styles.addInline}>{s.text}</span>;
      })}
    </span>
  );
}

export default function EditDiff({ args }) {
  const { file_path, old_string = '', new_string = '' } = args || {};

  const rows = useMemo(() => {
    const lineRows = lineDiff(old_string, new_string);
    return withInlineHighlight(lineRows);
  }, [old_string, new_string]);

  return (
    <div className={styles.diff}>
      {file_path && (
        <div className={styles.header}>
          <span className={styles.fileIcon}>🔧</span>
          <span className={styles.filePath} title={file_path}>{file_path}</span>
        </div>
      )}
      <div className={styles.body}>
        {rows.map((row, i) => {
          const cls = row.type === 'del' ? styles.del : row.type === 'add' ? styles.add : styles.context;
          const prefix = row.type === 'del' ? '-' : row.type === 'add' ? '+' : ' ';
          return (
            <div key={i} className={`${styles.line} ${cls}`}>
              <span className={styles.gutter}>{prefix}</span>
              {row.segs
                ? <SegmentedLine segs={row.segs} />
                : <span>{row.text || ' '}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
