# 会话交接文档 · dsh-session-sync（备份与同步插件）

- **会话名称**：备份与同步插件
- **会话 ID**：`session-0c42dba5-ddf2-4543-8f7b-6002c5cb3821`
- **生成时间**：2026-10-15 20:40 (Asia/Shanghai)
- **源码目录**：`<workspace>\dsh-session-sync-ui`（本机实际位于 `Documents\deepseek-harness\default-workspace\` 下，路径按设备动态解析，勿写死）
- **插件版本**：`0.2.24-ui.1`
- **部署目标**：`~/.dsh/profiles/{desktop,diagcopy}/node_modules/dsh-session-sync`

---

## 一、一句话现状

三大备份域（会话 / 插件 / 技能）均已可用，历史删除、多选、孤儿回收、路径消毒全部落地；**97/97 测试通过、26 文件双 profile 哈希一致**；但 **8 个改动文件尚未 git 提交**（等用户通知），且**后端改动需重启 DSH 才生效**。

---

## 二、本轮完整改动清单

### 2.1 已提交并推送（远端 `main = f271f8b`）

| 提交 | 内容 |
| --- | --- |
| `33d69c2` | fork 单提交干净历史：三域备份 + 设备路径动态识别 + 个人路径消毒 |
| `c2fa628` | **修复「备份报成功但无还原点」**：`engine.mjs` 提交判据改为始终尝试 `commitAll` |
| `f271f8b` | 移除误入仓库的探针脚本 |

### 2.2 未提交（8 个文件，已核对无个人路径 / 无探针残留）

| 文件 | 改动要点 |
| --- | --- |
| `lib/cloud-core.mjs` | `GistProvider.listObjects/removeObjects`、`EncryptedProvider` 透传、新增导出 `reclaimOrphanObjects` |
| `lib/cloud.mjs` | 注册路由 `snapshot/reclaim-orphans` |
| `lib/constants.mjs` | **`COMMAND_TIMEOUT_MS` 120000 → 600000** |
| `client.js` | 插件备份 TAB「其他」卡片新增「回收孤儿对象」按钮（带二次确认） |
| `test/cloud.test.mjs` | `EXPECTED_OPS` / `REQUIRED_CORE_EXPORTS` 同步 |
| `test/client-render.test.mjs` | 新增按钮渲染门 |
| `test/reclaim-orphans.test.mjs` | 新增（3 条回收契约） |
| `test/timeout-budget.test.mjs` | 新增（2 条超时预算守卫） |

---

## 三、本轮修复的四个真实 Bug（均有实测证据）

### Bug 1：备份报成功但无还原点 ⚠️ 最严重

- **现象**：状态栏显示备份成功，备份记录里没有该还原点
- **根因**：`engine.mjs#mirrorAndCommit` 用「本次镜像是否写入文件」当提交判据；而 `status()` 会**先镜像不提交**，导致后续 push 时 `mirrored=0` → 跳过提交 → 脏工作树被永久遗留
- **证据**：`git reflog` 只有 `initial commit`；`git status --porcelain` 有 1 个脏文件
- **修复**：改为无条件尝试 `commitAll`（其自带 porcelain 空检查，不产生空提交）
- **验证**：回归测试**双向验证**——旧代码 `fail 1`，新代码通过

### Bug 2：`git push timed out after 120000ms`

- **根因**：不是网络问题，是超时值小于真实数据量
- **证据（同一命令、同一仓库实测）**：

| 场景 | 耗时 |
| --- | --- |
| 36MB 会话数据首次推送 | **264.0s** |
| 无新数据重复推送 | **2.0s** |
| 原超时上限 | **120s** → 必然失败 |

- **修复**：`DEFAULTS.COMMAND_TIMEOUT_MS` → 600000（2.3 倍余量）
- **验证**：改回 120000 → `fail 1`（报错点名 264000ms）；恢复后 97/97

### Bug 3：孤儿对象永远清不掉

