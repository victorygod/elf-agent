import React, { useState, useEffect } from 'react';
import useAgentStore from '../stores/agentStore';
import useConfig from '../hooks/useConfig';
import * as api from '../api/index.js';
import ConfigField from './ConfigField';
import SkillManager from './SkillManager';
import GameStatePanel from './GameStatePanel';
import ConfirmModal from './ConfirmModal';
import styles from './ConfigDrawer.module.css';

export default function ConfigDrawer({ onClose }) {
  const configAgentId = useAgentStore(s => s.configAgentId);
  const agent = useAgentStore(s => s.getAgent(configAgentId));

  const {
    config, layout, formData, activeTab,
    isSaving, isStarting, isStopping,
    setActiveTab, handleFieldChange, handleFieldCommit,
    handleSave, handleStart, handleStop,
    handleClearAll, closeConfigStore,
  } = useConfig();

  // 可用工具列表（用于 tools 字段的多选）
  const [availableTools, setAvailableTools] = useState([]);
  useEffect(() => {
    api.getAvailableTools().then(setAvailableTools).catch(() => setAvailableTools([]));
  }, []);

  // 「清空聊天与记忆」确认弹窗（替代原生 confirm()，避免被浏览器屏蔽导致按钮无响应）
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

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
        {tabs.map(tab => {
          const editableFields = tab.fields.filter(f => f.type !== 'readonly-tags');
          const readonlyFields = tab.fields.filter(f => f.type === 'readonly-tags');
          const renderField = (field) => (
            <ConfigField
              key={field.key}
              field={field}
              agentId={configAgentId}
              value={formData[field.key] ?? ''}
              currentAvatar={field.key === 'avatar' ? (agent?.avatar || null) : null}
              options={field.options ?? (field.type === 'multiselect' ? availableTools : null)}
              onChange={(val) => handleFieldChange(field.key, val)}
              onCommit={(val) => handleFieldCommit(field.key, val)}
            />
          );
          return (
          <div
            key={tab.key}
            className={`${styles.tabPanel} ${activeTab === tab.key ? styles.tabPanelActive : ''}`}
          >
            {tab.type === 'skill-manager' ? (
              <SkillManager agentId={configAgentId} />
            ) : tab.type === 'game-state' ? (
              <GameStatePanel agentId={configAgentId} />
            ) : (
              <>
                {editableFields.map(renderField)}
                {readonlyFields.length > 0 && (
                  <>
                    <div className={styles.sectionDivider}>
                      <span className={styles.sectionTitle}>当前能力（只读 · 改 config.json 后重启生效）</span>
                    </div>
                    {readonlyFields.map(renderField)}
                  </>
                )}
              </>
            )}
          </div>
          );
        })}
      </div>

      <div className={styles.footer}>
        <button className={`${styles.btn} ${styles.btnWarning} ${styles.btnSm}`} onClick={() => setClearConfirmOpen(true)}>清空聊天与记忆</button>
        <span style={{ flex: 1 }} />
      </div>

      <ConfirmModal
        open={clearConfirmOpen}
        title="清空聊天与记忆"
        message="确定要清空聊天记录和 Agent 记忆吗？此操作不可恢复，Agent 将忘记之前的对话内容。"
        confirmText="清空"
        tone="danger"
        onCancel={() => setClearConfirmOpen(false)}
        onConfirm={() => { setClearConfirmOpen(false); handleClearAll(); }}
      />
    </div>
  );
}

// 从 config 中提取默认布局
function buildDefaultLayout(config) {
  if (!config) return { tabs: [] };
  const agentFields = [];
  const skipKeys = new Set([
    'agentId', 'port', 'systemPromptPath',
    'avatar', 'userAvatar', '_ui', 'provider', 'systemPrompt',
    'model', 'modelError',
  ]);

  for (const [key, value] of Object.entries(config)) {
    if (skipKeys.has(key)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) continue;
    const meta = config._ui?.[key] || {};
    let type = meta.type;
    if (!type) {
      if (Array.isArray(value) && (key === 'tools' || key === 'subagents')) type = 'readonly-tags';
      else if (typeof value === 'boolean') type = 'checkbox';
      else if (typeof value === 'number') type = 'number';
      else if (typeof value === 'string' && value.length > 100) type = 'textarea';
      else type = 'text';
    }
    agentFields.push({
      key, type,
      label: meta.label || (key === 'tools' ? '已启用工具' : key === 'subagents' ? '已启用子 agent 类型' : key),
      hint: meta.hint || (key === 'tools' ? '该 Agent 当前可调用的工具（只读，改 config.json 后重启生效）' : ''),
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