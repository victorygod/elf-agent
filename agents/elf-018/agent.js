/**
 * DNDAgent —— DND DM agent（elf-018），3-loop workflow：main（大纲）→ reviewer（审校+维护）→ render。
 *
 * main loop：回归普通 agent——用主 MM 跨轮累积（Uₙ + tool + assistant 大纲），DNDMM.getBaseForLLM
 *   剪裁"最近 user 之前"的超长 tool_result（<persisted-output> 占位），canon/面板/任务由 create_agent
 *   注册的注入器（useSystemReplace/useAppend）在 _currentLoop='main' 时注入。不 override _buildLLMRequest。
 * reviewer loop：override _buildLLMRequest 自建 messages（摘要+最近2历史大纲+待review大纲+面板+任务reminder），
 *   合并原 lore_keeper：改大纲 + 更新 lore + 据面板造新主角卡（user_profile.md）。改前 _backupPanel 备份旧面板。
 * render loop：隔离 _buildRenderMessages（历史大纲+上一轮正文+本轮大纲+新旧面板+语言风格reminder）。
 *
 * 本轮 tool 隔离：_loopStartMsgIdx 记 loop 开始 MM 偏移，reviewer 重建历史不带 main 的 tool。
 * Skip 后直接 break（_runToolExec override）。
 */
import fs from 'fs';
import path from 'path';
import { Agent } from '../../engine/agent.js';
import { Skip } from '../../engine/tools/Skip.js';
import { createLogger } from '../../shared/logger.js';
import { buildMetadata } from '../../shared/agents/elf-018/buildMetadata.js';

const logger = createLogger('dnd-agent');

// ===== 提示词文案（统一管理；注释标明使用位置）=====

// runFourLoopWorkflow 内 detect 失败时 addMetaMessage 注入的提醒（main / reviewer loop）
const REMINDER_MAIN = '尚未产出本轮大纲，请用 Write 把大纲写到 outline/round-N.md（含 剧情节拍 + 数值结算 initial/changes/final）后再结束。';
const REMINDER_REVIEWER = '尚未完成审校/维护：请改大纲、更新 lore、或据面板造新主角卡；若全无需改动，调用 Skip。';

// _mainContext 末尾的写大纲任务指令（main loop 的 useAppend 注入）
const MAIN_TASK_INSTR = (N, outlineAbs) => `本轮轮次 N=${N}。请把大纲写到 ${outlineAbs}（含 剧情节拍 + 数值结算 initial/changes/final），需判定时调 Roll。`;

// _buildReviewerMessages 末尾的 <system-reminder> 任务（改大纲/更新lore/造新角色卡）
const REVIEWER_REMINDER = (task, outlineAbs, loreAbs, panelPath) =>
  `<system-reminder>\n${task}\n\n大纲路径: ${outlineAbs}（Edit/Write 改）；lore 根: ${loreAbs}（Write/Edit 更新设定）；角色卡路径: ${panelPath}（Write 输出整份 JSON 造新角色卡）。\n</system-reminder>`;

// 角色卡（面板）消息体：_mainContext / _buildReviewerMessages / _buildRenderMessages 的面板注入
const PANEL_MSG = (tag, panelPath, content) => `## ${tag}（路径: ${panelPath}）\n\`\`\`json\n${content}\n\`\`\``;

// _historyMerged 的每轮历史对 + 分隔（reviewer 与 render 共用）
const HIST_PAIR = (u, i, o) => `玩家指令：${u}\nRound ${i} 大纲：${o}`;
const HIST_SEP = '\n---\n';

// _doHistoryCompact 的压缩指令前缀
const COMPACT_INSTR = '把以下更早的历史（玩家指令/大纲）压缩成剧情脉络摘要（保留伏笔/关键状态/NPC/玩家行动，丢弃数值演算细节）：\n\n';

const LOOPS = [
  {
    name: 'main',
    reminderTag: 'main_reminder',
    disableTools: [],
    detect: async (agent) => fs.existsSync(path.join(agent._roots.outline, agent._roundFile())),
    reminder: REMINDER_MAIN,
  },
  {
    name: 'reviewer',
    reminderTag: 'reviewer_reminder',
    disableTools: ['Roll'],
    extraTools: [Skip],
    detect: async (agent) => {
      if (agent._loopCalledSkip()) return true;
      const outline = path.join(agent._roots.outline, agent._roundFile());
      const char = path.join(agent._roots.lore, agent._protagonistFile);
      const start = agent._loopStartMs || 0;
      const oChanged = fs.existsSync(outline) && fs.statSync(outline).mtimeMs > start;
      const cChanged = fs.existsSync(char) && fs.statSync(char).mtimeMs > start;
      return oChanged || cChanged;
    },
    reminder: REMINDER_REVIEWER,
  },
  {
    name: 'render',
    reminderTag: 'render_reminder',
    disableTools: null,
    isRender: true,
  },
];

