// index.mjs — dsh-session-sync 插件入口（唯一 host 面文件）。
//
// 功能：把 DSH 会话存储目录（默认 $DSH_HOME/sessions）作为不透明字节镜像进
// 一个专用 git 工作树并同步到自定义 remote：
// - 默认 git 后端（ctx.subprocess 跑 git；动词白名单 + 绝不强推）；backend 词汇
//   预留端到端加密后端（age/GPG 类），密钥不入仓库（当前配置即响亮失败）。
// - /sync 命令（status|pull|push|diff|log|help；pull/push 走确认门）与
//   sync_pull / sync_push / sync_status 模型工具（操作走审批，轮次内可用）。
// - 冲突裁决：会话日志 append-only —— 双边纯追加/真实分歧一律"本地保留 +
//   远端留存 fork 文件"，绝不静默覆盖（lib/merge.mjs 语义 + 测试）。
// - 自动模式：autoPullOnStart / autoPushOnTurnEnd（turn/end 会话事件）/
//   pullIntervalMinutes（周期拉取；定时与事件全部走 ctx.effect 可逆）。
// - 同步元数据（设备 id、最近推/拉、最近错误）存 ctx.storageDomain 领域
//   'session-sync'。
//
// 只消费公开服务：sessions / commands / storageDomain / subprocess（inject
// 声明），tools 经 ctx.inject 可选注册；userQuestions / approval 可选查找
// （缺失 = 失败关闭）。lib/ 零 DSH 依赖，服务只在边界接线。

import { randomUUID } from 'node:crypto'
import { resolveGitExecutable } from './lib/git-executable.mjs'
import { gitAuthEnvironment } from './lib/git-auth.mjs'
import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  API_PREFIX,
  BACKENDS,
  COMMAND_NAME,
  COMMIT_MESSAGE_AUTO,
  COMMIT_MESSAGE_MANUAL,
  CONFIRM_CHANNELS,
  DEFAULTS,
  LIMITS,
  PLUGIN_NAME,
  RESTORE_STATES,
  SCHEDULE_MODES,
  SESSION_EVENTS,
  SNAPSHOT_DIR_NAME,
  STATE_KEY,
  TOOL_PULL,
  TOOL_PUSH,
  TOOL_STATUS,
} from './lib/constants.mjs'
import {
  badConfig,
  backendUnsupported,
  messageOf,
  registryUnavailable,
} from './lib/errors.mjs'
import {
  assertNestingSafe,
  resolveRepoDir,
  resolveSessionRoot,
  sessionIdOfForkPath,
} from './lib/paths.mjs'
import { GitBackend } from './lib/git.mjs'
import { SyncEngine } from './lib/engine.mjs'
import { EncryptedBackend, encryptTree, decryptTree, mergeTrees } from './lib/encrypted.mjs'
import { selectEncryptionMode } from './lib/backend.mjs'
import { detectAge, ageEncrypt, ageDecrypt } from './lib/age.mjs'
import { collectStatus } from './lib/status.mjs'
import { renderDiff, renderPull, renderPush, renderStatus, errorValue } from './lib/render.mjs'
import { confirmSync, hasOpenTurn, makeEventGate, maybeAppendSessionEvent, openTurnFromProjection } from './lib/gate.mjs'
import { sessionSyncDomainSpec } from './lib/domain.mjs'
import { defaultUiConfig, loadUiConfig, normalizeUiConfigPatch, saveUiConfig } from './lib/uiconfig.mjs'
import { delayUntilNextRun, describeSchedule, nextRunAt } from './lib/schedule.mjs'
import { countMirrorFilesAtCommit, deleteHistoryCommit, listHistory } from './lib/history.mjs'
import { createSafetySnapshot, materializeCommit, mergeRestore, overwriteApply, previewRestore } from './lib/restore.mjs'
import { OperationGate, buildRoutes, route } from './lib/api.mjs'
import { createSessionMapper, sessionHeader } from './lib/session-portable.mjs'
import { WORKSPACE_MANIFEST, captureWorkspaceManifest, repairMirroredWorkspaceGrouping, restoreWorkspaceGrouping } from './lib/workspace-manifest.mjs'
import { detectDshHome } from './lib/paths.mjs'
import { cloudRoutes, cloudRoutePaths, cloudOperationBusy, withCloudOperation, readPluginSchedule, runPluginBackup, setCloudProgressSink } from './lib/cloud.mjs'
import { ProgressRegistry, feedGitProgress } from './lib/progress.mjs'

// 模块级探针：所有 import 解析完毕后立即写入。无此记录 = 模块体从未执行
// （某个 import 解析失败，或宿主根本没加载本模块）。
try {
  fsSync.appendFileSync(
    path.join(os.homedir(), '.dsh', 'session-sync-import.log'),
    `${new Date().toISOString()} module-body-started pid=${process.pid}\n`,
  )
} catch {
  // 探针失败绝不影响模块加载。
}

export const name = PLUGIN_NAME

/**
 * 必需服务。
 *
 * 关键约束（读 cordis 源码 + 参照 dsh-checkpoint-rewind 得出）：
 * cordis 的 `_refresh()` 对 inject 里的**每一项**都要求可解析，任一缺失就把整个
 * fiber 置为 INACTIVE（state=5），`apply` 永不调用——插件静默挂起。
 *
 * `storageDomain` 在本机的组合里不保证存在（它由 dsh-storage-domain 经
 * `provide()` 挂载，且要求 Config.backend 指向一个存在的 storage 后端）。
 * 把它放进必需列表会让插件永久挂起（原版 0.2.24 即因此从未真正挂载）。
 * 因此与 dsh-checkpoint-rewind 一致：storageDomain 改为 apply 内 `ctx.get()`
 * 可选获取，缺失时存储相关能力优雅降级，插件照常挂载。
 */
export const inject = ['sessions', 'commands', 'subprocess']

/**
 * 宿主 append 是否盖章 ignorable 信封（运行时能力探测）。
 * 在全新 detached Context 上构造 SessionStore（绝不接入宿主持久化，探测
 * 会话不落盘）：追加一条带 { ignorable: true } 的探测事件并回读信封标记。
 * rc.6 的 append 静默丢弃未知选项键；rc.8/rc.2 的 append 对非 surface 类型不接受
 * 信封选项（ignorable 只是读取路径的标记）→ 探测事件均无 ignorable →
 * false（门保持关闭）；
 * append 会盖章 ignorable 信封的宿主 → true（sync/* 以 ignorable 落盘）。
 * @returns {boolean} 宿主支持 ignorable 信封。
 */
export function probeIgnorableAppend() {
  try {
    const store = new SessionStore(new Context())
    const session = store.create()
    const event = session.append(SESSION_EVENTS.PUSH, {
      sessionId: 'probe',
      ok: true,
      pushed: true,
      head: 'probe',
      // @ts-ignore non-surface append takes no envelope option — probing it is the point.
    }, /** @type {any} */ ({ ignorable: true }))
    return event?.ignorable === true
  } catch {
    return false
  }
}

/**
 * 插件配置（Schemastery，全部可 cordis.yml 覆盖；无硬编码 tunable）。
 * @typedef {object} Config
 * @property {boolean} [enabled] 整体开关；false 时不注册任何东西。
 * @property {string} [backend] 同步后端词汇；只有 'git' 实现，其余（加密后端）预留并响亮失败。
 * @property {string} [sessionRoot] 会话存储根；空 = $DSH_HOME/sessions（两者皆缺响亮失败）。
 * @property {string} [repoDir] 同步 git 工作树根；空 = $DSH_HOME/dsh-session-sync/repo。
 * @property {string} [remote] 远端地址（自定义 remote；pull/push 前必须非空，status/diff 不需要）。
 * @property {string} [branch] 远端分支名（默认 main）。
 * @property {string} [gitBin] git 可执行路径（默认 'git'）。
 * @property {string} [ageBin] age 可执行路径（默认 'age'；backend: encrypted 时探测，缺失降级明文）。
 * @property {string} [ageRecipient] age 收件人（公钥/身份串；空 = 无法加密，降级明文）。
 * @property {string} [ageIdentity] age 身份文件路径（无口令私钥；空 = 无法解密，降级明文）。
 * @property {boolean} [autoPullOnStart] 挂载时自动拉取一次（配置即授权，不再确认）。
 * @property {boolean} [autoPushOnTurnEnd] 每个 turn/end 后自动推送（配置即授权）。
 * @property {number} [pullIntervalMinutes] 周期自动拉取间隔分钟（0 = 关闭）。
 * @property {'auto'|'userQuestions'|'approval'} [confirmVia] 确认通道（auto 优先 userQuestions）。
 * @property {number} [graceMs] git 子进程终止宽限（ms）。
 * @property {number} [commandTimeoutMs] 单条 git 命令超时（ms）。
 * @property {number} [maxOutputBytes] git 输出单流收集上限（字节）。
 * @property {string} [commitName] 插件提交者名。
 * @property {string} [commitEmail] 插件提交者邮箱。
 * @property {boolean} [registerCommand] 注册 /sync 命令。
 * @property {boolean} [registerTools] tools 服务存在时注册 sync_* 工具。
 */
