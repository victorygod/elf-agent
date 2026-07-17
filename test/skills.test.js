/**
 * Skill 支持测试
 *
 * 覆盖：parser / registry（project 覆盖 user、getVisible）/ _formatSkillListing 增量推送 /
 *   Skill 工具 execute 两段消息（① <command-*> 非-isMeta ② 正文裸 isMeta）/ _invokedSkills 记录 /
 *   compact 恢复 invoked_skills / 未启用 agent 零行为
 * 不依赖真实 LLM API
 */

import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFrontmatter } from '../shared/agent/skills/parser.js';
import { SkillRegistry } from '../shared/agent/skills/registry.js';
import { getPromptForCommand } from '../shared/agent/skills/prompt.js';
import { Skill } from '../shared/agent/tools/Skill.js';
import { MessageManager } from '../shared/agent/message_manager.js';
import { Agent } from '../shared/agent/default_agent.js';
import { MockModel } from '../shared/agent/mock_model.js';
import { ToolRegistry } from '../shared/agent/tools/registry.js';

// 构造一个最小 config 对象（Agent 构造需要）
function minConfig() {
  return { get: () => undefined, getModelConfig: () => ({ provider: 'mock' }) };
}

// 创建一个临时 cwd，内含 .elf/skills/<name>/SKILL.md
function makeSkillDir(cwd, name, frontmatter, body) {
  const dir = path.join(cwd, '.elf', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const content = frontmatter
    ? `---\n${frontmatter}\n---\n\n${body}`
    : body;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
  return dir;
}

// 隔离测试环境：把"用户级 skills 目录"重定向到临时目录，避免扫到 ~/.elf/skills 的真实 skill
let _isolatedHome;
before(() => {
  _isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-skill-home-'));
  process.env.ELF_SKILLS_USER_DIR = _isolatedHome;
});
after(() => {
  delete process.env.ELF_SKILLS_USER_DIR;
  fs.rmSync(_isolatedHome, { recursive: true, force: true });
});

// 构造一个启用了 skill 的 agent（不走 fromConfigDir，直接构造 + _enableSkills）
function makeSkillAgent(cwd) {
  const config = minConfig();
  const model = new MockModel();
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(Skill);
  const messageManager = new MessageManager({
    systemPrompt: '', memoryTokenLimit: 9999, dataDir: null, config
  });
  const agent = new Agent({ config, model, toolRegistry, messageManager });
  agent._enableSkills(cwd);
  return agent;
}

// ========================
// parser
// ========================
describe('parser', () => {
  it('拆分 frontmatter 与正文', () => {
    const text = '---\nname: hello\ndescription: 打招呼\n---\n\n正文内容';
    const { frontmatter, body } = parseFrontmatter(text);
    assert.equal(frontmatter.name, 'hello');
    assert.equal(frontmatter.description, '打招呼');
    assert.equal(body.trim(), '正文内容');
  });

  it('无 frontmatter 返回空对象 + 全文 body', () => {
    const { frontmatter, body } = parseFrontmatter('纯正文');
    assert.deepEqual(frontmatter, {});
    assert.equal(body, '纯正文');
  });

  it('布尔与引号字符串', () => {
    const text = '---\nuser-invocable: false\ndisable-model-invocation: true\nname: "带引号"\n---\nx';
    const { frontmatter } = parseFrontmatter(text);
    assert.equal(frontmatter['user-invocable'], false);
    assert.equal(frontmatter['disable-model-invocation'], true);
    assert.equal(frontmatter.name, '带引号');
  });
});

// ========================
// registry
// ========================
describe('SkillRegistry', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-skill-'));
  });

  it('扫描 .elf/skills/ 子目录，name=目录名，对象不存正文', () => {
    makeSkillDir(cwd, 'hello', 'description: 打招呼', '正文');
    const reg = new SkillRegistry();
    reg.loadAll(cwd);
    const s = reg.get('hello');
    assert.ok(s);
    assert.equal(s.name, 'hello');
    assert.equal(s.description, '打招呼');
    assert.ok(s.contentLength > 0);
    assert.equal(s.body, undefined);     // 不存正文
    assert.equal(s.loadedFrom, 'skills');
    assert.equal(s.userInvocable, true);
    assert.equal(s.disableModelInvocation, false);
  });

  it('description 缺失时从正文首个 # 兜底', () => {
    makeSkillDir(cwd, 'fallback', null, '# 兜底标题\n正文');
    const reg = new SkillRegistry();
    reg.loadAll(cwd);
    assert.equal(reg.get('fallback').description, '兜底标题');
  });

  it('getVisible 排除 disableModelInvocation:true', () => {
    makeSkillDir(cwd, 'visible', 'description: a', 'x');
    makeSkillDir(cwd, 'hidden', 'description: b\ndisable-model-invocation: true', 'x');
    const reg = new SkillRegistry();
    reg.loadAll(cwd);
    const names = reg.getVisible().map(s => s.name);
    assert.ok(names.includes('visible'));
    assert.ok(!names.includes('hidden'));
  });

  it('目录不存在静默跳过，不抛错', () => {
    const reg = new SkillRegistry();
    reg.loadAll(cwd);   // cwd 下无 .elf/skills
    assert.equal(reg.getAll().length, 0);
  });
});

