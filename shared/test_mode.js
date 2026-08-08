/**
 * test mode 统一判定 + 隔离引导（全仓唯一处用 process.argv 判 --test）。
 *
 * 取代旧 test/setup-env.js（靠 `--import` 预加载，bare `node --test` 漏带即失效，曾导致
 * 测试 ProcessManager 打到真实 8180、ensureServerUp 杀生产 agent-server）。
 * 现改为：被 shared/profiles_paths.js 顶部 import → 任何 import 平台模块的测试 transitively
 * 触发本模块；在 logger.js 缓存 LOG_DIR 之前、在首次 profilesRoot()/ProcessManager 构造之前
 * 设好全部隔离 env。生产 `node gateway/index.js` argv 无 --test → 零副作用。
 *
 * isTestMode 是全仓唯一标志：需要按 test mode 显式分支的地方 `import { isTestMode }`，
 * 不要再重复判 process.argv。大多数代码无需感知——直接读 env（ELF_PORT_OFFSET 等）即可。
 *
 * 只在未设置时填默认值，允许单测用自身 env 覆盖（如 auth.test 显式 ELF_SKIP_AUTH=''）。
 * 不在此设（仅 spawn 真实 agent 的集成测试自设）：ELF_FORCE_MOCK_MODEL。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const isTestMode =
  process.argv.includes('--test') || !!process.env.NODE_TEST_CONTEXT;
// 说明:Node 测试 runner 把 `--test` 留在父进程,每个测试文件在**子进程**里跑、其 argv 不含 `--test`,
//   但 Node 给子进程设 `NODE_TEST_CONTEXT=child-*`。故二者取或:argv 检查覆盖父进程(若它 import 平台模块),
//   NODE_TEST_CONTEXT 覆盖测试子进程(本模块实际生效处)。生产 `node gateway/index.js` 两者皆无 → false。

// 记录本引导自己创建的隔离目录，进程退出时（全绿才）清理。
const _created = [];

if (isTestMode) {
  // ① 日志独立 tmp → 测试日志不写真实 profiles/logs/gateway.log
  if (!process.env.ELF_LOG_DIR) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-test-logs-'));
    process.env.ELF_LOG_DIR = d;
    _created.push(d);
  }
  // ② 数据落地 tmp → 不污染真实 profiles/（具体测试可覆盖为各自 tmp）
  if (!process.env.ELF_PROFILES_ROOT) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-test-profiles-'));
    process.env.ELF_PROFILES_ROOT = d;
    _created.push(d);
  }
  // ③ 共享 agent-server 端口偏移（8180 + 10000 → 18180），与真实 8180 隔离。
  //    让 gateway.test/auth.test 等未自设偏移的测试，其 ProcessManager.server.port 也落 18180，
  //    ensureServerUp/stopServer 只打测试段，不再误杀真实 agent-server（首刀，根因见 plan 文档）。
  if (!process.env.ELF_PORT_OFFSET) {
    process.env.ELF_PORT_OFFSET = '10000';
  }
  // ④ 多用户鉴权：测试默认跳过 auth（req.user = 内置 u_test 管理员）；固定密钥防写真实 auth.json。
  //    auth.test 在文件内显式 ELF_SKIP_AUTH='' 关闭旁路（import 在其覆写之前，per-request 读，无碍）。
  if (!process.env.ELF_SKIP_AUTH) process.env.ELF_SKIP_AUTH = '1';
  if (!process.env.ELF_JWT_SECRET) process.env.ELF_JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef';
  if (!process.env.ELF_INTERNAL_TOKEN) process.env.ELF_INTERNAL_TOKEN = 'test-internal-token-0123456789abcdef0123456789';

  // ⑤ agents 目录 tmp 副本：测试 PUT /agents/:id/config 写 tmp,不触生产 agent-server 的 fs.watch
  //    热重载（热重载在飞回合会崩共享 agent-server,见 docs/test-runtime-isolation-plan.md / agent-server-adopt-priority.md）。
  //    复制 cwd/agents → dst/agents；再在 dst 建 engine、shared 符号链接指回真实——因 create_agent.js 用
  //    相对 import ../../engine、../../shared,纯复制会断引用。agents/ ~18MB;串行峰值一份,退出清。
  if (!process.env.ELF_AGENTS_DIR) {
    const cwd = process.cwd();
    const src = path.join(cwd, 'agents');
    if (fs.existsSync(src)) {
      const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-test-agents-'));
      try {
        fs.cpSync(src, path.join(dst, 'agents'), { recursive: true });
        try { fs.symlinkSync(path.join(cwd, 'engine'), path.join(dst, 'engine'), 'dir'); } catch (e) { /* ignore */ }
        try { fs.symlinkSync(path.join(cwd, 'shared'), path.join(dst, 'shared'), 'dir'); } catch (e) { /* ignore */ }
        process.env.ELF_AGENTS_DIR = path.join(dst, 'agents');
        _created.push(dst);
      } catch (e) {
        try { fs.rmSync(dst, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.warn(`[elf] test mode on → port_offset=10000 skip_auth=1 profiles=<tmp> logs=<tmp> agents=<tmp copy>`);

  // 进程退出清理：仅全绿（exitCode===0）时删本引导建的隔离目录；有失败则保留排查。
  // 多文件各自子进程判定——通过的清自己的，失败的留下。
  process.on('exit', () => {
    if (process.exitCode !== 0) return;
    for (const d of _created) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  });
}