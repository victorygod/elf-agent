import { useState, useEffect, useCallback } from 'react';
import * as api from '../api/index.js';
import useAgentStore from '../stores/agentStore';
import { getAgentManifest } from '../pluginRegistry';

/**
 * useConfig — 配置面板操作 hook
 */
export default function useConfig() {
  const configAgentId = useAgentStore(s => s.configAgentId);
  const configDrawerOpen = useAgentStore(s => s.configDrawerOpen);
  const closeConfigStore = useAgentStore(s => s.closeConfig);
  const refreshAgents = useAgentStore(s => s.refreshAgents);

  const [config, setConfig] = useState(null);
  const [layout, setLayout] = useState(null);
  const [formData, setFormData] = useState({});
  const [activeTab, setActiveTab] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);

  // 打开配置面板时加载数据
  useEffect(() => {
    if (configDrawerOpen && configAgentId) {
      api.getConfigUI(configAgentId).then(data => {
        if (data) {
          setLayout(data.layout);
          setConfig(data.config);
          // 初始化 formData
          const initial = {};
          const model = data.config?.model || {};
          initial.systemPrompt = data.config?.systemPrompt || '';
          initial.base_url = model.base_url || '';
          initial.auth_token = model.auth_token || '';
          initial.model = model.model || '';

          // 从 config 提取其他字段
          if (data.config) {
            const skip = new Set(['agentId', 'port', 'systemPromptPath',
              'avatar', 'userAvatar', '_ui', 'provider', 'systemPrompt', 'model', 'modelError']);
            for (const [k, v] of Object.entries(data.config)) {
              if (skip.has(k)) continue;
              if (v && typeof v === 'object' && !Array.isArray(v)) continue;
              initial[k] = v ?? '';
            }
          }

          setFormData(initial);
          // 设置默认选项卡（manifest 优先——config-ui.json 废弃后 layout 恒 null，取 manifest 首个 tab）
          const manifestTabs = getAgentManifest(configAgentId)?.config?.tabs;
          const tabs = manifestTabs || data.layout?.tabs || buildDefaultTabs();
          if (tabs.length > 0) setActiveTab(tabs[0].key);
        }
      }).catch(() => {});
    }
  }, [configDrawerOpen, configAgentId]);

  // 仅更新本地 formData（不触发保存）。保存由 ConfigField 失焦时通过 handleFieldCommit 提交，
  // 避免逐键 autosave 过于频繁 + 引发 avatar 等连带刷新。
  const handleFieldChange = useCallback((key, value) => {
    setFormData(prev => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  // 失焦提交（text/textarea/number/password）。checkbox/multiselect 在变更时即时 commit。
  const handleFieldCommit = useCallback((key, value) => {
    _saveField(configAgentId, key, value, refreshAgents);
  }, [configAgentId, refreshAgents]);

  const handleSave = useCallback(async () => {
    // 保留供手动触发（如 Enter 等场景），但不再有 UI 按钮
    if (!configAgentId) return;
    setIsSaving(true);
    try {
      await _saveAllFields(configAgentId, formData);
      await refreshAgents();
      useAgentStore.getState().showToast('配置已保存');
    } catch (e) {
      useAgentStore.getState().showToast('保存失败: ' + e.message);
    }
    setIsSaving(false);
  }, [configAgentId, formData, refreshAgents]);

  const handleStart = useCallback(async () => {
    if (!configAgentId) return;
    setIsStarting(true);
    try {
      const data = await api.startAgent(configAgentId);
      if (data.error) {
        useAgentStore.getState().showToast( `启动失败: ${data.error}`);
      } else {
        useAgentStore.getState().showToast( `Agent ${configAgentId} 已启动 (PID: ${data.pid})`);
      }
    } catch (e) {
      useAgentStore.getState().showToast( `启动失败: ${e.message}`);
    }
    setIsStarting(false);
    await refreshAgents();
  }, [configAgentId, refreshAgents]);

  const handleStop = useCallback(async () => {
    if (!configAgentId) return;
    setIsStopping(true);
    try {
      const data = await api.stopAgent(configAgentId);
      if (data.error) {
        useAgentStore.getState().showToast( `停止失败: ${data.error}`);
      } else {
        useAgentStore.getState().showToast( `Agent ${configAgentId} 已停止`);
      }
    } catch (e) {
      useAgentStore.getState().showToast( `停止失败: ${e.message}`);
    }
    setIsStopping(false);
    await refreshAgents();
  }, [configAgentId, refreshAgents]);

  const handleClearAll = useCallback(async () => {
    if (!configAgentId) return;
    const store = useAgentStore.getState();
    try {
      // 先清空聊天记录
      await store.clearHistory(configAgentId, { silent: true });
      // 再清空记忆
      const ok = await api.deleteMemory(configAgentId);
      if (ok) {
        store.showToast('聊天记录与记忆已清空');
      } else {
        store.showToast('聊天记录已清空，但记忆清空失败');
      }
    } catch (e) {
      store.showToast(`清空失败: ${e.message}`);
    }
  }, [configAgentId]);

  return {
    config, layout, formData, activeTab,
    isSaving, isStarting, isStopping,
    setActiveTab, handleFieldChange, handleFieldCommit,
    handleSave, handleStart, handleStop,
    handleClearAll, closeConfigStore,
  };
}

// 立即保存单字段（失焦提交用）
async function _saveField(agentId, key, value, refreshAgents) {
  if (!agentId) return;
  try {
    const update = _buildUpdate(key, value);
    await api.updateConfig(agentId, update);
    await refreshAgents();
  } catch (e) {
    useAgentStore.getState().showToast('保存失败: ' + e.message);
  }
}

// 保存全部字段
async function _saveAllFields(agentId, formData) {
  const update = {};
  if (formData.systemPrompt !== undefined) update.systemPrompt = formData.systemPrompt;
  const modelUpdate = {};
  if (formData.base_url !== undefined) modelUpdate.base_url = formData.base_url;
  if (formData.auth_token !== undefined) modelUpdate.auth_token = formData.auth_token;
  if (formData.model !== undefined) modelUpdate.model = formData.model;
  if (Object.keys(modelUpdate).length > 0) update.model = modelUpdate;
  const skip = new Set(['systemPrompt', 'base_url', 'auth_token', 'model']);
  for (const [k, v] of Object.entries(formData)) {
    if (skip.has(k)) continue;
    update[k] = v;
  }
  await api.updateConfig(agentId, update);
}

// 构建单字段 update
function _buildUpdate(key, value) {
  const update = {};
  if (key === 'systemPrompt') {
    update.systemPrompt = value;
  } else if (key === 'base_url' || key === 'auth_token' || key === 'model') {
    const modelUpdate = {};
    modelUpdate[key] = value;
    update.model = modelUpdate;
  } else {
    update[key] = value;
  }
  return update;
}

function buildDefaultTabs() {
  return [
    { key: 'agent', label: 'Agent 配置', fields: [] },
    { key: 'model', label: '模型配置', fields: [] },
  ];
}