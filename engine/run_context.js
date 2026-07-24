/**
 * 运行时身份（runContext）—— 实例化改造的第三层
 *
 * 模型：Config（类级人设）→ Agent 实例（人设+内核）→ runContext（运行时身份，实例级）
 *
 * 解决单实例遗留：原来 identity 焊死在 Agent 实例上（agentId 当全局身份、dataDir 写死 configDir/..）。
 * 引入 runContext 后，区分实例靠 runKey：
 *   - 私聊实例：runKey = agentId，mode='private'
 *   - 群聊副本：runKey = <roomId>/<agentId>，mode='room'
 *
 * 本步 runContext 仅内存对象（由 startAgent 从启动参数构造注入）。
 * run.json 落盘（副本 re-discover 用）留到群聊副本阶段。
 *
 * 见 docs/chat-room-design.md §10.2 / §10.6。
 */

/**
 * 构造 runContext
 * @param {object} opts
 * @param {string} opts.agentId - 来源 agent 的类身份（config.agentId，只读）
 * @param {string} [opts.mode='private'] - 'private' | 'room'
 * @param {number} [opts.port] - 本实例监听端口；缺省由调用方回退到 config.port
 * @param {string} [opts.dataDir] - 本实例独占数据目录；缺省回退到 agents/<id>/data
 * @param {string} [opts.roomId] - 仅 room 模式：所在群 id
 * @param {string} [opts.memberName] - 仅 room 模式：群里的名字
 * @param {string} [opts.roomBusUrl] - 仅 room 模式：room_bus base url（Speak 工具回调用）
 * @returns {{runKey:string, agentId:string, mode:string, port:number|null, dataDir:string|null, roomId:string|null, memberName:string|null, roomBusUrl:string|null}}
 */
export function buildRunContext({ agentId, mode = 'private', port = null, dataDir = null, roomId = null, memberName = null, roomBusUrl = null } = {}) {
  if (!agentId) throw new Error('buildRunContext: agentId 必填');
  const m = mode === 'room' ? 'room' : 'private';

  // room 模式 fail-fast(防 #1 数据破坏 / #2 身份碰撞 / #5 端口冲突):
  //   - roomId 缺失 → runKey 会静默降为 agentId,与私聊实例 runKey 重合 → 日志/状态身份碰撞(#2)
  //   - dataDir 缺失 → fromConfigDir 会 || 回退到私聊 data 目录 → 副本写私聊 context.json 破坏数据(#1)
  // 三者任一缺失,room 模式直接抛错,不静默回退私聊。
  //   注:port 的回退(config.port)在 room 模式下会抢私聊端口(#5),但 port 校验在 start.js
  //   入口做(buildRunContext 拿到的 port 已是"显式 port ?? config.port",无法区分来源),
  //   故 port fail-fast 由 start.js 按 runOpts.port 是否显式传入判定。
  if (m === 'room') {
    if (!roomId) throw new Error('buildRunContext: room 模式必须提供 roomId(否则与私聊实例身份碰撞)');
    if (!dataDir) throw new Error('buildRunContext: room 模式必须提供 dataDir(否则回退私聊 data 破坏数据)');
  }

  // runKey：私聊=agentId；群聊副本=roomId/agentId(全局唯一运行单元)。room 模式 roomId 已 fail-fast 保证非空。
  const runKey = m === 'room' ? `${roomId}/${agentId}` : agentId;
  // memberName 缺省回退 agentId
  const member = m === 'room' ? (memberName || agentId) : null;
  // v3：私聊也是 Room（roomId = chat-<agentId>），保留 roomId 供 PrivateChatPlugin 拼 sync URL。
  //   room 模式 roomId 已 fail-fast 非空；private 模式 roomId 缺省 null（旧 start.js 单参路径零回归）。
  return {
    runKey,
    agentId,
    mode: m,
    port: port ?? null,
    dataDir: dataDir ?? null,
    roomId: roomId ?? null,
    memberName: member,
    roomBusUrl: m === 'room' ? roomBusUrl : null,
  };
}

/**
 * 私聊默认形态：runKey=agentId、mode='private'、port/dataDir 缺省（由调用方回退到 config）
 * @param {string} agentId
 * @param {number} [port]
 */
export function buildPrivateRunContext(agentId, port = null) {
  return buildRunContext({ agentId, mode: 'private', port });
}