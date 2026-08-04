/**
 * 语言风格管理面板（ConfigDrawer 的 language-styles 选项卡，elf-018 等）
 *
 * - 列出 config/styles/*.md：default_style 可编辑（名锁死）、不可删；其余可增/改/删、名可改（改名）。
 * - 编辑/新增用弹窗：name（=文件名 stem，不带 .md）、description 两个必填输入框，body 单独可编辑正文。
 * - name 前端预查重（与现有文件重名则禁用保存并提示），后端 409 兜底。
 * - 引擎热读 config/styles，保存后下一轮 outline/render 即生效，无需重启。
 */
import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api/index.js';
import ConfirmModal from './ConfirmModal';

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const preStyle = { whiteSpace: 'pre-wrap', margin: 0, fontSize: '13px', lineHeight: '1.5' };

export default function LanguageStylesPanel({ agentId }) {
  const [styles, setStyles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);            // { type: 'ok'|'error', text }
  const [editor, setEditor] = useState(null);      // null | { isNew, filename, name, description, body }
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getStyles(agentId);
      setStyles(data.styles || []);
    } catch (e) {
      setMsg({ type: 'error', text: `加载失败: ${e.message}` });
      api.log('ERROR', `[语言风格] 加载失败: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { refresh(); }, [refresh]);

  const namesInUse = new Set(styles.map((s) => s.name));

  const openNew = () => setEditor({ isNew: true, filename: '', name: '', description: '', body: '' });
  const openEdit = (s) => setEditor({ isNew: false, filename: s.filename, name: s.name, description: s.description, body: s.body });

  // 校验 + 查重：通过返回 null，否则错误信息。default 的 name 锁死为 default_style，不校验其可改性。
  const validate = (e) => {
    if (!e.name || !NAME_RE.test(e.name)) return 'name 非法（仅 A-Za-z0-9._-，不带 .md）';
    if (!e.description.trim()) return 'description 必填';
    if (!e.body.trim()) return 'body 必填';
    const collide = namesInUse.has(e.name) && e.filename !== `${e.name}.md`;
    if (collide) return `已存在 ${e.name}.md，请换个名字`;
    return null;
  };

  const save = async () => {
    const err = validate(editor);
    if (err) { setMsg({ type: 'error', text: err }); return; }
    setSaving(true);
    try {
      if (editor.isNew) {
        await api.createStyle(agentId, { name: editor.name, description: editor.description, body: editor.body });
        setMsg({ type: 'ok', text: `已新增 ${editor.name}` });
      } else {
        await api.updateStyle(agentId, editor.filename, { name: editor.name, description: editor.description, body: editor.body });
        setMsg({ type: 'ok', text: `已保存 ${editor.name}` });
      }
      setEditor(null);
      refresh();
    } catch (e) {
      setMsg({ type: 'error', text: `保存失败: ${e.message}` });
      api.log('ERROR', `[语言风格] 保存失败: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (filename) => {
    try {
      await api.deleteStyle(agentId, filename);
      setMsg({ type: 'ok', text: `已删除 ${filename}` });
      refresh();
    } catch (e) {
      setMsg({ type: 'error', text: `删除失败: ${e.message}` });
      api.log('ERROR', `[语言风格] 删除失败: ${e?.message || e}`);
    }
  };

  const editorErr = editor ? validate(editor) : null;
  const editorNameLocked = editor && !editor.isNew && editor.filename === 'default_style.md';

  const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid #eee' };
  const btnBase = { padding: '3px 10px', fontSize: '12px', cursor: 'pointer', border: '1px solid #d0d0d0', borderRadius: '4px', background: '#fff' };

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '13px', color: '#999' }}>语言风格文件（大纲点名 &lt;文件名.md&gt;，render 据此加载正文）</span>
        <button style={{ ...btnBase, borderColor: '#409eff', color: '#409eff' }} onClick={openNew}>+ 新增风格</button>
      </div>
      <div style={{ fontSize: '12px', color: '#bbb', marginBottom: '8px' }}>
        default_style 恒为 render system 末尾常驻的默认风格（含短例）；其余为场景风格，大纲「## 语言风格」节点名后由 render 在 user 末尾加载。引擎热读，保存即生效。
      </div>

      {msg && (
        <div style={{
          padding: '6px 10px', marginBottom: '8px', borderRadius: '4px', fontSize: '13px',
          background: msg.type === 'error' ? '#fff1f0' : '#f6ffed',
          color: msg.type === 'error' ? '#cf1322' : '#389e0d',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>{msg.text}</span>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999' }} onClick={() => setMsg(null)}>×</button>
        </div>
      )}

      {loading && <div style={{ color: '#999', fontSize: '13px' }}>加载中…</div>}

      {!loading && styles.length === 0 && <div style={{ color: '#ccc', fontSize: '13px' }}>（暂无风格文件）</div>}

      {styles.map((s) => (
        <div key={s.filename} style={rowStyle}>
          <span style={{ fontWeight: 600, fontSize: '13px', minWidth: '120px' }}>{s.name}</span>
          {s.isDefault && <span style={{ fontSize: '11px', color: '#fa8c16', border: '1px solid #fa8c16', borderRadius: '3px', padding: '0 4px' }}>默认</span>}
          <span style={{ flex: 1, fontSize: '12px', color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</span>
          <button style={btnBase} onClick={() => openEdit(s)}>编辑</button>
          {!s.isDefault && (
            <button style={{ ...btnBase, color: '#cf1322', borderColor: '#cf1322' }} onClick={() => setPendingDelete(s)}>删除</button>
          )}
        </div>
      ))}

      {editor && (
        <div style={modalOverlay} onClick={() => setEditor(null)}>
          <div style={modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <span style={{ fontWeight: 600, fontSize: '14px' }}>{editor.isNew ? '新增语言风格' : '编辑语言风格'}</span>
              <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '16px' }} onClick={() => setEditor(null)}>×</button>
            </div>

            <label style={labelStyle}>name（文件名，不带 .md{editorNameLocked ? ' · 默认锁定' : ''}）</label>
            <input
              style={inputStyle}
              value={editor.name}
              disabled={editorNameLocked}
              placeholder="如 combat_style"
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            />

            <label style={labelStyle}>description（简介，进大纲 metadata，必填）</label>
            <input
              style={inputStyle}
              value={editor.description}
              placeholder="如 战斗时紧凑凌厉、短句与体感优先"
              onChange={(e) => setEditor({ ...editor, description: e.target.value })}
            />

            <label style={labelStyle}>正文（风格规则 + 可选短例，必填）</label>
            <textarea
              style={{ ...textareaStyle }}
              value={editor.body}
              onChange={(e) => setEditor({ ...editor, body: e.target.value })}
            />

            {editorErr && <div style={{ color: '#cf1322', fontSize: '12px', marginTop: '4px' }}>{editorErr}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
              <button style={btnBase} onClick={() => setEditor(null)}>取消</button>
              <button
                style={{ ...btnBase, background: '#409eff', color: '#fff', borderColor: '#409eff', opacity: editorErr || saving ? 0.5 : 1, cursor: editorErr || saving ? 'not-allowed' : 'pointer' }}
                disabled={!!editorErr || saving}
                onClick={save}
              >{saving ? '保存中…' : '保存'}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!pendingDelete}
        title="删除语言风格"
        message={`确定删除「${pendingDelete?.name}」？此操作不可恢复。`}
        confirmText="删除"
        tone="danger"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => { const p = pendingDelete; setPendingDelete(null); if (p) doDelete(p.filename); }}
      />
    </div>
  );
}

// —— 行内样式常量（仿 GameStatePanel，避免新增 CSS module）——
const labelStyle = { display: 'block', fontSize: '12px', color: '#666', margin: '8px 0 4px 0' };
const inputStyle = { width: '100%', padding: '5px 8px', fontSize: '13px', border: '1px solid #d0d0d0', borderRadius: '4px', boxSizing: 'border-box' };
const textareaStyle = { width: '100%', minHeight: '160px', padding: '6px 8px', fontSize: '13px', border: '1px solid #d0d0d0', borderRadius: '4px', boxSizing: 'border-box', fontFamily: 'inherit', whiteSpace: 'pre-wrap' };
const modalOverlay = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalBox = { background: '#fff', borderRadius: '8px', padding: '16px', width: '560px', maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto' };
