/**
 * Agent 工具 —— 启动子 agent（subagent）执行任务
 *
 * 看 docs/subagent-design.md：
 * - 子 agent 零对话上下文（只一条 prompt），引擎部件复用主 agent（model/config/同类MM）
 * - 子 agent 关流式：跑完取最后 assistant 文本作为 tool_result 回流
 * - isConcurrencySafe=true：同批多个 Agent tool_call 并发（多 subagent 并行）
 * - subagent_type 必填、必须在 config.subagents 启用集内
 * - 工具黑名单：Explore disallowedTools 含 Agent 自身 → 禁止嵌套
 *
 * 引擎部件获取：execute 经 ctx.agent 拿主 agent 引用（ToolManager.execute 透传 ctx）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getSubagentDefinition } from '../subagents/registry.js';

export const Agent = {
  name: 'Agent',
  description: "启动一个子 agent 执行任务。子 agent 有独立上下文（看不到当前对话），需在 prompt 里说明任务背景。subagent_type 必须是启用的子 agent 类型（如 Explore 只读检索 / general-purpose 通用可改文件）。",
  isConcurrencySafe: true,

  parameters: {
    type: 'object',
    properties: {
      subagent_type: {
        type: 'string',
        // 静态示意；运行时 enum 动态填为 config.subagents（见 registry + Agent 工具注册处）
        enum: ['Explore', 'general-purpose'],
        description: '子 agent 类型（必填，必须在启用集内）'
      },
      prompt: { type: 'string', description: '给子 agent 的完整任务描述（零上下文，需 briefing）' },
      description: { type: 'string', description: '3-5 词任务摘要' }
    },
    required: ['subagent_type', 'prompt']
  },

  callSummary: (args) => args.description || args.subagent_type || '',

  /**
   * @param {object} args - { subagent_type, prompt, description }
   * @param {AbortSignal} [signal]
   * @param {object} ctx - 工具上下文 { agent } 主 agent 实例（ToolManager.execute 透传）
   */
  execute: async (args, signal, ctx) => {
    const { subagent_type, prompt } = args;
    if (signal?.aborted) return 'Error: aborted';

    const parentAgent = ctx?.agent;
    if (!parentAgent) return 'Error: Agent 工具缺少主 agent 上下文';

    // 校验 subagent_type 必填 + 在启用集内
    const enabledTypes = parentAgent.config.get('subagents') || [];
    if (!subagent_type) return 'Error: subagent_type 必填';
    if (!enabledTypes.includes(subagent_type)) {
      return `Error: subagent_type "${subagent_type}" 未启用（config.subagents = ${JSON.stringify(enabledTypes)}）`;
    }

    const def = getSubagentDefinition(subagent_type);
    if (!def) return `Error: 未知 subagent_type "${subagent_type}"`;

    // 构造子 agent：复用主 agent 的 model/config，临时 MM（继承父 MM 类、临时 dataDir）
    const ParentMMClass = Object.getPrototypeOf(parentAgent.messageManager).constructor;
    const subDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-subagent-'));
    const systemPrompt = def.getSystemPrompt() + (def.criticalSystemReminder ? `\n\n${def.criticalSystemReminder}` : '');
    const subMM = new ParentMMClass({
      systemPrompt,
      dataDir: subDataDir,                 // 临时目录：L1 tool-results + context.json 都落此，跑完清
      config: parentAgent.config,          // 复用主 agent Config（读压缩配置/阈值/L1-L2 阈值）
    });

    // 子工具集：按 def 过滤（Explore 黑名单 / general-purpose 全开）。
    // Speak 永不出现在子 agent（§12.3：子 agent 无 runContext,调 Speak 会报错/越界）。
    const parentTools = parentAgent.toolManager.getAll();
    const allNames = parentTools.map(t => t.name);
    const allowedNames = (def.tools && def.tools[0] === '*'
      ? allNames
      : allNames.filter(n => !(def.disallowedTools || []).includes(n))
    ).filter(n => n !== 'Speak');
    const subTools = parentTools.filter(t => allowedNames.includes(t.name));

    // 复用主 agent 的 ToolRegistry 类构造子 registry（含 Agent 工具若未被 disallow）
    const ToolManagerCtor = parentAgent.toolManager.constructor;
    const subRegistry = new ToolManagerCtor();
    for (const t of subTools) subRegistry.register(t);

    // 子 agent：new 同类 Agent？仍用主 agent 类，配子 MM/子 registry/主 model+config
    const ParentAgentClass = Object.getPrototypeOf(parentAgent).constructor;
    const subAgent = new ParentAgentClass({
      config: parentAgent.config,          // 继承 maxIterations 等
      model: parentAgent.model,            // inherit 主模型
      toolManager: subRegistry,
      messageManager: subMM,
    });

    // 桥接父 agent abort → 子 agent abort（修复：父 agent 停止时子 agent 继续跑的问题）
    const onParentAbort = () => subAgent.abort();
    if (signal) {
      if (signal.aborted) onParentAbort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }

    // 子 agent 跑 loop（关流式：drain 吞事件、取最后 assistant 文本）
    let finalText = '';
    try {
      // drain：吞掉子 agent 的流式事件（不转发前端），空 emit。
      // 中断靠 onParentAbort → subAgent.abort()（receive 走 AbortError 收尾路径，resolve 不抛）。
      await subAgent.receive(prompt, { emit: () => {} });
      // 取最后一条 assistant 文本作为 tool_result
      const msgs = subMM.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant' && msgs[i].content) {
          finalText = msgs[i].content;
          break;
        }
      }
      if (!finalText) finalText = '(子 agent 未产生最终文本)';
    } catch (err) {
      if (signal?.aborted) {
        finalText = 'Error: aborted';
      } else {
        finalText = `Error: 子 agent 执行失败: ${err.message}`;
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onParentAbort);
      // 跑完清临时目录（L1 tool-results + context.json，不污染主 agent data/）
      try { fs.rmSync(subDataDir, { recursive: true, force: true }); } catch (e) { console.warn(`[Agent tool] 清子 agent 临时目录失败 ${subDataDir}: ${e.message}`); }
    }

    return finalText;
  }
};
