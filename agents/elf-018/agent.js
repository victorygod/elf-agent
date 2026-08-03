/**
 * DNDAgent —— DND DM agent（elf-018），2-loop workflow：outline（产大纲+维护）→ render。
 *
 * outline loop：回归普通 agent——用主 MM 跨轮累积（Uₙ + tool + 各轮 render 正文），base compactIfNeeded
 *   异步压缩（DNDMM._doCompact lastUser：摘要"最近 user 之前"全部，保留最近 user 及之后）+ getBaseForLLM
 *   剪裁"最近 user 之前"的超长 tool_result（<persisted-output> 占位）；canon/全局进度(state.md)/面板/任务由
 *   create_agent 注入器在 _currentLoop='outline' 时注入（基线预载 → 提示词不要求先 Read）。不 override _buildLLMRequest。
 *   职责：WriteOutline 落本轮大纲（含「剧情发展」节）+ 据 changes 维护 lore/面板/state.md。
 *   detect 只看本轮大纲 mtime 是否更新——产大纲是唯一 completion 信号，维护为衍生 best-effort。
 *   改前 _backupPanel 备份旧面板（供 render 新旧对比）。
 * render loop：隔离 _buildRenderMessages（MM 压缩摘要 + fresh outline 文件 + 上一轮正文 + 本轮大纲+新旧面板 + 语言风格reminder）。
 *   历史不再单列 outline 摘要文件：render 直接取 outline loop MM 里的压缩摘要 + 压缩后仍在 MM 的轮的 outline 文件。
 */
import fs from 'fs';
import path from 'path';
import { Agent } from '../../engine/agent.js';
import { sendNotice } from '../../engine/notice.js';
import { createLogger } from '../../shared/logger.js';
import { buildMetadata } from '../../shared/agents/elf-018/buildMetadata.js';
import { SUMMARY_PREAMBLE, CONTINUATION_CLAUSE } from '../../engine/message_manager.js';

const logger = createLogger('dnd-agent');

// ===== 提示词文案（统一管理；注释标明使用位置）=====

// runFourLoopWorkflow 内 detect 失败时 addMetaMessage 注入的提醒（outline loop）
const REMINDER_OUTLINE = '本轮尚未产出大纲（outline/round-N.md 未更新）。请用 WriteOutline 写本轮大纲（含 情节弧 + 剧情发展 + 数值结算 initial/changes/final）；落完大纲后据 changes 用 Write/Edit 维护 lore（角色卡/设定）、user_profile.md（面板）、state.md（故事态）。';

// _outlineContext 末尾的任务指令（outline loop 的 useAppend 注入）
const MAIN_TASK_INSTR = (N) =>
  `本轮轮次 N=${N}。请调用 WriteOutline 写本轮大纲（content 含 情节弧 + 剧情发展 + 数值结算 initial/changes/final），需判定时调 Roll；` +
  `落完大纲后据 changes 用 Write/Edit 维护 lore（角色卡/设定）、user_profile.md（面板）、state.md（故事态）。` +
  `全部落盘后对话只回一句"大纲已完成"——本阶段不渲染正文，正文由后续 render loop 产出，不要在回复里写正文/叙事/选项。`;

// 角色卡（面板）消息体：_outlineContext / _buildRenderMessages 的面板注入
const PANEL_MSG = (tag, panelPath, content) => `## ${tag}（路径: ${panelPath}）\n\`\`\`json\n${content}\n\`\`\``;

// fresh outline 文件之间的分隔（render 历史块共用）
const HIST_SEP = '\n---\n';

