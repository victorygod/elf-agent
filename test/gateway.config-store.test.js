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

describe('config_store', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-config-store-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupConfigDir(config, apiKey, prompts) {
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    if (apiKey !== undefined) {
      fs.writeFileSync(path.join(configDir, 'api_key.json'), JSON.stringify(apiKey, null, 2), 'utf-8');
    }
    if (prompts) {
      for (const [name, content] of Object.entries(prompts)) {
        fs.writeFileSync(path.join(configDir, name), content, 'utf-8');
      }
    }
    return configDir;
  }

  it('readAgentConfig 应读取 config.json + type:path 文件 + api_key.json', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', port: 9000, provider: 'llm', systemPrompt: { type: 'path', content: 'system_prompt.md' }, prefix_prompt: { type: 'path', content: 'prefix_prompt.md' }, suffix_prompt: { type: 'path', content: 'suffix_prompt.md' } },
      { base_url: 'https://api.test.com', auth_token: 'key', model: 'gpt-4o' },
      { 'system_prompt.md': '系统提示', 'prefix_prompt.md': '前缀', 'suffix_prompt.md': '后缀' }
    );
    const config = readAgentConfig(configDir);
    assert.equal(config.agentId, 'test');
    assert.equal(config.systemPrompt, '系统提示');
    assert.equal(config.prefix_prompt, '前缀');
    assert.equal(config.suffix_prompt, '后缀');
    assert.equal(config.model.base_url, 'https://api.test.com');
    assert.equal(config.model.provider, 'llm');
  });

  it('readAgentConfig type:path 文件不存在时应返回空字符串', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', systemPrompt: { type: 'path', content: 'missing.md' } },
      { base_url: 'https://api.test.com', auth_token: 'key', model: 'm' }
    );
    const config = readAgentConfig(configDir);
    assert.equal(config.systemPrompt, '');
  });

  it('readAgentConfig 模型配置不完整时应设置 modelError', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', provider: 'llm' },
      { base_url: 'https://api.test.com', auth_token: '', model: '' }
    );
    const config = readAgentConfig(configDir);
    assert.ok(config.modelError);
    assert.ok(config.modelError.includes('auth_token'));
    assert.ok(config.modelError.includes('model'));
  });

  it('readAgentConfig mock provider 时不应设置 modelError', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', provider: 'mock' },
      {}
    );
    const config = readAgentConfig(configDir);
    assert.ok(!config.modelError);
  });

  it('writeAgentConfig 应更新 config.json 中的普通字段', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', port: 9000, memoryTokenLimit: 8000 },
      { base_url: 'https://api.test.com', auth_token: 'key', model: 'm' }
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
      { agentId: 'test', systemPrompt: { type: 'path', content: 'system_prompt.md' } },
      { base_url: 'https://api.test.com', auth_token: 'key', model: 'm' },
      { 'system_prompt.md': '旧提示' }
    );
    writeAgentConfig(configDir, { systemPrompt: '新提示' });
    const content = fs.readFileSync(path.join(configDir, 'system_prompt.md'), 'utf-8');
    assert.equal(content, '新提示');
  });

  it('writeAgentConfig 应将 model 字段写入 api_key.json', () => {
    const configDir = setupConfigDir(
      { agentId: 'test' },
      { base_url: 'https://old.com', auth_token: 'old-key', model: 'old-model' }
    );
    writeAgentConfig(configDir, { model: { auth_token: 'new-key' } });
    const apiKey = JSON.parse(fs.readFileSync(path.join(configDir, 'api_key.json'), 'utf-8'));
    assert.equal(apiKey.auth_token, 'new-key');
    assert.equal(apiKey.base_url, 'https://old.com'); // 未修改的字段保留
  });

  it('writeAgentConfig 应将 model.provider 写入 config.json', () => {
    const configDir = setupConfigDir(
      { agentId: 'test', provider: 'llm' },
      { base_url: 'https://api.test.com', auth_token: 'key', model: 'm' }
    );
    const result = writeAgentConfig(configDir, { model: { provider: 'mock' } });
    assert.equal(result.provider, 'mock');
  });
});