// Service Definition — Config: the plugin's public configuration contract
// (Schemastery schema), validated loudly at load by resolveConfig.
export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.ENABLED),
  backend: Schema.union(Object.values(BACKENDS)).default(DEFAULTS.BACKEND),
  sessionRoot: Schema.string().default(DEFAULTS.SESSION_ROOT),
  repoDir: Schema.string().default(DEFAULTS.REPO_DIR),
  remote: Schema.string().default(DEFAULTS.REMOTE),
  branch: Schema.string().default(DEFAULTS.BRANCH),
  gitBin: Schema.string().default(DEFAULTS.GIT_BIN),
  ageBin: Schema.string().default(DEFAULTS.AGE_BIN),
  ageRecipient: Schema.string().default(DEFAULTS.AGE_RECIPIENT),
  ageIdentity: Schema.string().default(DEFAULTS.AGE_IDENTITY),
  autoPullOnStart: Schema.boolean().default(DEFAULTS.AUTO_PULL_ON_START),
  autoPushOnTurnEnd: Schema.boolean().default(DEFAULTS.AUTO_PUSH_ON_TURN_END),
  pullIntervalMinutes: Schema.number().default(DEFAULTS.PULL_INTERVAL_MINUTES),
  confirmVia: Schema.union(Object.values(CONFIRM_CHANNELS)).default(DEFAULTS.CONFIRM_VIA),
  graceMs: Schema.number().default(DEFAULTS.GRACE_MS),
  commandTimeoutMs: Schema.number().default(DEFAULTS.COMMAND_TIMEOUT_MS),
  maxOutputBytes: Schema.number().default(DEFAULTS.MAX_OUTPUT_BYTES),
  commitName: Schema.string().default(DEFAULTS.COMMIT_NAME),
  commitEmail: Schema.string().default(DEFAULTS.COMMIT_EMAIL),
  registerCommand: Schema.boolean().default(DEFAULTS.REGISTER_COMMAND),
  registerTools: Schema.boolean().default(DEFAULTS.REGISTER_TOOLS),
})

/**
 * 显式补齐默认 + 加载期校验（非法配置响亮失败）。
 * @param {Partial<Config>|undefined} config - cordis loader 传入的配置。
 * @returns {Required<Config>} 校验后的配置。
 */
export function resolveConfig(config = {}) {
  const resolved = {
    enabled: config.enabled ?? DEFAULTS.ENABLED,
    backend: config.backend ?? DEFAULTS.BACKEND,
    sessionRoot: config.sessionRoot ?? DEFAULTS.SESSION_ROOT,
    repoDir: config.repoDir ?? DEFAULTS.REPO_DIR,
    remote: config.remote ?? DEFAULTS.REMOTE,
    branch: config.branch ?? DEFAULTS.BRANCH,
    gitBin: config.gitBin ?? DEFAULTS.GIT_BIN,
    ageBin: config.ageBin ?? DEFAULTS.AGE_BIN,
    ageRecipient: config.ageRecipient ?? DEFAULTS.AGE_RECIPIENT,
    ageIdentity: config.ageIdentity ?? DEFAULTS.AGE_IDENTITY,
    autoPullOnStart: config.autoPullOnStart ?? DEFAULTS.AUTO_PULL_ON_START,
    autoPushOnTurnEnd: config.autoPushOnTurnEnd ?? DEFAULTS.AUTO_PUSH_ON_TURN_END,
    pullIntervalMinutes: config.pullIntervalMinutes ?? DEFAULTS.PULL_INTERVAL_MINUTES,
    confirmVia: config.confirmVia ?? DEFAULTS.CONFIRM_VIA,
    graceMs: config.graceMs ?? DEFAULTS.GRACE_MS,
    commandTimeoutMs: config.commandTimeoutMs ?? DEFAULTS.COMMAND_TIMEOUT_MS,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULTS.MAX_OUTPUT_BYTES,
    commitName: config.commitName ?? DEFAULTS.COMMIT_NAME,
    commitEmail: config.commitEmail ?? DEFAULTS.COMMIT_EMAIL,
    registerCommand: config.registerCommand ?? DEFAULTS.REGISTER_COMMAND,
    registerTools: config.registerTools ?? DEFAULTS.REGISTER_TOOLS,
  }
  if (resolved.enabled === false) return resolved
  if (!Object.values(BACKENDS).includes(/** @type {any} */ (resolved.backend))) {
    throw backendUnsupported(/** @type {any} */ (resolved.backend))
  }
  if (!Object.values(CONFIRM_CHANNELS).includes(resolved.confirmVia)) {
    throw badConfig(`confirmVia ${JSON.stringify(resolved.confirmVia)} must be one of auto|userQuestions|approval`)
  }
  if (typeof resolved.gitBin !== 'string' || resolved.gitBin.length === 0) {
    throw badConfig('gitBin must be a non-empty string')
  }
  if (typeof resolved.ageBin !== 'string' || resolved.ageBin.length === 0) {
    throw badConfig('ageBin must be a non-empty string')
  }
  if (typeof resolved.ageRecipient !== 'string') {
    throw badConfig('ageRecipient must be a string')
  }
  if (typeof resolved.ageIdentity !== 'string') {
    throw badConfig('ageIdentity must be a string')
  }
  if (typeof resolved.branch !== 'string' || resolved.branch.length === 0 || !/^[A-Za-z0-9._/-]+$/u.test(resolved.branch)) {
    throw badConfig('branch must be a non-empty ref-safe string')
  }
  if (!Number.isFinite(resolved.graceMs) || resolved.graceMs < LIMITS.MIN_GRACE_MS || resolved.graceMs > LIMITS.MAX_GRACE_MS) {
    throw badConfig(`graceMs must be an integer in [${LIMITS.MIN_GRACE_MS}, ${LIMITS.MAX_GRACE_MS}]`)
  }
  if (!Number.isFinite(resolved.commandTimeoutMs) || resolved.commandTimeoutMs < LIMITS.MIN_COMMAND_TIMEOUT_MS || resolved.commandTimeoutMs > LIMITS.MAX_COMMAND_TIMEOUT_MS) {
    throw badConfig(`commandTimeoutMs must be an integer in [${LIMITS.MIN_COMMAND_TIMEOUT_MS}, ${LIMITS.MAX_COMMAND_TIMEOUT_MS}]`)
  }
  if (!Number.isFinite(resolved.maxOutputBytes) || resolved.maxOutputBytes < LIMITS.MIN_MAX_OUTPUT_BYTES || resolved.maxOutputBytes > LIMITS.MAX_MAX_OUTPUT_BYTES) {
    throw badConfig(`maxOutputBytes must be an integer in [${LIMITS.MIN_MAX_OUTPUT_BYTES}, ${LIMITS.MAX_MAX_OUTPUT_BYTES}]`)
  }
  if (!Number.isInteger(resolved.pullIntervalMinutes) || resolved.pullIntervalMinutes < LIMITS.MIN_PULL_INTERVAL_MINUTES || resolved.pullIntervalMinutes > LIMITS.MAX_PULL_INTERVAL_MINUTES) {
    throw badConfig(`pullIntervalMinutes must be an integer in [${LIMITS.MIN_PULL_INTERVAL_MINUTES}, ${LIMITS.MAX_PULL_INTERVAL_MINUTES}]`)
  }
  if (typeof resolved.commitName !== 'string' || resolved.commitName.trim().length === 0) {
    throw badConfig('commitName must be a non-empty string')
  }
  if (typeof resolved.commitEmail !== 'string' || resolved.commitEmail.trim().length === 0) {
    throw badConfig('commitEmail must be a non-empty string')
  }
  // 空 sessionRoot/repoDir 不再要求 $DSH_HOME：paths.mjs 的 detectDshHome() 会
  // 动态检测（环境 → 本模块安装路径反推 → ~/.dsh），每台设备不同也不写死个人路径。
  return resolved
}

/**
 * git runner：ctx.subprocess 上的 collect/pipe 封装。
 * binary=true 时 stdout 走原始字节管道（读 blob 必需），否则 collect 文本。
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessRuntime} subprocess - 宿主子进程服务。
 * @param {object} opts - {gitBin, graceMs, commandTimeoutMs, maxOutputBytes}。
 * @returns {(args: string[], runOpts?: object) => Promise<{code: number, stdout: string|Buffer, stderr: string}>}
 */
