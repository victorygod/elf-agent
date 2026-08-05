/**
 * elf-018 专属后端 API 路由
 *
 * 原在 gateway/server.js 写死，现在收回 agent 目录。
 * gateway 启动时自动扫描注册（gateway/plugin-loader.js）。
 */

import fs from 'fs';
import path from 'path';

import { buildMetadata } from '../../../shared/agents/elf-018/buildMetadata.js';
import { parseFrontmatter } from '../../../engine/skills/parser.js';
import { LLMModel } from '../../../engine/models/llm.js';
import { agentMemory, roomsRoot } from '../../../shared/profiles_paths.js';
import { listCheckpoints } from '../../../gateway/snapshot.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('elf-018-polish', 'gateway.log');

// ===== 常量 =====
const STYLES_NAME_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_STYLE_FILE = 'default_style.md';

// ===== 辅助 =====
function stylesDirOf(pm, id) {
  return path.join(pm.agentsDir, id, 'config', 'styles');
}

function safeStylePath(pm, id, fileName) {
  const root = path.resolve(stylesDirOf(pm, id));
  const resolved = path.resolve(root, fileName);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw Object.assign(new Error('path escape detected'), { statusCode: 400 });
  }
  return resolved;
}

function assembleStyleFile(description, body) {
  return `---\ndescription: ${String(description).trim()}\n---\n\n${String(body).trim()}\n`;
}

function validateStyleInput(name, description, body) {
  if (!name || !STYLES_NAME_RE.test(name)) return 'name 非法（仅 A-Za-z0-9._-，不带 .md）';
  if (!String(description ?? '').trim()) return 'description 必填';
  if (!String(body ?? '').trim()) return 'body 必填';
  return null;
}

function parseFm(txt) {
  const fm = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return name ? { name, description: desc || '' } : null;
}

