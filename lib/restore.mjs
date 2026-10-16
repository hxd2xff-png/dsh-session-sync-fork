// lib/restore.mjs — 从指定备份提交还原到本机会话库。
//
// 两种模式：
// - merge（安全合并）：复用 append-only keep-both 语义——只把备份提交里
//   **本地缺失**的会话文件写入本地；同名文件一律保留本地版本，备份版本另存
//   为 fork 文件。绝不覆盖本地已存在的会话字节。
// - overwrite（全量还原）：以备份恢复缺失/较旧会话，保留本地新增历史与
//   本地独有会话；分叉拒绝；不交换整个目录，不回退 live writer 的日志。
//
// 安全边界：全部写入路径经 assertRelPath + 根目录包含检查；符号链接拒绝；
// overwrite 在宿主写租约保护下逐会话写入，失败只回滚本次实际修改的日志。

import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { FORK_NAME_RE, HOST_ARTIFACT_NAME_RE, MIRROR_DIR, RESTORE_MODES } from './constants.mjs'
import { assertRelPath, forkFileName } from './paths.mjs'
import { mirrorFilesAtCommit } from './history.mjs'
import { SyncError, pathUnsafe } from './errors.mjs'

/** 临时比对区根的缺省值（系统临时目录，绝不落在会话库内）。 */
function tempRootOf(deps) {
  return typeof deps.tempRoot === 'string' && deps.tempRoot.length > 0 ? deps.tempRoot : os.tmpdir()
}

/** 目标路径是否落在 root 内（纯路径运算，拒绝 `..` 逃逸）。 */
function insideRoot(root, target) {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 递归枚举常规文件（符号链接跳过）。 */
async function listFilesRecursive(root) {
  const files = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (entry.isFile()) files.push({ absolute, rel: path.relative(root, absolute).split(path.sep).join('/') })
    }
  }
  await walk(root)
  return files
}

/** 内容一致返回 true。 */
async function sameContent(a, b) {
  try {
    const [left, right] = await Promise.all([fs.readFile(a), fs.readFile(b)])
    return left.equals(right)
  } catch {
    return false
  }
}

/**
 * 在系统临时目录里落一个 blob 供逐字节比对；用完立即删除。
 * 放在 os.tmpdir() 而非 sessionRoot 内：绝不往会话库写临时文件（否则会成为
 * 可同步内容并污染镜像）。
 * @param {object} deps - {tempRoot}。
 * @param {Buffer} blob - 内容。
 * @returns {Promise<{path: string, cleanup: () => Promise<void>}>}
 */
async function withTempBlob(deps, blob) {
  const dir = await fs.mkdtemp(path.join(tempRootOf(deps), 'sessionsync-restore-'))
  const file = path.join(dir, 'blob')
  await fs.writeFile(file, blob)
  return {
    path: file,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  }
}

/** Resolve the complete restore plan before writing any live file. */
async function restoreEntries(deps) {
  const files = await mirrorFilesAtCommit(deps.git, deps.commit)
  const entries = []
  const targets = new Set()
  for (const rel of files) {
    const name = rel.split('/').at(-1) ?? ''
    if (FORK_NAME_RE.test(name) || HOST_ARTIFACT_NAME_RE.test(name)) continue
    const blob = await deps.git.readFileAtRev(deps.commit, MIRROR_DIR + '/' + rel)
    if (blob === undefined) continue
    const entry = typeof deps.mapEntry === 'function' ? await deps.mapEntry(rel, blob) : { rel, blob }
    if (targets.has(entry.rel)) throw pathUnsafe('multiple backup logs map to one target: ' + entry.rel)
    targets.add(entry.rel)
    entries.push(entry)
  }
  return entries
}

/**
 * 还原预览：只读统计，供页面展示风险后再决定。
 * @param {object} deps - {git, sessionRoot, commit, mode}。
 * @returns {Promise<object>} 预览结果。
 */
