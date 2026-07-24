import React, { useEffect, useRef } from 'react';
import styles from './RewindMenu.module.css';

/**
 * Rewind 菜单浮层（输入框上方）—— 纯展示 + 触屏交互
 *
 * 列出快照包（每个用户 prompt 一个），最近排最上、默认聚焦第一项。
 * 键盘操作（↑↓/Enter/Esc）由父组件的 window keydown 监听统一处理，
 * 通过 selectedIndex/onSelect/onConfirm/onClose 控制——避免多个 window
 * capture 监听冲突。
 *
 * @param {Object} props
 * @param {Array<{id,createdAt,prompt}>} props.checkpoints
 * @param {number} props.selectedIndex
 * @param {function(number): void} props.onSelect   - 选中项索引
 * @param {function(): void} props.onConfirm        - 回退到当前选中
 * @param {function(): void} props.onClose
 */
export default function RewindMenu({ checkpoints, selectedIndex, onSelect, onConfirm, onClose }) {
  const count = checkpoints.length;
  const empty = count === 0;
  const listRef = useRef(null);

  // 菜单打开时默认聚焦最近一项（列表最下），把列表滚到底让选中项可见
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, []);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.menu} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>Rewind</div>
        {empty ? (
          <div className={styles.empty}>暂无可回退状态</div>
        ) : (
          <>
            <div className={styles.list} ref={listRef}>
              {checkpoints.map((cp, i) => {
                const time = cp.createdAt ? new Date(cp.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
                const label = (cp.prompt || '').slice(0, 40) || '(无内容)';
                return (
                  <div
                    key={cp.id}
                    className={`${styles.item} ${i === selectedIndex ? styles.selected : ''}`}
                    onClick={() => {
                      onSelect(i);
                      onConfirm(i);   // 直接把被点的 index 传给 onConfirm，避免依赖尚未生效的 selectedIndex state
                    }}
                    title={cp.prompt}
                  >
                    <span className={styles.time}>{time}</span>
                    <span className={styles.label}>{label}</span>
                  </div>
                );
              })}
            </div>
            <div className={styles.footer}>
              <span className={styles.hint}>
                <kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 或点击回退 · <kbd>Esc</kbd> 关闭
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
