// test/progress-ui-regression.test.mjs — 锁死进度条的两个显示 bug + 三类备份全覆盖。
//
// 背景（2026-10-15 真实故障）：
//   BUG-1 前端 exiting 集合只增不减 → 某类备份【第二次起】永远带 is-exiting
//         （CSS opacity:0 + scale）→ 进度条渲染了却完全看不见。
//   BUG-2 displayRef 残留上一轮的 100% → 新一轮从 100 回落。
//   BUG-3 自动/定时备份不登记进度 → 用户以为没在跑。
//
// 这些断言读【真实源码文本】，不是复刻副本 —— 防止代码改回旧写法而测试仍绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const indexSrc = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')

test('前端：新一轮 running 时必须清除 exiting 标记（BUG-1 回归）', () => {
  // 必须有 delete，且是在处理 runningKeys（kind+action 复合键）的上下文里
  assert.match(clientSrc, /runningKeys[\s\S]{0,400}next\.delete\(k\)/u,
    'exiting 只增不减会让第二次起的进度条永久 opacity:0 —— 必须在 running 时清除')
})

test('前端：新一轮 running 时必须重置残留显示值（BUG-2 回归）', () => {
  assert.match(clientSrc, /displayRef\.current\.delete\(/u,
    'displayRef 残留上一轮 100% 会让新一轮从 100 回落 —— 必须重置')
})

test('前端：进度浮层挂在 shell.overlay（跨工作区可见的前提）', () => {
  assert.match(clientSrc, /slots\.inject\('shell\.overlay'/u)
})

test('前端：进度条容器与三条排列的样式存在', () => {
  assert.match(clientSrc, /\.ss-prog-dock\{/u)
  assert.match(clientSrc, /\.ss-prog-row\.is-exiting\{/u, '收尾动画样式必须存在')
  assert.match(clientSrc, /\.ss-prog-flow\{/u, '不确定态流动条纹样式必须存在')
})

test('后端：三条备份域都有 progress.start 登记', () => {
  const starts = [...indexSrc.matchAll(/progress\.start\(([^,)]+)/gu)].map((m) => m[1].trim())
  assert.ok(starts.some((s) => s === "'session'"), '会话备份必须登记')
  assert.ok(starts.some((s) => s === "kind"), '插件/技能（路由包装）必须登记')
  assert.ok(starts.length >= 4, `登记点应覆盖手动/自动/turn-end/定时插件，实际 ${starts.length} 处`)
})

test('后端：手动会话备份把 onStderr 透传给引擎', () => {
  assert.match(indexSrc, /backupEngine\.push\(\{[\s\S]{0,200}onStderr/u)
})

test('后端：自动备份（定时）也登记进度（BUG-3 回归）', () => {
  // runAutomaticBackup 函数体内必须有 progress.start
  const fn = indexSrc.match(/async function runAutomaticBackup\(\)[\s\S]*?\n  \}/u)
  assert.ok(fn !== null, '找不到 runAutomaticBackup 定义')
  assert.match(fn[0], /progress\.start\('session'/u, '自动会话备份必须登记进度')
  assert.match(fn[0], /progress\.finish\('session'/u)
})

test('后端：turn/end 自动推送也登记进度（BUG-3 回归）', () => {
  const block = indexSrc.match(/if \(resolved\.autoPushOnTurnEnd\)[\s\S]*?\n  \}/u)
  assert.ok(block !== null, '找不到 autoPushOnTurnEnd 分支')
  assert.match(block[0], /progress\.start\('session'/u, 'turn/end 推送必须登记进度')
})

test('后端：定时插件备份也登记进度（BUG-3 回归）', () => {
  // 定时器 tick 内的 runPluginBackup 调用必须被 progress 包裹
  assert.match(indexSrc, /if \(due\) \{[\s\S]{0,400}progress\.start\('plugin'/u,
    '定时插件备份不登记 → 自动跑时看不到进度条')
})

test('后端：五条云路由映射到（域, 操作），且按【结尾】匹配', () => {
  // 匹配逻辑已收敛到 routeKind()：必须按路径结尾匹配多段路由名。
  // 取最后一段只会拿到 push/delete，在 /api/.../cloud/snapshot/push 上永远匹配不上
  // （2026-10-15 实测：插件/技能备份从不登记进度，根因就是旧写法）。
  //
  // 断言按「结尾路径 + 该行含 kind/action/label」分别校验，不用一整条正则
  // 强求三者同行：源码里它们是同一 return 对象，但缩进/换行会随格式化变动。
  const expected = [
    ['/skill/push', 'skill', 'backup', '技能备份'],
    ['/skill/history/delete', 'skill', 'delete', '技能备份删除'],
    ['/snapshot/push', 'plugin', 'backup', '插件备份'],
    ['/snapshot/history/delete', 'plugin', 'delete', '插件备份删除'],
    ['/snapshot/reclaim-orphans', 'plugin', 'delete', '孤儿对象回收'],
  ]
  for (const [tail, kind, action, label] of expected) {
    const line = new RegExp(`endsWith\\('${tail.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'\\)[^\\n]*`, 'u').exec(indexSrc)
    assert.ok(line !== null, `缺少结尾匹配：${tail}`)
    assert.match(line[0], new RegExp(`kind:\\s*'${kind}'`, 'u'), `${tail} 的 kind 应为 ${kind}`)
    assert.match(line[0], new RegExp(`action:\\s*'${action}'`, 'u'), `${tail} 的 action 应为 ${action}`)
    assert.match(line[0], new RegExp(`label:\\s*'${label}'`, 'u'), `${tail} 的 label 应为 ${label}`)
  }
  assert.doesNotMatch(indexSrc, /const tail = item\.path\.slice\(item\.path\.lastIndexOf\('\/'\) \+ 1\)/u,
    '旧的取最后一段写法在 /api/.../cloud/snapshot/push 上永远匹配不上')
})

test('后端：备份与删除使用不同 action（同域可同时显示，互不覆盖）', () => {
  assert.match(indexSrc, /progress\.start\(kind,\s*\{[^}]*action\s*\}/u, 'start 必须传 action')
  assert.match(indexSrc, /progress\.finish\(kind,\s*\{[^}]*action\s*\}/u, 'finish 必须传 action')
})

test('后端：包装版必须【替换】cloud 域同名项，而不是并列追加（注册去重陷阱）', () => {
  // webServer 的 exact 表按 path 做键，同一路径只能注册一次。
  // 旧写法 `[...routes, ...progressWrapped]` 会让包装版注册被静默跳过，
  // 生效的仍是未包装版本 —— 进度条完全不出现。
  // 实测：删除路由 14 次采样全无 delete 条目，根因即此。
  assert.match(indexSrc, /const wrappedByPath = new Map\(progressWrapped\.map/u,
    '必须用 Map 建立 path → 包装版 的索引')
  // cloud 域必须经过"命中则替换"的 map
  assert.match(indexSrc, /cloudRoutes\(\)\.map\(\(item\) => wrappedByPath\.get\(item\.path\) \?\? item\)/u,
    'cloud 域必须经过包装替换')
  assert.doesNotMatch(indexSrc, /\[\.\.\.routes, \.\.\.progressWrapped/u,
    '并列追加会让包装版注册被静默跳过（重复路径）')
})

test('后端：allRoutes 必须同时含 routes 与 cloud 域（漏一个就整体 404）', () => {
  // 已犯此错：只合并 routes 而漏掉 cloudRoutes()，
  // 导致 32 条 cloud 路由整体丢失，技能/插件备份全部 404
  // （挂载日志 routes-done 从 45/45 掉到 13/13）。
  const block = /const allRoutes = \[([\s\S]*?)\]/u.exec(indexSrc)
  assert.ok(block !== null, '找不到 allRoutes 定义')
  assert.match(block[1], /\.\.\.routes/u, '必须包含会话域 routes')
  assert.match(block[1], /\.\.\.cloud/u, '必须包含 cloud 域（包装替换后）')
  assert.match(block[1], /API_PREFIX\}\/progress/u, '必须包含 /progress')
  // 绝不能再出现只留 routes 的写法
  assert.doesNotMatch(indexSrc, /const mergedRoutes = routes\.map/u,
    '只合并 routes 会丢掉全部 cloud 路由（32 条），技能/插件备份 404')
})

test('后端：cloud OPS 条数不得少于 32（防整体丢失的兜底）', () => {
  // 数字来自实测：cloudRoutePaths() 返回 32 条（2026-10-16）
  const cloud = readFileSync(new URL('../lib/cloud.mjs', import.meta.url), 'utf8')
  const opCount = [...cloud.matchAll(/^  '[a-z][\w/-]*':/gmu)].length
  assert.ok(opCount >= 32, `cloud OPS 应有至少 32 条，实际 ${opCount}`)
})

test('后端：/progress 路由已注册', () => {
  assert.match(indexSrc, /route\(`\$\{API_PREFIX\}\/progress`/u)
})

test('后端：进度回调绝不改变 git 行为（不传时命令不带 --progress）', () => {
  const gitSrc = readFileSync(new URL('../lib/git.mjs', import.meta.url), 'utf8')
  assert.match(gitSrc, /opts\.onStderr === undefined \? \[\] : \['--progress'\]/u,
    '只有传回调时才加 --progress，否则命令必须与改动前一致')
})

// —— 全量覆盖还原（overwriteApply）：DSH 内直接执行，无外部 helper ——
test('后端：全量还原 overwriteApply 存在且不生成外部 helper', () => {
  const restoreSrc = readFileSync(new URL('../lib/restore.mjs', import.meta.url), 'utf8')
  assert.match(restoreSrc, /export async function overwriteApply/u, 'restore.mjs 必须导出 overwriteApply')
  // 绝不生成外部脚本/辅助程序（用户明确要求）
  assert.doesNotMatch(restoreSrc, /writeFile\([^)]*\.ps1|spawn\([^)]*pwsh|child_process/u,
    '不得生成或调用外部 helper 脚本')
  assert.doesNotMatch(indexSrc, /RESTORE_HELPER_NAME/u,
    '不得引用 helper 名常量')
  // 全量还原保留本地增量，不得再交换整个会话库（会使 live writer 的游标脱节）。
  assert.doesNotMatch(restoreSrc, /fs[.]rename[(]sessionRoot/u,
    '不得把仍有 live writer 的整个会话库移走')
  assert.match(restoreSrc, /historyPrefix/u, '必须按已提交事件校验前缀关系')
  assert.match(indexSrc, /acquireWriteLease/u, '实际写入必须接宿主写租约')
})

test('后端：全量还原前必须检查活动轮次（live 会话正在写 sessionRoot）', () => {
  assert.match(indexSrc, /openTurnFromProjection\(ctx, session\)/u,
    '必须依据权威投影判定轮次状态')
  assert.match(indexSrc, /if \(openTurn !== false\) blocked\.push\(session\.id\)/u,
    'true（轮次中）与 undefined（投影缺席）都必须拒绝，只有 false 放行')
  assert.match(indexSrc, /已拒绝全量还原/u, '拒绝时必须给出可读原因')
})

test('前端：全量还原按钮调 apply（不是 prepare 死路）', () => {
  assert.match(clientSrc, /call\('\/restore\/overwrite\/apply'/u,
    '必须调用 apply 端点（prepare 只建 pending 任务、永不执行替换）')
  assert.doesNotMatch(clientSrc, /call\('\/restore\/overwrite\/prepare'/u,
    '不得再调用 prepare —— 它是死路')
  assert.match(clientSrc, /t\('restore\.overwriteRisk'\)/u,
    '确认弹窗必须包含新语义的风险说明（保留增量，分叉拒绝）')
  assert.match(clientSrc, /'history\.overwrite': '全量还原'/u, '按钮文案应为「全量还原」')
})

test('后端：/restore/overwrite/apply 路由已注册', () => {
  const apiSrc = readFileSync(new URL('../lib/api.mjs', import.meta.url), 'utf8')
  assert.match(apiSrc, /restore\/overwrite\/apply/u)
})

// —— 插件/技能备份的真实计数（不伪造百分比）——
const cloudSrc = readFileSync(new URL('../lib/cloud.mjs', import.meta.url), 'utf8')
const coreSrc = readFileSync(new URL('../lib/cloud-core.mjs', import.meta.url), 'utf8')

test('后端：cloud 进度经模块级 sink 上报（回调无法穿过 HTTP 请求体）', () => {
  assert.match(cloudSrc, /export function setCloudProgressSink/u)
  assert.match(cloudSrc, /function emitProgress\(patch\)/u)
})

test('后端：插件/技能 OPS 把 onProgress 接到 emitProgress', () => {
  assert.match(cloudSrc, /onProgress: emitProgress/u)
  const hits = [...cloudSrc.matchAll(/onProgress: emitProgress/gu)]
  assert.ok(hits.length >= 2, `插件与技能两条路径都要接，实际 ${hits.length} 处`)
})

test('后端：插件/技能备份上报【真实计数】而非估算百分比', () => {
  // 技能：真实技能数 + 真实分片数
  assert.match(coreSrc, /total: names\.length/u, '技能总数必须来自实际枚举')
  assert.match(coreSrc, /total: uploads\.length/u, '分片总数必须来自实际待上传列表')
  // 插件：真实 profile 数
  assert.match(coreSrc, /total: profileList\.length/u, 'profile 总数必须来自实际枚举')
  // 任何一处都不得把 percent 写成固定值
  assert.doesNotMatch(coreSrc, /report\(\{[^}]*percent:\s*\d/u,
    'core 不得上报编造的百分比')
})

test('后端：core 的 onProgress 是可选的（不传时行为不变）', () => {
  assert.match(coreSrc, /typeof onProgress === 'function'/u, '回调必须做存在性检查')
  assert.match(coreSrc, /try \{ onProgress\(patch\) \} catch \{/u, '回调抛错不得影响备份')
})

test('后端：sink 在 finally 清除（防回调泄漏到下一次调用）', () => {
  assert.match(indexSrc, /finally \{\s*setCloudProgressSink\(null\)/u)
})

test('前端：无百分比但有真实计数时，用计数比例驱动条宽', () => {
  assert.match(clientSrc, /const derivedPct = /u, '应有从 files.done/files.total 派生的百分比')
  assert.match(clientSrc, /const effectivePct = target !== null \? shown : derivedPct/u)
  assert.match(clientSrc, /const showIndeterminate = indeterminate && derivedPct === null/u,
    '只有连真实计数都没有时才走不确定态')
})

test('前端：完成提示带耗时与计数，且删除/备份文案区分', () => {
  // 完成文案按 action 区分：删除说"已删除"，备份说"备份完毕"——不能都叫备份完毕。
  assert.match(clientSrc, /const doneText = isDelete/u, '应有按操作区分的完成文案')
  assert.match(clientSrc, /locale === 'en' \? 'Deleted' : '已删除'/u, '删除完成应为「已删除」')
  assert.match(clientSrc, /locale === 'en' \? 'Done' : '备份完毕'/u, '备份完成应为「备份完毕」')
  assert.match(clientSrc, /\[doneText, elapsed, fileCounts\]/u,
    '完成后应显示 文案 · 耗时 · 计数')
  // 失败文案同样区分
  assert.match(clientSrc, /const failText = isDelete/u, '失败文案也应按操作区分')
})

test('前端：exiting / displayRef / React key 使用 kind+action 复合键', () => {
  // 同域可同时有备份与删除两条，只用 kind 会互相误判
  // （删除完成把备份条目标成 exiting → 备份条被 CSS 隐藏）。
  assert.match(clientSrc, /const keyOf = \(entry\) => `\$\{entry\.kind\}:\$\{entry\.action \?\? 'backup'\}`/u,
    '应定义 kind+action 复合键函数')
  assert.match(clientSrc, /const runningKeys = entries\.filter\(\(e\) => e\.state === 'running'\)\.map\(keyOf\)/u,
    '清除退出标记应收集复合键（不能用裸 kind）')
  assert.match(clientSrc, /displayRef\.current\.get\(key\)/u, '显示值读取应用复合键')
  assert.match(clientSrc, /displayRef\.current\.set\(key, shown\)/u, '显示值写入应用复合键')
  assert.match(clientSrc, /exiting\.has\(key\)/u, '退出标记判断应用复合键')
  assert.match(clientSrc, /\n\s*key,\n/, 'React key prop 应为复合键（两条同 kind 会 key 冲突丢一条）')
})

test('前端：stageLabel 覆盖 delete 阶段', () => {
  assert.match(clientSrc, /delete: 'Deleting…'/u, '英文应有 Deleting')
  assert.match(clientSrc, /delete: '删除中…'/u, '中文应有「删除中…」')
})

test('后端：会话历史删除也登记进度（真实计数 = 需重写提交数）', () => {
  const historySrc = readFileSync(new URL('../lib/history.mjs', import.meta.url), 'utf8')
  assert.match(historySrc, /typeof deps\.onProgress !== 'function'/u, 'onProgress 必须是可选回调')
  assert.match(historySrc, /report\(\{ stage: 'delete', files: \{ done: 0, total: rewriteTotal \} \}\)/u,
    '删除前应上报真实总数（需重写的提交数）')
  assert.match(historySrc, /report\(\{ stage: 'delete', files: \{ done: rewritten, total: rewriteTotal \} \}\)/u,
    '每个提交重写后应上报真实进度')
  // 三个安全护栏一个都不许削弱
  assert.match(historySrc, /仅剩最后一条历史，无法删除/u)
  assert.match(historySrc, /合并提交不可删除/u)
  assert.match(historySrc, /远端领先本地/u)
})

test('后端：deleteHistory 用 action=delete 登记并在失败时收尾', () => {
  assert.match(indexSrc, /progress\.start\('session', \{ label: '会话备份删除', stage: 'delete', action: 'delete' \}/u)
  assert.match(indexSrc, /deleteHistoryCommit\(backend, \{[\s\S]{0,400}onProgress:/u,
    'deleteHistory 必须把 onProgress 透传给 deleteHistoryCommit')
  assert.match(indexSrc, /progress\.finish\('session', \{ ok: false, error: messageOf\(error\), action: 'delete' \}/u,
    '删除失败必须以 action=delete 收尾（不能把备份条目标成失败）')
})
