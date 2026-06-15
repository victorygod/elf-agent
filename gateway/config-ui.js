/**
 * 根据 config.json + api_key.json 自动生成配置页面 HTML（双选项卡）
 *
 * 规则：
 *   - Agent 配置选项卡：头像 + 系统提示词 + config.json 的非内部字段
 *   - 模型配置选项卡：base_url / auth_token / model（来自 api_key.json）
 *   - provider 不在 UI 中展示（仅用于测试或手动修改 config.json）
 *   - api_key.json 缺失时，模型选项卡显示空表单字段
 *   - 字段的 label / hint 来自 config.json 中的 _ui 字段定义
 *   - input type 按值的类型推断（auth_token 默认 text 不做脱敏），password 需在 _ui 中显式指定
 *   - HTML 模板在 frontend/default-config-ui.html
 */

import fs from 'fs';
import path from 'path';

const TEMPLATE_PATH = path.join(process.cwd(), 'frontend', 'default-config-ui.html');

/** 不在 Agent 配置面板展示的字段（模型字段在独立选项卡，提示词字段在模板中单独处理） */
const SKIP_KEYS = new Set([
  'agentId', 'port', 'systemPromptPath', 'prefixPromptPath', 'suffixPromptPath',
  'avatar', 'userAvatar', '_ui', 'provider',
  'systemPrompt', 'prefix_prompt', 'suffix_prompt',
  'model', 'modelError',
]);

/** 模型字段的 _ui 默认定义 */
const MODEL_UI_DEFAULTS = {
  'base_url': { label: 'API Base URL', hint: 'LLM API 端点地址' },
  'auth_token': { label: 'Auth Token', hint: 'LLM API 认证密钥', type: 'text' },
  'model': { label: '模型名称', hint: '如 gpt-4o、GLM-5.1、deepseek-chat' },
};

/**
 * HTML 转义
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 遍历 config 对象，提取可配置字段列表（排除内部字段和模型字段）
 * 返回 [{key, label, hint, type, value}]
 */
function extractAgentFields(config) {
  const uiMeta = config._ui || {};
  const fields = [];

  function walk(obj, prefix) {
    for (const [key, value] of Object.entries(obj)) {
      if (SKIP_KEYS.has(key)) continue;
      const dotKey = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value, dotKey);
      } else {
        const meta = uiMeta[dotKey] || {};
        const label = meta.label || dotKey;
        const hint = meta.hint || '';
        let type = meta.type;
        if (!type) {
          if (typeof value === 'boolean') type = 'checkbox';
          else if (typeof value === 'number') type = 'number';
          else if (typeof value === 'string' && value.length > 100) type = 'textarea';
          else type = 'text';
        }
        fields.push({ key: dotKey, label, hint, type, value });
      }
    }
  }

  walk(config, '');
  return fields;
}

/**
 * 从 apiKeyData 提取模型配置字段
 * 返回 [{key, label, hint, type, value}]  — key 不带 model. 前缀
 */
function extractModelFields(apiKeyData) {
  const fields = [];
  for (const [key, value] of Object.entries(apiKeyData)) {
    if (SKIP_KEYS.has(key)) continue;
    const meta = MODEL_UI_DEFAULTS[key] || {};
    const label = meta.label || key;
    const hint = meta.hint || '';
    let type = meta.type;
    if (!type) {
      if (typeof value === 'boolean') type = 'checkbox';
      else if (typeof value === 'number') type = 'number';
      else if (typeof value === 'string' && value.length > 100) type = 'textarea';
      else type = 'text';
    }
    fields.push({ key, label, hint, type, value });
  }
  return fields;
}

/**
 * 将字段列表渲染为 HTML 片段
 */