// ========================
// _formatSkillListing 增量推送
// ========================
describe('_formatSkillListing 增量推送', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-skill-'));
  });

  it('首推全量，之后无新增返回空', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    makeSkillDir(cwd, 'b', 'description: bb', 'x');
    const agent = makeSkillAgent(cwd);

    const first = agent._formatSkillListing();
    assert.ok(first.includes('- a: aa'));
    assert.ok(first.includes('- b: bb'));
    assert.ok(first.startsWith('<system-reminder>'));
    assert.equal(agent._pushedSkills.size, 2);

    const second = agent._formatSkillListing();
    assert.equal(second, '');    // 无新增 → 不产出
  });

  it('whenToUse 追加到行尾', () => {
    makeSkillDir(cwd, 'w', 'description: d\nwhen_to_use: 何时用', 'x');
    const agent = makeSkillAgent(cwd);
    const listing = agent._formatSkillListing();
    assert.ok(listing.includes('- w: d - 何时用'));
  });

  it('热更新：新增 skill → 推增量', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    const agent = makeSkillAgent(cwd);
    const first = agent._formatSkillListing();
    assert.ok(first.includes('- a: aa'));

    // 会话中途新增 skill b（热更新：入口重扫会发现）
    makeSkillDir(cwd, 'b', 'description: bb', 'x');
    agent._skillRegistry.loadAll(cwd);   // 模拟入口重扫
    const second = agent._formatSkillListing();
    assert.ok(second, '应推增量');
    assert.ok(second.includes('- b: bb'), '含新增 b');
    assert.ok(!second.includes('- a: aa'), '增量只含新增，不含已推的 a');
  });

  it('热更新：删除 skill → 推全量修正清单', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    makeSkillDir(cwd, 'b', 'description: bb', 'x');
    const agent = makeSkillAgent(cwd);
    agent._formatSkillListing();   // 首推全量 a/b

    // 会话中途删除 skill a
    fs.rmSync(path.join(cwd, '.elf', 'skills', 'a'), { recursive: true, force: true });
    agent._skillRegistry.loadAll(cwd);   // 入口重扫：a 消失
    const after = agent._formatSkillListing();
    assert.ok(after, '删除后应推修正清单');
    assert.ok(after.includes('- b: bb'), '修正清单含仍在的 b');
    assert.ok(!after.includes('- a: aa'), '修正清单不含已删的 a');
  });

  it('热更新：改 description → 推全量修正清单', () => {
    makeSkillDir(cwd, 'a', 'description: 旧描述', 'x');
    const agent = makeSkillAgent(cwd);
    agent._formatSkillListing();

    // 改 a 的 description
    fs.writeFileSync(path.join(cwd, '.elf', 'skills', 'a', 'SKILL.md'),
      '---\ndescription: 新描述\n---\nx');
    agent._skillRegistry.loadAll(cwd);
    const after = agent._formatSkillListing();
    assert.ok(after.includes('新描述'));
    assert.ok(!after.includes('旧描述'));
  });

  it('未启用 skill（基类 agent）返回空、不报错', () => {
    const agent = new Agent({ config: minConfig(), model: new MockModel(),
      toolRegistry: new ToolRegistry(), messageManager: new MessageManager({ config: minConfig() }) });
    assert.equal(agent._formatSkillListing(), '');
    assert.equal(agent._skillRegistry, null);
  });

  it('注册了 registry 但未注册 Skill 工具 → 不产出（门控对齐 mhY ①）', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    const config = minConfig();
    const agent = new Agent({ config, model: new MockModel(),
      toolRegistry: new ToolRegistry(),   // 无 Skill 工具
      messageManager: new MessageManager({ config }) });
    agent._enableSkills(cwd);
    assert.equal(agent._formatSkillListing(), '');
  });
});

