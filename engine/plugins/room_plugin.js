/**
 * RoomPlugin —— 群聊场景插件（v3 阶段三：Room is Plugin）
 *
 * v0.2 愿景"Room is Plugin"的落点：原 RoomAgent（extends Agent 重载 receive）的调度行为
 * 收敛为本插件。v3 阶段三：继承 ScenePlugin，通用 buffer 机器（flush 循环/mergeForReason/
 * postReason/_flushPending/preReceive 骨架）上升基类，本类只留群聊专属。
 *
 * 群聊专属：
 *   - accept/parse：name 前缀 + mention 检测 + roster 名字映射
 *   - 自消息过滤 / seq 去重 / gap 补洞（_consumeGapMessage / syncMissingHistory）
 *   - shouldFlush = _bufferHasMention（mention 命中才 flush）
 *   - wireOutput：注册 Speak + reasoning 门控（preReason 重置计数 / shouldBreakAfterTools / onAssistantContent Speak 门控）
 *   - _ensureRoomPrompt：群聊人设前缀一次性注入
 *
 * 通用调度状态（_buffer/_bufferHasMention/_replying/_pendingBuffer/_pendingHasMention）在基类，
 *   字段名沿用旧名以兼容测试 + /clear 的 scene._buffer 查找。
 *
 * 门控点经基类 _dispatchGate / _runInjection 调用（对齐 LangChain middleware 链式语义）：
 *   onRoomEnter（注入）/ preReceive / mergeForReason / postReason — receive 编排
 *   preReason（注入）                                             — 每轮 LLM 前重置 Speak 计数
 *   shouldBreakAfterTools / onAssistantContent                   — reasoning 门控
 *
 * start.js 直推 agent._scene = new RoomPlugin(agent)。
 * 兼容：导出 RoomMiddleware 别名 = RoomPlugin（旧引用平滑迁移）。
 */

import fs from 'fs';
import path from 'path';
import { SyncSource } from '../sync_source.js';
import { createLogger } from '../../shared/logger.js';
import { ScenePlugin } from './scene_plugin.js';

// 观测式策略默认参数（关注词/静默阈值可被 observe_status.json 运行时文件覆盖；观测间隔走动态退避常量）
const OBSERVE_FIXED_SILENT_RETRIES = 2;   // 固定阈值：连续不发言几次后放弃（不可配，agent 与人均无法改）
const OBSERVE_MAX_KEYWORDS = 7;
const OBSERVE_STATUS_FILE = 'observe_status.json';   // 关注词运行时文件（= runContext.dataDir/observe_status.json）
// 观测间隔动态退避区间：初始=MIN；每次 Skip→×2 封顶 MAX；每次 Speak→恢复 MIN；沉默不变。常量、不落盘、重启回 MIN。
const OBSERVE_MIN_WINDOW = 10, OBSERVE_MAX_WINDOW = 600;

/** 观测式"不发言"提醒文案（与 @ 式 Speak.missingReminder 区分：观测式允许不发言）。
 *  总返回文案——何时放弃由 onAssistantContent 按 silentRetries 阈值决定，不在此函数内判。 */
function _observeSilentReminder() {
  return `<system-reminder>\n你刚才只输出了文本没调 Speak 也没调 Skip。观测式下你可以：调用 Speak 发言让大家看到，或调用 Skip 主动放弃本轮。请现在选择其一。\n</system-reminder>`;
}

export class RoomPlugin extends ScenePlugin {
  /**
   * @param {object} agent - Agent 实例（读 runContext / toolManager / messageManager / 操 _speakAttempts）
   */
  constructor(agent) {
    super(agent);
    // 花名册映射 + seq 去重 + roster 前缀
    this._agentNames = new Map();
    this._processedSeqs = new Set();
    this._rosterPrefix = '';
    // prompt 一次性注入标记
    this._roomPromptInjected = false;
    // Speak 门控计数（从原 agent._speakAttempts 迁入此实例）
    this._speakAttempts = 0;
    this._roomLogger = null;
    // —— 观测式策略状态 ——
    // _currentTrigger：本次 flush 的触发来源 'mention' | 'observe'（决定 Speak 门控阈值）
    this._currentTrigger = null;
    // _lastFlushAt：上次 reasoning 结束时刻（ms），观测窗口起算点
    this._lastFlushAt = Date.now();
    // _observeTimer：观测窗口到期定时器
    this._observeTimer = null;
    this._disposed = false;
    // _observeIntervalSec：当前生效观测间隔（秒，动态退避）。进群=MIN；Skip→×2 封顶 MAX；Speak→MIN；沉默不变。不落盘。
    this._observeIntervalSec = OBSERVE_MIN_WINDOW;
  }

