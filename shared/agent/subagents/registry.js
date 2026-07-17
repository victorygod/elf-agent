/**
 * subagent 配置注册表（内置）
 *
 * subagent 类型定义：agentType / whenToUse / tools|disallowedTools / getSystemPrompt / criticalSystemReminder。
 * - 类型定义内置（用户不改），用户只在 config.json 的 `subagents` 字段勾选启用集（见 docs/subagent-design.md §3.3b）。
 * - model 本期不设（子 agent inherit 主 agent 模型，见 §四差异2）。
 * - Explore disallowedTools 含 Agent 自身 → 禁止嵌套（§1.3 C）。
 */

const EXPLORE_SYSTEM_PROMPT = `You are an expert software reviewer and code exploration assistant. Your goal is to thoroughly explore the codebase and answer the user's questions accurately.

## Critical Rules
- This is a READ-ONLY task. You CANNOT edit, write, create, or delete files.
- Do not run commands that modify state (no mkdir/touch/rm/cp/mv/git add/commit/npm install/...). Bash is limited to read-only commands (ls/git status/git log/git diff/find/grep/cat/head/tail).
- Do not write to /tmp or use output redirection (> >> |).

## How to Work
- Use Glob/Grep to find files/code, Read to read content, Bash only for read-only commands.
- Call tools in parallel when possible (they run concurrently).
- Return absolute file paths in your findings.

## Output
- Report findings directly as text. Do not create files.
- Be thorough: the caller specifies thoroughness (quick / medium / very thorough) in the task prompt.`;

const GENERAL_PURPOSE_SYSTEM_PROMPT = `You are a general-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. You can read and modify files.

## How to Work
- You have an independent context: you cannot see the parent conversation. The task prompt is your only input — follow it carefully.
- Call tools in parallel when possible (read-only tools run concurrently).
- Use the tools needed to complete the task: read, search, edit, write, run commands.

## Output
- When the task is done, summarize what you did and the final result as text.`;

const subagentDefinitions = {
  'Explore': {
    agentType: 'Explore',
    whenToUse: '只读检索 agent:按 pattern 找文件、搜代码关键词、回答代码库问题。快、广撒网。靠只读工具并发(并发工程提供),不靠模型差异。',
    disallowedTools: ['Agent', 'Edit', 'Write'],   // ★ 含 Agent 自身 → 禁止嵌套
    getSystemPrompt: () => EXPLORE_SYSTEM_PROMPT,
    criticalSystemReminder: 'CRITICAL: 这是只读任务。你不能编辑/写/删文件,只能用只读命令。',
  },
  'general-purpose': {
    agentType: 'general-purpose',
    whenToUse: '通用 agent:研究复杂问题、多步执行、可改文件。工具全开,继承主模型。',
    tools: ['*'],
    getSystemPrompt: () => GENERAL_PURPOSE_SYSTEM_PROMPT,
    criticalSystemReminder: null,
  },
};

/**
 * 取启用的 subagent 定义（按 config.subagents 过滤）
 * @param {string[]} enabledTypes - config.subagents 启用集
 * @returns {Record<string, object>} 启用的定义
 */
export function getEnabledSubagents(enabledTypes = []) {
  const result = {};
  for (const t of enabledTypes) {
    if (subagentDefinitions[t]) {
      result[t] = subagentDefinitions[t];
    }
  }
  return result;
}

/**
 * 取单个 subagent 定义
 */
export function getSubagentDefinition(type) {
  return subagentDefinitions[type] || null;
}

/**
 * 列出所有内置类型名（config-ui field.options 用）
 */
export function listAllSubagentTypes() {
  return Object.keys(subagentDefinitions);
}
