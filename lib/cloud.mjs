// lib/cloud.mjs — 云同步能力（把 @dickpy/dsh-cloud-sync 的核心逻辑内置进来）。
//
// 目标：其他设备不装 dsh-cloud-sync 也能用同一套能力。因此不依赖外部包，
// 而是把 cloud-sync 的 core.js 原样 vendor 为 ./cloud-core.mjs（它只依赖 Node
// 内置模块，跨设备可跑）。本模块只做三件事：
//   1. 把 22 个操作映射到 core 函数；
//   2. 统一注入平台默认值（profile / home 由 core.dshHome() 解析，跨平台正确）；
//   3. 用 lib/api.mjs 的 route() 工厂产出同源路由项（loopback + JSON 信封 + 脱敏）。
//
// 依赖注入：core 函数本身支持 { home, profile, fetcher } 参数，这里全部走默认，
// 不读取任何 DSH 服务，便于单测（注入 fake core 即可）。

import { route } from './api.mjs'
import { CLOUD_PREFIX } from './constants.mjs'
import * as core from './cloud-core.mjs'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 插件备份的自动调度配置：单独存在 <home>/dsh-session-sync/plugin-schedule.json。
 * 复用 lib/schedule.mjs 的 daily / interval 两种模式（与会话备份的自动备份一致）。
 */
const DEFAULT_PLUGIN_SCHEDULE = {
  enabled: false, mode: 'daily', atHour: 3, atMinute: 0, everyMinutes: 60,
  lastRunAt: null, lastResult: null,
}
const pluginScheduleFile = () => join(core.dshHome(), 'dsh-session-sync', 'plugin-schedule.json')

export async function readPluginSchedule() {
  try {
    const raw = await readFile(pluginScheduleFile(), 'utf8')
    return { ...DEFAULT_PLUGIN_SCHEDULE, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_PLUGIN_SCHEDULE }
  }
}

