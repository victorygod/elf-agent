/**
 * Roll 工具 —— DND 5e 骰子掷骰与判定（elf-018 专属工具，本地化于本 agent）
 *
 * 确定性随机（crypto.randomInt，防 LLM 凭空编数字）。
 * dice 为 XdY（默认 1d20）：判定步（攻击/行动/豁免/对抗）用 1d20 并判 nat；
 *   结算步（伤害/治疗/附加骰）用如 1d8/2d6，只出数值。
 * 给 dc 则判 total = 各骰之和 + modifier >= dc。
 * 仅当 dice 恰为 1d20 时判大成功（自然 20）/ 大失败（自然 1）；其他骰子不判 nat。
 * 连续判定（命中→伤害）由调用方分多次调用，工具不做编排。只读、并发安全。
 */
import crypto from 'crypto';

// 解析 XdY → {count, sides}；非法回退 1d20。count 上限 20 颗防 LLM 传爆。
const parseDice = (raw) => {
  const m = /^(\d+)d(\d+)$/i.exec(String(raw || '').trim());
  if (!m) return { count: 1, sides: 20 };
  const count = Math.min(parseInt(m[1], 10), 20);
  const sides = parseInt(m[2], 10);
  if (count < 1 || sides < 1) return { count: 1, sides: 20 };
  return { count, sides };
};

const fmtDice = (count, sides) => `${count}d${sides}`;

export const Roll = {
  name: 'Roll',
  description: "掷骰子进行判定或结算。purpose 为用途说明；dice 为骰表达式 XdY（默认 1d20，判定步用 1d20；伤害/治疗/附加用如 1d8、2d6）；modifier 可选（调整值，默认 0）；dc 可选（难度等级，省略则纯掷骰不判过）。仅 1d20 判大成功/大失败（自然 20/1）。返回逐骰点数、合计、是否过 DC。",
  isConcurrencySafe: true,

  statusEvent: {
    state: 'rolling',
    detail: (args) => `Roll ${args.dice || '1d20'}（${args.purpose || ''}）`,
  },
  callSummary: (args) => `${args.dice || '1d20'}${args.dc != null ? ` vs DC ${args.dc}` : ''}（${args.purpose || ''}）`,

  parameters: {
    type: 'object',
    properties: {
      purpose: { type: 'string', description: '本次判定的用途/情境（必填）' },
      dice: { type: 'string', description: '骰表达式 XdY，默认 1d20。判定步用 1d20；伤害/治疗/附加用如 1d8、2d6', default: '1d20' },
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
    const { count, sides } = parseDice(args && args.dice);

    const dice = [];
    for (let i = 0; i < count; i++) dice.push(crypto.randomInt(1, sides + 1));   // 1..sides（上界 exclusive）
    const sum = dice.reduce((a, b) => a + b, 0);
    const total = sum + modifier;

    let line = `Roll ${fmtDice(count, sides)}=${dice.join('+')}`;
    if (count > 1) line += `=${sum}`;                       // 多颗显示求和
    if (modifier !== 0) line += `${modifier > 0 ? '+' : ''}${modifier}=${total}`;

    const isNatD20 = count === 1 && sides === 20;
    const single = dice[0];

    let outcome;
    if (isNatD20 && single === 1) outcome = '大失败（自然 1）';
    else if (isNatD20 && single === 20) outcome = '大成功（自然 20）';
    else if (dc !== null) outcome = total >= dc ? '成功' : '失败';
    else outcome = '仅掷骰';

    let result = line;
    if (dc !== null) result += ` vs DC ${dc}`;
    result += ` → ${outcome}`;
    result += `（${purpose}）`;
    return result;
  },
};
