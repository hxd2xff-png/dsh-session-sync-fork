// test/paths.test.mjs — 动态路径检测契约（每台设备不同，禁止个人路径写死）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { detectDshHome, resolveSessionRoot, resolveRepoDir } from '../lib/paths.mjs'

test('detectDshHome 优先取 $DSH_HOME', () => {
  assert.equal(detectDshHome(undefined, { DSH_HOME: '/custom/home' }), '/custom/home')
})

test('detectDshHome 从插件安装路径反推 home（Electron 无 $DSH_HOME 的主路径）', () => {
  const win = 'C:\\Users\\someone\\.dsh\\profiles\\desktop\\node_modules\\dsh-session-sync\\lib\\paths.mjs'
  assert.equal(path.resolve(detectDshHome(win, {})), path.resolve('C:\\Users\\someone\\.dsh'))
  const unix = '/home/dev/.dsh/profiles/web/node_modules/dsh-session-sync/lib/paths.mjs'
  assert.equal(detectDshHome(unix, {}), path.resolve('/home/dev/.dsh'))
})

test('detectDshHome 安装路径不匹配时兜底 ~/.dsh', () => {
  const detected = detectDshHome('/opt/elsewhere/plugin.mjs', {})
  assert.ok(detected.endsWith('.dsh'), detected)
})

test('resolveSessionRoot/RepoDir 空配置走动态 home，绝不写死个人路径', () => {
  assert.equal(resolveSessionRoot('', '/h'), path.join('/h', 'sessions'))
  assert.equal(resolveRepoDir('', '/h'), path.join('/h', 'dsh-session-sync', 'repo'))
  // 显式配置仍然优先（老配置不受影响）。
  assert.equal(resolveSessionRoot('/explicit', '/h'), path.resolve('/explicit'))
})

test('本仓库运行位置自身可被解析（真实安装路径冒烟）', () => {
  const detected = detectDshHome()
  assert.ok(typeof detected === 'string' && detected.length > 0, 'detectDshHome() 无注入时必须有结果')
})
