import React, { useState } from 'react';
import * as api from '../api/index.js';
import { useAuthStore } from '../stores/authStore.js';

/**
 * LoginPage —— 登录/注册覆盖层
 *
 * App 启动时无有效 token 则全屏覆盖。登录/注册同一张表单切换模式。
 * 第一个注册的用户自动成为超级管理员（后端判定）。
 */
export default function LoginPage() {
  const [mode, setMode] = useState('login');   // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const setAuth = useAuthStore(s => s.setAuth);

  const submit = async () => {
    const u = username.trim();
    if (!u || !password) { setError('请输入用户名和密码'); return; }
    setBusy(true);
    setError('');
    try {
      const fn = mode === 'login' ? api.login : api.register;
      const { token, user } = await fn(u, password);
      setAuth(token, user);
    } catch (e) {
      setError(e.message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.box}>
        <h1 style={styles.title}>Elf</h1>
        <div style={styles.subtitle}>{mode === 'login' ? '登录你的账户' : '注册新账户'}</div>

        <input
          style={styles.input}
          placeholder="用户名"
          value={username}
          autoFocus
          onChange={e => setUsername(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
        />
        <input
          style={styles.input}
          type="password"
          placeholder="密码"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
        />

        {error && <div style={styles.error}>{error}</div>}

        <button style={styles.primary} onClick={submit} disabled={busy}>
          {busy ? '…' : (mode === 'login' ? '登录' : '注册')}
        </button>

        <div style={styles.switchRow}>
          {mode === 'login' ? (
            <span>还没有账户？<a style={styles.link} onClick={() => { setMode('register'); setError(''); }}>注册</a></span>
          ) : (
            <span>已有账户？<a style={styles.link} onClick={() => { setMode('login'); setError(''); }}>登录</a></span>
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'var(--bg, #1e1e1e)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  box: {
    width: 320, padding: '32px 28px', borderRadius: 12,
    background: 'var(--panel-bg, #2a2a2a)',
    boxShadow: '0 8px 32px rgba(0,0,0,.35)',
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  title: { margin: 0, fontSize: 28, color: 'var(--text, #eee)', textAlign: 'center' },
  subtitle: { fontSize: 13, color: 'var(--text-dim, #999)', textAlign: 'center', marginBottom: 8 },
  input: {
    padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border, #444)',
    background: 'var(--input-bg, #1f1f1f)', color: 'var(--text, #eee)', fontSize: 14, outline: 'none',
  },
  primary: {
    marginTop: 4, padding: '10px 0', borderRadius: 8, border: 'none',
    background: '#07c160', color: '#fff', fontSize: 15, cursor: 'pointer',
  },
  error: { fontSize: 12, color: '#e74c3c', textAlign: 'center' },
  switchRow: { fontSize: 12, color: 'var(--text-dim, #999)', textAlign: 'center', marginTop: 4 },
  link: { color: '#07c160', cursor: 'pointer' },
};
