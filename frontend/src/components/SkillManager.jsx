/**
 * Skill 管理面板（ConfigDrawer 的 skill 选项卡）
 *
 * - 分两区列出 user / project 目录下的 skill，每项显示名字、hover 显示 description
 * - 每项可删除（二次确认）
 * - "添加 skill" → 浏览目录 → 选定目录后复制到 ~/.elf/skills/（user 侧）
 */
import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api/index.js';
import styles from './SkillManager.module.css';

const SOURCES = [
  { key: 'user', label: '用户级 (~/.elf/skills)', hint: '所有项目共享' },
  { key: 'project', label: '项目级 (.elf/skills)', hint: '仅当前项目' },
];

export default function SkillManager() {
  const [skills, setSkills] = useState([]);
  const [roots, setRoots] = useState({});
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);          // { type: 'ok'|'error', text }
  const [browser, setBrowser] = useState(null);   // 目录浏览弹窗状态：null | { current, entries, selected, loading }

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listSkills();
      setSkills(data.skills || []);
      setRoots(data.roots || {});
    } catch (e) {
      setMsg({ type: 'error', text: `加载失败: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = async (source, name) => {
    if (!window.confirm(`确定删除 skill「${name}」？此操作不可恢复。`)) return;
    try {
      await api.deleteSkill(source, name);
      setMsg({ type: 'ok', text: `已删除 ${name}` });
      refresh();
    } catch (e) {
      setMsg({ type: 'error', text: `删除失败: ${e.message}` });
    }
  };

  // —— 目录浏览弹窗 ——
  const openBrowser = async () => {
    // 立刻打开弹窗（loading 态），即使首次拉取失败也保留弹窗，避免闪退
    setBrowser({ current: '', entries: [], loading: true, error: null });
    try {
      const data = await api.browseSkillDirs('');
      setBrowser({ ...data, loading: false, error: null });
    } catch (e) {
      setBrowser({ current: '', entries: [], loading: false, error: `加载目录失败: ${e.message}` });
    }
  };

  const navTo = async (dir) => {
    setBrowser(b => ({ ...b, loading: true, error: null }));
    try {
      const data = await api.browseSkillDirs(dir);
      setBrowser({ ...data, loading: false, error: null });
    } catch (e) {
      setBrowser(b => ({ ...b, loading: false, error: `浏览失败: ${e.message}` }));
    }
  };

  const goUp = (current) => {
    if (!current) return;
    const parent = current.replace(/\/[^/]+\/?$/, '') || '/';
    navTo(parent === current ? '/' : parent);
  };

  const handleInstall = async () => {
    // 安装「当前浏览到的目录」作为 skill 源
    const target = browser?.current;
    if (!target) return;
    try {
      const r = await api.installSkill(target);
      setMsg({ type: 'ok', text: `已安装 skill「${r.name}」到用户级目录` });
      setBrowser(null);
      refresh();
    } catch (e) {
      setMsg({ type: 'error', text: `安装失败: ${e.message}` });
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.title}>已安装的 Skill</span>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={openBrowser}>+ 添加 skill</button>
      </div>
      <div className={styles.hint}>skill 通过目录存放，目录名即 skill 名。用户级所有项目共享，项目级仅当前项目生效（同名项目级覆盖用户级）。</div>

      {msg && (
        <div className={`${styles.msg} ${msg.type === 'error' ? styles.msgErr : styles.msgOk}`}>
          {msg.text}
          <button className={styles.msgClose} onClick={() => setMsg(null)}>×</button>
        </div>
      )}

      {loading && <div className={styles.loading}>加载中…</div>}

      {SOURCES.map(src => {
        const items = skills.filter(s => s.source === src.key);
        const rootPath = roots[src.key];
        return (
          <div key={src.key} className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>{src.label}</span>
              <span className={styles.sectionHint}>{src.hint}{rootPath ? ` · ${rootPath}` : ''}</span>
            </div>
            {items.length === 0 ? (
              <div className={styles.empty}>（空）</div>
            ) : (
              <ul className={styles.list}>
                {items.map(s => (
                  <li key={`${s.source}/${s.name}`} className={styles.item} title={s.whenToUse ? `${s.description}\n— ${s.whenToUse}` : s.description}>
                    <div className={styles.itemMain}>
                      <span className={styles.itemName}>{s.name}</span>
                      {s.whenToUse && <span className={styles.itemWhen}>{s.whenToUse}</span>}
                    </div>
                    <span className={styles.itemDesc}>{s.description}</span>
                    <button
                      className={`${styles.btn} ${styles.btnDanger} ${styles.btnSm}`}
                      onClick={() => handleDelete(s.source, s.name)}
                    >删除</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {browser && (
        <div className={styles.modal} onClick={() => setBrowser(null)}>
          <div className={styles.modalBox} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHead}>
              <span className={styles.modalTitle}>选择 skill 目录</span>
              <button className={styles.msgClose} onClick={() => setBrowser(null)}>×</button>
            </div>
            <div className={styles.modalPath}>
              <button className={`${styles.btn} ${styles.btnSm}`} onClick={() => goUp(browser.current)} disabled={!browser.current}>↑ 上级</button>
              <span className={styles.pathText}>{browser.current || '/'}</span>
            </div>
            <div className={styles.dirTip}>单击目录进入 · 找到含 SKILL.md 的目录后点「安装」</div>
            <div className={styles.dirList}>
              {browser.loading ? (
                <div className={styles.loading}>加载中…</div>
              ) : browser.error ? (
                <div className={styles.empty}>{browser.error}</div>
              ) : browser.entries.length === 0 ? (
                <div className={styles.empty}>（无子目录）</div>
              ) : (
                browser.entries.map(e => {
                  const isSkillFile = /^skill\.md$/i.test(e.name);
                  if (e.isDirectory) {
                    return (
                      <div
                        key={e.path}
                        className={styles.dirItem}
                        onClick={() => navTo(e.path)}
                        onDoubleClick={() => navTo(e.path)}
                        title={`进入 ${e.path}`}
                      >
                        <span className={styles.dirName}>📁 {e.name}</span>
                      </div>
                    );
                  }
                  // 文件：标灰不可点；SKILL.md 高亮提示
                  return (
                    <div
                      key={e.path}
                      className={`${styles.fileItem} ${isSkillFile ? styles.fileItemSkill : ''}`}
                      title={isSkillFile ? '该目录已含 SKILL.md，可点「安装」' : e.name}
                    >
                      <span className={styles.dirName}>📄 {e.name}</span>
                      {isSkillFile && <span className={styles.skillBadge}>SKILL</span>}
                    </div>
                  );
                })
              )}
            </div>
            <div className={styles.modalFoot}>
              <span className={styles.selectedText}>
                {browser.current ? `当前: ${browser.current}` : ''}
              </span>
              <span style={{ flex: 1 }} />
              <button className={styles.btn} onClick={() => setBrowser(null)}>取消</button>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={!browser.current || browser.loading}
                onClick={handleInstall}
              >安装</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}