export default function register(pm, agentId) {

  // ===== GET /game-state =====
  const gameState = async (req, res) => {
    const loreDir = path.join(agentMemory(agentId), 'runtime', 'lore');
    const readFull = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } };
    const scan = (sub) => {
      const dir = path.join(loreDir, sub);
      const out = [];
      try {
        for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md') && !x.endsWith('.prev.md'))) {
          const txt = readFull(path.join(dir, f));
          const e = parseFm(txt);
          if (e) out.push({ ...e, content: txt, path: path.join(dir, f) });
        }
      } catch {}
      return out;
    };

    const protPath = path.join(loreDir, 'user_profile.md');
    const protTxt = readFull(protPath);
    const protagonist = protTxt ? { ...(parseFm(protTxt) || {}), content: protTxt, path: protPath } : null;
    const characters = scan('characters');
    const locations = scan('locations');
    const quests = scan('quests');
    const items = scan('items');
    const skills = scan('skills');
    const state = (() => {
      const p = path.join(loreDir, 'state.md');
      const t = readFull(p);
      const e = parseFm(t);
      return e ? { ...e, content: t, path: p } : null;
    })();
    const metadata = buildMetadata(loreDir);

    res.json({ protagonist, characters, locations, quests, items, skills, state, metadata });
  };

  // ===== GET /styles =====
  const listStyles = async (req, res) => {
    const dir = stylesDirOf(pm, agentId);
    const out = [];
    try {
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md') && !x.endsWith('.prev.md')).sort()) {
        const { frontmatter, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf-8'));
        out.push({
          filename: f,
          name: f.replace(/\.md$/, ''),
          description: (frontmatter.description || '').trim(),
          body: body.trim(),
          isDefault: f === DEFAULT_STYLE_FILE,
        });
      }
    } catch {}
    res.json({ styles: out, defaultFile: DEFAULT_STYLE_FILE });
  };

  // ===== POST /styles =====
  const createStyle = async (req, res) => {
    const { name, description, body } = req.body || {};
    const err = validateStyleInput(name, description, body);
    if (err) return res.status(400).json({ error: err });
    if (name + '.md' === DEFAULT_STYLE_FILE) return res.status(400).json({ error: 'default_style 已固定存在，无需新建' });
    let p;
    try { p = safeStylePath(pm, agentId, name + '.md'); } catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }
    if (fs.existsSync(p)) return res.status(409).json({ error: '已存在 ' + name + '.md，请换个名字' });
    fs.mkdirSync(stylesDirOf(pm, agentId), { recursive: true });
    fs.writeFileSync(p, assembleStyleFile(description, body), 'utf-8');
    res.json({ ok: true, filename: name + '.md' });
  };

  // ===== PUT /styles/:filename =====
  const updateStyle = async (req, res) => {
    const oldFile = req.params.filename;
    const { name, description, body } = req.body || {};
    const err = validateStyleInput(name, description, body);
    if (err) return res.status(400).json({ error: err });
    const newFile = name + '.md';
    if (oldFile === DEFAULT_STYLE_FILE && newFile !== DEFAULT_STYLE_FILE) return res.status(400).json({ error: 'default_style 不可改名' });
    if (newFile === DEFAULT_STYLE_FILE && oldFile !== DEFAULT_STYLE_FILE) return res.status(400).json({ error: '不可改名为 default_style' });
    let oldPath, newPath;
    try { oldPath = safeStylePath(pm, agentId, oldFile); newPath = safeStylePath(pm, agentId, newFile); }
    catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: oldFile + ' 不存在' });
    if (newFile !== oldFile && fs.existsSync(newPath)) return res.status(409).json({ error: '目标名 ' + newFile + ' 已存在' });
    fs.writeFileSync(newPath, assembleStyleFile(description, body), 'utf-8');
    if (newFile !== oldFile) { try { fs.rmSync(oldPath, { force: true }); } catch {} }
    res.json({ ok: true, filename: newFile });
  };

  // ===== DELETE /styles/:filename =====
  const deleteStyle = async (req, res) => {
    const f = req.params.filename;
    if (f === DEFAULT_STYLE_FILE) return res.status(400).json({ error: 'default_style 不可删除' });
    let p;
    try { p = safeStylePath(pm, agentId, f); } catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }
    try { fs.rmSync(p, { force: true }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  };

  // ===== seeds 读取 =====
  const seedsDir = path.join(pm.agentsDir, agentId, 'config', 'seeds', 'lore');

  /** 递归读取 seeds 目录，返回每个 lore 类型的种子列表 */
  const getSeeds = async (req, res) => {
    const out = {};
    for (const type of ['characters', 'items', 'locations', 'skills', 'quests']) {
      const dir = path.join(seedsDir, type);
      const files = [];
      try {
        for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
          const txt = fs.readFileSync(path.join(dir, f), 'utf-8');
          const { frontmatter, body } = parseFrontmatter(txt);
          files.push({
            filename: f,
            name: f.replace(/\.md$/, ''),
            description: (frontmatter.description || '').trim(),
            body: body.trim(),
          });
        }
      } catch {}
      out[type] = files;
    }
    // 读 user_profile 种子模板
    const upPath = path.join(seedsDir, 'user_profile.md');
    try {
      const txt = fs.readFileSync(upPath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(txt);
      out.userProfile = {
        name: (frontmatter.name || '').trim(),
        description: (frontmatter.description || '').trim(),
        body: body.trim(),
      };
    } catch {
      out.userProfile = null;
    }
    res.json(out);
  };

  // ===== 记录集通用工具（lore 实体，文件名含中文等字符）=====
  const LORE_TYPES = new Set(['characters', 'items', 'locations', 'skills', 'quests']);

  function loreDirOf(id, type) {
    return path.join(agentMemory(id), 'runtime', 'lore', type);
  }

  function safeLorePath(id, type, fileName) {
    const root = path.resolve(loreDirOf(id, type));
    const resolved = path.resolve(root, fileName);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw Object.assign(new Error('path escape detected'), { statusCode: 400 });
    }
    return resolved;
  }

  function assembleLoreFile(name, description, body) {
    const safeDesc = (description || '').trim();
    return `---\nname: ${name}\ndescription: ${safeDesc}\n---\n\n${(body || '').trim()}\n`;
  }

  // ===== GET /lore/:type — 列某个 lore 类型的所有实体 =====
  const listLore = async (req, res) => {
    const type = req.params.type;
    if (!LORE_TYPES.has(type)) return res.status(400).json({ error: '无效的 lore 类型' });
    const dir = loreDirOf(agentId, type);
    const out = [];
    try {
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md') && !x.endsWith('.prev.md')).sort()) {
        const txt = fs.readFileSync(path.join(dir, f), 'utf-8');
        const { frontmatter, body } = parseFrontmatter(txt);
        out.push({
          filename: f,
          name: (frontmatter.name || '').trim(),
          description: (frontmatter.description || '').trim(),
          body: body.trim(),
        });
      }
    } catch {}
    res.json({ entities: out });
  };

  // ===== POST /lore/:type — 新建 lore 实体 =====
  const createLore = async (req, res) => {
    const type = req.params.type;
    if (!LORE_TYPES.has(type)) return res.status(400).json({ error: '无效的 lore 类型' });
    const { name, description, body } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name 必填' });
    // 文件名规范化：中英文数字下划线连字符点
    const fileName = name.trim().replace(/[^\w.一-鿿-]/g, '_') + '.md';
    let p;
    try { p = safeLorePath(agentId, type, fileName); } catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }
    if (fs.existsSync(p)) return res.status(409).json({ error: '已存在同名文件' });
    fs.mkdirSync(loreDirOf(agentId, type), { recursive: true });
    fs.writeFileSync(p, assembleLoreFile(name.trim(), description, body), 'utf-8');
    res.json({ ok: true, filename: fileName });
  };

  // ===== PUT /lore/:type/:filename — 更新 lore 实体 =====
  const updateLore = async (req, res) => {
    const type = req.params.type;
    if (!LORE_TYPES.has(type)) return res.status(400).json({ error: '无效的 lore 类型' });
    const oldFile = req.params.filename;
    const { name, description, body } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name 必填' });
    const newFileName = name.trim().replace(/[^\w.一-鿿-]/g, '_') + '.md';
    let oldPath, newPath;
    try { oldPath = safeLorePath(agentId, type, oldFile); newPath = safeLorePath(agentId, type, newFileName); }
    catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: oldFile + ' 不存在' });
    if (newFileName !== oldFile && fs.existsSync(newPath)) return res.status(409).json({ error: '目标名 ' + newFileName + ' 已存在' });
    fs.writeFileSync(newPath, assembleLoreFile(name.trim(), description, body), 'utf-8');
    if (newFileName !== oldFile) { try { fs.rmSync(oldPath, { force: true }); } catch {} }
    res.json({ ok: true, filename: newFileName });
  };

  // ===== DELETE /lore/:type/:filename — 删 lore 实体 =====
  const deleteLore = async (req, res) => {
    const type = req.params.type;
    if (!LORE_TYPES.has(type)) return res.status(400).json({ error: '无效的 lore 类型' });
    const f = req.params.filename;
    let p;
    try { p = safeLorePath(agentId, type, f); } catch (e) { return res.status(e.statusCode || 400).json({ error: e.message }); }
    try { fs.rmSync(p, { force: true }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  };

  // ===== PUT /user-profile — 写主角面板（name + body，全量覆盖）=====
  const updateUserProfile = async (req, res) => {
    const { name, body } = req.body || {};
    const protPath = path.join(agentMemory(agentId), 'runtime', 'lore', 'user_profile.md');
    try {
      let txt = '';
      if (fs.existsSync(protPath)) txt = fs.readFileSync(protPath, 'utf-8');
      const nameVal = String(name ?? '').trim();
      const bodyVal = String(body ?? '').trim();
      // 保留 frontmatter 或新建
      const fmMatch = txt.match(/^---\n[\s\S]*?\n---\n?/);
      if (fmMatch) {
        let fm = fmMatch[0];
        fm = fm.replace(/^name:.*$/m, nameVal ? 'name: ' + nameVal : 'name:');
        if (bodyVal) {
          txt = fm + bodyVal;
        } else {
          txt = fm;
        }
      } else {
        txt = '---\nname: ' + nameVal + '\ndescription: \n---\n\n' + bodyVal;
      }
      fs.writeFileSync(protPath, txt, 'utf-8');
      res.json({ ok: true, name: nameVal });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };

  // ===== 存档管理 =====
  const memoryDir = agentMemory(agentId);

  /** 复制目录（递归） */
  function _copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const s = path.join(src, entry);
      const d = path.join(dest, entry);
      if (fs.statSync(s).isDirectory()) {
        _copyDir(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }

  /** savings 目录 */
  function _savingsDir() { return path.join(memoryDir, 'savings'); }
  function _saveDir(name) { return path.join(_savingsDir(), name); }

  // POST /save — 存档：拷贝 runtime + checkpoints + context + tool-results + sync_cursor + history
  //    重名时 force=true 先删旧存档再写入
  const saveGame = async (req, res) => {
    const { name, force } = req.body || {};
    const saveName = String(name || '').trim();
    if (!saveName) return res.status(400).json({ error: '存档名必填' });
    const dest = _saveDir(saveName);
    if (fs.existsSync(dest)) {
      if (force) {
        fs.rmSync(dest, { recursive: true, force: true });
      } else {
        return res.status(409).json({ error: '存档名已存在' });
      }
    }
    try {
      // runtime（lore/outline/scene 等）
      const runtimeDir = path.join(memoryDir, 'runtime');
      if (fs.existsSync(runtimeDir)) _copyDir(runtimeDir, path.join(dest, 'runtime'));
      // 整个 checkpoints 目录（保留全部快照，读档后可继续 rewind）
      const cpDir = path.join(memoryDir, 'checkpoints');
      if (fs.existsSync(cpDir)) _copyDir(cpDir, path.join(dest, 'checkpoints'));
      // context.json + tool-results + sync_cursor
      for (const fn of ['context.json', 'sync_cursor.json']) {
        const f = path.join(memoryDir, fn);
        if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dest, fn));
      }
      const trDir = path.join(memoryDir, 'tool-results');
      if (fs.existsSync(trDir)) _copyDir(trDir, path.join(dest, 'tool-results'));
      // 私聊房 history
      const roomHistoryPath = path.join(roomsRoot(), 'chat-' + agentId, 'history.jsonl');
      if (fs.existsSync(roomHistoryPath)) fs.copyFileSync(roomHistoryPath, path.join(dest, 'room-history.jsonl'));
      // 存档元信息：记录当前轮次（数 outline/round-N.md 文件数 = 已完成的轮数）
      let round = 0;
      try {
        const outlineDir = path.join(memoryDir, 'runtime', 'outline');
        round = fs.readdirSync(outlineDir).filter(f => /^round-[1-9]\d*\.md$/.test(f)).length;
      } catch {}
      fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify({
        name: saveName,
        round,
        createdAt: new Date().toISOString(),
      }), 'utf-8');
      res.json({ ok: true, name: saveName, round });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };

  // GET /saves — 列出所有存档
  const listSaves = async (req, res) => {
    const dir = _savingsDir();
    const out = [];
    try {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
          const stat = fs.statSync(full);
          // 读 meta.json 取 round（存档时的轮次）；无 meta 退化为 0
          let round = 0;
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(full, 'meta.json'), 'utf-8'));
            round = meta.round || 0;
          } catch {}
          out.push({
            name: entry,
            createdAt: stat.birthtimeMs || stat.mtimeMs,
            round,
          });
        }
      }
    } catch {}
    out.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ saves: out });
  };

  // POST /load-save — 加载存档：恢复 runtime + checkpoints + context.json + tool-results + history
  //    不走 rewindTo（会销毁 checkpoint），保留全部快照以支持读档后继续 rewind
  const loadSave = async (req, res) => {
    const { name } = req.body || {};
    const saveName = String(name || '').trim();
    if (!saveName) return res.status(400).json({ error: '存档名必填' });
    const src = _saveDir(saveName);
    if (!fs.existsSync(src)) return res.status(404).json({ error: '存档不存在' });
    try {
      // 1. 恢复 runtime（含 lore/outline/scene 等）
      const srcRuntime = path.join(src, 'runtime');
      const liveRuntime = path.join(memoryDir, 'runtime');
      if (fs.existsSync(srcRuntime)) {
        if (fs.existsSync(liveRuntime)) fs.rmSync(liveRuntime, { recursive: true, force: true });
        _copyDir(srcRuntime, liveRuntime);
      }

      // 2. 恢复 checkpoints 目录（整份替换，保留全部快照）
      const srcCp = path.join(src, 'checkpoints');
      const liveCp = path.join(memoryDir, 'checkpoints');
      if (fs.existsSync(liveCp)) fs.rmSync(liveCp, { recursive: true, force: true });
      if (fs.existsSync(srcCp)) _copyDir(srcCp, liveCp);

      // 3. 恢复 context.json + tool-results + sync_cursor.json
      for (const name of ['context.json', 'sync_cursor.json']) {
        const sf = path.join(src, name);
        if (fs.existsSync(sf)) fs.copyFileSync(sf, path.join(memoryDir, name));
      }
      const srcTr = path.join(src, 'tool-results');
      const liveTr = path.join(memoryDir, 'tool-results');
      if (fs.existsSync(srcTr)) {
        if (fs.existsSync(liveTr)) fs.rmSync(liveTr, { recursive: true, force: true });
        _copyDir(srcTr, liveTr);
      }

      // 4. 恢复私聊房 history
      const srcHistory = path.join(src, 'room-history.jsonl');
      const roomHistoryPath = path.join(roomsRoot(), 'chat-' + agentId, 'history.jsonl');
      if (fs.existsSync(srcHistory) && fs.existsSync(roomHistoryPath)) {
        fs.copyFileSync(srcHistory, roomHistoryPath);
      }

      // 5. reload agent 进程（如 running）
      const port = pm?.getAgentPort?.(agentId);
      if (port) {
        fetch('http://127.0.0.1:' + port + '/reload/chat-' + agentId, { method: 'POST' })
          .catch(err => console.warn('[loadSave] agent reload 失败', err.message));
      }

      res.json({ ok: true, name: saveName });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };

  // DELETE /save/:name — 删除存档目录
  const deleteSave = async (req, res) => {
    const saveName = decodeURIComponent(req.params.name);
    const dest = _saveDir(saveName);
    if (!fs.existsSync(dest)) return res.status(404).json({ error: '存档不存在' });
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };

  // ===== AI 润色 =====
  const POLISH_SYS = `你是一个 DND 跑团游戏的设定文档撰写助手。请根据以下上下文完善当前条目。

规则：
1. 不得修改条目名称——frontmatter 的 name 字段必须与已有 name 一致
2. description 控制在 50 字以内，是一句话简介
3. 正文控制在 300 字以内
4. 只描述固定性信息（外观、氛围、地理/建筑/物品的固有特征、由来等），不要涉及可变量（如人物、当前事件、时间、状态、持有者等）——人物关系与剧情由 DM 在运行时演绎，设定文档只记不变的事实
5. 风格对齐参考文件，但严守上面的篇幅与内容约束
6. 涉及其它 lore 条目时用其名提及
7. 与主角设定不冲突
8. 若「已有正文」非空，在其基础上润色完善——保留其中的有效事实，补足缺失、修顺表达，不要丢弃用户已写的关键信息

输出格式：
- 完整的 Markdown 文件（含 frontmatter，frontmatter 含 name、description）
- 正文直接写内容，不要标题行（# xxx 一律不写）
- 不额外解释`;

  /** 从某 lore 类型目录随机取 ≤n 个文件全文，排除 frontmatter name 匹配 excludeName 的自身文件 */
  function _sampleLoreFiles(loreDir, type, n, excludeName) {
    const dir = path.join(loreDir, type);
    const out = [];
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.endsWith('.prev.md'));
      // 洗牌
      for (let i = files.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [files[i], files[j]] = [files[j], files[i]];
      }
      for (const f of files) {
        if (out.length >= n) break;
        const txt = fs.readFileSync(path.join(dir, f), 'utf-8');
        const { frontmatter } = parseFrontmatter(txt);
        if (excludeName && (frontmatter.name || '').trim() === excludeName) continue;   // 排除自身
        out.push({ filename: f, content: txt });
      }
    } catch {}
    return out;
  }

  // POST /polish-lore — AI 润色 lore 实体
  const polishLore = async (req, res) => {
    const { type, name, description, body } = req.body || {};
    if (!type || !name) return res.status(400).json({ error: 'type 和 name 必填' });
    const LORE_TYPES = new Set(['characters', 'items', 'locations', 'skills']);
    if (!LORE_TYPES.has(type)) return res.status(400).json({ error: '无效的 lore 类型' });

    logger.info(`[polish] 开始 agent=${agentId} type=${type} name=${name} desc.len=${(description||'').length} body.len=${(body||'').length}`);
    try {
      const loreDir = path.join(agentMemory(agentId), 'runtime', 'lore');

      // 1. 读 system_prompt
      const sysPrompt = (() => {
        try { return fs.readFileSync(path.join(pm.agentsDir, agentId, 'config', 'system_prompt.md'), 'utf-8'); }
        catch { return ''; }
      })();

      // 2. 读 user_profile
      const userProfile = (() => {
        try { return fs.readFileSync(path.join(loreDir, 'user_profile.md'), 'utf-8'); }
        catch { return ''; }
      })();

      // 3. 各类型交叉参考（每类 ≤2，排除自身）
      const refsByType = {};
      for (const t of ['characters', 'items', 'locations', 'skills']) {
        refsByType[t] = _sampleLoreFiles(loreDir, t, 2, String(name).trim());
      }
      const refCount = Object.values(refsByType).reduce((s, a) => s + a.length, 0);

      // 4. 组装单条 user 消息
      const parts = ['## 世界观基底', sysPrompt, '## 主角面板', userProfile, '## 现存设定参考'];
      for (const t of ['characters', 'items', 'locations', 'skills']) {
        const label = { characters: '角色', items: '物品', locations: '地点', skills: '技能' }[t];
        parts.push('### ' + label);
        if (refsByType[t].length === 0) { parts.push('（暂无）'); continue; }
        for (const r of refsByType[t]) {
          parts.push('#### ' + r.filename);
          parts.push(r.content);
        }
      }
      parts.push('## ===== 当前要润色的条目 =====');
      parts.push('名称：' + name);
      parts.push('描述：' + (description || ''));
      const bodyTrim = String(body || '').trim();
      if (bodyTrim) {
        parts.push('已有正文（草稿，请在其基础上润色完善，不要丢弃其中的有效信息）：');
        parts.push(bodyTrim);
      } else {
        parts.push('已有正文：（无，请从头撰写）');
      }
      const userMsg = parts.join('\n\n');

      // 5. 读 api_key.json 构造 model
      const apiKey = JSON.parse(fs.readFileSync(path.join(pm.agentsDir, agentId, 'config', 'api_key.json'), 'utf-8'));
      const model = new LLMModel(apiKey);

      // 6. 非流式调 LLM
      logger.info(`[polish] 调 LLM model=${apiKey.model} refs=${refCount} userMsg.len=${userMsg.length}`);
      const llmOutput = await model.chat([
        { role: 'system', content: POLISH_SYS },
        { role: 'user', content: userMsg },
      ]);
      logger.info(`[polish] LLM 返回 len=${(llmOutput||'').length}`);

      // 7. parse frontmatter；name 由 modal 保留原值（前端不取 LLM 的 name），故不校验、不拒绝
      const { frontmatter, body } = parseFrontmatter(llmOutput);
      const genName = (frontmatter.name || '').trim();
      if (genName && genName !== String(name).trim()) {
        logger.info(`[polish] AI 改名 复写 原=${name} 生成=${genName}（已忽略，用原名）`);
      }
      const outDesc = (frontmatter.description || '').trim();
      const outBody = body.trim();
      logger.info(`[polish] 成功 desc.len=${outDesc.length} body.len=${outBody.length}`);
      res.json({ ok: true, description: outDesc, body: outBody });
    } catch (e) {
      logger.error(`[polish] 失败 agent=${agentId} type=${type} name=${name}: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  };

  return [
    { method: 'GET',    path: '/game-state',          handler: gameState },
    { method: 'GET',    path: '/styles',              handler: listStyles },
    { method: 'POST',   path: '/styles',              handler: createStyle },
    { method: 'PUT',    path: '/styles/:filename',    handler: updateStyle },
    { method: 'DELETE', path: '/styles/:filename',    handler: deleteStyle },
    { method: 'PUT',    path: '/user-profile',          handler: updateUserProfile },
    { method: 'GET',    path: '/seeds',               handler: getSeeds },
    { method: 'GET',    path: '/lore/:type',          handler: listLore },
    { method: 'POST',   path: '/lore/:type',          handler: createLore },
    { method: 'PUT',    path: '/lore/:type/:filename',handler: updateLore },
    { method: 'DELETE', path: '/lore/:type/:filename',handler: deleteLore },
    { method: 'POST',   path: '/save',                  handler: saveGame },
    { method: 'GET',    path: '/saves',                 handler: listSaves },
    { method: 'POST',   path: '/load-save',             handler: loadSave },
    { method: 'DELETE', path: '/save/:name',            handler: deleteSave },
    { method: 'POST',   path: '/polish-lore',           handler: polishLore },
  ];
}