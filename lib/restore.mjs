// lib/restore.mjs — 从指定备份提交还原到本机会话库。
//
// 两种模式：
// - merge（安全合并）：复用 append-only keep-both 语义——只把备份提交里
//   **本地缺失**的会话文件写入本地；同名文件一律保留本地版本，备份版本另存
//   为 fork 文件。绝不覆盖本地已存在的会话字节。
// - overwrite（完整覆盖）：两阶段。页面只**准备**任务（写安全快照 + 生成
//   独立 helper），真正替换由 helper 在 DSH 完全退出后执行；失败回滚快照。
//
// 安全边界：全部写入路径经 assertRelPath + 根目录包含检查；符号链接拒绝；
// 任何一步失败都不留下半替换状态（overwrite 的替换本身是"先备份后整目录换"）。

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FORK_NAME_RE, HOST_ARTIFACT_NAME_RE, MIRROR_DIR, RESTORE_MODES } from './constants.mjs'
import { forkFileName } from './paths.mjs'
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

/**
 * 还原预览：只读统计，供页面展示风险后再决定。
 * @param {object} deps - {git, sessionRoot, commit, mode}。
 * @returns {Promise<object>} 预览结果。
 */
export async function previewRestore(deps) {
  const { git, sessionRoot, commit } = deps
  try {
    const files = await mirrorFilesAtCommit(git, commit)
    let existing = 0
    let missing = 0
    let identical = 0
    const willWrite = []
    const willFork = []
    for (const rel of files) {
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
      const blob = await git.readFileAtRev(commit, `${MIRROR_DIR}/${rel}`)
      if (blob === undefined) continue
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
      totalFiles: files.length,
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
  try {
    const files = await mirrorFilesAtCommit(git, commit)
    let written = 0
    let skipped = 0
    const forks = []
    for (const rel of files) {
      const basename = rel.split('/').at(-1) ?? ''
      if (FORK_NAME_RE.test(basename) || HOST_ARTIFACT_NAME_RE.test(basename)) continue
      const target = path.join(sessionRoot, ...rel.split('/'))
      if (!insideRoot(sessionRoot, target)) throw pathUnsafe(`restore path escapes sessionRoot: ${rel}`)
      const blob = await git.readFileAtRev(commit, `${MIRROR_DIR}/${rel}`)
      if (blob === undefined) continue
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
    return { ok: true, mode: RESTORE_MODES.MERGE, commit, written, skipped, forks }
  } catch (error) {
    return {
      ok: false,
      mode: RESTORE_MODES.MERGE,
      commit,
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
    const files = await mirrorFilesAtCommit(git, commit)
    let written = 0
    for (const rel of files) {
      const basename = rel.split('/').at(-1) ?? ''
      if (FORK_NAME_RE.test(basename) || HOST_ARTIFACT_NAME_RE.test(basename)) continue
      const target = path.join(stagingDir, ...rel.split('/'))
      if (!insideRoot(stagingDir, target)) throw pathUnsafe(`staging path escapes: ${rel}`)
      const blob = await git.readFileAtRev(commit, `${MIRROR_DIR}/${rel}`)
      if (blob === undefined) continue
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, blob)
      written += 1
    }
    return { ok: true, stagingDir, files: written }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export { SyncError, insideRoot, listFilesRecursive }