const LOOPS = [
  {
    name: 'outline',
    reminderTag: 'outline_reminder',
    // 全工具开启：WriteOutline/EditOutline 写本轮大纲（落 outline 目录），Write/Edit 维护 lore/面板/state.md。
    //   专版 Write/Edit 是 lore 作用域，物理碰不到 outline 目录，故无需禁用即可保大纲只能经 WriteOutline 落盘。
    disableTools: [],
    detect: async (agent) => {
      const f = path.join(agent._roots.outline, agent._roundFile());
      const start = agent._loopStartMs || 0;
      return fs.existsSync(f) && fs.statSync(f).mtimeMs > start;
    },
    reminder: REMINDER_OUTLINE,
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

    for (const loop of LOOPS) {
      this._currentLoop = loop.name;
      this.messageManager._currentLoop = loop.name;   // 传给 MM，add* 方法记 _loop
      this._loopStartMs = Date.now();
      if (loop.name === 'outline') this._backupPanel();   // 改面板前备份旧（供 render 新旧对比）

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
        // 提醒上限：detect 失败（未产出大纲）最多重注入 REMINDER_OUTLINE MAX_OUTLINE_REMINDERS 次。
        //   上游偶发空回复时，_handlePureText('') 立即 break、detect 失败，若无上限这个 while 会无限重入
        //   （每轮重新从「第1轮」起，反复空回 + 注入提醒，刷爆日志/烧 token）。超限即放弃本轮、不进 render。
        const MAX_OUTLINE_REMINDERS = 3;
        let reminders = 0;
        while (true) {
          const loopR = await this._runAgentLoop(emit, maxIterations);
          if (loopR.aborted) { restore(); return; }
          const ok = await loop.detect(this);
          if (ok) break;
          if (++reminders > MAX_OUTLINE_REMINDERS) {
            logger.error(`[outline] 提醒 ${MAX_OUTLINE_REMINDERS} 次仍未产出大纲（round ${this._roundNumber}），放弃本轮，不进 render`);
            sendNotice({ emit, runContext: this.runContext }, {
              kind: 'error',
              agentId: this.runContext?.agentId,
              memberName: this.runContext?.memberName,
              text: `连续 ${MAX_OUTLINE_REMINDERS} 次未产出大纲，已中止本轮；可点 ⟲ 回退后重试`,
            });
            this._discardCurrentRoundArtifacts();   // 清本轮半成品，让 rewind+重发能重玩
            this._currentLoop = null;
            this.abortFlow.emitDone(emit, { promptTokens: this.messageManager.estimateTokens() });
            return;   // 直接退出 runFourLoopWorkflow，不进 render loop
          }
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

  /** outline 的 system（总纲 + canon + file_index），由 create_agent 注入器调用。 */
  _outlineSystem() {
    let sys = this.config.get('systemPrompt') || '';
    const md = buildMetadata(this._roots.lore);
    if (md) sys += '\n\n' + md;
    return sys;
  }

  /** outline 的 append（全局进度 state.md + 当前面板 + 写大纲任务），由 create_agent 注入器调用。
   *   state.md 全文 + 主角面板全文预注入上下文 → 提示词无需要求先 Read 即可据基线写大纲/维护设定。 */
  _outlineContext() {
    const read = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch { return ''; } };
    const N = this._roundNumber;
    const statePath = path.join(this._roots.lore, 'state.md');
    const panelPath = path.join(this._roots.lore, this._protagonistFile);
    const task = this.config.get('loop_outline_prompt') || '';
    const stateBlock = PANEL_MSG('全局进度', statePath, read(statePath));
    const panelBlock = PANEL_MSG('当前面板', panelPath, read(panelPath));
    return `${stateBlock}\n\n${panelBlock}\n\n${task}\n\n${MAIN_TASK_INSTR(N)}`;
  }

  // ============ render loop（隔离） ============

  async _runRenderLoop(loop, emit) {
    const messages = this._buildRenderMessages();
    const allTools = this.toolManager.getAll().map((t) => t.name);
    const restore = this.harness.withRunLevel({ toolManager: this.toolManager, middlewares: this.middlewares, disableTools: allTools });
    // render 空内容自愈：上游偶发返回空流（无 content delta），原地重试同一份 messages，
    //   最多重试 MAX_RENDER_RETRIES 次（总 MAX+1 次尝试）。仍空则放弃本轮：不入空 assistant
    //   消息、不落空 scene、删本轮 outline+scene 半成品（让 ⟲ rewind + 重发能重玩本轮而非推进到 N+1）、
    //   推 notice 提示玩家回退。abort 不重试——立即交回 abort 收尾。
    const MAX_RENDER_RETRIES = 3;
    try {
      let content = '';
      for (let attempt = 1; attempt <= 1 + MAX_RENDER_RETRIES; attempt++) {
        const lr = await this._runLLMStream(messages, [], emit, { iteration: 'render' });
        if (lr.aborted) return true;            // 用户中断 → 走 finishAborted，不重试
        content = lr.content || '';
        if (content.trim()) break;              // 非空即成功
        if (attempt <= MAX_RENDER_RETRIES) logger.warn(`[render] 第 ${attempt} 次返回空 content，重试…`);
      }

      if (!content.trim()) {
        logger.error(`[render] 重试 ${MAX_RENDER_RETRIES} 次仍为空，放弃本轮（round ${this._roundNumber}）`);
        sendNotice({ emit, runContext: this.runContext }, {
          kind: 'error',
          agentId: this.runContext?.agentId,
          memberName: this.runContext?.memberName,
          text: `渲染连续 ${MAX_RENDER_RETRIES} 次返回空，已中止本轮；可点 ⟲ 回退到上一轮后重试`,
        });
        this._discardCurrentRoundArtifacts();   // 删 outline/round-N.md + scene/round-N.md
        return false;                           // 正常 emitDone，turn 封棺
      }

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

  /** render 重试耗尽后删本轮半成品：outline/round-N.md + scene/round-N.md。
   *  目的：_countRounds() 数 outline 文件，删掉后计数回到 N-1，配合 ⟲ rewind（恢复 MM 到轮前）
   *    + 重发，本轮从大纲重算重渲；否则 rewind+重发会跳到 N+1、留一条无 scene 的孤儿大纲。 */
  _discardCurrentRoundArtifacts() {
    for (const dir of [this._roots.outline, this._roots.scene]) {
      const f = path.join(dir, this._roundFile());
      try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); }
      catch (e) { logger.warn(`删 ${f} 失败: ${e.message}`); }
    }
  }

  /** render messages：system总纲 + 历史(MM压缩摘要+fresh outline文件) + 上一轮正文 + 本轮大纲+新旧面板 + 语言风格reminder。 */
  _buildRenderMessages() {
    const read = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch { return ''; } };
    const N = this._roundNumber;
    const users = this._extractUserMessages();
    const sysPrompt = this.config.get('systemPrompt') || '';
    const examples = this.config.get('renderExamples') || '';
    const msgs = [{ role: 'system', content: examples ? sysPrompt + '\n\n' + examples : sysPrompt }];

    // render 不含 metadata（不读 lore，所需设定由大纲抄录）。
    // 历史 = outline loop MM 的压缩摘要（去 preamble）+ 压缩后仍在 MM 的轮（fresh）的 outline 文件全文。
    //   fresh 轮范围 K..N-1：K = N - freshUserCount + 1（freshUserCount = MM 里非 meta/非 summary 的 user 数，
    //   即最近一次压缩后留存下来的轮；本轮 N 单独在下方给，不进此块）。
    const summaryText = this._compactSummaryText();
    const freshUserCount = users.length;
    const K = N - freshUserCount + 1;
    const freshParts = [];
    for (let i = K; i < N; i++) {
      const o = read(path.join(this._roots.outline, `round-${i}.md`));
      if (o) freshParts.push(`Round ${i} 大纲：\n${o}`);
    }
    const histBlock = [summaryText ? `## 历史摘要\n${summaryText}` : '', freshParts.join(HIST_SEP)]
      .filter(Boolean).join(HIST_SEP);
    if (histBlock) msgs.push({ role: 'user', content: histBlock });

    // 上一轮正文（scene/round-(N-1).md）以 assistant 角色注入，衔接叙事语气与断章钩
    if (N > 1) {
      const prevScene = read(path.join(this._roots.scene, `round-${N - 1}.md`));
      if (prevScene) msgs.push({ role: 'assistant', content: prevScene });
    }

    const outline = read(path.join(this._roots.outline, this._roundFile()));
    const panelPath = path.join(this._roots.lore, this._protagonistFile);
    const prevPanelPath = path.join(this._roots.lore, this._prevFile());
    const panelBlock = `${PANEL_MSG('旧面板(initial)', prevPanelPath, read(prevPanelPath))}\n\n${PANEL_MSG('新面板(final)', panelPath, read(panelPath))}`;
    // 语言风格 reminder 不单独成消息、不裹 system-reminder 标签，直接拼到当前指令消息尾部
    //   当前轮玩家输入 = MM 里最后一条 fresh user（压缩后老轮 user 已进摘要，不能按下标 users[N-1] 取）
    const rem = this.config.get('loop_render_prompt') || '';
    const currentUser = users.length ? users[users.length - 1] : '';
    msgs.push({ role: 'user', content: `玩家当前指令：${currentUser}\n本轮大纲：\n${outline || ''}\n\n${panelBlock}${rem ? `\n\n${rem}` : ''}` });

    return msgs;
  }

  /** outline loop MM 里最近一次压缩的摘要正文（剥除 SUMMARY_PREAMBLE+CONTINUATION_CLAUSE 前缀）；无则空串。 */
  _compactSummaryText() {
    const m = this.messageManager.messages.find((mm) => mm.isCompactSummary);
    if (!m) return '';
    const pre = SUMMARY_PREAMBLE + CONTINUATION_CLAUSE;
    return m.content && m.content.startsWith(pre) ? m.content.slice(pre.length) : (m.content || '');
  }

  // ============ clearRuntime / helpers ============

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

  _extractUserMessages() {
    return this.messageManager.messages
      .filter((m) => m.role === 'user' && !m.isMeta && !m.isCompactSummary)
      .map((m) => m.content);
  }

  /** outline loop 改面板前备份旧 → 主角.prev.json，供 render 读"旧面板"。 */
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