- **现象**：删除全部备份历史后，Gist 仍有残留对象
- **根因**：删除只扫「索引记账过的 key」；推送中途失败（如批量 PATCH 422）留下「已上传但从未入账」的对象，索引扫不到
- **证据**：实测发现 4 个未入账技能归档（53/5/21/3KB）
- **修复**：新增 `reclaimOrphanObjects`——正向哈希构建保护名单（两索引 + latest + sources + marker），只删 `GIST_FILE_PREFIX` 前缀且无引用者，**宁漏删不误删**
- **验证**：契约测试 3 条 + 真实 Gist 端到端（干净数据 → `removed:0`）

### Bug 4：加密模式下孤儿回收崩溃（复核时发现）

- **根因**：`EncryptedProvider.listObjects()` 在底层不支持列举时返回 `undefined`，原逻辑只检查「方法存在」，随后 `.filter` 直接 TypeError
- **修复**：加 `Array.isArray(remoteNames)` 守卫，不满足即降级返回 `supported:false`
- **验证**：新增第 3 条契约测试

---

## 四、关键设计决策（含被否决的方案）

| 决策 | 理由 |
| --- | --- |
| 个人路径消毒用 `~/` 占位而非删除 | 还原侧可按目标机 home 展开，跨设备可用 |
| 回收用「正向哈希保护名单」而非列举反推 | `gistObjectFileName` 是 sha256 单向哈希，无法从远端文件名反推 key |
| 回收**只**删本插件前缀对象 | 同一 Gist 内可能有用户自有文件 |
| **撤销** `encryptedKey()` 加 `skills/` | 属未经确认的范围外改动，已恢复原值 |
| **未改** `archiveHistory` 多步往返 | 提速需合并/并发写同一 Gist，有 ETag 冲突与数据损坏风险，**须用户拍板** |

---

## 五、当前数据状态（实测）

### 5.1 Gist 备份对象：40 个

由你本轮执行的技能备份产生，构成：

| 类型 | 数量 | 说明 |
| --- | --- | --- |
| 技能分片 | 35 | 28 个技能，`skills/batch-bf193e0153fc3726` |
| 技能索引 | 1 | `skills/index.json`（16KB） |
| 快照归档 | 1 | 历史归档（20KB） |
| 快照索引 | 1 | `snapshots/history/index.json` |
| 当前快照 | 1 | `snapshots/latest.json.gz` |
| 归属标记 | 1 | `dsh-cloud-sync-v1.json` |

- **快照历史条目**：1 条
- **技能历史条目**：1 条（28 技能 / 35 分片）
- **回收校验**：`would_remove=0 kept=40` —— 保护逻辑对真实新数据正确，无误删风险

### 5.2 会话镜像仓库

- 本地：`~/.dsh/dsh-session-sync/repo`，HEAD = `853ab18 dsh-session-sync: push snapshot`
- 远端：`hxd2xff-png/dsh-config-manager`，main = `853ab186f20f49c275ca95dd7033a68144169afb`（**首次全量传输已完成**）
- 仓库体积：46.7MB；会话数据 11 文件 / 36.0MB（单文件最大 15.2MB）

### 5.3 代码仓库

- 远端：`hxd2xff-png/dsh-session-sync-fork`，main = `f271f8b`
- HEAD 个人路径 grep：**0 命中**

---

## 六、待办 / 待决策

### 6.1 必须执行

1. **重启 DSH** —— `constants.mjs` / `cloud-core.mjs` / `cloud.mjs` 改动不重启不生效（否则备份仍走 120s 旧值）
2. **重启后刷新页面** —— `client.js` 改动生效，才能看到「回收孤儿对象」按钮

### 6.2 等用户通知才做

3. **git 提交推送**（严格遵守：「你等我通知你再去 push 到仓库」）
   - 提交前必须 `git status` 逐项核对
   - **严禁 `git add -A`** —— 此前已两次把探针脚本误提交进公开仓库

