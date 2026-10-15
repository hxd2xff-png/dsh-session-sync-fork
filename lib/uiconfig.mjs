// lib/uiconfig.mjs — Web 页面的 UI 配置（远端/分支/自动备份计划）读写与校验。
//
// 纯逻辑 + 一张 storage 表句柄；不含 DSH 服务依赖，便于单测。
// 页面保存值覆盖 bundle 的空远端默认，但绝不改写 profile 文件。
// 凭据（Token/密码/私钥）一律不落此存储——认证交给 SSH / 系统 git 凭据助手。

import { CONFIG_KEY, DEFAULTS, LIMITS, SCHEDULE_MODES } from './constants.mjs'
import { badConfig } from './errors.mjs'

/**
 * 默认 UI 配置：远端继承插件 Config（通常为空）、分支继承 Config、
 * 自动备份关闭且为每日模式。DSH 未运行时也不补跑。
 * @param {{remote?: string, branch?: string}} [fallback] - 插件 Config 的兜底值。
 * @returns {{remote: string, branch: string, schedule: {enabled: boolean, mode: string, atHour: number, atMinute: number, everyMinutes: number}}}
 */
export function defaultUiConfig(fallback = {}) {
  return {
    remote: typeof fallback.remote === 'string' ? fallback.remote : '',
    branch: typeof fallback.branch === 'string' && fallback.branch.length > 0 ? fallback.branch : DEFAULTS.BRANCH,
    schedule: {
      enabled: false,
      mode: SCHEDULE_MODES.DAILY,
      atHour: 3,
      atMinute: 0,
      everyMinutes: 60,
    },
  }
}

/** 值是否为有限整数。 */
function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * 校验并规范化页面提交的 patch（只接受已知键；未知键忽略）。
 * 越界响亮失败（BAD_CONFIG），绝不静默钳制。
 * @param {object} patch - 页面提交的部分配置。
 * @param {object} base - 当前生效配置（未提交的键沿用）。
 * @returns {object} 规范化后的完整配置。
 */
export function normalizeUiConfigPatch(patch, base) {
  if (patch === null || typeof patch !== 'object') throw badConfig('settings patch must be an object')
  const next = {
    remote: base.remote,
    branch: base.branch,
    schedule: { ...base.schedule },
  }
  if ('remote' in patch) {
    if (typeof patch.remote !== 'string') throw badConfig('remote must be a string')
    const trimmed = patch.remote.trim()
    if (trimmed.length > LIMITS.MAX_REMOTE_LENGTH) throw badConfig(`remote exceeds ${LIMITS.MAX_REMOTE_LENGTH} characters`)
    next.remote = trimmed
  }
  if ('branch' in patch) {
    if (typeof patch.branch !== 'string') throw badConfig('branch must be a string')
    const trimmed = patch.branch.trim()
    if (trimmed.length === 0) throw badConfig('branch must not be empty')
    if (trimmed.length > LIMITS.MAX_BRANCH_LENGTH) throw badConfig(`branch exceeds ${LIMITS.MAX_BRANCH_LENGTH} characters`)
    if (/[\s~^:?*[\]\\]/u.test(trimmed)) throw badConfig('branch contains characters git refuses')
    next.branch = trimmed
  }
  if ('schedule' in patch) {
    const schedule = patch.schedule
    if (schedule === null || typeof schedule !== 'object') throw badConfig('schedule must be an object')
    const merged = { ...next.schedule }
    if ('enabled' in schedule) {
      if (typeof schedule.enabled !== 'boolean') throw badConfig('schedule.enabled must be a boolean')
      merged.enabled = schedule.enabled
    }
    if ('mode' in schedule) {
      if (schedule.mode !== SCHEDULE_MODES.DAILY && schedule.mode !== SCHEDULE_MODES.INTERVAL) {
        throw badConfig(`schedule.mode must be one of ${SCHEDULE_MODES.DAILY}|${SCHEDULE_MODES.INTERVAL}`)
      }
      merged.mode = schedule.mode
    }
    if ('atHour' in schedule) {
      if (!isInt(schedule.atHour) || schedule.atHour < 0 || schedule.atHour > 23) throw badConfig('schedule.atHour must be an integer in [0, 23]')
      merged.atHour = schedule.atHour
    }
    if ('atMinute' in schedule) {
      if (!isInt(schedule.atMinute) || schedule.atMinute < 0 || schedule.atMinute > 59) throw badConfig('schedule.atMinute must be an integer in [0, 59]')
      merged.atMinute = schedule.atMinute
    }
    if ('everyMinutes' in schedule) {
      if (!isInt(schedule.everyMinutes) || schedule.everyMinutes < LIMITS.MIN_SCHEDULE_MINUTES || schedule.everyMinutes > LIMITS.MAX_SCHEDULE_MINUTES) {
        throw badConfig(`schedule.everyMinutes must be an integer in [${LIMITS.MIN_SCHEDULE_MINUTES}, ${LIMITS.MAX_SCHEDULE_MINUTES}]`)
      }
      merged.everyMinutes = schedule.everyMinutes
    }
    next.schedule = merged
  }
  return next
}