export class DNDAgent extends Agent {
  async reasoning(message, opts = {}) {
    if (this._scene) {
      // 每轮重置中断标记：super.reasoning 在 engine/agent.js 入口处做（this._aborted = false），
      //   本 override 绕过 super 直进 runFourLoopWorkflow，须自行补齐。否则用户首次中断后 _aborted
      //   常驻 true，后续每轮首个工具执行完即被 executeBatch 当作中断抛 AbortError → runAborable 收尾，
      //   表现为「中断过一次就一直中断」。
      this._aborted = false;
      return this.runFourLoopWorkflow({ emit: opts.emit || (() => {}), skipAddUser: opts.skipAddUser });
    }
    return super.reasoning(message, opts);
  }

  async runFourLoopWorkflow({ emit, skipAddUser }) {
    const maxIterations = this.config.get('maxIterations') ?? 5;
    this._roundNumber = this._countRounds() + 1;
    this._triggerHistoryCompact();

    for (const loop of LOOPS) {
      this._currentLoop = loop.name;
      this.messageManager._currentLoop = loop.name;   // 传给 MM，add* 方法记 _loop
      this._loopStartMsgIdx = this.messageManager.messages.length;
      this._loopStartMs = Date.now();
      if (loop.name === 'reviewer') this._backupPanel();   // 改面板前备份旧（供 render 新旧对比）

      if (loop.isRender) {
        const aborted = await this._runRenderLoop(loop, emit);
        if (aborted) return;
        continue;
      }

      const disableTools = loop.disableTools === null
        ? this.toolManager.getAll().map((t) => t.name)
        : loop.disableTools;
      const restore = this.harness.withRunLevel({
        toolManager: this.toolManager, middlewares: this.middlewares, disableTools, tools: loop.extraTools,
      });
      try {
        while (true) {
          const loopR = await this._runAgentLoop(emit, maxIterations);
          if (loopR.aborted) { restore(); return; }
          const ok = await loop.detect(this);
          if (ok) break;
          this.messageManager.addMetaMessage(loop.reminder, loop.reminderTag);
        }
      } finally {
        restore();
      }
    }

    this._currentLoop = null;
    this.abortFlow.emitDone(emit, { promptTokens: this.messageManager.estimateTokens() });
  }

  // ============ messages 构建 ============

  /** reviewer 自建 messages；main 用 base assemble（super）。 */
  _buildLLMRequest() {
    if (this._currentLoop === 'reviewer') {
      return { messages: this._buildReviewerMessages(), tools: this.toolManager.getAll() };
    }
    return super._buildLLMRequest();
  }

  /** 本轮调了 Skip → 直接 break（不再请求纯文本轮）。 */
  async _runToolExec(toolCallsResult, emit) {
    const r = await super._runToolExec(toolCallsResult, emit);
    if (r.aborted) return r;
    if (this._loopCalledSkip()) return { aborted: false, break: true };
    return r;
  }

  /** main 的 system（总纲 + canon + file_index），由 create_agent 注入器调用。 */
  _mainSystem() {
    let sys = this.config.get('systemPrompt') || '';
    const md = buildMetadata(this._roots.lore);
    if (md) sys += '\n\n' + md;
    return sys;
  }

