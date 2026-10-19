// test/uiconfig.test.mjs — 页面配置校验与规范化（纯逻辑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultUiConfig, normalizeUiConfigPatch } from '../lib/uiconfig.mjs'
import { SCHEDULE_MODES } from '../lib/constants.mjs'

test('默认配置：远端继承、分支 main、自动备份关闭', () => {
  const config = defaultUiConfig({})
  assert.equal(config.remote, '')
  assert.equal(config.branch, 'main')
  assert.equal(config.schedule.enabled, false)
})

test('默认配置继承插件 Config 的远端与分支', () => {
  const config = defaultUiConfig({ remote: 'git@github.com:me/sessions.git', branch: 'backup' })
  assert.equal(config.remote, 'git@github.com:me/sessions.git')
  assert.equal(config.branch, 'backup')
})

test('patch 只改提交的键，其余沿用', () => {
  const base = defaultUiConfig({})
  const next = normalizeUiConfigPatch({ remote: 'git@example.com:a/b.git' }, base)
  assert.equal(next.remote, 'git@example.com:a/b.git')
  assert.equal(next.branch, 'main', '未提交的键保持不变')
})

test('remote 两端空白被裁剪', () => {
  const next = normalizeUiConfigPatch({ remote: '  git@example.com:a/b.git  ' }, defaultUiConfig({}))
  assert.equal(next.remote, 'git@example.com:a/b.git')
})

test('branch 非法值响亮失败', () => {
  const base = defaultUiConfig({})
  assert.throws(() => normalizeUiConfigPatch({ branch: '' }, base), /branch/)
  assert.throws(() => normalizeUiConfigPatch({ branch: 'has space' }, base), /branch/)
  assert.throws(() => normalizeUiConfigPatch({ branch: 'bad~name' }, base), /branch/)
})

test('schedule 字段越界失败，不静默钳制', () => {
  const base = defaultUiConfig({})
  assert.throws(() => normalizeUiConfigPatch({ schedule: { atHour: 24 } }, base), /atHour/)
  assert.throws(() => normalizeUiConfigPatch({ schedule: { atHour: -1 } }, base), /atHour/)
  assert.throws(() => normalizeUiConfigPatch({ schedule: { atMinute: 60 } }, base), /atMinute/)
  assert.throws(() => normalizeUiConfigPatch({ schedule: { everyMinutes: 1 } }, base), /everyMinutes/)
  assert.throws(() => normalizeUiConfigPatch({ schedule: { mode: 'hourly' } }, base), /mode/)
})

test('schedule 部分提交只覆盖给定字段', () => {
  const base = defaultUiConfig({})
  const next = normalizeUiConfigPatch({ schedule: { enabled: true, mode: SCHEDULE_MODES.INTERVAL, everyMinutes: 30 } }, base)
  assert.equal(next.schedule.enabled, true)
  assert.equal(next.schedule.mode, SCHEDULE_MODES.INTERVAL)
  assert.equal(next.schedule.everyMinutes, 30)
  assert.equal(next.schedule.atHour, base.schedule.atHour, '未提交字段沿用')
})

test('非对象 patch 失败', () => {
  assert.throws(() => normalizeUiConfigPatch(null, defaultUiConfig({})), /object/)
  assert.throws(() => normalizeUiConfigPatch('x', defaultUiConfig({})), /object/)
})

test('remote 超长失败', () => {
  assert.throws(() => normalizeUiConfigPatch({ remote: 'a'.repeat(3000) }, defaultUiConfig({})), /remote/)
})