export async function previewRestore(deps) {
  const { git, sessionRoot, commit } = deps
  try {
    const entries = await restoreEntries(deps)
    const files = entries.filter(entry => !entry.auxiliary)
    const auxiliaryFiles = entries.filter(entry => entry.auxiliary).map(entry => entry.rel)
    let existing = 0
    let missing = 0
    let identical = 0
    const willWrite = []
    const willFork = []
    for (const { rel, blob } of files) {
      const basename = rel.split('/').at(-1) ?? ''
      // fork 文件与宿主私有产物不是还原目标：它们属于运行时/冲突产物。
      if (FORK_NAME_RE.test(basename) || HOST_ARTIFACT_NAME_RE.test(basename)) continue
      const target = path.join(sessionRoot, ...rel.split('/'))
      if (!insideRoot(sessionRoot, target)) throw pathUnsafe(`restore path escapes sessionRoot: ${rel}`)
      let stat = null
      try {
        stat = await fs.stat(target)
      } catch {
        stat = null
      }
      if (stat === null) {
        missing += 1
        willWrite.push(rel)
        continue
      }
      existing += 1
      const temp = await withTempBlob(deps, blob)
      try {
        if (await sameContent(target, temp.path)) identical += 1
        else willFork.push(rel)
      } finally {
        await temp.cleanup()
      }
    }
    return {
      ok: true,
      commit,
      mode: deps.mode ?? RESTORE_MODES.MERGE,
      projects: typeof deps.projects === 'function' ? deps.projects() : [],
      totalFiles: files.length,
      auxiliaryFiles,
      auxiliaryCount: auxiliaryFiles.length,
      missing,
      existing,
      identical,
      willWrite: willWrite.slice(0, 200),
      willFork: willFork.slice(0, 200),
      willWriteCount: willWrite.length,
      willForkCount: willFork.length,
    }
  } catch (error) {
    return { ok: false, commit, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 安全合并还原：只写本地缺失的文件；同名不同内容一律留存为 fork。
 * 绝不覆盖本地已有字节，绝不删除本地文件。
 * @param {object} deps - {git, sessionRoot, commit, deviceShort, tempRoot, logger?}。
 * @returns {Promise<object>} 结果摘要。
 */
export async function mergeRestore(deps) {
  const { git, sessionRoot, commit } = deps
  const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)
  const deviceShort = deps.deviceShort ?? 'unknown'
  let artifacts = {}
  try {
    const entries = await restoreEntries(deps)
    const files = entries.filter(entry => !entry.auxiliary)
    artifacts = await preserveArtifacts(deps, entries.filter(entry => entry.auxiliary))
    let written = 0
    let skipped = 0
    const forks = []
    for (const { rel, blob } of files) {
      const basename = rel.split('/').at(-1) ?? ''
      if (FORK_NAME_RE.test(basename) || HOST_ARTIFACT_NAME_RE.test(basename)) continue
      const target = path.join(sessionRoot, ...rel.split('/'))
      if (!insideRoot(sessionRoot, target)) throw pathUnsafe(`restore path escapes sessionRoot: ${rel}`)
      let exists = false
      try {
        await fs.access(target)
        exists = true
      } catch {
        exists = false
      }
      if (!exists) {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, blob)
        written += 1
        continue
      }
      // 本地已有：逐字节相同则跳过，不同则留存备份版本为 fork（本地版本保留）。
      const temp = await withTempBlob(deps, blob)
      let identical
      try {
        identical = await sameContent(target, temp.path)
      } finally {
        await temp.cleanup()
      }
      if (identical) {
        skipped += 1
        continue
      }
      const forkName = forkFileName(basename, stamp, deviceShort)
      const forkPath = path.join(path.dirname(target), forkName)
      if (!insideRoot(sessionRoot, forkPath)) throw pathUnsafe(`fork path escapes sessionRoot: ${rel}`)
      await fs.writeFile(forkPath, blob)
      forks.push(path.posix.join(path.posix.dirname(rel), forkName))
      skipped += 1
    }
    return { ok: true, mode: RESTORE_MODES.MERGE, commit, written, skipped, forks, ...artifacts }
  } catch (error) {
    return {
      ok: false,
      mode: RESTORE_MODES.MERGE,
      commit,
      ...artifacts,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 准备完整覆盖：复制当前会话库为安全快照（只读备份），返回快照目录。
 * 真正的替换与回滚由独立 helper 执行——这里不做任何破坏性写入。
 * @param {object} deps - {sessionRoot, snapshotDir, id}。
 * @returns {Promise<{ok: boolean, snapshotDir?: string, files?: number, error?: string}>}
 */
export async function createSafetySnapshot(deps) {
  const { sessionRoot, snapshotDir, id } = deps
  try {
    const target = path.join(snapshotDir, id)
    if (!insideRoot(snapshotDir, target)) throw pathUnsafe('snapshot path escapes the snapshot root')
    await fs.mkdir(target, { recursive: true })
    const files = await listFilesRecursive(sessionRoot)
    let copied = 0
    for (const file of files) {
      const destination = path.join(target, ...file.rel.split('/'))
      if (!insideRoot(target, destination)) throw pathUnsafe(`snapshot path escapes: ${file.rel}`)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(file.absolute, destination)
      copied += 1
    }
    return { ok: true, snapshotDir: target, files: copied }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 从某提交把完整会话库物化到一个暂存目录（helper 用它做整目录替换的来源）。
 * 不触碰 sessionRoot。
 * @param {object} deps - {git, commit, stagingDir}。
 * @returns {Promise<{ok: boolean, stagingDir?: string, files?: number, error?: string}>}
 */
export async function materializeCommit(deps) {
  const { git, commit, stagingDir } = deps
  try {
    await fs.rm(stagingDir, { recursive: true, force: true })
    await fs.mkdir(stagingDir, { recursive: true })
    const files = await restoreEntries(deps)
    let written = 0
    for (const { rel, blob } of files) {
      const basename = rel.split('/').at(-1) ?? ''
      if (FORK_NAME_RE.test(basename) || HOST_ARTIFACT_NAME_RE.test(basename)) continue
      const target = path.join(stagingDir, ...rel.split('/'))
      if (!insideRoot(stagingDir, target)) throw pathUnsafe(`staging path escapes: ${rel}`)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, blob)
      written += 1
    }
    return { ok: true, stagingDir, files: written, auxiliaryFiles: files.filter(entry => entry.auxiliary).map(entry => entry.rel) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Read only real files under the session root; never follow links during restore. */
async function restoreTarget(root, rel) {
  const target = path.resolve(root, ...rel.split('/'))
  if (!insideRoot(root, target) || target === path.resolve(root)) throw pathUnsafe('restore path escapes sessionRoot')
  let current = path.resolve(root)
  for (const part of ['', ...rel.split('/')]) {
    current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw pathUnsafe('restore refuses symbolic links: ' + rel)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return target
}

async function readOptional(file) {
  try { return await fs.readFile(file) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Keep opaque backup sidecars outside the live store; never drop or adopt their histories. */
async function preserveArtifacts(deps, entries) {
  if (entries.length === 0) return { auxiliaryCount: 0 }
  if (typeof deps.artifactRoot !== 'string' || !path.isAbsolute(deps.artifactRoot)) {
    throw new Error('附属备份保留目录不可用，已拒绝丢弃文件')
  }
  if (insideRoot(deps.sessionRoot, deps.artifactRoot)) throw pathUnsafe('auxiliary archive must be outside the live session root')
  const name = 'restore-artifacts-' + randomUUID()
  const target = await restoreTarget(deps.artifactRoot, name)
  await fs.mkdir(deps.artifactRoot, { recursive: true })
  await fs.mkdir(target)
  const manifest = []
  for (const entry of entries) {
    const rel = assertRelPath(entry.rel)
    const file = await restoreTarget(target, 'files/' + rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, entry.blob, { flag: 'wx' })
    manifest.push({ path: rel, bytes: entry.blob.length, sha256: createHash('sha256').update(entry.blob).digest('hex') })
  }
  await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify({ commit: deps.commit, files: manifest }, null, 2) + '\n', { flag: 'wx' })
  return { auxiliaryCount: entries.length, artifactDir: target }
}

/** Compare decoded committed histories, not compression frame boundaries. */
function historyPrefix(older, newer) {
  return isDeepStrictEqual(older.meta, newer.meta)
    && older.inheritedEventCount === newer.inheritedEventCount
    && older.events.length <= newer.events.length
    && older.events.every((event, index) => isDeepStrictEqual(event, newer.events[index]))
}

/**
 * 用备份恢复，同时保留本地追加的历史与本地独有会话。
 * 不再交换 sessionRoot；保留中的日志连 inode 都不改，live writer 可继续追加。
 * 分叉或损坏在任何日志写入前拒绝；需要修改的冷会话由宿主写租约保护。
 * inspectLog 必须用宿主解码器检查完整日志；acquireWriteLease 必须拒绝已加载会话。
 * @param {object} deps - {git, commit, sessionRoot, snapshotDir, stagingDir, id,
 *   inspectLog, acquireWriteLease, onProgress?}。
 * @returns {Promise<object>} 实际恢复/保留数量、快照与失败回滚信息。
 */
export async function overwriteApply(deps) {
  const { git, commit, sessionRoot, snapshotDir, stagingDir, id } = deps
  const snapshotTarget = path.resolve(snapshotDir, id)
  const leases = []
  const applied = []
  let artifacts = {}
  const report = (patch) => {
    if (typeof deps.onProgress !== 'function') return
    try { deps.onProgress(patch) } catch { /* 进度回调不改变还原结果 */ }
  }
  try {
    if (!insideRoot(snapshotDir, snapshotTarget) || snapshotTarget === path.resolve(snapshotDir)) {
      throw pathUnsafe('snapshot path escapes the snapshot root')
    }
    for (const [left, right] of [[sessionRoot, stagingDir], [sessionRoot, snapshotTarget], [stagingDir, snapshotTarget]]) {
      if (insideRoot(left, right) || insideRoot(right, left)) throw pathUnsafe('restore directories must not overlap')
    }
    if (typeof deps.inspectLog !== 'function' || typeof deps.acquireWriteLease !== 'function') {
      throw new Error('宿主日志校验或写租约不可用，已拒绝全量还原')
    }
    const staged = await materializeCommit({ git, commit, stagingDir, mapEntry: deps.mapEntry })
    if (staged.ok === false) throw new Error('materialize failed: ' + staged.error)
    const auxiliaryFiles = new Set(staged.auxiliaryFiles ?? [])
    const plan = []
    let preserved = 0
    // 全部预检完成后才允许修改日志；不以改 seq 或丢弃事件来掩盖分叉。
    for (const file of await listFilesRecursive(stagingDir)) {
      if (auxiliaryFiles.has(file.rel)) continue
      const target = await restoreTarget(sessionRoot, file.rel)
      const backup = await fs.readFile(file.absolute)
      const remote = await deps.inspectLog(file.rel, backup)
      const original = await readOptional(target)
      if (original !== undefined) {
        const local = await deps.inspectLog(file.rel, original)
        if (historyPrefix(remote, local)) {
          preserved += 1
          continue
        }
        if (!historyPrefix(local, remote)) throw new Error('备份与本地历史分叉，已拒绝全量还原: ' + file.rel)
      }
      plan.push({ rel: file.rel, target, backup, original, meta: remote.meta })
    }
    // 持有全部待写会话的宿主锁，防止另一进程或新打开的写句柄与还原并发。
    for (const item of plan) leases.push(await deps.acquireWriteLease(item.rel, item.meta))
    for (const item of plan) {
      const now = await readOptional(await restoreTarget(sessionRoot, item.rel))
      if (!(now === undefined && item.original === undefined)
        && !(now !== undefined && item.original !== undefined && now.equals(item.original))) {
        throw new Error('本地日志在预检后发生变化，已拒绝全量还原: ' + item.rel)
      }
    }
    // 保留原有安全快照；任务 id 冲突时绝不覆盖先前快照。
    await fs.mkdir(snapshotDir, { recursive: true })
    await fs.mkdir(snapshotTarget)
    const auxiliaryEntries = []
    for (const rel of auxiliaryFiles) auxiliaryEntries.push({ rel, blob: await fs.readFile(await restoreTarget(stagingDir, rel)) })
    artifacts = await preserveArtifacts({ ...deps, artifactRoot: deps.artifactRoot ?? snapshotDir }, auxiliaryEntries)
    const current = await listFilesRecursive(sessionRoot)
    report({ stage: 'delete', files: { done: 0, total: current.length + plan.length } })
    let done = 0
    for (const file of current) {
      const destination = path.join(snapshotTarget, ...file.rel.split('/'))
      if (!insideRoot(snapshotTarget, destination)) throw pathUnsafe('snapshot path escapes')
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(file.absolute, destination)
      report({ stage: 'delete', files: { done: ++done, total: current.length + plan.length } })
    }
    for (const item of plan) {
      await fs.mkdir(path.dirname(item.target), { recursive: true })
      const temporary = path.join(path.dirname(item.target), '.session-sync-restore-' + randomUUID() + '.tmp')
      const handle = await fs.open(temporary, 'wx')
      try {
        try {
          await handle.writeFile(item.backup)
          await handle.sync()
        } finally { await handle.close() }
        // 同目录发布，不把原日志先截断；缺失目标用 link 保证绝不覆盖并发创建的文件。
        if (item.original === undefined) await fs.link(temporary, item.target)
        else await fs.rename(temporary, item.target)
        applied.push(item)
      } finally { await fs.rm(temporary, { force: true }) }
      report({ stage: 'delete', files: { done: ++done, total: current.length + plan.length } })
    }
    return { ok: true, replaced: plan.length, preserved, snapshotDir: snapshotTarget, ...artifacts }
  } catch (error) {
    // 仅回滚本次实际写入的冷会话；绝不把整个库回退，更不碰保留中的 live 日志。
    const rollbackErrors = []
    for (const item of applied.reverse()) {
      try {
        if (item.original === undefined) await fs.unlink(item.target)
        else await fs.writeFile(item.target, item.original)
      } catch (rollbackError) { rollbackErrors.push(String(rollbackError)) }
    }
    return {
      ok: false, rolledBack: applied.length > 0 && rollbackErrors.length === 0,
      snapshotDir: snapshotTarget, rollbackErrors, ...artifacts,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    // release 失败必须向调用方暴露，不能把仍持有租约伪装成成功。
    const releases = await Promise.allSettled(leases.map((lease) => lease.release()))
    const failed = releases.find((result) => result.status === 'rejected')
    if (failed !== undefined) throw failed.reason
  }
}

export { SyncError, insideRoot, listFilesRecursive }
