// test/cloud.test.mjs — 云同步内置路由的契约门。
//
// 保证：路径唯一（宿主 exact 表只按 path 做键）、全部落在 CLOUD_PREFIX 下、
// 且 cloud-core（vendored）导出了 cloud.mjs 引用的函数——这是「其他设备不装
// dsh-cloud-sync 也能用」这一目标的回归门：一旦 vendor 不完整，测试立刻失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cloudRoutes, cloudRoutePaths, cloudCore } from '../lib/cloud.mjs'
import { CLOUD_PREFIX } from '../lib/constants.mjs'

/** 与 @dickpy/dsh-cloud-sync 对应的 22 个操作 + 历史删除 + 5 个技能备份 + 孤儿回收 + 3 个调度操作。 */
const EXPECTED_OPS = [
  'status', 'settings/get', 'release/check', 'release/update',
  'webdav/connect', 'provider/connect',
  'github/device/status', 'github/device/start', 'github/device/poll',
  'settings/clear-provider', 'settings/preferences',
  'security/unlock', 'security/lock',
  'snapshot/diff', 'snapshot/history', 'snapshot/history/delete', 'snapshot/push', 'snapshot/pull',
  'snapshot/reclaim-orphans',
  'source/backup', 'inventory',
  'plugin/adopt-configured', 'plugin/install-configured', 'plugin/uninstall',
  'skill/local-list', 'skill/push', 'skill/history', 'skill/history/delete', 'skill/restore',
  'plugin-schedule/get', 'plugin-schedule/set', 'plugin-schedule/run',
]

/** cloud.mjs 引用的 cloud-core 导出（vendor 完整性）。 */
const REQUIRED_CORE_EXPORTS = [
  'dshHome', 'status', 'getPublicSettings', 'checkSelfUpdate', 'updateSelf',
  'connectWebDav', 'connectProvider', 'getGithubDeviceAuthorizationStatus',
  'startGithubDeviceAuthorization', 'pollGithubDeviceAuthorization',
  'clearSyncProvider', 'updateSyncPreferences', 'unlockEncryption', 'lockEncryption',
  'previewSyncChanges', 'listSnapshotHistory', 'deleteSnapshotHistory', 'synchronizeSnapshots', 'pullSnapshot',
  'backupLocalPlugin', 'getSyncInventory', 'adoptConfiguredPlugin',
  'installConfiguredPlugin', 'uninstallPlugin',
  'skillsRoot', 'listLocalSkills', 'backupLocalSkill', 'listSkillBackups', 'pushSkillBackup', 'deleteSkillBackup', 'restoreSkills',
  'reclaimOrphanObjects',
]

test('cloud 路由数量与 22 个 cloud-sync 操作 + 历史删除 + 5 个技能备份 + 孤儿回收 + 3 个调度操作一一对应', () => {
  assert.equal(cloudRoutePaths().length, EXPECTED_OPS.length)
  assert.deepEqual(
    [...cloudRoutePaths()].sort(),
    EXPECTED_OPS.map((name) => `${CLOUD_PREFIX}/${name}`).sort(),
  )
})

test('cloud 路由路径唯一（宿主 exact 表只按 path 做键）', () => {
  const paths = cloudRoutePaths()
  assert.equal(new Set(paths).size, paths.length)
})

test('cloud 路由全部落在 CLOUD_PREFIX 下且是 exact 项', () => {
  for (const item of cloudRoutes()) {
    assert.equal(item.kind, 'exact')
    assert.ok(item.path.startsWith(`${CLOUD_PREFIX}/`), item.path)
    assert.equal(typeof item.handler, 'function')
  }
})

test('vendored cloud-core 导出齐全（跨设备可用性的前提）', () => {
  for (const name of REQUIRED_CORE_EXPORTS) {
    assert.equal(typeof cloudCore[name], 'function', `cloud-core 缺少导出 ${name}`)
  }
})

test('cloud-core 与 session 路由前缀不冲突（跨前缀唯一）', () => {
  const sessionPaths = cloudRoutePaths().map((p) => p.replace(CLOUD_PREFIX, '/api/dsh-session-sync'))
  assert.equal(new Set(sessionPaths).size, sessionPaths.length)
})