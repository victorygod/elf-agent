/**
 * Write 工具 —— elf-018 专版（工厂，持 agent 实例）
 *
 * 同名覆盖通用 Write，加两层守卫：
 *   - 前置 lore 范围校验：file_path 必须落在 lore 目录内；
 *   - 前置 frontmatter 校验：content 须以 ---\nname: ...\ndescription: ...\n--- 开头。
 * 不委托通用 Write.execute：state.md/面板等基线已由注入器预载上下文，本工具不要求先 Read、
 *   不做 hasRead/陈旧检查，自行建父目录→写盘→markRead。仅复用通用 Write 的 parameters schema。
 */
import fs from 'fs';
import path from 'path';
import { Write as GenericWrite } from '../../../engine/tools/index.js';
import { isInsideLore, validateFrontmatter } from './loreGuard.js';
import { markRead } from '../../../engine/tools/read_state.js';

export function makeWrite(agent) {
  return {
    name: 'Write',
    description: '写 lore 目录内的设定文件（覆盖或新建）。file_path 须在 lore 内；content 须以 frontmatter 开头（含 name 与 description：---\\nname: ...\\ndescription: ...\\n---）。无需先 Read——基线内容已注入上下文。',
    isConcurrencySafe: false,

    statusEvent: { state: 'writing_file', detail: (a) => `写入 ${a.file_path || ''}` },
    callSummary: (a) => a.file_path || '',

    parameters: GenericWrite.parameters,

    execute: async (args, signal) => {
      if (signal?.aborted) return 'Error: aborted';
      const fp = args && args.file_path;
      if (!fp || !isInsideLore(fp, agent._roots.lore)) {
        return `Error: 只能写 lore 目录内的文件: ${fp || ''}`;
      }
      const content = args && args.content;
      if (!validateFrontmatter(content)) {
        return `Error: lore 文件须以 frontmatter 开头且含 name 与 description（---\\nname: ...\\ndescription: ...\\n---）`;
      }

      // 自行写盘（不要求先 Read、不做 hasRead/陈旧检查）：建父目录 → 写盘 → markRead
      const dir = path.dirname(fp);
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        return `Error: 创建父目录失败 ${fp}: ${e.message}`;
      }
      const existed = fs.existsSync(fp);
      try {
        fs.writeFileSync(fp, content, 'utf-8');
      } catch (e) {
        if (e.code === 'EACCES') return `Error: Permission denied writing to ${fp}`;
        return `Error: Failed to write ${fp}: ${e.message}`;
      }
      markRead(fp, { content, timestamp: Math.floor(Date.now()) });

      return existed
        ? `File overwritten successfully at: ${fp} (file state is current in your context — no need to Read it back)`
        : `File created successfully at: ${fp} (file state is current in your context — no need to Read it back)`;
    },
  };
}