  _logger() {
    if (this._roomLogger) return this._roomLogger;
    const runKey = this.runContext?.runKey;
    this._roomLogger = runKey ? createLogger('room-agent', `agent-${runKey.replace(/\//g, '-')}.log`) : null;
    return this._roomLogger;
  }

  /**
   * 确保状态字段就绪 + 建 syncSource（room 版）。
   */
  ensureState() {
    if (!Array.isArray(this._buffer)) {
      this._buffer = [];
      this._bufferHasMention = false;
      this._replying = false;
    }
    if (!this._agentNames) this._agentNames = new Map();
    if (!this._processedSeqs) this._processedSeqs = new Set();
    if (typeof this._rosterPrefix !== 'string') this._rosterPrefix = '';
    if (!Array.isArray(this._pendingBuffer)) this._pendingBuffer = [];
    if (typeof this._pendingHasMention === 'undefined' || this._pendingHasMention === null) {
      this._pendingHasMention = false;
    }
    // sync 源（room 版）：dataDir 在 room 模式 fail-fast 保证非空。onGapMessage 做 buffer 消费。
    if (!this.syncSource && this.runContext?.dataDir) {
      const rc = this.runContext;
      const syncSourceUrl = rc.roomBusUrl ? `${rc.roomBusUrl}/sync-history` : null;
      this._agent.syncSource = new SyncSource({
        dataDir: rc.dataDir,
        syncSourceUrl,
        agentId: rc.agentId,
        urlIncludesAgentId: false,
        onGapMessage: (msg, { fromSeq, toSeq }) => this._consumeGapMessage(msg),
        logger: this._logger() || createLogger('room-sync', `agent-${rc.runKey?.replace(/\//g, '-')}.log`),
      });
    }
  }

  /** Room 补洞消息消费：自消息过滤 + seq 去重 + parse + push buffer + mention 追踪。 */
  _consumeGapMessage(msg) {
    const myName = this.runContext?.memberName;
    const myId = this.runContext?.agentId;
    if (msg.speaker && (msg.speaker === myName || (myId && msg.speaker === myId))) return;
    if (this._processedSeqs.has(msg.seq)) return;
    const { text, mentionedMe } = this._parse({
      from: msg.speaker,
      content: msg.content,
      mentions: msg.mentions || [],
      ts: msg.ts,
    });
    if (text) {
      this._buffer.push(text);
      this._processedSeqs.add(msg.seq);
    }
    if (mentionedMe) this._bufferHasMention = true;
  }

  async _refreshRoster() {
    const rc = this.runContext;
    if (!rc || rc.mode !== 'room' || !rc.roomBusUrl) return;
    try {
      const resp = await fetch(rc.roomBusUrl);
      if (!resp.ok) return;
      const room = await resp.json();
      this._rosterPrefix = this._formatRoster(room?.members, room?.userName, room?.userUid, room?.name);
      if (Array.isArray(room?.members)) {
        for (const m of room.members) {
          if (m?.agentId && m.name) {
            this._agentNames.set(m.agentId, m.name);
            this._agentNames.set(m.name, m.name);
          }
        }
      }
      if (room?.userUid && room?.userName) {
        this._agentNames.set(room.userUid, room.userName);
        this._agentNames.set(room.userName, room.userName);
      }
    } catch (err) { /* 不阻断 */ }
    // roster 刷新后保证 observe_status.json 存在 + 名字底料（改名热同步）
    this._ensureObserveStatus();
  }

  _formatRoster(members, userName, userUid, roomName) {
    const lines = [];
    if (Array.isArray(members)) {
      for (const m of members) {
        if (!m?.name) continue;
        lines.push(`- ${m.name}`);
      }
    }
    lines.push(`- ${userName || 'user'}`);
    // 群名缓存（动态段最开头引用，改名热更新经 _refreshRoster 重设）
    this._roomName = roomName || '';
    // 静态部分（规则 + 成员）；群名引导句、当前时间、关键词/窗口由 _formatDynamicReminder 每轮动态拼
    this._rosterStatic = (
      `发言使用Speak工具，否则别人看不到你说的话。\n` +
      `@群员名字能使其回复你，别人@你你也需要回复别人。发言从简，200字以内，没必要不发言，Skip掉。\n` +
      `群成员：\n` +
      `${lines.join('\n')}\n`
    );
    return this._buildReminder();
  }

