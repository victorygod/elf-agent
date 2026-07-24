/**
 * SkillLister —— skill 清单增量注入 + 触发记录（compact 恢复用）
 *
 * 从 default_agent.js 迁出（功能无 diff）。Agent 对它的接口收窄为：
 *   - enable()                 初始化（对齐原 _enableSkills）
 *   - inject()                 reasoning 入口每轮调，现算清单写 mm.skillListing（对齐原 _injectSkillListing）
 *   - reset()                  清空记忆/会话重开时调，清去重快照 + 触发记录（对齐原 _resetSkillPushState + 清 _invokedSkills）
 *   - reinvokeAfterCompact()   compact 后重推清单字段 + invoked_skills 全文（对齐原 _reinjectMetaMessages）
 *   - recordInvoked({name,path,contents})  Skill 工具触发时调，收口对 _invokedSkills 的写入
 *   - get registry()           暴露 SkillRegistry 给 Skill 工具按名查 skill
 *   - get invokedSkills()      暴露触发记录（只读访问，供测试断言）
 *
 * 门控：未启用（_registry 为 null）或未注册 Skill 工具时，所有产出短路为空，零开销。
 */

import { SkillRegistry } from './registry.js';

export class SkillLister {
  /**
   * @param {object} params
   * @param {object} params.messageManager  - 只用：mm.skillListing 字段、mm.addMetaMessage
   * @param {object} params.toolManager    - 只用：get('Skill') 门控
   * @param {string} params.cwd             - skill 扫描根
   */
  constructor({ messageManager, toolManager, cwd }) {
    this._mm = messageManager;
    this._toolManager = toolManager;
    this._cwd = cwd ?? process.cwd();
    this._registry = null;       // SkillRegistry 实例（null=未启用）
    this._pushedSkills = null;   // Set<string> 已推送签名（对齐 CC nT6，会话常驻、compact/rewind 不清）
    this._pushedNames = null;    // Set<string> 上次推送的 visible name 全集，检测删除用
    this._invokedSkills = null;  // 已触发 skill 全文记录（对齐 $O6），供 compact 恢复
  }

  /** 暴露 SkillRegistry 给 Skill 工具按名查 skill */
  get registry() {
    return this._registry;
  }

  /** 暴露触发记录（只读访问，供测试断言） */
  get invokedSkills() {
    return this._invokedSkills;
  }

  /**
   * 启用 skill 支持。
   * 未调用则三字段保持 null——后续 inject/reset 等入口守卫短路，本 lister 不产生任何 skill 行为。
   */
  enable() {
    this._registry = new SkillRegistry();
    this._registry.loadAll(this._cwd);
    this._pushedSkills = new Set();   // 对齐 CC nT6 精神：会话常驻，compact 不清、rewind 不清
    this._pushedNames = new Set();    // 上次推送时的 visible name 全集，用于检测删除
    this._invokedSkills = [];         // 对齐 $O6：记录已触发 skill 全文，供 compact 恢复
  }

  /**
   * 重置 skill 清单的去重快照 + 触发记录（清空记忆 = 会话重开时调）。
   * 语义对齐 CC `Pc()`：清 nT6（已推送记录）。
   *
   * 与原 _resetSkillPushState 的差异：原方法**不清 _invokedSkills**（compact 后重推时只清快照），
   * 清空记忆（会话重开）由 /clear 路由单独清 _invokedSkills。
   * 迁移后调用方语义两分：compact 后重推走 reinvokeAfterCompact 内部只清快照；/clear 走 reset 全清。
   */
  reset() {
    if (this._pushedSkills) this._pushedSkills.clear();
    if (this._pushedNames) this._pushedNames.clear();
    if (Array.isArray(this._invokedSkills)) this._invokedSkills.length = 0;
  }

  /**
   * 入口 skill 清单注入（重扫 + 增量/全量）。
   * reasoning 入口每轮调；/clear 清空后也调一次，让空 messages 立即重含 listing。
   *
   * 与 CC 对齐：清单不 addMetaMessage 持久化进 messages，而是写入 mm.skillListing 字段，
   * 由 getMessagesForLLM() 临注入到本轮 user 文本之前。门控：仅当启用了 skill 且注册了 Skill 工具才做。
   */
  inject() {
    if (!this._registry || !this._toolManager.get('Skill')) return;
    this._registry.loadAll(this._cwd);   // 热更新重扫
    this._refreshListing();
  }

  /**
   * 现算本轮要送的 skill 清单字符串，覆盖 mm.skillListing。
   * 首轮/有变化 → 写入 <system-reminder> 包裹的清单（全量或增量）；
   * 无变化 → 保留上轮值（清单仍需在场，对齐 CC attachment 每轮常驻 user turn）；
   * 未启用 skill / 未注册 Skill 工具 → 显式清空，防上轮残留泄漏。
   */
  _refreshListing() {
    if (!this._registry || !this._toolManager.get('Skill')) {
      this._mm.skillListing = '';
      return;
    }
    const listing = this._formatListing();
    if (listing) this._mm.skillListing = listing;
    // listing 为空（无变化）→ 保留上轮字段不动
  }

