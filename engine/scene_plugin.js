/**
 * ScenePlugin —— 场景插件基类（v3 阶段三：万物皆 Room）
 *
 * 设计见 docs/agent-v3-design.md §四。每个 room 恰好一个 ScenePlugin，是本 room 行为的主权 owner：
 *   持 buffer 状态机、接管输出接线、给推理 gate 返回权威值。Agent 核心引擎只有推理能力，
 *   对外输出能力（流式 / Speak）全部由场景插件定义。
 *
 * 基类上升自原 RoomMiddleware 的通用 buffer 机器（私聊/群聊共享）：
 *   - 调度状态机：_buffer / _replying / _pendingBuffer（+ mention/flush 标记）
 *   - flushLoop / mergeForReason / postReason / _flushPending
 *   - preReceive 默认骨架（accept → replying?pending:buffer → flushNow=shouldFlush()）
 *   - reasoning gate 默认 no-op
 *
 * 子类 override 差异点：
 *   - accept(payload) → {text, flushTrigger} 或 null(drop)   [私聊/群聊各自的解析+过滤]
 *   - shouldFlush() → bool                                    [私聊 !replying / 群聊 bufferHasMention]
 *   - wireOutput()                                             [私聊流式接线 / 群聊注册 Speak]
 *   - 群聊额外：_isSelf / _parse / _consumeGapMessage / roster / seq 去重 / Speak 门控
 *
 * 字段名沿用旧 RoomMiddleware（_buffer/_bufferHasMention/_replying/_pendingBuffer/_pendingHasMention）
 *   以兼容现有测试与 /clear 的 middlewares.find(m=>m._buffer) 查找。
 */
import { createLogger } from '../shared/logger.js';

export class ScenePlugin {
  /**
   * @param {object} agent - Agent 实例（读 runContext/messageManager/toolManager/syncSource）
   */
  constructor(agent) {
    this._agent = agent;
    // 调度状态机（共享）
    this._buffer = [];
    this._bufferHasMention = false;   // buffer 中是否存在 flush-triggering 消息（群聊=mention，私聊=恒后立即 flush）
    this._replying = false;
    this._pendingBuffer = [];          // reasoning 进行中累积的消息
    this._pendingHasMention = false;
  }

  get agent() { return this._agent; }
  get runContext() { return this._agent?.runContext; }
  get messageManager() { return this._agent?.messageManager; }
  get toolManager() { return this._agent?.toolManager; }
  get syncSource() { return this._agent?.syncSource; }

  // ---- abstract：子类实现 ----

  /**
   * 解析 payload，返回 {text, flushTrigger} 或 null(drop)。
   * 私聊：text=content, flushTrigger=true。
   * 群聊：text=`name: content`, flushTrigger=mentionedMe；自消息/已处理 seq → null。
   * @param {object} payload
   * @returns {Promise<{text?:string, flushTrigger?:boolean}|null>}
   */
  async accept(payload) { return null; }

  /** 当前是否该 flush。私聊 !replying；群聊 _bufferHasMention。 */
  shouldFlush() { return false; }

  /** 输出层接线：RoomState 建时调一次。私聊接管 emit 转发；群聊注册 Speak。 */
  wireOutput(_roomState) {}

  /**
   * run-level 工具裁剪门控：场景插件对本请求临时工具做审查/强制保留。
   * 默认透传；群聊可 override 强制保留 Speak（防请求方 disableTools 掉 Speak），
   * 私聊可 override 拒绝危险工具。返回过滤后的工具数组。
   */
  filterRunLevelTools(tools) { return tools; }

  /** pending drain 时判定某条消息是否自消息（群聊 override；私聊无自消息概念）。 */
  _isSelf(_payload) { return false; }

  // ---- 共享调度 ----

  _setReplying(v) { this._replying = v; }

  /**
   * preReceive 默认骨架（私聊用；群聊 override 整个 preReceive 以插入 roster/seq/gap 前置）。
   * accept → replying?pending:buffer → flushNow=shouldFlush()。
   * @returns {{action:'drop'|'pending'|'buffer', seq?, flushNow?:boolean}|null}
   */
  async preReceive(acc, payload) {
    const accepted = await this.accept(payload);
    if (accepted === null) return { action: 'drop', seq: payload?.seq };
    const seq = payload?.seq ?? null;
    if (this._replying) {
      if (accepted.text) this._pendingBuffer.push({ text: accepted.text, payload });
      if (accepted.flushTrigger) this._pendingHasMention = true;
      return { action: 'pending', seq };
    }
    if (accepted.text) this._buffer.push(accepted.text);
    if (accepted.flushTrigger) this._bufferHasMention = true;
    return { action: 'buffer', seq, flushNow: this.shouldFlush() };
  }

  /** flushLoop 每轮取合并文本，清 buffer + mention 标记。first-wins 合并语义。 */
  mergeForReason() {
    const merged = this._buffer.join('\n');
    this._buffer = [];
    this._bufferHasMention = false;
    return merged;
  }

  /** reasoning 结束后把 pending 移入 buffer（自消息过滤），返回是否需要再 flush。 */
  async _flushPending(label) {
    if (!this._pendingBuffer || this._pendingBuffer.length === 0) return false;
    const pending = this._pendingBuffer;
    this._pendingBuffer = [];
    const hadMention = this._pendingHasMention;
    this._pendingHasMention = false;
    for (const item of pending) {
      if (this._isSelf(item.payload)) continue;
      if (item.text) this._buffer.push(item.text);
    }
    if (hadMention) this._bufferHasMention = true;
    return !this._replying && this._bufferHasMention;
  }

  /** flushLoop 每轮 reasoning 后：drain pending，返回是否再 flush 一轮。OR 合并语义。 */
  async postReason(acc) {
    await this._flushPending('postReason');
    const reflush = this._buffer.length > 0 && this.shouldFlush();
    return { reflush };
  }

  /**
   * flush 循环：每轮 merge→addUser→reasoning→postReason，while shouldFlush()。
   * done 语义：reasoning 内部正常完成已 emit done；只有"一轮都没跑（merged 空 break）"时
   *   才由本方法补一次 done，避免双 done（私聊原来只单 done，统一到此语义不回归）。
   */
  async flushLoop(emit) {
    const agent = this._agent;
    let ranReasoning = false;
    do {
      const merged = await agent._dispatchGate('mergeForReason', null);
      if (!merged || !merged.trim()) break;
      ranReasoning = true;
      this._setReplying(true);
      agent.messageManager.addUserMessage(merged);
      try {
        await agent.reasoning(null, { skipAddUser: true, emit });
      } finally {
        this._setReplying(false);
        await agent._dispatchGate('postReason', null);
      }
    } while (this._buffer.length > 0 && this.shouldFlush());
    if (!ranReasoning) agent.abortFlow.emitDone(emit);
  }

  // ---- reasoning gate 默认 no-op（私聊不复写；群聊 override）----

  /** 每轮 LLM 前注入。默认 no-op。 */
  async preReason(_mm) {}

  /** 工具批次后是否结束本轮。null=放行基类默认 continue。 */
  shouldBreakAfterTools(_acc, _toolCallsResult) { return null; }

  /**
   * LLM 吐纯文本未调工具时门控。null=放行（基类默认 break）。
   * @returns {{break:boolean, injectReminder?:string}|null}
   */
  onAssistantContent(_acc, _fullContent) { return null; }
}