// ========================
// Skill 工具 execute 两段消息
// ========================
describe('Skill 工具 execute', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-skill-'));
  });

  it('注入 ① <command-*> 非-isMeta + ② 正文裸 isMeta，并记录 _invokedSkills', async () => {
    makeSkillDir(cwd, 'hello', 'description: 打招呼', '你好，${CLAUDE_SKILL_DIR} 的 skill。参数=$ARGUMENTS');
    const agent = makeSkillAgent(cwd);
    const before = agent.messageManager.messages.length;

    const result = await Skill.execute({ skill: 'hello', args: '世界' }, {}, { agent });

    assert.equal(result, 'Skill \'hello\' loaded');
    // 新增两条消息
    assert.equal(agent.messageManager.messages.length, before + 2);
    const m1 = agent.messageManager.messages[before];
    const m2 = agent.messageManager.messages[before + 1];

    // ① 非 isMeta，含 <command-name> / <command-message> / <command-args>
    assert.equal(m1.isMeta, undefined);
    assert.ok(m1.content.includes('<command-name>hello</command-name>'));
    assert.ok(m1.content.includes('<command-message>/hello</command-message>'));
    assert.ok(m1.content.includes('<command-args>世界</command-args>'));

    // ② isMeta，裸正文，含 Base directory 前缀 + 变量替换；不包 <system-reminder>
    assert.equal(m2.isMeta, true);
    assert.equal(m2.metaTag, 'skill_invocation');
    assert.ok(m2.content.startsWith('Base directory for this skill:'));
    assert.ok(m2.content.includes('你好'));
    assert.ok(m2.content.includes('参数=世界'));         // $ARGUMENTS 替换
    assert.ok(!m2.content.includes('<system-reminder>')); // 裸，不包
    assert.ok(!m2.content.includes('${CLAUDE_SKILL_DIR}')); // 变量已替换

    // _invokedSkills 记录全文
    assert.equal(agent._invokedSkills.length, 1);
    assert.equal(agent._invokedSkills[0].name, 'hello');
  });

  it('无 args 时不输出 <command-args> 行', async () => {
    makeSkillDir(cwd, 'noargs', 'description: x', '正文');
    const agent = makeSkillAgent(cwd);
    await Skill.execute({ skill: 'noargs' }, {}, { agent });
    const last = agent.messageManager.messages[agent.messageManager.messages.length - 2];
    assert.ok(!last.content.includes('<command-args>'));
  });

  it('未知 skill 报错，不注入消息', async () => {
    const agent = makeSkillAgent(cwd);
    const before = agent.messageManager.messages.length;
    const r = await Skill.execute({ skill: 'noexist' }, {}, { agent });
    assert.ok(r.startsWith('Error: Unknown skill'));
    assert.equal(agent.messageManager.messages.length, before);
  });

  it('未启用的 agent 报错', async () => {
    const agent = new Agent({ config: minConfig(), model: new MockModel(),
      toolRegistry: new ToolRegistry(), messageManager: new MessageManager({ config: minConfig() }) });
    const r = await Skill.execute({ skill: 'x' }, {}, { agent });
    assert.ok(r.includes('not enabled'));
  });

  it('fork skill 报错跳过', async () => {
    makeSkillDir(cwd, 'forker', 'description: x\ncontext: fork', '正文');
    const agent = makeSkillAgent(cwd);
    const r = await Skill.execute({ skill: 'forker' }, {}, { agent });
    assert.ok(r.includes('fork skills not supported'));
  });
});

