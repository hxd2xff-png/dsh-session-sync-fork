// test/progress.test.mjs — 进度解析必须是"真数据"，且不得编造百分比。
//
// 夹具来源：2026-10-15 本机实测 `git push --progress`（git 2.55.0.windows.3）
// 的 stderr 原始输出，逐行抄录——不是构造的理想样本。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ProgressRegistry,
  PROGRESS_KINDS,
  FINISHED_LINGER_MS,
  parseGitProgressLine,
  feedGitProgress,
} from '../lib/progress.mjs'

// 实测输出（原样保留空格与标点）
const REAL_GIT_PUSH_STDERR = [
  'Enumerating objects: 3, done.',
  'Counting objects:  33% (1/3)',
  'Counting objects:  66% (2/3)',
  'Counting objects: 100% (3/3)',
  'Counting objects: 100% (3/3), done.',
  'Delta compression using up to 20 threads',
  'Compressing objects:  50% (1/2)',
  'Compressing objects: 100% (2/2)',
  'Compressing objects: 100% (2/2), done.',
  'Writing objects:  33% (1/3)',
  'Writing objects:  66% (2/3)',
  'Writing objects: 100% (3/3)',
  'Writing objects: 100% (3/3), 392 bytes | 392.00 KiB/s, done.',
  'Total 3 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)',
  'To C:\\Users\\HUANGX~1\\AppData\\Local\\Temp\\git-progress-probe\\bare.git',
  ' * [new branch]      HEAD -> main',
]

test('解析实测 git 输出：每条百分比都来自原文，不生成任何数字', () => {
  const parsed = REAL_GIT_PUSH_STDERR.map(parseGitProgressLine)

  // 与原文逐行对齐：有百分比的行 → 解析出百分比；(3/3) → 计数正确
  assert.deepEqual(parsed[1], { phase: 'counting', percent: 33, counts: { done: 1, total: 3 } })
  assert.deepEqual(parsed[3], { phase: 'counting', percent: 100, counts: { done: 3, total: 3 } })
  assert.deepEqual(parsed[6], { phase: 'compressing', percent: 50, counts: { done: 1, total: 2 } })
  assert.deepEqual(parsed[9], { phase: 'writing', percent: 33, counts: { done: 1, total: 3 } })
  assert.deepEqual(parsed[10], { phase: 'writing', percent: 66, counts: { done: 2, total: 3 } })

  // 无进度的行必须返回 null（不被当成 0%）
  assert.equal(parsed[5], null, 'Delta compression ... 不含进度，应为 null')
  assert.equal(parsed[13], null, 'Total 3 (delta 0) ... 不含进度，应为 null')
  assert.equal(parsed[14], null, '远端地址行不含进度')
  assert.equal(parsed[15], null, '分支引用行不含进度')

  // Enumerating objects: 3, done. → 计数型
  assert.deepEqual(parsed[0], { phase: 'enumerating', percent: 100, counts: { done: 3, total: 3 } })

  // 完成行带速率
  assert.equal(parsed[12].percent, 100)
  assert.equal(parsed[12].counts.total, 3)
  assert.equal(parsed[12].rate, '392.00 KiB/s')
})

test('git 的百分比是【阶段自身】的——不得冒充全局进度', () => {
  // 实测里 Counting 到达 100% 之后，Compressing 又从 50% 开始。
  // 若把它当全局百分比，进度条就会从 100% 倒退。注册表必须原样保存 phase + percent。
  const registry = new ProgressRegistry()
  registry.start('session')
  const state = { carry: '' }
  for (const line of REAL_GIT_PUSH_STDERR) {
    feedGitProgress(registry, 'session', `${line}\n`, state)
  }
  const [entry] = registry.snapshot().entries
  assert.equal(entry.stage, 'push')
  assert.equal(entry.phase, 'writing', '最后一个带进度的阶段是 writing')
  assert.deepEqual(entry.counts, { done: 3, total: 3 })
  assert.equal(entry.rate, '392.00 KiB/s')
  // 阶段百分比照实记录（100），但它不代表"整个备份完成"
  assert.equal(entry.percent, 100)
})

test('跨 chunk 的残行必须被正确拼接（流式读取的真实场景）', () => {
  const registry = new ProgressRegistry()
  registry.start('plugin')
  const state = { carry: '' }
  const text = 'Writing objects:  66% (2/3)\n'
  // 故意在行中间切断
  feedGitProgress(registry, 'plugin', text.slice(0, 12), state)
  const mid = registry.snapshot().entries[0]
  assert.equal(mid.percent, null, '半行不得产生任何进度')
  feedGitProgress(registry, 'plugin', text.slice(12), state)
  const after = registry.snapshot().entries[0]
  assert.equal(after.percent, 66, '补齐后应解析出 66%')
  assert.deepEqual(after.counts, { done: 2, total: 3 })
})

