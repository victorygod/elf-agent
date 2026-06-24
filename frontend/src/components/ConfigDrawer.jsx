import React from 'react';
import useAgentStore from '../stores/agentStore';
import useConfig from '../hooks/useConfig';
import ConfigField from './ConfigField';
import styles from './ConfigDrawer.module.css';

export default function ConfigDrawer({ onClose }) {
  const configAgentId = useAgentStore(s => s.configAgentId);
  const agent = useAgentStore(s => s.getAgent(configAgentId));

  const {
    config, layout, formData, activeTab,
    isSaving, isStarting, isStopping,
    setActiveTab, handleFieldChange,
    handleSave, handleStart, handleStop,
    handleClearHistory, handleClearMemory,
  } = useConfig();

  if (!configAgentId) return null;

  // 提取字段元数据
  const defaultTabs = layout ? null : buildDefaultLayout(config);

  const tabs = layout?.tabs || defaultTabs?.tabs || [];

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={onClose}>{'<'}</button>
        <h2>Agent 配置</h2>
        <div className={styles.headerActions}>
          {agent?.status === 'running' ? (
            <button className={`${styles.btn} ${styles.btnDanger} ${styles.btnSm}`} onClick={handleStop}>
              {isStopping ? '停止中...' : '停止服务'}
            </button>
          ) : (
            <button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`} onClick={handleStart} disabled={isStarting}>
              {isStarting ? '启动中...' : '启动服务'}
            </button>
          )}
        </div>
      </div>

      <div className={styles.tabs}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >{tab.label}</button>
        ))}
      </div>

      <div className={styles.body}>
        {tabs.map(tab => (
          <div
            key={tab.key}
            className={`${styles.tabPanel} ${activeTab === tab.key ? styles.tabPanelActive : ''}`}
          >
            {tab.fields.map(field => (
              <ConfigField
                key={field.key}
                field={field}
                agentId={configAgentId}
                value={formData[field.key] ?? ''}
                currentAvatar={field.key === 'avatar' ? (agent?.avatar || null) : null}
                currentUserAvatar={field.key === 'avatar' ? (agent?.userAvatar || null) : null}
                onChange={(val) => handleFieldChange(field.key, val)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className={styles.footer}>
        <button className={`${styles.btn} ${styles.btnWarning} ${styles.btnSm}`} onClick={handleClearHistory}>清空聊天记录</button>
        <button className={`${styles.btn} ${styles.btnWarning} ${styles.btnSm}`} onClick={handleClearMemory}>清空记忆</button>
        <span style={{ flex: 1 }} />
        <button className={styles.btn} onClick={onClose}>取消</button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSave} disabled={isSaving}>
          {isSaving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
}

// 从 config 中提取默认布局
function buildDefaultLayout(config) {
  if (!config) return { tabs: [] };
  const agentFields = [];
  const skipKeys = new Set([
    'agentId', 'port', 'systemPromptPath', 'prefixPromptPath', 'suffixPromptPath',
    'avatar', 'userAvatar', '_ui', 'provider', 'systemPrompt', 'prefix_prompt',
    'suffix_prompt', 'model', 'modelError',
  ]);

  for (const [key, value] of Object.entries(config)) {
    if (skipKeys.has(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) continue;
    const meta = config._ui?.[key] || {};
    let type = meta.type;
    if (!type) {
      if (typeof value === 'boolean') type = 'checkbox';
      else if (typeof value === 'number') type = 'number';
      else if (typeof value === 'string' && value.length > 100) type = 'textarea';
      else type = 'text';
    }
    agentFields.push({
      key, type,
      label: meta.label || key,
      hint: meta.hint || '',
    });
  }

  return {
    tabs: [
      {
        key: 'agent',
        label: 'Agent 配置',
        fields: [
          { key: 'avatar', type: 'avatar' },
          { key: 'systemPrompt', type: 'textarea', label: '系统提示词', hint: '定义 Agent 的角色和行为方式' },
          ...agentFields,
        ],
      },
      {
        key: 'model',
        label: '模型配置',
        fields: [
          { key: 'base_url', type: 'text', label: 'API Base URL', hint: 'LLM API 端点地址' },
          { key: 'auth_token', type: 'text', label: 'Auth Token', hint: 'LLM API 认证密钥' },
          { key: 'model', type: 'text', label: '模型名称', hint: '如 gpt-4o、GLM-5.1、deepseek-chat' },
        ],
      },
    ],
  };
}