export function makeRunGit(subprocess, opts) {
  return async (args, runOpts = {}) => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`git ${args[0] ?? ''} timed out after ${opts.commandTimeoutMs}ms`))
    }, opts.commandTimeoutMs)
    const onAbort = () => {
      controller.abort(runOpts.signal?.reason instanceof Error ? runOpts.signal.reason : new Error('sync operation aborted'))
    }
    if (runOpts.signal !== undefined) {
      runOpts.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const executable = await resolveGitExecutable(subprocess, opts.gitBin, controller.signal)
      const handle = subprocess.spawn({
        argv: [executable, ...args],
        cwd: runOpts.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: runOpts.binary === true ? 'pipe' : { maxBytes: opts.maxOutputBytes },
          stderr: { maxBytes: opts.maxOutputBytes },
        },
        graceMs: opts.graceMs,
        signal: controller.signal,
        env: {
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          ...(opts.authEnv ?? {}),
          ...(runOpts.env ?? {}),
        },
      })
      let raw
      if (runOpts.binary === true) {
        const chunks = []
        for await (const chunk of handle.stdout) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        raw = Buffer.concat(chunks)
      }
      // 进度观察（纯增量，不改变任何现有行为）。
      //
      // 依据 dsh-subprocess-local/lib/output.js:189 —— OutputCollector.readFrom
      // 是 **offset 基、非消费式** 读取：独立读取者互相不影响。因此这里提前读走的
      // stderr 文本，下面第 335 行的 collected.stderr.readFrom(0) 仍然能完整读到，
      // git 的失败诊断、超时判定、返回值全部保持原样。
      //
      // 不传 onStderr 时不会建立定时器，「行 282-286 的 stdio 配置」与
      // 「行 335 的 stderr 取值」都与改动前逐字节相同。
      let progressTimer = null
      if (runOpts.onStderr !== undefined) {
        const progressState = { offset: 0 }
        progressTimer = setInterval(() => {
          let read
          try {
            read = handle.collected.stderr.readFrom(progressState.offset)
          } catch {
            return // 读取失败不影响 git 结果
          }
          if (typeof read?.nextOffset === 'number') progressState.offset = read.nextOffset
          const text = typeof read?.text === 'string' ? read.text : ''
          if (text === '') return
          try {
            runOpts.onStderr(text)
          } catch {
            // 回调自身出错只吞掉，绝不改变 git 行为。
          }
        }, 120)
        if (typeof progressTimer.unref === 'function') progressTimer.unref()
      }
      try {
        const outcome = await handle.done
        if (timedOut) {
          throw new Error(`git ${args[0] ?? ''} timed out after ${opts.commandTimeoutMs}ms`)
        }
        if (runOpts.signal?.aborted === true) {
          throw runOpts.signal.reason instanceof Error ? runOpts.signal.reason : new Error('sync operation aborted')
        }
        const stdout = raw ?? handle.collected.stdout.readFrom(0).text
        const stderr = handle.collected.stderr.readFrom(0).text
        return { code: outcome.exitCode ?? (outcome.signal !== null ? 128 : 0), stdout, stderr }
      } finally {
        if (progressTimer !== null) clearInterval(progressTimer)
      }
    } finally {
      clearTimeout(timer)
      if (runOpts.signal !== undefined) {
        runOpts.signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

/**
 * age runner：ctx.subprocess 上的 collect 封装（与 makeRunGit 同构）。
 * args 为「含可执行路径的完整 argv」（lib/age.mjs 的 runner 契约），只做文本
 * 输出收集与退出码/超时/取消语义；age 加解密经文件入参（-o out in），无需 stdin。
 * @param {import('@deepseek-ai/dsh-subprocess').SubprocessRuntime} subprocess - 宿主子进程服务。
 * @param {object} opts - {graceMs, commandTimeoutMs, maxOutputBytes}。
 * @returns {(args: string[], runOpts?: object) => Promise<{code: number, stdout: string, stderr: string}>}
 */
export function makeRunAge(subprocess, opts) {
  return async (args, runOpts = {}) => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`age ${args[0] ?? ''} timed out after ${opts.commandTimeoutMs}ms`))
    }, opts.commandTimeoutMs)
    const onAbort = () => {
      controller.abort(runOpts.signal?.reason instanceof Error ? runOpts.signal.reason : new Error('sync operation aborted'))
    }
    if (runOpts.signal !== undefined) {
      runOpts.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const executable = await subprocess.resolveExecutable(args[0], undefined, controller.signal)
      const handle = subprocess.spawn({
        argv: [executable, ...args.slice(1)],
        cwd: runOpts.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: opts.maxOutputBytes },
          stderr: { maxBytes: opts.maxOutputBytes },
        },
        graceMs: opts.graceMs,
        signal: controller.signal,
      })
      const outcome = await handle.done
      if (timedOut) {
        throw new Error(`age ${args[0] ?? ''} timed out after ${opts.commandTimeoutMs}ms`)
      }
      if (runOpts.signal?.aborted === true) {
        throw runOpts.signal.reason instanceof Error ? runOpts.signal.reason : new Error('sync operation aborted')
      }
      const stdout = handle.collected.stdout.readFrom(0).text
      const stderr = handle.collected.stderr.readFrom(0).text
      return { code: outcome.exitCode ?? (outcome.signal !== null ? 128 : 0), stdout, stderr }
    } finally {
      clearTimeout(timer)
      if (runOpts.signal !== undefined) {
        runOpts.signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

/**
 * 工具参数/输出描述（双语）。
 */
const TOOL_TEXT = {
  en: {
    statusDescription: 'Show the session-sync git mirror state: branch, sanitized remote, ahead/behind counts, uncommitted files, fork files from conflicts, and the last pull/push times. Read-only: never confirms, never touches the network.',
    pullDescription: 'Pull remote session changes into the local sync mirror with append-only keep-both merge semantics (local version kept, remote version preserved as fork files — never silently overwritten). Requires user confirmation.',
    pushDescription: 'Mirror local session files into the sync repo, commit, and push to the configured remote. Never force-pushes; a rejected push reconciles by pulling first and retries once. Requires user confirmation.',
  },
}

/** sync_status 工具规范结果（与工具 schema 同构）。 */
/** @typedef {{ok: boolean, branch: string, remote: string, head?: string, remoteHead?: string, ahead: number, behind: number, dirty: string[], forks: string[], diffStat: string, mergeInProgress: boolean, lastCommits: string[], lastPullAt?: number, lastPushAt?: number, lastError?: string, error?: string, warnings?: string[]}} StatusValue */
/** @typedef {{ok: boolean, pulled?: boolean, merged?: boolean, adopted?: number, appended?: number, diverged?: number, forks?: string[], head?: string, error?: string, warnings?: string[]}} PullValue */
/** @typedef {{ok: boolean, pushed?: boolean, head?: string, mirrored?: number, deleted?: number, remote?: string, error?: string, warnings?: string[]}} PushValue */

/**
 * sync_status 工具定义（read-only：不确认、不触网）。
 * @param {{status: () => Promise<object>}} engine - 同步引擎（git 或 encrypted 后端同一 surface）。
 * @param {() => Promise<object>} readMeta - 元数据读取。
 * @returns {object} 工具定义。
 */
export function makeSyncStatusTool(engine, readMeta) {
  return defineTool({
    name: TOOL_STATUS,
    description: TOOL_TEXT.en.statusDescription,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          branch: { type: 'string' },
          remote: { type: 'string' },
          head: { type: 'string' },
          remoteHead: { type: 'string' },
          ahead: { type: 'integer' },
          behind: { type: 'integer' },
          dirty: { type: 'array', items: { type: 'string' } },
          forks: { type: 'array', items: { type: 'string' } },
          diffStat: { type: 'string' },
          mergeInProgress: { type: 'boolean' },
          lastCommits: { type: 'array', items: { type: 'string' } },
          lastPullAt: { type: 'integer' },
          lastPushAt: { type: 'integer' },
          lastError: { type: 'string' },
          error: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: renderStatus(value) }]
      },
    },
    async execute(_args, exec) {
      exec.signal?.throwIfAborted()
      const status = await engine.status()
      try {
        const meta = await readMeta()
        return { ...status, lastPullAt: meta.lastPullAt, lastPushAt: meta.lastPushAt, lastError: meta.lastError }
      } catch {
        return status
      }
    },
  })
}

/**
 * sync_pull 工具定义（操作走确认门；execute 尊重 exec.signal）。
 * @param {object} deps - {engine, ctx, confirmVia}。
 * @returns {object} 工具定义。
 */
export function makeSyncPullTool(deps) {
  return defineTool({
    name: TOOL_PULL,
    description: TOOL_TEXT.en.pullDescription,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          pulled: { type: 'boolean' },
          merged: { type: 'boolean' },
          adopted: { type: 'integer' },
          appended: { type: 'integer' },
          diverged: { type: 'integer' },
          forks: { type: 'array', items: { type: 'string' } },
          head: { type: 'string' },
          error: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: renderPull(value) }]
      },
    },
    async execute(_args, exec) {
      exec.signal?.throwIfAborted()
      const verdict = await confirmSync(
        { ctx: deps.ctx, confirmVia: deps.confirmVia, action: 'pull', summary: 'Download remote session changes into the local sync mirror (keep-both merge; never overwrites).' },
        exec.agent,
        exec.signal,
      )
      if (!verdict.allowed) {
        return errorValue(verdict.reason ?? 'confirmation failed (fail closed)')
      }
      const result = await deps.engine.pull({ signal: exec.signal })
      if (exec.agent?.session !== null && exec.agent?.session !== undefined) {
        maybeAppendSessionEvent(exec.agent.session, SESSION_EVENTS.PULL, {
          sessionId: exec.agent.session.id,
          ok: result.ok,
          error: result.error,
          pulled: result.pulled,
          merged: result.merged,
          adopted: result.adopted,
          appended: result.appended,
          diverged: result.diverged,
          forks: result.forks,
          head: result.head,
        }, deps.eventGate, (message) => deps.logger.warn(message))
      }
      return result
    },
  })
}

/**
 * sync_push 工具定义（操作走确认门；execute 尊重 exec.signal）。
 * @param {object} deps - {engine, ctx, confirmVia, eventGate, logger}。
 * @returns {object} 工具定义。
 */
export function makeSyncPushTool(deps) {
  return defineTool({
    name: TOOL_PUSH,
    description: TOOL_TEXT.en.pushDescription,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          pushed: { type: 'boolean' },
          head: { type: 'string' },
          mirrored: { type: 'integer' },
          deleted: { type: 'integer' },
          remote: { type: 'string' },
          error: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: renderPush(value) }]
      },
    },
    async execute(_args, exec) {
      exec.signal?.throwIfAborted()
      const verdict = await confirmSync(
        { ctx: deps.ctx, confirmVia: deps.confirmVia, action: 'push', summary: 'Upload local session changes to the sync remote (commit + push; never force-pushes).' },
        exec.agent,
        exec.signal,
      )
      if (!verdict.allowed) {
        return errorValue(verdict.reason ?? 'confirmation failed (fail closed)')
      }
      const result = await deps.engine.push({ signal: exec.signal })
      if (exec.agent?.session !== null && exec.agent?.session !== undefined) {
        maybeAppendSessionEvent(exec.agent.session, SESSION_EVENTS.PUSH, {
          sessionId: exec.agent.session.id,
          ok: result.ok,
          error: result.error,
          pushed: result.pushed,
          mirrored: result.mirrored,
          deleted: result.deleted,
          head: result.head,
        }, deps.eventGate, (message) => deps.logger.warn(message))
      }
      return result
    },
  })
}