/**
 * 读取 UI 配置（缺失或无表时返回兜底）。
 * @param {object} deps - {table: Promise<object|undefined>, fallback: object}。
 * @returns {Promise<object>} 生效配置。
 */
export async function loadUiConfig(deps) {
  const fallback = defaultUiConfig(deps.fallback ?? {})
  let table
  try {
    table = await deps.table
  } catch {
    return fallback
  }
  if (table === undefined || table === null) return fallback
  try {
    const stored = await table.get(CONFIG_KEY)
    if (stored === undefined) return fallback
    // 存储记录可能来自旧版本：逐键校验后再合并，非法值退回兜底而不是抛错
    // （页面配置损坏不应阻断插件挂载）。
    return {
      remote: typeof stored.remote === 'string' ? stored.remote : fallback.remote,
      branch: typeof stored.branch === 'string' && stored.branch.length > 0 ? stored.branch : fallback.branch,
      schedule: normalizeStoredSchedule(stored.schedule, fallback.schedule),
      updatedAt: stored.updatedAt,
    }
  } catch {
    return fallback
  }
}

/** 存储里的计划记录 → 合法计划（任何非法字段退回兜底）。 */
function normalizeStoredSchedule(stored, fallback) {
  if (stored === null || typeof stored !== 'object') return { ...fallback }
  const mode = stored.mode === SCHEDULE_MODES.INTERVAL ? SCHEDULE_MODES.INTERVAL : SCHEDULE_MODES.DAILY
  return {
    enabled: stored.enabled === true,
    mode,
    atHour: isInt(stored.atHour) && stored.atHour >= 0 && stored.atHour <= 23 ? stored.atHour : fallback.atHour,
    atMinute: isInt(stored.atMinute) && stored.atMinute >= 0 && stored.atMinute <= 59 ? stored.atMinute : fallback.atMinute,
    everyMinutes: isInt(stored.everyMinutes) && stored.everyMinutes >= LIMITS.MIN_SCHEDULE_MINUTES && stored.everyMinutes <= LIMITS.MAX_SCHEDULE_MINUTES
      ? stored.everyMinutes
      : fallback.everyMinutes,
  }
}

/**
 * 写入 UI 配置（全量覆盖单例记录）。
 * @param {object} deps - {table: Promise<object|undefined>}。
 * @param {object} config - 已规范化的完整配置。
 * @returns {Promise<object>} 落盘后的配置（含 updatedAt）。
 */
export async function saveUiConfig(deps, config) {
  const table = await deps.table
  if (table === undefined || table === null) throw badConfig('storage domain is unavailable; settings cannot be saved')
  const record = { ...config, updatedAt: Date.now() }
  await table.put(CONFIG_KEY, record)
  return record
}
