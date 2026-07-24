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
import { parseFrontmatter } from '../engine/skills/parser.js';
import { SkillRegistry } from '../engine/skills/registry.js';
import { SkillLister } from '../engine/skills/lister.js';
import { getPromptForCommand } from '../engine/skills/prompt.js';
import { Skill } from '../engine/tools/Skill.js';
import { MessageManager } from '../engine/message_manager.js';
import { Agent } from '../engine/default_agent.js';
import { MockModel } from '../engine/mock_model.js';
import { ToolManager } from '../engine/tools/tool_manager.js';

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

// 构造一个启用了 skill 的 agent（不走 fromConfigDir，直接构造 + 挂 SkillLister）
function makeSkillAgent(cwd) {
  const config = minConfig();
  const model = new MockModel();
  const toolManager = new ToolManager();
  toolManager.register(Skill);
  const messageManager = new MessageManager({
    systemPrompt: '', memoryTokenLimit: 9999, dataDir: null, config
  });
  const agent = new Agent({ config, model, toolManager, messageManager });
  agent.skillLister = new SkillLister({ messageManager, toolManager, cwd });
  agent.skillLister.enable();
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

    const first = agent.skillLister._formatListing();
    assert.ok(first.includes('- a: aa'));
    assert.ok(first.includes('- b: bb'));
    assert.ok(first.startsWith('<system-reminder>'));
    assert.equal(agent.skillLister._pushedSkills.size, 2);

    const second = agent.skillLister._formatListing();
    assert.equal(second, '');    // 无新增 → 不产出
  });

  it('whenToUse 追加到行尾', () => {
    makeSkillDir(cwd, 'w', 'description: d\nwhen_to_use: 何时用', 'x');
    const agent = makeSkillAgent(cwd);
    const listing = agent.skillLister._formatListing();
    assert.ok(listing.includes('- w: d - 何时用'));
  });

  it('热更新：新增 skill → 推增量', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    const agent = makeSkillAgent(cwd);
    const first = agent.skillLister._formatListing();
    assert.ok(first.includes('- a: aa'));

    // 会话中途新增 skill b（热更新：入口重扫会发现）
    makeSkillDir(cwd, 'b', 'description: bb', 'x');
    agent.skillLister.registry.loadAll(cwd);   // 模拟入口重扫
    const second = agent.skillLister._formatListing();
    assert.ok(second, '应推增量');
    assert.ok(second.includes('- b: bb'), '含新增 b');
    assert.ok(!second.includes('- a: aa'), '增量只含新增，不含已推的 a');
  });

  it('热更新：删除 skill → 推全量修正清单', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    makeSkillDir(cwd, 'b', 'description: bb', 'x');
    const agent = makeSkillAgent(cwd);
    agent.skillLister._formatListing();   // 首推全量 a/b

    // 会话中途删除 skill a
    fs.rmSync(path.join(cwd, '.elf', 'skills', 'a'), { recursive: true, force: true });
    agent.skillLister.registry.loadAll(cwd);   // 入口重扫：a 消失
    const after = agent.skillLister._formatListing();
    assert.ok(after, '删除后应推修正清单');
    assert.ok(after.includes('- b: bb'), '修正清单含仍在的 b');
    assert.ok(!after.includes('- a: aa'), '修正清单不含已删的 a');
  });

  it('热更新：改 description → 推全量修正清单', () => {
    makeSkillDir(cwd, 'a', 'description: 旧描述', 'x');
    const agent = makeSkillAgent(cwd);
    agent.skillLister._formatListing();

    // 改 a 的 description
    fs.writeFileSync(path.join(cwd, '.elf', 'skills', 'a', 'SKILL.md'),
      '---\ndescription: 新描述\n---\nx');
    agent.skillLister.registry.loadAll(cwd);
    const after = agent.skillLister._formatListing();
    assert.ok(after.includes('新描述'));
    assert.ok(!after.includes('旧描述'));
  });

  it('未启用 skill（基类 agent）skillLister 为 null、零行为', () => {
    const agent = new Agent({ config: minConfig(), model: new MockModel(),
      toolManager: new ToolManager(), messageManager: new MessageManager({ config: minConfig() }) });
    assert.equal(agent.skillLister, null);
  });

  it('注册了 registry 但未注册 Skill 工具 → 不产出（门控对齐 mhY ①）', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    const config = minConfig();
    const toolManager = new ToolManager();   // 无 Skill 工具
    const messageManager = new MessageManager({ config });
    const agent = new Agent({ config, model: new MockModel(), toolManager, messageManager });
    agent.skillLister = new SkillLister({ messageManager, toolManager, cwd });
    agent.skillLister.enable();
    assert.equal(agent.skillLister._formatListing(), '');
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
    assert.equal(agent.skillLister.invokedSkills.length, 1);
    assert.equal(agent.skillLister.invokedSkills[0].name, 'hello');
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
      toolManager: new ToolManager(), messageManager: new MessageManager({ config: minConfig() }) });
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

  it('压缩后重推：清单字段补全量 + invoked_skills（有触发过的）补回全文', async () => {
    makeSkillDir(cwd, 'hello', 'description: 打招呼', '你好');
    const agent = makeSkillAgent(cwd);
    agent.skillLister._formatListing();                 // 先推一次清单（全加入 _pushedSkills）
    await Skill.execute({ skill: 'hello' }, {}, { agent });  // 触发一次，记录 _invokedSkills
    const before = agent.messageManager.messages.length;

    await agent.skillLister.reinvokeAfterCompact();

    // skill 清单不再持久化进 messages（临注入），故 messages 只新增 invoked_skills 一条。
    assert.equal(agent.messageManager.messages.length, before + 1);
    const mInvoked = agent.messageManager.messages[before];
    assert.equal(mInvoked.metaTag, 'invoked_skills');
    assert.ok(mInvoked.content.includes('The following skills were invoked in this session'));
    assert.ok(mInvoked.content.includes('### Skill: hello'));
    assert.ok(mInvoked.content.includes('你好'));          // 正文全文

    // 全量清单经 refreshSkillListing 写入 skillListing 字段（不进 messages，临注入到 LLM 请求）。
    assert.ok(agent.messageManager.skillListing.includes('following skills'));
    assert.ok(agent.messageManager.skillListing.includes('- hello: 打招呼'));
  });

  it('压缩后只补清单字段（无已触发 skill 时不补 invoked_skills）', async () => {
    makeSkillDir(cwd, 'hello', 'description: 打招呼', '你好');
    const agent = makeSkillAgent(cwd);
    const before = agent.messageManager.messages.length;
    await agent.skillLister.reinvokeAfterCompact();   // _invokedSkills 为空
    // listing 不进 messages；无 invoked_skills → messages 不增
    assert.equal(agent.messageManager.messages.length, before);
    // 但 skillListing 字段已被补为全量
    assert.ok(agent.messageManager.skillListing.includes('following skills'));
    assert.ok(agent.messageManager.skillListing.includes('- hello: 打招呼'));
  });

  it('compact 后清单重推（压缩把 listing 吞了，补回全量）', async () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    const agent = makeSkillAgent(cwd);
    const first = agent.skillLister._formatListing();
    assert.ok(first);                                   // 首推全量
    await agent.skillLister.reinvokeAfterCompact();                // compact 后钩子：重置快照 + 重推全量
    // 重新算：快照已被重置并重推过，再调应返回空（无新变化）
    const after = agent.skillLister._formatListing();
    assert.equal(after, '');
  });

  it('清空记忆（_resetSkillPushState）后重新首推全量', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    makeSkillDir(cwd, 'b', 'description: bb', 'x');
    const agent = makeSkillAgent(cwd);
    agent.skillLister._formatListing();          // 首推，_pushedSkills 记满
    assert.equal(agent.skillLister._formatListing(), '');   // 无变化不推

    // 清空记忆 = 会话重开 → 重置去重快照（对齐 CC Pc）
    agent.messageManager.clear();
    agent.skillLister.reset();

    // 下一轮应重新首推全量
    const after = agent.skillLister._formatListing();
    assert.ok(after, '清空记忆后应重新首推');
    assert.ok(after.includes('- a: aa'));
    assert.ok(after.includes('- b: bb'));
  });
});

