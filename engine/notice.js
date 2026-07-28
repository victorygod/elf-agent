/**
 * 与上文无关的统一上送通道：把「居中瞬态通知」（LLM 重试 / 最终失败 / 普通提示）发给前端。
 *
 * 两端各自封装：本模块封装后端「怎么发」，前端 Toast/useToast 封装「怎么渲染」。
 *   - 注意职责：本模块只送**结构化字段**，不编文案。文案由前端按字段拼（名字/agentId/attempt/错误）。
 *   - 通道按 runContext.mode 分流，不下沉到调用点：
 *       room → fetch(POST ${roomBusUrl}/notice) 直推房间广播（Speak 同款通道，不经网关 _onAgentEvent）
 *       私聊（private 或无 rc）→ ctx.emit({event:'notice'}) 走私聊既有转发（_onAgentEvent chat- 前缀）
 *   - 失败一律吞掉（notice 是"尽力而为"的 UI 提示，不能影响主流程/重试本身）。
 *
 * @param {{ emit?: Function, runContext?: object }|null} ctx   私聊走 ctx.emit（agent 透传）；rc 在 ctx.runContext
 * @param {{ kind:'retry'|'error'|'info', agentId:string, memberName?:string, attempt?:number, maxRetries?:number, error?:string, final?:boolean }} fields
 */
export function sendNotice(ctx, fields) {
  try {
    const rc = ctx?.runContext || null;
    if (rc && rc.mode === 'room' && rc.roomBusUrl) {
      // 群聊：直推房间总线，经 POST /rooms/:rid/notice → bc.broadcast('notice') 下发房间 SSE。
      const body = JSON.stringify({
        ...fields,
        roomId: rc.roomId,
        memberName: fields.memberName || rc.memberName || rc.agentId,
      });
      const u = `${rc.roomBusUrl}/notice`;
      fetch(u, {
        method: 'POST',
        // X-Speaker-Id 仅 ASCII 身份标识用 agentId（memberName 可能含中文，HTTP header 不接受非 ASCII）。
        headers: { 'Content-Type': 'application/json', 'X-Speaker-Id': rc.agentId },
        body,
        // 不传 signal：notice 不应被 abort 信号取消（即便用户中断，已发的重试提示仍可见）。
      }).catch(() => {});
      return;
    }
    // 私聊：走 emit（reasoning 同款 channel），经 _onAgentEvent chat- 前缀转发到私聊 SSE。
    const emit = ctx?.emit;
    if (typeof emit === 'function') {
      emit({ event: 'notice', data: { ...fields, memberName: fields.memberName || rc?.agentId || fields.agentId } });
    }
  } catch {
    /* swallow: notice 不影响主流程 */
  }
}