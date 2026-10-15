// lib/progress.mjs — 备份进度注册表（会话 / 插件 / 技能三类，各自独立）。
//
// 设计约束（2026-10-15 与用户确认）：
// - 数据必须真实：git 的百分比/对象计数/速率全部来自 `git push --progress` 的
//   stderr 原始输出；镜像阶段来自逐文件计数。**本模块绝不生成估算百分比**。
// - 没有真实百分比时显式进入 `indeterminate` 态（前端显示流动条纹 + 已用时长），
//   而不是编一个数字。
// - 前端每 500ms 轮询一次快照（宿主无 SSE/WebSocket 通道，实测确认）。
//
// 生命周期：start(kind) → update(kind, patch) → finish(kind, ok) → 完成后保留
// 一小段时间（默认 6s）供前端做"完成 → 缩小消失"动画，之后从快照里移除。

/** 三类备份域。顺序即前端上下排列的顺序。 */
export const PROGRESS_KINDS = Object.freeze(['session', 'plugin', 'skill'])

/** 完成后在快照里保留多久（ms）——给前端播放收尾动画的窗口。 */
export const FINISHED_LINGER_MS = 6000

/** 不确定态（有进度未知的等待，如 push 握手期）。 */
export const PHASE_INDETERMINATE = 'indeterminate'

/**
 * 解析一行 git 进度输出。
 *
 * git 的输出形态（实测 git 2.55.0.windows.3，`git push --progress` stderr）：
 *   Enumerating objects: 3, done.
 *   Counting objects:  33% (1/3)
 *   Counting objects: 100% (3/3), done.
 *   Delta compression using up to 20 threads
 *   Compressing objects:  50% (1/2)
 *   Writing objects:  66% (2/3)
 *   Writing objects: 100% (3/3), 392 bytes | 392.00 KiB/s, done.
 *   Total 3 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)
 *
 * **注意**：git 的百分比是它自己【单个阶段】的进度（Counting / Compressing /
 * Writing 各自 0→100），不是整个 push 的百分比。因此这里如实上报 phase +
 * 该阶段自己的 percent，绝不把它冒充成全局百分比。
 *
 * @param {string} line - 一行 stderr 文本。
 * @returns {{phase: string, percent: number, counts?: {done: number, total: number}, rate?: string} | null} 解析结果，或 null（该行不含进度）。
 */
export function parseGitProgressLine(line) {
  const text = String(line ?? '').replace(/\r/gu, '').trim()
  if (text === '') return null

  // 阶段名 + 百分比 + 计数 [+ 可选速率]，一条正则覆盖全部实测形态：
  //   `Writing objects:  33% (1/3)`
  //   `Writing objects: 100% (3/3), 392 bytes | 392.00 KiB/s, done.`
  //   `Counting objects: 100% (3/3), done.`
  // 注意 `\s*` 必须放在阶段名与百分号之间（实测有双空格）。
  const progress = /^([A-Za-z][A-Za-z ]*?objects)\s*:\s*(\d{1,3})%\s*\((\d+)\/(\d+)\)(.*)$/u.exec(text)
  if (progress !== null) {
    const tail = progress[5] ?? ''
    const rate = /([\d.]+\s*\w+\/s)/u.exec(tail)
    return {
      phase: normalizePhase(progress[1]),
      percent: Math.max(0, Math.min(100, Number(progress[2]))),
      counts: { done: Number(progress[3]), total: Number(progress[4]) },
      ...(rate !== null ? { rate: rate[1] } : {}),
    }
  }

  // 只有计数、没有百分比：`Enumerating objects: 3, done.`
  const countOnly = /^(Enumerating objects)\s*:\s*(\d+)(?:,\s*done\.?)?/u.exec(text)
  if (countOnly !== null) {
    return {
      phase: normalizePhase(countOnly[1]),
      percent: 100,
      counts: { done: Number(countOnly[2]), total: Number(countOnly[2]) },
    }
  }

  return null
}

/** 把 git 的英文阶段名归一到稳定枚举（前端据此选文案）。 */
function normalizePhase(raw) {
  const name = String(raw).replace(/^remote:\s*/u, '').trim()
  switch (name) {
    case 'Enumerating objects': return 'enumerating'
    case 'Counting objects': return 'counting'
    case 'Compressing objects': return 'compressing'
    case 'Writing objects': return 'writing'
    case 'Receiving objects': return 'receiving'
    case 'Resolving deltas': return 'resolving'
    case 'Updating files': return 'updating'
    default: return 'transfer'
  }
}

/**
 * 进度注册表。一个实例服务一次进程生命周期；三类域各自独立条目。
 *
 * 线程模型：全部同步（Node 单线程）。`update` 只是对象赋值，不阻塞子进程读取。
 */
export class ProgressRegistry {
  /** @type {Map<string, object>} */
  #entries = new Map()

  /** @type {() => number} */
  #now