// ========================
// skill_listing 临注入（不持久化、不堆积）
// ========================
describe('skill_listing 临注入（不发写入记忆）', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-skill-'));
  });

  it('多轮 _injectSkillListing 不往 messages 堆 listing，skillListing 字段每轮在场', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    const agent = makeSkillAgent(cwd);

    // 模拟 3 轮 reasoning 入口
    agent.skillLister.inject();
    agent.messageManager.addUserMessage('第一轮');
    agent.skillLister.inject();
    agent.messageManager.addUserMessage('第二轮');
    agent.skillLister.inject();
    agent.messageManager.addUserMessage('第三轮');

    // messages 里没有任何 skill_listing 持久化消息
    const listings = agent.messageManager.messages.filter(m => m.metaTag === 'skill_listing');
    assert.equal(listings.length, 0);
    // 字段仍在场，含全量清单
    assert.ok(agent.messageManager.skillListing.includes('following skills'));
    assert.ok(agent.messageManager.skillListing.includes('- a: aa'));
  });

  it('getMessagesForLLM 临注入一份 listing 到最近 user 之前，且过滤旧持久化 listing', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    const agent = makeSkillAgent(cwd);
    agent.skillLister.inject();
    agent.messageManager.addUserMessage('你好');

    const msgs = agent.messageManager.getMessagesForLLM();
    // system + 临时 listing + user = 3
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[0].role, 'system');
    const listingMsg = msgs[1];
    assert.equal(listingMsg.role, 'user');
    assert.ok(listingMsg.content.includes('following skills'), '临注入 listing 应在 user 之前');
    assert.equal(msgs[2].content, '你好');
  });

  it('旧 context.json 里残留的 skill_listing 持久化消息被 getMessagesForLLM 过滤掉', () => {
    makeSkillDir(cwd, 'a', 'description: aa', 'x');
    const agent = makeSkillAgent(cwd);
    // 模拟旧版本写入的持久化 listing（直接塞进 messages，模拟历史残留）
    agent.messageManager.addMetaMessage('<system-reminder>\nold listing\n</system-reminder>', 'skill_listing');
    agent.messageManager.addUserMessage('你好');
    agent.skillLister.inject();

    const msgs = agent.messageManager.getMessagesForLLM();
    // 旧持久化 listing 不应出现，只剩本轮临注入的那一份
    const listCount = msgs.filter(m => m.role === 'user' && m.content.includes('listing')).length;
    assert.equal(listCount, 0);
    const fresh = msgs.filter(m => m.role === 'user' && m.content.includes('following skills'));
    assert.equal(fresh.length, 1, '只保留本轮临注入一份');
  });
});