  /**
   * 动态部分：群名引导句（最开头）+ 当前关键词/观测窗口。
   * 当前时间不在 reminder 里——放聊天历史末尾（mergeForReason 产出 [当前时间] ...）。
   * 每轮 assemble 现算（关键词/窗口经 SetObserveConfig 改了立即反映）。
   */
  _formatDynamicReminder() {
    let s = `你正在一个多人聊天群「${this._roomName || ''}」中。以上所有历史消息都是群聊中的公开对话，来自本群成员或你的发言。\n`;
    // 观测式策略才暴露关键词/窗口
    if (this._interactionStrategy() !== 'mention') {
      const { focusKeywords } = this.getObserveConfig();
      // 显示的是纯关注词（不含名字）；名字触发是隐式的——别人@你或直呼你名字你也要回复
      s += `你当前最关注的关键词：[${(focusKeywords || []).join(', ')}]（群里有人聊到其中任何一个，或别人@你、直呼你名字，你都会被触发发言）\n`;
      s += `用 SetObserveConfig 工具写下你当前最关注的关键词（最多 ${OBSERVE_MAX_KEYWORDS} 个，整体覆盖，不是增删）。\n`;
    }
    return s;
  }

  /** 组装完整 <system_reminder>：动态段（群名引导+时间+关键词/窗口）+ 静态段（规则+成员）。 */
  _buildReminder() {
    return `<system_reminder>\n` + this._formatDynamicReminder() + (this._rosterStatic || '') + `</system_reminder>\n`;
  }

  _ensureRoomPrompt() {
    // 注入器注册：向 agent 的 PromptAssembler 注册
    //   roster（含群聊规则 + 成员列表 + 当前时间 + 当前关键词）作为最近 user message 的 prefix 注入。
    //   provider 每轮 assemble 现调 _buildReminder()：当前时间/关键词热更新（SetObserveConfig 改词即时反映）。
    //   群聊规则不单独追加到 system prompt。
    if (this._roomPromptInjected) return;
    this._roomPromptInjected = true;
    const asm = this._agent?.promptAssembler;
    if (!asm) return;
    asm.useWrapLastUser(() => {
      const reminder = this._rosterStatic != null ? this._buildReminder() : (this._rosterPrefix || '');
      return reminder ? { prefix: reminder } : null;
    }, { order: 50, name: 'roster' });
  }

  /** 同步缺失历史（seed cursor）。 */
  async syncMissingHistory() {
    this.ensureState();
    await this._refreshRoster();
    await this.syncSource?.seed();
    const cursor = this.syncSource?.getCursor();
    this._logger()?.info(`syncMissingHistory 完成 cursor=${cursor}`);
  }

  // ============================================================
  // 观测式策略：配置读取 + 关键词检测 + 触发判定
  // ============================================================

  /** 交互策略：'mention'（默认）| 'observe' | 'both'。热更新现读。 */
  _interactionStrategy() {
    const cfg = this._agent?.config?.get?.('interaction');
    const s = cfg?.strategy;
    return s === 'observe' || s === 'both' ? s : 'mention';
  }

  /** 观测参数：observe_status.json 为唯一关注词来源；silentRetries 固定。
   *  名字不存进文件——读取时由 _effectiveKeywords 把当前显示名并入匹配列表（observe 策略下
   *    别人直呼你名字也能触发你），但名字不占关注词名额、不在 reminder 的关键词列表里展示。
   *  观测间隔不在此返回——它是 _observeIntervalSec 动态退避值（Skip×2 / Speak 复位），非配置项。 */
  getObserveConfig() {
    const fileCfg = this._readObserveStatusFile();
    const focus = Array.isArray(fileCfg.keywords) ? fileCfg.keywords : [];
    return {
      keywords: this._effectiveKeywords(focus),           // 匹配用：[名字, ...focus] 去重
      focusKeywords: focus,                                // 纯关注词（agent 写下的，≤上限，不含名字）
      silentRetries: OBSERVE_FIXED_SILENT_RETRIES,
    };
  }

