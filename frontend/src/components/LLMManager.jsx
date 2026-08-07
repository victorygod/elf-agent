import React, { useState, useEffect } from 'react';
import { authFetch } from '../api';
import ConfirmModal from './ConfirmModal';
import styles from './LLMManager.module.css';

/**
 * LLM API 管理——内联面板（渲染在系统设置弹窗的 llm 视图里，不再自己起全屏 modal）。
 * 两个内部状态：列表 / 编辑（新增或编辑某条），都在同一个框内切换。
 */
export default function LLMManager() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);           // false = 列表；true = 编辑表单
  const [editingModel, setEditingModel] = useState(null);  // null = 新增，对象 = 编辑
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleteId, setDeleteId] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const [formData, setFormData] = useState({
    model_id: '',
    base_url: '',
    auth_token: '',
    model: '',
    params_schema: null,
  });

  useEffect(() => { loadModels(); }, []);

  const loadModels = async () => {
    setLoading(true);
    try {
      const res = await authFetch('/models');
      const data = await res.json();
      setModels(data);
    } catch (err) {
      console.error('加载模型失败:', err);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormData({ model_id: '', base_url: '', auth_token: '', model: '', params_schema: null });
    setEditingModel(null);
    setEditing(false);
    setErrorMsg('');
  };

  const handleSave = async () => {
    setErrorMsg('');
    if (!formData.model_id || !formData.base_url || !formData.auth_token || !formData.model) {
      setErrorMsg('请填写所有必填字段');
      return;
    }
    try {
      let newModels;
      if (editingModel) {
        newModels = models.map(m => (m.model_id === editingModel.model_id ? formData : m));
      } else {
        if (models.some(m => m.model_id === formData.model_id)) {
          setErrorMsg('model_id 已存在，请使用不同的值');
          return;
        }
        newModels = [...models, formData];
      }
      const res = await authFetch('/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: newModels }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '保存失败');
      }
      await loadModels();
      resetForm();
    } catch (err) {
      setErrorMsg(err.message);
    }
  };

  const handleEdit = (model) => {
    setEditingModel(model);
    setFormData({ ...model });
    setEditing(true);
    setErrorMsg('');
  };

  const handleDelete = async () => {
    try {
      const newModels = models.filter(m => m.model_id !== deleteId);
      const res = await authFetch('/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: newModels }),
      });
      if (!res.ok) throw new Error('删除失败');
      await loadModels();
      setShowConfirm(false);
      setDeleteId(null);
    } catch (err) {
      setErrorMsg(err.message);
    }
  };

  const confirmDelete = (id) => {
    setDeleteId(id);
    setShowConfirm(true);
  };

  if (editing) {
    return (
      <div className={styles.editPanel}>
        <div className={styles.field}>
          <label>model_id（必填）</label>
          <input
            value={formData.model_id}
            onChange={e => setFormData({ ...formData, model_id: e.target.value })}
            disabled={!!editingModel}
          />
        </div>
        <div className={styles.field}>
          <label>base_url（必填）</label>
          <input
            value={formData.base_url}
            onChange={e => setFormData({ ...formData, base_url: e.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label>auth_token（必填）</label>
          <input
            type="password"
            value={formData.auth_token}
            onChange={e => setFormData({ ...formData, auth_token: e.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label>model（必填）</label>
          <input
            value={formData.model}
            onChange={e => setFormData({ ...formData, model: e.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label>params_schema（JSON，可选）</label>
          <textarea
            value={formData.params_schema ? JSON.stringify(formData.params_schema, null, 2) : ''}
            onChange={e => {
              const val = e.target.value.trim();
              setFormData({ ...formData, params_schema: val ? JSON.parse(val) : null });
            }}
            rows={6}
          />
        </div>
        {errorMsg && <div className={styles.errorMsg}>{errorMsg}</div>}
        <div className={styles.formActions}>
          <button onClick={resetForm}>取消</button>
          <button className={styles.saveBtn} onClick={handleSave}>保存</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.listPanel}>
      <button
        className={styles.addBtn}
        onClick={() => { setEditingModel(null); setFormData({ model_id: '', base_url: '', auth_token: '', model: '', params_schema: null }); setEditing(true); setErrorMsg(''); }}
      >
        + 新增模型
      </button>

      {loading ? (
        <div className={styles.loading}>加载中...</div>
      ) : models.length === 0 ? (
        <div className={styles.loading}>还没有模型，点击上方按钮添加。</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>model_id</th>
                <th>base_url</th>
                <th>model</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map(m => (
                <tr key={m.model_id}>
                  <td>{m.model_id}</td>
                  <td>{m.base_url}</td>
                  <td>{m.model}</td>
                  <td>
                    <button className={styles.editBtn} onClick={() => handleEdit(m)}>编辑</button>
                    <button className={styles.deleteBtn} onClick={() => confirmDelete(m.model_id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {errorMsg && <div className={styles.errorMsg}>{errorMsg}</div>}

      <ConfirmModal
        open={showConfirm}
        title="确认删除"
        message={`确定要删除模型 ${deleteId} 吗？`}
        confirmText="删除"
        tone="danger"
        onCancel={() => setShowConfirm(false)}
        onConfirm={handleDelete}
      />
    </div>
  );
}