  /**
   * @param {object} [deps] - {now?: () => number}（测试可注入时钟）。
   */
  constructor(deps = {}) {
    this.#now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  }

  /**
   * 开始一次备份。重复开始（同一域）会覆盖为新的进行中状态。
   * @param {'session'|'plugin'|'skill'} kind - 备份域。
   * @param {object} [init] - {label?: string, total?: number, stage?: string}。
   * @returns {object} 该条目的快照。
   */
  start(kind, init = {}) {
    assertKind(kind)
    const at = this.#now()
    const entry = {
      kind,
      label: typeof init.label === 'string' ? init.label : kind,
      state: 'running',
      stage: typeof init.stage === 'string' ? init.stage : 'starting',
      // 真实百分比；null = 未知（前端走不确定态）
      percent: null,
      // 阶段自身的百分比（git 语义），与 overall 区分
      phase: null,
      counts: null,
      rate: null,
      // 镜像阶段的真实文件计数
      files: Number.isFinite(init.total) && init.total > 0 ? { done: 0, total: Number(init.total) } : null,
      startedAt: at,
      updatedAt: at,
      finishedAt: null,
      ok: null,
      error: null,
    }
    this.#entries.set(kind, entry)
    return { ...entry }
  }

  /**
   * 更新一个域。只覆盖显式传入的字段（patch 语义），不做推算。
   * @param {'session'|'plugin'|'skill'} kind - 备份域。
   * @param {object} patch - 要覆盖的字段。
   * @returns {object|null} 更新后的快照；该域不存在时为 null。
   */
  update(kind, patch = {}) {
    const entry = this.#entries.get(kind)
    if (entry === undefined) return null
    if (patch.stage !== undefined) entry.stage = patch.stage
    if (patch.percent !== undefined) entry.percent = patch.percent
    if (patch.phase !== undefined) entry.phase = patch.phase
    if (patch.counts !== undefined) entry.counts = patch.counts
    if (patch.rate !== undefined) entry.rate = patch.rate
    if (patch.files !== undefined) entry.files = patch.files
    if (patch.label !== undefined) entry.label = patch.label
    entry.updatedAt = this.#now()
    return { ...entry }
  }

  /**
   * 结束一次备份（成功或失败）。不立即删除：保留 FINISHED_LINGER_MS 供前端播放收尾动画。
   * @param {'session'|'plugin'|'skill'} kind - 备份域。
   * @param {object} [result] - {ok?: boolean, error?: string, message?: string}。
   * @returns {object|null} 结束时快照。
   */
  finish(kind, result = {}) {
    const entry = this.#entries.get(kind)
    if (entry === undefined) return null
    const at = this.#now()
    entry.state = 'finished'
    entry.ok = result.ok !== false
    entry.error = result.ok === false ? (typeof result.error === 'string' ? result.error : 'unknown error') : null
    if (typeof result.message === 'string') entry.message = result.message
    entry.finishedAt = at
    entry.updatedAt = at
    if (entry.ok === true) entry.percent = 100
    return { ...entry }
  }

  /**
   * 当前快照。已结束且超过保留期的条目在此清理（惰性 GC）。
   * @returns {{entries: object[], now: number}} 按 PROGRESS_KINDS 顺序排列。
   */
  snapshot() {
    const at = this.#now()
    for (const [kind, entry] of [...this.#entries]) {
      if (entry.state === 'finished' && entry.finishedAt !== null && at - entry.finishedAt > FINISHED_LINGER_MS) {
        this.#entries.delete(kind)
      }
    }
    const entries = []
    for (const kind of PROGRESS_KINDS) {
      const entry = this.#entries.get(kind)
      if (entry !== undefined) entries.push({ ...entry, elapsedMs: (entry.finishedAt ?? at) - entry.startedAt })
    }
    return { entries, now: at }
  }

  /** 是否还有进行中的条目（调度器可用于避免并发）。 */
  hasRunning() {
    for (const entry of this.#entries.values()) {
      if (entry.state === 'running') return true
    }
    return false
  }
}

/** 断言域合法（配置/调用错误响亮失败）。 */
function assertKind(kind) {
  if (!PROGRESS_KINDS.includes(kind)) {
    throw new Error(`unknown progress kind ${JSON.stringify(kind)}; expected one of ${PROGRESS_KINDS.join('|')}`)
  }
}

/**
 * 把 git stderr 的一块文本喂给注册表：逐行解析、只上报真实进度。
 * 处理跨块残行（chunk 边界可能切断一行）。
 * @param {ProgressRegistry} registry - 注册表。
 * @param {'session'|'plugin'|'skill'} kind - 备份域。
 * @param {string} chunk - 本次读到的文本块。
 * @param {{carry: string}} state - 跨块残行载体（调用方持有同一对象）。
 * @returns {object|null} 最后一条被采纳的进度。
 */
export function feedGitProgress(registry, kind, chunk, state) {
  const text = `${state.carry ?? ''}${String(chunk ?? '')}`
  const lines = text.split('\n')
  state.carry = lines.pop() ?? ''
  let last = null
  for (const line of lines) {
    const parsed = parseGitProgressLine(line)
    if (parsed === null) continue
    last = parsed
    registry.update(kind, {
      stage: 'push',
      phase: parsed.phase,
      percent: parsed.percent,
      counts: parsed.counts ?? null,
      rate: parsed.rate ?? null,
    })
  }
  // 残行本身也可能已是完整进度（没有换行的结尾）
  if (state.carry !== '') {
    const parsed = parseGitProgressLine(state.carry)
    if (parsed !== null) {
      last = parsed
      registry.update(kind, {
        stage: 'push',
        phase: parsed.phase,
        percent: parsed.percent,
        counts: parsed.counts ?? null,
        rate: parsed.rate ?? null,
      })
    }
  }
  return last
}