/**
 * 向 fork 子会话注入冲突通知：说明远端版本已留存为 fork 文件、两边历史
 * 都完整。通知是持久的 user/message（本插件自有的 producer-owned source），
 * 派生历史会投影它。
 *
 * 宿主 0.1.7 起 `MessageSourceMap` 是**可合并扩展的联合**，没有共享的兜底
 * `plugin` kind；`{ kind: 'plugin' }` 已被退役（`session-format-v3-to-v4`
 * 的 `assertV4MessageSources` 直接拒收）。这里声明本插件自己的 kind —— 与
 * `types.d.ts` 的声明合并同名，缺一不可（见 test/source-readback.test.mjs）。
 * @param {import('@deepseek-ai/dsh-session').Session} child - fork 子会话。
 * @param {string[]} forkPaths - 本会话相关 fork 文件路径。
 * @param {string} parentId - 原会话 id。
 */
export function injectForkNotice(child, forkPaths, parentId) {
  const text = [
    'session-sync resolved a cross-device conflict by keeping both sides:',
    `the local lineage of session ${parentId} continues here (this forked session);`,
    'the remote version was preserved as fork file(s):',
    ...forkPaths.slice(0, 10).map(path => `  ${path}`),
    forkPaths.length > 10 ? `  … ${forkPaths.length - 10} more` : '',
    'Both histories are intact in the sync repository; nothing was overwritten.',
  ].filter(line => line.length > 0).join('\n')
  try {
    /** @type {import('@deepseek-ai/dsh-llm').UserMessage} 冲突通知消息（本插件 producer-owned source）。 */
    const notice = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-session-sync', form: 'notice', summary: 'session-sync conflict fork' },
    })
    child.append('user/message', notice, { surfaceOp: 'append' })
  } catch (error) {
    // 通知是锦上添花：append 失败绝不能把一次成功的拉取变成失败。
    return
  }
}

/**
 * 插件挂载。enabled:false 时不注册任何东西；非法配置在加载期响亮抛错。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {Partial<Config>} [config] - 插件配置。
 */
