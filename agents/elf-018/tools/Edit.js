/**
 * Edit 工具 —— elf-018 专版（工厂，持 agent 实例）
 *
 * 同名覆盖通用 Edit，加两层守卫：
 *   - 前置 lore 范围校验：file_path 必须落在 lore 目录内；
 *   - 改后内容 frontmatter 校验：预算替换结果，若改后不符 frontmatter 规范则拒绝（不写盘）。
 * 不委托通用 Edit.execute：state.md/面板等基线已由注入器预载上下文，本工具不要求先 Read、
 *   不做 hasRead/陈旧检查，自行读盘→applyEdit→frontmatter 校验→写盘→markRead。仅复用通用 Edit 的 parameters schema。
 */
import fs from 'fs';
import path from 'path';
import { Edit as GenericEdit } from '../../../engine/tools/index.js';
import { isInsideLore, validateFrontmatter, applyEdit, parseFrontmatterName, isUnderCharacters } from './loreGuard.js';
import { markRead } from '../../../engine/tools/read_state.js';

export function makeEdit(agent) {
  return {
    name: 'Edit',
    description: '精准编辑 lore 目录内的设定文件。file_path 须在 lore 内；old_string→new_string 精确替换（须唯一或设 replace_all）；改后内容须仍以 frontmatter 开头（含 name 与 description）。无需先 Read——基线内容已注入上下文。',
    isConcurrencySafe: false,

    statusEvent: { state: 'editing_file', detail: (a) => `编辑 ${a.file_path || ''}` },
    callSummary: (a) => a.file_path || '',

    parameters: GenericEdit.parameters,

    execute: async (args, signal) => {
      if (signal?.aborted) return 'Error: aborted';
      const fp = args && args.file_path;
      if (!fp || !isInsideLore(fp, agent._roots.lore)) {
        return `Error: 只能编辑 lore 目录内的文件: ${fp || ''}`;
      }
      const oldString = args && args.old_string;
      const newString = args && args.new_string;
      const replaceAll = args && args.replace_all === true;
      if (typeof oldString !== 'string' || typeof newString !== 'string') {
        return 'Error: old_string/new_string 必填且为字符串';
      }
      if (oldString === newString) return 'Error: old_string and new_string are identical';

      // 读盘 → 替换 → frontmatter 校验 → 写盘（不要求先 Read、不做 hasRead/陈旧检查）
      let content;
      try {
        content = fs.readFileSync(fp, 'utf-8');
      } catch (e) {
        if (e.code === 'ENOENT') return `Error: File not found: ${fp}`;
        return `Error reading ${fp}: ${e.message}`;
      }

      const r = applyEdit(content, oldString, newString, replaceAll);
      if (!r.ok) {
        // applyEdit error：not found / matched N times（后者补 replace_all 提示，对齐通用 Edit 文案）
        if (r.error === 'old_string not found') return `Error: old_string not found in ${fp}`;
        if (r.error.startsWith('old_string matched')) {
          const count = r.error.match(/\d+/)?.[0] || 'multiple';
          return `Error: old_string matched ${count} times in ${fp}. Set replace_all=true to replace all, or provide more context to make it unique.`;
        }
        return `Error: ${r.error}`;
      }
      if (!validateFrontmatter(r.result)) {
        return `Error: 改后内容不符合 lore frontmatter 规范（须以 ---\\nname: ...\\ndescription: ...\\n--- 开头）`;
      }

      // 主角守卫：禁止编辑 characters/ 下的主角同名角色卡
      if (isUnderCharacters(fp, agent._roots.lore)) {
        const editedName = parseFrontmatterName(r.result);
        if (editedName) {
          const profilePath = path.join(agent._roots.lore, agent._protagonistFile);
          let protagonistName = '';
          try {
            if (fs.existsSync(profilePath)) {
              const pc = fs.readFileSync(profilePath, 'utf-8');
              protagonistName = parseFrontmatterName(pc);
            }
          } catch {}
          if (protagonistName && editedName === protagonistName) {
            return `Error: 主角（${protagonistName}）已在 ${agent._protagonistFile} 中管理，禁止编辑 characters/ 下的主角角色卡`;
          }
        }
      }

      try {
        fs.writeFileSync(fp, r.result, 'utf-8');
      } catch (e) {
        return `Error writing ${fp}: ${e.message}`;
      }

      const escaped = oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const count = (content.match(new RegExp(escaped, 'g')) || []).length;
      markRead(fp, { content: r.result, timestamp: Math.floor(Date.now()) });

      return replaceAll && count > 1
        ? `The file ${fp} has been updated successfully (${count} replacements). (file state is current in your context — no need to Read it back)`
        : `The file ${fp} has been updated successfully. (file state is current in your context — no need to Read it back)`;
    },
  };
}