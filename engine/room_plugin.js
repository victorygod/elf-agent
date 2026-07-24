/**
 * RoomPlugin —— 群聊场景插件（v3 阶段三：Room is Plugin）
 *
 * v0.2 愿景"Room is Plugin"的落点：原 RoomAgent（extends Agent 重载 receive）的调度行为
 * 收敛为本插件。v3 阶段三：继承 ScenePlugin，通用 buffer 机器（flushLoop/mergeForReason/
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

import { SyncSource } from './sync_source.js';
import { createLogger } from '../shared/logger.js';
import { ScenePlugin } from './scene_plugin.js';

const ROOM_BEHAVIOR_PROMPT = `【群聊模式】你正在一个多人聊天群中。规则：
- 你想说任何话让群里其他人/agent 看到,必须调用 Speak 工具(传完整 message)。
- 你直接输出的文本(content)只在你自己的思考里,群里没有人能看到——不调 Speak 就等于没说话。
- 只有被 @ 你时才需要回应;同样只有你@别人别人才会回应你。

以下是你的原始人设:`;

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
      this._rosterPrefix = this._formatRoster(room?.members, room?.userName, room?.userUid);
      const mm = this.messageManager;
      if (mm && 'roomRosterPrefix' in mm) mm.roomRosterPrefix = this._rosterPrefix;
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
  }

  _formatRoster(members, userName, userUid) {
    const lines = [];
    if (Array.isArray(members)) {
      for (const m of members) {
        if (!m?.agentId) continue;
        lines.push(`- ${m.agentId} / ${(m.name || m.agentId)}`);
      }
    }
    lines.push(`- ${userUid || 'default_userid'} / ${userName || 'user'}`);
    return (
      `<system-reminder>\n群成员：\n${lines.join('\n')}\n` +
      `可以用 @id 或 @名字 提及成员。只有别人被 @ 时才会回应你。\n</system-reminder>\n`
    );
  }

  _ensureRoomPrompt() {
    if (this._roomPromptInjected) return;
    this._roomPromptInjected = true;
    const mm = this.messageManager;
    if (mm && typeof mm.updateConfig === 'function') {
      mm.updateConfig({ systemPrompt: ROOM_BEHAVIOR_PROMPT + '\n' + (mm.systemPrompt || '') });
    }
    if (mm && 'prefixPrompt' in mm) {
      mm._roomMode = true;
    }
  }

  /** 同步缺失历史（seed cursor）。 */
  async syncMissingHistory() {
    this.ensureState();
    await this._refreshRoster();
    await this.syncSource?.seed();
    const cursor = this.syncSource?.getCursor();
    this._logger()?.info(`syncMissingHistory 完成 cursor=${cursor}`);
  }

  /** 群聊 mention 命中才 flush。 */
  shouldFlush() { return this._bufferHasMention; }

  /** pending drain 时的自消息过滤（群聊：from===memberName/agentId）。 */
  _isSelf(payload) {
    const myName = this.runContext?.memberName;
    const myId = this.runContext?.agentId;
    return !!(payload?.from && (payload.from === myName || (myId && payload.from === myId)));
  }

  /** parse：解析 payload 为带前缀文本 + mentionedMe。 */
  _parse(payload) {
    const { from, content, mentions } = payload || {};
    const displayName = (from && this._agentNames.has(from)) ? this._agentNames.get(from) : from;
    if (from && !this._agentNames.has(from)) {
      this._logger()?.info(`_parse: from="${from}" 未在 _agentNames 中找到映射，将直接使用 from 作为前缀。`);
    }
    let text;
    if (Array.isArray(payload.contents)) {
      const filtered = payload.contents.filter(c => c != null && String(c).trim());
      if (filtered.length === 0) return { text: null, mentionedMe: false };
      text = filtered.map(c => displayName ? `${displayName}: ${c}` : c).join('\n');
    } else {
      const textContent = (content == null) ? '' : String(content);
      if (!textContent.trim()) return { text: null, mentionedMe: false };
      text = textContent;
      if (displayName) text = `${displayName}: ${text}`;
    }
    const list = mentions instanceof Set ? [...mentions] : (Array.isArray(mentions) ? mentions : []);
    const mentionedMe = !!(this.runContext?.agentId && list.includes(this.runContext.agentId));
    return { text, mentionedMe };
  }

  // ============================================================
  // receive 编排门控点（阶段 5b）：基类 receive 接管 buffer 编排 + flushLoop，
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
  }

  /**
   * 门控点 preReceive：每条 chat 消息。做完全部前置副作用（自消息过滤、roster、align、seq 去重、
   * parse、replying 判定、入 buffer/pending、mention 累积），返回决策对象让基类分派。
   *
   * @param {*} acc - 前序累积（first-action-wins：首个非 null 决策生效）
   * @param {object} payload - 消息 { from, content, mentions, seq, role:'chat', contents? }
   * @returns {{action:'drop'|'pending'|'buffer', seq?, flushNow?:boolean}|null}
   *   null=放行基类默认（私聊）；drop=自消息/已处理 seq；pending=replying 中已入 pending；
   *   buffer=已入 buffer，flushNow 决定是否立即进 flushLoop
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
    log?.info(`${label}: push buffer后 buffer长度=${this._buffer.length} bufferHasMention=${this._bufferHasMention}`);

    // 7. flush 判定
    return { action: 'buffer', seq, flushNow: this._bufferHasMention };
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
    const hasSpeak = Array.isArray(toolCallsResult) &&
      toolCallsResult.some(tc => tc.function?.name === 'Speak');
    if (!hasSpeak) return null;
    return true;
  }

  /**
   * LLM 吐纯文本未调工具时的门控。merge 合并语义。
   * @returns {{break:boolean, injectReminder?:string}|null}
   *   null=放行（基类默认 break）；{break:false,injectReminder}=注入提醒再试；{break:true}=放弃
   */
  onAssistantContent(acc, fullContent) {
    if (this.runContext?.mode !== 'room') return null;
    const Speak = this.toolManager && typeof this.toolManager.get === 'function'
      ? this.toolManager.get('Speak') : null;
    if (!Speak) return null;
    if (typeof Speak.missingReminder !== 'function') return null;
    const attempts = this._speakAttempts || 0;
    const reminder = Speak.missingReminder(attempts);
    this._speakAttempts = attempts + 1;
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