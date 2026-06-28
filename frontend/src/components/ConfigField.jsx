import React, { useRef } from 'react';
import * as api from '../api/index.js';
import useAgentStore from '../stores/agentStore';
import styles from './ConfigField.module.css';

export default function ConfigField({ field, agentId, value, currentAvatar, currentUserAvatar, options, onChange }) {
  const fileRef = useRef(null);

  const handleFileChange = async (e, fieldName) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      alert('图片大小不能超过 2MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const base64 = ev.target.result;
      try {
        const data = await api.uploadAvatar(agentId, fieldName, base64, file.type);
        const filename = (data.path || '').split('/').pop();
        if (filename) {
          if (fieldName === 'avatar') {
            onChange?.({ avatar: filename });
          } else {
            onChange?.({ userAvatar: filename });
          }
        }
        useAgentStore.getState().refreshAgents();
      } catch (err) {
        alert('上传失败: ' + err.message);
      }
    };
    reader.readAsDataURL(file);
  };

  const { key, type, label, hint } = field;

  if (type === 'avatar') {
    const avatarSrc = currentAvatar
      ? `/agents/${agentId}/config/${currentAvatar}?t=${Date.now()}`
      : null;
    const userAvatarSrc = currentUserAvatar
      ? `/agents/${agentId}/config/${currentUserAvatar}?t=${Date.now()}`
      : null;

    return (
      <div className={styles.avatarRow}>
        <div className={styles.avatarCol}>
          <label>Agent 头像</label>
          <div
            className={`${styles.avatarPreview} ${currentAvatar ? styles.hasAvatar : ''}`}
            onClick={() => document.getElementById(`cfgAvatarFile_${agentId}`)?.click()}
          >
            {avatarSrc ? <img src={avatarSrc} alt="头像" /> : <span className={styles.placeholder}>点击<br/>上传</span>}
          </div>
          <input
            type="file" id={`cfgAvatarFile_${agentId}`}
            accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => handleFileChange(e, 'avatar')}
          />
        </div>
        <div className={styles.avatarCol}>
          <label>用户头像</label>
          <div
            className={`${styles.avatarPreview} ${styles.userAvatarPreview} ${currentUserAvatar ? styles.hasAvatar : ''}`}
            onClick={() => document.getElementById(`cfgUserAvatarFile_${agentId}`)?.click()}
          >
            {userAvatarSrc ? <img src={userAvatarSrc} alt="我" /> : <span className={styles.placeholder}>点击<br/>上传</span>}
          </div>
          <input
            type="file" id={`cfgUserAvatarFile_${agentId}`}
            accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => handleFileChange(e, 'user-avatar')}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.field} ${type === 'checkbox' ? styles.checkbox : ''}`}>
      {type !== 'checkbox' && type !== 'multiselect' && <label>{label}</label>}
      {type === 'multiselect' ? (
        <div className={styles.multiselect} data-key={key}>
          <label>{label}</label>
          <div className={styles.multiselectOptions}>
            {(options || []).map(opt => {
              const checked = Array.isArray(value) && value.includes(opt);
              return (
                <label key={opt} className={styles.multiselectItem}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = Array.isArray(value) ? [...value] : [];
                      if (e.target.checked) {
                        if (!next.includes(opt)) next.push(opt);
                      } else {
                        const i = next.indexOf(opt);
                        if (i >= 0) next.splice(i, 1);
                      }
                      onChange(next);
                    }}
                  />
                  {opt}
                </label>
              );
            })}
          </div>
        </div>
      ) : type === 'textarea' ? (
        <textarea data-key={key} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : type === 'checkbox' ? (
        <label className={styles.checkboxLabel}>
          <input type="checkbox" data-key={key} checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
      ) : type === 'password' ? (
        <input type="password" data-key={key} placeholder={value ? '*** (未修改)' : ''} onChange={(e) => onChange(e.target.value)} />
      ) : type === 'number' ? (
        <input type="number" data-key={key} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      ) : (
        <input type="text" data-key={key} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {hint && type !== 'checkbox' && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}