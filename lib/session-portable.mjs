// Relocate only the immutable session header. Event frames/messages stay byte-for-byte intact.
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { assertRelPath, detectProjectFallbackRoot, isNativeAbsolute, userHomeDir } from './paths.mjs'
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

/**
 * 本机目录判定：先验“本机完全限定绝对路径”（跨平台差异由 paths.mjs 吸收），再 stat。
 * @param {string} value - 待判定路径。
 * @returns {Promise<boolean>}
 */
async function isLocalDirectory(value) {
  if (!isNativeAbsolute(value)) return false
  try { return (await fs.stat(value)).isDirectory() } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error }
}

/**
 * 为缺失的源目录挑一个**本机真实存在**的落点：`<本机文档目录>/<源目录名>`。
 * 文档目录的本地化/无桌面回退全部由 detectProjectFallbackRoot() 处理，
 * 绝不写死 'Documents' 这类英文名。
 * @param {string} source - 备份里的来源 cwd。
 * @param {object} deps - 依赖。
 * @param {string|undefined} deps.userHome - 本机用户目录。
 * @param {string|undefined} deps.fallbackRoot - 显式回退根。
 * @param {NodeJS.Platform} [deps.platform] - 平台（测试注入）。
 * @returns {string} 本机绝对路径（回退根一定存在）。
 */
function suggestedLocalProject(source, { userHome, fallbackRoot, platform }) {
  const fallback = detectProjectFallbackRoot({ userHome, fallbackRoot, platform })
  const name = path.basename(source.replace(/[/\\]+$/u, ''))
  if (fallback === undefined) return ''
  return name === '' || name === '.' || name === '..' ? fallback : path.join(fallback, name)
}

/**
 * 创建会话映射器：把备份里的外来 cwd 重写到本机项目目录。
 *
 * 跨设备差异（盘符不同、主目录不同、目录名本地化、目录根本不存在）在这里
 * 全部被吸收成「一个本机绝对路径」：优先显式映射 → 便携占位展开后的真实目录
 * → 来源目录在本机恰好存在时原样复用 → 本机文档目录下的同名子目录。
 * @param {object} deps - 依赖。
 * @param {string} deps.sessionRoot - 本机会话根目录。
 * @param {{locate: Function, findLog?: Function}} deps.persistence - 宿主会话定位服务。
 * @param {Record<string, string>} [deps.projectPaths] - 源路径 → 目标路径映射。
 * @param {boolean} [deps.preview] - 预览模式（保留字段；目录缺失不阻断）。
 * @param {string} [deps.userHome] - 本机用户目录（默认按平台动态识别）。
 * @param {string} [deps.dshHome] - DSH home（默认动态识别）。
 * @param {string} [deps.fallbackRoot] - 缺失项目的回退根（默认动态识别文档目录）。
 * @param {NodeJS.Platform} [deps.platform] - 平台（默认 process.platform）。
 * @param {(path: string) => Promise<boolean>} [deps.isDirectory] - 目录探测（测试注入）。
 * @param {Function} deps.inspectLog - 日志校验回调。
 */
export function createSessionMapper({
  sessionRoot,
  persistence,
  projectPaths = {},
  preview = false,
  userHome = userHomeDir(),
  dshHome,
  fallbackRoot,
  platform = process.platform,
  isDirectory = isLocalDirectory,
  inspectLog,
}) {
  if (projectPaths === null || typeof projectPaths !== 'object' || Array.isArray(projectPaths)) throw new Error('projectPaths must be a source-to-target directory map')
  const probe = typeof isDirectory === 'function' ? isDirectory : isLocalDirectory
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
        // 便携展开：来源路径里的 ~/$VAR/%VAR% 之外的设备差异（用户目录、DSH home）
        // 全部展开成本机路径；展开结果仍可能是不存在的目录，交给下面的探测。
        const expanded = explicit ? projectPaths[source] : localText(source, { userHome, dshHome }).replaceAll('\\', path.sep)
        const fallback = suggestedLocalProject(source, { userHome, fallbackRoot, platform })
        // 优先级：显式映射 → 展开后存在 → 来源路径在本机恰好存在 → 本机文档目录同名子目录。
        const candidates = explicit ? [expanded] : [expanded, source, fallback]
        let chosen = ''
        for (const candidate of candidates) {
          if (!isNativeAbsolute(candidate)) continue
          if (await probe(candidate)) { chosen = candidate; break }
        }
        if (chosen === '') chosen = isNativeAbsolute(expanded) ? expanded : (isNativeAbsolute(fallback) ? fallback : '')
        // 目录尚不存在也不再阻断还原：落点恒为本机绝对路径，工作区归属留给后续步骤。
        project = {
          source,
          target: isNativeAbsolute(chosen) ? path.resolve(chosen) : '',
          suggested: isNativeAbsolute(chosen) ? path.resolve(chosen) : fallback,
          requiresSelection: !(await probe(chosen)),
        }
        projects.set(source, project)
      }
      // 目录不存在时不再阻断还原，直接使用已解析的落点。
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
  void preview
  return { mapEntry, projects: () => [...projects.values()] }
}
