import React, { useState, useEffect, useCallback } from 'react';
import useAgentStore from '../stores/agentStore';
import useConfig from '../hooks/useConfig';
import useBridge from '../hooks/useBridge';
import * as api from '../api/index.js';
import ConfigField from './ConfigField';
import ConfirmModal from './ConfirmModal';
import { getAgentManifest, loadAgentComponent } from '../pluginRegistry';
import styles from './ConfigDrawer.module.css';

/**
 * 配置 tab 内容渲染器
 * - platform 级内置 type（skill-manager）：直接渲染内置组件
 * - manifest 声明了 component：从 agent UI 目录动态加载
 * - 默认：遍历 fields 渲染 ConfigField
 */
function ConfigTabBody({ tab, agentId, formData, agent, availableTools, onFieldChange, onFieldCommit, bridge }) {
  const [CustomComponent, setCustomComponent] = useState(undefined);

  useEffect(() => {
    if (tab.component) {
      loadAgentComponent(agentId, tab.component)
        .then(comp => setCustomComponent(() => comp))
        .catch(() => setCustomComponent(null));
    } else {
      setCustomComponent(null);
    }
  }, [tab.component, agentId]);

  // 平台级内置 tab
  if (tab.type === 'skill-manager') {
    // 延迟加载 SkillManager（非高频执行 path）
    const SkillManager = React.lazy(() => import('./SkillManager'));
    return <React.Suspense fallback={<div style={{ padding: 16, color: '#999' }}>加载中…</div>}>
      <SkillManager agentId={agentId} />
    </React.Suspense>;
  }

  // 自定义组件
  if (tab.component && CustomComponent) {
    return <CustomComponent agentId={agentId} bridge={bridge} />;
  }
  if (tab.component && CustomComponent === undefined) {
    return <div style={{ padding: '16px', color: '#999' }}>加载中…</div>;
  }

  // 标准字段渲染（含 prompt tab 底部的 LanguageStylesPanel）
  const editableFields = tab.fields.filter(f => f.type !== 'readonly-tags');
  const readonlyFields = tab.fields.filter(f => f.type === 'readonly-tags');

  const renderField = (field) => (
    <ConfigField
      key={field.key}
      field={field}
      agentId={agentId}
      value={formData[field.key] ?? ''}
      currentAvatar={field.key === 'avatar' ? (agent?.avatar || null) : null}
      options={field.options ?? (field.type === 'multiselect' ? availableTools : null)}
      onChange={(val) => onFieldChange(field.key, val)}
      onCommit={(val) => onFieldCommit(field.key, val)}
    />
  );

  return (
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
      {/* prompt tab 底部额外面板由 agent UI 动态加载 */}
      {tab.key === 'prompt' && <AgentPromptExtras agentId={agentId} />}
    </>
  );
}

/**
 * prompt tab 底部的额外面板（如语言风格管理）
 * 动态从 agent UI 目录加载 LanguageStylesPanel
 */
function AgentPromptExtras({ agentId }) {
  const [Panel, setPanel] = useState(null);

  useEffect(() => {
    loadAgentComponent(agentId, 'LanguageStylesPanel')
      .then(comp => setPanel(() => comp))
      .catch(() => setPanel(null));
  }, [agentId]);

  if (!Panel) return null;
  return <Panel agentId={agentId} />;
}

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

  // Bridge（提供给自定义 tab 组件调 agent 专属 API）
  const bridge = useBridge(configAgentId);

  if (!configAgentId) return null;

  // 从 agent 的 manifest 获取 config tabs，若 agent 没有 manifest 则 fallback 到 layout.config-ui
  const manifest = getAgentManifest(configAgentId);
  const manifestTabs = manifest?.config?.tabs || null;

  // 提取字段元数据
  const defaultTabs = (layout || manifestTabs) ? null : buildDefaultLayout(config);

  const tabs = manifestTabs || layout?.tabs || defaultTabs?.tabs || [];

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={onClose}>{'<'}</button>
        <h2>Agent 配置</h2>
        <div className={styles.headerActions}>
          {agent?.status === 'running' ? (
            <button className={`${styles.btn} ${styles.btnDanger} ${styles.btnSm}`} onClick={handleStop}>
              {isStopping ? '停止中...' : '停止实例'}
            </button>
          ) : (
            <button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`} onClick={handleStart} disabled={isStarting}>
              {isStarting ? '启动中...' : '启动实例'}
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
            <ConfigTabBody
              tab={tab}
              agentId={configAgentId}
              formData={formData}
              agent={agent}
              availableTools={availableTools}
              onFieldChange={handleFieldChange}
              onFieldCommit={handleFieldCommit}
              bridge={bridge}
            />
          </div>
        ))}
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