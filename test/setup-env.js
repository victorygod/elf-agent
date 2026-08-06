/**
 * 测试环境统一隔离引导（经 `node --import ./test/setup-env.js --test ...` 注入）。
 *
 * 在所有测试模块（及其 import 的 gateway/engine 模块）加载前，于顶层设好 env。
 * 只设「对所有测试都安全」的全局隔离，避免破坏断言真实默认行为的单测：
 *  - ELF_LOG_DIR：日志独立 tmp 目录 → 测试日志不写真实 profiles/logs/gateway.log
 *  - ELF_PROFILES_ROOT：数据落地 tmp → 不污染真实 profiles/（具体测试可覆盖为各自 tmp）
 *
 * 不在此设（仅 spawn 真实 agent 的集成测试自设，避免破坏单测断言）：
 *  - ELF_PORT_OFFSET：integration.test 自设（私聊 agent 监听端口偏移，与真实 808x 隔离）
 *  - ELF_FORCE_MOCK_MODEL：integration.test 自设（mock model，不连真实 LLM）
 *
 * 只在未设置时填默认值，允许单测用自身 env 覆盖。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// 记录本引导自己创建的隔离目录，进程退出时（全绿才）清理。
// 各测试自设的 ELF_PROFILES_ROOT 由它们各自 after 清理，不在此处理。
const _created = [];

if (!process.env.ELF_LOG_DIR) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-test-logs-'));
  process.env.ELF_LOG_DIR = d;
  _created.push(d);
}
if (!process.env.ELF_PROFILES_ROOT) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'elf-test-profiles-'));
  process.env.ELF_PROFILES_ROOT = d;
  _created.push(d);
}

// 多用户鉴权（docs/multi-user-auth-design.md）：测试默认跳过 auth（req.user = 内置 u_test 管理员），
//   并固定密钥 env（防 loadGatewayConfig 生成密钥写 profiles/auth.json —— 虽在 tmp 下，固定值让断言稳定）。
//   auth 自身的测试（auth.test.js）在文件内显式 process.env.ELF_SKIP_AUTH = '' 关闭旁路。
if (!process.env.ELF_SKIP_AUTH) {
  process.env.ELF_SKIP_AUTH = '1';
}
if (!process.env.ELF_JWT_SECRET) {
  process.env.ELF_JWT_SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef';
}
if (!process.env.ELF_INTERNAL_TOKEN) {
  process.env.ELF_INTERNAL_TOKEN = 'test-internal-token-0123456789abcdef0123456789';
}

// 进程退出清理：仅当本测试文件全绿（exitCode===0）时删除本引导建的隔离目录。
//   有失败则保留，便于排查（日志/runtime 都还在）。多文件并行时每个文件子进程
//   各自判定——通过的文件清自己的，失败的留下。
process.on('exit', () => {
  if (process.exitCode !== 0) return;
  for (const d of _created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});