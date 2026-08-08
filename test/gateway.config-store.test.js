/**
 * Gateway config_store 模块测试
 * 使用临时目录模拟 Agent 配置目录，不依赖真实 Agent
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readAgentConfig, writeAgentConfig } from '../gateway/config_store.js';
import * as api_key_store from '../gateway/api_key_store.js';

describe('config_store', () => {
  let tmpDir;
  let originalCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-config-store-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    // 设置 api_key_store 的根目录
    api_key_store.setApiKeyStoreRootDir(tmpDir);

    // 创建全局 api_key.json
    const globalModels = [
      { model_id: 'gpt-4o', base_url: 'https://api.openai.com/v1', auth_token: 'sk-test-key', model: 'gpt-4o', params_schema: null },
      { model_id: 'claude', base_url: 'https://api.anthropic.com/v1', auth_token: 'sk-ant-key', model: 'claude-3-5-sonnet', params_schema: null }
    ];
    fs.mkdirSync('config', { recursive: true });
    fs.writeFileSync('config/api_key.json', JSON.stringify({ models: globalModels }), 'utf-8');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupConfigDir(config, prompts) {
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    if (prompts) {
      for (const [name, content] of Object.entries(prompts)) {
        fs.writeFileSync(path.join(configDir, name), content, 'utf-8');
      }
    }
    return configDir;
  }

  it('readAgentConfig 应读取 config.json + type:path 文件 + model_id', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', port: 9000, provider: 'llm', model_id: 'gpt-4o', systemPrompt: { type: 'path', content: 'system_prompt.md' }, prefix_prompt: { type: 'path', content: 'prefix_prompt.md' }, suffix_prompt: { type: 'path', content: 'suffix_prompt.md' } },
      { 'system_prompt.md': '系统提示', 'prefix_prompt.md': '前缀', 'suffix_prompt.md': '后缀' }
    );
    const config = readAgentConfig(configDir);
    assert.equal(config.agentId, 'test');
    assert.equal(config.systemPrompt, '系统提示');
    assert.equal(config.prefix_prompt, '前缀');
    assert.equal(config.suffix_prompt, '后缀');
    assert.equal(config.model.base_url, 'https://api.openai.com/v1');
    assert.equal(config.model.model, 'gpt-4o');
    assert.equal(config.model.auth_token, 'sk-test-key');
    assert.equal(config.model.provider, 'llm');
  });

  it('readAgentConfig type:path 文件不存在时应返回空字符串', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', model_id: 'gpt-4o', systemPrompt: { type: 'path', content: 'missing.md' } }
    );
    const config = readAgentConfig(configDir);
    assert.equal(config.systemPrompt, '');
  });

  it('readAgentConfig model_id 为空且无 ELF_FORCE_MOCK_MODEL 时应返回空的 model 对象', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', provider: 'llm' }
    );
    // 确保环境变量未设置
    delete process.env.ELF_FORCE_MOCK_MODEL;
    const config = readAgentConfig(configDir);
    assert.equal(config.model.provider, 'llm'); // model_id 为空时保持 llm，不是 mock
    assert.equal(config.model.base_url, undefined);
    assert.equal(config.model.auth_token, undefined);
    assert.equal(config.model.model, undefined);
    assert.ok(!config.modelError);
  });

  it('readAgentConfig ELF_FORCE_MOCK_MODEL=1 时应强制使用 mock 模式', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', provider: 'llm', model_id: 'gpt-4o' }
    );
    process.env.ELF_FORCE_MOCK_MODEL = '1';
    const config = readAgentConfig(configDir);
    assert.equal(config.model.provider, 'mock');
    assert.ok(!config.modelError);
    delete process.env.ELF_FORCE_MOCK_MODEL;
  });

  it('readAgentConfig model_id 不存在时应设置 modelError', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', provider: 'llm', model_id: 'non-existent' }
    );
    const config = readAgentConfig(configDir);
    assert.ok(config.modelError);
    assert.ok(config.modelError.includes('non-existent'));
  });

  it('writeAgentConfig 应更新 config.json 中的普通字段', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', port: 9000, model_id: 'gpt-4o', memoryTokenLimit: 8000 }
    );
    const result = writeAgentConfig(configDir, { memoryTokenLimit: 12000 });
    assert.equal(result.memoryTokenLimit, 12000);
    assert.equal(result.agentId, 'test');
    // 验证文件也更新了
    const written = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'));
    assert.equal(written.memoryTokenLimit, 12000);
  });

  it('writeAgentConfig 应写入 type:path 文件', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', model_id: 'gpt-4o', systemPrompt: { type: 'path', content: 'system_prompt.md' } },
      { 'system_prompt.md': '旧提示' }
    );
    writeAgentConfig(configDir, { systemPrompt: '新提示' });
    const content = fs.readFileSync(path.join(configDir, 'system_prompt.md'), 'utf-8');
    assert.equal(content, '新提示');
  });

  it('writeAgentConfig 应写入 model_id 字段', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', model_id: 'gpt-4o' }
    );
    writeAgentConfig(configDir, { model_id: 'claude' });
    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'));
    assert.equal(config.model_id, 'claude');
  });

  it('writeAgentConfig 应写入 model_params 字段', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', model_id: 'gpt-4o' }
    );
    writeAgentConfig(configDir, { 'model_params.effort': 'high' });
    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'));
    assert.equal(config.model_params.effort, 'high');
  });

  it('writeAgentConfig 合并 model_params 字段', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', model_id: 'gpt-4o', model_params: { effort: 'low' } }
    );
    writeAgentConfig(configDir, { 'model_params.temperature': 0.7 });
    const result = writeAgentConfig(configDir, { 'model_params.effort': 'medium' });
    assert.equal(result.model_params.effort, 'medium');
    assert.equal(result.model_params.temperature, 0.7);
  });

  it('readAgentConfig 应将 model_params 展平到 model 顶层', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', model_id: 'gpt-4o', model_params: { effort: 'high', temperature: 0.8 } }
    );
    const config = readAgentConfig(configDir);
    assert.equal(config.model.effort, 'high');
    assert.equal(config.model.temperature, 0.8);
  });

  it('writeAgentConfig 应将 provider 写入 config.json', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', provider: 'llm', model_id: 'gpt-4o' }
    );
    const result = writeAgentConfig(configDir, { provider: 'mock' });
    assert.equal(result.provider, 'mock');
  });
});