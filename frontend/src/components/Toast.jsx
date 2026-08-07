import React, { useEffect, useState } from 'react';

/**
 * 把 notice 字段拼成居中文案。
 *   string/有 text      → 直接用
 *   kind:'retry'        → {name}(id) LLM 请求失败，重试第 {attempt} 次
 *   kind:'error' + 重试上下文 → {name}(id) LLM 请求失败，已重试 {maxRetries} 次仍失败：{error}
 *   kind:'error' 其他   → {name}(id) {error}（模型未配置/工具失败/max 迭代等非重试终端错误）
 *   其余                → {text || '...'}
 */
export function formatNotice(f) {
  if (!f) return '';
  if (typeof f === 'string') return f;
  if (f.text) return f.text;
  const name = f.memberName || f.agentId || '';
  const tag = name ? `${name}(${f.agentId || ''})` : (f.agentId || '');
  if (f.kind === 'retry') {
    const n = f.attempt ?? '?';
    return `${tag} LLM 请求失败，重试第 ${n} 次`;
  }
  if (f.kind === 'error') {
    if (f.maxRetries != null || f.attempt != null) {
      const n = f.maxRetries ?? f.attempt;
      return `${tag} LLM 请求失败，已重试 ${n} 次仍失败：${f.error || ''}`;
    }
    return tag ? `${tag} ${f.error || ''}` : (f.error || '');
  }
  return tag ? `${tag} ${f.error || ''}` : (f.error || '');
}

/**
 * 单条横幅，自带 3s 显示 + 淡出计时，到点调 remove 自销毁。多条互不干扰。
 */
function ToastItem({ toast, remove, styles, showMs = 3000, fadeMs = 400 }) {
  const [fading, setFading] = useState(false);
  const text = formatNotice(toast.fields);

  useEffect(() => {
    if (!text) return;
    setFading(false);
    const t1 = setTimeout(() => setFading(true), showMs);
    return () => clearTimeout(t1);
  }, [text, toast.id, showMs]);

  useEffect(() => {
    if (!fading) return;
    const t = setTimeout(() => remove(toast.id), fadeMs);
    return () => clearTimeout(t);
  }, [fading, fadeMs, remove, toast.id]);

  if (!text) return null;
  return <div className={`${styles.toast} ${fading ? styles.toastFade : ''}`}>{text}</div>;
}

/**
 * 共享居中横幅栈：多条竖排，各自独立计时/淡出、互不干扰。
 * @param {object[]} toasts       store 的 toast 列表 [{id, fields}]
 * @param {Function} remove       remove(id) 由 store 提供
 * @param {object} styles         CSS module { toast, toastFade, toastStack }
 */
export default function ToastStack({ toasts = [], remove, styles }) {
  if (!toasts.length) return null;
  return (
    <div className={styles.toastStack}>
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} remove={remove} styles={styles} />
      ))}
    </div>
  );
}