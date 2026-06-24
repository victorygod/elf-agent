import { useState, useEffect, useCallback } from 'react';
import * as api from '../api/index.js';
import useAgentStore from '../stores/agentStore';

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
          initial.prefix_prompt = data.config?.prefix_prompt || '';
          initial.suffix_prompt = data.config?.suffix_prompt || '';
          initial.base_url = model.base_url || '';
          initial.auth_token = model.auth_token || '';
          initial.model = model.model || '';

          // 从 config 提取其他字段
          if (data.config) {
            const skip = new Set(['agentId', 'port', 'systemPromptPath', 'prefixPromptPath', 'suffixPromptPath',
              'avatar', 'userAvatar', '_ui', 'provider', 'systemPrompt', 'prefix_prompt', 'suffix_prompt', 'model', 'modelError']);
            for (const [k, v] of Object.entries(data.config)) {
              if (skip.has(k)) continue;
              if (v && typeof v === 'object' && !Array.isArray(v)) continue;
              initial[k] = v ?? '';
            }
          }

          setFormData(initial);
          // 设置默认选项卡
          const tabs = data.layout?.tabs || buildDefaultTabs();
          if (tabs.length > 0) setActiveTab(tabs[0].key);
        }
      }).catch(() => {});
    }
  }, [configDrawerOpen, configAgentId]);

  const handleFieldChange = useCallback((key, value) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!configAgentId) return;
    setIsSaving(true);
    try {
      const update = {};

      // 提示词字段
      if (formData.systemPrompt !== undefined) update.systemPrompt = formData.systemPrompt;
      if (formData.prefix_prompt !== undefined) update.prefix_prompt = formData.prefix_prompt;
      if (formData.suffix_prompt !== undefined) update.suffix_prompt = formData.suffix_prompt;

      // 模型字段
      const modelUpdate = {};
      if (formData.base_url !== undefined) modelUpdate.base_url = formData.base_url;
      if (formData.auth_token !== undefined) modelUpdate.auth_token = formData.auth_token;
      if (formData.model !== undefined) modelUpdate.model = formData.model;
      if (Object.keys(modelUpdate).length > 0) update.model = modelUpdate;

      // 其他字段
      const skip = new Set(['systemPrompt', 'prefix_prompt', 'suffix_prompt', 'base_url', 'auth_token', 'model']);
      for (const [k, v] of Object.entries(formData)) {
        if (skip.has(k)) continue;
        update[k] = v;
      }

      await api.updateConfig(configAgentId, update);
      closeConfigStore();
      // 配置保存不改变聊天记录和 agent 运行状态，无需 refreshAgents / loadHistory
      // 服务端 PUT /agents/:id/config 已同步内存中的 config；
      // agent 侧 fs.watch 会热加载新配置。
      // 之前 refreshAgents + loadHistory 会导致：正在流式回复时 loadHistory 把
      // 已写入 jsonl 的 user 消息重建到 turns，与 activeTurn 重复显示。
      useAgentStore.getState().showToast('配置已保存');
    } catch (e) {
      alert('保存失败: ' + e.message);
      api.log('ERROR', '配置保存失败: ' + e.message);
    }
    setIsSaving(false);
  }, [configAgentId, formData, closeConfigStore, refreshAgents]);

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

  const handleClearHistory = useCallback(async () => {
    if (!configAgentId || !confirm('确定要清空聊天记录吗？此操作不可恢复。')) return;
    const store = useAgentStore.getState();
    await store.clearHistory(configAgentId);
  }, [configAgentId]);

  const handleClearMemory = useCallback(async () => {
    if (!configAgentId || !confirm('确定要清空 Agent 记忆吗？此操作不可恢复，Agent 将忘记之前的对话内容。')) return;
    try {
      const ok = await api.deleteMemory(configAgentId);
      if (ok) {
        useAgentStore.getState().showToast( 'Agent 记忆已清空');
      } else {
        useAgentStore.getState().showToast( '清空失败');
      }
    } catch (e) {
      useAgentStore.getState().showToast( `清空失败: ${e.message}`);
    }
  }, [configAgentId]);

  return {
    config, layout, formData, activeTab,
    isSaving, isStarting, isStopping,
    setActiveTab, handleFieldChange,
    handleSave, handleStart, handleStop,
    handleClearHistory, handleClearMemory,
  };
}

function buildDefaultTabs() {
  return [
    { key: 'agent', label: 'Agent 配置', fields: [] },
    { key: 'model', label: '模型配置', fields: [] },
  ];
}