  /** main 的 append（当前面板 + 写大纲任务），由 create_agent 注入器调用。 */
  _mainContext() {
    const read = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch { return ''; } };
    const N = this._roundNumber;
    const panelPath = path.join(this._roots.lore, this._protagonistFile);
    const outlineAbs = path.join(this._roots.outline, this._roundFile());
    const task = this.config.get('loop_outline_prompt') || '';
    return `${PANEL_MSG('当前面板', panelPath, read(panelPath))}\n\n${task}\n\n${MAIN_TASK_INSTR(N, outlineAbs)}`;
  }

  /** reviewer messages：system(总纲+canon+file_index) + 摘要 + 最近2历史大纲 + 待review大纲 + 当前面板 + 任务reminder。 */
  _buildReviewerMessages() {
    const read = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch { return ''; } };
    const N = this._roundNumber;
    const msgs = [{ role: 'system', content: this._mainSystem() }];

    const summary = read(path.join(this._roots.outline, 'history-summary.md'));
    if (summary) msgs.push({ role: 'user', content: `## 历史摘要\n${summary}` });

    const users = this._extractUserMessages();
    const hist = this._historyMerged(read, users);
    if (hist) msgs.push({ role: 'user', content: hist });

    const outline = read(path.join(this._roots.outline, this._roundFile()));
    msgs.push({ role: 'user', content: `玩家当前指令：${users[N - 1] || ''}\n待review大纲：\n${outline || ''}` });

    const panelPath = path.join(this._roots.lore, this._protagonistFile);
    msgs.push({ role: 'user', content: PANEL_MSG('当前面板', panelPath, read(panelPath)) });

    const outlineAbs = path.join(this._roots.outline, this._roundFile());
    const loreAbs = this._roots.lore;
    const task = this.config.get('loop_reviewer_prompt') || '';
    msgs.push({ role: 'user', content: REVIEWER_REMINDER(task, outlineAbs, loreAbs, panelPath) });

    // 本轮 tool 过程（仅本 loop）
    for (const m of this.messageManager.messages.slice(this._loopStartMsgIdx || 0)) {
      const { id, isMeta, metaTag, isCompactSummary, ...rest } = m;
      msgs.push(rest);
    }
    return msgs;
  }

  // ============ render loop（隔离） ============

  async _runRenderLoop(loop, emit) {
    const messages = this._buildRenderMessages();
    const allTools = this.toolManager.getAll().map((t) => t.name);
    const restore = this.harness.withRunLevel({ toolManager: this.toolManager, middlewares: this.middlewares, disableTools: allTools });
    try {
      const lr = await this._runLLMStream(messages, [], emit, { iteration: 'render' });
      if (lr.aborted) return true;
      const content = lr.content || '';
      this.messageManager.addAssistantMessage(content);
      try {
        fs.mkdirSync(this._roots.scene, { recursive: true });
        fs.writeFileSync(path.join(this._roots.scene, this._roundFile()), content, 'utf-8');
      } catch (e) {
        logger.error(`落 scene 失败: ${e.message}`);
      }
      return false;
    } finally {
      restore();
    }
  }

  /** render messages：system总纲 + 历史大纲(摘要+最近) + 上一轮正文 + 本轮大纲+新旧面板 + 语言风格reminder。 */
  _buildRenderMessages() {
    const read = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch { return ''; } };
    const N = this._roundNumber;
    const users = this._extractUserMessages();
    const sysPrompt = this.config.get('systemPrompt') || '';
    const examples = this.config.get('renderExamples') || '';
    const msgs = [{ role: 'system', content: examples ? sysPrompt + '\n\n' + examples : sysPrompt }];

    // render 不含 metadata（不读 lore，所需设定由大纲抄录）
    const summary = read(path.join(this._roots.outline, 'history-summary.md'));
    if (summary) msgs.push({ role: 'user', content: `## 历史摘要\n${summary}` });

    const hist = this._historyMerged(read, users);
    if (hist) msgs.push({ role: 'user', content: hist });

    const outline = read(path.join(this._roots.outline, this._roundFile()));
    const panelPath = path.join(this._roots.lore, this._protagonistFile);
    const prevPanelPath = path.join(this._roots.lore, this._prevFile());
    const panelBlock = `${PANEL_MSG('旧面板(initial)', prevPanelPath, read(prevPanelPath))}\n\n${PANEL_MSG('新面板(final)', panelPath, read(panelPath))}`;
    msgs.push({ role: 'user', content: `玩家当前指令：${users[N - 1] || ''}\n本轮大纲：\n${outline || ''}\n\n${panelBlock}` });

    const rem = this.config.get('loop_render_prompt') || '';
    if (rem) msgs.push({ role: 'user', content: `<system-reminder>\n${rem}\n</system-reminder>` });
    return msgs;
  }

  /** 历史轮合并一条 user：每轮"玩家指令：U_i\nRound i 大纲：outline_i"，用 --- 分隔（最近 2 轮，被压的进摘要）。 */
  _historyMerged(read, users) {
    const N = this._roundNumber;
    const startI = Math.max(1, N - 2);
    const parts = [];
    for (let i = startI; i < N; i++) {
      const u = users[i - 1] != null ? users[i - 1] : '';
      const o = read(path.join(this._roots.outline, `round-${i}.md`)) || '';
      parts.push(HIST_PAIR(u, i, o));
    }
    return parts.join(HIST_SEP);
  }

  // ============ skip / 历史压缩 / clearRuntime / helpers ============

  /** 清空运行时文档（rm runtime + re-seed 回种子态）——clearRoom 调。 */
  clearRuntime() {
    if (!this._configDir || !this.messageManager?.dataDir) return;
    const runtimeDir = path.join(this.messageManager.dataDir, 'runtime');
    const seedsDir = path.join(this._configDir, 'seeds');
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch (e) { logger.warn(`清 runtime 失败: ${e.message}`); }
    this._seedRuntime(seedsDir, runtimeDir);
    logger.info('runtime 已清空并重新播种');
  }

  _seedRuntime(seedsDir, runtimeDir) {
    for (const name of ['lore', 'outline', 'scene']) {
      const dst = path.join(runtimeDir, name);
      if (fs.existsSync(dst)) continue;
      const src = path.join(seedsDir, name);
      if (!fs.existsSync(src)) continue;
      try { this._copyDir(src, dst); } catch (e) { /* 种子拷贝失败不阻断 */ }
    }
  }

  _copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) this._copyDir(s, d);
      else if (e.isFile()) fs.copyFileSync(s, d);
    }
  }

  _loopCalledSkip() {
    for (const m of this.messageManager.messages.slice(this._loopStartMsgIdx || 0)) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          if ((tc.function?.name || tc.name) === 'Skip') return true;
        }
      }
    }
    return false;
  }

  _triggerHistoryCompact() {
    const N = this._roundNumber;
    if (N < 3) return;   // 保最近 2，需 N>=3
    const summaryPath = path.join(this._roots.outline, 'history-summary.md');
    const read = (p) => { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch { return ''; } };
    let total = read(summaryPath).length;
    for (let i = 1; i < N; i++) total += read(path.join(this._roots.outline, `round-${i}.md`)).length;
    const limit = this.config.get('historyOutlineLimit') ?? 16000;
    if (total <= limit) return;
    void this._doHistoryCompact().catch((e) => logger.warn(`历史大纲压缩失败: ${e.message}`));
  }

  // 压 round-1..N-3 + user_1..N-3（保最近 2：round-(N-2), round-(N-1)）
  async _doHistoryCompact() {
    const N = this._roundNumber;
    if (N < 3) return;
    const summaryPath = path.join(this._roots.outline, 'history-summary.md');
    const read = (p) => { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch { return ''; } };
    const parts = [];
    const old = read(summaryPath);
    if (old) parts.push(`## 历史摘要\n${old}`);
    const users = this._extractUserMessages();
    for (let i = 1; i <= N - 3; i++) {
      if (users[i - 1] != null) parts.push(`## 玩家 round-${i}\n${users[i - 1]}`);
      const c = read(path.join(this._roots.outline, `round-${i}.md`));
      if (c) parts.push(`## 大纲 round-${i}\n${c}`);
    }
    if (!parts.length) return;
    const compactSystemPrompt = this.config.get('compactSystemPrompt') || '';
    const compactPrompt = this.config.get('compactPrompt') || COMPACT_INSTR;
    const req = [];
    if (compactSystemPrompt) req.push({ role: 'system', content: compactSystemPrompt });
    req.push({ role: 'user', content: compactPrompt + parts.join('\n\n') });
    const summary = (await this.model.chat(req, { enable_thinking: false })) || '';
    if (summary.trim()) {
      fs.writeFileSync(summaryPath, summary, 'utf-8');
      logger.info(`历史大纲压缩完成，摘要写入 ${summaryPath}`);
    }
  }

  _extractUserMessages() {
    return this.messageManager.messages
      .filter((m) => m.role === 'user' && !m.isMeta && !m.isCompactSummary)
      .map((m) => m.content);
  }

  /** reviewer 改面板前备份旧 → 主角.prev.json，供 render 读"旧面板"。 */
  _backupPanel() {
    try {
      const charPath = path.join(this._roots.lore, this._protagonistFile);
      const prevPath = path.join(this._roots.lore, this._prevFile());
      if (fs.existsSync(charPath)) fs.copyFileSync(charPath, prevPath);
      else fs.writeFileSync(prevPath, '', 'utf-8');
    } catch (e) {
      logger.warn(`备份面板失败: ${e.message}`);
    }
  }
  _prevFile() {
    return this._protagonistFile.replace(/\.md$/, '.prev.md');
  }

  _roundFile() {
    return `round-${this._roundNumber}.md`;
  }
  _countRounds() {
    try {
      const files = fs.readdirSync(this._roots.outline).filter((f) => /^round-[1-9]\d*\.md$/.test(f));
      return files.length;
    } catch { return 0; }
  }
}