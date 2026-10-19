// Workspace registration is separate from session logs. Never create project directories.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isSessionLog, sessionHeader } from './session-portable.mjs'

export const WORKSPACE_MANIFEST = 'workspace-manifest.json'
const SCHEMA = 'dsh-session-sync/workspaces/v1'
const pathKey = value => typeof value === 'string' ? (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)) : ''

/** Read only formal logs; do not follow links or adopt manual snapshots as sessions. */
export async function workspaceSessionHeaders(root) {
  const result = []
  const walk = async directory => {
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && isSessionLog(path.relative(root, file).split(path.sep).join('/'))) {
        const rel = path.relative(root, file).split(path.sep).join('/')
        const { header } = sessionHeader(rel, await fs.readFile(file))
        result.push({ id: header.id, cwd: header.cwd })
      }
    }
  }
  await walk(root)
  return result
}

export async function captureWorkspaceManifest({ registry, sessionRoot }) {
  if (typeof registry?.list !== 'function') throw new Error('工作区注册服务不可用，无法备份原分组元数据')
  const workspaces = registry.list()
  const sessions = (await workspaceSessionHeaders(sessionRoot)).map(header => {
    const owner = workspaces.find(workspace => workspace.sessionIds.includes(header.id))
      ?? workspaces.find(workspace => header.cwd !== undefined && pathKey(workspace.path) === pathKey(header.cwd))
    return { ...header, workspace: owner ? { path: owner.path, title: owner.title } : null }
  }).sort((a, b) => a.id.localeCompare(b.id))
  return { schema: SCHEMA, sessions }
}

function parseManifest(bytes) {
  const value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes)
  if (value?.schema !== SCHEMA || !Array.isArray(value.sessions)) throw new Error('不支持的工作区分组元数据')
  const ids = new Set()
  for (const row of value.sessions) {
    if (typeof row?.id !== 'string' || row.id === '' || ids.has(row.id)
      || (row.cwd !== undefined && typeof row.cwd !== 'string')
      || (row.workspace !== null && (typeof row.workspace?.path !== 'string' || typeof row.workspace?.title !== 'string'))) {
      throw new Error('工作区分组元数据损坏或包含重复会话')
    }
    ids.add(row.id)
  }
  return value
}

/** Same-cwd local identities win, just as the keep-both log merge retains local identity. */
export function mergeWorkspaceManifests(ours, theirs) {
  const left = ours === undefined ? [] : parseManifest(ours).sessions
  const right = theirs === undefined ? [] : parseManifest(theirs).sessions
  const rows = new Map(right.map(row => [row.id, row]))
  for (const row of left) rows.set(row.id, row)
  return Buffer.from(JSON.stringify({ schema: SCHEMA, sessions: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)) }) + '\n')
}

export async function writeWorkspaceManifest({ repoDir, capture }) {
  if (typeof capture !== 'function') return
  const content = Buffer.from(JSON.stringify(await capture()) + '\n')
  const file = path.join(repoDir, WORKSPACE_MANIFEST)
  try { if ((await fs.readFile(file)).equals(content)) return } catch (error) { if (error.code !== 'ENOENT') throw error }
  await fs.writeFile(file, content)
}

/** Apply only to verified live headers. Missing directories never block log restoration. */
export async function restoreWorkspaceGrouping({ registry, headers, manifestBytes, preview = false }) {
  const report = { restored: 0, preserved: 0, ungrouped: 0, ready: 0, legacy: manifestBytes === undefined, pending: [], warnings: [], items: [] }
  let manifest
  try { manifest = manifestBytes === undefined ? undefined : parseManifest(manifestBytes) }
  catch (error) { report.warnings.push(error.message); return report }
  const metadata = new Map(manifest?.sessions.map(row => [row.id, row]) ?? [])
  if (report.legacy && headers.length > 0) report.warnings.push('旧备份未包含工作区名称；仅按实际 cwd 恢复分组，原自定义名称无法恢复')
  const existing = typeof registry?.list === 'function' ? registry.list() : []
  const owned = new Set(existing.flatMap(workspace => [...workspace.sessionIds]))
  const seen = new Set()
  for (const header of headers) {
    if (seen.has(header.id)) continue
    seen.add(header.id)
    const row = metadata.get(header.id)
    const item = { id: header.id, path: header.cwd, sourcePath: row?.cwd, title: row?.workspace?.title, status: 'pending' }
    report.items.push(item)
    if (owned.has(header.id)) {
      const owner = existing.find(workspace => workspace.sessionIds.includes(header.id))
      item.title = owner?.title
      item.status = 'preserved'; report.preserved++; continue
    }
    if (manifest !== undefined && row?.workspace === null) { item.status = 'ungrouped'; report.ungrouped++; continue }
    if (manifest !== undefined && row === undefined) {
      report.pending.push({ id: header.id, path: header.cwd, reason: '备份未记录该会话的原分组，不推测归属' }); continue
    }
    const cwd = header.cwd
    if (cwd === undefined || cwd === '') { item.status = 'ungrouped'; report.ungrouped++; continue }
    const title = row?.workspace.title || path.basename(cwd.replaceAll('\\', path.sep))
    item.title = title
    const pending = reason => report.pending.push({ id: header.id, path: cwd, title, sourcePath: row?.cwd, reason })
    if (typeof registry?.create !== 'function') { pending('宿主工作区注册接口不可用'); continue }
    if (!path.isAbsolute(cwd) || (process.platform === 'win32' && !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/u.test(cwd))) {
      pending('会话 cwd 不是本机完全限定路径'); continue
    }
    try {
      if (!(await fs.stat(cwd)).isDirectory()) { pending('工作区路径不是目录，未创建或修改项目目录'); continue }
      if (preview) { item.status = 'ready'; report.ready++; continue }
      const workspace = await registry.create(cwd, title)
      await workspace.attachSession(header.id)
      owned.add(header.id)
      item.status = 'restored'
      report.restored++
    } catch (error) {
      pending(['ENOENT', 'ENOTDIR'].includes(error.code) ? '原目录不存在，日志已保留；需选择本机目录映射，未创建项目目录' : (error.message ?? String(error)))
    }
  }
  return report
}

/** Repair only sessions present in both the local mirror and the live store. No network. */
export async function repairMirroredWorkspaceGrouping({ registry, repoDir, sessionRoot, mirrorDir = 'sessions' }) {
  const mirrored = await workspaceSessionHeaders(path.join(repoDir, mirrorDir))
  const ids = new Set(mirrored.map(header => header.id))
  const headers = (await workspaceSessionHeaders(sessionRoot)).filter(header => ids.has(header.id))
  let manifestBytes
  try { manifestBytes = await fs.readFile(path.join(repoDir, WORKSPACE_MANIFEST)) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return restoreWorkspaceGrouping({ registry, headers, manifestBytes })
}
