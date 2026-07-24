import React, { useEffect } from 'react';
import styles from './ConfirmModal.module.css';

/**
 * 页内确认弹窗 —— 替代原生 window.confirm()。
 *
 * 原生 confirm() 在某些环境（页面非激活/非最前窗口 / Electron）会被浏览器屏蔽并返回
 * false，导致按钮看起来点不动。改为页内 Modal 由 React 渲染，避开创伤范围。
 *
 * @param {object} props
 * @param {boolean} props.open - 是否显示
 * @param {string} [props.title] - 标题
 * @param {string} props.message - 正文
 * @param {string} [props.confirmText='确定'] - 确认按钮文案
 * @param {string} [props.cancelText='取消'] - 取消按钮文案
 * @param {'danger'|'warning'|'primary'} [props.tone='danger'] - 确认按钮色调
 * @param {() => void} props.onConfirm - 确认回调
 * @param {() => void} props.onCancel - 取消/关闭回调
 */
export default function ConfirmModal({
  open,
  title = '确认操作',
  message,
  confirmText = '确定',
  cancelText = '取消',
  tone = 'danger',
  onConfirm,
  onCancel,
}) {
  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const toneClass =
    tone === 'warning' ? styles.btnWarning
    : tone === 'primary' ? styles.btnPrimary
    : styles.btnDanger;

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.title}>{title}</div>
        <div className={styles.message}>{message}</div>
        <div className={styles.actions}>
          <button className={`${styles.btn} ${styles.btnDefault}`} onClick={onCancel}>{cancelText}</button>
          <button className={`${styles.btn} ${toneClass}`} onClick={onConfirm} autoFocus>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}