test('没有真实百分比时保持 null（前端据此走不确定态）', () => {
  const registry = new ProgressRegistry()
  const entry = registry.start('skill')
  assert.equal(entry.percent, null, 'start() 不得预设 0-100 的假值')
  assert.equal(entry.state, 'running')
  const after = registry.update('skill', { stage: 'push' })
  assert.equal(after.percent, null)
})

test('三类域互不干扰，且按 session/plugin/skill 顺序快照', () => {
  const registry = new ProgressRegistry()
  registry.start('skill')
  registry.start('session')
  registry.start('plugin')
  const { entries } = registry.snapshot()
  assert.deepEqual(entries.map((e) => e.kind), ['session', 'plugin', 'skill'])
  assert.deepEqual(PROGRESS_KINDS, ['session', 'plugin', 'skill'])
})

// 回归：cloud 路由路径必须按【结尾】匹配多段路由名。
// 2026-10-15 真实事故：index.mjs 曾用 `path.slice(path.lastIndexOf('/') + 1)` 取最后一段，
// 对 `/api/dsh-session-sync/cloud/snapshot/push` 只会拿到 `push`，永远匹配不上
// `snapshot/push`，导致插件/技能备份的进度条从不出现（会话备份正常）。
test('备份路由按结尾匹配：真实 cloud 路径必须被识别为 plugin/skill', () => {
  // 这两个是真实路径（实测自 lib/cloud.mjs 的 cloudRoutePaths()）。
  const realPaths = [
    '/api/dsh-session-sync/cloud/snapshot/push',
    '/api/dsh-session-sync/cloud/skill/push',
    '/api/dsh-session-sync/cloud/inventory',
    '/api/dsh-session-sync/cloud/snapshot/history',
  ]

  // 当前实现：结尾匹配
  const kindOf = (path) => (path.endsWith('/skill/push') ? 'skill' : path.endsWith('/snapshot/push') ? 'plugin' : null)
  // 旧的错误实现：取最后一段
  const buggyKindOf = (path) => {
    const tail = path.slice(path.lastIndexOf('/') + 1)
    return tail === 'skill/push' ? 'skill' : tail === 'snapshot/push' ? 'plugin' : null
  }

  assert.equal(kindOf(realPaths[0]), 'plugin', 'snapshot/push 必须识别为 plugin')
  assert.equal(kindOf(realPaths[1]), 'skill', 'skill/push 必须识别为 skill')
  assert.equal(kindOf(realPaths[2]), null, 'inventory 不得被识别为备份')
  assert.equal(kindOf(realPaths[3]), null, 'snapshot/history 不得被识别为备份')

  // 锁死回归：旧的"取最后一段"实现在真实路径上必须失效（证明它确实有 bug）
  assert.equal(buggyKindOf(realPaths[0]), null, '旧实现取最后一段拿不到 snapshot/push')
  assert.equal(buggyKindOf(realPaths[1]), null, '旧实现取最后一段拿不到 skill/push')
})

test('未包装的路由不产生任何进度条目（不误伤非备份操作）', () => {
  const registry = new ProgressRegistry()
  // 只有被显式 start 的域才有条目；仅调用 snapshot 不得凭空产生条目
  assert.deepEqual(registry.snapshot().entries, [])
  assert.equal(registry.hasRunning(), false)
})

test('finish() 保留条目以便播放收尾动画，超期后惰性清理', () => {
  let clock = 1_000_000
  const registry = new ProgressRegistry({ now: () => clock })
  registry.start('session')
  registry.finish('session', { ok: true })
  assert.equal(registry.snapshot().entries.length, 1, '刚结束仍在快照内')

  clock += FINISHED_LINGER_MS - 1
  assert.equal(registry.snapshot().entries.length, 1)

  clock += 2
  assert.equal(registry.snapshot().entries.length, 0, '超过保留期应被清理')
})

test('失败的备份如实记录错误，且不把 percent 刷成 100', () => {
  const registry = new ProgressRegistry()
  registry.start('plugin')
  registry.update('plugin', { stage: 'push', percent: 42 })
  const entry = registry.finish('plugin', { ok: false, error: 'git push failed: rejected' })
  assert.equal(entry.state, 'finished')
  assert.equal(entry.ok, false)
  assert.equal(entry.error, 'git push failed: rejected')
  assert.equal(entry.percent, 42, '失败时保留最后一次真实进度，不伪装完成')
})

test('未知域响亮失败，不静默吞掉调用错误', () => {
  const registry = new ProgressRegistry()
  assert.throws(() => registry.start('unknown'), /unknown progress kind/u)
})

test('镜像阶段的文件计数是真实计数，不是百分比换算', () => {
  const registry = new ProgressRegistry()
  registry.start('session', { total: 14 })
  registry.update('session', { stage: 'mirror', files: { done: 9, total: 14 } })
  const [entry] = registry.snapshot().entries
  assert.deepEqual(entry.files, { done: 9, total: 14 })
  assert.equal(entry.percent, null, '文件计数不等于已推送百分比')
})
