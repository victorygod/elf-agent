/**
 * profiles/ 路径解析模块 —— engine + gateway 共用的单一路径来源
 *
 * 收口 v3 之前散落在 start.js / process_manager.js / room_bus.js / snapshot.js /
 * room_routes.js / gateway/index.js 的 path.join，按"所有权原则"统一布局：
 *   - agent 拥有自己的记忆（memory + rooms/<rid>）
 *   - room 拥有房历史与配置（room.json + history.jsonl + run/<id>.json）
 *
 * 布局（详见 docs/temp-analysis-conclusions.md §5）：
 *   profiles/
 *   ├── agents/<id>/memory/        私聊记忆（context/tool-results/checkpoints/sync_cursor）
 *   ├── agents/<id>/rooms/<rid>/   该 agent 在各群的私有记忆（context/sync_cursor/tool-results）
 *   ├── rooms/<rid>/               room.json + history.jsonl + run/<id>.json
 *   ├── rooms/chat-<id>/           私聊房（仅 history.jsonl，无 room.json）
 *   └── logs/
 *
 * 根可由 env ELF_PROFILES_ROOT 覆盖（默认 <cwd>/profiles），供测试隔离。
 *
 * 旧布局（chat//rooms//logs//agents/<id>/data）不兼容、不自动迁移；老数据需手动搬移。
 */
import path from 'path';

let _root = null;

/** profiles 根目录（绝对路径）。ELF_PROFILES_ROOT 可覆盖，默认 <cwd>/profiles。 */
export function profilesRoot() {
  if (_root) return _root;
  _root = process.env.ELF_PROFILES_ROOT
    ? path.resolve(process.env.ELF_PROFILES_ROOT)
    : path.join(process.cwd(), 'profiles');
  return _root;
}

/** 供测试重置缓存（改 env 后调一次）。 */
export function _resetProfilesRoot() { _root = null; }

/** agent 私聊记忆目录：profiles/agents/<id>/memory。 */
export function agentMemory(agentId) {
  return path.join(profilesRoot(), 'agents', agentId, 'memory');
}

/** agent 在某群的私有记忆目录：profiles/agents/<id>/rooms/<rid>。 */
export function agentRoomState(agentId, roomId) {
  return path.join(profilesRoot(), 'agents', agentId, 'rooms', roomId);
}

/** rooms 根目录：profiles/rooms。供 RoomManager/RoomConfig 等作 fileRoot。 */
export function roomsRoot() {
  return path.join(profilesRoot(), 'rooms');
}

/** users 根目录：profiles/users。每个注册用户一个子目录（user.json + avatar）。 */
export function usersRoot() {
  return path.join(profilesRoot(), 'users');
}

/** 某用户的数据目录：profiles/users/<uid>。 */
export function userDir(uid) {
  return path.join(profilesRoot(), 'users', uid);
}

/** 日志目录：profiles/logs。ELF_LOG_DIR 可覆盖（测试用，日志与真实 profiles/logs 分离）。 */
export function logsDir() {
  return process.env.ELF_LOG_DIR ? path.resolve(process.env.ELF_LOG_DIR) : path.join(profilesRoot(), 'logs');
}
