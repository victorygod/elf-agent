/**
 * DM Agent (elf-018) 测试：Roll / DNDMessageManager / DNDAgent 4-loop workflow
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Roll } from '../agents/elf-018/tools/Roll.js';
import { makeWriteOutline } from '../agents/elf-018/tools/WriteOutline.js';
import { makeEditOutline } from '../agents/elf-018/tools/EditOutline.js';
import { makeRead } from '../agents/elf-018/tools/Read.js';
import { makeWrite } from '../agents/elf-018/tools/Write.js';
import { makeEdit } from '../agents/elf-018/tools/Edit.js';
import { reset as resetReadState } from '../engine/tools/read_state.js';
import { MockModel } from '../engine/models/index.js';
import { ToolManager } from '../engine/tools/tool_manager.js';
import { Read, Write, Edit, Grep } from '../engine/tools/index.js';
import { Config } from '../engine/config_loader.js';
import { MessageManager, SUMMARY_PREAMBLE, CONTINUATION_CLAUSE } from '../engine/message_manager.js';
import { MessageManager as DNDMessageManager } from '../agents/elf-018/message_manager.js';
import { DNDAgent } from '../agents/elf-018/agent.js';
import { Agent } from '../engine/agent.js';
import { LLMModel } from '../engine/models/index.js';
import { buildStyleMetadata } from '../shared/agents/elf-018/buildMetadata.js';

// 带 frontmatter 的角色卡内容（lore 文件须符合此规范，专版 Write 后置校验）
const charProfile = (body) => `---\nname: 勇者\ndescription: 玩家角色（主角）\n---\n${body}`;

// ========================
// Roll 工具
// ========================
describe('Roll 工具', () => {
  it('返回格式含 d20 点数与用途', async () => {
    const r = await Roll.execute({ purpose: '攻击判定', dc: 10, modifier: 2 });
    assert.match(r, /Roll 1d20=\d+/);
    assert.match(r, /vs DC 10/);
    assert.match(r, /（攻击判定）/);
    assert.ok(/大失败|大成功|成功|失败/.test(r));
  });

  it('省略 dc 时不判过（无 vs DC，自然1/20 仍大失败/大成功）', async () => {
    const r = await Roll.execute({ purpose: '测试' });
    assert.match(r, /Roll 1d20=\d+/);
    assert.doesNotMatch(r, /vs DC/);
  });

  it('自然 1/20 文本在范围内可出现（多次抽样）', async () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const r = await Roll.execute({ purpose: '采样', dc: 10 });
      const m = r.match(/Roll 1d20=(\d+)/);
      seen.add(Number(m[1]));
      if (seen.has(1) && seen.has(20)) break;
    }
    assert.ok(seen.has(1) && seen.has(20), '多次掷骰应能采到 1 和 20');
  });

  it('1d8 伤害骰：无 dc、只出数值、不判 nat', async () => {
    const r = await Roll.execute({ purpose: '长剑伤害', dice: '1d8', modifier: 3 });
    assert.match(r, /Roll 1d8=\d+/);
    assert.match(r, /仅掷骰/);
    assert.doesNotMatch(r, /vs DC/);
    assert.doesNotMatch(r, /大成功|大失败/);   // 非 1d20 不判 nat
  });

  it('2d6 多颗骰：显示逐骰与求和', async () => {
    const r = await Roll.execute({ purpose: '伤害', dice: '2d6' });
    assert.match(r, /Roll 2d6=\d+\+\d+=\d+/);
    assert.doesNotMatch(r, /大成功|大失败/);
  });

  it('dice 默认 1d20（不传时）', async () => {
    const r = await Roll.execute({ purpose: '默认', dc: 10 });
    assert.match(r, /Roll 1d20=\d+/);
  });
});

// ========================
// DNDMessageManager（按最近 user 压缩）
// ========================
describe('DNDMessageManager', () => {
  it('压缩保留最近 user 及其后、之前被摘要替换', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-dndmm-'));
    const mm = new DNDMessageManager({
      systemPrompt: 'sys', memoryTokenLimit: 40000,
      compactPrompt: '总结', compactSystemPrompt: '压缩器', dataDir: tmp, config: null,
    });
    // 历史：user1 / assistant1 / user2(最近) / assistant2
    mm.addUserMessage('第一轮指令');
    mm.addAssistantMessage('第一轮回复');
    mm.addUserMessage('第二轮指令');
    mm.addAssistantMessage('第二轮回复');
    const lastUserId = mm.messages[2].id;

    // mock model.chat 返回固定摘要
    const model = new MockModel({ responses: [{ content: '历史剧情摘要' }] });
    const r = await mm._doCompact(model);
    assert.ok(r.summary);
    assert.equal(r.anchorId, lastUserId);

    mm._applyResultSync(r);
    // messages = [摘要(含 isCompactSummary), user2, assistant2]
    assert.equal(mm.messages.length, 3);
    assert.equal(mm.messages[0].isCompactSummary, true);
    assert.equal(mm.messages[0].content, expectPreamble() + '历史剧情摘要');
    assert.equal(mm.messages[1].id, lastUserId);
    assert.equal(mm.messages[2].content, '第二轮回复');
  });

  function expectPreamble() {
    // 基类 _applyResultSync 用 SUMMARY_PREAMBLE + CONTINUATION_CLAUSE 前缀
    return 'This session is being continued from a previous conversation that ran out of context. ' +
      'The summary below covers the earlier portion of the conversation.\n\n' +
      'Continue the conversation from where it left off without asking the user any further questions. ' +
      'Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface ' +
      'with "I\'ll continue" or similar. Pick up the last task as if the break never happened.\n\n';
  }

});

// ========================
// DNDAgent 2-loop workflow
// ========================
describe('DNDAgent 2-loop workflow', () => {
  beforeEach(() => resetReadState());

  it('2 loop 顺序跑通：写大纲+维护面板 → 渲染落盘', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-dnd-'));
    const roots = {
      lore: path.join(tmp, 'lore'),
      outline: path.join(tmp, 'outline'),
      scene: path.join(tmp, 'scene'),
    };
    fs.mkdirSync(path.join(roots.lore, 'characters'), { recursive: true });
    fs.mkdirSync(roots.outline, { recursive: true });
    fs.mkdirSync(roots.scene, { recursive: true });
    fs.mkdirSync(roots.lore, { recursive: true });
    fs.writeFileSync(path.join(roots.lore, 'metadata.md'), 'metadata');
    fs.writeFileSync(path.join(roots.lore, 'user_profile.md'), '主角面板-初始');

    const outlinePath = path.join(roots.outline, 'round-1.md');
    const charPath = path.join(roots.lore, 'user_profile.md');
    const write = (fp, c) => ({ id: `c_${fp}`, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: fp, content: c }) } });
    const writeOutline = (c) => ({ id: 'c_wo', type: 'function', function: { name: 'WriteOutline', arguments: JSON.stringify({ content: c }) } });
    const read = (fp) => ({ id: `c_r_${fp}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: fp }) } });

    const responses = [
      { tool_calls: [writeOutline('大纲初稿')] },                       // outline: WriteOutline（无需指定路径）
      { tool_calls: [write(charPath, charProfile('主角面板-final'))] }, // outline: Write char（无需先 Read，带 frontmatter 维护面板到 final）
      { content: '完成' },                                              // outline: 纯文本 break
      { content: '剧情正文内容' },                                      // render: 纯文本
    ];
    const model = new MockModel({ responses });

    const config = new Config(tmp);
    config.data = {
      maxIterations: 10, systemPrompt: '', memoryTokenLimit: 40000,
      compactPrompt: '总结', compactSystemPrompt: '压缩器', compactMode: 'async',
      loop_outline_prompt: 'outline prompt',
      loop_render_prompt: 'render prompt',
    };
    const tm = new ToolManager();
    [Read, Write, Edit, Grep, Roll].forEach((t) => tm.register(t));

    const mm = new MessageManager({ systemPrompt: '', memoryTokenLimit: 40000, dataDir: path.join(tmp, 'mm'), config });
    const agent = new DNDAgent({ config, model, toolManager: tm, messageManager: mm });
    agent._roots = roots;
    agent._protagonistFile = 'user_profile.md';
    tm.register(makeWriteOutline(agent));   // 本轮大纲专用工具（持 agent 实例，建后注册）
    tm.register(makeEditOutline(agent));
    tm.register(makeRead(agent));            // lore 作用域 Read/Write/Edit 专版（同名覆盖通用版）
    tm.register(makeWrite(agent));
    tm.register(makeEdit(agent));

    await agent.runFourLoopWorkflow({ emit: () => {}, skipAddUser: true });

    assert.equal(fs.readFileSync(outlinePath, 'utf-8'), '大纲初稿', 'outline 由 main 写入');
    assert.equal(fs.readFileSync(charPath, 'utf-8'), charProfile('主角面板-final'), 'char 经 reviewer 更新到 final（带 frontmatter）');
    assert.equal(fs.readFileSync(path.join(roots.lore, 'user_profile.prev.md'), 'utf-8'), '主角面板-初始', 'reviewer 备份旧面板');
    assert.equal(fs.readFileSync(path.join(roots.scene, 'round-1.md'), 'utf-8'), '剧情正文内容', 'render 落盘 scene');
    const lastAssistant = [...mm.messages].reverse().find((m) => m.role === 'assistant');
    assert.equal(lastAssistant.content, '剧情正文内容');
  });

  it('reasoning 入口重置 _aborted：上次中断的残留标记不致本轮一直中断', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-dnd-abort-'));
    const roots = {
      lore: path.join(tmp, 'lore'),
      outline: path.join(tmp, 'outline'),
      scene: path.join(tmp, 'scene'),
    };
    fs.mkdirSync(path.join(roots.lore, 'characters'), { recursive: true });
    fs.mkdirSync(path.join(roots.outline), { recursive: true });
    fs.mkdirSync(path.join(roots.scene), { recursive: true });
    fs.mkdirSync(path.join(roots.lore), { recursive: true });
    fs.writeFileSync(path.join(roots.lore, 'metadata.md'), 'metadata');
    fs.writeFileSync(path.join(roots.lore, 'user_profile.md'), '主角面板-初始');

    const outlinePath = path.join(roots.outline, 'round-1.md');
    const charPath = path.join(roots.lore, 'user_profile.md');
    const write = (fp, c) => ({ id: `c_${fp}`, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: fp, content: c }) } });
    const writeOutline = (c) => ({ id: 'c_wo', type: 'function', function: { name: 'WriteOutline', arguments: JSON.stringify({ content: c }) } });
    const read = (fp) => ({ id: `c_r_${fp}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: fp }) } });
    const responses = [
      { tool_calls: [writeOutline('大纲初稿')] },
      { tool_calls: [write(charPath, charProfile('主角面板-final'))] },
      { content: '完成' },
      { content: '剧情正文内容' },
    ];
    const model = new MockModel({ responses });
    const config = new Config(tmp);
    config.data = {
      maxIterations: 10, systemPrompt: '', memoryTokenLimit: 40000,
      compactPrompt: '总结', compactSystemPrompt: '压缩器', compactMode: 'async',
      loop_outline_prompt: 'outline prompt',
      loop_render_prompt: 'render prompt',
    };
    const tm = new ToolManager();
    [Read, Write, Edit, Grep, Roll].forEach((t) => tm.register(t));
    const mm = new MessageManager({ systemPrompt: '', memoryTokenLimit: 40000, dataDir: path.join(tmp, 'mm'), config });
    const agent = new DNDAgent({ config, model, toolManager: tm, messageManager: mm });
    agent._roots = roots;
    agent._protagonistFile = 'user_profile.md';
    tm.register(makeWriteOutline(agent));
    tm.register(makeEditOutline(agent));
    tm.register(makeRead(agent));
    tm.register(makeWrite(agent));
    tm.register(makeEdit(agent));
    agent._scene = {};   // 走 override 的 runFourLoopWorkflow 分支（私聊场景）

    // 模拟「上一轮被用户中断」遗留的 _aborted=true（harness.abort 设、本轮入口应收尾重置）
    agent._aborted = true;
    let abortedEmitted = false;
    const emit = (e) => { if (e.event === 'aborted') abortedEmitted = true; };

    await agent.reasoning(null, { skipAddUser: true, emit });

    // 入口应重置 _aborted；workflow 不应被残留标记中断（render 落盘 + 无 aborted 事件）
    assert.equal(agent._aborted, false, 'reasoning 入口须重置 _aborted=false');
    assert.equal(abortedEmitted, false, '残留 _aborted 不应触发本轮 aborted 事件');
    assert.equal(fs.readFileSync(path.join(roots.scene, 'round-1.md'), 'utf-8'), '剧情正文内容', '本轮应跑完到 render 落盘');
  });

  it('render 历史：MM 压缩摘要 + fresh outline 文件（被摘要覆盖的老轮不进 fresh）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-render-hist-'));
    const roots = {
      lore: path.join(tmp, 'lore'),
      outline: path.join(tmp, 'outline'),
      scene: path.join(tmp, 'scene'),
    };
    for (const r of Object.values(roots)) fs.mkdirSync(r, { recursive: true });
    fs.mkdirSync(path.join(roots.lore, 'characters'), { recursive: true });
    fs.writeFileSync(path.join(roots.lore, 'metadata.md'), 'metadata');
    fs.writeFileSync(path.join(roots.lore, 'user_profile.md'), charProfile('面板'));
    // round-1 被 MM 摘要覆盖；round-2 = fresh；round-3 = 本轮（进 msg3）
    fs.writeFileSync(path.join(roots.outline, 'round-1.md'), 'R1大纲');
    fs.writeFileSync(path.join(roots.outline, 'round-2.md'), 'R2大纲');
    fs.writeFileSync(path.join(roots.outline, 'round-3.md'), 'R3大纲');
    fs.writeFileSync(path.join(roots.scene, 'round-2.md'), 'R2正文');

    const config = new Config(tmp);
    config.data = {
      maxIterations: 10, systemPrompt: '', memoryTokenLimit: 40000,
      compactPrompt: '总结', compactSystemPrompt: '压缩器', compactMode: 'async',
      loop_outline_prompt: '', loop_render_prompt: 'RENDER',
    };
    const tm = new ToolManager();
    [Read, Write, Edit, Grep, Roll].forEach((t) => tm.register(t));
    const mm = new MessageManager({ systemPrompt: '', memoryTokenLimit: 40000, dataDir: path.join(tmp, 'mm'), config });
    const agent = new DNDAgent({ config, model: new MockModel({ responses: [] }), toolManager: tm, messageManager: mm });
    agent._roots = roots;
    agent._protagonistFile = 'user_profile.md';
    tm.register(makeWriteOutline(agent));
    tm.register(makeEditOutline(agent));
    tm.register(makeRead(agent));
    tm.register(makeWrite(agent));
    tm.register(makeEdit(agent));

    agent._roundNumber = 3;
    // MM = [摘要(盖 round-1), user2, render正文2, user3] → fresh users = round2/3
    const pre = SUMMARY_PREAMBLE + CONTINUATION_CLAUSE;
    mm.messages.push(
      { id: 's1', role: 'user', content: pre + 'round1 摘要正文', isCompactSummary: true },
      { id: 'u2', role: 'user', content: '玩家R2指令' },
      { id: 'a2', role: 'assistant', content: 'R2正文' },
      { id: 'u3', role: 'user', content: '玩家R3指令' },
    );

    const msgs = agent._buildRenderMessages();
    // [system, hist(user), assistant(上一轮正文), user(本轮)]
    assert.equal(msgs.length, 4, '应 4 条消息');
    assert.equal(msgs[1].role, 'user');
    assert.match(msgs[1].content, /## 历史摘要/);
    assert.match(msgs[1].content, /round1 摘要正文/, 'MM 摘要正文进历史块');
    assert.doesNotMatch(msgs[1].content, /This session is being continued/, 'preamble 须剥除');
    assert.match(msgs[1].content, /Round 2 大纲：\nR2大纲/, 'fresh round-2 进历史块');
    assert.doesNotMatch(msgs[1].content, /R1大纲/, '被摘要覆盖的 round-1 不进 fresh');
    assert.equal(msgs[2].role, 'assistant');
    assert.equal(msgs[2].content, 'R2正文', '上一轮 render 正文作 assistant');
    assert.match(msgs[3].content, /玩家当前指令：玩家R3指令/);
    assert.match(msgs[3].content, /本轮大纲：\nR3大纲/);
    assert.match(msgs[3].content, /RENDER$/, '语言风格提示词拼在末尾');
  });
});

// ========================
// render 空内容自愈（重试 + 兜底）+ reloadConfig modelKey 守卫
// ========================
describe('render 空内容自愈 + reloadConfig', () => {
  beforeEach(() => resetReadState());

  // 复用 workflow describe 的装配样板，返回 { agent, mm, roots, model }
  function buildAgent(tmp, responses) {
    const roots = {
      lore: path.join(tmp, 'lore'),
      outline: path.join(tmp, 'outline'),
      scene: path.join(tmp, 'scene'),
    };
    fs.mkdirSync(path.join(roots.lore, 'characters'), { recursive: true });
    for (const r of Object.values(roots)) fs.mkdirSync(r, { recursive: true });
    fs.writeFileSync(path.join(roots.lore, 'metadata.md'), 'metadata');
    fs.writeFileSync(path.join(roots.lore, 'user_profile.md'), '主角面板-初始');

    const charPath = path.join(roots.lore, 'user_profile.md');
    const write = (fp, c) => ({ id: `c_${fp}`, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: fp, content: c }) } });
    const writeOutline = (c) => ({ id: 'c_wo', type: 'function', function: { name: 'WriteOutline', arguments: JSON.stringify({ content: c }) } });

    const model = new MockModel({ responses });
    const config = new Config(tmp);
    config.data = {
      maxIterations: 10, systemPrompt: '', memoryTokenLimit: 40000,
      compactPrompt: '总结', compactSystemPrompt: '压缩器', compactMode: 'async',
      loop_outline_prompt: 'outline prompt', loop_render_prompt: 'render prompt',
    };
    const tm = new ToolManager();
    [Read, Write, Edit, Grep, Roll].forEach((t) => tm.register(t));
    const mm = new MessageManager({ systemPrompt: '', memoryTokenLimit: 40000, dataDir: path.join(tmp, 'mm'), config });
    const agent = new DNDAgent({ config, model, toolManager: tm, messageManager: mm });
    agent._roots = roots;
    agent._protagonistFile = 'user_profile.md';
    tm.register(makeWriteOutline(agent));
    tm.register(makeEditOutline(agent));
    tm.register(makeRead(agent));
    tm.register(makeWrite(agent));
    tm.register(makeEdit(agent));
    return { agent, mm, roots, model, charPath };
  }

  // outline 段固定三步响应：WriteOutline 落大纲 → Write 维护面板 → 纯文本 '完成' break
  const outlineResponses = (charPath) => [
    { tool_calls: [writeOutlineFor('大纲初稿')] },
    { tool_calls: [writeFor(charPath, charProfile('主角面板-final'))] },
    { content: '完成' },
  ];
  const writeOutlineFor = (c) => ({ id: 'c_wo', type: 'function', function: { name: 'WriteOutline', arguments: JSON.stringify({ content: c }) } });
  const writeFor = (fp, c) => ({ id: `c_${fp}`, type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: fp, content: c }) } });

  it('render 空内容重试：前两次空、第三次非空 → 落盘非空、不入空消息', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-render-retry-'));
    const charPath = path.join(tmp, 'lore', 'user_profile.md');
    const { agent, mm, roots } = buildAgent(tmp, [
      ...outlineResponses(charPath),
      { content: '' },            // render 第 1 次空
      { content: '' },            // render 第 2 次空
      { content: '剧情正文' },     // render 第 3 次非空 → 成功
    ]);
    await agent.runFourLoopWorkflow({ emit: () => {}, skipAddUser: true });

    assert.equal(fs.readFileSync(path.join(roots.scene, 'round-1.md'), 'utf-8'), '剧情正文', '第三次重试成功,scene 落非空');
    const lastAssistant = [...mm.messages].reverse().find((m) => m.role === 'assistant');
    assert.equal(lastAssistant.content, '剧情正文', '入 MM 的 render 正文为非空');
    assert.ok(!mm.messages.some((m) => m.role === 'assistant' && m.content === ''), '不应有任何空 assistant 消息');
  });

  it('render 连续 4 次空 → 兜底：删本轮 outline+scene、不入空消息、推 error notice、emitDone', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-render-exhaust-'));
    const charPath = path.join(tmp, 'lore', 'user_profile.md');
    const { agent, mm, roots } = buildAgent(tmp, [
      ...outlineResponses(charPath),
      { content: '' }, { content: '' }, { content: '' }, { content: '' },   // render 1+3 次皆空
    ]);
    const events = [];
    const emit = (e) => events.push(e);
    await agent.runFourLoopWorkflow({ emit, skipAddUser: true });

    assert.ok(!fs.existsSync(path.join(roots.outline, 'round-1.md')), 'exhaust 后 outline/round-1.md 应被删（让 rewind+重发重玩本轮）');
    assert.ok(!fs.existsSync(path.join(roots.scene, 'round-1.md')), 'exhaust 后 scene/round-1.md 应被删（不落空 scene）');
    assert.ok(!mm.messages.some((m) => m.role === 'assistant' && m.content === ''), '不应入空 assistant 消息');
    const notice = events.find((e) => e.event === 'notice');
    assert.ok(notice, '应推 notice');
    assert.equal(notice.data.kind, 'error', 'notice kind=error');
    assert.match(notice.data.text, /渲染连续.*次返回空/, 'notice 文案提示渲染空');
    assert.ok(events.some((e) => e.event === 'done'), '应正常 emitDone 封棺');
  });

  it('outline 连续空回复 → 提醒 3 次即放弃，不进 render、不死循环', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-outline-cap-'));
    const charPath = path.join(tmp, 'lore', 'user_profile.md');
    const { agent, roots, model } = buildAgent(tmp, [
      { content: '' }, { content: '' }, { content: '' }, { content: '' },  // 4 次空 outline（1 次初试 + 3 次提醒重入）
      { content: '不该被调用的 render 正文' },                                 // 若误进 render 会消费这条
    ]);
    const events = [];
    const emit = (e) => events.push(e);
    await agent.runFourLoopWorkflow({ emit, skipAddUser: true });

    // 没进 render：第 5 条 responses 未被消费 → 无 scene、无 outline
    assert.equal(model._callIndex, 4, '只跑 4 次 outline LLM 调用（1+3 提醒），不进 render');
    assert.ok(!fs.existsSync(path.join(roots.outline, 'round-1.md')), '未产出大纲');
    assert.ok(!fs.existsSync(path.join(roots.scene, 'round-1.md')), 'outline 放弃后不应进 render/落 scene');
    const notice = events.find((e) => e.event === 'notice');
    assert.ok(notice, '应推放弃 notice');
    assert.equal(notice.data.kind, 'error', 'notice kind=error');
    assert.match(notice.data.text, /未产出大纲/, 'notice 文案提示未产出大纲');
    assert.ok(events.some((e) => e.event === 'done'), '应 emitDone 封棺，不死循环');
  });

  it('用户终止 → emit abortRewind 信号交 gateway rewindTo(latest);agent 自身不动盘(不截 context/不删 round 文件)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-dnd-terminate-'));
    const charPath = path.join(tmp, 'lore', 'user_profile.md');
    const { agent, mm, roots, model } = buildAgent(tmp, [
      ...outlineResponses(charPath),
      { content: '剧情正文内容' },   // render：流到首字即被中止
    ]);
    agent._scene = {};   // 走 override 的 runFourLoopWorkflow 分支（私聊场景）
    mm.addUserMessage('玩家本轮指令');

    // render 的 chatStream（第 4 次 LLM 调用）首 token 后同步中止
    const realChatStream = model.chatStream.bind(model);
    let callCount = 0;
    let aborted = false;
    const events = [];
    const emit = (e) => events.push(e);
    model.chatStream = async function (messages, tools, options) {
      callCount++;
      const origOnChunk = options.onChunk;
      if (callCount === 4) {
        options.onChunk = (chunk) => {
          if (origOnChunk) origOnChunk(chunk);
          if (!aborted) { aborted = true; agent.abort(); }   // 首 token 后中止
        };
      }
      return realChatStream(messages, tools, options);
    };

    await agent.reasoning(null, { skipAddUser: true, emit });

    assert.ok(aborted, 'render 首 token 后触发了 abort');
    assert.equal(agent._aborted, true, '本轮被终止（_aborted=true）');
    assert.ok(events.some((e) => e.event === 'aborted'), 'emit 了 aborted');
    // ★ 新契约：发 abortRewind 信号把回退交由 gateway rewindTo(latest);agent 不再自行回退磁盘
    assert.ok(events.some((e) => e.event === 'abortRewind'), 'emit 了 abortRewind 信号(交 gateway 复用 ⟲ rewind)');
    // agent 自身不截 context(partial/user 仍在,由 gateway rewindTo 从 checkpoint 整份覆盖清掉)
    assert.ok(mm.messages.some((m) => m.role === 'user'), 'agent 未自行截断 context(本轮 user 仍在)');
    // agent 自身不删 round 文件(由 gateway rewindTo 从 pre-round checkpoint 还原实现 _countRounds 回退)
    //   注:本测试 buildAgent 的 roots 不在 mm.dataDir/runtime 下、也未 seed checkpoint,
    //   round 文件是否残留仅作"agent 不动盘"的旁证,不断言删除。
  });


  it('reloadConfig modelKey 守卫：提示词类编辑不重建 model，base_url 变了才重建', () => {
    // stub config：load() 推进 getModelConfig 返回的配置序号（模拟真实 load 从盘读到新配置）。
    //   序列：[初始/构造]→idx0；第1次 reload（仅提示词变,mc 不变）→idx1；第2次 reload（base_url 变）→idx2。
    const cfgA = { provider: 'llm', base_url: 'http://a', auth_token: 'k', model: 'm', enable_thinking: false };
    const modelConfigs = [cfgA, { ...cfgA }, { ...cfgA, base_url: 'http://b' }];
    let loadIdx = 0;
    const config = {
      load: () => { loadIdx = Math.min(loadIdx + 1, modelConfigs.length - 1); },
      getModelConfig: () => modelConfigs[loadIdx],
      get: (k) => ({ systemPrompt: 's', memoryTokenLimit: 40000, compactSystemPrompt: '', compactPrompt: '' })[k],
    };
    const mm = { updateConfig: () => {} };
    const tm = { _setMessageManager() {} };
    const agent = new Agent({ config, model: {}, toolManager: tm, messageManager: mm });
    const m0 = agent.model;

    // 第 1 次 reload：load 把 idx0→idx1，两份 mc 字段相同 → modelKey 不变 → 跳过重建
    agent.reloadConfig();
    assert.equal(agent.model, m0, '提示词编辑不重建 model,同实例引用');

    // 第 2 次 reload：load 把 idx1→idx2，base_url 变了 → modelKey 变 → 重建 LLMModel
    agent.reloadConfig();
    assert.notEqual(agent.model, m0, 'base_url 变了应重建');
    assert.ok(agent.model instanceof LLMModel, '重建后为 LLMModel 实例');
  });
});
describe('lore 作用域工具', () => {
  beforeEach(() => resetReadState());

  function makeAgent(loreRoot) {
    return { _roots: { lore: loreRoot }, _protagonistFile: 'user_profile.md' };
  }

  it('Write 非法路径（lore 外）被前置校验拒', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-lore-'));
    const w = makeWrite(makeAgent(path.join(tmp, 'lore')));
    const r = await w.execute({ file_path: path.join(tmp, 'outside.md'), content: charProfile('x') });
    assert.match(r, /只能写 lore 目录内的文件/);
    assert.ok(!fs.existsSync(path.join(tmp, 'outside.md')), 'lore 外文件不应被写入');
  });

  it('Write 缺 frontmatter 被后置校验拒（不写盘）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-lore-'));
    const lore = path.join(tmp, 'lore');
    fs.mkdirSync(lore);
    const w = makeWrite(makeAgent(lore));
    const r = await w.execute({ file_path: path.join(lore, 'a.md'), content: '无 frontmatter 的内容' });
    assert.match(r, /frontmatter/);
    assert.ok(!fs.existsSync(path.join(lore, 'a.md')), '缺 frontmatter 不应落盘');
  });

  it('Write lore 内 + 合法 frontmatter → 落盘', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-lore-'));
    const lore = path.join(tmp, 'lore', 'characters');
    fs.mkdirSync(lore, { recursive: true });
    const w = makeWrite(makeAgent(path.join(tmp, 'lore')));
    const fp = path.join(lore, '镇长.md');
    const r = await w.execute({ file_path: fp, content: charProfile('镇长正文') });
    assert.match(r, /created successfully/);
    assert.equal(fs.readFileSync(fp, 'utf-8'), charProfile('镇长正文'));
  });

  it('Write 覆盖已有文件无需先 Read（基线已注入）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-lore-'));
    const lore = path.join(tmp, 'lore', 'characters');
    fs.mkdirSync(lore, { recursive: true });
    const fp = path.join(lore, '镇长.md');
    const w = makeWrite(makeAgent(path.join(tmp, 'lore')));
    await w.execute({ file_path: fp, content: charProfile('旧正文') });
    // 未 Read 直接覆盖 → 应成功（不卡 hasRead/陈旧检查）
    const r = await w.execute({ file_path: fp, content: charProfile('新正文') });
    assert.match(r, /has been updated successfully/);
    assert.equal(fs.readFileSync(fp, 'utf-8'), charProfile('新正文'));
  });

  it('Edit 已有文件无需先 Read（基线已注入）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-lore-'));
    const lore = path.join(tmp, 'lore');
    fs.mkdirSync(lore);
    const fp = path.join(lore, 'a.md');
    fs.writeFileSync(fp, charProfile('正文-旧'), 'utf-8');
    const agent = makeAgent(lore);
    const e = makeEdit(agent);
    // 未 Read 直接编辑 → 应成功（不卡 hasRead/陈旧检查）
    const r = await e.execute({ file_path: fp, old_string: '正文-旧', new_string: '正文-新' });
    assert.match(r, /updated successfully/);
    assert.equal(fs.readFileSync(fp, 'utf-8'), charProfile('正文-新'));
  });

  it('Edit 改后破坏 frontmatter 被拒（不写盘）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-lore-'));
    const lore = path.join(tmp, 'lore');
    fs.mkdirSync(lore);
    const fp = path.join(lore, 'a.md');
    fs.writeFileSync(fp, charProfile('正文-旧'), 'utf-8');
    const agent = makeAgent(lore);
    const e = makeEdit(agent);
    // 把开头的 --- 删掉 → 破坏 frontmatter
    const r = await e.execute({ file_path: fp, old_string: '---\nname: 勇者', new_string: 'name: 勇者' });
    assert.match(r, /frontmatter/);
    assert.equal(fs.readFileSync(fp, 'utf-8'), charProfile('正文-旧'), '破坏 frontmatter 的编辑不应落盘');
  });

  it('Edit lore 外路径被拒', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-lore-'));
    const e = makeEdit(makeAgent(path.join(tmp, 'lore')));
    const r = await e.execute({ file_path: path.join(tmp, 'outside.md'), old_string: 'a', new_string: 'b' });
    assert.match(r, /只能编辑 lore 目录内的文件/);
  });

  it('Read lore 外路径被拒；lore 内可读', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-lore-'));
    const lore = path.join(tmp, 'lore');
    fs.mkdirSync(lore);
    const fp = path.join(lore, 'a.md');
    fs.writeFileSync(fp, charProfile('正文'), 'utf-8');
    const rd = makeRead(makeAgent(lore));
    assert.match(await rd.execute({ file_path: path.join(tmp, 'outside.md') }), /只能读 lore 目录内的文件/);
    const ok = await rd.execute({ file_path: fp });
    assert.match(ok, /勇者/);
  });

  it('tools 目录无 Glob（已被移除）', () => {
    const dir = fileURLToPath(new URL('../agents/elf-018/tools/', import.meta.url));
    assert.ok(!fs.existsSync(path.join(dir, 'Glob.js')), 'elf-018 不应有 Glob 工具');
  });
});

// ========================
// buildStyleMetadata：扫描 styles 目录 → <文件名.md> - description
// ========================
describe('buildStyleMetadata', () => {
  it('扫描 styles 目录，输出 <文件名.md> - description，无绝对路径；default 不列入', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-sm-'));
    fs.writeFileSync(path.join(tmp, 'default_style.md'), '---\ndescription: 默认风格简介\n---\n正文');
    fs.writeFileSync(path.join(tmp, 'combat_style.md'), '---\ndescription: 战斗风格简介\n---\n正文');
    const md = buildStyleMetadata(tmp);
    assert.match(md, /## 语言风格 metadata/);
    assert.doesNotMatch(md, /<default_style\.md>/, 'default 不列入可选 metadata');
    assert.match(md, /<combat_style\.md> - 战斗风格简介/);
    assert.doesNotMatch(md, new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '不含绝对路径');
  });

  it('仅含 default_style 时返回空串（无可选场景风格）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-sm-only-'));
    fs.writeFileSync(path.join(tmp, 'default_style.md'), '---\ndescription: 默认风格简介\n---\n正文');
    assert.equal(buildStyleMetadata(tmp), '');
  });

  it('空目录返回空串', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-sm2-'));
    assert.equal(buildStyleMetadata(tmp), '');
  });

  it('无 frontmatter 的文件降级为（无简介）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-sm3-'));
    fs.writeFileSync(path.join(tmp, 'plain.md'), '无 frontmatter 的正文');
    const md = buildStyleMetadata(tmp);
    assert.match(md, /<plain\.md> - （无简介）/);
  });
});

// ========================
// render 语言风格注入：默认常驻 system 末尾 + 命名风格加载到最近一条 user 末尾
// ========================
describe('render 语言风格注入', () => {
  beforeEach(() => resetReadState());

  const DEFAULT_FM = '---\ndescription: 默认叙事风格\n---\n\n默认风格正文。\n\n## 短例\n默认短例。';
  const COMBAT_FM = '---\ndescription: 战斗风格\n---\n\n战斗风格正文。';

  function setup({ outlineContent, styleFiles }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-style-'));
    const roots = { lore: path.join(tmp, 'lore'), outline: path.join(tmp, 'outline'), scene: path.join(tmp, 'scene') };
    const stylesDir = path.join(tmp, 'styles');
    for (const r of [roots.lore, roots.outline, roots.scene, stylesDir]) fs.mkdirSync(r, { recursive: true });
    fs.mkdirSync(path.join(roots.lore, 'characters'), { recursive: true });
    fs.writeFileSync(path.join(roots.lore, 'user_profile.md'), charProfile('面板'));
    fs.writeFileSync(path.join(roots.lore, 'user_profile.prev.md'), charProfile('旧面板'));
    for (const { file, content } of styleFiles || []) fs.writeFileSync(path.join(stylesDir, file), content);
    fs.writeFileSync(path.join(roots.outline, 'round-1.md'), outlineContent || '');

    const config = new Config(tmp);
    config.data = { maxIterations: 10, systemPrompt: '', memoryTokenLimit: 40000, compactPrompt: '总结', compactSystemPrompt: '压缩器', compactMode: 'async', loop_outline_prompt: '', loop_render_prompt: 'RENDER' };
    const tm = new ToolManager();
    const mm = new MessageManager({ systemPrompt: '', memoryTokenLimit: 40000, dataDir: path.join(tmp, 'mm'), config });
    const agent = new DNDAgent({ config, model: new MockModel({ responses: [] }), toolManager: tm, messageManager: mm });
    agent._roots = roots;
    agent._stylesDir = stylesDir;
    agent._protagonistFile = 'user_profile.md';
    agent._roundNumber = 1;
    mm.messages.push({ id: 'u1', role: 'user', content: '玩家R1指令' });
    const msgs = agent._buildRenderMessages();
    return { agent, msgs };
  }

  it('默认风格正文常驻 render system 末尾（剥 frontmatter）', () => {
    const { msgs } = setup({ outlineContent: '## 剧情发展\n推进。', styleFiles: [{ file: 'default_style.md', content: DEFAULT_FM }] });
    assert.equal(msgs[0].role, 'system');
    assert.match(msgs[0].content, /默认风格正文/, '默认正文进 system');
    assert.doesNotMatch(msgs[0].content, /description: 默认叙事风格/, 'system 不带 frontmatter');
    assert.match(msgs[1].content, /RENDER$/, '未点名命名风格时 user 末尾仍是 render 任务指令');
    assert.doesNotMatch(msgs[1].content, /默认风格正文/, '默认不在 user 末尾重复');
  });

  it('大纲点名命名风格 → 命名风格正文加载到最近一条 user 末尾（在 render 任务之后）', () => {
    const { msgs } = setup({
      outlineContent: '## 剧情发展\n交战。\n\n## 语言风格\n<combat_style.md>',
      styleFiles: [{ file: 'default_style.md', content: DEFAULT_FM }, { file: 'combat_style.md', content: COMBAT_FM }],
    });
    assert.match(msgs[0].content, /默认风格正文/, '默认仍常驻 system');
    assert.match(msgs[1].content, /战斗风格正文/, '命名风格正文进 user 末尾');
    assert.match(msgs[1].content, /RENDER\n\n战斗风格正文/, '命名风格在 render 任务指令之后');
    assert.doesNotMatch(msgs[1].content, /description: 战斗风格/, '命名风格正文剥 frontmatter');
  });

  it('大纲点了缺失的风格文件 → 不抛、user 末尾不注入，默认仍兜底', () => {
    const { msgs } = setup({
      outlineContent: '## 语言风格\n<nope.md>',
      styleFiles: [{ file: 'default_style.md', content: DEFAULT_FM }],
    });
    assert.match(msgs[0].content, /默认风格正文/, '默认兜底仍在 system');
    // 缺失文件不注入正文 → user 末尾仍以 RENDER 收尾（无额外风格正文被追加）
    assert.match(msgs[1].content, /RENDER$/, '缺失文件不注入，user 末尾仍以 render 任务指令结尾');
  });

  it('大纲点名 default_style.md → 不在 user 末尾重复（默认已在 system）', () => {
    const { msgs } = setup({
      outlineContent: '## 语言风格\n<default_style.md>',
      styleFiles: [{ file: 'default_style.md', content: DEFAULT_FM }],
    });
    assert.match(msgs[0].content, /默认风格正文/);
    assert.doesNotMatch(msgs[1].content, /默认风格正文/, '命中默认时不重复注入到 user 末尾');
    assert.match(msgs[1].content, /RENDER$/);
  });

  it('无 _stylesDir 时退化为空默认（system 不含默认正文），不抛', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-style-nodir-'));
    const roots = { lore: path.join(tmp, 'lore'), outline: path.join(tmp, 'outline'), scene: path.join(tmp, 'scene') };
    for (const r of Object.values(roots)) fs.mkdirSync(r, { recursive: true });
    fs.writeFileSync(path.join(roots.outline, 'round-1.md'), '## 剧情发展\n推进。');
    const config = new Config(tmp);
    config.data = { maxIterations: 10, systemPrompt: '', memoryTokenLimit: 40000, compactPrompt: '总结', compactSystemPrompt: '压缩器', compactMode: 'async', loop_outline_prompt: '', loop_render_prompt: 'RENDER' };
    const tm = new ToolManager();
    const mm = new MessageManager({ systemPrompt: '', memoryTokenLimit: 40000, dataDir: path.join(tmp, 'mm'), config });
    const agent = new DNDAgent({ config, model: new MockModel({ responses: [] }), toolManager: tm, messageManager: mm });
    agent._roots = roots;
    agent._protagonistFile = 'user_profile.md';
    agent._roundNumber = 1;
    mm.messages.push({ id: 'u1', role: 'user', content: '玩家R1指令' });
    // 不设 _stylesDir
    const msgs = agent._buildRenderMessages();
    assert.equal(msgs[0].content, '', '无 stylesDir 时 system 只剩空总纲');
    assert.match(msgs[1].content, /RENDER$/);
  });
});