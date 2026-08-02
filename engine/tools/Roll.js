/**
 * Roll 工具 —— DND 5e d20 判定掷骰
 *
 * 确定性随机（crypto.randomInt，防 LLM 凭空编数字）。自然 1 大失败 / 自然 20 大成功。
 * 给 dc 则判 total = roll + modifier >= dc。只读、并发安全（不改任何状态）。
 */
import crypto from 'crypto';

export const Roll = {
  name: 'Roll',
  description: "掷一次 d20 进行判定。purpose 为用途说明；dc 可选（难度等级，省略则纯掷骰不判过）；modifier 可选（调整值，默认 0）。返回点数、是否过 DC、是否大成功/大失败。",
  isConcurrencySafe: true,

  statusEvent: {
    state: 'rolling',
    detail: (args) => `Roll d20（${args.purpose || ''}）`,
  },
  callSummary: (args) => `d20${args.dc != null ? ` vs DC ${args.dc}` : ''}（${args.purpose || ''}）`,

  parameters: {
    type: 'object',
    properties: {
      purpose: { type: 'string', description: '本次判定的用途/情境（必填）' },
      dc: { type: 'integer', description: '难度等级，省略则纯掷骰不判过' },
      modifier: { type: 'integer', description: '调整值，默认 0' },
    },
    required: ['purpose'],
  },

  execute: async (args, signal) => {
    if (signal?.aborted) return 'Error: aborted';
    const purpose = (args && args.purpose) || '判定';
    const modifier = (args && typeof args.modifier === 'number') ? args.modifier : 0;
    const dc = (args && typeof args.dc === 'number') ? args.dc : null;

    const roll = crypto.randomInt(1, 21);   // 1..20（上界 exclusive）
    const total = roll + modifier;

    let line = `Roll d20=${roll}`;
    if (modifier !== 0) line += `${modifier > 0 ? '+' : ''}${modifier}=${total}`;

    let outcome;
    if (roll === 1) outcome = '大失败（自然 1）';
    else if (roll === 20) outcome = '大成功（自然 20）';
    else if (dc !== null) outcome = total >= dc ? '成功' : '失败';
    else outcome = '仅掷骰';

    let result = line;
    if (dc !== null) result += ` vs DC ${dc}`;
    result += ` → ${outcome}`;
    result += `（${purpose}）`;
    return result;
  },
};