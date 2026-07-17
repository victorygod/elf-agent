/**
 * RoomAgent —— 群聊副本 agent（累积 + 门控状态机）
 *
 * 设计见 docs/chat-room-design.md §3（入群装备化）、§4（intuitive 策略）、§12（review 真坑）。
 *
 * intuitive 策略（用户定的正确语义）：
 *   维护一个"待处理 buffer"（内存中,未进 context）。
 *   每收到一条非自消息 → 揉进 buffer + 标记 buffer 里是否有 @ 我。
 *   - 若当前不在回复：buffer 有 @ 我 → 把整段 buffer 合成一条 user 消息进 context + reasoning。
 *                       buffer 无 @ 我 → 只累积,等下一条。
 *   - 若当前在回复（reasoning）：只攒进 buffer,等回复完再判。
 *   reasoning 期间来的消息由 server /observe 队列排到回复后调 receive,进 buffer 循环。
 *
 * 与默认 Agent 的差异（仅 override receive + 加 buffer 状态,内核 reasoning/工具全复用）：
 * 1. 自消息过滤:from===本成员名 → done(防自激)。
 * 2. 累积进 buffer(非 context),触发时才合成一条 user 消息进 context。
 * 3. 被@才 reasoning。
 * 4. prefix/suffix 群聊过滤:_roomMode。
 */

import { Agent } from './default_agent.js';

/**
 * 群聊行为规则前缀(注入 systemPrompt,告诉 LLM 用 Speak 发言,content 不可见)。
 */
const ROOM_BEHAVIOR_PROMPT = `【群聊模式】你正在一个多人聊天群中。规则：
- 你想说任何话让群里其他人/agent 看到,必须调用 Speak 工具(传完整 message)。
- 你直接输出的文本(content)只在你自己的思考里,群里没有人能看到——不调 Speak 就等于没说话。
- 只有被 @ 你时才需要回应;没被 @ 就静静观察累积上下文,不要主动发言。
- 已为你注册 Speak 工具。

以下是你的原始人设:`;

export class RoomAgent extends Agent {
  constructor(params) {
    super(params);
    this._buffer = [];              // 待处理群消息片段(未进 context),字符串数组
    this._bufferHasMention = false; // buffer 里是否有 @ 本成员的消息
    this._replying = false;         // 是否正在 reasoning
  }

  /**
   * 惰性初始化 buffer 状态。
   * 副本经 start.js 用 Object.setPrototypeOf 升级成 RoomAgent(只改原型链,不跑构造器),
   * 故实例字段在首次 receive 时才保证存在(对齐 §11 坑7 包装而非替换)。
   */
  _ensureBufferState() {
    if (!Array.isArray(this._buffer)) {
      this._buffer = [];
      this._bufferHasMention = false;
      this._replying = false;
    }
    if (typeof this._rosterPrefix !== 'string') this._rosterPrefix = '';
  }

