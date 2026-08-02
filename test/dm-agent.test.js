/**
 * DM Agent (elf-018) 测试：Roll / DNDMessageManager / DNDAgent 4-loop workflow
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Roll } from '../engine/tools/Roll.js';
import { reset as resetReadState } from '../engine/tools/read_state.js';
import { MockModel } from '../engine/models/index.js';
import { ToolManager } from '../engine/tools/tool_manager.js';
import { Read, Write, Edit, Grep, Glob } from '../engine/tools/index.js';
import { Config } from '../engine/config_loader.js';
import { MessageManager } from '../engine/message_manager.js';
import { MessageManager as DNDMessageManager } from '../agents/elf-018/message_manager.js';
import { DNDAgent } from '../agents/elf-018/agent.js';

// ========================
// Roll 工具
// ========================
describe('Roll 工具', () => {
  it('返回格式含 d20 点数与用途', async () => {
    const r = await Roll.execute({ purpose: '攻击判定', dc: 10, modifier: 2 });
    assert.match(r, /Roll d20=\d+/);
    assert.match(r, /vs DC 10/);
    assert.match(r, /（攻击判定）/);
    assert.ok(/大失败|大成功|成功|失败/.test(r));
  });

  it('省略 dc 时不判过（无 vs DC，自然1/20 仍大失败/大成功）', async () => {
    const r = await Roll.execute({ purpose: '测试' });
    assert.match(r, /Roll d20=\d+/);
    assert.doesNotMatch(r, /vs DC/);
  });

  it('自然 1/20 文本在范围内可出现（多次抽样）', async () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const r = await Roll.execute({ purpose: '采样', dc: 10 });
      const m = r.match(/Roll d20=(\d+)/);
      seen.add(Number(m[1]));
      if (seen.has(1) && seen.has(20)) break;
    }
    assert.ok(seen.has(1) && seen.has(20), '多次掷骰应能采到 1 和 20');
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
// DNDAgent 4-loop workflow
// ========================
describe('DNDAgent 4-loop workflow', () => {
  beforeEach(() => resetReadState());

  it('4 loop 顺序跑通：写大纲 → 审校改 → 维护面板 → 渲染落盘', async () => {
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
    const read = (fp) => ({ id: `c_r_${fp}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: fp }) } });

    const responses = [
      { tool_calls: [write(outlinePath, '大纲初稿')] },      // main: Write outline
      { content: '大纲完成' },                                 // main: 纯文本 break
      { tool_calls: [read(charPath)] },                        // reviewer: Read char（hasRead 后才可覆盖写）
      { tool_calls: [write(charPath, '主角面板-final')] },     // reviewer: Write char（新面板，mtime 变）
      { content: '审校维护完成' },                             // reviewer: 纯文本 break
      { content: '剧情正文内容' },                             // render: 纯文本
    ];
    const model = new MockModel({ responses });

    const config = new Config(tmp);
    config.data = {
      maxIterations: 10, systemPrompt: '', memoryTokenLimit: 40000,
      compactPrompt: '总结', compactSystemPrompt: '压缩器', compactMode: 'async',
      loop_outline_prompt: 'outline prompt', loop_reviewer_prompt: 'reviewer prompt',
      loop_render_prompt: 'render prompt',
    };
    const tm = new ToolManager();
    [Read, Write, Edit, Grep, Glob, Roll].forEach((t) => tm.register(t));

    const mm = new MessageManager({ systemPrompt: '', memoryTokenLimit: 40000, dataDir: path.join(tmp, 'mm'), config });
    const agent = new DNDAgent({ config, model, toolManager: tm, messageManager: mm });
    agent._roots = roots;
    agent._protagonistFile = 'user_profile.md';

    await agent.runFourLoopWorkflow({ emit: () => {}, skipAddUser: true });

    assert.equal(fs.readFileSync(outlinePath, 'utf-8'), '大纲初稿', 'outline 由 main 写入');
    assert.equal(fs.readFileSync(charPath, 'utf-8'), '主角面板-final', 'char 经 reviewer 更新到 final');
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
    const read = (fp) => ({ id: `c_r_${fp}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: fp }) } });
    const responses = [
      { tool_calls: [write(outlinePath, '大纲初稿')] },
      { content: '大纲完成' },
      { tool_calls: [read(charPath)] },
      { tool_calls: [write(charPath, '主角面板-final')] },
      { content: '审校维护完成' },
      { content: '剧情正文内容' },
    ];
    const model = new MockModel({ responses });
    const config = new Config(tmp);
    config.data = {
      maxIterations: 10, systemPrompt: '', memoryTokenLimit: 40000,
      compactPrompt: '总结', compactSystemPrompt: '压缩器', compactMode: 'async',
      loop_outline_prompt: 'outline prompt', loop_reviewer_prompt: 'reviewer prompt',
      loop_render_prompt: 'render prompt',
    };
    const tm = new ToolManager();
    [Read, Write, Edit, Grep, Glob, Roll].forEach((t) => tm.register(t));
    const mm = new MessageManager({ systemPrompt: '', memoryTokenLimit: 40000, dataDir: path.join(tmp, 'mm'), config });
    const agent = new DNDAgent({ config, model, toolManager: tm, messageManager: mm });
    agent._roots = roots;
    agent._protagonistFile = 'user_profile.md';
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
});