export function apply(ctx, config = {}) {
  // 探针必须是 apply 的**第一条语句**：任何在它之前抛错的代码都会掩盖
  // 「apply 是否被调用」这一基本事实。用 appendFileSync 保证同步落盘。
  const mountProbe = (stage, extra = '') => {
    try {
      fsSync.appendFileSync(path.join(os.homedir(), '.dsh', 'session-sync-mount.log'),
        `${new Date().toISOString()} ${stage} ${extra}\n`)
    } catch {
      // 探针失败绝不影响插件。
    }
  }
  mountProbe('apply-entered', `configKeys=${config === null || typeof config !== 'object' ? String(config) : Object.keys(config).length}`)

  let resolved
  try {
    resolved = resolveConfig(config)
    mountProbe('config-resolved', `enabled=${resolved.enabled}`)
  } catch (error) {
    mountProbe('config-FAILED', messageOf(error))
    throw error
  }

  // 诊断：逐个探测宿主服务是否可解析（inject 为空时 apply 仍会被调用，
  // 因此这里能拿到真实的可用性快照）。
  try {
    const probe = {
      sessions: typeof ctx.get('sessions'),
      commands: typeof ctx.get('commands'),
      subprocess: typeof ctx.get('subprocess'),
      storageDomain: typeof ctx.get('storageDomain'),
      webServer: typeof ctx.get('webServer'),
      tools: typeof ctx.get('tools'),
      logger: typeof ctx.get('logger'),
    }
    mountProbe('service-probe', JSON.stringify(probe))
  } catch (error) {
    mountProbe('service-probe-failed', messageOf(error))
  }

  if (resolved.enabled === false) return
  mountProbe('after-enabled-check')
  if (typeof ctx.get('webServer')?.register !== 'function') {
    mountProbe('WEB-SERVER-MISSING', `webServer=${typeof ctx.get('webServer')}`)
  } else {
    mountProbe('webServer-ok')
  }

  const logger = ctx.get('logger')?.call?.(ctx, PLUGIN_NAME) ?? console
  const warn = (message) => logger.warn(message)
  const eventGate = makeEventGate(KNOWN_SESSION_EVENT_TYPES, probeIgnorableAppend())

  const sessionRoot = resolveSessionRoot(resolved.sessionRoot)
  const repoDir = resolveRepoDir(resolved.repoDir)
  assertNestingSafe(sessionRoot, repoDir)

  let workspaceRestoreStatus
  let workspaceRepairPromise
  function reportWorkspaceRestore(report) {
    workspaceRestoreStatus = report
    logger.info(`workspace grouping: ${report.restored} restored, ${report.preserved} preserved, ${report.pending.length} pending`)
    for (const warning of report.warnings) warn(warning)
    if (report.pending.length > 0) warn(`workspace grouping pending (logs retained, no project directories created): ${JSON.stringify(report.pending)}`)
    return report
  }
  function ensureWorkspaceRepair() {
    const registry = ctx.get('workspaceRegistry')
    if (typeof registry?.list !== 'function') return Promise.resolve(undefined)
    return workspaceRepairPromise ??= repairMirroredWorkspaceGrouping({ registry, repoDir, sessionRoot })
      .then(reportWorkspaceRestore)
  }
  async function captureWorkspaces() {
    await ensureWorkspaceRepair()
    return captureWorkspaceManifest({ registry: ctx.get('workspaceRegistry'), sessionRoot })
  }
  ctx.inject(['workspaceRegistry'], workspaceCtx => {
    workspaceCtx.effect(() => {
      void ensureWorkspaceRepair().catch(error => warn(`workspace grouping repair failed: ${messageOf(error)}`))
      return () => {}
    }, `${PLUGIN_NAME}.workspace-grouping-repair`)
  })
  if (resolved.backend === BACKENDS.ENCRYPTED) warn('加密传输暂不支持备份原工作区分组元数据；不会将名称或路径明文写入仓库。页面普通 Git 备份不受此限制。')

  // --- 同步元数据：ctx.storageDomain 领域 'session-sync'（异步打开，操作路径 await）。
  // V2 形态（A02）：effect 在 apply 帧内**同步注册**并持有打开句柄——异步 open 期间
  // 卸载时，disposer 仍会等到 promise 落定后关闭句柄，不会出现「INACTIVE_EFFECT
  // 吞掉注册 ⇒ 域句柄永不关闭」。拒绝显式处理（记录原因 + 一次可见告警），不再用
  // 静默的 `.catch(() => {})` 掩盖。
  /**
   * storageDomain 是**可选**服务：宿主未组合存储栈时本插件照常挂载，绝不把
   * profile 卡在 pending。用 ctx.get() 按需取，取不到就让 tablePromise 以
   * 结构化错误拒绝——消费方各自 await 并降级（命令返回可读错误，UI 层隐藏
   * 需要持久化的区块）。
   */
  const storageDomain = ctx.get('storageDomain')
  /** @type {Promise<object>} 打开的领域句柄（config/restore/state 三张表共用）。 */
  let domainPromise
  /** @type {Promise<object>} 领域内的 state 表（同步元数据专用）。 */
  let tablePromise
  if (storageDomain === undefined) {
    warn('storageDomain service is unavailable: sync metadata (device id, last push/pull) and page settings will not persist; the plugin still mounts and /sync keeps working')
    domainPromise = Promise.reject(registryUnavailable('storageDomain'))
    tablePromise = domainPromise.then((domain) => domain.table('state'))
    domainPromise.catch(() => {})
    tablePromise.catch(() => {})
  } else {
    ctx.effect(() => {
      domainPromise = storageDomain.open(sessionSyncDomainSpec)
      tablePromise = domainPromise.then((domain) => domain.table('state'))
      domainPromise.catch((error) => {
        warn(`storage domain open failed: ${error?.message ?? String(error)}`)
      })
      tablePromise.catch(() => {})
      return () => {
        void domainPromise.then((domain) => domain.close()).catch((error) => {
          warn(`storage domain close failed: ${error?.message ?? String(error)}`)
        })
      }
    }, `${PLUGIN_NAME}.domain.close`)
  }

  /** @type {{deviceId: string, lastPullAt?: number, lastPushAt?: number, lastPushHead?: string, lastError?: string}|undefined} 元数据缓存。 */
  let metaCache
  let metaOps = Promise.resolve()
  const withMeta = (fn) => {
    const run = metaOps.then(fn, fn)
    metaOps = run.then(() => undefined, () => undefined)
    return run
  }

  /** 确保设备 id 已持久化并读入缓存。 */
  async function ensureMeta() {
    if (metaCache !== undefined) return metaCache
    const table = await tablePromise
    let state = await table.get(STATE_KEY)
    if (state === undefined) {
      state = { deviceId: randomUUID() }
      await table.put(STATE_KEY, state)
    }
    metaCache = state
    return state
  }

  /** 元数据补丁（引擎回调；串行写领域）。 */
  function reportMeta(patch) {
    void withMeta(async () => {
      try {
        const current = await ensureMeta()
        const next = { ...current, ...patch }
        const table = await tablePromise
        await table.put(STATE_KEY, next)
        metaCache = next
      } catch (error) {
        warn(`sync metadata write failed: ${messageOf(error)}`)
      }
    })
  }

  /** 最近错误（引擎回调；串行写领域）。 */
  function reportError(message) {
    reportMeta({ lastError: message.slice(0, 500) })
  }

  // --- git 后端 + 引擎（backend seam：git = 明文，encrypted = age 加密的 git）。
  const git = new GitBackend({
    repoDir,
    remote: resolved.remote,
    branch: resolved.branch,
    commitName: resolved.commitName,
    commitEmail: resolved.commitEmail,
    run: makeRunGit(ctx.subprocess, {
      gitBin: resolved.gitBin,
      graceMs: resolved.graceMs,
      commandTimeoutMs: resolved.commandTimeoutMs,
      maxOutputBytes: resolved.maxOutputBytes,
    }),
    timeoutMs: resolved.commandTimeoutMs,
  })

  const engineDeps = {
    captureWorkspaces: resolved.backend === BACKENDS.ENCRYPTED ? undefined : captureWorkspaces,
    requireWorkspaceMetadata: true,
    git,
    sessionRoot,
    repoDir,
    remote: resolved.remote,
    branch: resolved.branch,
    deviceId: 'pending',
    reportMeta,
    reportError,
    logger,
    onForks: (forkPaths) => handleForks(forkPaths),
  }
  const engine = resolved.backend === BACKENDS.ENCRYPTED
    ? new EncryptedBackend({
        ...engineDeps,
        run: makeRunAge(ctx.subprocess, {
          graceMs: resolved.graceMs,
          commandTimeoutMs: resolved.commandTimeoutMs,
          maxOutputBytes: resolved.maxOutputBytes,
        }),
        ageBin: resolved.ageBin,
        ageRecipient: resolved.ageRecipient,
        ageIdentity: resolved.ageIdentity,
        timeoutMs: resolved.commandTimeoutMs,
      })
    : new SyncEngine(engineDeps)
  // 设备 id 来自元数据领域；在领域就绪后补齐（fork 命名/设备文件用）。
  void ensureMeta().then((meta) => {
    engine.deviceId = meta.deviceId
  }).catch(error => warn(`sync metadata open failed: ${messageOf(error)}`))

  /** fork 文件产生回调：尝试把冲突会话在会话层面 fork（安全时）。 */
  function handleForks(forkPaths) {
    const bySession = new Map()
    let unmapped = 0
    for (const forkPath of forkPaths) {
      const sessionId = sessionIdOfForkPath(forkPath)
      if (sessionId === undefined) {
        unmapped += 1
        continue
      }
      const list = bySession.get(sessionId) ?? []
      list.push(forkPath)
      bySession.set(sessionId, list)
    }
    if (unmapped > 0) {
      logger.warn(`sync: ${unmapped} fork path(s) outside the project/session layout were not mapped to a session-level fork (files preserved)`)
    }
    for (const [sessionId, paths] of bySession) {
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) continue
      maybeAppendSessionEvent(session, SESSION_EVENTS.CONFLICT, {
        sessionId: session.id,
        forkPaths: paths,
        diverged: paths.length,
      }, eventGate, warn)
      const openTurn = openTurnFromProjection(ctx, session)
      if (openTurn !== false) {
        // true=轮次进行中；undefined=投影缺席。两者都跳过会话级 fork：拿不到
        // 权威轮次状态时绝不在可能开放的轮次里 fork，fork 文件仍全部保留。
        logger.info(`sync conflict on live session ${sessionId}: ${openTurn === true ? 'turn open' : 'turn state unavailable (turnBoundary projection absent)'}, session-level fork skipped (files preserved as forks)`)
        continue
      }
      try {
        const child = ctx.sessions.fork(session)
        injectForkNotice(child, paths, session.id)
        maybeAppendSessionEvent(session, SESSION_EVENTS.CONFLICT, {
          sessionId: session.id,
          forkPaths: paths,
          childSessionId: child.id,
        }, eventGate, warn)
        logger.info(`sync conflict on session ${sessionId}: forked → ${child.id} (both lineages kept)`)
      } catch (error) {
        logger.warn(`sync conflict session fork failed for ${sessionId}: ${messageOf(error)} (fork files preserved)`)
      }
    }
  }

  // Service Provider — /sync 命令注册进宿主 commands 服务；其 handler 是消费面（Consumer）。
  if (resolved.registerCommand) {
    ctx.commands.register({
      name: COMMAND_NAME,
      description: 'Cross-device session sync: status, pull/push the git mirror with keep-both conflict resolution, or diff against the last-fetched remote.',
      input: { hint: '[status | pull | push | diff | log | help]' },
      async handler(invocation) {
        return handleSyncCommand(invocation)
      },
    })
  }

  /**
   * /sync 命令处理器。
   * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation - 命令调用。
   * @returns {Promise<import('@deepseek-ai/dsh-commands').CommandResult>} 命令结果。
   */
  async function handleSyncCommand(invocation) {
    const { agent, rawInput, signal } = invocation
    const session = agent?.session
    const action = rawInput.trim().split(/\s+/u)[0]?.toLowerCase() || 'status'
    try {
      if (action === 'help' || (action !== 'status' && action !== 'pull' && action !== 'push' && action !== 'diff' && action !== 'log')) {
        return {
          kind: 'success',
          text: [
            'sync: usage — /sync [status | pull | push | diff | log | help]',
            '  status  show mirror state (default): branch, remote, ahead/behind, dirty, forks',
            '  pull    fetch + merge remote changes (keep-both; confirms first)',
            '  push    mirror + commit + push local changes (confirms first)',
            '  diff    uncommitted changes + HEAD..remote stat (read-only)',
            '  log     last commits in the sync repository',
          ].join('\n'),
        }
      }
      if (action === 'status') {
        const status = await engine.status()
        let meta = {}
        try {
          meta = await ensureMeta()
        } catch {
          // 元数据只读失败不阻断状态展示。
        }
        return { kind: status.ok ? 'success' : 'error', text: renderStatus({ ...status, lastPullAt: meta.lastPullAt, lastPushAt: meta.lastPushAt }) }
      }
      if (action === 'diff') {
        const status = await engine.status()
        return { kind: status.ok ? 'success' : 'error', text: renderDiff(status) }
      }
      if (action === 'log') {
        const status = await engine.status()
        const lines = status.lastCommits.length > 0 ? status.lastCommits : ['(no commits yet)']
        return { kind: 'success', text: `sync: last commits in ${repoDir}:\n${lines.map(line => `  ${line}`).join('\n')}` }
      }
      // pull / push：覆盖性操作必须经确认门（无回答者失败关闭）。
      const summary = action === 'push'
        ? 'Local session files will be mirrored, committed, and pushed to the sync remote (never force-pushed).'
        : 'Remote session changes will be merged into the local mirror with keep-both semantics (local kept, remote preserved as fork files).'
      const verdict = await confirmSync({ ctx, confirmVia: resolved.confirmVia, action, summary }, agent, signal)
      if (!verdict.allowed) {
        const reason = verdict.reason ?? 'no confirmation answerer (fail closed)'
        logger.info(`sync ${action} denied (${verdict.channel}: ${reason})`)
        return { kind: 'error', text: `sync: cancelled: ${reason}` }
      }
      if (action === 'push') {
        const result = await engine.push({ signal })
        if (session !== null && session !== undefined) {
          maybeAppendSessionEvent(session, SESSION_EVENTS.PUSH, {
            sessionId: session.id,
            ok: result.ok,
            error: result.error,
            pushed: result.pushed,
            mirrored: result.mirrored,
            deleted: result.deleted,
            head: result.head,
          }, eventGate, warn)
        }
        return { kind: result.ok ? 'success' : 'error', text: renderPush(result) }
      }
      const result = await engine.pull({ signal })
      if (session !== null && session !== undefined) {
        maybeAppendSessionEvent(session, SESSION_EVENTS.PULL, {
          sessionId: session.id,
          ok: result.ok,
          error: result.error,
          pulled: result.pulled,
          merged: result.merged,
          adopted: result.adopted,
          appended: result.appended,
          diverged: result.diverged,
          forks: result.forks,
          head: result.head,
        }, eventGate, warn)
      }
      return { kind: result.ok ? 'success' : 'error', text: renderPull(result) }
    } catch (error) {
      const message = `sync: ${action || 'status'} failed: ${messageOf(error)}`
      logger.error(message)
      return { kind: 'error', text: message }
    }
  }

  // --- sync_* 模型工具（Consumer；tools 服务存在时才注册，随 fiber 卸载撤销）。
  if (resolved.registerTools) {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.tools.register(makeSyncStatusTool(engine, ensureMeta))
      toolCtx.tools.register(makeSyncPullTool({ engine, ctx, confirmVia: resolved.confirmVia, eventGate, logger }))
      toolCtx.tools.register(makeSyncPushTool({ engine, ctx, confirmVia: resolved.confirmVia, eventGate, logger }))
    })
  }

  // --- 自动模式（全部 effect：事件/定时随插件卸载自动撤销）。
  // 挂载时自动拉取（配置即授权；失败只记日志，绝不阻断启动）。
  if (resolved.autoPullOnStart) {
    ctx.effect(() => {
      void engine.pull().then(result => {
        if (!result.ok) warn(`auto pull failed: ${result.error ?? 'unknown error'}`)
      })
      return () => {}
    }, `${PLUGIN_NAME}.auto-pull-on-start`)
  }

  // turn/end 自动推送（配置即授权；每轮结束拉一次快照并推送）。
  //
  // 防抖：一轮推送尚未结束时，后续 turn/end 直接跳过（不排队、不叠加）。
  // engine.push 内部经 git.schedule 串行，但每次推送都跑全量镜像（16 文件
  // 约 48MB 逐个读取比对）；连续快速的多轮对话会把推送排队堆积，宿主进程
  // 内的磁盘 I/O 与内存压力集中放大（2026-10-16 实测整应用冻结一次）。
  // 跳过的轮次不丢数据：下一轮 turn/end 或手动备份仍会全量镜像提交。
  if (resolved.autoPushOnTurnEnd) {
    let turnPushInFlight = false
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      if (turnPushInFlight) {
        warn('auto push skipped: previous turn push still running')
        return
      }
      turnPushInFlight = true
      // 与手动备份一致地登记进度（自动跑时用户也要看得见）。
      const turnProgressState = { carry: '' }
      progress.start('session', { label: '会话备份', stage: 'mirror' })
      void engine.push({
        onStderr: (text) => feedGitProgress(progress, 'session', text, turnProgressState),
      }).then(result => {
        turnPushInFlight = false
        progress.finish('session', { ok: result?.ok !== false, error: result?.error })
        maybeAppendSessionEvent(session, SESSION_EVENTS.PUSH, {
          sessionId: session.id,
          ok: result.ok,
          error: result.error,
          pushed: result.pushed,
          mirrored: result.mirrored,
          deleted: result.deleted,
          head: result.head,
        }, eventGate, warn)
        if (!result.ok) warn(`auto push failed: ${result.error ?? 'unknown error'}`)
      }).catch((error) => {
        turnPushInFlight = false
        progress.finish('session', { ok: false, error: messageOf(error) })
        warn(`auto push failed: ${messageOf(error)}`)
      })
    })
  }

  // 周期拉取（pullIntervalMinutes > 0 时；定时器随 fiber 自动撤销）。
  if (resolved.pullIntervalMinutes > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void engine.pull().then(result => {
          if (!result.ok) warn(`periodic pull failed: ${result.error ?? 'unknown error'}`)
        })
      }, resolved.pullIntervalMinutes * 60_000)
      return () => clearInterval(timer)
    }, `${PLUGIN_NAME}.periodic-pull`)
  }

  // --- Web UI 后端（页面：会话备份 / 还原 / 自动备份计划）--------------------
  // webServer 是可选服务：缺失时整个 UI 层安静缺席，命令与工具照常可用。
  const gate = new OperationGate()
  // 备份进度注册表（会话/插件/技能三类）。纯内存、无 IO；前端按 500ms 轮询读取。
  const progress = new ProgressRegistry()
  /** 页面配置缓存（首次读取后复用；保存时同步更新）。 */
  let uiConfigCache
  /** 复用的 GitBackend：远端/分支随页面配置变化时重建。 */
  let uiGit = null
  let uiGitRemote = null
  let uiGitBranch = null
  let uiGitAuth = null
  /** 计划状态：下次执行时刻与最近一次结果。 */
  let scheduleRuntime = { nextRunAt: undefined, lastRunAt: undefined, lastResult: undefined }

  /** 读取页面配置（带缓存）。 */
  async function uiConfig() {
    if (uiConfigCache !== undefined) return uiConfigCache
    uiConfigCache = await loadUiConfig({
      table: domainPromise.then(domain => domain.table('config')).catch(() => undefined),
      fallback: { remote: resolved.remote, branch: resolved.branch },
    })
    return uiConfigCache
  }

  /** 取用与页面配置一致的 git 后端（远端/分支变化时重建）。 */
  async function uiBackend() {
    const config = await uiConfig()
    const authSignature = JSON.stringify([config.authMode, config.sshKeyPath])
    if (uiGit === null || uiGitRemote !== config.remote || uiGitBranch !== config.branch || uiGitAuth !== authSignature) {
      uiGit = new GitBackend({
        repoDir,
        remote: config.remote,
        branch: config.branch,
        commitName: resolved.commitName,
        commitEmail: resolved.commitEmail,
        run: makeRunGit(ctx.subprocess, {
          gitBin: resolved.gitBin,
          authEnv: gitAuthEnvironment(config),
          graceMs: resolved.graceMs,
          commandTimeoutMs: resolved.commandTimeoutMs,
          maxOutputBytes: resolved.maxOutputBytes,
        }),
        timeoutMs: resolved.commandTimeoutMs,
      })
      uiGitRemote = config.remote
      uiGitBranch = config.branch
      uiGitAuth = authSignature
    }
    return uiGit
  }

  /** 页面用引擎：与页面配置同源的 GitBackend + SyncEngine。 */
  async function uiEngine() {
    const config = await uiConfig()
    const backend = await uiBackend()
    const meta = await ensureMeta().catch(() => ({ deviceId: 'unknown' }))
    return new SyncEngine({
      captureWorkspaces,
      git: backend,
      sessionRoot,
      repoDir,
      remote: config.remote,
      branch: config.branch,
      deviceId: meta.deviceId ?? 'unknown',
      reportMeta,
      reportError,
      logger,
      onForks: (forkPaths) => handleForks(forkPaths),
    })
  }

  /** 还原任务表（存储领域 restore）。 */
  async function restoreTable() {
    const domain = await domainPromise
    return domain.table('restore')
  }

  /** 写入还原任务记录。 */
  async function putRestoreTask(task) {
    const table = await restoreTable()
    await table.put(task.id, { ...task, updatedAt: Date.now() })
  }

  /** 待执行的还原任务（最多一条；多条时取最新）。 */
  async function readPendingRestore() {
    const table = await restoreTable()
    // 宿主 KvTable 没有 list()，只有同步 entries()（对照 dsh-checkpoint-rewind 的既证用法）。
    const rows = [...table.entries()].map(([, record]) => record)
    const pending = rows
      .filter(row => row.state === RESTORE_STATES.PENDING || row.state === RESTORE_STATES.RUNNING)
      .sort((a, b) => b.createdAt - a.createdAt)
    return pending[0]
  }

  /** 还原任务对外视图。 */
  const restoreView = (task) => (task === undefined ? null : {
    id: task.id,
    mode: task.mode,
    commit: task.commit,
    state: task.state,
    snapshotDir: task.snapshotDir,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    detail: task.detail,
  })

  /** 计划信息（页面轮询）。 */
  function scheduleInfo() {
    const config = uiConfigCache ?? { schedule: defaultUiConfig().schedule }
    return {
      ...config.schedule,
      nextRunAt: scheduleRuntime.nextRunAt,
      lastRunAt: scheduleRuntime.lastRunAt,
      lastResult: scheduleRuntime.lastResult,
      description: describeSchedule(config.schedule),
    }
  }

  /** 自动备份执行体（与手动备份共用引擎；有变化才提交）。 */
  async function runAutomaticBackup() {
    scheduleRuntime.lastRunAt = Date.now()
    // 自动备份同样登记进度：否则定时跑起来时用户完全看不到（与手动不一致 = 功能不完全）。
    const autoProgressState = { carry: '' }
    progress.start('session', { label: '会话备份', stage: 'mirror' })
    try {
      const result = await gate.run('backup', async () => {
        const automatic = await uiEngine()
        return await automatic.push({
          onStderr: (text) => feedGitProgress(progress, 'session', text, autoProgressState),
        })
      })
      progress.finish('session', { ok: result?.ok !== false, error: result?.error })
      scheduleRuntime.lastResult = { ok: result.ok !== false, pushed: result.pushed === true, at: Date.now() }
      if (result.ok === false) warn(`automatic backup failed: ${result.error ?? 'unknown error'}`)
      else logger.info(`automatic backup ok (pushed=${result.pushed === true})`)
    } catch (error) {
      progress.finish('session', { ok: false, error: messageOf(error) })
      scheduleRuntime.lastResult = { ok: false, error: messageOf(error), at: Date.now() }
      warn(`automatic backup failed: ${messageOf(error)}`)
    }
  }

  /** 自动备份调度器：配置变化时重新武装；停机期间的错过的点不补跑。 */
  function armSchedule() {
    const config = uiConfigCache
    const schedule = config?.schedule ?? defaultUiConfig().schedule
    const delay = delayUntilNextRun(schedule, Date.now())
    if (delay === undefined) {
      scheduleRuntime.nextRunAt = undefined
      return () => {}
    }
    scheduleRuntime.nextRunAt = nextRunAt(schedule, Date.now())
    const armedAt = Date.now()
    let timer = null
    const fire = () => {
      void runAutomaticBackup().finally(() => {
        // 重新计算下一个未来点（绝不补跑过去）。
        const next = delayUntilNextRun(schedule, Date.now(), armedAt)
        scheduleRuntime.nextRunAt = next === undefined ? undefined : nextRunAt(schedule, Date.now(), armedAt)
        if (next !== undefined && !disposed) timer = setTimeout(fire, next)
      })
    }
    timer = setTimeout(fire, delay)
    let disposed = false
    return () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
    }
  }

  // 首次读取配置后武装调度器；配置变化经 /settings 触发重新武装。
  ctx.effect(() => {
    let dispose = () => {}
    void uiConfig().then(() => {
      dispose = armSchedule()
    }).catch(error => warn(`automatic backup scheduling failed: ${messageOf(error)}`))
    return () => dispose()
  }, `${PLUGIN_NAME}.auto-backup-schedule`)

  // 插件备份自动调度：配置单独持久化（plugin-schedule.json），每 60s 检查一次是否到期。
  // 两种模式与会话备份的自动备份一致：daily=每天固定时间（只跑一次）；interval=每隔 N 分钟。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const config = await readPluginSchedule()
          if (config.enabled !== true || cloudOperationBusy()) return
          const now = Date.now()
          const last = config.lastRunAt ? Date.parse(config.lastRunAt) : 0
          const due = config.mode === 'interval'
            ? (now - last) >= (Number(config.everyMinutes) || 60) * 60_000
            : (() => {
                const target = new Date(now)
                target.setHours(Number(config.atHour ?? 3), Number(config.atMinute ?? 0), 0, 0)
                return now >= target.getTime() && (last === 0 || last < target.getTime())
              })()
          if (due) {
            // 定时插件备份也登记进度：这条路径不经过 HTTP 路由包装，
            // 必须在此处显式登记，否则自动跑时进度条完全不出现。
            progress.start('plugin', { label: '插件备份', stage: 'collecting' })
            try {
              const result = await runPluginBackup({ onProgress: patch => progress.update('plugin', patch) })
              progress.finish('plugin', { ok: result.ok, error: result.error ?? undefined })
            } catch (error) {
              progress.finish('plugin', { ok: false, error: messageOf(error) })
              throw error
            }
          }
        } catch (error) {
          warn(`plugin backup schedule tick failed: ${messageOf(error)}`)
        }
      })()
    }, 60_000)
    return () => clearInterval(timer)
  }, `${PLUGIN_NAME}.plugin-backup-schedule`)

  // webServer 不放进必需 inject（会让插件挂起）；改用 ctx.inject 可选获取：
  // 服务存在时注册路由，不存在时 UI 层安静缺席，命令与工具不受影响。
  // Each restore request gets an independent map; no cross-request source-device state.
  function sessionRestoreContext(projectPaths = {}, preview = false) {
    const persistence = ctx.get('sessionPersistence')
    const inspectLog = async (rel, bytes) => {
      if (typeof persistence?.readZstdPrefix !== 'function' || typeof persistence?.locate !== 'function') {
        throw new Error('当前宿主不支持完整日志校验，已拒绝还原')
      }
      let compressed = bytes
      if (!rel.endsWith('.zstd')) {
        const end = bytes.indexOf(10)
        if (end < 0) throw new Error('会话日志缺少完整头部: ' + rel)
        compressed = Buffer.concat([zstdCompressSync(bytes.subarray(0, end + 1)), zstdCompressSync(bytes.subarray(end + 1))])
      }
      const parsed = await persistence.readZstdPrefix(compressed)
      if (parsed.tornTruncateTo !== undefined || (parsed.recoveredTail?.length ?? 0) > 0) throw new Error('会话日志存在不完整尾部，已拒绝还原: ' + rel)
      if (path.resolve(persistence.locate(parsed.meta).path) !== path.resolve(sessionRoot, ...rel.split('/'))) throw new Error('会话路径与宿主存储身份不匹配: ' + rel)
      return parsed
    }
    const mapper = createSessionMapper({ sessionRoot, persistence, projectPaths, preview, dshHome: detectDshHome(), inspectLog })
    const workspaceTargets = new Map()
    return {
      ...mapper, inspectLog, workspaceTargets,
      mapEntry: async (rel, bytes) => {
        const entry = await mapper.mapEntry(rel, bytes)
        if (!entry.auxiliary) {
          const { id, cwd } = sessionHeader(entry.rel, entry.blob).header
          workspaceTargets.set(entry.rel, { id, cwd })
        }
        return entry
      },
    }
  }

  async function finishSessionWorkspaceRestore(result, restoreContext, backend, commit) {
    if (result?.ok === false) return result
    try {
      const headers = []
      for (const [rel, expected] of restoreContext.workspaceTargets) {
        const file = path.join(sessionRoot, ...rel.split('/'))
        try {
          const { header } = sessionHeader(rel, await fs.readFile(file))
          if (header.id === expected.id) headers.push({ id: header.id, cwd: header.cwd })
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      const manifestBytes = await backend.readFileAtRev(commit, WORKSPACE_MANIFEST)
      const workspaceRestore = reportWorkspaceRestore(await restoreWorkspaceGrouping({ registry: ctx.get('workspaceRegistry'), headers, manifestBytes }))
      return { ...result, workspaceRestore }
    } catch (error) {
      const workspaceRestore = { restored: 0, preserved: 0, pending: [], warnings: [`会话日志已还原，工作区分组恢复失败: ${messageOf(error)}`] }
      reportWorkspaceRestore(workspaceRestore)
      return { ...result, workspaceRestore }
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    mountProbe('web-inject-fired')
    const routes = buildRoutes({
      gate,
      status: async () => {
        const statusEngine = await uiEngine()
        const base = await statusEngine.status()
        const meta = await ensureMeta().catch(() => ({}))
        return { ...base, lastPullAt: meta.lastPullAt, lastPushAt: meta.lastPushAt, workspaceRestore: workspaceRestoreStatus,
          ...(resolved.backend === BACKENDS.ENCRYPTED ? { workspaceBackupWarning: '加密传输暂不支持原工作区分组元数据备份；未写入明文分组信息' } : {}) }
      },
      loadConfig: () => uiConfig(),
      saveConfig: async (patch) => {
        const base = await uiConfig()
        const next = normalizeUiConfigPatch(patch, base)
        const saved = await saveUiConfig({
          table: domainPromise.then(domain => domain.table('config')),
        }, { remote: next.remote, branch: next.branch, schedule: next.schedule })
        uiConfigCache = { remote: saved.remote, branch: saved.branch, schedule: saved.schedule, updatedAt: saved.updatedAt }
        // 远端/分支变化 → 后续操作使用新的后端。
        uiGit = null
        return uiConfigCache
      },
      updateSchedule: async () => {
        // 重新武装：调度器 effect 只跑一次，这里通过重建 effect 实现热更新。
        scheduleRuntime.nextRunAt = nextRunAt(uiConfigCache?.schedule ?? defaultUiConfig().schedule, Date.now())
        return scheduleInfo()
      },
      verifyRemote: async () => {
        const config = await uiConfig()
        if (config.remote.trim() === '') return { ok: false, detail: 'remote is not configured' }
        const backend = await uiBackend()
        try {
          await fs.mkdir(repoDir, { recursive: true })
          await backend.ensureRepo()
          const current = await backend.refSha('HEAD')
          return {
            ok: true,
            detail: `local repository ready (${current === undefined ? 'no commits yet' : `head ${current.slice(0, 8)}`}) · remote ${config.remote}`.trim(),
          }
        } catch (error) {
          return { ok: false, detail: messageOf(error) }
        }
      },
      history: async (limit) => {
        const backend = await uiBackend()
        const config = await uiConfig()
        try {
          await fs.mkdir(repoDir, { recursive: true })
          await backend.ensureRepo()
        } catch {
          // 仓库尚未建立时仍返回空历史（页面不报错）。
        }
        return listHistory(backend, {
          limit: limit ?? LIMITS.DEFAULT_HISTORY_LIMIT,
          branch: config.branch,
          remote: config.remote,
        })
      },
      backup: async () => {
        const backupEngine = await uiEngine()
        // 进度：仅在本次备份期间登记；git 的真百分比来自 --progress 的 stderr。
        const progressState = { carry: '' }
        progress.start('session', { label: '会话备份', stage: 'mirror' })
        try {
          const result = await backupEngine.push({
            onStderr: (text) => feedGitProgress(progress, 'session', text, progressState),
          })
          progress.finish('session', { ok: result?.ok !== false, error: result?.error })
          return result
        } catch (error) {
          progress.finish('session', { ok: false, error: messageOf(error) })
          throw error
        }
      },
      previewRestore: async (commit, projectPaths) => previewRestore({
        ...sessionRestoreContext(projectPaths, true),
        git: await uiBackend(),
        sessionRoot,
        commit,
        tempRoot: os.tmpdir(),
      }),
      mergeRestore: async (commit, projectPaths) => {
        const meta = await ensureMeta().catch(() => ({ deviceId: 'unknown' }))
        const backend = await uiBackend()
        const restoreContext = sessionRestoreContext(projectPaths)
        const result = await mergeRestore({
          ...restoreContext,
          artifactRoot: path.join(detectDshHome(), SNAPSHOT_DIR_NAME),
          git: await uiBackend(),
          sessionRoot,
          commit,
          deviceShort: String(meta.deviceId ?? 'unknown').replaceAll('-', '').slice(0, 8).toLowerCase() || 'unknown',
          tempRoot: os.tmpdir(),
        })
      },
      prepareOverwrite: async (commit) => {
        const backend = await uiBackend()
        const id = `restore-${Date.now().toString(36)}`
        const snapshotRoot = path.join(path.dirname(sessionRoot), SNAPSHOT_DIR_NAME)
        const snapshot = await createSafetySnapshot({ sessionRoot, snapshotDir: snapshotRoot, id })
        if (snapshot.ok === false) return { ok: false, error: snapshot.error }
        const task = {
          id,
          mode: 'overwrite',
          commit,
          state: RESTORE_STATES.PENDING,
          snapshotDir: snapshot.snapshotDir,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          detail: `snapshot of ${snapshot.files} file(s)`,
        }
        await putRestoreTask(task)
        return { ok: true, snapshotDir: snapshot.snapshotDir, files: snapshot.files, taskId: id }
      },
      // 全量还原：备份为底座，保留本地增量；不交换会话库目录。
      //
      // 活动轮次检查：live 会话正在写 sessionRoot，运行时直接替换有竞争风险。
      // 依据权威投影判定——true（轮次进行中）或 undefined（投影缺席）一律拒绝；
      // 只有投影明确返回 false 才放行。绝不静默绕过。
      overwriteApply: async (commit, projectPaths) => {
        const blocked = []
        for (const session of ctx.sessions.list()) {
          const openTurn = openTurnFromProjection(ctx, session)
          if (openTurn !== false) blocked.push(session.id)
        }
        if (blocked.length > 0) {
          return {
            ok: false,
            error: `有 ${blocked.length} 个会话处于活动状态（轮次未关闭或轮次状态不可读），已拒绝全量还原。请关闭这些会话后再试——运行中直接替换会丢失正在写入的数据。`,
          }
        }
        const backend = await uiBackend()
        const id = `restore-${Date.now().toString(36)}`
        const snapshotRoot = path.join(path.dirname(sessionRoot), SNAPSHOT_DIR_NAME)
        const stagingDir = path.join(os.tmpdir(), `dsh-session-sync-staging-${id}`)
        // 进度：真实计数（快照文件数 / 物化文件数），与备份同域但 action 不同。
        progress.start('session', { label: '会话全量还原', stage: 'delete', action: 'delete' })
        try {
          const result = await overwriteApply({
            ...sessionRestoreContext(projectPaths),
            git: backend,
            commit,
            sessionRoot,
            snapshotDir: snapshotRoot,
            stagingDir,
            id,
            acquireWriteLease: async (rel, header) => {
              if (ctx.sessions.get(header.id) !== undefined) {
                throw new Error('备份比已加载会话更新，请完全退出并重新启动 DSH 后再还原: ' + header.id)
              }
              const persistence = ctx.get('sessionPersistence')
              if (typeof persistence?.acquireWriteLease !== 'function'
                || typeof persistence?.locate !== 'function'
                || path.resolve(persistence.locate(header).path) !== path.resolve(sessionRoot, ...rel.split('/'))) {
                throw new Error('宿主写租约不可用或存储路径不匹配，已拒绝全量还原')
              }
              const lease = await persistence.acquireWriteLease(header)
              if (ctx.sessions.get(header.id) !== undefined) {
                await lease.release()
                throw new Error('会话在预检后被加载，已拒绝全量还原: ' + header.id)
              }
              return lease
            },
            onProgress: (patch) => progress.update('session', {
              action: 'delete',
              ...(typeof patch?.stage === 'string' ? { stage: patch.stage } : {}),
              ...(patch?.files !== undefined ? { files: patch.files } : {}),
            }),
          })
          progress.finish('session', {
            ok: result?.ok !== false,
            action: 'delete',
            error: result?.ok === false ? result.error : undefined,
          })
          return result
        } catch (error) {
          progress.finish('session', { ok: false, error: messageOf(error), action: 'delete' })
          throw error
        }
      },
      pendingRestores: async () => ({ pending: restoreView(await readPendingRestore()) }),
      deleteHistory: async (commit) => {
        const backend = await uiBackend()
        await fs.mkdir(repoDir, { recursive: true })
        await backend.bootstrap()
        // 进度：会话历史删除同样登记（真实计数 = 需重写的提交数 / 已重写数）。
        // 与备份同域但 action 不同，因此两条可以并存、互不覆盖。
        progress.start('session', { label: '会话备份删除', stage: 'delete', action: 'delete' })
        try {
          const result = await deleteHistoryCommit(backend, {
            commit,
            logger,
            onProgress: (patch) => progress.update('session', {
              action: 'delete',
              ...(typeof patch?.stage === 'string' ? { stage: patch.stage } : {}),
              ...(patch?.files !== undefined ? { files: patch.files } : {}),
            }),
          })
          progress.finish('session', { ok: true, action: 'delete' })
          return result
        } catch (error) {
          progress.finish('session', { ok: false, error: messageOf(error), action: 'delete' })
          throw error
        }
      },
      cancelRestore: async (id) => {
        const table = await restoreTable()
        const task = await table.get(id)
        if (task === undefined) return { pending: null }
        if (task.state !== RESTORE_STATES.PENDING) {
          throw new Error(`restore task ${id} is ${task.state} and cannot be cancelled`)
        }
        await table.put(id, { ...task, state: RESTORE_STATES.CANCELLED, updatedAt: Date.now() })
        return { pending: null }
      },
      scheduleInfo,
      logger,
    })
    // 合并云同步路由（内置 cloud-sync 核心，跨设备可用）。路径前缀不同，不冲突。
    //
    // 插件备份 / 技能备份的进度：在【路由层】包一层，不改 lib/cloud.mjs 的调用签名字面。
    // 这两条操作的核心是网络往返（Gist/WebDAV/S3），没有 git 那样的分段百分比；
    // 但 core 内部有真实的可数对象（profile 数 / 技能数 / 待上传分片数），
    // 因此上报【真实计数】而不是估算百分比。
    //
    // 计数怎么从 core 传出来：进度回调是函数，穿不过 HTTP 请求体。
    // 所以用 lib/cloud.mjs 的模块级 sink（setCloudProgressSink）——
    // 发起前设、finally 清，避免回调泄漏到下一次调用。
    const progressWrapped = cloudRoutes().map((item) => {
      // item.path 形如 `/api/dsh-session-sync/cloud/snapshot/push`，
      // 必须按【结尾】匹配多段路由名：按最后一段只会拿到 `push`，永远匹配不上，
      // 结果是插件/技能备份从不登记进度（实测确实如此）。
      // 路由 →（域, 操作）。删除与备份各占一条，互不覆盖，因此同域可同时显示。
      // 路径形如 /api/dsh-session-sync/cloud/<...>，必须按结尾匹配（取最后一段会只拿到 push/delete）。
      /**
       * 路由 →（域, 操作）。
       * @param {string} path - 请求路径。
       * @returns {{kind: 'session'|'plugin'|'skill', action: 'backup'|'delete', label: string}|null} 命中为映射，否则 null。
       */
      const routeKind = (path) => {
        if (path.endsWith('/skill/push')) return { kind: 'skill', action: 'backup', label: '技能备份' }
        if (path.endsWith('/skill/history/delete')) return { kind: 'skill', action: 'delete', label: '技能备份删除' }
        if (path.endsWith('/snapshot/push')) return { kind: 'plugin', action: 'backup', label: '插件备份' }
        if (path.endsWith('/snapshot/history/delete')) return { kind: 'plugin', action: 'delete', label: '插件备份删除' }
        if (path.endsWith('/snapshot/reclaim-orphans')) return { kind: 'plugin', action: 'delete', label: '孤儿对象回收' }
        return null
      }
      const mapped = routeKind(item.path)
      if (mapped === null) return item
      const { kind, action, label } = mapped
      const inner = item.handler
      return {
        ...item,
        handler: async (request, response) => withCloudOperation(label, async () => {
          let operationError = null
          progress.start(kind, { label, stage: 'collecting', action })
          // core 的真实计数 → 进度条目（stage/files 全部照抄，不做换算）。
          setCloudProgressSink((patch) => {
            if (typeof patch?.error === 'string') operationError = patch.error
            progress.update(kind, {
              action,
              ...(typeof patch?.stage === 'string' ? { stage: patch.stage } : {}),
              ...(patch?.files !== undefined ? { files: patch.files } : {}),
            })
          })
          try {
            const result = await inner(request, response)
            // route会自行写出HTTP错误而不抛错；不能仅凭正常返回判定业务成功。
            if (operationError !== null) progress.finish(kind, { ok: false, error: operationError, action })
            else if (response.statusCode >= 400) progress.finish(kind, { ok: false, error: `请求失败（HTTP ${response.statusCode}）`, action })
            else progress.finish(kind, { ok: true, action })
            return result
          } catch (error) {
            progress.finish(kind, { ok: false, error: messageOf(error), action })
            throw error
          } finally {
            setCloudProgressSink(null)
          }
        }).catch(error => route(item.path, 'GET', async () => { throw error }).handler(request, response)),
      }
    })
    // 路由装配：保持原有 [...routes, ...cloudRoutes()] 结构不变，
    // 只把 5 条备份/删除路由替换成带进度的包装版（map 内命中才换，未命中原样返回）。
    // 这样 diff 最小：没碰 routes、没碰 cloudRoutes() 的其余 27 条。
    const wrappedByPath = new Map(progressWrapped.map((item) => [item.path, item]))
    const cloudWithProgress = cloudRoutes().map((item) => wrappedByPath.get(item.path) ?? item)
    const allRoutes = [...routes, ...cloudWithProgress, route(`${API_PREFIX}/progress`, 'GET', async () => progress.snapshot())]
    const disposers = []
    for (const item of allRoutes) {
      try {
        disposers.push(/** @type {any} */ (webCtx).webServer.register(item))
        mountProbe('route-OK', item.path)
      } catch (error) {
        logger.error(`web route registration FAILED for ${item.path}: ${messageOf(error)}`)
        mountProbe('route-FAILED', `${item.path} :: ${messageOf(error)}`)
      }
    }
    mountProbe('routes-done', `count=${disposers.length}/${allRoutes.length}`)
    mountProbe('cloud-paths', cloudRoutePaths().join(','))
    // 启动期真实烟测：验证 domain 句柄能分别打开 config / restore 表。
    // 这两条路径正是页面首屏会访问的状态，失败时立即留下精确证据。
    void uiConfig().then(() => mountProbe('ui-config-OK')).catch((error) => mountProbe('ui-config-FAILED', messageOf(error)))
    void restoreTable().then(() => mountProbe('restore-table-OK')).catch((error) => mountProbe('restore-table-FAILED', messageOf(error)))
    webCtx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 注销期错误不影响其余路由。
        }
      }
    }, `${PLUGIN_NAME}.web-routes`)
  })
}

export {
  // 复用/测试面：引擎、后端、纯函数与词汇。
  GitBackend,
  SyncEngine,
  EncryptedBackend,
  selectEncryptionMode,
  detectAge,
  ageEncrypt,
  ageDecrypt,
  encryptTree,
  decryptTree,
  mergeTrees,
  collectStatus,
  renderStatus,
  renderDiff,
  renderPull,
  renderPush,
  confirmSync,
  makeEventGate,
  maybeAppendSessionEvent,
  hasOpenTurn,
  openTurnFromProjection,
  resolveSessionRoot,
  resolveRepoDir,
  assertNestingSafe,
  sessionSyncDomainSpec,
  registryUnavailable,
  errorValue,
}