// ========================
// compact 恢复 invoked_skills
// ========================
describe('compact 恢复 invoked_skills', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-skill-'));
  });

  it('压缩后重推：清单 + invoked_skills（有触发过的）都补回', async () => {
    makeSkillDir(cwd, 'hello', 'description: 打招呼', '你好');
    const agent = makeSkillAgent(cwd);
    agent._formatSkillListing();                 // 先推一次清单（全加入 _pushedSkills）
    await Skill.execute({ skill: 'hello' }, {}, { agent });  // 触发一次，记录 _invokedSkills
    const before = agent.messageManager.messages.length;

    await agent._reinjectMetaMessages();

    // 压缩后补两条：先全量 listing，再 invoked_skills 全文
    assert.equal(agent.messageManager.messages.length, before + 2);
    const mListing = agent.messageManager.messages[before];
    const mInvoked = agent.messageManager.messages[before + 1];
    assert.equal(mListing.metaTag, 'skill_listing');
    assert.ok(mListing.content.includes('following skills'));
    assert.equal(mInvoked.metaTag, 'invoked_skills');
    assert.ok(mInvoked.content.includes('The following skills were invoked in this session'));
    assert.ok(mInvoked.content.includes('### Skill: hello'));
    assert.ok(mInvoked.content.includes('你好'));          // 正文全文
  });

  it('压缩后只补清单（无已触发 skill 时不补 invoked_skills）', async () => {
    makeSkillDir(cwd, 'hello', 'description: 打招呼', '你好');
    const agent = makeSkillAgent(cwd);
    const before = agent.messageManager.messages.length;
    await agent._reinjectMetaMessages();   // _invokedSkills 为空
    assert.equal(agent.messageManager.messages.length, before + 1);  // 只补 listing
    assert.equal(agent.messageManager.messages[before].metaTag, 'skill_listing');
  });

  it('compact 后清单重推（压缩把 listing 吞了，补回全量）', async () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    const agent = makeSkillAgent(cwd);
    const first = agent._formatSkillListing();
    assert.ok(first);                                   // 首推全量
    await agent._reinjectMetaMessages();                // compact 后钩子：重置快照 + 重推全量
    // 重新算：快照已被重置并重推过，再调应返回空（无新变化）
    const after = agent._formatSkillListing();
    assert.equal(after, '');
  });

  it('清空记忆（_resetSkillPushState）后重新首推全量', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    makeSkillDir(cwd, 'b', 'description: bb', 'x');
    const agent = makeSkillAgent(cwd);
    agent._formatSkillListing();          // 首推，_pushedSkills 记满
    assert.equal(agent._formatSkillListing(), '');   // 无变化不推

    // 清空记忆 = 会话重开 → 重置去重快照（对齐 CC Pc）
    agent.messageManager.clear();
    agent._resetSkillPushState();

    // 下一轮应重新首推全量
    const after = agent._formatSkillListing();
    assert.ok(after, '清空记忆后应重新首推');
    assert.ok(after.includes('- a: aa'));
    assert.ok(after.includes('- b: bb'));
  });
});