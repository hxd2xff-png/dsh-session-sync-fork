// Relocate only the immutable session header. Event frames/messages stay byte-for-byte intact.
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { assertRelPath } from './paths.mjs'
import { localText } from './portable.mjs'

export function isSessionLog(rel) {
  return /\/session\.v\d+\.jsonl(?:\.zstd)?$/u.test('/' + rel)
}

export function sessionHeader(rel, bytes) {
  if (!isSessionLog(rel)) throw new Error('Unsupported session artifact: ' + rel)
  const compressed = rel.endsWith('.zstd')
  /** @type {any} */
  const frame = compressed ? zstdDecompressSync(bytes, { info: true }) : undefined
  const first = compressed ? frame.buffer : bytes
  const end = first.indexOf(10)
  if (end < 0 || (compressed && end !== first.length - 1)) throw new Error('Session header must be one complete independent record: ' + rel)
  const header = JSON.parse(first.subarray(0, end).toString('utf8'))
  if (header?.type !== 'session' || typeof header.id !== 'string' || !Number.isSafeInteger(header.version)) throw new Error('Invalid session header: ' + rel)
  return { header, body: compressed ? bytes.subarray(frame.engine.bytesWritten) : bytes.subarray(end + 1), compressed }
}

export function replaceSessionCwd(rel, bytes, cwd, targetRel = rel) {
  const decoded = sessionHeader(rel, bytes)
  const compressed = targetRel.endsWith('.zstd')
  if (decoded.header.cwd === cwd && decoded.compressed === compressed) return bytes
  const header = { ...decoded.header, cwd }
  const line = Buffer.from(JSON.stringify(header) + '\n')
  let body = decoded.body
  if (decoded.compressed !== compressed && body.length > 0) {
    if (compressed) body = zstdCompressSync(body)
    else {
      const frames = []
      while (body.length > 0) {
        /** @type {any} */
        const frame = zstdDecompressSync(body, { info: true })
        if (frame.engine.bytesWritten <= 0) throw new Error('Invalid compressed session frame')
        frames.push(frame.buffer)
        body = body.subarray(frame.engine.bytesWritten)
      }
      body = Buffer.concat(frames)
    }
  }
  return Buffer.concat([compressed ? zstdCompressSync(line) : line, body])
}

function nativeAbsolute(value) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) return false
  // A Windows path on POSIX, or a POSIX root on Windows, is not a local absolute project.
  return process.platform !== 'win32' ? !path.win32.isAbsolute(value) || path.posix.isAbsolute(value) : path.win32.parse(value).root !== '\\' && path.win32.parse(value).root !== '/'
}
async function isDirectory(value) {
  if (!nativeAbsolute(value)) return false
  try { return (await fs.stat(value)).isDirectory() } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error }
}

/**
 * 创建会话映射器：把备份里的外来 cwd 重写到本机项目目录。
 * @param {object} deps - 依赖。
 * @param {string} deps.sessionRoot - 本机会话根目录。
 * @param {{locate: Function, findLog?: Function}} deps.persistence - 宿主会话定位服务。
 * @param {Record<string, string>} [deps.projectPaths] - 源路径 → 目标路径映射。
 * @param {boolean} [deps.preview] - 预览模式（缺少目标目录时不抛错）。
 * @param {string} [deps.userHome] - 本机用户目录。
 * @param {string} [deps.dshHome] - DSH home。
 * @param {Function} deps.inspectLog - 日志校验回调。
 */
export function createSessionMapper({ sessionRoot, persistence, projectPaths = {}, preview = false, userHome = os.homedir(), dshHome, inspectLog }) {
  if (projectPaths === null || typeof projectPaths !== 'object' || Array.isArray(projectPaths)) throw new Error('projectPaths must be a source-to-target directory map')
  const projects = new Map()
  const ids = new Map()
  const targetOwners = new Map()
  const existingIds = new Map()
  const mapEntry = async (rel, bytes) => {
    assertRelPath(rel)
    // Preserve manual snapshots and sidecars without adopting them as live session identities.
    if (!isSessionLog(rel)) return { rel, blob: bytes, auxiliary: true }
    const { header } = sessionHeader(rel, bytes)
    const source = header.cwd
    let cwd = source
    if (source !== undefined) {
      if (typeof source !== 'string') throw new Error('Invalid session project path')
      let project = projects.get(source)
      if (project === undefined) {
        const explicit = Object.hasOwn(projectPaths, source)
        const suggested = explicit ? projectPaths[source] : localText(source, { userHome, dshHome }).replaceAll('\\', path.sep)
        cwd = explicit ? suggested : await isDirectory(suggested) ? suggested : await isDirectory(source) ? source : suggested
        const available = await isDirectory(cwd)
        // 目标目录不存在时不再阻断还原，fallback 到 suggested 路径继续
        project = { source, target: nativeAbsolute(cwd) ? path.resolve(cwd) : '', suggested: nativeAbsolute(cwd) ? path.resolve(cwd) : path.join(userHome, 'Documents', path.win32.basename(source.replaceAll('/', '\\'))), requiresSelection: !available }
        projects.set(source, project)
      }
      // 目录不存在时不再阻断还原，直接使用 suggested 路径
      cwd = project.target || project.suggested
    }
    const next = { ...header, ...(cwd === undefined ? {} : { cwd }) }
    if (typeof persistence?.locate !== 'function') throw new Error('Host session location service is unavailable')
    const target = persistence.locate(next).path
    if (/session[.]v[0-9]+[.]jsonl/u.exec(path.basename(rel))?.[0] !== /session[.]v[0-9]+[.]jsonl/u.exec(path.basename(target))?.[0]) throw new Error('备份日志版本与目标宿主不同，需先完成格式迁移: ' + rel)
    const mappedRel = assertRelPath(path.relative(sessionRoot, target).split(path.sep).join('/'))
    if (mappedRel.startsWith('../') || path.isAbsolute(mappedRel)) throw new Error('Session target escaped the session root')
    const previous = ids.get(header.id)
    if (previous !== undefined && previous !== mappedRel) throw new Error('重复会话 ID 映射到不同项目: ' + header.id)
    ids.set(header.id, mappedRel)
    const owner = targetOwners.get(mappedRel)
    if (owner !== undefined) throw new Error('多个备份文件映射到同一日志，已拒绝还原: ' + mappedRel)
    targetOwners.set(mappedRel, rel)
    if (typeof persistence.findLog === 'function') {
      if (!existingIds.has(header.id)) existingIds.set(header.id, await persistence.findLog(header.id))
      const existing = existingIds.get(header.id)
      if (existing !== undefined && path.resolve(existing.sourcePath) !== path.resolve(target)) throw new Error('本地同 ID 会话已存在于其他目录，请选择该会话对应目录，避免重复身份: ' + header.id)
    }
    const migrated = replaceSessionCwd(rel, bytes, cwd, mappedRel)
    // Decoder validates every committed event after replacing the foreign OS header path.
    await inspectLog(mappedRel, migrated)
    return { rel: mappedRel, blob: migrated }
  }
  return { mapEntry, projects: () => [...projects.values()] }
}
