/**
 * Agent UI 组件注册表
 *
 * 编译时通过 Vite import.meta.glob 自动发现 agents/{id}/ui/ 下的组件。
 * 新增 agent UI = 在 agents/{agentId}/ui/ 下放 manifest.json + 组件 = 自动生效。
 * 无需手动注册、无需改 SPA 代码。
 */

// import.meta.glob 相对路径从模块文件出发。从 src/pluginRegistry.jsx 到项目根 agents/ 需两级
//   frontend/src/ → ../.. → project root（同 git root）
const manifestModules = import.meta.glob('../../agents/*/ui/manifest.json', {
  eager: true,
  import: 'default',
});

// 发现所有 UI 组件入口（非 eager，运行时才加载）
const componentModules = import.meta.glob('../../agents/*/ui/**/index.{jsx,js}', {
  eager: false,
});

// 构建 agentId → manifest 映射
const agentManifests = {};
for (const [path, manifest] of Object.entries(manifestModules)) {
  // path: ../../../agents/elf-018/ui/manifest.json
  const match = path.match(/\/agents\/([^/]+)\/ui\/manifest\.json$/);
  if (match) {
    agentManifests[match[1]] = manifest;
  }
}

/**
 * 获取 agent 的 UI manifest
 * @param {string} agentId
 * @returns {object|null} { uiType, page, config }
 */
export function getAgentManifest(agentId) {
  return agentManifests[agentId] || null;
}

/**
 * 动态加载 agent 的自定义组件
 * @param {string} agentId
 * @param {string} componentName — manifest 里声明的组件名，如 "DnDChatView"
 * @returns {Promise<React.Component|null>}
 */
export async function loadAgentComponent(agentId, componentName) {
  const prefix = `../../agents/${agentId}/ui/${componentName}`;
  const candidates = [
    `${prefix}/index.jsx`, `${prefix}.jsx`,
    `${prefix}/index.js`, `${prefix}.js`,
  ];

  for (const p of candidates) {
    const loader = componentModules[p];
    if (loader) {
      try {
        const mod = await loader();
        return mod.default || mod;
      } catch (e) {
        console.warn(`[pluginRegistry] failed to load ${p}:`, e);
        return null;
      }
    }
  }
  return null;
}