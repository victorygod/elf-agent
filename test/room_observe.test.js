/**
 * 观测式交互策略测试
 *
 * 覆盖：
 *  - 默认名字关键词 + 自定义关键词（子串/正则）命中即时触发
 *  - 观测窗口到期巡视触发（手动模拟窗口到期 → triggerRoomFlush）
 *  - 窗口到期 buffer 空 → 不触发
 *  - Skip 主动放弃 / silentRetries 连续静默放弃
 *  - both 策略：@ 强门控（阈值1）+ keyword 弱门控（阈值2）
 *  - dispose 清 timer；mention 策略不起 timer
 *  - SetObserveConfig 工具：写文件 + 校验截断 + 热生效（只设关注词，不设窗口；名字读取时并入不占名额）
 *  - Skip 工具 execute
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { MockModel } from '../engine/models/index.js';
import { MessageManager } from '../engine/message_manager.js';
import { ToolManager } from '../engine/tools/tool_manager.js';
import { Agent } from '../engine/agent.js';
import { RoomMiddleware } from '../engine/plugins/room_plugin.js';
import { buildRunContext } from '../engine/run_context.js';
import { Skip } from '../engine/tools/Skip.js';
import { SetObserveConfig } from '../engine/tools/SetObserveConfig.js';
import { Speak as RealSpeak } from '../engine/tools/Speak.js';

/** 占位 Speak（不真发 room_bus，复用真实 missingReminder 协议） */
const mockSpeak = {
  name: 'Speak',
  description: '占位',
  parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  callSummary: (args) => `Speak: ${(args?.message || '').slice(0, 30)}`,
  missingReminder: RealSpeak.missingReminder,
  execute: async () => '已发言',
};

/**
 * 构造观测式 agent。
 * @param {object} opts
 * @param {string} [opts.strategy='observe']
 * @param {string[]|undefined} [opts.keywords]  自定义关注词；名字(memberName)在读取时由 RoomPlugin 并入匹配列表（不占名额、不写文件）
 * @param {number} [opts.observationWindowSec=60]
 * @param {number} [opts.silentRetries]  已废弃（固定常量2，不可配）；保留参数仅为兼容旧调用，无效果
 * @param {Array} [opts.responses]
 * @param {string} [opts.dataDir]
 * @param {boolean} [opts.withTools=true]
 */
function makeObserveAgent({
  strategy = 'observe', keywords, observationWindowSec = 60, silentRetries,
  responses = [{ content: '回复' }], dataDir = null, withTools = true,
  memberName = 'elf-001', agentId = 'elf-001',
} = {}) {
  const observe = {};
  if (keywords !== undefined) observe.keywords = keywords;
  if (observationWindowSec !== undefined) observe.observationWindowSec = observationWindowSec;
  // silentRetries 不再写入 config（固定常量）
  const interaction = { strategy, observe };
  const config = {
    get: (k) => k === 'interaction' ? interaction : ({ agentId, port: 9999, maxIterations: 8, memoryTokenLimit: 8000 })[k],
    getModelConfig: () => ({ provider: 'mock' }),
    getModelMissingFields: () => null,
  };
  const mm = new MessageManager({ systemPrompt: '你是 elf-001', memoryTokenLimit: 8000, dataDir });
  const model = new MockModel({ responses });
  const tr = new ToolManager();
  if (withTools) {
    tr.register(mockSpeak);
    tr.register(Skip);
    if (strategy !== 'mention') tr.register(SetObserveConfig);
  }
  const rc = buildRunContext({ agentId, mode: 'room', port: 9999, dataDir: dataDir || '/tmp', roomId: 'roomA', memberName });
  const agent = new Agent({ config, model, toolManager: tr, messageManager: mm, runContext: rc });
  const rm = new RoomMiddleware(agent);
  agent._scene = rm;
  agent._rm = rm;
  // 模拟 _refreshRoster 后的 observe_status.json 初始化（测试无 roomBusUrl，_refreshRoster 早 return）
  // 文件只存纯关注词（config.keywords 种子）；名字在读取时由 _effectiveKeywords 并入匹配列表
  if (strategy !== 'mention') rm._ensureObserveStatus();
  return agent;
}