export async function writePluginSchedule(input = {}) {
  const next = { ...DEFAULT_PLUGIN_SCHEDULE, ...(input ?? {}) }
  const file = pluginScheduleFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 立即执行一次插件备份：推送含插件清单的快照到远端，并记录时间。 */
export async function runPluginBackup() {
  const result = await core.synchronizeSnapshots({
    home: core.dshHome(),
    // 经模块级 sink 上报真实计数（回调无法穿过 HTTP 请求体）。
    onProgress: emitProgress,
  })
  const current = await readPluginSchedule()
  const next = await writePluginSchedule({
    ...current,
    lastRunAt: new Date().toISOString(),
    lastResult: { ok: result?.ok !== false, pushed: result?.pushed === true, error: result?.error ?? null },
  })
  return { ok: result?.ok !== false, pushed: result?.pushed === true, error: result?.error ?? null, schedule: next }
}

/**
 * 当前运行的 profile：从本插件自己的安装路径解析（宿主按 profile 挂载，
 * 路径里一定含 profiles/<name>/node_modules/）。比读 process.env.DSH_PROFILE 可靠——
 * 后者会被父进程/外部 shell 环境污染（实测 diagcopy 上读到 desktop）。
 * 解析不到时回退 DSH_PROFILE，再回退 cloud-sync 默认 'web'。
 */
const PROFILE = (() => {
  try {
    const p = fileURLToPath(import.meta.url)
    const matched = /[/\\]profiles[/\\]([^/\\]+)[/\\]node_modules[/\\]/.exec(p)
    if (matched) return matched[1]
  } catch { /* 解析失败走回退 */ }
  return String(process.env.DSH_PROFILE ?? '').trim() || 'web'
})()

/** 包一层：把 core 的任意抛错转成可读的 { ok:false, error }，避免路由层一律 500。 */
async function wrap(fn) {
  try {
    return await fn()
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

/** 生成 profile 相关调用默认值（不硬编码 home，让 core.dshHome() 跨平台解析）。 */
const profileOpts = (input = {}) => ({ profile: input.profile ?? PROFILE, home: core.dshHome() })

/**
 * 操作表：path → (input, opts) => core 调用。
 * 与 cloud-sync 的 22 个 API 一一对应，保持客户端可迁移。
 */
const OPS = {
  'status': () => core.status({ home: core.dshHome() }),
  'settings/get': () => core.getPublicSettings(core.dshHome()),
  'release/check': () => core.checkSelfUpdate({ home: core.dshHome() }),
  'release/update': () => core.updateSelf({ home: core.dshHome() }),
  'webdav/connect': (input) => core.connectWebDav(input, { home: core.dshHome() }),
  'provider/connect': (input) => core.connectProvider(input, { home: core.dshHome() }),
  'github/device/status': () => core.getGithubDeviceAuthorizationStatus(),
  'github/device/start': () => core.startGithubDeviceAuthorization({ home: core.dshHome() }),
  'github/device/poll': (input) => core.pollGithubDeviceAuthorization({ requestId: input.requestId }, { home: core.dshHome() }),
  'settings/clear-provider': () => core.clearSyncProvider({ home: core.dshHome() }),
  'settings/preferences': (input) => core.updateSyncPreferences(input, { home: core.dshHome() }),
  'security/unlock': (input) => core.unlockEncryption(input, { home: core.dshHome() }),
  'security/lock': () => core.lockEncryption({ home: core.dshHome() }),
  'snapshot/diff': () => core.previewSyncChanges({ home: core.dshHome() }),
  'snapshot/history': () => core.listSnapshotHistory({ home: core.dshHome() }),
  'snapshot/history/delete': (input) => core.deleteSnapshotHistory({
    snapshotKey: input.snapshotKey,
    home: core.dshHome(),
    // 经模块级 sink 上报真实计数（回调无法穿过 HTTP 请求体）。
    onProgress: emitProgress,
  }),
  // 技能备份域：独立键空间 skills/，与快照历史互不干扰。
  'skill/local-list': (input) => core.listLocalSkills({ root: input.root }),
  'skill/push': (input) => core.pushSkillBackup({
    home: core.dshHome(),
    root: input.root,
    limit: input.limit,
    // 经模块级 sink 上报真实计数（回调无法穿过 HTTP 请求体）。
    onProgress: emitProgress,
  }),
  'skill/history': () => core.listSkillBackups({ home: core.dshHome() }),
  'skill/history/delete': (input) => core.deleteSkillBackup({
    skillKey: input.skillKey,
    home: core.dshHome(),
    // 经模块级 sink 上报真实计数（本次备份实际分片数）。
    onProgress: emitProgress,
  }),
  'skill/restore': (input) => core.restoreSkills({ home: core.dshHome(), root: input.root, skillKeys: input.skillKeys }),
  // 孤儿回收：删除远端已无任何索引引用的备份对象（失败推送的残留）。
  'snapshot/reclaim-orphans': () => core.reclaimOrphanObjects({
    home: core.dshHome(),
    // 经模块级 sink 上报真实计数（实际枚举出的远端对象数）。
    onProgress: emitProgress,
  }),
  'snapshot/push': (input) => core.synchronizeSnapshots({
    home: core.dshHome(),
    strategy: input.strategy,
    resolveConflicts: input.resolveConflicts,
    selectedItems: input.selectedItems,
    onProgress: emitProgress,
  }),
  'snapshot/pull': (input) => core.pullSnapshot({ home: core.dshHome(), apply: input.apply === true, snapshotKey: input.snapshotKey }),
  'plugin-schedule/get': () => readPluginSchedule(),
  'plugin-schedule/set': (input) => writePluginSchedule(input),
  'plugin-schedule/run': () => runPluginBackup(),
  'source/backup': (input) => core.backupLocalPlugin(input.directory, { home: core.dshHome() }),
  'inventory': (input) => core.getSyncInventory(profileOpts(input)),
  'plugin/adopt-configured': (input) => core.adoptConfiguredPlugin({ profile: input.profile ?? PROFILE, packageName: input.packageName, home: core.dshHome() }),
  'plugin/install-configured': (input) => core.installConfiguredPlugin({ profile: input.profile ?? PROFILE, packageName: input.packageName, home: core.dshHome() }),
  'plugin/uninstall': (input) => core.uninstallPlugin({ profile: input.profile ?? PROFILE, packageName: input.packageName, home: core.dshHome() }),
}

/**
 * 进度上报通道（模块级 sink）。
 *
 * 为什么这样设计：进度回调是**函数**，无法经 HTTP 请求体从路由层传进来。
 * 因此由调用方（index.mjs 的进度包装）在发起备份前 set 一个 sink，
 * ops 读取它把 core 的真实计数翻译成进度。备份结束（finally）后必须 clear，
 * 避免把上一次的回调泄漏给下一次调用。
 */
let progressSink = null

/** 设置/清除当前备份的进度 sink（传 null 清除）。 */
export function setCloudProgressSink(sink) {
  progressSink = typeof sink === 'function' ? sink : null
}

/** 把 core 的上报转给 sink（sink 不存在时静默丢弃）。 */
function emitProgress(patch) {
  if (progressSink === null) return
  try {
    progressSink(patch)
  } catch {
    // 进度回调出错绝不影响备份结果。
  }
}

/**
 * 生成 cloud 路由项列表。
 * 每条路由统一把 input/query 传给对应 op；op 内自行 await core 调用。
 *
 * 方法策略：云页签按钮有的带 JSON 请求体（POST），有的不带（GET）。
 * route() 在 method='GET' 时会同时放行 GET/HEAD/POST，并按实际方法决定
 * 是否解析请求体——因此统一按 'GET' 注册，让两种调用都通（仅本机回环可访问）。
 * @returns {Array<{kind: string, path: string, handler: Function}>}
 */
export function cloudRoutes() {
  return Object.entries(OPS).map(([name, op]) =>
    route(`${CLOUD_PREFIX}/${name}`, 'GET',
      (input) => wrap(() => op(input)),
    ),
  )
}

/** 供烟测使用：列出全部 cloud 路由路径。 */
export function cloudRoutePaths() {
  return Object.keys(OPS).map((name) => `${CLOUD_PREFIX}/${name}`)
}

// 引用 core 以保持 tree-shake 可见性（无副作用）。
export { core as cloudCore }