  /** 有效匹配关键词：当前显示名置顶 + 关注词去重追加。名字不占关注词名额。 */
  _effectiveKeywords(focus) {
    const cleaned = (Array.isArray(focus) ? focus : [])
      .map(k => (typeof k === 'string' ? k.trim() : String(k ?? '').trim()))
      .filter(k => k.length > 0);
    const name = this._currentDisplayName();
    const seen = new Set();
    const out = [];
    if (name) { out.push(name); seen.add(name); }
    for (const k of cleaned) {
      if (seen.has(k)) continue;
      out.push(k); seen.add(k);
    }
    return out;
  }

  /** 读 dataDir/observe_status.json；失败/不存在返回 {}。 */
  _readObserveStatusFile() {
    const dir = this.runContext?.dataDir;
    if (!dir) return {};
    try {
      const fp = path.join(dir, OBSERVE_STATUS_FILE);
      if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8')) || {};
    } catch (e) { /* 容错 */ }
    return {};
  }

  /** 当前显示名：优先 _agentNames（_refreshRoster 后填），回退 memberName，再 agentId。
   *  与群消息前缀一致，保证"别人提到我名字"能命中。 */
  _currentDisplayName() {
    const aid = this.runContext?.agentId;
    return (aid && this._agentNames?.get(aid)) || this.runContext?.memberName || aid || null;
  }

