/**
 * Gateway api_key_store 模块测试
 * 使用临时目录模拟全局 api_key.json
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as api_key_store from '../gateway/api_key_store.js';

describe('api_key_store', () => {
  let tmpDir;
  let originalCwd;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-api-key-store-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    api_key_store.setApiKeyStoreRootDir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readGlobalModels 应读取 api_key.json 中的 models 数组', () => {
    const testModels = [
      { model_id: 'gpt-4o', base_url: 'https://api.openai.com/v1', auth_token: 'sk-key', model: 'gpt-4o', params_schema: null }
    ];
    fs.mkdirSync('config', { recursive: true });
    fs.writeFileSync('config/api_key.json', JSON.stringify({ models: testModels }), 'utf-8');

    const models = api_key_store.readGlobalModels();

    assert.equal(models.length, 1);
    assert.equal(models[0].model_id, 'gpt-4o');
    assert.equal(models[0].base_url, 'https://api.openai.com/v1');
  });

  it('readGlobalModels api_key.json 不存在时应返回空数组', () => {
    const models = api_key_store.readGlobalModels();

    assert.equal(models.length, 0);
  });

  it('writeGlobalModels 应写入 models 数组到 api_key.json', () => {
    const testModels = [
      { model_id: 'gpt-4o', base_url: 'https://api.openai.com/v1', auth_token: 'sk-key', model: 'gpt-4o', params_schema: null }
    ];

    api_key_store.writeGlobalModels(testModels);

    const content = fs.readFileSync('config/api_key.json', 'utf-8');
    const data = JSON.parse(content);

    assert.equal(data.models.length, 1);
    assert.equal(data.models[0].model_id, 'gpt-4o');

    const models = api_key_store.readGlobalModels();
    assert.equal(models.length, 1);
  });

  it('resolveModelConfig model_id 命中时应返回连接信息并展平 model_params', () => {
    api_key_store.writeGlobalModels([
      { model_id: 'gpt-4o', base_url: 'https://api.openai.com/v1', auth_token: 'sk-key', model: 'gpt-4o', params_schema: null },
    ]);

    const { model, modelError } = api_key_store.resolveModelConfig({
      model_id: 'gpt-4o', provider: 'llm', model_params: { effort: 'high' },
    });

    assert.equal(model.provider, 'llm');
    assert.equal(model.base_url, 'https://api.openai.com/v1');
    assert.equal(model.auth_token, 'sk-key');
    assert.equal(model.model, 'gpt-4o');
    assert.equal(model.effort, 'high');   // 展平到顶层，供 extractExtraParams 透传
    assert.equal(modelError, null);
  });

  it('resolveModelConfig 空列表时 model_id 命中失败应返回 modelError', () => {
    const { model, modelError } = api_key_store.resolveModelConfig({
      model_id: 'non-existent', provider: 'llm', model_params: {},
    });

    assert.equal(model.base_url, undefined);
    assert.equal(model.model, undefined);
    assert.ok(modelError && modelError.includes('non-existent'));
  });

  it('resolveModelConfig 空 model_id 时返回空 model 对象且无 modelError', () => {
    const { model, modelError } = api_key_store.resolveModelConfig({
      model_id: '', provider: 'llm', model_params: { effort: 'high' },
    });

    assert.equal(model.provider, 'llm');
    assert.equal(model.base_url, undefined);
    assert.equal(model.auth_token, undefined);
    assert.equal(model.model, undefined);
    assert.equal(model.effort, 'high');
    assert.equal(modelError, null);
  });
});