// lib/api.mjs — 同源 Web API 路由（页面 ↔ 后端）。
//
// 契约与宿主 ctx.webServer 一致（对齐 @dickpy/dsh-cloud-sync 的实测形态）：
//   注册项 = { kind: 'exact', path, handler(request, response) }
// handler 自行读写 HTTP；本模块提供 route() 工厂，统一处理：
//   · loopback 限制（只允许本机、同源请求）
//   · 方法限制
//   · JSON 请求体解析 + 体积上限
//   · 统一 { ok, value } / { ok, error } 信封
//   · 脱敏（错误消息经 redactText）
//
// 全部业务依赖经 deps 注入，本模块不 import 任何 DSH 服务，便于单测。

import { API_PREFIX, OPERATION_STATES } from './constants.mjs'
import { SyncError, messageOf } from './errors.mjs'
import { redactText } from './sanitize.mjs'

/** 请求体上限（页面配置很小；防止内存滥用）。 */
const MAX_BODY_BYTES = 128 * 1024

/** 是否来自本机回环且非同源跨站请求。 */
export function isLoopback(request) {
  const address = request.socket?.remoteAddress
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  try {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${host}`).hostname)) return false
  } catch {
    return false
  }
  return request.headers?.['sec-fetch-site'] !== 'cross-site'
}

/** 写 JSON 响应（禁止缓存与 referrer 泄漏）。 */
function send(response, code, value) {
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  response.end(JSON.stringify(value))
}

/** 读取并解析 JSON 请求体（GET 无体时返回 {}）。 */
async function readBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new SyncError('BAD_CONFIG', 'request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    throw new SyncError('BAD_CONFIG', 'request body must be JSON')
  }
}

/**
 * 建一条路由。operation 返回业务载荷表示成功，抛错表示失败。
 *
 * 宿主 webServer 的 exact 表只按 path 做键：同一路径只能注册一次。因此
 * `method` 传 'GET' 时该端点同时接受 GET / HEAD / POST（POST 由 operation
 * 内部按 request.method 自行分派）——这样 GET 与 POST 只需一条路由。
 *
 * @param {string} path - 完整路径。
 * @param {'GET'|'POST'} method - 主要方法；'GET' 允许附带 POST 处理。
 * @param {(input: object, query: URLSearchParams, request: object) => Promise<object>} operation - 业务处理。
 * @returns {{kind: string, path: string, handler: Function}}
 */
export function route(path, method, operation) {
  return {
    kind: 'exact',
    path,
    handler: async (request, response) => {
      if (!isLoopback(request)) {
        send(response, 403, { ok: false, code: 'FORBIDDEN', error: 'loopback-only endpoint' })
        return
      }
      // GET 端点额外接受 HEAD（页面探测）与 POST（同路径的写入分派）。
      const allowed = method === 'GET'
        ? ['GET', 'HEAD', 'POST']
        : ['POST']
      if (!allowed.includes(request.method)) {
        send(response, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: `${allowed.join('|')} required` })
        return
      }
      let query = new URLSearchParams()
      try {
        const url = new URL(request.url ?? path, 'http://127.0.0.1')
        query = url.searchParams
      } catch {
        // URL 解析失败时按无查询参数处理（路径本身已由宿主精确匹配）。
      }
      try {
        // 有请求体的方法才解析 body；GET/HEAD 一律给空对象。
        const input = request.method === 'POST' ? await readBody(request) : {}
        const value = await operation(input, query, request)
        send(response, 200, { ok: true, value })
      } catch (error) {
        const code = error instanceof SyncError ? error.code : 'INTERNAL'
        const status = code === 'INTERNAL' ? 500 : 400
        send(response, status, { ok: false, code, error: redactText(messageOf(error)) })
      }
    },
  }
}

/**
 * 单一操作互斥：备份与还原串行执行；页面轮询状态时不阻塞。
 */
export class OperationGate {
  #state = OPERATION_STATES.IDLE
  #kind = null
  #startedAt = 0
  #finishedAt = 0
  #lastError = null
  #lastResult = null

  /** 当前状态快照（供页面轮询）。 */
  snapshot() {
    return {
      state: this.#state,
      kind: this.#kind,
      startedAt: this.#startedAt,
      finishedAt: this.#finishedAt,
      lastError: this.#lastError,
      lastResult: this.#lastResult,
    }
  }

  /** 是否有操作在跑。 */
  get busy() {
    return this.#state === OPERATION_STATES.RUNNING
  }

  /**
   * 互斥执行；忙碌时抛 BAD_CONFIG（页面据此禁用按钮）。
   * @param {string} kind - 操作种类。
   * @param {() => Promise<object>} fn - 实际操作。
   * @returns {Promise<object>} 操作结果。
   */
  async run(kind, fn) {
    if (this.busy) throw new SyncError('BAD_CONFIG', `another operation is already running (${this.#kind ?? 'unknown'})`)
    this.#state = OPERATION_STATES.RUNNING
    this.#kind = kind
    this.#startedAt = Date.now()
    this.#lastError = null
    try {
      const result = await fn()
      this.#state = result?.ok === false ? OPERATION_STATES.FAILED : OPERATION_STATES.SUCCESS
      this.#lastResult = summarizeResult(kind, result)
      if (result?.ok === false) this.#lastError = result.error ?? 'operation failed'
      return result
    } catch (error) {
      this.#state = OPERATION_STATES.FAILED
      this.#lastError = redactText(messageOf(error))
      throw error
    } finally {
      this.#finishedAt = Date.now()
    }
  }
}

/** 结果摘要（页面显示用；只保留少量必要字段）。 */
function summarizeResult(kind, result) {
  if (result === null || typeof result !== 'object') return null
  const base = { kind, ok: result.ok !== false, at: Date.now() }
  if (kind === 'backup') {
    return {
      ...base,
      pushed: result.pushed === true,
      mirrored: result.mirrored ?? 0,
      deleted: result.deleted ?? 0,
      head: result.head ?? null,
    }
  }
  if (kind === 'merge') {
    return { ...base, written: result.written ?? 0, skipped: result.skipped ?? 0, forks: (result.forks ?? []).length }
  }
  if (kind === 'overwrite-prepare') {
    return { ...base, snapshotDir: result.snapshotDir ?? null, files: result.files ?? 0, helperPath: result.helperPath ?? null }
  }
  return base
}

/** 校验提交 sha（页面输入不可信）。 */
export function requireCommit(input) {
  const commit = typeof input?.commit === 'string' ? input.commit.trim() : ''
  if (commit.length === 0) throw new SyncError('BAD_CONFIG', 'commit is required')
  if (!/^[0-9a-f]{7,64}$/iu.test(commit)) throw new SyncError('BAD_CONFIG', 'commit must be a hex object id')
  return commit
}

/**
 * 构造全部路由。
 * @param {object} deps - 依赖集合（见 index.mjs 的接线）。
 * @returns {Array<object>} 路由注册项。
 */
export function buildRoutes(deps) {
  return [
    route(`${API_PREFIX}/status`, 'GET', async () => {
      const [status, config, schedule] = await Promise.all([deps.status(), deps.loadConfig(), deps.scheduleInfo()])
      return {
        status: status.ok === false ? { ...status, remote: undefined } : status,
        config: { remote: config.remote, branch: config.branch, updatedAt: config.updatedAt ?? null },
        schedule,
        operation: deps.gate.snapshot(),
      }
    }),

    // 注意：宿主 webServer 的 exact 表**只按 path 做键**（不区分 HTTP 方法），
    // 同一路径注册两次会抛 duplicate route 并中断后续注册。因此 GET 与 POST
    // 必须共用一条路由，在 handler 内按 method 分派。
    route(`${API_PREFIX}/settings`, 'GET', async (input, query, request) => {
      if (request?.method === 'POST') {
        const saved = await deps.saveConfig(input ?? {})
        const schedule = await deps.updateSchedule(saved)
        return { config: saved, schedule }
      }
      return { config: await deps.loadConfig() }
    }),

    route(`${API_PREFIX}/remote/check`, 'POST', async () => ({ check: await deps.verifyRemote() })),

    route(`${API_PREFIX}/history`, 'GET', async (_input, query) => {
      const limit = Number.parseInt(String(query?.get('limit') ?? ''), 10)
      return { history: await deps.history(Number.isFinite(limit) ? limit : undefined) }
    }),

    route(`${API_PREFIX}/history/delete`, 'POST', async (input) => {
      const commit = requireCommit(input)
      const result = await deps.gate.run('history-delete', () => deps.deleteHistory(commit))
      if (result.ok === false) throw new SyncError('GIT_FAILED', result.error ?? 'history delete failed')
      return { result }
    }),

    route(`${API_PREFIX}/backup/preview`, 'POST', async () => {
      const status = await deps.status()
      const dirty = status.dirty ?? []
      return {
        preview: {
          dirty,
          dirtyCount: dirty.length,
          ahead: status.ahead ?? 0,
          behind: status.behind ?? 0,
          remote: status.remote,
          branch: status.branch,
          nothingToDo: dirty.length === 0 && (status.ahead ?? 0) === 0,
        },
      }
    }),

    route(`${API_PREFIX}/backup/run`, 'POST', async () => {
      const result = await deps.gate.run('backup', () => deps.backup())
      if (result.ok === false) throw new SyncError('GIT_FAILED', result.error ?? 'backup failed')
      return { result }
    }),

    route(`${API_PREFIX}/restore/preview`, 'POST', async (input) => ({
      preview: await deps.previewRestore(requireCommit(input)),
    })),

    route(`${API_PREFIX}/restore/merge`, 'POST', async (input) => {
      const commit = requireCommit(input)
      const result = await deps.gate.run('merge', () => deps.mergeRestore(commit))
      if (result.ok === false) throw new SyncError('GIT_FAILED', result.error ?? 'restore failed')
      return { result }
    }),

    route(`${API_PREFIX}/restore/overwrite/prepare`, 'POST', async (input) => {
      const commit = requireCommit(input)
      const result = await deps.gate.run('overwrite-prepare', () => deps.prepareOverwrite(commit))
      if (result.ok === false) throw new SyncError('GIT_FAILED', result.error ?? 'restore preparation failed')
      return { result }
    }),

    route(`${API_PREFIX}/restore/pending`, 'GET', async () => ({ pending: await deps.pendingRestores() })),

    route(`${API_PREFIX}/restore/pending/cancel`, 'POST', async (input) => {
      const id = typeof input?.id === 'string' ? input.id.trim() : ''
      if (id.length === 0) throw new SyncError('BAD_CONFIG', 'restore task id is required')
      return { pending: await deps.cancelRestore(id) }
    }),
  ]
}

export { isLoopback as isLoopbackRequest }
