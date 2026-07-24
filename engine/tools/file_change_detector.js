/**
 * 文件变更检测 — 对齐 CC ilp
 *
 * 每轮 reasoning 入口调用，扫描 readFileState 中所有已读文件：
 *  1. 对比磁盘 mtime > recorded.timestamp
 *  2. 对比内容哈希
 *  3. 生成简易 diff（带行号）
 *  4. 注入 isMeta 消息到 messageManager
 *
 * 和 CC ilp 的关键对齐：
 *  - 检测到变化后立即调用 markRead 刷新 readFileState → 下一轮不再重复通知
 *  - 部分读取(isPartialView)跳过
 *  - 总额限制 DIFF_SNIPPET_BUDGET
 */

import fs from 'fs';
import path from 'path';
import { getReadPaths, getReadState, markRead, deleteReadState, hashContent } from './read_state.js';

const DIFF_SNIPPET_BUDGET = 16384; // 对齐 CC Cy_

/**
 * 简易 LCS diff，生成带行号的统一格式
 */
function generateDiff(oldContent, newContent, filePath) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // LCS 长度表
  const m = oldLines.length;
  const n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // 回溯生成操作序列
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: 'same', oldIdx: i - 1, newIdx: j - 1, line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'add', newIdx: j - 1, line: newLines[j - 1] });
      j--;
    } else {
      ops.unshift({ type: 'del', oldIdx: i - 1, line: oldLines[i - 1] });
      i--;
    }
  }

  // 格式化为带行号的 diff 文本
  let result = `--- ${path.basename(filePath)}\n+++ ${path.basename(filePath)}\n`;
  let oldLineNum = 1, newLineNum = 1;

  for (const op of ops) {
    switch (op.type) {
      case 'del':
        result += `-${oldLineNum}: ${op.line}\n`;
        oldLineNum++;
        break;
      case 'add':
        result += `+${newLineNum}: ${op.line}\n`;
        newLineNum++;
        break;
      case 'same':
        oldLineNum++;
        newLineNum++;
        break;
    }
  }

  return result;
}

/**
 * 每轮入口调用 — 对齐 CC: ab("changed_files", () => ilp(u))
 *
 * @param {MessageManager} messageManager
 */
export async function detectChangedFiles(messageManager) {
  const paths = getReadPaths();
  if (paths.length === 0) return;

  const changes = [];
  let totalSnippetLen = 0;

  await Promise.all(paths.map(async (filePath) => {
    const st = getReadState(filePath);
    if (!st || st.isPartialView) return; // 跳过部分读取

    try {
      const mtimeMs = Math.floor(fs.statSync(filePath).mtimeMs);
      if (mtimeMs <= st.timestamp) return; // mtime 未变 → 跳过

      let currentContent;
      try {
        // 如果是全文读取且 content 还在，用它做哈希对比；否则读磁盘
        const diskContent = fs.readFileSync(filePath, 'utf-8');
        if (st.content && hashContent(diskContent) === st.contentHash) return; // 哈希相同 → 跳过
        currentContent = diskContent;
      } catch {
        return;
      }

      // ★ 关键：立即更新 readFileState，防止下一轮重复通知
      // 这对齐了 CC ilp 内部调用 nS.call(Read) 刷新 readFileState 的行为
      markRead(filePath, {
        content: currentContent,
        timestamp: mtimeMs,
      });

      // 生成 diff
      const snippet = generateDiff(st.content || '', currentContent, filePath);
      if (!snippet) return;

      changes.push({ filePath, snippet });
    } catch (err) {
      if (err?.code === 'ENOENT') {
        // 文件被删 → 清理状态
        try { deleteReadState(filePath); } catch {}
      }
    }
  }));

  if (changes.length === 0) return;

  // 注入 isMeta 消息（对齐 CC ddp.edited_text_file）
  // 无 <system-reminder> 包裹，role:user + isMeta 独立消息
  for (const { filePath, snippet } of changes) {
    const overBudget = totalSnippetLen >= DIFF_SNIPPET_BUDGET;
    totalSnippetLen += snippet.length;

    const content = overBudget
      ? `Note: ${filePath} was modified, either by the user or by a linter. This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware. The diff was omitted because other modified files in this turn already exceeded the snippet budget; use the Read tool if you need the current content.`
      : `Note: ${filePath} was modified, either by the user or by a linter. This change was intentional, so make sure to take it into account as you proceed (ie. don't revert it unless the user asks you to). Don't tell the user this, since they are already aware. Here are the relevant changes:\n${snippet}`;

    messageManager.addMetaMessage(content, 'file_changed');
  }
}