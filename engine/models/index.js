/**
 * 模型层 barrel —— 统一导出 LLMModel / MockModel
 * MockModel 与 LLMModel 接口完全一致（provider==='mock' 时切换），见 build_agent.js
 */
export { LLMModel } from './llm.js';
export { MockModel } from './mock.js';