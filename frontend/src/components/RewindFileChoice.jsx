import React from 'react';
import styles from './RewindMenu.module.css';

/**
 * Rewind 二段式菜单 —— 选了"带文件改动"的 checkpoint 后，二选一回退范围。
 * 复用 RewindMenu 的浮层样式。键盘 ↑↓/Enter/Esc 由父组件 window 监听路由，本组件纯展示+触屏。
 *
 * @param {Object} props
 * @param {string} [props.prompt]    - 待回退 checkpoint 的 prompt（头部展示上下文，截断）
 * @param {number} props.selected    - 0=对话+文件，1=只对话
 * @param {function(number): void} props.onSelect
 * @param {function(boolean): void} props.onConfirm - 传入 restoreFiles（true=对话+文件，false=只对话）
 * @param {function(): void} props.onBack   - Esc 返回 checkpoint 列表
 * @param {function(): void} props.onClose  - 点遮罩关闭菜单
 */
const OPTIONS = [
  { key: 'both', title: '回退对话和文件', desc: '撤销 Claude 对追踪文件的改动' },
  { key: 'conv', title: '只回退对话', desc: '保留当前文件，只回到那句话之前' },
];

export default function RewindFileChoice({ prompt, selected, onSelect, onConfirm, onBack, onClose }) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.menu} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>Rewind · 选择范围</div>
        {prompt ? (
          <div style={{ padding: '0 12px 8px', fontSize: 12, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {(prompt || '').slice(0, 40) || '(无内容)'}
          </div>
        ) : null}
        <div className={styles.list}>
          {OPTIONS.map((o, i) => (
            <div
              key={o.key}
              className={`${styles.item} ${i === selected ? styles.selected : ''}`}
              onClick={() => onConfirm(i === 0)}
              title={o.desc}
            >
              <span className={styles.label}>{o.title}</span>
            </div>
          ))}
        </div>
        <div className={styles.footer}>
          <span className={styles.hint}>
            <kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 确认 · <kbd>Esc</kbd> 返回
          </span>
        </div>
      </div>
    </div>
  );
}
