/**
 * GameSetupPanel — elf-018 游戏初始设定页
 *
 * 在没有对话时展示，允许玩家设定角色名、编辑用户面板、
 * 以及管理初始 lore 实体（characters/items/locations/skills）。
 * 用户点击「开始游戏」后保存全部内容并发送首条消息。
 */

import React, { useState, useEffect, useCallback } from 'react';
import styles from './index.module.css';

// —— 行内样式常量 ——
const labelS = { display: 'block', fontSize: '12px', color: '#666', margin: '8px 0 4px 0' };
const inputS = { width: '100%', padding: '5px 8px', fontSize: '13px', border: '1px solid #d0d0d0', borderRadius: '4px', boxSizing: 'border-box' };
const textareaS = { width: '100%', minHeight: '120px', padding: '6px 8px', fontSize: '13px', border: '1px solid #d0d0d0', borderRadius: '4px', boxSizing: 'border-box', fontFamily: 'inherit', whiteSpace: 'pre-wrap', lineHeight: '1.5' };
const btnBase = { padding: '3px 10px', fontSize: '12px', cursor: 'pointer', border: '1px solid #d0d0d0', borderRadius: '4px', background: '#fff' };
const modalOverlay = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalBox = { background: '#fff', borderRadius: '8px', padding: '16px', width: '560px', maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto' };

const SAMPLES = {
  characters: { name: '旅店老板', desc: '边境小镇酒馆的老板，消息灵通' },
  locations:  { name: '边境小镇', desc: '玩家起始地，黄昏薄雾的边境小镇' },
  items:      { name: '木剑', desc: '训练用木剑，攻击力+1' },
  skills:     { name: '基础攻击', desc: '初学剑术，造成 1d4 伤害' },
};
const LORE_TYPES = [
  { key: 'characters', label: '角色' },
  { key: 'locations',  label: '地点' },
  { key: 'items',      label: '物品' },
  { key: 'skills',     label: '技能' },
];

/** Lore 实体编辑弹窗（复用语言风格编辑器的交互模式） */
function LoreEntityModal({ isNew, initial, onSave, onPolish, onClose, type }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [body, setBody] = useState(initial?.body || '');
  const [saving, setSaving] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [polishMsg, setPolishMsg] = useState(null);

  const canSave = name.trim() && description.trim() && body.trim();
  const ph = SAMPLES[type] || SAMPLES.characters;

  const handleSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSave({ name: name.trim(), description: description.trim(), body });
      onClose();
    } catch (e) {
      alert('保存失败: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handlePolish = async () => {
    if (polishing || !name.trim()) return;
    setPolishing(true);
    setPolishMsg(null);
    try {
      const r = await onPolish({ type, name: name.trim(), description: description.trim(), body });
      if (r && r.ok) {
        if (r.description) setDescription(r.description);
        if (r.body) setBody(r.body);
        setPolishMsg({ type: 'ok', text: '已润色' });
      } else {
        setPolishMsg({ type: 'error', text: (r && r.error) || '润色失败' });
      }
    } catch (e) {
      setPolishMsg({ type: 'error', text: '润色失败: ' + e.message });
    } finally {
      setPolishing(false);
    }
  };

  return (
    <div style={modalOverlay}>
      <div style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <span style={{ fontWeight: 600, fontSize: '14px' }}>{isNew ? '新增条目' : '编辑条目'}</span>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '16px' }} onClick={onClose}>×</button>
        </div>

        <label style={labelS}>name（必填）</label>
        <input style={inputS} value={name} onChange={e => setName(e.target.value)} placeholder={'如 ' + ph.name} />

        <button
          style={{ ...btnBase, borderColor: '#722ed1', color: '#722ed1', marginBottom: '8px', opacity: name.trim() && !polishing ? 1 : 0.5, cursor: name.trim() && !polishing ? 'pointer' : 'not-allowed' }}
          disabled={!name.trim() || polishing}
          onClick={handlePolish}
        >{polishing ? '生成中…' : '✨ AI 润色'}</button>

        {polishMsg && (
          <div style={{
            padding: '4px 10px', marginBottom: '8px', borderRadius: '4px', fontSize: '12px',
            background: polishMsg.type === 'error' ? '#fff1f0' : '#f6ffed',
            color: polishMsg.type === 'error' ? '#cf1322' : '#389e0d',
          }}>{polishMsg.text}</div>
        )}

        <label style={labelS}>description（必填）</label>
        <input style={inputS} value={description} onChange={e => setDescription(e.target.value)} placeholder={'如 ' + ph.desc} />

        <label style={labelS}>正文（必填）</label>
        <textarea style={textareaS} value={body} onChange={e => setBody(e.target.value)} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
          <button style={btnBase} onClick={onClose}>取消</button>
          <button
            style={{ ...btnBase, background: '#409eff', color: '#fff', borderColor: '#409eff', opacity: canSave && !saving ? 1 : 0.5, cursor: canSave && !saving ? 'pointer' : 'not-allowed' }}
            disabled={!canSave || saving}
            onClick={handleSave}
          >{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}

export default function GameSetupPanel({ bridge }) {
  const [playerName, setPlayerName] = useState('');
  const [profileBody, setProfileBody] = useState('');
  const [openingMessage, setOpeningMessage] = useState('出发吧');
  const [seeds, setSeeds] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loreLists, setLoreLists] = useState({});
  const [loreEditor, setLoreEditor] = useState(null);

  // 读取种子 + 现有 lore
  useEffect(() => {
    async function init() {
      try {
        const [seedData, state] = await Promise.all([
          bridge.call('GET', '/seeds'),
          bridge.call('GET', '/game-state'),
        ]);
        setSeeds(seedData);

        if (state?.protagonist) {
          setPlayerName(state.protagonist.name || '');
          const body = (state.protagonist.content || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
          setProfileBody(body);
        } else if (seedData?.userProfile) {
          setPlayerName(seedData.userProfile.name || '');
          setProfileBody(seedData.userProfile.body || '');
        }

        const lists = {};
        for (const { key } of LORE_TYPES) {
          const existing = state?.[key] || [];
          if (existing.length > 0) {
            lists[key] = existing.map(e => ({
              name: e.name,
              description: e.description,
              body: (e.content || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim(),
              fromSeed: false,
            }));
          } else if (seedData?.[key]) {
            lists[key] = seedData[key].map(e => ({ ...e, fromSeed: true }));
          } else {
            lists[key] = [];
          }
        }
        setLoreLists(lists);
      } catch (e) {
        console.warn('setup 初始化失败:', e);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // 失焦保存玩家设定
  const handleBlurProfile = useCallback(() => {
    bridge.call('PUT', '/user-profile', { name: playerName, body: profileBody }).catch(() => {});
  }, [playerName, profileBody, bridge]);

  // 创建/更新 lore
  const handleLoreSave = useCallback(async ({ name, description, body }) => {
    const { type, isNew } = loreEditor;
    if (isNew) {
      await bridge.call('POST', '/lore/' + type, { name, description, body });
    } else {
      await bridge.call('PUT', '/lore/' + type + '/' + encodeURIComponent(loreEditor.filename), { name, description, body });
    }
    const data = await bridge.call('GET', '/lore/' + type);
    setLoreLists(prev => ({ ...prev, [type]: data.entities.map(e => ({ ...e, fromSeed: false })) }));
  }, [loreEditor, bridge]);

  // AI 润色：调 /polish-lore，返回 {ok, description, body}（ok=false 时 modal 保留原 state）
  const handlePolish = useCallback(async ({ type, name, description, body }) => {
    return await bridge.call('POST', '/polish-lore', { type, name, description, body });
  }, [bridge]);

  // 删除 lore
  const handleDeleteLore = useCallback(async (type, filename) => {
    if (!confirm('确定删除该条目？')) return;
    try {
      await bridge.call('DELETE', '/lore/' + type + '/' + encodeURIComponent(filename));
      setLoreLists(prev => ({
        ...prev,
        [type]: (prev[type] || []).filter(e => (e.name.replace(/[^\w.一-鿿-]/g, '_') + '.md') !== filename),
      }));
    } catch (e) {
      alert('删除失败: ' + e.message);
    }
  }, [bridge]);

  // 开始游戏
  const handleStartGame = useCallback(async () => {
    try {
      await bridge.call('PUT', '/user-profile', { name: playerName, body: profileBody });
      bridge.send(openingMessage);
    } catch (e) {
      alert('开始游戏失败: ' + e.message);
    }
  }, [playerName, profileBody, openingMessage, bridge]);

  const openNewLore = (type) => setLoreEditor({ type, isNew: true, initial: null });
  const openEditLore = (type, entity, filename) => setLoreEditor({ type, isNew: false, filename, initial: { name: entity.name, description: entity.description, body: entity.body } });

  if (loading) {
    return (
      <div className={styles.setupPanel}>
        <div className={styles.loading}>加载初始设定…</div>
      </div>
    );
  }

  return (
    <div className={styles.setupPanel}>
      <div className={styles.setupInner}>
        <h2 className={styles.setupTitle}>⚔ 游戏初始设定</h2>
        <p className={styles.setupHint}>设定好开局内容后点「开始游戏」</p>

        {/* 玩家设定 */}
        <section className={styles.setupSection}>
          <h3 className={styles.setupSectionTitle}>玩家设定</h3>
          <label style={labelS}>主角名（开局后不可改）</label>
          <input style={inputS} value={playerName} onChange={e => setPlayerName(e.target.value)} onBlur={handleBlurProfile} placeholder="如 勇者" />
          <label style={labelS}>角色面板（支持 Markdown）</label>
          <textarea style={textareaS} value={profileBody} onChange={e => setProfileBody(e.target.value)} onBlur={handleBlurProfile} />
        </section>

        {/* 世界设定 */}
        {LORE_TYPES.map(({ key, label }) => (
          <section key={key} className={styles.setupSection}>
            <div className={styles.setupRow}>
              <h3 className={styles.setupSectionTitle}>{label}</h3>
              <button style={{ ...btnBase, borderColor: '#409eff', color: '#409eff' }} onClick={() => openNewLore(key)}>+ 新增</button>
            </div>
            {(!loreLists[key] || loreLists[key].length === 0) ? (
              <span className={styles.empty}>（暂无{label}）</span>
            ) : (
              loreLists[key].map((entity, i) => {
                const filename = entity.name.replace(/[^\w.一-鿿-]/g, '_') + '.md';
                return (
                  <div key={i} className={styles.loreRow}>
                    <span className={styles.loreRowClick} onClick={() => openEditLore(key, entity, filename)}>
                      <strong className={styles.loreName}>{entity.name}</strong>
                      <span className={styles.loreDesc}>{entity.description}</span>
                      {entity.fromSeed && <span className={styles.fromSeed}>种子</span>}
                    </span>
                    <button className={styles.loreDelBtn} onClick={() => handleDeleteLore(key, filename)}>×</button>
                  </div>
                );
              })
            )}
          </section>
        ))}

        {/* 开场白设定 + 开始游戏 */}
        <div style={{ textAlign: 'center', marginTop: '24px' }}>
          <label style={labelS}>开场白（发送给 DM 的第一条消息）</label>
          <textarea
            style={{ ...textareaS, minHeight: '60px', marginBottom: '12px', textAlign: 'center' }}
            value={openingMessage}
            onChange={e => setOpeningMessage(e.target.value)}
          />
          <br />
          <button
            style={{
              padding: '10px 32px', fontSize: '16px', fontWeight: 600, cursor: 'pointer',
              background: '#52c41a', color: '#fff', border: 'none', borderRadius: '8px',
              boxShadow: '0 2px 6px rgba(82,196,26,0.3)',
            }}
            onClick={handleStartGame}
          >⚔ 开始游戏</button>
          <p className={styles.setupFooter}>开始游戏前会先保存玩家设定</p>
        </div>
      </div>

      {loreEditor && (
        <LoreEntityModal
          isNew={loreEditor.isNew}
          initial={loreEditor.initial}
          type={loreEditor.type}
          onSave={handleLoreSave}
          onPolish={handlePolish}
          onClose={() => setLoreEditor(null)}
        />
      )}
    </div>
  );
}