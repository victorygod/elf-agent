/**
 * PromptAssembler —— 发给 LLM 这一轮请求的临时拼装统一模块（解决 temp #1）
 *
 * 严格三点位 + 临时（不落盘、每轮重算、可叠加）：
 *  ① 系统提示词：追加到 systemPrompt 尾 / 整体替换
 *  ② 最近一条 user 消息及其前后：前插独立消息 / 后插独立消息 / 前后缀修改其 content
 *  ③ 末尾追加独立消息
 *
 * 持久化 meta（addMetaMessage 系列）不经本模块——它写 context.json 是历史修改，不是请求拼装。
 * 本模块只 base 上做三点位注入：纯函数管道、无副作用、易测。
 *
 * base = [{role:'system', content: systemPrompt}, ...stripped messages]（由 mm 产出，元字段 isMeta/metaTag 已 strip）。
 * assemble 按 order 顺序应用所有注册的注入器，返回最终 messages。
 */

/** 注入器：{ slot, form, provider, order, name }。 */
function _entry(slot, form, provider, { order = 100, name } = {}) {
  return { slot, form, provider, order, name: name || `${slot}:${form}` };
}

/** 找最近一条 user 在 messages 中的下标（-1 = 无）。 */
function _lastUserIdx(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return i;
  }
  return -1;
}

export class PromptAssembler {
  constructor() {
    this._entries = [];
  }

  // ── 点位① 系统提示词 ──
  /** 追加文本到 systemPrompt 尾（叠加，按 order）。provider(ctx)=>string|null。 */
  useSystemAppend(provider, opts) { this._entries.push(_entry('system', 'append', provider, opts)); return this; }
  /** 整体替换 systemPrompt。provider(ctx)=>string|null。order 最小的 replace 生效，其余忽略。 */
  useSystemReplace(provider, opts) { this._entries.push(_entry('system', 'replace', provider, opts)); return this; }

  // ── 点位② 最近一条 user 及其前后 ──
  /** 在最近 user 前插一条独立 {role:'user'} 消息。provider(ctx)=>string|null(content)。 */
  useBeforeLastUser(provider, opts) { this._entries.push(_entry('beforeLastUser', 'insert', provider, opts)); return this; }
  /** 在最近 user 后插一条独立消息。provider(ctx)=>string|null。 */
  useAfterLastUser(provider, opts) { this._entries.push(_entry('afterLastUser', 'insert', provider, opts)); return this; }
  /** 修改最近 user 的 content 前后缀。provider(ctx)=>{prefix?,suffix?}|null。 */
  useWrapLastUser(provider, opts) { this._entries.push(_entry('lastUser', 'wrap', provider, opts)); return this; }

  // ── 点位③ 末尾追加 ──
  /** 末尾追加一条独立消息。provider(ctx)=>string|null。 */
  useAppend(provider, opts) { this._entries.push(_entry('append', 'insert', provider, opts)); return this; }

  /**
   * 拼装：base → 按点位应用所有注入器 → 最终 messages。
   * @param {Array} base [{role:'system',content}, ...messages]
   * @param {object} ctx 透传给 provider 的只读上下文
   * @returns {Array} 新 messages 数组（纯函数，不修改 base）
   */
  assemble(base, ctx) {
    const msgs = [...(base || [])];
    const sorted = [...this._entries].sort((a, b) => a.order - b.order);

    // ① system：先处理 replace（取 order 最小者），再 append（叠加）
    let systemReplaced = null;
    for (const e of sorted) {
      if (e.slot !== 'system') continue;
      const val = e.provider(ctx);
      if (val == null || val === '') continue;
      if (e.form === 'replace') {
        if (systemReplaced === null) systemReplaced = val;
      }
    }
    const sysIdx = msgs.findIndex(m => m.role === 'system');
    if (systemReplaced !== null) {
      if (sysIdx >= 0) msgs[sysIdx] = { role: 'system', content: systemReplaced };
      else msgs.unshift({ role: 'system', content: systemReplaced });
    }
    for (const e of sorted) {
      if (e.slot !== 'system' || e.form !== 'append') continue;
      const val = e.provider(ctx);
      if (val == null || val === '') continue;
      if (sysIdx >= 0 || msgs.some(m => m.role === 'system')) {
        const i = msgs.findIndex(m => m.role === 'system');
        msgs[i] = { role: 'system', content: (msgs[i].content || '') + val };
      } else {
        msgs.unshift({ role: 'system', content: val });
      }
    }

    // ② 最近 user 处理：按 beforeLastUser → wrap → afterLastUser 顺序（各自内部再按 order）
    //    注意：before/after 插入会改变下标，故每类插入前重定位 lastUser。
    // beforeLastUser：在最近 user 前插独立消息（倒序插入避免下标漂移：同批多个 before 时，order 大的先插→order 小的排更前）
    for (const e of sorted.filter(x => x.slot === 'beforeLastUser').reverse()) {
      const val = e.provider(ctx);
      if (val == null || val === '') continue;
      const idx = _lastUserIdx(msgs);
      if (idx < 0) { msgs.push({ role: 'user', content: val }); continue; }
      msgs.splice(idx, 0, { role: 'user', content: val });
    }
    // wrap：前后缀改最近 user content（叠加，按 order）
    for (const e of sorted) {
      if (e.slot !== 'lastUser') continue;
      const val = e.provider(ctx);
      if (val == null) continue;
      const idx = _lastUserIdx(msgs);
      if (idx < 0) continue;
      const { prefix, suffix } = val;
      msgs[idx] = {
        ...msgs[idx],
        content: `${prefix || ''}${msgs[idx].content || ''}${suffix || ''}`,
      };
    }
    // afterLastUser：在最近 user 后插独立消息（正序插入：order 小的排更靠近 user）
    for (const e of sorted.filter(x => x.slot === 'afterLastUser')) {
      const val = e.provider(ctx);
      if (val == null || val === '') continue;
      const idx = _lastUserIdx(msgs);
      if (idx < 0) { msgs.push({ role: 'user', content: val }); continue; }
      msgs.splice(idx + 1, 0, { role: 'user', content: val });
    }

    // ③ 末尾追加
    for (const e of sorted) {
      if (e.slot !== 'append') continue;
      const val = e.provider(ctx);
      if (val == null || val === '') continue;
      msgs.push({ role: 'user', content: val });
    }

    return msgs;
  }

  /** 仅供诊断/测试：已注册注入器摘要。 */
  list() { return this._entries.map(e => ({ slot: e.slot, form: e.form, order: e.order, name: e.name })); }
}