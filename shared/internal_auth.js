/**
 * 内部服务凭证（agent-server → gateway 的机器身份）
 *
 * 多用户改造后 gateway 业务路由一律要鉴权。agent 侧回调 gateway 的通道
 * （Speak /say、sync-history、/notice、roomBusUrl 拉取）带此头放行。
 *
 * token 由 gateway 生成并持久化在 gateway.json internalToken，
 * spawn agent-server 时经 env ELF_INTERNAL_TOKEN 注入（gateway/process_manager.js）。
 */

/** @returns {{ Authorization?: string }} 可直接 spread 进 fetch headers */
export function internalAuthHeaders() {
  const t = process.env.ELF_INTERNAL_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
}
