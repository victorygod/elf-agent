/**
 * Skill 工具（统一入口，对齐 Claude Code `o66`/`OP1`/`Fd4`）
 *
 * 模型侧只看到「一个名为 Skill 的工具」，按 description 清单决定是否调用。
 *  - description 动态极简（`Execute skill: <名>`），不含清单（清单靠 L1 注入）
 *  - prompt 静态复刻 CC `OP1`，含 `<command-name>` 防重复契约
 *
 * execute 触发后注入两段消息（对齐 `Fd4` cli.js:8236640）：
 *  ① <command-name>/<command-message>/<command-args> 非-isMeta（模拟用户敲 /命令）
 *  ② 正文裸 isMeta（不包 <system-reminder>）
 * 并经 agent.skillLister.recordInvoked 记录，供 compact 恢复（对齐 $O6）。
 */

import { getPromptForCommand } from '../skills/prompt.js';

// 静态使用说明，复刻 CC `OP1`（cli.js:1661）。command-name 那条防同轮重复调用，不能省。
const TOOL_PROMPT = `
 - invoke using fully qualified name

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`;

// 常规 skill（userInvocable !== false）的标签段，对齐 CC `ud4`（cli.js:8236321）
// <command-name>name</command-name>\n<command-message>/name</command-message>\n<command-args>args</command-args>
function commandTag(name, args) {
  const lines = [
    `<command-name>${name}</command-name>`,
    `<command-message>/${name}</command-message>`,
    args ? `<command-args>${args}</command-args>` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

export const Skill = {
  name: 'Skill',
  // 极简静态描述（对齐 CC `o66` 的 description 语义：只表明"执行某个 skill"，不含清单）
  // 清单通过 L1 注入的 <system-reminder> 进入上下文，不进工具定义。
  description: 'Execute a skill by name. Available skills are listed in system-reminder messages in the conversation.',
  prompt: TOOL_PROMPT,
  isConcurrencySafe: false, // 写入对话历史，非只读

  statusEvent: {
    state: 'running_skill',
    detail: (args) => `正在执行 skill: ${args?.skill || ''}`,
  },
  callSummary: (args) => args?.skill || '',

  parameters: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The name of the skill to invoke'
      },
      args: {
        type: 'string',
        description: 'Arguments to pass to the skill'
      }
    },
    required: ['skill']
  },

  execute: async (args, signal, ctx) => {
    if (signal?.aborted) return 'Error: aborted';

    const name = String(args?.skill ?? '').trim().replace(/^\//, '');
    const argStr = args?.args ?? '';

    const agent = ctx?.agent;
    const list = agent?.skillLister;
    if (!agent || !list?.registry) {
      return `Error: skills not enabled on this agent`;
    }

    const skill = list.registry.get(name);
    if (!skill) {
      return `Error: Unknown skill: ${name}`;
    }
    // fork 本期不支持
    if (skill.context === 'fork') {
      return `Error: fork skills not supported yet (skill: ${name})`;
    }

    const body = getPromptForCommand(skill, argStr);

    // ① <command-*> 标签段：非 isMeta，模拟用户敲 /命令（也是防重复调用的标记）
    agent.messageManager.addUserMessage(commandTag(name, argStr), false);

    // ② 正文：裸 isMeta，不包 <system-reminder>（与清单/invoked_skills 走 x5 形成对照）
    agent.messageManager.addMetaMessage(body, 'skill_invocation');

    // 记录全文供 compact 恢复（对齐 $O6）
    list.recordInvoked({ name, path: skill.skillRoot, contents: [body] });

    return `Skill '${name}' loaded`;
  }
};