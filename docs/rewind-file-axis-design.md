# Rewind 文件轴 P1 设计（CC 方案 A 复刻）

> 目标：给 rewind 补上"回退 Edit/Write 改过的文件"的能力（对标 CC `Restore code`），填上已落地 MVP（只回退对话三件套）缺的文件轴。
> 方案：忠实复刻 CC v2.1.209 的 `file-history` 机制（源码已实读核实，见附录函数表）——**每条 user 消息边界抓一张【全部追踪文件当前内容】的自包含快照，rewind 取目标那张逐文件覆盖**。即本轮讨论确定的"方案 A"。
> 上游 MVP（对话轴）设计见 `docs/archieve/rewind-design.md`。

---

## 一、范围

- **只动通用 agent 的 `engine/tools/{Edit,Write}.js`**。它们写的是项目里任意绝对路径的真实文件，不在已有 `dataDir/runtime` 快照范围内 → 这是当前缺口。
- **elf-018 不动**。其 Edit/Write 被 `isInsideLore` 约束只能写 `dataDir/runtime/lore`（`create_agent.js:46`），已被 `snapshot.js` 整目录快照+回退覆盖（存 :111-114 / 还 :235-238）。它把文件写死在已快照目录里，绕开了文件轴问题。

## 二、数据模型（CC `fileHistory` 机制的 elf 落地）

`dataDir`（= `agentRoomState(agentId, roomId)`）下新增两样：

```
dataDir/
  file-history/            # 备份本体目录（CC 同名）
    <sha16>@vN             #   文件内容备份；内容未变则复用同一文件（不重复拷贝）
  file-history.json        # 追踪注册表（跨轮持久；CC 用 log，elf 用单个 JSON 简化）
    {
      trackedFiles: [absPath...],
      snapshots: [ { cpId, messageId, trackedFileBackups: { absPath: { backupFileName, version } } } ],
      snapshotSequence
    }
```

要点（对齐 CC，省存储）：
- **未变复用**：`makeSnapshot` 对没变的追踪文件直接复用上一张的 `backupFileName`，snapshot 里只是个引用，不拷新文件（对应 CC `s0t` 的 `PJn` 复用分支）。
- **只有内容真变了才新增备份**：`<sha16>@vN`，sha16 = 文件路径哈希，N = version。
- checkpoint 目录维持现状（仍只装对话三件套）；文件轴状态全在 `file-history.json` 注册表里，靠 `cpId` 与 checkpoint 关联。

## 三、三个机制

### ① 写前钩子 `track`（Edit/Write 写盘前）
对应 CC：`t5e`(fileHistoryTrackEdit) → `vvu`(copyFile 当前内容 → file-history)。
```
Edit.js / Write.js execute(args, signal, ctx)：写盘前
  if (file 已在【当前轮 cp】trackedFileBackups) skip        // 同轮只存第一次（CC `_ve` 判定）
  backupFileName = copyFile(file 当前内容 → dataDir/file-history/<sha>@v1)
  file-history.json.snapshots[last].trackedFileBackups[file] = { backupFileName, version }
  trackedFiles.add(file)
```
elf 落点：`execute(args, signal, ctx)` 已注入 `ctx.agent`（`tool_manager.js:121`），取 `ctx.agent.messageManager.dataDir`（`message_manager.js:64`）即私聊房 dataDir，直接定位 file-history 目录。

### ② 发消息时 `makeSnapshot`（"边界抓全部 + 未变复用"）
对应 CC：`s0t`(fileHistoryMakeSnapshot)。并入现有 `snapshotBeforeSend`（`room_routes.js:319` 调）：建好 cpN 后，
```
for (file of file-history.json.trackedFiles):
  if (file 当前内容 == 上次备份)  复用 backupFileName          // PJn 省拷
  else                           copyFile → file-history/<sha>@vN
  cpN.trackedFileBackups[file] = { backupFileName, version }
push { cpId, messageId, trackedFileBackups } 进 snapshots
```
→ cpN 自包含那一刻所有追踪文件的**磁盘真实状态**（不分是谁改的）。

### ③ rewind `restore`（取目标那张逐文件覆盖）
对应 CC：`Q4r` → `sCg`。并入现有 `rewindTo`（`room_routes.js:431` / abort `process_manager.js:467`）：
```
for (file of targetCp.trackedFileBackups):
  if (backupFileName === null)            unlink(file)       // 快照时该文件不存在 → 删（撤回"没创建它"）
  elif (当前内容 !== targetCp 备份)        copyFile(backup → file)   // 变了才写，省冗余
  else                                    skip
注册表 snapshots 弹出 ≥ targetSeq 的（与 checkpoint 目录删除同步）
```

## 四、边界（与 CC 一致；写进 UI 文案）

