// lib/domain.mjs — 'session_sync' 存储领域声明（唯一允许 zod/DSH 包的 lib 模块：
// 领域记录 schema 是持久边界校验器，zod 与 defineDomain 是 harness 自身词汇）。

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { DOMAIN_NAME, LIMITS, SCHEDULE_MODES, RESTORE_MODES, RESTORE_STATES } from './constants.mjs'

/**
 * 同步元数据记录（state 表单例键）：设备 id（fork 归属/提交署名）、最近
 * 推/拉时间、最近推送头与最近错误。介质上每条记录在 open 时按此校验
 * （invalid-record 响亮拒绝，绝不静默跳过）。
 */
export const syncStateSchema = z.object({
  deviceId: z.string().min(1).max(LIMITS.MAX_DEVICE_ID_LENGTH),
  lastPullAt: z.number().int().nonnegative().optional(),
  lastPushAt: z.number().int().nonnegative().optional(),
  lastPushHead: z.string().regex(/^[0-9a-f]{40,64}$/iu).optional(),
  lastError: z.string().max(500).optional(),
})

/**
 * 自动备份计划（Web 页面手动配置；默认关闭）。
 * - 'daily'：每天本地时间 atHour:atMinute 触发。
 * - 'interval'：每 everyMinutes 分钟触发一次。
 */
export const scheduleSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum([SCHEDULE_MODES.DAILY, SCHEDULE_MODES.INTERVAL]),
  atHour: z.number().int().min(0).max(23),
  atMinute: z.number().int().min(0).max(59),
  everyMinutes: z.number().int().min(LIMITS.MIN_SCHEDULE_MINUTES).max(LIMITS.MAX_SCHEDULE_MINUTES),
})

/**
 * UI 配置（Web 页面保存）：远端、分支与自动备份计划。
 * 页面保存值覆盖 bundle 的空远端默认，但**不**改写 profile 文件。
 * 绝不包含任何凭据（Token/密码/私钥）——认证交给 SSH/系统 git 凭据助手。
 */
export const uiConfigSchema = z.object({
  remote: z.string().max(LIMITS.MAX_REMOTE_LENGTH),
  branch: z.string().min(1).max(LIMITS.MAX_BRANCH_LENGTH),
  authMode: z.enum(['system', 'ssh-key']).optional(),
  sshKeyPath: z.string().max(4096).optional(),
  schedule: scheduleSchema,
  updatedAt: z.number().int().nonnegative().optional(),
})

/**
 * 还原任务记录（'restore' 表）。
 * 完整覆盖是两阶段操作：页面写 pending 任务 → 独立 helper 在 DSH 完全退出后
 * 执行替换 → 回写终态。任一步失败即回滚安全快照。
 */
export const restoreTaskSchema = z.object({
  id: z.string().min(1).max(64),
  mode: z.enum([RESTORE_MODES.MERGE, RESTORE_MODES.OVERWRITE]),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/iu),
  state: z.enum([
    RESTORE_STATES.PENDING,
    RESTORE_STATES.RUNNING,
    RESTORE_STATES.SUCCEEDED,
    RESTORE_STATES.FAILED,
    RESTORE_STATES.CANCELLED,
  ]),
  snapshotDir: z.string().max(4096).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** 执行结果摘要（脱敏后的短文本）。 */
  detail: z.string().max(1000).optional(),
})

/**
 * 'session_sync' 领域 spec：三张表。
 * - state：单例同步元数据（设备 id、最近推/拉）。
 * - config：单例 UI 配置（远端、分支、自动备份计划）。
 * - restore：还原任务（按 id 键控，保留最近记录）。
 * version 变更即废弃整介质（预发布立场，无迁移）。
 */
export const sessionSyncDomainSpec = defineDomain({
  name: DOMAIN_NAME,
  version: 2,
  tables: {
    state: domainTable(syncStateSchema),
    config: domainTable(uiConfigSchema),
    restore: domainTable(restoreTaskSchema),
  },
})