  /**
   * 生成 skill 清单（L1 注入），增量推送 + 热更新变化检测。
   *
   * 推送策略（每轮入口重扫后调用）：
   *  - 纯新增 skill → 只推增量（对齐 CC mhY 增量），轻
   *  - 有删除或内容改动 → 推一条【全量修正清单】，让模型看到当前完整可见集合，覆盖旧认知
   *  - 无变化 → 返回 ''，不注入
   *  - 首轮（_pushedSkills 空）→ 推全量
   *
   * 单行格式：`- name: desc`，有 whenToUse 追加 ` - whenToUse`；<system-reminder> 包裹；16000 截断兜底。
   * @returns {string}
   */
  _formatListing() {
    if (!this._registry || !this._pushedSkills) return '';
    if (!this._toolManager.get('Skill')) return '';   // 门控：未注册 Skill 工具不产出（对齐 mhY ①）
    const skills = this._registry.getVisible();

    const sig = s => `${s.name}|${s.description || ''}|${s.whenToUse || ''}`;
    const currentNames = new Set(skills.map(s => s.name));
    const currentSigs = new Set(skills.map(sig));

    // 首轮：推全量
    if (this._pushedSkills.size === 0) {
      return this._emitListing(skills, currentSigs, currentNames, /*full*/ true);
    }

    const removedNames = [...this._pushedNames].filter(n => !currentNames.has(n));   // 被删的
    const newOrChanged = skills.filter(s => !this._pushedSkills.has(sig(s)));         // 新增或内容变
    const hasChange = removedNames.length > 0 || newOrChanged.length > 0;
    if (!hasChange) return '';   // 无变化不推

    // 有删除或内容改动 → 推全量修正（覆盖旧认知）；纯新增 → 推增量
    const full = removedNames.length > 0 || newOrChanged.some(s => this._pushedNames.has(s.name));
    return this._emitListing(full ? skills : newOrChanged, currentSigs, currentNames, full);
  }

  /**
   * 实际拼装并发出一条 listing，同时更新去重快照。
   * @param skills    本次要列出的 skill 数组（全量 or 增量）
   * @param allSigs   当前 visible 全集签名（无论本次列哪些，快照都记全集）
   * @param allNames  当前 visible 全集 name
   * @param full      是否全量（仅用于日志，不影响行为）
   */
  _emitListing(skills, allSigs, allNames, full) {
    if (!skills.length) return '';
    const lines = skills.map(s => {
      const base = `- ${s.name}: ${s.description}`;
      return s.whenToUse ? `${base} - ${s.whenToUse}` : base;
    });
    // 快照更新到当前全集（无论推增量还是全量，都记住"现在可见的全部"）
    this._pushedSkills = allSigs;
    this._pushedNames = allNames;

    let body = lines.join('\n');
    const BUDGET = 16000;
    if (body.length > BUDGET) body = body.slice(0, BUDGET) + '…';
    return `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n${body}\n</system-reminder>`;
  }

  /**
   * compact 后重推系统注入消息。
   *
   * 对齐 CC：compact 后**不重推 skill 清单持久化消息**（清单已改为临注入，不在 messages 里）。
   * 此处做两件事：
   *  1. 重置去重快照 + 重扫，让 mm.skillListing 字段重新拼出全量（下一轮 reasoning 入口也会 refresh；
   *     这里也立即刷新，保证 compact 后若本轮继续发请求，字段已是全量）。
   *  2. 重推 invoked_skills：本会话已触发过的 skill 正文全文（包 <system-reminder> + isMeta，
   *     对齐 CC dAq → dispatch 走 x5）。
   *
   * **不清 _invokedSkills**：触发记录会话级累积，对齐 CC $O6，下次 compact 仍能重推 invoked_skills。
   *
   * 调用时机：compactIfNeeded yield compact 事件后。
   */
  async reinvokeAfterCompact() {
    if (this._registry && this._toolManager.get('Skill')) {
      // 不清 _invokedSkills——触发记录会话级累积，对齐 CC $O6，下次 compact 仍能重推。
      if (this._pushedSkills) this._pushedSkills.clear();
      if (this._pushedNames) this._pushedNames.clear();
      this._registry.loadAll(this._cwd);   // 重扫，确保清单反映当前可见 skill
      // 重置快照后 _formatListing 必走"首轮"分支返回全量 → 写入 skillListing 字段
      this._refreshListing();
    }

    // 重推 invoked_skills（已触发 skill 正文全文，对齐 CC dAq；持久化留存，不临注入）。
    if (this._invokedSkills && this._invokedSkills.length > 0) {
      const blocks = this._invokedSkills.map(s =>
        `### Skill: ${s.name}\nPath: ${s.path}\n\n${s.contents.join('\n\n')}`
      ).join('\n\n---\n\n');
      const content =
        `<system-reminder>\n` +
        `The following skills were invoked in this session. Continue to follow these guidelines:\n\n` +
        `${blocks}\n` +
        `</system-reminder>`;
      this._mm.addMetaMessage(content, 'invoked_skills');
    }
  }

  /**
   * 记录一次 skill 触发（Skill 工具 execute 成功后调）。
   * 收口原本散在 tools/Skill.js 里直 push agent._invokedSkills 的逻辑。
   * @param {object} entry - { name, path, contents: string[] }
   */
  recordInvoked({ name, path, contents }) {
    if (Array.isArray(this._invokedSkills)) {
      this._invokedSkills.push({ name, path, contents });
    }
  }
}