/**
 * 工具注册表
 *
 * 管理已注册的工具，供 Agent Loop 查询和执行
 */

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  /**
   * 注册工具
   * @param {object} tool - 工具定义 { name, description, parameters, execute }
   */
  register(tool) {
    this.tools.set(tool.name, tool);
  }

  /**
   * 获取工具
   */
  get(name) {
    return this.tools.get(name);
  }

  /**
   * 获取所有工具定义（用于 LLM tools 参数）
   */
  getAll() {
    return Array.from(this.tools.values());
  }

  /**
   * 执行工具
   * @param {string} name - 工具名称
   * @param {object} args - 工具参数
   * @returns {Promise<string>} 工具执行结果
   */
  async execute(name, args) {
    const tool = this.tools.get(name);
    if (!tool) {
      return `[错误: 工具 "${name}" 不存在]`;
    }
    try {
      return await tool.execute(args);
    } catch (err) {
      return `[工具执行错误: ${err.message}]`;
    }
  }
}