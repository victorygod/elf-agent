/**
 * Prompt 注入器装配 helper —— 把 config 的 prefix_prompt/suffix_prompt 注册成 PromptAssembler 的注入器。
 *
 * 取代旧 elf-001/003 mm 子类重写 getMessagesForLLM 拼前后缀的做法。
 * 注入器读 config（热更新时 config 实例重读，注入器每轮 assemble provider 取最新值）。
 *
 * 群聊语义：群聊（ctx.agent.runContext.mode==='room'）下不拼 prefix/suffix——对齐旧 elf-001 子类
 *   "群聊 1:1 语境不适用 prefix/suffix" 设计；顺带消除旧 elf-003 群聊也拼 prefix 的不一致 bug。
 *
 * @param {PromptAssembler} assembler
 * @param {Config} config
 */
export function registerPrefixSuffixInjectors(assembler, config) {
  const get = (k) => {
    try { return config?.get?.(k) || ''; } catch (e) { console.warn(`[injectors] 读 config 字段 ${k} 失败: ${e.message}`); return ''; }
  };
  // 群聊模式跳过 prefix/suffix（只由 RoomPlugin 注册 roster 注入器）
  const isRoom = (ctx) => ctx?.agent?.runContext?.mode === 'room';
  // 前缀：拼到最近 user content 前
  assembler.useWrapLastUser((ctx) => {
    if (isRoom(ctx)) return null;
    const prefix = get('prefix_prompt');
    return prefix ? { prefix } : null;
  }, { order: 100, name: 'prefix_prompt' });
  // 后缀：拼到最近 user content 后
  assembler.useWrapLastUser((ctx) => {
    if (isRoom(ctx)) return null;
    const suffix = get('suffix_prompt');
    return suffix ? { suffix } : null;
  }, { order: 110, name: 'suffix_prompt' });
}