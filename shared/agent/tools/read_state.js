/**
 * 文件读取状态追踪
 * Read/Write/Edit 三个工具共享此模块，确保文件被 Read 后才能 Write/Edit
 */

const readFiles = new Set();

export function markRead(filePath) {
  readFiles.add(filePath);
}

export function hasRead(filePath) {
  return readFiles.has(filePath);
}

export function reset() {
  readFiles.clear();
}
