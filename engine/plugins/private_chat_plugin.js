/**
 * PrivateChatPlugin —— 私聊场景插件（v3 阶段三）
 *
 * 设计见 docs/agent-v3-design.md §四。继承 ScenePlugin，复用通用 buffer 机器；
 *   私聊差异点：accept(text=content, flushTrigger 恒 true)、shouldFlush=!_replying（空闲即 flush）。
 *
 * 统一关键（v3）：私聊不再走 action:'private' 特判直推 reasoning，而是与群聊一样走
 *   action:'buffer' + flush 循环。差异只在 flushNow = shouldFlush() = !_replying——
 *   一空闲就 flush，语义等价于前端"发一条屏蔽输入，等回复完再发"。
 *
 * sync（align/advance）：accept 内做 align；advance 由基类 receive 统一调（私聊/群聊一致）。
 *   addUserMessage 不在此做（flush 循环的 mergeForReason→addUserMessage 统一加，防双份）。
 *
 * 输出层（wireOutput）：私聊流式 emit token 经 agent→gateway 长连接转发到常驻 room SSE。
 *   该改造依赖 gateway 侧（步骤 5），本阶段留接口、emit 走基类透传（reasoning 直接 emit token，
 *   由 engine/server.js 当前 /chat 闭包写 res；gateway 改造后切转发模式）。
 *
 * reasoning gate：全 no-op（基类默认即可——shouldBreakAfterTools→null 继续，
 *   onAssistantContent→null 即把整段 content 当回复 break）。故本类不复写 reasoning gate。
 *
 * 兼容：导出 PrivateChatMiddleware 别名 = PrivateChatPlugin，沿用旧引用。
 */
import { SyncSource } from '../sync_source.js';
import { createLogger } from '../../shared/logger.js';
import { ScenePlugin } from './scene_plugin.js';

let logFileName = null;
export function setPrivateChatLogFileName(name) { logFileName = name; }

export class PrivateChatPlugin extends ScenePlugin {
  constructor(agent) {
    super(agent);
  }

  // 惰性建私聊 syncSource（原 PrivateChatMiddleware._ensureSyncSource）。dataDir 用 mm.dataDir。
  _ensureSyncSource() {
    if (this._agent.syncSource) return;
    const dataDir = this.messageManager?.dataDir || this.runContext?.dataDir;
    if (!dataDir) return;   // 无 dataDir → 不建，align 短路
    const agentId = this.runContext?.agentId;
    const roomId = this.runContext?.roomId;
    const gw = this._agent._gatewayUrl;
    // v3：私聊统一 /rooms/<rid>/sync-history/<agentId>（要求 runContext.roomId = chat-<agentId>，由 start.js 保证）。
    if (!roomId) {
      // 无 roomId（测试/异常构造）：不建 syncSource，align 短路（不发拉取）。
      this._agent.syncSource = null;
      return;
    }
    const syncSourceUrl = gw ? `${gw}/rooms/${roomId}/sync-history` : null;
    this._agent.syncSource = new SyncSource({
      dataDir,
      syncSourceUrl,
      agentId,
      urlIncludesAgentId: false,
      onGapMessage: (msg) => { this.messageManager.addUserMessage(msg.content); },
      logger: createLogger('private-sync', logFileName),
    });
  }

  /**
   * accept：私聊消息接入。align + 返回 {text:content, flushTrigger:true}。
   *   flushTrigger 恒 true → 空闲时 shouldFlush=!_replying 立即 flush。
   *   不做 addUserMessage（flush 循环 统一加）；advance 由 receive 统一调。
   */
  async accept(payload) {
    this._ensureSyncSource();
    await this._agent.syncSource?.align(payload.seq);
    const content = payload.content;
    const text = (content != null && String(content).trim()) ? String(content) : null;
    return { text, flushTrigger: true };
  }

  /** 空闲即 flush。 */
  shouldFlush() { return !this._replying; }
}

/** 兼容旧引用。 */
export const PrivateChatMiddleware = PrivateChatPlugin;