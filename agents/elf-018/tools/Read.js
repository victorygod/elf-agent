/**
 * Read 工具 —— elf-018 专版（工厂，持 agent 实例）
 *
 * 同名覆盖通用 Read，前置 lore 范围校验：只能读 lore 目录内的文件。其余（cat -n/分页/
 * read_state 标记）委托通用 Read 执行。outline loop 按需读 lore（state.md/角色卡/设定）。
 */
import { Read as GenericRead } from '../../../engine/tools/index.js';
import { isInsideLore } from './loreGuard.js';

export function makeRead(agent) {
  return {
    name: 'Read',
    description: '读取 lore 目录内的设定文件（角色卡/地点/物品/技能/任务/state.md/user_profile.md）。只允许读 lore 目录内的文件，cat -n 格式输出，支持 offset/limit 分页。',
    isConcurrencySafe: true,

    statusEvent: { state: 'reading_file', detail: (a) => `读取 ${a.file_path || ''}` },
    callSummary: (a) => a.file_path || '',

    parameters: GenericRead.parameters,

    execute: async (args, signal) => {
      if (signal?.aborted) return 'Error: aborted';
      const fp = args && args.file_path;
      if (!fp || !isInsideLore(fp, agent._roots.lore)) {
        return `Error: 只能读 lore 目录内的文件: ${fp || ''}`;
      }
      return GenericRead.execute(args, signal);
    },
  };
}