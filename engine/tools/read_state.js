/**
 * 文件读取状态追踪 — 对齐 CC readFileState (wsu LRU Map)
 * 每条记录: { content, contentHash, timestamp, offset, limit, isPartialView }
 *
 * CC 原始字段还包括 keepContent / contentLength，elf 简化：
 * - 全文且 ≤ CONTENT_KEEP_SIZE → 保留 content
 * - 否则 content 置空，仅保留 contentHash 用于比对
 */

import crypto from 'crypto';
import path from 'path';

const CONTENT_KEEP_SIZE = 4096; // 对齐 CC qdg

const state = new Map();

export function hashContent(content) {
  return crypto.createHash('sha1').update(content).digest('base64');
}

function normalizeKey(filePath) {
  return path.normalize(filePath);
}

export function markRead(filePath, { content, timestamp, offset, limit }) {
  const key = normalizeKey(filePath);
  const fullRead = !offset && !limit;
  const keepContent = fullRead && content.length <= CONTENT_KEEP_SIZE;
  state.set(key, {
    content: keepContent ? content : '',
    contentHash: hashContent(content),
    timestamp: Math.floor(timestamp),
    offset: offset ?? undefined,
    limit: limit ?? undefined,
    isPartialView: !fullRead,
  });
}

export function hasRead(filePath) {
  return state.has(normalizeKey(filePath));
}

export function getReadState(filePath) {
  return state.get(normalizeKey(filePath)) ?? null;
}

export function getReadPaths() {
  return [...state.keys()];
}

export function deleteReadState(filePath) {
  state.delete(normalizeKey(filePath));
}

export function reset() {
  state.clear();
}

export { CONTENT_KEEP_SIZE };
