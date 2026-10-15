// lib/schedule.mjs — 自动备份时间计算（纯函数，零依赖）。
//
// 语义：
// - 'daily'：每个本地日的 atHour:atMinute 触发一次。
// - 'interval'：自 armedAt 起每 everyMinutes 分钟触发一次。
// - 启动时只计算**未来**的下一个执行点，绝不返回过去的时刻——DSH 停机期间
//   错过的计划不补跑（避免开机瞬间连发多次推送）。

import { SCHEDULE_MODES } from './constants.mjs'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/**
 * 计算下一个执行时刻。
 * @param {object} schedule - {enabled, mode, atHour, atMinute, everyMinutes}。
 * @param {number} now - 当前时刻（ms）。
 * @param {number} [armedAt] - interval 模式的起算点（缺省=now）。
 * @returns {number|undefined} 下一个执行时刻；未启用或非法时为 undefined。
 */
export function nextRunAt(schedule, now, armedAt) {
  if (schedule === null || typeof schedule !== 'object') return undefined
  if (schedule.enabled !== true) return undefined
  if (schedule.mode === SCHEDULE_MODES.INTERVAL) {
    const every = schedule.everyMinutes
    if (!Number.isInteger(every) || every <= 0) return undefined
    const base = Number.isFinite(armedAt) ? armedAt : now
    const period = every * MINUTE_MS
    if (now < base) return base
    // 严格大于 now：恰好对齐时也推到一个完整周期之后，避免边界重入。
    const elapsed = now - base
    const steps = Math.floor(elapsed / period) + 1
    return base + steps * period
  }
  if (schedule.mode === SCHEDULE_MODES.DAILY) {
    const hour = schedule.atHour
    const minute = schedule.atMinute
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined
    const current = new Date(now)
    // 用本地日历字段逐日推进，跨夏令时/闰日时仍取本地墙上时间。
    for (let offset = 1; offset <= 2; offset += 1) {
      const candidate = new Date(
        current.getFullYear(),
        current.getMonth(),
        current.getDate() + (offset - 1),
        hour,
        minute,
        0,
        0,
      )
      if (candidate.getTime() > now) return candidate.getTime()
    }
    // 理论上不可达（两天内必有未来时刻）；保守回退一天后。
    return now + DAY_MS
  }
  return undefined
}

/**
 * 距下一次执行的毫秒数（用于 setTimeout；未启用时为 undefined）。
 * @param {object} schedule - 计划。
 * @param {number} now - 当前时刻。
 * @param {number} [armedAt] - interval 起算点。
 * @returns {number|undefined} 延迟毫秒（≥1）。
 */
export function delayUntilNextRun(schedule, now, armedAt) {
  const target = nextRunAt(schedule, now, armedAt)
  if (target === undefined) return undefined
  return Math.max(1, target - now)
}

/**
 * 人可读的计划描述（页面/日志用；纯函数，便于断言）。
 * @param {object} schedule - 计划。
 * @returns {string} 描述文本。
 */
export function describeSchedule(schedule) {
  if (schedule === null || typeof schedule !== 'object' || schedule.enabled !== true) return 'off'
  if (schedule.mode === SCHEDULE_MODES.INTERVAL) return `every ${schedule.everyMinutes} minute(s)`
  const hh = String(schedule.atHour).padStart(2, '0')
  const mm = String(schedule.atMinute).padStart(2, '0')
  return `daily at ${hh}:${mm} (local time)`
}
