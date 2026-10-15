// test/schedule.test.mjs — 自动备份时间计算（纯函数，无 DSH 依赖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRunAt, delayUntilNextRun, describeSchedule } from '../lib/schedule.mjs'
import { SCHEDULE_MODES } from '../lib/constants.mjs'

const daily = (hour, minute) => ({
  enabled: true,
  mode: SCHEDULE_MODES.DAILY,
  atHour: hour,
  atMinute: minute,
  everyMinutes: 60,
})

const interval = (minutes) => ({
  enabled: true,
  mode: SCHEDULE_MODES.INTERVAL,
  atHour: 0,
  atMinute: 0,
  everyMinutes: minutes,
})

test('daily: 当天时刻未到 → 取当天', () => {
  // 2026-10-14 08:00 本地，计划 09:30 → 当天 09:30。
  const now = new Date(2026, 9, 14, 8, 0, 0, 0).getTime()
  const at = nextRunAt(daily(9, 30), now)
  assert.equal(new Date(at).getHours(), 9)
  assert.equal(new Date(at).getMinutes(), 30)
  assert.equal(new Date(at).getDate(), 14)
})

test('daily: 当天时刻已过 → 顺延到次日', () => {
  const now = new Date(2026, 9, 14, 10, 0, 0, 0).getTime()
  const at = nextRunAt(daily(9, 30), now)
  assert.equal(new Date(at).getDate(), 15)
  assert.equal(new Date(at).getHours(), 9)
})

test('daily: 恰好等于当前时刻 → 推到次日（不重入）', () => {
  const now = new Date(2026, 9, 14, 9, 30, 0, 0).getTime()
  const at = nextRunAt(daily(9, 30), now)
  assert.ok(at > now, '必须严格晚于 now')
  assert.equal(new Date(at).getDate(), 15)
})

test('daily: 跨月边界', () => {
  const now = new Date(2026, 9, 31, 23, 0, 0, 0).getTime()
  const at = nextRunAt(daily(1, 0), now)
  assert.equal(new Date(at).getMonth(), 10, '应落在 11 月')
  assert.equal(new Date(at).getDate(), 1)
})

test('interval: 从起算点按周期推进', () => {
  const armedAt = 1_000_000
  const now = armedAt + 30_000
  const at = nextRunAt(interval(5), now, armedAt)
  assert.equal(at, armedAt + 5 * 60_000)
})

test('interval: 已过多个周期 → 取下一个未来点，绝不返回过去', () => {
  const armedAt = 0
  const now = 100 * 60_000
  const at = nextRunAt(interval(10), now, armedAt)
  assert.ok(at > now, '必须是未来时刻')
  assert.equal(at, 110 * 60_000)
})

test('停机期间错过的计划不补跑：过去时刻永不返回', () => {
  // 模拟 DSH 停机两天后启动：daily 计划仍只给未来点。
  const now = new Date(2026, 9, 16, 12, 0, 0, 0).getTime()
  const at = nextRunAt(daily(3, 0), now)
  assert.ok(at > now)
  assert.equal(new Date(at).getDate(), 17)
})

test('未启用 → undefined', () => {
  assert.equal(nextRunAt({ ...daily(3, 0), enabled: false }, Date.now()), undefined)
})

test('非法字段 → undefined（不静默纠正）', () => {
  assert.equal(nextRunAt(daily(99, 0), Date.now()), undefined)
  assert.equal(nextRunAt(daily(0, 99), Date.now()), undefined)
  assert.equal(nextRunAt(interval(0), Date.now()), undefined)
  assert.equal(nextRunAt(null, Date.now()), undefined)
})

test('delayUntilNextRun 恒为正数', () => {
  const now = new Date(2026, 9, 14, 12, 0, 0, 0).getTime()
  const delay = delayUntilNextRun(daily(3, 0), now)
  assert.ok(delay > 0)
  assert.equal(delay, nextRunAt(daily(3, 0), now) - now)
})

test('describeSchedule 文本', () => {
  assert.equal(describeSchedule({ ...daily(3, 5) }), 'daily at 03:05 (local time)')
  assert.equal(describeSchedule(interval(30)), 'every 30 minute(s)')
  assert.equal(describeSchedule({ ...daily(3, 0), enabled: false }), 'off')
})