### 6.3 待用户拍板

4. **插件/技能备份提速**（三选一）
   - **A 保守**：不动。首次推送已过，增量本就快
   - **B 合并往返**：`archiveHistory` 的「读索引+写归档+写索引」合并为一次 PATCH，预计 6+ 次往返压到 2 次。风险中等，需补 ETag 冲突测试
   - **C 并发上传**：提速最多，但直接撞已踩过的 ETag 422 坑，**不建议**

### 6.4 已知未修问题

5. **技能归档在加密模式下明文上传** —— `encryptedKey()` 未含 `skills/` 前缀。本轮为守范围已撤销该改动，**需你决定是否处理**
6. **插件快照不拆分** —— 单个快照超 700KB 会失败（技能侧已用 `SKILLS_LIMIT=5` 规避 Gist 200 文件上限）
7. **批量删除逐条调 `run()`** —— 额外刷新往返，未优化

---

## 七、验证命令速查

```powershell
# 源码目录按设备动态解析（不需要写死个人路径）
$src = (Resolve-Path (Join-Path $PWD 'dsh-session-sync-ui')).Path

# 全量测试（应 97/97）
Set-Location $src
npm.cmd test

# 部署哈希核对（应 HASH_OK files=26 profiles=2）
$targets=@("$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-sync","$env:USERPROFILE\.dsh\profiles\diagcopy\node_modules\dsh-session-sync")
$files=@((Get-ChildItem -LiteralPath (Join-Path $src 'lib') -File | ForEach-Object { "lib\$($_.Name)" }) + @('index.mjs','client.js','package.json','cordis.patch.yml'))
$bad=@(); foreach($rel in $files){ $s=(Get-FileHash -LiteralPath (Join-Path $src $rel) -Algorithm SHA256).Hash; foreach($t in $targets){ $d=(Get-FileHash -LiteralPath (Join-Path $t $rel) -Algorithm SHA256).Hash; if($s -ne $d){ $bad += "$(Split-Path (Split-Path $t -Parent) -Leaf)::$rel" } } }
if($bad.Count -gt 0){ "MISMATCH: $($bad -join '; ')" } else { "HASH_OK" }

# 会话镜像仓库状态
git -C "$env:USERPROFILE\.dsh\dsh-session-sync\repo" log --oneline -3
git -C "$env:USERPROFILE\.dsh\dsh-session-sync\repo" ls-remote origin
```

---

## 八、必须遵守的全局硬规则（本项目生效）

1. **只做用户明确指定的调整** —— 范围外发现只报告，等确认再动
2. **禁止假设** —— 任何结论 / 归因 / 数字 / 状态，必须有工具输出或可核验来源
3. **不得把测试通过当交付完成** —— 必须额外核对部署产物哈希
4. **设备路径一律动态识别** —— 禁止写死 `C:/Users/<name>/…`；发布前消毒产物
5. **工具链事实**：
   - PowerShell 不支持 `&&`，用 `;` 或 `if($LASTEXITCODE -ne 0){ exit 1 }`
   - 改源码一律写 `.mjs` 脚本执行，**禁止内联 `node -e`**（嵌套引号必炸）
   - 读 UTF-8 中文文件必须显式指定编码，否则 GBK 误判
   - Edit 报 "file has not been read" = 文件被改过，**先 read 再 edit**
6. **反钻牛角尖** —— 同类问题失败 2 次，立即停止逐次修补，回已知良好基线重做
7. **全程中文回复**

---

## 九、交接给下一个 Agent 的第一句话

> 源码在 `dsh-session-sync-ui`，97/97 测试通过、双 profile 已部署，但 **8 个文件未提交**（用户明确要求等通知才 push）。先读本文件第六节确认待办；用户点备份报错前，先确认 DSH 是否已重启（后端改动不重启不生效）。提交前**必须** `git status` 逐项核对，禁止 `git add -A`。