function renderFields(fields) {
  return fields.map(f => {
    const escaped = f.value !== null && f.value !== undefined ? escapeHtml(f.value) : '';
    const hintHtml = f.hint ? `<div class="cfg-hint">${escapeHtml(f.hint)}</div>` : '';

    switch (f.type) {
      case 'textarea':
        return `<div class="cfg-field">
  <label>${escapeHtml(f.label)}</label>
  <textarea data-key="${f.key}">${escaped}</textarea>
  ${hintHtml}
</div>`;

      case 'password':
        return `<div class="cfg-field">
  <label>${escapeHtml(f.label)}</label>
  <input type="password" data-key="${f.key}" placeholder="${f.value ? '*** (未修改)' : ''}" />
  ${hintHtml}
</div>`;

      case 'number':
        return `<div class="cfg-field">
  <label>${escapeHtml(f.label)}</label>
  <input type="number" data-key="${f.key}" value="${escaped}" />
  ${hintHtml}
</div>`;

      case 'checkbox': {
        const checked = f.value ? 'checked' : '';
        return `<div class="cfg-field cfg-checkbox">
  <label><input type="checkbox" data-key="${f.key}" ${checked} /> ${escapeHtml(f.label)}</label>
</div>`;
      }

      default: // text
        return `<div class="cfg-field">
  <label>${escapeHtml(f.label)}</label>
  <input type="text" data-key="${f.key}" value="${escaped}" />
  ${hintHtml}
</div>`;
    }
  }).join('\n');
}

/**
 * 生成头像上传区域 HTML
 * @param {string} agentId
 * @param {string} avatar - 当前头像文件名
 * @param {string} userAvatar - 当前用户头像文件名
 * @returns {string}
 */
function renderAvatarSection(agentId, avatar, userAvatar) {
  const apiBase = ''; // 同源，相对路径即可
  const avatarImg = avatar
    ? `<img src="${apiBase}/agents/${escapeHtml(agentId)}/config/${escapeHtml(avatar)}?t=${Date.now()}" alt="头像">`
    : '<span class="placeholder">点击<br>上传</span>';
  const userAvatarImg = userAvatar
    ? `<img src="${apiBase}/agents/${escapeHtml(agentId)}/config/${escapeHtml(userAvatar)}?t=${Date.now()}" alt="我">`
    : '<span class="placeholder">点击<br>上传</span>';

  return `<div class="cfg-avatar-row">
  <div class="cfg-avatar-col">
    <label>Agent 头像</label>
    <div class="cfg-avatar-preview ${avatar ? 'has-avatar' : ''}" id="cfgAvatarPreview"
         onclick="document.getElementById('cfgAvatarFile').click()">
      ${avatarImg}
    </div>
    <input type="file" id="cfgAvatarFile" accept="image/png,image/jpeg,image/gif,image/webp"
           style="display:none" onchange="uploadAvatar(this,'avatar')" />
  </div>
  <div class="cfg-avatar-col">
    <label>用户头像</label>
    <div class="cfg-avatar-preview ${userAvatar ? 'has-avatar' : ''}" id="cfgUserAvatarPreview"
         onclick="document.getElementById('cfgUserAvatarFile').click()">
      ${userAvatarImg}
    </div>
    <input type="file" id="cfgUserAvatarFile" accept="image/png,image/jpeg,image/gif,image/webp"
           style="display:none" onchange="uploadAvatar(this,'user-avatar')" />
  </div>
</div>`;
}

/**
 * 生成默认配置页面 HTML（双选项卡：Agent 配置 + 模型配置）
 * @param {string} agentId
 * @param {object} config - config.json 的内容（含 systemPrompt 等）
 * @param {object|null} apiKeyData - api_key.json 的内容，null 表示缺失
 * @returns {string} 完整 HTML
 */
export function generateDefaultConfigUI(agentId, config, apiKeyData) {
  // Agent 配置字段（排除 systemPrompt、模型等已在专门区域处理的字段）
  const agentFields = extractAgentFields(config);
  const agentFieldsHtml = renderFields(agentFields);

  // 头像上传区域
  const avatarHtml = renderAvatarSection(agentId, config.avatar, config.userAvatar);

  // 读取 HTML 模板
  let template;
  try {
    template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  } catch (err) {
    template = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>{{agentFields}}</body></html>';
  }

  return template
    .replace('{{agentId}}', escapeHtml(agentId))
    .replace('{{avatarHtml}}', avatarHtml)
    .replace('{{agentFields}}', agentFieldsHtml);
}