| 情况 | rewind 文件轴结果 |
|---|---|
| Edit 改 F、Bash 没动 | F 精确回退 ✓ |
| Edit 改 F、Bash 又改它 | 覆盖回边界那版，**Bash 改动静默丢失**（CC 同款，不弹窗） |
| Edit 改 F 后，Bash 在"agent 没动 F 的轮"单独改 F | **方案 A 正确回退**（makeSnapshot 边界重抓到 Bash 改动）；方案 B 会漏，见附录 |
| Edit 新建 F | backup=null → rewind 时 unlink（F 撤回"没创建"） |
| Bash 独自改/删 Edit 从没碰过的文件 | 不在 trackedFiles → rewind 不碰（照搬 CC） |
| 远程副作用（DB/API/部署） | 不可回退，UI 提示 |

> MVP UI 文案统一："仅回退对话 + 被追踪本地文件；Bash/远程改动不在保证内"。

## 五、清理 / 淘汰

- **滑窗淘汰**（`MAX_CHECKPOINTS=10`）：删旧 checkpoint 时同步删 `file-history/` 里被淘汰且无人再引用的 backup（对应 CC `nCg`）。
- **`clearCheckpoints`**（清栈）一并删 `dataDir/file-history/` + 重置 `file-history.json`。

## 六、改动落点

| 文件 | 改动 |
|---|---|
| `engine/tools/Edit.js` / `Write.js` | execute 写盘前调 `shared/file_history.js` 的 `track(ctx, filePath)` |
| `shared/file_history.js`（新增） | `track` / `makeSnapshot` / `restore` / `checkOriginFileChanged` / 注册表读写 / 淘汰清理 |
| `gateway/snapshot.js` | `snapshotBeforeSend` 内调 `makeSnapshot`；`rewindTo` 内调 `restore`；`clearCheckpoints` 清 file-history |
| `gateway/room_routes.js` / `process_manager.js` | 无逻辑改动，复用现有 snapshot/rewind 调用点 |
| `agents/elf-018/tools/*` | **不改** |

## 七、测试

- `track`：Write/Edit 后 `file-history/` 有 pre-edit 备份；同轮二次改不重存。
- `makeSnapshot`：连发消息，每张 cp 自包含全部追踪文件当前内容；未变复用（无新 backup）。
- `restore`：rewind 后文件 = 边界内容；新建文件被 unlink；同轮/同毫秒不乱。
- **Bash 污染（方案 A 标志性用例）**：Edit F → Bash 改 F → rewind，F 回边界版本（这条证明 A 优于 B）。
- 淘汰：超 10 个 cp 旧 backup 被清；`clearCheckpoints` 清 file-history。
- integration：rewind 后 `snapshot.turns` 为快照视图 + 文件回边界态。

---

## 附录 A：为什么是方案 A，不是方案 B

> 方案 A（CC）：每条消息边界抓【全部】追踪文件当前内容、未变复用；rewind 取目标那张逐文件覆盖。
> 方案 B：只存"这轮 agent 改过"的文件、改前快照；rewind 顺次撤销各轮。

正确性差异**只出现在"Bash/用户在 agent 没编辑该文件的那轮里改了已追踪文件"时**：

```
round1: Edit F v0→v1；round2: agent 只改 G（没碰 F），但 Bash 把 F v1→v1B
回退目标 = S2（发 msg2 之前 = round1 之后）→ 期望 F = v1（Bash 在 round2 里、边界之后，该撤销）

方案 A: S2[F] = makeSnapshot 边界重抓 = v1（Bash 还没发生）→ F 覆盖回 v1   ✅ Bash 被撤销
方案 B: S2 只有 G，撤销 round2 只还原 G；F 这轮没被 agent 编辑 → 不动 → F=v1B  ❌ Bash 泄漏
```

- 纯 agent 编辑时两者**等价**（每次变化都对应"agent 编辑它的那轮"，顺次撤销刚好抵消）。
- 有外部改动落在"非 agent 编辑轮"时 B 不准——它只能感知 agent 的编辑点，中间的外部改动看不见。
- A **不更贵**：未变文件复用旧 backup、零多余拷贝（CC `PJn` 复用）。

故 elf 复刻 A。

## 附录 B：CC v2.1.209 源码依据（已实读 `claude.exe`）

| CC 符号 | 作用 |
|---|---|
| `t5e` fileHistoryTrackEdit | 写前钩子：未存则 `vvu` 备份当前内容，dispatch `track` |
| `vvu` | `copyFile(file → file-history/<sha>@vN)` |
| `s0t` fileHistoryMakeSnapshot | 边界抓：每个追踪文件复用或重抓，push 自包含 snapshot |
| `PJn` checkOriginFileChanged | stat + content 比对：未变→复用、变了→重抓 |
| `Q4r`→`sCg` fileHistoryRewind | 取目标 snapshot 逐文件：null→unlink、变了→copyFile 覆盖 |
| `nCg` | 淘汰：删被弹 snapshots 引用、且已无人再引用的 backup |
| `reduceFileHistoryState`(e5e) | reducer：`track` / `snapshot` / `touch` 三 case |