/** 收集 emit 事件。fn 接收 emit、内部 await agent.xxx */
async function collect(fn) {
  const events = [];
  await fn(e => events.push(e));
  return events;
}

const speakTool = (msg = 'hi') => ({ id: 'c1', type: 'function', function: { name: 'Speak', arguments: JSON.stringify({ message: msg }) } });
const skipTool = (reason) => ({ id: 'c1', type: 'function', function: { name: 'Skip', arguments: JSON.stringify(reason ? { reason } : {}) } });

describe('观测式交互策略', () => {
  let tmpDir;
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-obs-strat-')); });
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} });

  // ---- 关键词即时触发 ----
  it('默认关键词含自己名字：消息含 memberName → 即时触发 reasoning', async () => {
    const a = makeObserveAgent({ dataDir: path.join(tmpDir, 't1'), responses: [{ tool_calls: [speakTool()] }] });
    try {
      // content 含 elf-001（默认关键词=memberName）→ 命中即时触发
      const ev = await collect(emit => a.receive({ from: 'elf-002', content: '问下 elf-001 怎么看', mentions: [], role: 'chat' }, { emit }));
      assert.ok(ev.some(e => e.event === 'tool_call'), '关键词命中应触发 reasoning 调 Speak');
      // 一条 user（buffer 合成）+ assistant tool_calls + tool result
      assert.equal(a.messageManager.messages.filter(m => m.role === 'user').length, 1);
    } finally { a._rm.dispose(); }
  });

  it('自定义子串关键词命中 → 即时触发；未命中 → 进 buffer 不 reasoning', async () => {
    const a = makeObserveAgent({ dataDir: path.join(tmpDir, 't2'), keywords: ['架构'], responses: [{ tool_calls: [speakTool()] }] });
    try {
      // 未命中：进 buffer，无 reasoning，立即 done
      const ev1 = await collect(emit => a.receive({ from: 'elf-002', content: '今天吃什么', mentions: [], role: 'chat' }, { emit }));
      assert.equal(ev1[ev1.length - 1].event, 'done');
      assert.equal(a._rm._buffer.length, 1);
      assert.equal(a.messageManager.messages.length, 0);
      // 命中：触发
      const ev2 = await collect(emit => a.receive({ from: 'elf-003', content: '聊聊架构设计', mentions: [], role: 'chat' }, { emit }));
      assert.ok(ev2.some(e => e.event === 'tool_call'), '"架构"命中应触发');
    } finally { a._rm.dispose(); }
  });

  it('正则关键词命中（/bug\\d/i）', async () => {
    // 消息格式化为 "elf-002 [时间]: bug123..."，正则匹配整个 buffer 项文本
    const a = makeObserveAgent({ dataDir: path.join(tmpDir, 't3'), keywords: ['/bug\\d/i'], responses: [{ tool_calls: [speakTool()] }] });
    try {
      const ev = await collect(emit => a.receive({ from: 'elf-002', content: 'bug123 出现了', mentions: [], role: 'chat' }, { emit }));
      assert.ok(ev.some(e => e.event === 'tool_call'), '正则应命中 bug123');
    } finally { a._rm.dispose(); }
  });

  // ---- 窗口到期巡视 ----
  it('窗口到期 ∧ buffer 非空 → triggerRoomFlush 触发 reasoning', async () => {
    const a = makeObserveAgent({ dataDir: path.join(tmpDir, 't4'), keywords: ['架构'], observationWindowSec: 60, responses: [{ tool_calls: [speakTool()] }] });
    try {
      // 未命中消息进 buffer
      await collect(emit => a.receive({ from: 'elf-002', content: '随便聊聊', mentions: [], role: 'chat' }, { emit }));
      assert.equal(a._rm._buffer.length, 1);
      // 模拟窗口到期：_lastFlushAt 设为远过去
      a._rm._lastFlushAt = Date.now() - 100000;
      assert.ok(a._rm.shouldFlushObserve(), '窗口应已到期');
      const ev = await collect(emit => a.triggerRoomFlush('observe', { emit }));
      assert.ok(ev.some(e => e.event === 'tool_call'), '窗口到期应触发 reasoning');
    } finally { a._rm.dispose(); }
  });

  it('窗口到期 buffer 空 → 仍触发 reasoning（巡视，agent 可 Skip/主动 Speak）', async () => {
    const a = makeObserveAgent({ dataDir: path.join(tmpDir, 't5'), keywords: ['架构'], responses: [{ tool_calls: [speakTool()] }] });
    try {
      a._rm._lastFlushAt = Date.now() - 100000;
      assert.equal(a._rm._buffer.length, 0);
      assert.equal(a._rm.shouldFlushObserve(), true, '空 buffer 到期仍应触发');
      const ev = await collect(emit => a.triggerRoomFlush('observe', { emit }));
      assert.ok(ev.some(e => e.event === 'tool_call'), '空 buffer 到期应仍 reasoning');
      // merged 含 [当前时间] 作为巡视输入
      const userMsg = a.messageManager.messages.find(m => m.role === 'user');
      assert.ok(userMsg?.content?.includes('[当前时间]'), '空 buffer 的 user 消息应含 [当前时间]');
    } finally { a._rm.dispose(); }
  });

  it('窗口未到期 → shouldFlushObserve=false', async () => {
    const a = makeObserveAgent({ dataDir: path.join(tmpDir, 't6'), keywords: ['架构'], observationWindowSec: 60 });
    try {
      await collect(emit => a.receive({ from: 'elf-002', content: '随便', mentions: [], role: 'chat' }, { emit }));
      a._rm._lastFlushAt = Date.now();   // 刚 flush，窗口未到
      assert.equal(a._rm.shouldFlushObserve(), false);
    } finally { a._rm.dispose(); }
  });

  // ---- 静默放手 ----
  it('Skip 工具：主动放弃本轮，不注入 Speak 提醒', async () => {
    const a = makeObserveAgent({ dataDir: path.join(tmpDir, 't7'), keywords: ['架构'], responses: [{ tool_calls: [skipTool('不关我事')] }] });
    try {
      const ev = await collect(emit => a.receive({ from: 'elf-002', content: '聊架构', mentions: [], role: 'chat' }, { emit }));
      assert.ok(ev.some(e => e.event === 'tool_call'), '应调用 Skip');
      const metas = a.messageManager.messages.filter(m => m.metaTag === 'speak_reminder');
      assert.equal(metas.length, 0, 'Skip 不应注入 speak_reminder');
    } finally { a._rm.dispose(); }
  });

  it('固定 silentRetries=2：连续 2 次纯 content 注入提醒，第 3 次放弃', async () => {
    // silentRetries 固定常量2，不可配；工厂传 silentRetries 无效
    const a = makeObserveAgent({
      dataDir: path.join(tmpDir, 't8'), keywords: ['架构'], silentRetries: 5,
      responses: [{ content: '嗯' }, { content: '哦' }, { content: '算了' }],
    });
    try {
      assert.equal(a._rm.getObserveConfig().silentRetries, 2, '固定为2，不可配');
      await collect(emit => a.receive({ from: 'elf-002', content: '聊架构', mentions: [], role: 'chat' }, { emit }));
      const metas = a.messageManager.messages.filter(m => m.metaTag === 'speak_reminder');
      assert.equal(metas.length, 2, '应注入 2 次提醒');
      assert.equal(a._rm._speakAttempts, 3, '第3次放弃，attempts=3');
    } finally { a._rm.dispose(); }
  });

  // ---- both 策略 ----
  it('both 策略：被 @ 走强门控（阈值1，连续2次纯content放弃）', async () => {
    const a = makeObserveAgent({
      strategy: 'both', dataDir: path.join(tmpDir, 't9'), keywords: ['架构'],
      responses: [{ content: '想' }, { content: '还是不调' }],
    });
    try {
      await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 说', mentions: ['elf-001'], role: 'chat' }, { emit }));
      assert.equal(a._rm._currentTrigger, 'mention', '@ 触发应标 mention');
      const metas = a.messageManager.messages.filter(m => m.metaTag === 'speak_reminder');
      assert.equal(metas.length, 1, '阈值1：只注入1次提醒');
      assert.equal(a._rm._speakAttempts, 2);
    } finally { a._rm.dispose(); }
  });

  it('both 策略：未@但关键词命中 → 走弱门控（trigger=observe）', async () => {
    const a = makeObserveAgent({
      strategy: 'both', dataDir: path.join(tmpDir, 't10'), keywords: ['架构'], silentRetries: 2,
      responses: [{ tool_calls: [skipTool()] }],
    });
    try {
      await collect(emit => a.receive({ from: 'elf-002', content: '聊架构', mentions: [], role: 'chat' }, { emit }));
      assert.equal(a._rm._currentTrigger, 'observe', '关键词命中应标 observe');
    } finally { a._rm.dispose(); }
  });

  // ---- 定时器生命周期 ----
  it('observe 策略 onRoomEnter 起 timer；dispose 清空', async () => {
    const a = makeObserveAgent({ dataDir: path.join(tmpDir, 't11'), keywords: ['架构'] });
    try {
      // receive 触发 onRoomEnter
      await collect(emit => a.receive({ from: 'elf-002', content: 'hi', mentions: [], role: 'chat' }, { emit }));
      assert.ok(a._rm._observeTimer !== null, 'observe 应 arm timer');
      a._rm.dispose();
      assert.equal(a._rm._observeTimer, null, 'dispose 清 timer');
      assert.equal(a._rm._disposed, true);
    } finally { a._rm.dispose(); }
  });

  it('mention 策略不起 timer', async () => {
    const a = makeObserveAgent({ strategy: 'mention', dataDir: path.join(tmpDir, 't12'), keywords: ['架构'] });
    try {
      await collect(emit => a.receive({ from: 'elf-002', content: 'hi', mentions: [], role: 'chat' }, { emit }));
      assert.equal(a._rm._observeTimer, null, 'mention 不起 timer');
    } finally { a._rm.dispose(); }
  });

  // ---- 关键词列表注入 prompt（LLM 可感知当前关键词 + 热更新）----
  it('当前关键词列表注入 <system_reminder>，LLM 可感知', async () => {
    const a = makeObserveAgent({ dataDir: path.join(tmpDir, 'p1'), keywords: ['架构', '性能'], observationWindowSec: 90, responses: [{ tool_calls: [speakTool()] }] });
    try {
      // 测试无 roomBusUrl，_refreshRoster 不刷新；手动设 _rosterStatic + _roomName 模拟已刷新
      a._rm._rosterStatic = '群聊规则占位\n';
      a._rm._roomName = '测试群';
      // 命中"架构"触发 reasoning → user 消息进 context，promptAssembler 才有 user 可拼前缀
      await collect(emit => a.receive({ from: 'elf-002', content: '聊架构', mentions: [], role: 'chat' }, { emit }));
      const out = a.promptAssembler.assemble(a.messageManager.getBaseForLLM(), { agent: a, messageManager: a.messageManager });
      const userMsg = out.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('聊天历史'));
      assert.ok(userMsg, '应有 flush 进 context 的 user 消息');
      const c = userMsg.content;
      assert.ok(c.includes('<system_reminder>'), '应注入 system_reminder');
      // 当前时间在聊天历史末尾，不在 reminder
      assert.ok(!c.includes('当前本地时间'), 'reminder 不再含当前时间');
      assert.ok(c.includes('[当前时间]'), '聊天历史末尾应含 [当前时间]');
      assert.ok(c.indexOf('你正在一个多人聊天群「测试群」中') < c.indexOf('[当前时间]'), '群名引导句在时间之前');
      assert.match(c, /关注的关键词/, '应有关键词说明');
      // 关注词（架构、性能）在提示里；名字不进关键词列表（读取时并入匹配，不展示）
      assert.ok(!/\[.*elf-001.*\]/.test(c), '名字不应进关注关键词列表');
      assert.ok(c.includes('架构'), '自定义词应在关键词列表');
      assert.ok(c.includes('性能'), '自定义词应在关键词列表');
    } finally { a._rm.dispose(); }
  });

  it('SetObserveConfig 改词后，下一轮 prompt 热更新（窗口不由工具设置）', async () => {
    const a = makeObserveAgent({ dataDir: path.join(tmpDir, 'p2'), keywords: ['架构'], observationWindowSec: 60, responses: [{ tool_calls: [speakTool()] }, { tool_calls: [speakTool()] }] });
    try {
      a._rm._rosterStatic = '群聊规则占位\n';
      // 第一轮命中"架构"
      await collect(emit => a.receive({ from: 'elf-002', content: '聊架构', mentions: [], role: 'chat' }, { emit }));
      // 改词（工具不再设窗口；observationWindowSec 即便传也忽略）
      await SetObserveConfig.execute({ keywords: ['性能', 'bug'], observationWindowSec: 120 }, undefined, { agent: a });
      // 第二轮命中"性能"
      await collect(emit => a.receive({ from: 'elf-003', content: '聊性能', mentions: [], role: 'chat' }, { emit }));
      const out = a.promptAssembler.assemble(a.messageManager.getBaseForLLM(), { agent: a, messageManager: a.messageManager });
      const userMsgs = out.filter(m => m.role === 'user' && typeof m.content === 'string');
      const last = userMsgs[userMsgs.length - 1].content;
      assert.ok(last.includes('性能') && last.includes('bug'), '新词应出现在 prompt');
      assert.ok(!/架构/.test(last), '旧关注词应消失');
    } finally { a._rm.dispose(); }
  });

  it('mention 策略不暴露关键词/窗口，但仍含群名引导句', async () => {
    const a = makeObserveAgent({ strategy: 'mention', dataDir: path.join(tmpDir, 'p3'), keywords: ['架构'], responses: [{ tool_calls: [speakTool()] }] });
    try {
      a._rm._rosterStatic = '群聊规则占位\n';
      a._rm._roomName = '测试群';
      // mention 策略：被@触发
      await collect(emit => a.receive({ from: 'elf-002', content: '@elf-001 hi', mentions: ['elf-001'], role: 'chat' }, { emit }));
      const out = a.promptAssembler.assemble(a.messageManager.getBaseForLLM(), { agent: a, messageManager: a.messageManager });
      const userMsg = out.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('聊天历史'));
      assert.ok(userMsg, '应触发 reasoning');
      assert.ok(userMsg.content.includes('你正在一个多人聊天群「测试群」中'), 'mention 仍含群名引导句');
      assert.ok(!userMsg.content.includes('关注关键词'), 'mention 不暴露关键词');
      assert.ok(!userMsg.content.includes('观测巡视间隔'), 'mention 不暴露观测窗口');
    } finally { a._rm.dispose(); }
  });

  // ---- 工具 ----
  describe('Skip 工具', () => {
    it('execute 返回跳过信息；带 reason', async () => {
      const r1 = await Skip.execute({}, undefined, { agent: { runContext: { mode: 'room' } } });
      assert.match(r1, /已跳过/);
      const r2 = await Skip.execute({ reason: '不熟' }, undefined, { agent: { runContext: { mode: 'room' } } });
      assert.match(r2, /不熟/);
    });
    it('aborted → Error', async () => {
      const ac = new AbortController(); ac.abort();
      const r = await Skip.execute({}, ac.signal, { agent: { runContext: { mode: 'room' } } });
      assert.match(r, /aborted/);
    });
  });

  describe('SetObserveConfig 工具', () => {
    it('写文件 + 热生效（RoomPlugin 读到新关注词；名字读取时并入不占名额）', async () => {
      const dir = path.join(tmpDir, 't13');
      const a = makeObserveAgent({ dataDir: dir, keywords: ['架构'] });
      try {
        // 初始：关注词['架构']；effective 含名字 elf-001（读取时并入）
        assert.deepEqual(a._rm.getObserveConfig().keywords, ['elf-001', '架构']);
        assert.deepEqual(a._rm.getObserveConfig().focusKeywords, ['架构']);
        // 工具改为 ['性能','bug']
        const r = await SetObserveConfig.execute({ keywords: ['性能', 'bug'] }, undefined, { agent: a });
        assert.match(r, /已更新/);
        const fp = path.join(dir, 'observe_status.json');
        assert.ok(fs.existsSync(fp), '应写 observe_status.json');
        // 文件里只有纯关注词（不含名字）
        const fileCfg = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        assert.deepEqual(fileCfg.keywords, ['性能', 'bug'], '文件只存纯关注词，不含名字');
        assert.deepEqual(a._rm.getObserveConfig().focusKeywords, ['性能', 'bug']);
        assert.deepEqual(a._rm.getObserveConfig().keywords, ['elf-001', '性能', 'bug'], 'effective 仍含名字（读取并入）');
      } finally { a._rm.dispose(); }
    });

    it('关键词超上限截断（关注词最多7，名字不占名额）；工具不设窗口', async () => {
      const dir = path.join(tmpDir, 't14');
      const a = makeObserveAgent({ dataDir: dir, keywords: ['x'] });
      try {
        const r = await SetObserveConfig.execute({
          keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],  // 8 个关注词，超上限
          observationWindowSec: 5,                               // 工具已不暴露该参数，传了也忽略
        }, undefined, { agent: a });
        assert.match(r, /截断/, '关注词超限应截断');
        const cfg = a._rm.getObserveConfig();
        // 关注词截断到 7；effective = 名字 + 7 = 8（名字不占名额）
        assert.equal(cfg.focusKeywords.length, 7, '关注词截断到 7');
        assert.equal(cfg.keywords.length, 8, '含名字共 8（名字不占名额）');
        assert.equal(cfg.keywords[0], 'elf-001', '名字恒在 effective 第0位');
        assert.equal(cfg.observationWindowSec, 60, '窗口仍为 config 默认 60（工具不设窗口）');
        assert.equal(cfg.silentRetries, 2, 'silentRetries 固定2，工具不可配');
      } finally { a._rm.dispose(); }
    });

    it('keywords=[] 清空关注词，effective 仍含名字（读取并入）', async () => {
      const dir = path.join(tmpDir, 't15');
      const a = makeObserveAgent({ dataDir: dir, keywords: ['架构'] });
      try {
        assert.deepEqual(a._rm.getObserveConfig().keywords, ['elf-001', '架构']);
        await SetObserveConfig.execute({ keywords: [] }, undefined, { agent: a });
        assert.deepEqual(a._rm.getObserveConfig().focusKeywords, []);
        assert.deepEqual(a._rm.getObserveConfig().keywords, ['elf-001'], '清空关注词后 effective 仍含名字');
        // 名字仍能命中
        assert.ok(a._rm._matchesKeyword('elf-001 你看下', ['elf-001']), '名字仍命中');
      } finally { a._rm.dispose(); }
    });

    it('工具不暴露 silentRetries 参数（传了也无效）', async () => {
      const dir = path.join(tmpDir, 't16');
      const a = makeObserveAgent({ dataDir: dir, keywords: ['x'] });
      try {
        // 工具 parameters 不含 silentRetries
        assert.equal(SetObserveConfig.parameters.properties.silentRetries, undefined, '工具不暴露 silentRetries');
        // 即便手动传，工具也不处理（execute 不读 args.silentRetries）
        const r = await SetObserveConfig.execute({ observationWindowSec: 30, silentRetries: 5 }, undefined, { agent: a });
        assert.match(r, /已更新/);
        assert.equal(a._rm.getObserveConfig().silentRetries, 2, 'silentRetries 恒为2');
        // 文件里不应有 silentRetries 残留
        const fileCfg = JSON.parse(fs.readFileSync(path.join(dir, 'observe_status.json'), 'utf-8'));
        assert.equal(fileCfg.silentRetries, undefined, '文件不写 silentRetries');
      } finally { a._rm.dispose(); }
    });

    it('私聊/无 dataDir → Error', async () => {
      const r = await SetObserveConfig.execute({ keywords: ['x'] }, undefined, { agent: { runContext: { mode: 'private' } } });
      assert.match(r, /Error/);
    });

  describe('observe_status.json 文件唯一来源', () => {
    it('getObserveConfig 直接读文件；名字在读取时并入匹配列表', async () => {
      const dir = path.join(tmpDir, 'f1');
      const a = makeObserveAgent({ dataDir: dir, keywords: ['架构'] });
      try {
        // 工厂已 _ensureObserveStatus 建文件，存纯关注词 ['架构']
        const fp = path.join(dir, 'observe_status.json');
        assert.ok(fs.existsSync(fp));
        assert.deepEqual(a._rm.getObserveConfig().focusKeywords, ['架构']);
        assert.deepEqual(a._rm.getObserveConfig().keywords, ['elf-001', '架构'], 'effective 含名字（读取并入）');
        // 手动改文件 → getObserveConfig 立即反映（文件唯一来源）
        fs.writeFileSync(fp, JSON.stringify({ keywords: ['手动词'], observationWindowSec: 99 }, null, 2), 'utf-8');
        assert.deepEqual(a._rm.getObserveConfig().focusKeywords, ['手动词']);
        assert.deepEqual(a._rm.getObserveConfig().keywords, ['elf-001', '手动词']);
        assert.equal(a._rm.getObserveConfig().observationWindowSec, 99);
      } finally { a._rm.dispose(); }
    });

    it('改名热同步：显示名变了，effective 自动用新名字（无需回写文件）', async () => {
      const dir = path.join(tmpDir, 'f2');
      const a = makeObserveAgent({ dataDir: dir, keywords: ['架构'] });
      try {
        // 初始名字 elf-001（memberName）
        assert.deepEqual(a._rm.getObserveConfig().keywords, ['elf-001', '架构']);
        // 文件里只有关注词，不含名字
        const fp = path.join(dir, 'observe_status.json');
        assert.deepEqual(JSON.parse(fs.readFileSync(fp, 'utf-8')).keywords, ['架构']);
        // 模拟 roster 刷新后显示名变成"大黑塔"
        a._rm._agentNames.set('elf-001', '大黑塔');
        a._rm._ensureObserveStatus();
        // effective 自动换名；文件未变（名字不落盘）
        const kw = a._rm.getObserveConfig().keywords;
        assert.ok(kw.includes('大黑塔'), 'effective 自动并入新名字');
        assert.equal(kw[0], '大黑塔', '新显示名在 effective 第0位');
        assert.deepEqual(JSON.parse(fs.readFileSync(fp, 'utf-8')).keywords, ['架构'], '文件不存名字，改名无需回写');
      } finally { a._rm.dispose(); }
    });

    it('文件不存在 + 无 config 种子 → 关注词为空，effective 仅含名字', async () => {
      const dir = path.join(tmpDir, 'f3');
      const a = makeObserveAgent({ dataDir: dir });  // 无 keywords
      try {
        assert.deepEqual(a._rm.getObserveConfig().focusKeywords, [], '关注词为空');
        assert.deepEqual(a._rm.getObserveConfig().keywords, ['elf-001'], 'effective 仅名字');
      } finally { a._rm.dispose(); }
    });
  });
  });
});