  /**
   * 保证 observe_status.json 存在且有关键词字段。_refreshRoster 后调。
   * 文件存的是纯关注词（不含名字——名字在读取时由 _effectiveKeywords 并入匹配列表，不占名额，
   *   改名时无需回写文件）。文件不存在或无 keywords 字段时，用 config 种子词初始化（截断到上限）。
   * 其他字段信任文件（文件是唯一来源）。
   */
  _ensureObserveStatus() {
    if (this._interactionStrategy() === 'mention') return;
    const dir = this.runContext?.dataDir;
    if (!dir) return;
    const fp = path.join(dir, OBSERVE_STATUS_FILE);
    let cfg = this._readObserveStatusFile();
    let changed = false;
    if (!Array.isArray(cfg.keywords)) {
      const seed = (this._agent?.config?.get?.('interaction') || {}).observe?.keywords || [];
      cfg.keywords = (Array.isArray(seed) ? seed : [])
        .map(k => (typeof k === 'string' ? k.trim() : String(k ?? '').trim()))
        .filter(k => k.length > 0)
        .slice(0, OBSERVE_MAX_KEYWORDS);
      changed = true;
    }
    if (changed) {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fp, JSON.stringify(cfg, null, 2), 'utf-8'); }
      catch (e) { this._logger()?.warn?.(`_ensureObserveStatus 写文件失败: ${e.message}`); }
    }
  }

  /**
   * 写 observe_status.json（SetObserveConfig 工具调，也可内部调）。
   * 关注词纯覆盖、截断到 OBSERVE_MAX_KEYWORDS（不含名字——名字读取时并入，不占名额）。
   * 仅关注词落盘；观测间隔是内存退避值（_observeIntervalSec），不在此写。
   * @param {object} updates - { keywords?: string[](整体替换) }
   * @returns {{cfg:object, warnings:string[]}}
   */
  writeObserveStatus(updates = {}) {
    const dir = this.runContext?.dataDir;
    const warnings = [];
    if (!dir) return { cfg: {}, warnings: ['无 dataDir'] };
    const fp = path.join(dir, OBSERVE_STATUS_FILE);
    let cur = this._readObserveStatusFile();
    delete cur.silentRetries;   // 历史残留清除（不可配）
    if (Array.isArray(updates.keywords)) {
      const cleaned = updates.keywords
        .map(k => (typeof k === 'string' ? k.trim() : String(k ?? '').trim()))
        .filter(k => k.length > 0);
      let focus = cleaned;
      if (cleaned.length > OBSERVE_MAX_KEYWORDS) { focus = cleaned.slice(0, OBSERVE_MAX_KEYWORDS); warnings.push(`关注关键词超过 ${OBSERVE_MAX_KEYWORDS} 个上限，已截断`); }
      cur.keywords = focus;
    }
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fp, JSON.stringify(cur, null, 2), 'utf-8'); }
    catch (e) { return { cfg: cur, warnings: [`写入失败: ${e.message}`] }; }
    this.onObserveConfigChanged();
    return { cfg: cur, warnings };
  }

  /** 单条文本是否命中任一关键词（子串 includes 或 /pattern/flags 正则）。 */
  _matchesKeyword(text, keywords) {
    if (!text || !keywords?.length) return false;
    for (const k of keywords) {
      if (k.startsWith('/') && k.lastIndexOf('/') > 0) {
        // /pattern/flags 形式
        const lastSlash = k.lastIndexOf('/');
        const pattern = k.slice(1, lastSlash);
        const flags = k.slice(lastSlash + 1);
        try { if (new RegExp(pattern, flags).test(text)) return true; } catch (e) { /* 坏正则降级子串 */ }
      }
      if (text.includes(k)) return true;
    }
    return false;
  }

  /** buffer 中是否存在命中关键词的未读消息。 */
  _bufferHasKeyword() {
    const { keywords } = this.getObserveConfig();
    if (!keywords?.length) return false;
    return this._buffer.some(text => this._matchesKeyword(text, keywords));
  }

  /** 即时触发判定（flushNow / 循环继续用）：按策略。 */
  _shouldTrigger() {
    const s = this._interactionStrategy();
    if (s === 'mention') return this._bufferHasMention;
    if (s === 'observe') return this._bufferHasKeyword();
    // both：mention 优先（强门控），否则 keyword
    return this._bufferHasMention || this._bufferHasKeyword();
  }

  /** 窗口到期巡视触发复核：窗口到期 ∧ 非回复中。不看 buffer（空 buffer 也触发，agent 巡视后可 Skip/主动 Speak）。
   *  到期判定用动态退避间隔 _observeIntervalSec（非配置窗口）。 */
  shouldFlushObserve() {
    if (this._replying) return false;
    return Date.now() >= (this._lastFlushAt || 0) + this._observeIntervalSec * 1000;
  }

  /** flush 触发：mention 命中走强门控；观测（keyword/窗口）走弱门控。 */
  shouldFlush() { return this._shouldTrigger(); }

  /** 标记本次 flush 触发来源（由 preReceive 即时触发 / triggerRoomFlush 窗口触发设置）。 */
  setCurrentTrigger(t) { this._currentTrigger = t; }

  /** 本次 flush 触发来源（门控阈值用）。默认 mention（向后兼容）。 */
  _currentTriggerKind() {
    return this._currentTrigger === 'observe' ? 'observe' : 'mention';
  }

  // ============================================================
  // 观测式：定时器 + 心跳 + 自驱动触发
  // ============================================================

  /** 武装观测窗口定时器：到期回调 _onObserveDue。反复调用先清旧 timer。用动态退避间隔 _observeIntervalSec。 */
  _armObserveTimer() {
    if (this._disposed) return;
    if (this._interactionStrategy() === 'mention') return;   // mention 策略不起 timer
    this._clearObserveTimer();
    const dueAt = (this._lastFlushAt || Date.now()) + this._observeIntervalSec * 1000;
    const delay = Math.max(0, dueAt - Date.now());
    this._observeTimer = setTimeout(() => this._onObserveDue(), delay);
    if (typeof this._observeTimer.unref === 'function') this._observeTimer.unref();
  }

  /** 清当前观测定时器。即时触发/重 arm 前调，防旧窗口幽灵 fire。 */
  _clearObserveTimer() {
    if (this._observeTimer) { clearTimeout(this._observeTimer); this._observeTimer = null; }
  }

  /** 观测窗口到期：复核 → 自驱动 flush（走 agent.triggerRoomFlush）。空 buffer 也触发。 */
  _onObserveDue() {
    const log = this._logger();
    const aid = this.runContext?.agentId;
    if (this._disposed) { log?.info(`RoomPlugin.observe [${aid}] 窗口到期复核: disposed，跳过`); return; }
    if (this._replying) { log?.info(`RoomPlugin.observe [${aid}] 窗口到期复核: 正在回复中，跳过`); return; }
    if (!this.shouldFlushObserve()) {
      const remainMs = Math.max(0, (this._lastFlushAt || 0) + this._observeIntervalSec * 1000 - Date.now());
      log?.info(`RoomPlugin.observe [${aid}] 窗口到期复核: 未到期 (窗口剩余=${Math.ceil(remainMs/1000)}s)`);
      return;
    }
    log?.info(`RoomPlugin.observe [${aid}] ✅ 窗口到期触发 reasoning (buffer=${this._buffer.length})`);
    this._agent?.triggerRoomFlush?.('observe');
  }

  /** SetObserveConfig 工具写配置后调：重 arm timer（窗口可能变了）。 */
  onObserveConfigChanged() {
    this._armObserveTimer();
  }

  /** flush 循环结束后由 _runFlushLoop 调：重置窗口起算点 + 重 arm timer + 清 trigger。 */
  onFlushDone() {
    this._lastFlushAt = Date.now();
    this._armObserveTimer();
  }

  /** 销毁：清 timer，防幽灵回调。clearRoom/stopReplica/reloadFromDisk/clearRoom 调。 */
  dispose() {
    this._disposed = true;
    if (this._observeTimer) { clearTimeout(this._observeTimer); this._observeTimer = null; }
  }

  /** pending drain 时的自消息过滤（群聊：from===memberName/agentId）。 */
  _isSelf(payload) {
    const myName = this.runContext?.memberName;
    const myId = this.runContext?.agentId;
    return !!(payload?.from && (payload.from === myName || (myId && payload.from === myId)));
  }

  /** parse：解析 payload 为带前缀文本 + mentionedMe。每条消息格式：name(你)? [本地时间 MMDD hh:mm]: 内容 */
  _parse(payload) {
    const { from, content, mentions } = payload || {};
    const displayName = (from && this._agentNames.has(from)) ? this._agentNames.get(from) : from;
    if (from && !this._agentNames.has(from)) {
      this._logger()?.info(`_parse: from="${from}" 未在 _agentNames 中找到映射，将直接使用 from 作为前缀。`);
    }
    const isSelf = this._isSelf({ from });
    const ts = payload?.ts;
    let text;
    if (Array.isArray(payload.contents)) {
      const filtered = payload.contents.filter(c => c != null && String(c).trim());
      if (filtered.length === 0) return { text: null, mentionedMe: false };
      text = filtered.map(c => this._formatEntry(displayName, String(c), isSelf, ts)).join('\n');
    } else {
      const textContent = (content == null) ? '' : String(content);
      if (!textContent.trim()) return { text: null, mentionedMe: false };
      text = this._formatEntry(displayName, textContent, isSelf, ts);
    }
    const list = mentions instanceof Set ? [...mentions] : (Array.isArray(mentions) ? mentions : []);
    const mentionedMe = !!(this.runContext?.agentId && list.includes(this.runContext.agentId));
    return { text, mentionedMe };
  }

  /**
   * 格式化时间为本地 MMDD hh:mm。
   * ts 缺失/非法时用当前时间（实时 /observe 未带 ts 或测试直调场景兜底）。
   */
  _formatTs(ts) {
    let d;
    try { d = ts ? new Date(ts) : new Date(); } catch (e) { d = new Date(); }
    if (isNaN(d.getTime())) d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /**
   * 格式化单条消息：name(你)? [本地时间 MMDD hh:mm]: 内容
   * 自己发言时 name 后加 (你)。
   */
  _formatEntry(displayName, content, isSelf, ts) {
    const name = isSelf ? `${displayName || '你'}(你)` : (displayName || '未知');
    return `${name} [${this._formatTs(ts)}]: ${content}`;
  }

  /**
   * flush 循环每轮取合并文本：以 [聊天历史] 开头，条目间用 --- 分割，末尾附 [当前时间]。
   * 空 buffer（窗口到期巡视、无未读）也产出——保证 reasoning 仍跑一次（agent 可 Skip/主动 Speak）。
   * 清 buffer + mention 标记。每条 buffer 项已由 _parse 格式化为 `name [time]: 内容`。
   */
  mergeForReason() {
    const body = this._buffer.length > 0
      ? this._buffer.join('\n --- \n') + '\n --- \n'
      : '';
    const merged = `[聊天历史]\n --- \n${body}[当前时间] ${this._formatTs()}`;
    this._buffer = [];
    this._bufferHasMention = false;
    return merged;
  }

  // ============================================================
  // receive 编排门控点（阶段 5b）：基类 receive 接管 buffer 编排 + flush 循环，
  // 通过下列门控点回调本 middleware。状态（buffer/pending/mention/processedSeqs/replying）仍在
  // 本实例，门控点返回值只携带"基类要做什么"（drop/pending/buffer/flush）。逐字复刻 handleReceive 逻辑。
  // ============================================================

  /**
   * 注入型点 onRoomEnter：进 room 路径一次性初始化（注入 room prompt + 确保状态字段就绪）。
   * 基类 receive 的 room 分支入口调一次。替代 handleReceive 开头的 _ensureRoomPrompt + ensureState。
   */
  async onRoomEnter() {
    this._ensureRoomPrompt();
    this.ensureState();
    // clearRoom/reloadRoom 的 dispose 会置 _disposed=true；进房消息复活（重 arm timer）
    this._disposed = false;
    // 观测式策略：进群设窗口起算点 + 间隔复位到最小值 + 起 timer
    if (this._interactionStrategy() !== 'mention') {
      this._observeIntervalSec = OBSERVE_MIN_WINDOW;
      this._lastFlushAt = Date.now();
      this._armObserveTimer();
    }
  }

  /**
   * 门控点 preReceive：每条 chat 消息。做完全部前置副作用（自消息过滤、roster、align、seq 去重、
   * parse、replying 判定、入 buffer/pending、mention 累积），返回决策对象让基类分派。
   *
   * @param {*} acc - 前序累积（first-action-wins：首个非 null 决策生效）
   * @param {object} payload - 消息 { from, content, mentions, seq, role:'chat', contents? }
   * @returns {{action:'drop'|'pending'|'buffer', seq?, flushNow?:boolean}|null}
   *   null=放行基类默认（私聊）；drop=自消息/已处理 seq；pending=replying 中已入 pending；
   *   buffer=已入 buffer，flushNow 决定是否立即进 flush 循环
   */
  async preReceive(acc, payload) {
    const label = `RoomPlugin.preReceive [${this.runContext?.agentId}]`;
    const log = this._logger();
    const seq = payload?.seq;

    // 0. 自消息过滤
    const myName = this.runContext?.memberName;
    const myId = this.runContext?.agentId;
    if (payload.from && (payload.from === myName || (myId && payload.from === myId))) {
      log?.info(`${label}: 自消息 from=${payload.from} 跳过`);
      return { action: 'drop', seq };
    }

    // 1. 刷新花名册（必须在 align 之前，确保 fillGap 能用正确的名字映射）
    await this._refreshRoster();

    // 2. 对齐 seq：缺失消息从 gateway 补进 buffer（经 onGapMessage/_consumeGapMessage）
    await this.syncSource?.align(seq);

    // 3. 已由 fillGap 处理过的 seq 跳过（防 /observe 与 fillGap 双重投递）
    if (seq != null && this._processedSeqs.has(seq)) {
      log?.info(`${label}: seq=${seq} 已由 fillGap 处理过，跳过`);
      return { action: 'drop', seq };
    }

    // 4. parse
    const { text, mentionedMe } = this._parse(payload);

    // 5. reasoning 进行中 → 入 pending，等 reasoning 结束后 flush
    if (this._replying) {
      if (text) {
        this._pendingBuffer.push({ text, payload });
        if (seq != null) this._processedSeqs.add(seq);
      }
      if (mentionedMe) this._pendingHasMention = true;
      log?.info(`${label}: _replying=true，消息入 pending (mentionedMe=${mentionedMe} total=${this._pendingBuffer.length})`);
      return { action: 'pending', seq };
    }

    // 6. 当前消息进 buffer
    if (text) {
      this._buffer.push(text);
      if (seq != null) this._processedSeqs.add(seq);
    }
    if (mentionedMe) this._bufferHasMention = true;
    log?.info(`${label}: push buffer后 buffer长度=${this._buffer.length} bufferHasMention=${this._bufferHasMention} hasKeyword=${this._bufferHasKeyword()}`);

    // 7. flush 判定：mention→@命中；observe→keyword命中；both→mention优先(@强门控)否则keyword
    const strategy = this._interactionStrategy();
    const hasKw = this._bufferHasKeyword();
    const triggered = this._shouldTrigger();
    if (triggered) {
      // 触发来源：mentionedMe='mention'(强门控)；否则 keyword='observe'(弱门控)
      this._currentTrigger = this._bufferHasMention ? 'mention' : 'observe';
      // 关键词/@ 命中即时触发：结束当前观测窗口定时（本次触发已消费 buffer，旧窗口巡视作废），
      //   回复完毕 onFlushDone 会从此刻重算 _lastFlushAt + 重 arm 下一轮窗口。
      this._clearObserveTimer();
      log?.info(`${label}: ✅ 即时触发 trigger=${this._currentTrigger} (strategy=${strategy} mentionedMe=${mentionedMe} hasKeyword=${hasKw}) 已清观测定时，待回复完毕重 arm`);
    } else {
      // 未触发：打清原因，便于诊断"为什么没回"
      const { keywords } = this.getObserveConfig();
      const remainMs = Math.max(0, (this._lastFlushAt || 0) + this._observeIntervalSec * 1000 - Date.now());
      log?.info(`${label}: ⏸ 未触发 (strategy=${strategy} mentionedMe=${mentionedMe} hasKeyword=${hasKw} keywords=[${(keywords||[]).join(',')}] buffer=${this._buffer.length} 窗口剩余=${Math.ceil(remainMs/1000)}s)`);
    }
    return { action: 'buffer', seq, flushNow: triggered };
  }

  // ============================================================
  // reasoning 门控点（基类 reasoning 经 _dispatchGate 调）—— 阶段 4 RoomGateAdapter 并入
  // ============================================================

  /**
   * 注入型点 preReason：每轮 LLM 前执行。承担 Room 的每轮初始化——重置 Speak 门控计数。
   * 替换原基类 reasoning 入口的 _speakAttempts=0（该计数已迁入本实例）。
   * 阶段 5b 起也可在此做 roster 刷新/prompt 前缀注入；当前仅 reset。
   * @param {MessageManager} mm - 透传，本实现不用
   */
  async preReason(mm) {
    this._speakAttempts = 0;
  }

  /**
   * 工具批次执行后是否结束本轮 loop。OR 合并语义。
   * @returns {boolean|null} room+含Speak→true；null=放行（基类默认 continue）
   */
  shouldBreakAfterTools(acc, toolCallsResult) {
    if (this.runContext?.mode !== 'room') return null;
    if (!Array.isArray(toolCallsResult)) return null;
    const names = toolCallsResult.map(tc => tc.function?.name).filter(Boolean);
    const hasSpeak = names.includes('Speak');
    const hasSkip = names.includes('Skip');
    // Speak 或 Skip 命中 → 结束本轮（Skip 为观测式主动放弃）
    if (hasSpeak || hasSkip) {
      // 观测间隔动态退避（仅 observe/both 有定时器，mention 无影响；不在提示词里反映）：
      //   Speak→立即恢复最小值；Skip→×2 封顶 MAX；同批两者都有以 Speak 为准（恢复）。沉默不调工具→不变。
      if (this._interactionStrategy() !== 'mention') {
        this._observeIntervalSec = hasSpeak
          ? OBSERVE_MIN_WINDOW
          : Math.min(this._observeIntervalSec * 2, OBSERVE_MAX_WINDOW);
      }
      return true;
    }
    return null;
  }

  /**
   * LLM 吐纯文本未调工具时的门控。merge 合并语义。
   * 阈值按本次触发来源：mention→1（被@必须回）；observe→silentRetries（默认2，宽松）。
   * @returns {{break:boolean, injectReminder?:string}|null}
   *   null=放行（基类默认 break）；{break:false,injectReminder}=注入提醒再试；{break:true}=放弃
   */
  onAssistantContent(acc, fullContent) {
    if (this.runContext?.mode !== 'room') return null;
    const trigger = this._currentTriggerKind();
    const { silentRetries } = this.getObserveConfig();
    const threshold = trigger === 'observe' ? silentRetries : 1;

    const attempts = this._speakAttempts || 0;
    this._speakAttempts = attempts + 1;   // 先记（对齐旧逻辑：break 前也累计，供测试断言）
    if (attempts >= threshold) return { break: true };   // 超阈值放弃

    // 提醒文案：observe 用观测式（允许 Skip）；mention 用 Speak.missingReminder
    if (trigger === 'observe') {
      const reminder = _observeSilentReminder();
      if (reminder) return { break: false, injectReminder: reminder };
      return { break: true };
    }
    const Speak = this.toolManager && typeof this.toolManager.get === 'function'
      ? this.toolManager.get('Speak') : null;
    if (!Speak || typeof Speak.missingReminder !== 'function') return { break: true };
    const reminder = Speak.missingReminder(attempts);
    if (reminder) return { break: false, injectReminder: reminder };
    return { break: true };
  }

  /** reasoning 入口重置 Speak 门控计数（替换原基类入口的 _speakAttempts=0；阶段 5b 落到 preReason）。 */
  resetSpeakAttempts() {
    this._speakAttempts = 0;
  }
}

/** 兼容旧引用（旧文件名/类名 room_middleware.js::RoomMiddleware）平滑迁移到 RoomPlugin。 */
export const RoomMiddleware = RoomPlugin;