  /**
   * 拉取群成员花名册并渲染成动态 prefix（拼到最近一条 user 消息开头，不写记忆）。
   * 失败（room_bus 不通 / 网络异常）保留上次值，绝不阻断发言。
   * roster 形如：
   *   <system-reminder>群成员：- elf-001 / elf-001 ...- user / user 可以用 @id 或 @名字 提及成员。只有被 @ 你时才需要回应。</system-reminder>
   */
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
    } catch (err) {
      // 保留上次值，不阻断
    }
  }

  /**
   * 渲染 roster system-reminder 文本。members: [{agentId,name}], userName/userUid: 用户显示名/稳定身份
   * 不含在线状态、不以 @ 前缀成员；user 行渲染成 `- {uid} / {name}`（与 agent 行 `- agentId / name` 对称，
   * 问题3：身份用 uid/id、显示用 name）。
   */
  _formatRoster(members, userName, userUid) {
    const lines = [];
    if (Array.isArray(members)) {
      for (const m of members) {
        if (!m?.agentId) continue;
        const name = m.name || m.agentId;
        lines.push(`- ${m.agentId} / ${name}`);
      }
    }
    const uname = userName || 'user';
    const uid = userUid || 'default_userid';
    lines.push(`- ${uid} / ${uname}`);
    return (
      `<system-reminder>\n` +
      `群成员：\n` +
      `${lines.join('\n')}\n` +
      `可以用 @id 或 @名字 提及成员。只有被 @ 你时才需要回应。\n` +
      `</system-reminder>\n`
    );
  }

  _ensureRoomPrompt() {
    if (this._roomPromptInjected) return;
    this._roomPromptInjected = true;
    const mm = this.messageManager;
    if (mm && typeof mm.updateConfig === 'function') {
      const basePrompt = mm.systemPrompt || '';
      mm.updateConfig({
        systemPrompt: ROOM_BEHAVIOR_PROMPT + '\n' + basePrompt,
        // 群聊副本用较大的记忆上限,避免几条群消息就触发 compact
        // (私聊 config 的小 memoryTokenLimit 如 elf-001=500 不适合群聊;compact 会把
        //  "被@该发言"的明确指令压成摘要,导致 LLM 不再调 Speak 而退出 loop)。
        memoryTokenLimit: 40000,
      });
    }
    if (this.messageManager && 'prefixPrompt' in this.messageManager) {
      this.messageManager._roomMode = true;
    }
  }

  /** 把一条 payload 标准化成 {text, mentionedMe} */
  _normalizePayload(payload) {
    const { from, mentions, role } = payload || {};
    // 格式对齐 wolf: `name: 内容`(冒号空格),多条 join('\n')。
    let text;
    if (Array.isArray(payload.contents)) {
      // server 合并形态:contents 是字符串数组,每条前缀 from
      text = payload.contents.map(c => from ? `${from}: ${c}` : c).join('\n');
    } else {
      text = (payload.content == null) ? '' : String(payload.content);
      if (from) text = `${from}: ${text}`;
    }
    const mentionList = mentions instanceof Set ? [...mentions]
      : (Array.isArray(mentions) ? mentions : []);
    // 身份唯一标识用 agentId（问题3）：mentions 经 parseMentions 已归一到 agentId，
    // memberName 只是显示名、可改，不能拿来判"是否@我"，否则 name 改动会失配。
    const myId = this.runContext?.agentId;
    const mentionedMe = !!(myId && mentionList.includes(myId));
    return { text, mentionedMe };
  }

  async *receive(payload) {
    this._ensureRoomPrompt();
    this._ensureBufferState();   // setPrototypeOf 升级不跑构造器,惰性初始化 buffer

    // 兼容 string(私聊降级) 或非 chat role
    if (typeof payload === 'string' || (payload && payload.role && payload.role !== 'chat')) {
      yield* super.receive(typeof payload === 'string' ? payload : (payload.content || ''));
      return;
    }

    const rc = this.runContext;
    const myName = rc?.memberName;
    const myId = rc?.agentId;
    const { from } = payload || {};

    // 刷新群花名册(roster)动态 prefix：每条群消息进来刷一次,写回 mm.roomRosterPrefix,
    // 发往 LLM 时拼到最近一条 user 开头。失败不阻断(保留上次值)。
    await this._refreshRoster();

    // 自消息过滤:不被自己的发言触发(防 ping-pong 自激)。
    // 问题3：from 对成员自身发言是 memberName（Speak 工具回灌透传），对用户是用户名；
    // 兼容 memberName（现行）与未来按 agentId 透传两种形态，命中任一即丢弃。
    if (from && (from === myName || (myId && from === myId))) {
      yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
      return;
    }

    const { text, mentionedMe } = this._normalizePayload(payload);

    // 揉进 buffer
    if (text) this._buffer.push(text);
    if (mentionedMe) this._bufferHasMention = true;

    // 正在回复中 → 只攒,等回复完(server 会再把后续消息排过来)
    if (this._replying) {
      yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
      return;
    }

    // 非回复中:buffer 没 @ 我 → 继续等
    if (!this._bufferHasMention) {
      yield { event: 'done', data: { usage: { prompt_tokens: 0, completion_tokens: 0 } } };
      return;
    }

    // buffer 有 @ 我 → 合成一条 user 消息进 context,清 buffer,开始 reasoning
    const merged = this._buffer.join('\n');
    this._buffer = [];
    this._bufferHasMention = false;
    this._replying = true;
    this.messageManager.addUserMessage(merged);
    try {
      yield* this.reasoning(null, { skipAddUser: true });
    } finally {
      this._replying = false;
    }
  }
}