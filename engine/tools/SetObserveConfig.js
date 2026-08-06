/**
 * SetObserveConfig —— 观测式策略下 agent 运行时自配置工具
 *
 * 仅设置你当前最关注的关键词（最多 MAX_KEYWORDS 个，整体覆盖）。
 * 写 profiles/agents/<id>/rooms/<rid>/observe_status.json（= runContext.dataDir/observe_status.json）。
 * RoomPlugin.getObserveConfig() 直接读该文件（文件是关注词的唯一来源）。
 *
 * 名字不占名额：你写入的是纯关注词；你的名字在读取时由 RoomPlugin 自动并入匹配列表
 *   （observe 策略下别人直呼你名字仍能触发你发言），但名字不存进这 MAX_KEYWORDS 个、
 *   也不在本工具的描述/参数里暴露。
 *
 * 观测巡视间隔由 RoomPlugin 动态退避（Skip 翻倍 / Speak 复位），不由此工具设置。
 * silentRetries 固定常量（不暴露参数）。
 *
 * 仅在 interaction.strategy ∈ {observe, both} 时由 room_state.js 注册。
 */

import fs from 'fs';
import path from 'path';

const MAX_KEYWORDS = 7;          // 关注关键词上限（不含名字）

export const SetObserveConfig = {
  name: 'SetObserveConfig',
  description: `写下你当前最关注的关键词，最多 ${MAX_KEYWORDS} 个。群里有人聊到其中任何一个时你会被触发发言。每次调用都是整体覆盖，不是增删。`,
  isConcurrencySafe: false,

  parameters: {
    type: 'object',
    properties: {
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: `你当前最关注的关键词，整体覆盖上一次的设置（不是增删）。最多 ${MAX_KEYWORDS} 个；字符串=子串匹配，/pattern/flags=正则匹配。`,
      },
    },
    required: ['keywords'],
  },

  callSummary: (args) => {
    const n = Array.isArray(args?.keywords) ? args.keywords.length : 0;
    return `SetObserveConfig: keywords[${n}]`;
  },

  /**
   * @param {object} args - { keywords: string[] }
   * @param {AbortSignal} [signal]
   * @param {object} ctx - { agent }
   * @returns {Promise<string>} 工具结果（含生效描述）
   */
  execute: async (args, signal, ctx) => {
    if (signal?.aborted) return 'Error: aborted';
    const rc = ctx?.agent?.runContext;
    if (!rc || rc.mode !== 'room' || !rc.dataDir) {
      return 'Error: 仅群聊可用且需 dataDir';
    }

    // 经 scene.writeObserveStatus 统一写：截断 + 文件唯一来源（不合并名字）
    const scene = ctx?.agent?._scene;
    if (scene && typeof scene.writeObserveStatus === 'function') {
      const { cfg, warnings } = scene.writeObserveStatus({
        keywords: Array.isArray(args?.keywords) ? args.keywords : [],
      });
      const desc = `已更新：你当前最关注的关键词=[${(cfg.keywords || []).join(', ')}]`;
      return warnings.length ? `${desc}（${warnings.join('；')}）` : desc;
    }

    // 兜底：无 scene（纯工具测试用）——自行写文件，不合并名字
    const filePath = path.join(rc.dataDir, 'observe_status.json');
    let cur = {};
    try { if (fs.existsSync(filePath)) cur = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch (e) { console.warn(`[SetObserveConfig] 读 ${filePath} 失败: ${e.message}`); }
    delete cur.silentRetries;
    const cleaned = (Array.isArray(args?.keywords) ? args.keywords : [])
      .map(k => String(k ?? '').trim())
      .filter(k => k.length > 0)
      .slice(0, MAX_KEYWORDS);
    cur.keywords = cleaned;
    try { fs.mkdirSync(rc.dataDir, { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(cur, null, 2), 'utf-8'); }
    catch (err) { return `Error: 写入失败: ${err.message}`; }
    return `已更新：你当前最关注的关键词=[${(cur.keywords || []).join(', ')}]`;
  },
};