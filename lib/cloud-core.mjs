import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCHEMA = 'dsh-cloud-sync/v1'
const CONFIG_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', '.npmrc']
const DEFAULT_IGNORES = new Set(['node_modules', '.pnpm', '.git', '.svn', '.hg', 'dist', 'build', 'coverage', '.env', '.credentials.yaml', 'credentials.yaml', '.DS_Store'])
const MAX_SOURCE_BYTES = 100 * 1024 * 1024
const GIST_MAX_OBJECT_BYTES = 700 * 1024
const GIST_MAX_FILES = 200
const GIST_FILE_PREFIX = 'dsh-cloud-sync-v1-'
const GIST_MARKER_FILE = 'dsh-cloud-sync-v1.json'
const GITHUB_API_URL = 'https://api.github.com'
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_GITHUB_OAUTH_CLIENT_ID = 'Ov23liqTnhZ79x2hJZpd'
const GITHUB_GIST_MAX_RETRIES = 3
const SELF_PACKAGE = '@dickpy/dsh-cloud-sync'
const SELF_GITHUB_REPOSITORY = 'dickpy/dsh-cloud-sync'
const SELF_GITHUB_RELEASE_API = `https://api.github.com/repos/${SELF_GITHUB_REPOSITORY}/releases/latest`
const SELF_GITHUB_DOWNLOAD_PREFIX = `https://github.com/${SELF_GITHUB_REPOSITORY}/releases/download/`
const MAX_SELF_RELEASE_BYTES = 50 * 1024 * 1024
const MAX_LOCAL_BACKUPS = 10
const HISTORY_INDEX = 'snapshots/history/index.json'
const HISTORY_LIMIT = 30
// 技能备份域：与快照历史完全隔离的键空间（1A 方案）——skills/ 前缀只属于技能备份，
// 不会与会话/插件快照的 snapshots/ 前缀串味，删除互不影响。
const SKILLS_INDEX = 'skills/index.json'
const SKILLS_ARCHIVE_PREFIX = 'skills'
// 技能备份历史条数上限（是条数，不是天数）。Gist 全仓库硬上限 200 个文件，
// 一次备份 ≈ 35 个归档对象（28 技能 + 分片实测值）；5 × 35 = 175 < 200，
// 留足未变化技能共用对象与索引/快照文件的余量。30 条（1050 对象）必然撞
// file limit reached（用户确认降为 5；需要长期历史请改用 WebDAV/S3）。
const SKILLS_LIMIT = 5
const SKILLS_ROOT = ['.agents', 'skills']
// 分片目标体积：Gist 单对象上限的 60%（给 base64 膨胀与压缩波动留余量）。
const SKILL_PART_TARGET_BYTES = Math.floor(GIST_MAX_OBJECT_BYTES * 0.6)
// 一次批量 PATCH 携带的文件数上限：Gist PATCH 请求体过大会被 GitHub 拒（422）。
const SKILL_UPLOAD_BATCH = 12
const ownPackagePath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json')
const encryptionKeys = new Map()
const automaticSyncRuns = new Map()
const githubDeviceAuthorizations = new Map()
const ENCRYPTED_FORMAT = 'dsh-cloud-sync/encrypted/v1'

export function dshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  return resolve(configured || join(homedir(), '.dsh'))
}

export function syncRoot(home = dshHome()) { return join(home, 'dsh-cloud-sync') }
export function profileDir(name, home = dshHome()) {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === 'node_modules') throw new Error(`Invalid DSH profile name: ${JSON.stringify(name)}`)
  return join(home, 'profiles', name)
}

export async function ensureProfilePnpmShim({ profile = 'web', home = dshHome(), pnpmCommand, env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return undefined
  let globalShim = pnpmCommand ?? [
    join(homedir(), 'AppData', 'Roaming', 'npm', 'pnpm.cmd'),
    env.PNPM_HOME === undefined ? undefined : join(env.PNPM_HOME, 'pnpm.cmd'),
    env.APPDATA === undefined ? undefined : join(env.APPDATA, 'npm', 'pnpm.cmd'),
  ].find(candidate => candidate !== undefined && existsSync(candidate))
  if (globalShim === undefined) {
    try {
      const found = await commandOutput(spawn('where.exe', ['pnpm.cmd'], { shell: false, windowsHide: true }))
      globalShim = found.stdout.split(/\r?\n/).map(value => value.trim()).find(candidate => candidate !== '' && existsSync(candidate))
    } catch {}
  }
  if (globalShim === undefined || !existsSync(globalShim)) return undefined
  const target = join(profileDir(profile, home), 'pnpm.cmd')
  const content = `@echo off\r\ncall "${globalShim.replaceAll('"', '""')}" %*\r\n`
  if (!existsSync(target) || await readFile(target, 'utf8') !== content) await writeFile(target, content, 'utf8')
  return target
}

function hash(buffer) { return createHash('sha256').update(buffer).digest('hex') }
function encode(buffer) { return Buffer.from(buffer).toString('base64') }
function decode(value) { return Buffer.from(value, 'base64') }
function sourceSlug(name) { return name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '') }
function isInside(root, candidate) {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(`${base}\\`) || target.startsWith(`${base}/`)
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error?.code === 'ENOENT') return fallback; throw error }
}
async function writeJson(file, value) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); await chmod(file, 0o600).catch(() => {}) }

function releaseVersionParts(version) {
  const match = typeof version === 'string' && version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (match === null || match === false) return undefined
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] }
}

export function compareVersions(left, right) {
  const leftParts = releaseVersionParts(left)
  const rightParts = releaseVersionParts(right)
  if (leftParts === undefined || rightParts === undefined) throw new Error('Release versions must use major.minor.patch format')
  for (let index = 0; index < 3; index += 1) {
    if (leftParts.numbers[index] !== rightParts.numbers[index]) return leftParts.numbers[index] > rightParts.numbers[index] ? 1 : -1
  }
  if (leftParts.prerelease === rightParts.prerelease) return 0
  if (leftParts.prerelease === undefined) return 1
  if (rightParts.prerelease === undefined) return -1
  return leftParts.prerelease.localeCompare(rightParts.prerelease)
}

async function ownVersion() {
  const manifest = await readJson(ownPackagePath)
  if (typeof manifest?.version !== 'string') throw new Error('Cloud Sync package version is unavailable')
  releaseVersionParts(manifest.version) ?? (() => { throw new Error('Cloud Sync package version is invalid') })()
  return manifest.version
}

function selfReleaseAssetName(version) { return `dickpy-dsh-cloud-sync-${version}.tgz` }

function parseGithubSelfRelease(value) {
  if (value === null || typeof value !== 'object' || value.draft === true || value.prerelease === true || typeof value.tag_name !== 'string' || !Array.isArray(value.assets)) throw new Error('GitHub Cloud Sync release metadata is invalid')
  const version = value.tag_name.replace(/^v/, '')
  releaseVersionParts(version) ?? (() => { throw new Error('GitHub Cloud Sync release version is invalid') })()
  const asset = value.assets.find(item => item !== null && typeof item === 'object' && item.name === selfReleaseAssetName(version))
  if (asset === undefined || typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith(`${SELF_GITHUB_DOWNLOAD_PREFIX}${encodeURIComponent(value.tag_name)}/`) || typeof asset.digest !== 'string') throw new Error(`GitHub Cloud Sync release is missing ${selfReleaseAssetName(version)}`)
  const digest = asset.digest.match(/^sha256:([a-f0-9]{64})$/i)
  if (digest === null) throw new Error('GitHub Cloud Sync release checksum is invalid')
  return { packageName: SELF_PACKAGE, version, assetName: asset.name, downloadUrl: asset.browser_download_url, sha256: digest[1].toLowerCase(), createdAt: typeof value.published_at === 'string' ? value.published_at : undefined }
}

async function githubResponse(url, fetcher) {
  const response = await fetcher(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cloud-sync' } })
  if (!response.ok) throw new Error(`GitHub release request failed: HTTP ${response.status}`)
  return response
}

async function latestGithubSelfRelease(fetcher) {
  try { return parseGithubSelfRelease(await (await githubResponse(SELF_GITHUB_RELEASE_API, fetcher)).json()) } catch (error) {
    if ((error instanceof Error ? error.message : String(error)).includes('HTTP 404')) return undefined
    throw error
  }
}

async function downloadGithubSelfRelease(release, fetcher) {
  const response = await githubResponse(release.downloadUrl, fetcher)
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_SELF_RELEASE_BYTES) throw new Error('GitHub Cloud Sync release is too large')
  const archive = Buffer.from(await response.arrayBuffer())
  if (archive.length > MAX_SELF_RELEASE_BYTES) throw new Error('GitHub Cloud Sync release is too large')
  return archive
}

function configuredSelfArchive(spec, directory) {
  if (typeof spec !== 'string' || !spec.startsWith('file:')) return undefined
  const raw = spec.slice('file:'.length)
  if (!/\.tgz$/i.test(raw)) return undefined
  return resolve(directory, raw)
}

async function configuredSelfArchiveHash(home) {
  const directory = profileDir('web', home)
  const manifest = await readJson(join(directory, 'package.json'), {})
  const archivePath = configuredSelfArchive(manifest.dependencies?.[SELF_PACKAGE], directory)
  return archivePath === undefined || !existsSync(archivePath) ? undefined : hash(await readFile(archivePath))
}

export async function checkSelfUpdate({ home = dshHome(), fetcher = fetch } = {}) {
  const localVersion = await ownVersion()
  const release = await latestGithubSelfRelease(fetcher)
  if (release === undefined) return { localVersion, available: false }
  const localArchiveSha256 = await configuredSelfArchiveHash(home)
  const versionComparison = compareVersions(release.version, localVersion)
  const sameVersionRevision = versionComparison === 0 && localArchiveSha256 !== undefined && localArchiveSha256 !== release.sha256
  return { localVersion, localArchiveSha256, available: versionComparison > 0 || sameVersionRevision, sameVersionRevision, release }
}

const PORTABLE_PNPM_EXCLUDES = /^(?:storeDir|store-dir|globalDir|global-dir|globalBinDir|global-bin-dir|cacheDir|cache-dir|stateDir|state-dir|configDir|config-dir):/
const PORTABLE_NPMRC_EXCLUDES = /^\s*(?:storeDir|store-dir|globalDir|global-dir|globalBinDir|global-bin-dir|cacheDir|cache-dir|stateDir|state-dir|configDir|config-dir)\s*=/i
export function sanitizePnpmWorkspace(text) {
  return text.split(/\r?\n/).filter(line => !PORTABLE_PNPM_EXCLUDES.test(line.trim())).join('\n').replace(/\n+$/, '') + '\n'
}
export function sanitizeNpmrc(text) {
  return text.split(/\r?\n/).filter(line => !PORTABLE_NPMRC_EXCLUDES.test(line)).join('\n').replace(/\n+$/, '') + '\n'
}
export function sanitizeCordisPatch(text) {
  const lines = text.split(/\r?\n/)
  const emptyIndex = lines.findIndex(line => line.trim() === '[]')
  if (emptyIndex === -1 || !lines.slice(emptyIndex + 1).some(line => /^-\s+/.test(line.trim()))) return text
  lines.splice(emptyIndex, 1)
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}
export function sanitizePnpmLock(text) {
  const lines = text.split(/\r?\n/)
  const kept = []
  let skippedIndent
  for (const line of lines) {
    const indentation = line.match(/^\s*/)?.[0].length ?? 0
    if (skippedIndent !== undefined && (line.trim() === '' || indentation > skippedIndent)) continue
    skippedIndent = undefined
    const quoted = line.match(/^(\s+)(?:'([^']+)'|"([^"]+)"):\s*(?:\{\})?\s*$/)
    const bare = line.match(/^(\s+)([^:\s]+):\s*(?:\{\})?\s*$/)
    const key = quoted?.[2] ?? quoted?.[3] ?? bare?.[2]
    if (key === SELF_PACKAGE || key?.startsWith(`${SELF_PACKAGE}@file:`)) { skippedIndent = indentation; continue }
    kept.push(line)
  }
  return kept.join('\n').replace(/\n+$/, '') + '\n'
}
async function normalizeProfilePnpmWorkspace(directory) {
  const path = join(directory, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return false
  const current = await readFile(path, 'utf8')
  const next = sanitizePnpmWorkspace(current)
  if (current === next) return false
  await writeFile(path, next, 'utf8')
  return true
}
async function normalizeProfileNpmrc(directory) {
  const path = join(directory, '.npmrc')
  if (!existsSync(path)) return false
  const current = await readFile(path, 'utf8')
  const next = sanitizeNpmrc(current)
  if (current === next) return false
  await writeFile(path, next, 'utf8')
  return true
}
async function currentProfileStore(directory) {
  const modules = join(directory, 'node_modules', '.modules.yaml')
  if (!existsSync(modules)) return undefined
  const content = await readFile(modules, 'utf8')
  const match = content.match(/^storeDir:\s*(.+?)\s*$/m)
  if (match === null) return undefined
  const value = match[1].trim().replace(/^['"]|['"]$/g, '')
  return value === '' || /[\r\n]/.test(value) ? undefined : value
}
async function repairProfilePnpmConfig(directory) {
  await normalizeProfilePnpmWorkspace(directory)
  const store = await currentProfileStore(directory)
  await normalizeProfileNpmrc(directory)
  if (store === undefined) return undefined
  const path = join(directory, '.npmrc')
  const current = existsSync(path) ? await readFile(path, 'utf8') : ''
  const portable = sanitizeNpmrc(current).replace(/\n$/, '')
  const next = `${portable}${portable === '' ? '' : '\n'}store-dir=${store.replaceAll('\\', '/')}\n`
  if (current !== next) await writeFile(path, next, 'utf8')
  return store
}

function settingsPath(home) { return join(syncRoot(home), 'settings.json') }
function credentialsPath(home) { return join(syncRoot(home), 'credentials.json') }
const SAVED_PROVIDER_TYPES = ['webdav', 's3', 'oss', 'cos', 'minio', 'kodo', 'gist']
const defaultSettings = { provider: { type: 'webdav', url: '', username: '', password: '' }, savedProviders: {}, syncPolicy: 'smart', historyLimit: HISTORY_LIMIT, deviceId: '', deviceName: '', autoSync: { enabled: false, intervalMinutes: 30 }, syncScope: { sources: true }, encryption: { enabled: false, salt: '' } }

async function dpapi(value, operation) {
  const script = operation === 'protect'
    ? "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
    : "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v);[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(value, 'utf8')
  const result = await commandOutput(child)
  if (result.exitCode !== 0) throw new Error('Windows DPAPI could not protect Cloud Sync credentials')
  return result.stdout.trim()
}

async function saveSecret(type, secret, home) {
  const existing = await readJson(credentialsPath(home), undefined)
  const secrets = existing?.version === 2 && existing.secrets && typeof existing.secrets === 'object' ? { ...existing.secrets } : {}
  if (existing?.version !== 2 && typeof existing?.secret === 'string' && type !== undefined) secrets[type] = { scheme: existing.scheme, secret: existing.secret }
  if (secret === '') {
    delete secrets[type]
  } else {
    secrets[type] = process.platform === 'win32' ? { scheme: 'dpapi', secret: await dpapi(secret, 'protect') } : { scheme: 'file-0600', secret }
  }
  if (Object.keys(secrets).length === 0) { await rm(credentialsPath(home), { force: true }); return }
  await writeJson(credentialsPath(home), { version: 2, secrets })
}

async function readSecret(type, home) {
  const payload = await readJson(credentialsPath(home), undefined)
  const entry = payload?.version === 2 ? payload.secrets?.[type] : payload
  if (typeof entry?.secret !== 'string') return ''
  return entry.scheme === 'dpapi' ? dpapi(entry.secret, 'unprotect') : entry.scheme === 'file-0600' ? entry.secret : ''
}

function providerSecret(provider) {
  if (provider?.type === 'webdav') return provider.password
  if (isObjectStorageType(provider?.type)) return provider.secretAccessKey
  if (provider?.type === 'gist') return provider.token
  return ''
}

function maskedProvider(provider, secret) {
  if (provider?.type === 'webdav') return { type: 'webdav', url: provider.url, username: provider.username, password: secret === '' ? '' : '<stored-in-credentials>' }
  if (isObjectStorageType(provider?.type)) return { ...provider, secretAccessKey: secret === '' ? '' : '<stored-in-credentials>' }
  if (provider?.type === 'gist') return { ...provider, token: secret === '' ? '' : '<stored-in-credentials>' }
  return provider
}

function savedProviderProfile(provider, secret = '') {
  if (provider?.type === 'webdav') return { type: 'webdav', url: provider.url ?? '', username: provider.username ?? '', secretStored: secret !== '' || provider.secretStored === true || provider.password === '<stored-in-credentials>' || provider.password === '<stored-locally>' }
  if (isObjectStorageType(provider?.type)) {
    const { secretAccessKey, password, ...profile } = provider
    return { ...profile, secretStored: secret !== '' || provider.secretStored === true || secretAccessKey === '<stored-in-credentials>' || secretAccessKey === '<stored-locally>' }
  }
  if (provider?.type === 'gist') return { type: 'gist', gistId: provider.gistId ?? '', secretStored: secret !== '' || provider.secretStored === true || provider.token === '<stored-in-credentials>' || provider.token === '<stored-locally>' }
  return undefined
}

function normalizeSavedProviders(settings) {
  const savedProviders = {}
  for (const type of SAVED_PROVIDER_TYPES) {
    const profile = settings.savedProviders?.[type]
    if (profile?.type === type) savedProviders[type] = savedProviderProfile(profile)
  }
  const active = settings.provider
  if (SAVED_PROVIDER_TYPES.includes(active?.type)) {
    const profile = savedProviderProfile(active, providerSecret(active))
    if (profile !== undefined && (profile.url !== '' || profile.endpoint !== '' || profile.bucket !== '' || profile.gistId !== '')) savedProviders[active.type] = profile
  }
  return savedProviders
}

async function persistSettings(settings, home) {
  const secret = providerSecret(settings.provider)
  const type = SAVED_PROVIDER_TYPES.includes(settings.provider?.type) ? settings.provider.type : undefined
  if (type !== undefined) await saveSecret(type, secret, home)
  const stored = { ...settings, provider: maskedProvider(settings.provider, secret), savedProviders: normalizeSavedProviders(settings) }
  await writeJson(settingsPath(home), stored)
}

export async function loadSettings(home = dshHome()) {
  const settings = await readJson(settingsPath(home), defaultSettings)
  const type = settings.provider?.type
  if (type !== 'webdav' && !isObjectStorageType(type) && type !== 'gist' && type !== 'none') {
    const removed = { ...defaultSettings, ...settings, provider: { type: 'none' }, savedProviders: normalizeSavedProviders(settings), syncPolicy: normalizeSyncPolicy(settings.syncPolicy), lastConnectedAt: undefined }
    await writeJson(settingsPath(home), removed)
    return removed
  }
  if (type !== 'webdav' && !isObjectStorageType(type) && type !== 'gist') return { ...defaultSettings, ...settings, savedProviders: normalizeSavedProviders(settings) }
  const field = type === 'webdav' ? 'password' : type === 'gist' ? 'token' : 'secretAccessKey'
  if (settings.provider[field] !== '' && settings.provider[field] !== '<stored-in-credentials>') {
    const secret = settings.provider[field]
    await persistSettings({ ...settings, provider: { ...settings.provider, [field]: secret } }, home)
    return { ...defaultSettings, ...settings, autoSync: { ...defaultSettings.autoSync, ...(settings.autoSync ?? {}) }, syncScope: { ...defaultSettings.syncScope, ...(settings.syncScope ?? {}) }, encryption: { ...defaultSettings.encryption, ...(settings.encryption ?? {}) }, savedProviders: normalizeSavedProviders({ ...settings, provider: { ...settings.provider, [field]: secret } }), provider: { ...settings.provider, [field]: secret } }
  }
  const secret = settings.provider[field] === '' ? '' : await readSecret(type, home)
  const loaded = { ...defaultSettings, ...settings, autoSync: { ...defaultSettings.autoSync, ...(settings.autoSync ?? {}) }, syncScope: { ...defaultSettings.syncScope, ...(settings.syncScope ?? {}) }, encryption: { ...defaultSettings.encryption, ...(settings.encryption ?? {}) }, savedProviders: normalizeSavedProviders(settings), provider: { ...settings.provider, [field]: secret } }
  if (settings.provider[field] === '<stored-in-credentials>' && settings.savedProviders?.[type] === undefined) await persistSettings(loaded, home)
  return loaded
}
export async function saveSettings(settings, home = dshHome()) {
  await persistSettings(await normalizeSettings(settings, home), home)
}

async function normalizeSettings(settings, home) {
  if (settings?.provider?.type === 'webdav') return normalizeWebDavSettings(settings, home)
  if (isObjectStorageType(settings?.provider?.type)) return normalizeObjectStorageSettings(settings, home)
  if (settings?.provider?.type === 'gist') return normalizeGistSettings(settings, home)
  if (settings?.provider?.type === 'none') return { provider: { type: 'none' }, syncPolicy: normalizeSyncPolicy(settings.syncPolicy), lastConnectedAt: undefined }
  throw new Error('A sync provider is required')
}

async function normalizeObjectStorageSettings(settings, home) {
  const type = settings.provider.type
  const previous = await loadSettings(home)
  const secretAccessKey = settings.provider.secretAccessKey === '' ? previous.provider?.type === type ? previous.provider.secretAccessKey ?? '' : await readSecret(type, home) : settings.provider.secretAccessKey
  if (typeof secretAccessKey !== 'string' || secretAccessKey === '') throw new Error('An access key secret is required')
  const accessKeyId = typeof settings.provider.accessKeyId === 'string' ? settings.provider.accessKeyId.trim() : ''
  if (accessKeyId === '') throw new Error('An access key id is required')
  const bucket = typeof settings.provider.bucket === 'string' ? settings.provider.bucket.trim() : ''
  if (bucket === '' || /[\/\\\0-\x1f\x7f]/.test(bucket)) throw new Error('A valid bucket name is required')
  const endpoint = typeof settings.provider.endpoint === 'string' ? settings.provider.endpoint.trim() : ''
  if (endpoint === '') throw new Error('An endpoint is required')
  const region = typeof settings.provider.region === 'string' && settings.provider.region.trim() !== '' ? settings.provider.region.trim() : defaultObjectStorageRegion(type)
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(region)) throw new Error('A valid object storage region is required')
  const prefix = normalizeObjectStoragePrefix(settings.provider.prefix)
  const normalizedEndpoint = normalizeObjectStorageEndpoint(type, endpoint).url
  return {
    ...previous,
    ...settings,
    provider: { type, endpoint: normalizedEndpoint, region, bucket, prefix, accessKeyId, secretAccessKey },
    savedProviders: { ...(previous.savedProviders ?? {}), ...(settings.savedProviders ?? {}) },
    syncPolicy: normalizeSyncPolicy(settings.syncPolicy ?? previous.syncPolicy),
    autoSync: { ...defaultSettings.autoSync, ...(previous.autoSync ?? {}), ...(settings.autoSync ?? {}) },
    historyLimit: normalizeHistoryLimit(settings.historyLimit ?? previous.historyLimit),
    syncScope: { ...defaultSettings.syncScope, ...(previous.syncScope ?? {}), ...(settings.syncScope ?? {}) },
    encryption: { ...defaultSettings.encryption, ...(previous.encryption ?? {}), ...(settings.encryption ?? {}) },
    lastConnectedAt: previous.lastConnectedAt,
  }
}

async function normalizeWebDavSettings(settings, home) {
  let endpoint
  try { endpoint = new URL(settings.provider.url) } catch { throw new Error('WebDAV URL must use HTTPS') }
  if (endpoint.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && endpoint.protocol === 'http:')) throw new Error('WebDAV must use HTTPS; HTTP Basic authentication is not supported')
  const previous = await loadSettings(home)
  const password = settings.provider.password === '' ? previous.provider?.type === 'webdav' ? previous.provider.password ?? '' : await readSecret('webdav', home) : settings.provider.password
  if (typeof password !== 'string' || password === '') throw new Error('A WebDAV app password is required')
  const username = typeof settings.provider.username === 'string' ? settings.provider.username.trim() : ''
  if (username === '') throw new Error('A WebDAV username is required')
  return {
    ...previous,
    ...settings,
    provider: { type: 'webdav', url: endpoint.toString().replace(/\/+$/, ''), username, password },
    savedProviders: { ...(previous.savedProviders ?? {}), ...(settings.savedProviders ?? {}) },
    syncPolicy: normalizeSyncPolicy(settings.syncPolicy ?? previous.syncPolicy),
    autoSync: { ...defaultSettings.autoSync, ...(previous.autoSync ?? {}), ...(settings.autoSync ?? {}) },
    historyLimit: normalizeHistoryLimit(settings.historyLimit ?? previous.historyLimit),
    syncScope: { ...defaultSettings.syncScope, ...(previous.syncScope ?? {}), ...(settings.syncScope ?? {}) },
    encryption: { ...defaultSettings.encryption, ...(previous.encryption ?? {}), ...(settings.encryption ?? {}) },
    lastConnectedAt: previous.lastConnectedAt,
  }
}

async function normalizeGistSettings(settings, home) {
  const previous = await loadSettings(home)
  const token = settings.provider.token === '' ? previous.provider?.type === 'gist' ? previous.provider.token ?? '' : await readSecret('gist', home) : settings.provider.token
  if (typeof token !== 'string' || token === '') throw new Error('A GitHub token with Gist access is required')
  const gistId = typeof settings.provider.gistId === 'string' ? settings.provider.gistId.trim() : ''
  if (gistId !== '' && !/^[a-f0-9]{20,}$/i.test(gistId)) throw new Error('GitHub Gist ID is invalid')
  return {
    ...previous,
    ...settings,
    provider: { type: 'gist', gistId, token },
    savedProviders: { ...(previous.savedProviders ?? {}), ...(settings.savedProviders ?? {}) },
    syncPolicy: normalizeSyncPolicy(settings.syncPolicy ?? previous.syncPolicy),
    autoSync: { ...defaultSettings.autoSync, ...(previous.autoSync ?? {}), ...(settings.autoSync ?? {}) },
    historyLimit: normalizeHistoryLimit(settings.historyLimit ?? previous.historyLimit),
    syncScope: { sources: false },
    encryption: { ...defaultSettings.encryption, ...(previous.encryption ?? {}), ...(settings.encryption ?? {}) },
    lastConnectedAt: previous.lastConnectedAt,
  }
}

function normalizeSyncPolicy(value) {
  if (value === undefined) return 'smart'
  if (!['smart', 'cloud', 'local'].includes(value)) throw new Error('Sync policy must be smart, cloud, or local')
  return value
}

function normalizeHistoryLimit(value) {
  if (value === undefined) return HISTORY_LIMIT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('History limit must be an integer between 1 and 200')
  return limit
}

function publicSettings(settings, home = dshHome()) {
  const provider = { ...settings.provider }
  if ('password' in provider) provider.password = provider.password === '' ? '' : '<stored-locally>'
  if ('secretAccessKey' in provider) provider.secretAccessKey = provider.secretAccessKey === '' ? '' : '<stored-locally>'
  if ('token' in provider) provider.token = provider.token === '' ? '' : '<stored-locally>'
  const encryption = { ...defaultSettings.encryption, ...(settings.encryption ?? {}) }
  delete encryption.salt
  encryption.unlocked = encryption.enabled && encryptionKeys.has(resolve(home))
  return { ...settings, provider, savedProviders: normalizeSavedProviders({ ...settings, provider }), encryption }
}

export async function getPublicSettings(home = dshHome()) {
  return publicSettings(await deviceSettings(home), home)
}

async function webDavFetch(url, init = {}) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      if (response.status < 500 || attempt === 1) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
      if (attempt === 1) throw new Error(`WebDAV request failed: ${error instanceof Error && error.name === 'AbortError' ? 'timed out after 20 seconds' : error}`)
    } finally { clearTimeout(timer) }
  }
  throw lastError
}

class WebDavProvider {
  constructor({ url, username = '', password = '' }) {
    if (typeof url !== 'string' || (!/^https:\/\//.test(url) && !(process.env.NODE_ENV === 'test' && /^http:\/\//.test(url)))) throw new Error('WebDAV must use HTTPS')
    this.url = url.replace(/\/+$/, '')
    this.authorization = username === '' && password === '' ? undefined : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  }
  endpoint(key) { return `${this.url}/${key.split('/').map(encodeURIComponent).join('/')}` }
  async ensureCollections(key) {
    const parts = key.split('/').slice(0, -1)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let conflict = false
      for (let index = 1; index <= parts.length; index += 1) {
        const response = await webDavFetch(`${this.url}/${parts.slice(0, index).map(encodeURIComponent).join('/')}`, {
          method: 'MKCOL', headers: this.authorization === undefined ? {} : { authorization: this.authorization },
        })
        // Existing collections commonly return 405; reverse proxies can return 301/302.
        if ([200, 201, 204, 301, 302, 405].includes(response.status)) continue
        // Some servers (e.g. Nutstore) reject MKCOL with 409 while the target
        // directory is missing. Ensure it exists and retry once.
        if (response.status === 409 && attempt === 0) { conflict = true; break }
        throw new Error(`WebDAV MKCOL failed: HTTP ${response.status}`)
      }
      if (!conflict) return
      await this.probe()
    }
  }
  async put(key, body, { ifMatch, ifNoneMatch = false } = {}) {
    await this.ensureCollections(key)
    const headers = { ...(this.authorization === undefined ? {} : { authorization: this.authorization }), ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }), ...(ifNoneMatch ? { 'if-none-match': '*' } : {}) }
    const response = await webDavFetch(this.endpoint(key), { method: 'PUT', headers, body })
    if (response.status === 412) throw new Error('Remote snapshot changed during sync. Refresh and retry.')
    if (!response.ok) throw new Error(`WebDAV PUT ${key} failed: HTTP ${response.status}`)
  }
  async getWithMeta(key, retried = false) {
    const response = await webDavFetch(this.endpoint(key), { headers: this.authorization === undefined ? {} : { authorization: this.authorization } })
    if (!response.ok) {
      // A missing target directory (e.g. /dav/DSH-Sync) surfaces as 409 on
      // some servers (e.g. Nutstore). Create it and retry the read once.
      if (response.status === 409 && !retried) {
        await this.probe()
        return this.getWithMeta(key, true)
      }
      throw new Error(`WebDAV GET ${key} failed: HTTP ${response.status}`)
    }
    return { body: Buffer.from(await response.arrayBuffer()), etag: response.headers.get('etag') ?? undefined }
  }
  async get(key) {
    return (await this.getWithMeta(key)).body
  }
  async probe() {
    const headers = { ...(this.authorization === undefined ? {} : { authorization: this.authorization }), depth: '0' }
    const exists = async url => {
      const response = await webDavFetch(url, { method: 'PROPFIND', headers })
      if ([200, 204, 207].includes(response.status)) return true
      if (response.status === 404) return false
      throw new Error(`WebDAV connection failed: HTTP ${response.status}`)
    }
    if (await exists(this.url)) return
    // A fresh account has no target directory such as /dav/DSH-Sync yet.
    // Create every missing segment under the deepest existing ancestor so a
    // first-time sync works without manually creating the folder.
    const url = new URL(this.url)
    const encodeSegment = segment => { try { return encodeURIComponent(decodeURIComponent(segment)) } catch { return encodeURIComponent(segment) } }
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length === 0) throw new Error('WebDAV root directory is not accessible')
    let base = 0
    for (let count = segments.length - 1; count >= 1; count -= 1) {
      if (await exists(`${url.origin}/${segments.slice(0, count).map(encodeSegment).join('/')}`)) { base = count; break }
    }
    for (let count = base + 1; count <= segments.length; count += 1) {
      const created = await webDavFetch(`${url.origin}/${segments.slice(0, count).map(encodeSegment).join('/')}`, {
        method: 'MKCOL', headers: this.authorization === undefined ? {} : { authorization: this.authorization },
      })
      // Existing collections commonly return 405; reverse proxies can return 301/302.
      if (![200, 201, 204, 301, 302, 405].includes(created.status)) throw new Error(`WebDAV MKCOL failed: HTTP ${created.status}`)
    }
  }
}

const OBJECT_STORAGE_TYPES = ['s3', 'oss', 'cos', 'minio', 'kodo']
function isObjectStorageType(type) { return OBJECT_STORAGE_TYPES.includes(type) }
function defaultObjectStorageRegion(type) {
  if (type === 's3') return 'us-east-1'
  if (type === 'oss') return 'cn-hangzhou'
  if (type === 'cos') return 'ap-guangzhou'
  if (type === 'kodo') return 'cn-east-1'
  return 'us-east-1'
}
function normalizeObjectStoragePrefix(value) {
  const prefix = typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : ''
  const segments = prefix === '' ? [] : prefix.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || /[\0-\x1f\x7f]/.test(segment))) throw new Error('Object storage prefix is invalid')
  return segments.join('/')
}
function normalizeObjectStorageEndpoint(type, value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error(`${type.toUpperCase()} endpoint is invalid`) }
  const allowInsecure = type === 'minio' || process.env.NODE_ENV === 'test'
  if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:')) throw new Error(`${type.toUpperCase()} must use HTTPS`)
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') throw new Error(`${type.toUpperCase()} endpoint must not include credentials, query parameters, or fragments`)
  const basePath = parsed.pathname.replace(/\/+$/, '')
  if (basePath !== '' && !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(basePath)) throw new Error(`${type.toUpperCase()} endpoint path is invalid`)
  return { url: `${parsed.origin}${basePath}`, protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port, origin: parsed.origin, host: parsed.host, basePath }
}
function isProviderConfigured(provider) {
  if (provider?.type === 'webdav') return typeof provider.url === 'string' && provider.url !== ''
  if (isObjectStorageType(provider?.type)) return typeof provider.endpoint === 'string' && provider.endpoint !== '' && typeof provider.bucket === 'string' && provider.bucket !== ''
  if (provider?.type === 'gist') return typeof provider.gistId === 'string' && provider.gistId !== ''
  return false
}

function awsHmac(key, data) { return createHmac('sha256', key).update(data).digest() }
function awsSha256Hex(data) { return createHash('sha256').update(data).digest('hex') }
function awsUriEncode(value) {
  let encoded = ''
  for (const byte of Buffer.from(String(value), 'utf8')) {
    const char = String.fromCharCode(byte)
    if ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || char === '-' || char === '.' || char === '_' || char === '~') encoded += char
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return encoded
}
function awsCanonicalQuery(params) {
  const encoded = params.map(([key, value]) => [awsUriEncode(key), awsUriEncode(value)])
  encoded.sort((left, right) => left[0] === right[0] ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0) : (left[0] < right[0] ? -1 : 1))
  return encoded.map(([key, value]) => `${key}=${value}`).join('&')
}
function awsSigningKey(secretAccessKey, date, region, service) {
  const kDate = awsHmac(`AWS4${secretAccessKey}`, date)
  const kRegion = awsHmac(kDate, region)
  const kService = awsHmac(kRegion, service)
  return awsHmac(kService, 'aws4_request')
}
export function signAwsV4({ method, host, path, query = [], headers = {}, payloadHash, region, service, accessKeyId, secretAccessKey, amzDate }) {
  const date = amzDate ?? new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '')
  const hash = payloadHash ?? awsSha256Hex(Buffer.alloc(0))
  const canonicalHeaders = {}
  for (const [name, value] of Object.entries(headers)) canonicalHeaders[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ')
  canonicalHeaders.host = host
  canonicalHeaders['x-amz-date'] = date
  canonicalHeaders['x-amz-content-sha256'] = hash
  const signedHeaders = Object.keys(canonicalHeaders).sort()
  const canonicalHeadersBlock = signedHeaders.map(name => `${name}:${canonicalHeaders[name]}\n`).join('')
  const canonicalRequest = `${method}\n${path}\n${awsCanonicalQuery(query)}\n${canonicalHeadersBlock}\n${signedHeaders.join(';')}\n${hash}`
  const scope = `${date.slice(0, 8)}/${region}/${service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${awsSha256Hex(Buffer.from(canonicalRequest, 'utf8'))}`
  const signature = awsHmac(awsSigningKey(secretAccessKey, date.slice(0, 8), region, service), Buffer.from(stringToSign, 'utf8')).toString('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`
  return { authorization, amzDate: date, payloadHash: hash, signedHeaders }
}

async function s3Fetch(url, init = {}) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      if (response.status < 500 || attempt === 1) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
      if (attempt === 1) throw new Error(`Object storage request failed: ${error instanceof Error && error.name === 'AbortError' ? 'timed out after 30 seconds' : error}`)
    } finally { clearTimeout(timer) }
  }
  throw lastError
}

class S3Provider {
  constructor({ type, endpoint, region = '', bucket, prefix = '', accessKeyId = '', secretAccessKey = '' }) {
    if (!isObjectStorageType(type)) throw new Error(`Unsupported object storage provider: ${type}`)
    const parsed = normalizeObjectStorageEndpoint(type, endpoint)
    const normalizedBucket = typeof bucket === 'string' ? bucket.trim() : ''
    if (!/^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*(?:\.-|-\.))[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(normalizedBucket)) throw new Error('A valid object storage bucket is required')
    if (typeof accessKeyId !== 'string' || accessKeyId === '' || /[\0-\x1f\x7f]/.test(accessKeyId)) throw new Error('An access key id is required')
    if (typeof secretAccessKey !== 'string' || secretAccessKey === '') throw new Error('An access key secret is required')
    this.type = type
    this.label = type.toUpperCase()
    this.virtualHosted = type === 'oss' || type === 'cos'
    const bucketAlreadyInHost = parsed.hostname.toLowerCase().startsWith(`${normalizedBucket}.`)
    this.host = this.virtualHosted && !bucketAlreadyInHost ? `${normalizedBucket}.${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}` : parsed.host
    this.endpoint = `${parsed.protocol}//${this.host}`
    this.basePath = parsed.basePath
    this.region = typeof region === 'string' && region.trim() !== '' ? region.trim() : defaultObjectStorageRegion(type)
    this.bucket = normalizedBucket
    this.prefix = normalizeObjectStoragePrefix(prefix)
    this.accessKeyId = accessKeyId
    this.secretAccessKey = secretAccessKey
  }
  bucketPath() { return this.virtualHosted ? `${this.basePath}/` : `${this.basePath}/${awsUriEncode(this.bucket)}` }
  objectPath(key) {
    const segments = this.virtualHosted ? [] : [this.bucket]
    if (this.prefix !== '') segments.push(...this.prefix.split('/'))
    if (key !== '') segments.push(...key.split('/'))
    return `${this.basePath}/${segments.map(awsUriEncode).join('/')}`
  }
  async request(method, path, { query = [], body, ifMatch, ifNoneMatch } = {}) {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/octet-stream'
    if (this.type !== 'oss') {
      if (ifMatch !== undefined) headers['if-match'] = ifMatch
      if (ifNoneMatch === true) headers['if-none-match'] = '*'
    }
    const payloadHash = awsSha256Hex(body ?? Buffer.alloc(0))
    const signature = signAwsV4({ method, host: this.host, path, query, headers, payloadHash, region: this.region, service: 's3', accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey })
    const queryString = awsCanonicalQuery(query)
    const url = `${this.endpoint}${path}${queryString === '' ? '' : `?${queryString}`}`
    const requestHeaders = { ...headers, 'x-amz-date': signature.amzDate, 'x-amz-content-sha256': signature.payloadHash, authorization: signature.authorization }
    return s3Fetch(url, { method, headers: requestHeaders, body, redirect: 'manual' })
  }
  async put(key, body, { ifMatch, ifNoneMatch = false } = {}) {
    const response = await this.request('PUT', this.objectPath(key), { body, ifMatch, ifNoneMatch })
    if ((response.status === 409 || response.status === 412) && (ifMatch !== undefined || ifNoneMatch)) throw new Error('Remote snapshot changed during sync. Refresh and retry.')
    if (!response.ok) throw new Error(`${this.label} PUT ${key} failed: HTTP ${response.status}`)
    return response.headers.get('etag') ?? undefined
  }
  async getWithMeta(key) {
    const response = await this.request('GET', this.objectPath(key))
    if (!response.ok) throw new Error(`${this.label} GET ${key} failed: HTTP ${response.status}`)
    return { body: Buffer.from(await response.arrayBuffer()), etag: response.headers.get('etag') ?? undefined }
  }
  async get(key) { return (await this.getWithMeta(key)).body }
  async remove(key) {
    const response = await this.request('DELETE', this.objectPath(key))
    // S3 DELETE is idempotent: 204 on success, 204/404 on already-gone.
    if (!response.ok && response.status !== 404) throw new Error(`${this.label} DELETE ${key} failed: HTTP ${response.status}`)
  }
  async probe() {
    const response = await this.request('HEAD', this.bucketPath())
    if (response.ok) return
    if (response.status === 301 || response.status === 307 || response.status === 308) {
      const region = response.headers.get('x-amz-bucket-region')
      throw new Error(`${this.label} redirected${region !== null && region !== '' ? ` to region ${region}` : ''}; check the endpoint and region`)
    }
    if (response.status === 404) throw new Error(`${this.label} bucket not found: ${this.bucket}`)
    if (response.status === 403) throw new Error(`${this.label} access denied; check access key, secret, and bucket permissions`)
    throw new Error(`${this.label} connection failed: HTTP ${response.status}`)
  }
}

function gistObjectFileName(key) { return `${GIST_FILE_PREFIX}${hash(Buffer.from(key)).slice(0, 40)}.b64` }
function githubApiHeaders(token, json = false, extra = {}) {
  return { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cloud-sync', authorization: `Bearer ${token}`, 'x-github-api-version': '2026-03-10', ...(json ? { 'content-type': 'application/json' } : {}), ...extra }
}

function githubGistRetryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(Math.ceil(retryAfter * 1000), 10_000)
  return 350 * (2 ** attempt)
}

async function githubGistFetch(url, { token, method = 'GET', body, headers = {} } = {}) {
  for (let attempt = 0; attempt < GITHUB_GIST_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch(url, { method, headers: githubApiHeaders(token, body !== undefined, headers), body, signal: controller.signal })
      if (response.ok) return response
      const transient = response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504
      if (transient && attempt + 1 < GITHUB_GIST_MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, githubGistRetryDelay(response, attempt)))
        continue
      }
      let detail = ''
      try { detail = (await response.json())?.message ?? '' } catch {}
      if (transient) throw new Error(`GitHub Gist is temporarily unavailable after ${attempt + 1} attempts (HTTP ${response.status}). Please try again shortly.`)
      throw new Error(`GitHub Gist ${method} request failed: HTTP ${response.status}${detail === '' ? '' : ` (${detail})`}`)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('GitHub Gist request timed out after 30 seconds')
      if (error instanceof TypeError && attempt + 1 < GITHUB_GIST_MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 350 * (2 ** attempt)))
        continue
      }
      throw error
    } finally { clearTimeout(timer) }
  }
  throw new Error('GitHub Gist request failed unexpectedly')
}

class GistProvider {
  constructor({ gistId = '', token = '' }) {
    if (typeof token !== 'string' || token === '') throw new Error('A GitHub token with Gist access is required')
    this.gistId = gistId
    this.token = token
  }
  endpoint(path = '') { return `${GITHUB_API_URL}${path}` }
  async getGist() {
    if (this.gistId === '') throw new Error('GitHub Gist is not connected')
    const response = await githubGistFetch(this.endpoint(`/gists/${encodeURIComponent(this.gistId)}`), { token: this.token })
    return { gist: await response.json(), etag: response.headers.get('etag') ?? undefined }
  }
  async update(files, { ifMatch } = {}) {
    // GitHub returns weak ETags for Gists. HTTP forbids using those with
    // If-Match, and GitHub rejects the resulting PATCH with HTTP 400.
    const canUseIfMatch = typeof ifMatch === 'string' && !ifMatch.startsWith('W/')
    const response = await githubGistFetch(this.endpoint(`/gists/${encodeURIComponent(this.gistId)}`), {
      token: this.token,
      method: 'PATCH',
      body: JSON.stringify({ files }),
      headers: canUseIfMatch ? { 'if-match': ifMatch } : {},
    })
    return response.headers.get('etag') ?? undefined
  }
  async put(key, body, { ifMatch, ifNoneMatch = false } = {}) {
    if (!Buffer.isBuffer(body)) body = Buffer.from(body)
    if (body.length > GIST_MAX_OBJECT_BYTES) throw new Error(`GitHub Gist only supports Cloud Sync objects up to ${Math.floor(GIST_MAX_OBJECT_BYTES / 1024)} KiB. Disable local source archives or use WebDAV/S3 for this profile.`)
    const name = gistObjectFileName(key)
    const { gist, etag } = await this.getGist()
    // A Gist has one ETag for every file. Source archives written earlier in
    // this same synchronization advance it, so only use the freshly-read ETag.
    if (ifNoneMatch && gist.files?.[name] !== undefined) throw new Error('Remote snapshot changed during sync. Refresh and retry.')
    if (gist.files?.[name] === undefined && Object.keys(gist.files ?? {}).length >= GIST_MAX_FILES) throw new Error(`GitHub Gist file limit reached (${GIST_MAX_FILES}). Remove old source archives or use WebDAV/S3.`)
    return this.update({ [name]: { content: body.toString('base64') } }, { ifMatch: etag })
  }
  /**
   * 批量上传：一次 PATCH 携带多个文件。Gist 的 ETag 每次 PATCH 都会变，
   * 因此并发 PATCH 必然互相覆盖（if-match 冲突）——只能串行批次，
   * 但一个批次内多个文件共享同一次 getGist + 一次 PATCH。
   * 每个对象的 700KB 单对象上限在调用方逐项校验。
   */
  async putMany(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return
    for (const entry of entries) {
      if (!Buffer.isBuffer(entry.body)) entry.body = Buffer.from(entry.body)
      if (entry.body.length > GIST_MAX_OBJECT_BYTES) throw new Error(`GitHub Gist only supports Cloud Sync objects up to ${Math.floor(GIST_MAX_OBJECT_BYTES / 1024)} KiB. Disable local source archives or use WebDAV/S3 for this profile.`)
    }
    const { gist, etag } = await this.getGist()
    const files = {}
    for (const entry of entries) {
      const name = gistObjectFileName(entry.key)
      if (gist.files?.[name] === undefined && Object.keys(files).length + Object.keys(gist.files ?? {}).length >= GIST_MAX_FILES) throw new Error(`GitHub Gist file limit reached (${GIST_MAX_FILES}). Remove old source archives or use WebDAV/S3.`)
      files[name] = { content: entry.body.toString('base64') }
    }
    await this.update(files, { ifMatch: etag })
  }
  /**
   * 批量删除：一次 PATCH 携带多个 { name: null }。
   * 与单文件 remove 同样的存在性过滤：GitHub 对删除不存在的文件返回
   * HTTP 422（实测），索引里的历史 key 可能指向已被外部清理的文件，
   * 必须只提交远端确实存在的键；全部不存在则跳过 PATCH。
   */
  async removeMany(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return
    const { gist, etag } = await this.getGist()
    const files = {}
    let hasDelete = false
    for (const key of keys) {
      const name = gistObjectFileName(key)
      if (gist.files?.[name] === undefined) continue
      files[name] = null
      hasDelete = true
    }
    if (!hasDelete) return
    await this.update(files, { ifMatch: etag })
  }
  async getWithMeta(key) {
    const name = gistObjectFileName(key)
    const { gist, etag } = await this.getGist()
    const file = gist.files?.[name]
    if (file === undefined) throw new Error(`GitHub Gist GET ${key} failed: HTTP 404`)
    let content = file.content
    if (file.truncated === true) {
      if (typeof file.raw_url !== 'string' || !file.raw_url.startsWith('https://')) throw new Error(`GitHub Gist GET ${key} failed: truncated file cannot be retrieved safely`)
      const raw = await githubGistFetch(file.raw_url, { token: this.token })
      content = await raw.text()
    }
    if (typeof content !== 'string') throw new Error(`GitHub Gist GET ${key} returned invalid content`)
    return { body: Buffer.from(content, 'base64'), etag }
  }
  /** 批量读取：一次 getGist 取回多个文件内容（Gist 单次响应含全部文件）。 */
  async getMany(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return new Map()
    const { gist } = await this.getGist()
    const out = new Map()
    for (const key of keys) {
      const name = gistObjectFileName(key)
      const file = gist.files?.[name]
      if (file === undefined) throw new Error(`GitHub Gist GET ${key} failed: HTTP 404`)
      let content = file.content
      if (file.truncated === true) {
        if (typeof file.raw_url !== 'string' || !file.raw_url.startsWith('https://')) throw new Error(`GitHub Gist GET ${key} failed: truncated file cannot be retrieved safely`)
        const raw = await githubGistFetch(file.raw_url, { token: this.token })
        content = await raw.text()
      }
      if (typeof content !== 'string') throw new Error(`GitHub Gist GET ${key} returned invalid content`)
      out.set(key, Buffer.from(content, 'base64'))
    }
    return out
  }
  async get(key) { return (await this.getWithMeta(key)).body }
  async remove(key) {
    const name = gistObjectFileName(key)
    const { gist, etag } = await this.getGist()
    if (gist.files?.[name] === undefined) return
    await this.update({ [name]: null }, { ifMatch: etag })
  }
  async probe() {
    await githubGistFetch(this.endpoint('/user'), { token: this.token })
    if (this.gistId === '') {
      const response = await githubGistFetch(this.endpoint('/gists'), {
        token: this.token,
        method: 'POST',
        body: JSON.stringify({ description: 'DSH Cloud Sync (managed)', public: false, files: { [GIST_MARKER_FILE]: { content: `${JSON.stringify({ schema: SCHEMA, provider: 'github-gist' })}\n` } } }),
      })
      const gist = await response.json()
      if (typeof gist?.id !== 'string' || gist.id === '') throw new Error('GitHub did not return the created Gist ID')
      this.gistId = gist.id
      return
    }
    const { gist, etag } = await this.getGist()
    if (gist.files?.[GIST_MARKER_FILE] !== undefined) return
    if (Object.keys(gist.files ?? {}).length !== 0) throw new Error('The selected Gist is not a DSH Cloud Sync Gist. Create a new Gist or select an empty one.')
    await this.update({ [GIST_MARKER_FILE]: { content: `${JSON.stringify({ schema: SCHEMA, provider: 'github-gist' })}\n` } }, { ifMatch: etag })
  }
}

function encryptedKey(key) { return key.startsWith('snapshots/') || key.startsWith('sources/') }
function encryptedEnvelope(body, passphrase) {
  const salt = randomBytes(16)
  const key = scryptSync(passphrase, salt, 32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(body), cipher.final()])
  return Buffer.from(JSON.stringify({ format: ENCRYPTED_FORMAT, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }))
}
function decryptEnvelope(body, passphrase) {
  let value
  try { value = JSON.parse(body.toString('utf8')) } catch { return body }
  if (value?.format !== ENCRYPTED_FORMAT) return body
  if (typeof value.salt !== 'string' || typeof value.iv !== 'string' || typeof value.tag !== 'string' || typeof value.data !== 'string') throw new Error('Encrypted Cloud Sync object is invalid')
  try {
    const key = scryptSync(passphrase, Buffer.from(value.salt, 'base64'), 32)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()])
  } catch { throw new Error('Cloud Sync passphrase is incorrect or the encrypted data was modified') }
}
class EncryptedProvider {
  constructor(provider, passphrase) { this.provider = provider; this.passphrase = passphrase }
  async put(key, body, options) { return this.provider.put(key, encryptedKey(key) ? encryptedEnvelope(body, this.passphrase) : body, options) }
  async getWithMeta(key) { const remote = await this.provider.getWithMeta(key); return { ...remote, body: encryptedKey(key) ? decryptEnvelope(remote.body, this.passphrase) : remote.body } }
  async get(key) { return (await this.getWithMeta(key)).body }
  async remove(key) { return this.provider.remove(key) }
  async probe() { return this.provider.probe() }
}

export function providerFrom(settings, home = dshHome()) {
  let provider
  if (settings.provider.type === 'webdav') provider = new WebDavProvider(settings.provider)
  else if (isObjectStorageType(settings.provider.type)) provider = new S3Provider(settings.provider)
  else if (settings.provider.type === 'gist') provider = new GistProvider(settings.provider)
  else throw new Error(`Unsupported provider: ${settings.provider.type}`)
  if (settings.encryption?.enabled !== true) return provider
  const passphrase = encryptionKeys.get(resolve(home))
  if (passphrase === undefined) throw new Error('云同步已启用客户端加密，请先输入同步口令。')
  return new EncryptedProvider(provider, passphrase)
}

export async function connectProvider(settings, { home = dshHome() } = {}) {
  const type = settings?.provider?.type
  const next = type === 'webdav'
    ? await normalizeWebDavSettings(settings, home)
    : isObjectStorageType(type)
      ? await normalizeObjectStorageSettings(settings, home)
      : type === 'gist'
        ? await normalizeGistSettings(settings, home)
      : (() => { throw new Error('A sync provider is required') })()
  const provider = providerFrom({ ...next, encryption: { enabled: false } }, home)
  await provider.probe()
  if (provider instanceof GistProvider) next.provider.gistId = provider.gistId
  next.lastConnectedAt = new Date().toISOString()
  await persistSettings(next, home)
  return publicSettings(next, home)
}

export async function connectWebDav(settings, { home = dshHome() } = {}) {
  return connectProvider({ ...settings, provider: { ...settings.provider, type: 'webdav' } }, { home })
}

function githubOAuthClientId() { return process.env.DSH_CLOUD_SYNC_GITHUB_CLIENT_ID?.trim() || DEFAULT_GITHUB_OAUTH_CLIENT_ID }

async function githubDeviceFetch(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'dsh-cloud-sync' },
    body: new URLSearchParams(params),
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(value?.error_description || value?.error || `GitHub authorization request failed: HTTP ${response.status}`)
  return value
}

export function getGithubDeviceAuthorizationStatus() { return { configured: githubOAuthClientId() !== '' } }

export async function startGithubDeviceAuthorization({ home = dshHome() } = {}) {
  const clientId = githubOAuthClientId()
  if (clientId === '') throw new Error('GitHub device authorization is not configured in this build. Set DSH_CLOUD_SYNC_GITHUB_CLIENT_ID when packaging the plugin, or use a GitHub token.')
  const value = await githubDeviceFetch(GITHUB_DEVICE_CODE_URL, { client_id: clientId, scope: 'gist' })
  if (typeof value.device_code !== 'string' || typeof value.user_code !== 'string' || typeof value.verification_uri !== 'string' || !Number.isFinite(value.expires_in)) throw new Error('GitHub returned an invalid device authorization response')
  const requestId = randomUUID()
  githubDeviceAuthorizations.set(requestId, { home: resolve(home), clientId, deviceCode: value.device_code, intervalSeconds: Math.max(5, Number(value.interval) || 5), lastPollAt: 0, expiresAt: Date.now() + Number(value.expires_in) * 1000 })
  return { requestId, userCode: value.user_code, verificationUri: value.verification_uri, verificationUriComplete: typeof value.verification_uri_complete === 'string' ? value.verification_uri_complete : undefined, intervalSeconds: Math.max(5, Number(value.interval) || 5), expiresIn: Number(value.expires_in) }
}

export async function pollGithubDeviceAuthorization({ requestId } = {}, { home = dshHome() } = {}) {
  if (typeof requestId !== 'string') throw new Error('GitHub authorization request is invalid')
  const request = githubDeviceAuthorizations.get(requestId)
  if (request === undefined || request.home !== resolve(home)) throw new Error('GitHub authorization request has expired. Start again.')
  if (Date.now() >= request.expiresAt) { githubDeviceAuthorizations.delete(requestId); throw new Error('GitHub authorization code expired. Start again.') }
  if (Date.now() - request.lastPollAt < request.intervalSeconds * 1000) return { status: 'pending', intervalSeconds: request.intervalSeconds }
  request.lastPollAt = Date.now()
  const value = await githubDeviceFetch(GITHUB_DEVICE_TOKEN_URL, { client_id: request.clientId, device_code: request.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
  if (value.error === 'authorization_pending') return { status: 'pending', intervalSeconds: request.intervalSeconds }
  if (value.error === 'slow_down') { request.intervalSeconds += 5; return { status: 'pending', intervalSeconds: request.intervalSeconds }
  }
  if (typeof value.access_token !== 'string' || value.access_token === '') { githubDeviceAuthorizations.delete(requestId); throw new Error(value.error_description || 'GitHub did not return an access token') }
  githubDeviceAuthorizations.delete(requestId)
  const settings = await connectProvider({ provider: { type: 'gist', gistId: '', token: value.access_token } }, { home })
  return { status: 'connected', settings }
}

export async function clearSyncProvider({ home = dshHome() } = {}) {
  const settings = await loadSettings(home)
  const next = { provider: { type: 'none' }, savedProviders: settings.savedProviders ?? {}, syncPolicy: normalizeSyncPolicy(settings.syncPolicy), lastConnectedAt: undefined }
  await persistSettings(next, home)
  encryptionKeys.delete(resolve(home))
  automaticSyncRuns.delete(resolve(home))
  return publicSettings(next, home)
}

async function profileFiles(name, home) {
  const dir = profileDir(name, home)
  const files = {}
  for (const filename of CONFIG_FILES) {
    const path = join(dir, filename)
    if (existsSync(path)) {
      const data = await readFile(path)
      files[filename] = encode(filename === 'pnpm-workspace.yaml' ? Buffer.from(sanitizePnpmWorkspace(data.toString('utf8'))) : filename === '.npmrc' ? Buffer.from(sanitizeNpmrc(data.toString('utf8'))) : filename === 'pnpm-lock.yaml' ? Buffer.from(sanitizePnpmLock(data.toString('utf8'))) : filename === 'cordis.patch.yml' ? Buffer.from(sanitizeCordisPatch(data.toString('utf8'))) : data)
    }
  }
  const hotDir = join(dir, '.dsh-market')
  if (existsSync(hotDir)) {
    for (const entry of await readdir(hotDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.yml')) files[`.dsh-market/${entry.name}`] = encode(await readFile(join(hotDir, entry.name)))
    }
  }
  if (files['package.json'] === undefined) throw new Error(`Profile ${name} has no package.json`)
  return files
}

async function listProfiles(home) {
  const directory = join(home, 'profiles')
  if (!existsSync(directory)) return []
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory() && entry.name !== 'node_modules' && existsSync(join(directory, entry.name, 'package.json'))).map(entry => entry.name)
}

async function loadSourceCatalog(home) { return readJson(join(syncRoot(home), 'sources.json'), { schema: SCHEMA, sources: {} }) }
async function saveSourceCatalog(catalog, home) { await writeJson(join(syncRoot(home), 'sources.json'), catalog) }

function localDependencyNames(manifest) {
  return Object.entries(manifest.dependencies ?? {}).filter(([name, spec]) => name !== SELF_PACKAGE && typeof spec === 'string' && /^(?:link:|file:|\.|[A-Za-z]:[\\/])/.test(spec)).map(([name]) => name)
}

function withoutSelfDependency(files) {
  const next = { ...files }
  const manifest = JSON.parse(decode(next['package.json']).toString('utf8'))
  if (manifest.dependencies?.[SELF_PACKAGE] !== undefined) delete manifest.dependencies[SELF_PACKAGE]
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: bundles.filter(name => name !== SELF_PACKAGE) } }
  next['package.json'] = encodeJson(manifest)
  return next
}

/**
 * 快照消毒（用户全局规则·设备路径动态识别）：profile 文本配置里的本机个人路径
 * （os.homedir() 前缀 + 后续内容）一律替换为 `~/<rest>` 占位，绝不把设备专属
 * 路径原样推上远端备份。只对文本类配置文件生效；二进制内容原样保留。
 * 还原侧 expandPersonalPaths() 在目标机上把 `~/` 展开为对方自己的 home。
 * 已知边界：路径中恰好存在的未转义引号会提前终止匹配（真实 JSON 必转义，不受影响）。
 */
const PERSONAL_PATH_TEXT_FILES = /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|cordis\.patch\.yml|.*\.ya?ml|.*\.json|.*\.txt|.*\.md)$/u
const PERSONAL_PATH_TRAILER = '[^"\\s\\\\]*'

function homePathRegexes() {
  const home = homedir()
  const variants = new Set([home, home.replaceAll('\\', '/')])
  const regexes = []
  for (const variant of variants) {
    if (variant.length <= 1) continue
    const trimmed = variant.replace(/[/\\]$/u, '')
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    regexes.push(new RegExp(`(${escaped})([/\\\\]|\\\\\\\\)${PERSONAL_PATH_TRAILER}`, 'gu'))
  }
  return regexes
}

/** 消毒：把 <home>/<rest>（两种分隔符）换成 `~/<rest>` 占位（恒带尾斜杠前缀，便于还原侧精确识别）。 */
export function sanitizePersonalPaths(text) {
  let next = text
  for (const regex of homePathRegexes()) {
    next = next.replace(regex, (match, prefix, separator) => {
      const rest = match.slice(prefix.length + separator.length).replace(/^[/\\]+/u, '')
      return `~/${rest}`
    })
  }
  return next
}

function sanitizeProfilePersonalPaths(files) {
  const forward = homedir().replaceAll('\\', '/')
  const next = {}
  for (const [name, encoded] of Object.entries(files)) {
    if (!PERSONAL_PATH_TEXT_FILES.test(name)) { next[name] = encoded; continue }
    const raw = decode(encoded).toString('utf8')
    if (!raw.includes(homedir()) && !raw.includes(forward)) { next[name] = encoded; continue }
    next[name] = Buffer.from(sanitizePersonalPaths(raw), 'utf8').toString('base64')
  }
  return next
}

/** 展开（消毒的逆操作）：把 `~/<rest>` 占位解析到目标机自己的 home。 */
export function expandPersonalPaths(text) {
  const forward = homedir().replaceAll('\\', '/')
  return text.replace(/~(\/[^"'\\s]*)/g, (_match, rest) => `${forward}${rest}`)
}

/**
 * 还原写盘时的单文件处理：既有 sanitize（pnpm/npmrc/lock/cordis.patch）之外，
 * 文本类配置再展开 `~/` 占位为还原机 home（消毒的逆操作）。非文本文件原样解码。
 */
function profileRestoreData(name, content) {
  const isText = PERSONAL_PATH_TEXT_FILES.test(name)
  const text = isText ? decode(content).toString('utf8') : undefined
  if (name === 'pnpm-workspace.yaml') return Buffer.from(sanitizePnpmWorkspace(text))
  if (name === '.npmrc') return Buffer.from(sanitizeNpmrc(text))
  if (name === 'pnpm-lock.yaml') return Buffer.from(sanitizePnpmLock(text))
  if (name === 'cordis.patch.yml') return Buffer.from(expandPersonalPaths(sanitizeCordisPatch(text)))
  if (isText) return Buffer.from(expandPersonalPaths(text))
  return decode(content)
}

export async function createSnapshot({ home = dshHome(), profiles } = {}) {
  const names = profiles ?? await listProfiles(home)
  const catalog = await loadSourceCatalog(home)
  const profileData = []
  for (const name of names) {
    const files = sanitizeProfilePersonalPaths(withoutSelfDependency(await profileFiles(name, home)))
    const manifest = JSON.parse(decode(files['package.json']).toString('utf8'))
    profileData.push({ name, files, localDependencies: localDependencyNames(manifest) })
  }
  const snapshot = { schema: SCHEMA, createdAt: new Date().toISOString(), profiles: profileData, sources: Object.values(catalog.sources) }
  const encoded = gzipSync(Buffer.from(JSON.stringify(snapshot)))
  return { snapshot, encoded, sha256: hash(encoded), byteLength: encoded.length }
}

export async function pushSnapshot({ home = dshHome(), profiles } = {}) {
  const missingLocalSources = await backupReachableLocalSources({ home, profiles })
  const settings = await loadSettings(home)
  const provider = providerFrom(settings, home)
  const { snapshot, encoded, sha256, byteLength } = await createSnapshot({ home, profiles })
  for (const source of snapshot.sources) {
    const local = join(syncRoot(home), 'archives', source.archive)
    if (!existsSync(local)) throw new Error(`Local source archive is missing: ${source.name}`)
    await provider.put(source.objectKey, await readFile(local))
  }
  await provider.put('snapshots/latest.json.gz', encoded)
  return { createdAt: snapshot.createdAt, profiles: snapshot.profiles.map(profile => profile.name), sources: snapshot.sources.map(source => source.name), missingLocalSources, sha256, byteLength, provider: publicSettings(settings, home).provider }
}

function profileManifest(profile) {
  const encodedManifest = profile.files?.['package.json']
  if (typeof encodedManifest !== 'string') throw new Error(`Snapshot profile ${profile.name} has no package.json`)
  return JSON.parse(decode(encodedManifest).toString('utf8'))
}

function encodeJson(value) { return encode(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)) }
function equalFile(left, right) { return left === right }
function conflictChoice(resolution) { return resolution === 'cloud' || resolution === 'local' ? resolution : undefined }

function mergeProfile(cloud, local, resolution, conflicts) {
  if (cloud === undefined) return local
  if (local === undefined) return cloud
  const choice = conflictChoice(resolution)
  const cloudManifest = profileManifest(cloud)
  const localManifest = profileManifest(local)
  const mergedManifest = { ...cloudManifest, ...localManifest }
  const cloudDependencies = cloudManifest.dependencies ?? {}
  const localDependencies = localManifest.dependencies ?? {}
  const dependencies = {}
  for (const name of new Set([...Object.keys(cloudDependencies), ...Object.keys(localDependencies)])) {
    const cloudSpec = cloudDependencies[name]
    const localSpec = localDependencies[name]
    if (cloudSpec === undefined || localSpec === undefined || cloudSpec === localSpec) dependencies[name] = cloudSpec ?? localSpec
    else if (isLocalSpec(cloudSpec) && isLocalSpec(localSpec)) dependencies[name] = cloudSpec
    else if (choice !== undefined) dependencies[name] = choice === 'cloud' ? cloudSpec : localSpec
    else conflicts.push({ kind: 'dependency', profile: cloud.name, key: name, cloud: cloudSpec, local: localSpec })
  }
  mergedManifest.dependencies = dependencies
  const cloudBundles = Array.isArray(cloudManifest.dsh?.profile?.bundles) ? cloudManifest.dsh.profile.bundles : []
  const localBundles = Array.isArray(localManifest.dsh?.profile?.bundles) ? localManifest.dsh.profile.bundles : []
  mergedManifest.dsh = { ...(cloudManifest.dsh ?? {}), ...(localManifest.dsh ?? {}), profile: { ...(cloudManifest.dsh?.profile ?? {}), ...(localManifest.dsh?.profile ?? {}), bundles: [...new Set([...cloudBundles, ...localBundles])].filter(name => dependencies[name] !== undefined || name.startsWith('@deepseek-ai/dsh-')) } }
  const files = {}
  for (const name of new Set([...Object.keys(cloud.files ?? {}), ...Object.keys(local.files ?? {})])) {
    if (name === 'package.json') continue
    const cloudFile = cloud.files?.[name]
    const localFile = local.files?.[name]
    if (cloudFile === undefined || localFile === undefined || equalFile(cloudFile, localFile)) files[name] = cloudFile ?? localFile
    else if (name === 'pnpm-lock.yaml') files[name] = choice === 'local' ? localFile : cloudFile
    else if (choice !== undefined) files[name] = choice === 'cloud' ? cloudFile : localFile
    else conflicts.push({ kind: 'file', profile: cloud.name, key: name, cloud: 'changed', local: 'changed' })
  }
  files['package.json'] = encodeJson(mergedManifest)
  return { name: cloud.name, files, localDependencies: localDependencyNames(mergedManifest) }
}

function mergeSources(cloudSources, localSources, resolution, conflicts) {
  const choice = conflictChoice(resolution)
  const merged = []
  for (const name of new Set([...cloudSources.map(source => source.name), ...localSources.map(source => source.name)])) {
    const cloud = cloudSources.find(source => source.name === name)
    const local = localSources.find(source => source.name === name)
    if (cloud === undefined || local === undefined || cloud.sha256 === local.sha256) merged.push(cloud ?? local)
    else if (choice !== undefined) merged.push(choice === 'cloud' ? cloud : local)
    else conflicts.push({ kind: 'source', key: name, cloud: cloud.version, local: local.version })
  }
  return merged
}

function mergeSnapshots(cloud, local, resolution) {
  const conflicts = []
  const profiles = []
  for (const name of new Set([...cloud.profiles.map(profile => profile.name), ...local.profiles.map(profile => profile.name)])) {
    profiles.push(mergeProfile(cloud.profiles.find(profile => profile.name === name), local.profiles.find(profile => profile.name === name), resolution, conflicts))
  }
  const sources = mergeSources(cloud.sources, local.sources, resolution, conflicts)
  return { conflicts, snapshot: { schema: SCHEMA, createdAt: new Date().toISOString(), profiles, sources } }
}

function applySelectedItems(cloud, local, selectedItems) {
  if (!Array.isArray(selectedItems)) return local
  const selected = new Set(selectedItems)
  const profiles = local.profiles.map(profile => {
    const cloudProfile = cloud?.profiles.find(item => item.name === profile.name)
    if (cloudProfile === undefined) return profile
    const localManifest = profileManifest(profile)
    const cloudManifest = profileManifest(cloudProfile)
    const dependencies = { ...(localManifest.dependencies ?? {}) }
    for (const name of new Set([...Object.keys(localManifest.dependencies ?? {}), ...Object.keys(cloudManifest.dependencies ?? {})])) {
      const id = `dependency:${profile.name}:${name}`
      if (selected.has(id) || dependencies[name] === cloudManifest.dependencies?.[name]) continue
      if (cloudManifest.dependencies?.[name] === undefined) delete dependencies[name]
      else dependencies[name] = cloudManifest.dependencies[name]
    }
    const manifest = { ...localManifest, dependencies }
    const files = { ...profile.files, 'package.json': encodeJson(manifest) }
    for (const name of new Set([...Object.keys(profile.files ?? {}), ...Object.keys(cloudProfile.files ?? {})])) {
      if (name === 'package.json') continue
      const id = `config:${profile.name}:${name}`
      if (selected.has(id) || files[name] === cloudProfile.files?.[name]) continue
      if (cloudProfile.files?.[name] === undefined) delete files[name]
      else files[name] = cloudProfile.files[name]
    }
    return { ...profile, files, localDependencies: localDependencyNames(manifest) }
  })
  return { ...local, profiles }
}

async function putMergedSnapshot(provider, snapshot, home, etag) {
  for (const source of snapshot.sources) {
    const archive = join(syncRoot(home), 'archives', source.archive)
    // Archives already in WebDAV are retained. A locally-created archive is
    // uploaded before the merged snapshot references it.
    if (existsSync(archive)) await provider.put(source.objectKey, await readFile(archive))
  }
  const encoded = gzipSync(Buffer.from(JSON.stringify(snapshot)))
  await provider.put('snapshots/latest.json.gz', encoded, { ifMatch: etag })
  return { createdAt: snapshot.createdAt, profiles: snapshot.profiles.map(profile => profile.name), sources: snapshot.sources.map(source => source.name), sha256: hash(encoded), byteLength: encoded.length }
}

export async function synchronizeSnapshots({ home = dshHome(), strategy, resolveConflicts, selectedItems } = {}) {
  const settings = await deviceSettings(home)
  const policy = normalizeSyncPolicy(strategy ?? settings.syncPolicy)
  const pnpmShims = []
  for (const profile of await listProfiles(home)) {
    await repairProfilePnpmConfig(profileDir(profile, home))
    const shim = await ensureProfilePnpmShim({ profile, home })
    if (shim !== undefined) pnpmShims.push(shim)
  }
  if (policy === 'cloud') {
    const restored = await pullSnapshot({ home, apply: true })
    return { strategy: policy, direction: 'downloaded', pnpmShims, ...restored }
  }
  const sourcesEnabled = settings.provider?.type !== 'gist' && settings.syncScope?.sources !== false
  const missingLocalSources = sourcesEnabled ? await backupReachableLocalSources({ home }) : []
  let local = await createSnapshot({ home })
  if (!sourcesEnabled) {
    local = { ...local, snapshot: { ...local.snapshot, sources: [] } }
    local.encoded = gzipSync(Buffer.from(JSON.stringify(local.snapshot)))
  }
  const provider = providerFrom(settings, home)
  let cloud; let cloudEtag
  try {
    const remote = await loadRemoteSnapshotData(provider)
    cloud = remote.snapshot
    cloudEtag = remote.etag
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('HTTP 404')) throw error
  }
  if (cloud === undefined || policy === 'local') {
    for (const source of local.snapshot.sources) await provider.put(source.objectKey, await readFile(join(syncRoot(home), 'archives', source.archive)))
    await provider.put('snapshots/latest.json.gz', local.encoded, { ifMatch: cloudEtag, ifNoneMatch: cloud === undefined })
    const history = await archiveHistory(provider, local.snapshot, local.encoded, { deviceId: settings.deviceId, deviceName: settings.deviceName, limit: settings.historyLimit, changes: cloud === undefined ? diffSnapshots({ profiles: [], sources: [] }, local.snapshot) : diffSnapshots(cloud, local.snapshot) })
    return { strategy: policy, direction: 'uploaded', pnpmShims, missingLocalSources, history, createdAt: local.snapshot.createdAt, profiles: local.snapshot.profiles.map(profile => profile.name), sources: local.snapshot.sources.map(source => source.name), sha256: local.sha256, byteLength: local.byteLength }
  }
  local = { ...local, snapshot: applySelectedItems(cloud, local.snapshot, selectedItems), encoded: undefined }
  if (!sourcesEnabled) local.snapshot.sources = []
  local.encoded = gzipSync(Buffer.from(JSON.stringify(local.snapshot)))
  const merged = mergeSnapshots(cloud, local.snapshot, resolveConflicts)
  if (merged.conflicts.length > 0) return { strategy: policy, direction: 'needs-choice', pnpmShims, missingLocalSources, conflicts: merged.conflicts }
  if (!sourcesEnabled) merged.snapshot.sources = []
  const result = await putMergedSnapshot(provider, merged.snapshot, home, cloudEtag)
  const history = await archiveHistory(provider, merged.snapshot, gzipSync(Buffer.from(JSON.stringify(merged.snapshot))), { deviceId: settings.deviceId, deviceName: settings.deviceName, limit: settings.historyLimit, changes: diffSnapshots(cloud, merged.snapshot) })
  return { strategy: policy, direction: 'merged', pnpmShims, missingLocalSources, history, ...result }
}

function ignorePatternMatches(pattern, name, path) {
  if (pattern === name || pattern === path) return true
  const target = pattern.includes('/') ? path : name
  const expression = `^${pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`
  return new RegExp(expression).test(target)
}

async function collectFiles(root, extraIgnores) {
  const ignored = [...DEFAULT_IGNORES, ...extraIgnores]
  const files = []
  let total = 0
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = relative(root, absolute).replaceAll('\\', '/')
      if (ignored.some(pattern => ignorePatternMatches(pattern, entry.name, path))) continue
      if (entry.isDirectory()) { await walk(absolute); continue }
      if (!entry.isFile()) continue
      const data = await readFile(absolute)
      total += data.length
      if (total > MAX_SOURCE_BYTES) throw new Error(`Local plugin exceeds ${MAX_SOURCE_BYTES / 1024 / 1024} MiB after exclusions`)
      files.push({ path: relative(root, absolute).replaceAll('\\', '/'), data: encode(data) })
    }
  }
  await walk(root)
  return { files, total }
}

export async function backupLocalPlugin(directory, { home = dshHome() } = {}) {
  const root = resolve(directory)
  const packagePath = join(root, 'package.json')
  if (!existsSync(packagePath)) throw new Error('Local plugin source must contain package.json')
  const manifest = await readJson(packagePath)
  if (typeof manifest.name !== 'string' || manifest.name === '') throw new Error('Local plugin package.json needs a name')
  const ignorePath = join(root, '.dshsyncignore')
  const ignores = existsSync(ignorePath) ? (await readFile(ignorePath, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#')) : []
  const { files, total } = await collectFiles(root, ignores)
  const archiveBody = Buffer.from(JSON.stringify({ schema: `${SCHEMA}/source`, packageName: manifest.name, version: manifest.version ?? '0.0.0', files }))
  const compressed = gzipSync(archiveBody)
  const sha256 = hash(compressed)
  const archive = `${sourceSlug(manifest.name)}-${sha256.slice(0, 16)}.json.gz`
  const objectKey = `sources/${archive}`
  const archivePath = join(syncRoot(home), 'archives', archive)
  await mkdir(dirname(archivePath), { recursive: true })
  await writeFile(archivePath, compressed)
  const catalog = await loadSourceCatalog(home)
  const previous = catalog.sources[manifest.name]
  catalog.sources[manifest.name] = { name: manifest.name, version: manifest.version ?? '0.0.0', archive, objectKey, sha256, sourceBytes: total, backedUpAt: new Date().toISOString() }
  await saveSourceCatalog(catalog, home)
  if (previous?.archive !== undefined && previous.archive !== archive) await rm(join(syncRoot(home), 'archives', previous.archive), { force: true })
  return catalog.sources[manifest.name]
}

async function trimLocalBackups(home) {
  const directory = join(syncRoot(home), 'backups')
  if (!existsSync(directory)) return
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse()
  await Promise.all(entries.slice(MAX_LOCAL_BACKUPS).map(name => rm(join(directory, name), { recursive: true, force: true })))
}

function localDependencyPath(spec, directory) {
  if (!isLocalSpec(spec)) return undefined
  const rawPath = spec.replace(/^(?:file:|link:)/, '')
  if (rawPath === '') return undefined
  return resolve(directory, rawPath)
}

// Capture reachable file:/link: sources during a normal Sync. This keeps the
// original machine's path out of the snapshot while making recovery automatic.
async function backupReachableLocalSources({ home, profiles }) {
  const names = profiles ?? await listProfiles(home)
  const missing = new Set()
  for (const profile of names) {
    const directory = profileDir(profile, home)
    const manifest = await readJson(join(directory, 'package.json'))
    for (const [packageName, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (packageName === SELF_PACKAGE) continue
      const source = localDependencyPath(spec, directory)
      if (source === undefined) continue
      if (!existsSync(join(source, 'package.json'))) { missing.add(packageName); continue }
      const archived = await backupLocalPlugin(source, { home })
      if (archived.name !== packageName) missing.add(packageName)
    }
  }
  return [...missing].sort((left, right) => left.localeCompare(right))
}

function validateArchiveEntry(entry) {
  if (typeof entry?.path !== 'string' || entry.path === '' || entry.path.includes('..') || entry.path.startsWith('/') || entry.path.includes('\\')) throw new Error('Source archive contains an unsafe path')
  if (typeof entry.data !== 'string') throw new Error('Source archive entry has no data')
}

async function restoreSource(provider, source, home) {
  const compressed = await provider.get(source.objectKey)
  if (hash(compressed) !== source.sha256) throw new Error(`Source checksum mismatch: ${source.name}`)
  const archive = JSON.parse(gunzipSync(compressed).toString('utf8'))
  if (archive.schema !== `${SCHEMA}/source` || archive.packageName !== source.name || !Array.isArray(archive.files)) throw new Error(`Invalid source archive: ${source.name}`)
  const target = join(syncRoot(home), 'local-plugins', sourceSlug(source.name), source.sha256.slice(0, 16))
  await rm(target, { recursive: true, force: true })
  for (const entry of archive.files) { validateArchiveEntry(entry); const output = join(target, ...entry.path.split('/')); if (!isInside(target, output)) throw new Error('Source archive escaped its target'); await mkdir(dirname(output), { recursive: true }); await writeFile(output, decode(entry.data)) }
  return target
}

function parseRemoteSnapshot(compressed) {
  const snapshot = JSON.parse(gunzipSync(compressed).toString('utf8'))
  if (snapshot.schema !== SCHEMA || !Array.isArray(snapshot.profiles) || !Array.isArray(snapshot.sources)) throw new Error('Remote snapshot has an unsupported format')
  for (const profile of snapshot.profiles) {
    if (typeof profile.files?.['pnpm-workspace.yaml'] === 'string') profile.files['pnpm-workspace.yaml'] = encode(Buffer.from(sanitizePnpmWorkspace(decode(profile.files['pnpm-workspace.yaml']).toString('utf8'))))
    if (typeof profile.files?.['.npmrc'] === 'string') profile.files['.npmrc'] = encode(Buffer.from(sanitizeNpmrc(decode(profile.files['.npmrc']).toString('utf8'))))
    if (typeof profile.files?.['pnpm-lock.yaml'] === 'string') profile.files['pnpm-lock.yaml'] = encode(Buffer.from(sanitizePnpmLock(decode(profile.files['pnpm-lock.yaml']).toString('utf8'))))
    if (typeof profile.files?.['cordis.patch.yml'] === 'string') profile.files['cordis.patch.yml'] = encode(Buffer.from(sanitizeCordisPatch(decode(profile.files['cordis.patch.yml']).toString('utf8'))))
    profile.files = withoutSelfDependency(profile.files)
  }
  return snapshot
}

async function loadRemoteSnapshotData(provider, key = 'snapshots/latest.json.gz') {
  const remote = await provider.getWithMeta(key)
  return { snapshot: parseRemoteSnapshot(remote.body), etag: remote.etag }
}

function snapshotDependencies(snapshot) {
  const dependencies = new Map()
  for (const profile of snapshot.profiles) {
    const manifest = profileManifest(profile)
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) dependencies.set(`${profile.name}:${name}`, { profile: profile.name, name, version })
  }
  return dependencies
}

function diffSnapshots(cloud, local) {
  const remote = snapshotDependencies(cloud)
  const current = snapshotDependencies(local)
  const items = []
  for (const key of new Set([...remote.keys(), ...current.keys()])) {
    const left = remote.get(key); const right = current.get(key)
    if (left?.version === right?.version) continue
    items.push({ id: `dependency:${key}`, kind: 'plugin', profile: left?.profile ?? right?.profile, name: left?.name ?? right?.name, local: right?.version, remote: left?.version, selected: true })
  }
  const cloudProfiles = new Map(cloud.profiles.map(profile => [profile.name, profile]))
  const localProfiles = new Map(local.profiles.map(profile => [profile.name, profile]))
  for (const profileName of new Set([...cloudProfiles.keys(), ...localProfiles.keys()])) {
    const cloudProfile = cloudProfiles.get(profileName)
    const localProfile = localProfiles.get(profileName)
    for (const name of new Set([...Object.keys(cloudProfile?.files ?? {}), ...Object.keys(localProfile?.files ?? {})])) {
      if (name === 'package.json' || cloudProfile?.files?.[name] === localProfile?.files?.[name]) continue
      items.push({ id: `config:${profileName}:${name}`, kind: 'config', profile: profileName, name, local: localProfile?.files?.[name] === undefined ? undefined : '已修改', remote: cloudProfile?.files?.[name] === undefined ? undefined : '已修改', selected: true })
    }
  }
  return items.sort((left, right) => `${left.profile}/${left.name}`.localeCompare(`${right.profile}/${right.name}`))
}

async function deviceSettings(home) {
  const settings = await loadSettings(home)
  if (typeof settings.deviceId === 'string' && settings.deviceId !== '') return settings
  const next = { ...settings, deviceId: randomUUID(), deviceName: settings.deviceName || process.env.COMPUTERNAME || process.env.HOSTNAME || '未命名设备' }
  await persistSettings(next, home)
  return next
}

async function loadHistoryIndex(provider) {
  try {
    const remote = await provider.getWithMeta(HISTORY_INDEX)
    const value = JSON.parse(remote.body.toString('utf8'))
    return { index: Array.isArray(value?.entries) ? value : { schema: SCHEMA, entries: [] }, etag: remote.etag }
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)).includes('HTTP 404')) return { index: { schema: SCHEMA, entries: [] }, etag: undefined }
    throw error
  }
}

async function archiveHistory(provider, snapshot, encoded, { deviceId, deviceName, changes, limit }) {
  const key = `snapshots/history/${snapshot.createdAt.replace(/[:.]/g, '-')}-${hash(encoded).slice(0, 12)}.json.gz`
  await provider.put(key, encoded)
  const { index, etag } = await loadHistoryIndex(provider)
  const previous = index.entries
  index.entries = [{ key, createdAt: snapshot.createdAt, sha256: hash(encoded), deviceId, deviceName, changes }, ...previous.filter(entry => entry.key !== key)].slice(0, normalizeHistoryLimit(limit))
  await provider.put(HISTORY_INDEX, Buffer.from(`${JSON.stringify(index, null, 2)}\n`), { ifMatch: etag, ifNoneMatch: etag === undefined })
  if (typeof provider.remove === 'function') await Promise.all(previous.filter(entry => !index.entries.some(current => current.key === entry.key)).map(entry => provider.remove(entry.key)))
  return index.entries[0]
}

export async function listSnapshotHistory({ home = dshHome() } = {}) {
  const settings = await loadSettings(home)
  return (await loadHistoryIndex(providerFrom(settings, home))).index.entries
}

/**
 * 删除一条远端快照历史：先删除归档文件本体，再从 history 索引剔除该条目。
 * key 必须命中索引现有条目（防注入任意路径删除）；索引写回沿用 etag 乐观并发。
 * 归档删除失败必须向调用方报错，不能只隐藏索引后把 GitHub 文件留在远端。
 */
export async function deleteSnapshotHistory({ snapshotKey, home = dshHome() } = {}) {
  if (typeof snapshotKey !== 'string' || snapshotKey === '') throw new Error('snapshotKey is required')
  const settings = await loadSettings(home)
  const provider = providerFrom(settings, home)
  const { index, etag } = await loadHistoryIndex(provider)
  const target = index.entries.find(entry => entry.key === snapshotKey)
  if (target === undefined) throw new Error('History entry not found. Refresh and retry.')
  if (typeof provider.remove !== 'function') throw new Error('The configured provider does not support deleting snapshot archives.')
  await provider.remove(snapshotKey)
  index.entries = index.entries.filter(entry => entry.key !== snapshotKey)
  await provider.put(HISTORY_INDEX, Buffer.from(`${JSON.stringify(index, null, 2)}\n`), { ifMatch: etag })
  return { removed: snapshotKey, remaining: index.entries.length }
}

/* ── 技能备份域（与会话/插件域键空间隔离）──────────────────────────────
 * 事实源是全局技能库 ~/.agents/skills（与 DSH profile 无关）。
 * 每个技能一个独立归档对象，键为 skills/<slug>-<sha16>.json.gz，
 * 因此可以单技能删除/还原；索引是 skills/index.json，与会话/插件的
 * snapshots/history/index.json 完全分离——删插件历史不会碰到技能备份。
 * 归档格式与插件源归档一致（{schema, skill, files[]} + gzip），
 * 复用同一套 sha256 校验与安全解包（validateArchiveEntry + isInside）。
 */

/** 技能库根目录：~/.agents/skills。测试可注入 root 隔离。 */
export function skillsRoot(root = undefined) {
  return resolve(root ?? join(homedir(), '.agents', 'skills'))
}

async function listSkillNames(root) {
  const directory = skillsRoot(root)
  if (!existsSync(directory)) return []
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort((left, right) => left.localeCompare(right))
}

async function loadSkillsIndex(provider) {
  try {
    const remote = await provider.getWithMeta(SKILLS_INDEX)
    const value = JSON.parse(remote.body.toString('utf8'))
    return { index: Array.isArray(value?.entries) ? value : { schema: SCHEMA, entries: [] }, etag: remote.etag }
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)).includes('HTTP 404')) return { index: { schema: SCHEMA, entries: [] }, etag: undefined }
    throw error
  }
}

/** 打包单个技能：目录 → 一个或多个 gzip 分片 Buffer（不落盘、不上传）。
 *  分片是动态的：先按体积粗分，再逐个校验压缩后是否超过 Gist 单对象上限，
 *  超了就对半拆，直到达标或只剩单文件（单文件仍超则响亮失败）。
 *  因此 dws 这类会继续变大的技能不需要改代码——片数随内容自动伸缩。
 */
export async function backupLocalSkill(name, { root } = {}) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid skill name: ${JSON.stringify(name)}`)
  const directory = join(skillsRoot(root), name)
  if (!existsSync(join(directory, 'SKILL.md'))) throw new Error(`Skill ${name} has no SKILL.md`)
  const { files, total } = await collectFiles(directory, [])
  const sized = files
    .map(item => ({ path: item.path, data: item.data, bytes: Buffer.from(item.data, 'base64').length }))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
  // 第一级：按原始体积贪心分组（base64 膨胀 + gzip 后仍远低于上限的余量）。
  const groups = []
  let current = []
  let currentBytes = 0
  for (const item of sized) {
    if (current.length > 0 && currentBytes + item.bytes > SKILL_PART_TARGET_BYTES) { groups.push(current); current = []; currentBytes = 0 }
    current.push(item)
    currentBytes += item.bytes
  }
  if (current.length > 0) groups.push(current)
  // 第二级：逐个校验压缩后体积，超限就对半拆（动态，不预设片数）。
  const packed = []
  const splitGroup = (items) => {
    const compressed = gzipSync(Buffer.from(JSON.stringify({ schema: `${SCHEMA}/skills`, skill: name, part: 0, parts: 1, files: items.map(item => ({ path: item.path, data: item.data })) })))
    if (compressed.length <= GIST_MAX_OBJECT_BYTES) { packed.push(items); return }
    if (items.length <= 1) throw new Error(`Skill ${name} has a file that cannot fit a Gist object after compression: ${items[0].path} (${Math.ceil(compressed.length / 1024)} KiB). Use WebDAV/S3 for this skill.`)
    const middle = Math.ceil(items.length / 2)
    splitGroup(items.slice(0, middle))
    splitGroup(items.slice(middle))
  }
  for (const group of groups) splitGroup(group)
  const parts = packed.map((items, index) => {
    const compressed = gzipSync(Buffer.from(JSON.stringify({ schema: `${SCHEMA}/skills`, skill: name, part: index + 1, parts: packed.length, files: items.map(item => ({ path: item.path, data: item.data })) })))
    return { part: index + 1, parts: packed.length, files: items, compressed, byteLength: compressed.length, sha256: hash(compressed) }
  })
  const combined = Buffer.concat(parts.map(part => part.compressed))
  return { name, sha256: hash(combined), sourceBytes: total, byteLength: combined.length, parts }
}

/** 本地技能清单（名称 + 是否含 SKILL.md）。 */
export async function listLocalSkills({ root } = {}) {
  return (await listSkillNames(root)).map(name => ({ name }))
}

/** 远端技能备份历史（skills/index.json 的 entries，新→旧）。 */
export async function listSkillBackups({ home = dshHome(), provider } = {}) {
  return (await loadSkillsIndex(provider ?? providerFrom(await loadSettings(home), home))).index.entries
}
/**
 * 推送一次技能备份：整库打包上传，索引里只落 **一条** 历史（一次备份 = 一条）。
 * 该条目内含每个技能的分片键清单，因此界面上的历史列表按次显示，与分片数量无关。
 */
export async function pushSkillBackup({ home = dshHome(), root, limit = SKILLS_LIMIT, provider } = {}) {
  const settings = await deviceSettings(home)
  const target = provider ?? providerFrom(settings, home)
  const names = await listSkillNames(root)
  const createdAt = new Date().toISOString()
  const skills = []
  // 先全部打包（本地 CPU 工作，无网络），再一次批量上传：
  // Gist 的 ETag 每次 PATCH 都会变，并发 PATCH 必冲突，所以只能串行批次，
  // 但一个批次内所有分片共享一次 getGist + 一次 PATCH（35 次往返 → 2 次）。
  const uploads = []
  for (const name of names) {
    const archive = await backupLocalSkill(name, { root })
    const keys = []
    for (const part of archive.parts) {
      const suffix = archive.parts.length === 1 ? '' : `-p${part.part}of${part.parts}`
      const key = `${SKILLS_ARCHIVE_PREFIX}/${sourceSlug(name)}-${part.sha256.slice(0, 16)}${suffix}.json.gz`
      uploads.push({ key, body: part.compressed })
      keys.push(key)
    }
    skills.push({ name, keys, parts: archive.parts.length, sha256: archive.sha256, sourceBytes: archive.sourceBytes })
  }
  // 单批请求体上限：一次 PATCH 带太多文件会被 GitHub 拒（422），按批切。
  for (let index = 0; index < uploads.length; index += SKILL_UPLOAD_BATCH) {
    const batch = uploads.slice(index, index + SKILL_UPLOAD_BATCH)
    if (typeof target.putMany === 'function') await target.putMany(batch)
    else for (const item of batch) await target.put(item.key, item.body)
  }
  // 一次备份一个索引条目：batchKey 是这次备份内所有分片键的稳定哈希。
  const batchKey = `skills/batch-${hash(`${createdAt}|${skills.map(skill => skill.sha256).join(',')}`).slice(0, 16)}`
  const entry = {
    key: batchKey, createdAt,
    deviceId: settings.deviceId, deviceName: settings.deviceName,
    skills: skills.map(skill => skill.name), total: skills.length,
    parts: skills.reduce((sum, skill) => sum + skill.parts, 0),
    sourceBytes: skills.reduce((sum, skill) => sum + skill.sourceBytes, 0),
    // 每个技能的 sha256 清单：还原时按技能逐组校验分片完整性（解压之前）。
    manifest: skills,
    keys: skills.flatMap(skill => skill.keys),
  }
  const { index, etag } = await loadSkillsIndex(target)
  const previous = index.entries
  // 旧格式条目（按技能一条，无 skills[]）按 createdAt 归并成「一次备份」：
  // 它们是同一次旧备份的产物，不折叠就会在界面上显示成 N 条历史。
  const legacy = previous.filter(item => !Array.isArray(item.skills) || item.skills.length === 0)
  const current = previous.filter(item => Array.isArray(item.skills) && item.skills.length > 0)
  const folded = []
  for (const item of legacy) {
    const at = typeof item.createdAt === 'string' ? item.createdAt : ''
    const group = folded.find(entry => entry.at === at)
    if (group === undefined) { folded.push({ at, entries: [item] }); continue }
    group.entries.push(item)
  }
  const migrated = folded.map(group => ({
    key: `skills/batch-${hash(`${group.at}|${group.entries.map(item => item.key).join(',')}`).slice(0, 16)}`,
    createdAt: group.at,
    skills: group.entries.map(item => item.name).filter(name => typeof name === 'string'),
    total: group.entries.length,
    parts: group.entries.reduce((sum, item) => sum + (item.parts ?? 1), 0),
    sourceBytes: group.entries.reduce((sum, item) => sum + (item.sourceBytes ?? 0), 0),
    keys: group.entries.flatMap(item => entryKeys(item)),
    migrated: true,
  }))
  index.entries = [entry, ...migrated, ...current.filter(item => item.key !== entry.key)].slice(0, normalizeHistoryLimit(limit))
  await target.put(SKILLS_INDEX, Buffer.from(`${JSON.stringify(index, null, 2)}\n`), { ifMatch: etag, ifNoneMatch: etag === undefined })
  // 被裁掉的历史归档本体真正删除。存活判定必须按「分片键是否仍被引用」，
  // 不能比 entry.key——折叠会换 key，比 key 会把仍被引用的分片误判成孤儿。
  if (typeof target.remove === 'function' || typeof target.removeMany === 'function') {
    const liveKeys = new Set(index.entries.flatMap(item => entryKeys(item)))
    const orphaned = [...new Set(previous.flatMap(item => entryKeys(item)))].filter(key => !liveKeys.has(key))
    if (orphaned.length > 0) {
      if (typeof target.removeMany === 'function') await target.removeMany(orphaned)
      else for (const key of orphaned) await target.remove(key)
    }
  }
  return { createdAt, skills: entry.skills, total: entry.total, parts: entry.parts, bytes: entry.sourceBytes, migrated: migrated.length }
}

/** 历史条目的全部分片键（兼容旧格式单 key 条目）。 */
function entryKeys(entry) {
  if (Array.isArray(entry.keys) && entry.keys.length > 0) return entry.keys
  return typeof entry.key === 'string' && entry.key !== '' ? [entry.key] : []
}

/**
 * 删除一次技能备份历史：先删这次备份的全部分片本体，再从索引剔除该条目。
 * 失败必须报错——不能只隐藏索引而把 GitHub 文件留在远端。
 */
export async function deleteSkillBackup({ skillKey, home = dshHome(), provider } = {}) {
  if (typeof skillKey !== 'string' || skillKey === '') throw new Error('skillKey is required')
  const target = provider ?? providerFrom(await loadSettings(home), home)
  const { index, etag } = await loadSkillsIndex(target)
  const entry = index.entries.find(item => item.key === skillKey)
  if (entry === undefined) throw new Error('Skill backup entry not found. Refresh and retry.')
  if (typeof target.remove !== 'function' && typeof target.removeMany !== 'function') throw new Error('The configured provider does not support deleting skill archives.')
  // 先删这次备份的全部分片，再剔索引条目：任何一个分片删失败都不写索引。
  const keys = entryKeys(entry)
  if (typeof target.removeMany === 'function') await target.removeMany(keys)
  else for (const key of keys) await target.remove(key)
  index.entries = index.entries.filter(item => item.key !== skillKey)
  await target.put(SKILLS_INDEX, Buffer.from(`${JSON.stringify(index, null, 2)}\n`), { ifMatch: etag })
  return { removed: skillKey, skills: entry.skills ?? [], remaining: index.entries.length }
}

/**
 * 还原技能备份（3A 安全合并）：只写本地缺失的技能，绝不覆盖已存在的目录。
 *
 * 索引条目两种形态都支持：
 *  - 新格式（按次聚合）：entry.skills[] 列出这次备份的所有技能，entry.keys[] 是全部分片键，
 *    entry.manifest[] 带每个技能的 sha256（解压前按组校验完整性）；
 *  - 旧格式（按技能一条）：entry.name 单个技能，无 manifest 时跳过分组校验。
 * 未指定 skillKeys 时还原最新一次备份的整库。
 */
export async function restoreSkills({ home = dshHome(), root, skillKeys, provider } = {}) {
  const target = provider ?? providerFrom(await loadSettings(home), home)
  const { index } = await loadSkillsIndex(target)
  const wanted = Array.isArray(skillKeys) && skillKeys.length > 0 ? index.entries.filter(entry => skillKeys.includes(entry.key)) : index.entries.slice(0, 1)
  const library = skillsRoot(root)
  const restored = []
  const skipped = []
  for (const entry of wanted) {
    // 该条目要还原的技能清单：新格式取 skills[]，旧格式取 name。
    const names = Array.isArray(entry.skills) && entry.skills.length > 0 ? entry.skills : (typeof entry.name === 'string' && entry.name !== '' ? [entry.name] : [])
    // 分片键 → 内容：批量一次取回（Gist 单次响应含全部文件），避免逐片 getGist。
    const keys = entryKeys(entry)
    const buffers = typeof target.getMany === 'function' ? await target.getMany(keys) : new Map(await Promise.all(keys.map(async key => [key, await target.get(key)])))
    // 完整性校验必须走在 gunzip 之前：损坏字节一旦进解压就抛
    // "incorrect header check"，拿不到可读的 checksum 语义。
    const manifest = Array.isArray(entry.manifest) ? entry.manifest : []
    if (manifest.length > 0) {
      for (const item of manifest) {
        if (typeof item?.name !== 'string' || typeof item?.sha256 !== 'string') continue
        // push 时每个技能条目都带自己的 keys 清单：直接按键分组。
        // 不能用键名前缀子串匹配——技能名互为前缀时（tabbit / tabbit-plus）
        // `/tabbit-` 会同时命中两者，校验组被污染导致误报 checksum mismatch。
        const group = Array.isArray(item.keys) ? item.keys.map(key => buffers.get(key)).filter(buffer => buffer !== undefined) : []
        if (group.length !== (item.keys?.length ?? 0) || group.length === 0) throw new Error(`Skill ${item.name} is missing from backup ${entry.key}`)
        if (hash(Buffer.concat(group)) !== item.sha256) throw new Error(`Skill checksum mismatch: ${item.name}`)
      }
    } else if (typeof entry.sha256 === 'string' && entry.sha256 !== '') {
      // 旧格式（按技能一条）：整组只有一个 sha256。
      if (hash(Buffer.concat([...buffers.values()])) !== entry.sha256) throw new Error(`Skill checksum mismatch: ${entry.name ?? entry.key}`)
    }
    const perSkill = new Map()
    for (const [key, compressed] of buffers) {
      const archive = JSON.parse(gunzipSync(compressed).toString('utf8'))
      if (archive.schema !== `${SCHEMA}/skills` || !Array.isArray(archive.files)) throw new Error(`Invalid skill archive in ${entry.key}`)
      const name = archive.skill
      if (typeof name !== 'string' || name === '') throw new Error(`Invalid skill archive in ${entry.key}`)
      if (!names.includes(name)) throw new Error(`Archive ${key} references skill ${name} outside entry ${entry.key}`)
      perSkill.set(name, [...(perSkill.get(name) ?? []), ...archive.files])
    }
    for (const name of names) {
      const output = join(library, name)
      // 安全合并：本地已有同名技能就跳过，不覆盖。
      if (existsSync(join(output, 'SKILL.md'))) { skipped.push(name); continue }
      const items = perSkill.get(name)
      if (items === undefined) throw new Error(`Skill ${name} is missing from backup ${entry.key}`)
      await rm(output, { recursive: true, force: true })
      for (const item of items) {
        validateArchiveEntry(item)
        const file = join(output, ...item.path.split('/'))
        if (!isInside(output, file)) throw new Error(`Skill archive escaped its target: ${name}`)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, decode(item.data))
      }
      restored.push(name)
    }
  }
  return { restored, skipped, remaining: index.entries.length }
}

export async function previewSyncChanges({ home = dshHome() } = {}) {
  const settings = await loadSettings(home)
  const local = await createSnapshot({ home })
  try {
    const remote = await loadRemoteSnapshotData(providerFrom(settings, home))
    return { localCreatedAt: local.snapshot.createdAt, remoteCreatedAt: remote.snapshot.createdAt, items: diffSnapshots(remote.snapshot, local.snapshot), available: true }
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)).includes('HTTP 404')) return { localCreatedAt: local.snapshot.createdAt, items: [...snapshotDependencies(local.snapshot).values()].map(item => ({ id: `dependency:${item.profile}:${item.name}`, kind: 'plugin', ...item, local: item.version, remote: undefined, selected: true })), available: false }
    throw error
  }
}

export async function updateSyncPreferences({ deviceName, autoSync, syncScope, historyLimit } = {}, { home = dshHome() } = {}) {
  const settings = await deviceSettings(home)
  const minutes = Number(autoSync?.intervalMinutes ?? settings.autoSync.intervalMinutes)
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new Error('Automatic sync interval must be between 5 and 1440 minutes')
  const next = {
    ...settings,
    deviceName: typeof deviceName === 'string' && deviceName.trim() !== '' ? deviceName.trim().slice(0, 80) : settings.deviceName,
    autoSync: autoSync === undefined ? settings.autoSync : { enabled: autoSync?.enabled === true, intervalMinutes: minutes },
    syncScope: syncScope === undefined ? settings.syncScope : { sources: syncScope?.sources !== false },
    historyLimit: normalizeHistoryLimit(historyLimit ?? settings.historyLimit),
  }
  await persistSettings(next, home)
  return publicSettings(next, home)
}

export async function unlockEncryption({ passphrase, enable = false } = {}, { home = dshHome() } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('客户端加密口令至少需要 8 个字符')
  const settings = await deviceSettings(home)
  if (!isProviderConfigured(settings.provider)) throw new Error('请先连接同步渠道，再启用客户端加密')
  if (settings.encryption?.enabled === true || enable === true) {
    encryptionKeys.set(resolve(home), passphrase)
    const next = { ...settings, encryption: { enabled: true, salt: '' } }
    await persistSettings(next, home)
    return publicSettings(next, home)
  }
  throw new Error('客户端加密未启用')
}

export async function lockEncryption({ home = dshHome() } = {}) {
  encryptionKeys.delete(resolve(home))
  return publicSettings(await loadSettings(home), home)
}

export async function runAutomaticSync({ home = dshHome() } = {}) {
  const settings = await loadSettings(home)
  if (settings.autoSync?.enabled !== true || !isProviderConfigured(settings.provider)) return { attempted: false, reason: 'disabled' }
  if (settings.encryption?.enabled === true && !encryptionKeys.has(resolve(home))) return { attempted: false, reason: 'locked' }
  const interval = settings.autoSync.intervalMinutes * 60_000
  const previous = automaticSyncRuns.get(resolve(home)) ?? 0
  if (Date.now() - previous < interval) return { attempted: false, reason: 'not-due' }
  automaticSyncRuns.set(resolve(home), Date.now())
  const preview = await previewSyncChanges({ home })
  if (preview.items.length === 0) return { attempted: false, reason: 'unchanged' }
  const result = await synchronizeSnapshots({ home, strategy: 'smart' })
  return result.direction === 'needs-choice' ? { attempted: true, synchronized: false, reason: 'conflicts', conflicts: result.conflicts } : { attempted: true, synchronized: true, result }
}

export async function loadRemoteSnapshot(home = dshHome()) {
  const settings = await loadSettings(home)
  return (await loadRemoteSnapshotData(providerFrom(settings, home))).snapshot
}

export async function pullSnapshot({ home = dshHome(), apply = false, snapshotKey } = {}) {
  const settings = await loadSettings(home)
  const provider = providerFrom(settings, home)
  const snapshot = snapshotKey === undefined ? (await loadRemoteSnapshotData(provider)).snapshot : (await loadRemoteSnapshotData(provider, snapshotKey)).snapshot
  const restoredSources = {}
  for (const source of snapshot.sources) restoredSources[source.name] = await restoreSource(provider, source, home)
  const plan = snapshot.profiles.map(profile => ({ name: profile.name, files: Object.keys(profile.files ?? {}), localDependencies: profile.localDependencies ?? [] }))
  if (!apply) return { createdAt: snapshot.createdAt, plan, restoredSources, applied: false }
  const backup = join(syncRoot(home), 'backups', new Date().toISOString().replaceAll(':', '-'))
  const installations = []
  for (const profile of snapshot.profiles) {
    const target = profileDir(profile.name, home)
    const existingManifest = await readJson(join(target, 'package.json'), {})
    const before = existsSync(target) ? await profileFiles(profile.name, home) : {}
    await writeJson(join(backup, profile.name, 'files.json'), before)
    for (const [name, content] of Object.entries(profile.files ?? {})) {
      if (name.includes('..') || name.startsWith('/')) throw new Error(`Unsafe profile file: ${name}`)
      const output = join(target, ...name.split('/'))
      await mkdir(dirname(output), { recursive: true })
      const data = profileRestoreData(name, content)
      await writeFile(output, data)
    }
    const manifestPath = join(target, 'package.json')
    const manifest = await readJson(manifestPath)
    for (const localName of profile.localDependencies ?? []) if (restoredSources[localName] !== undefined) manifest.dependencies[localName] = `file:${restoredSources[localName].replaceAll('\\', '/')}`
    if (typeof existingManifest.dependencies?.[SELF_PACKAGE] === 'string') {
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [SELF_PACKAGE]: existingManifest.dependencies[SELF_PACKAGE] }
      const existingBundles = existingManifest.dsh?.profile?.bundles
      if (Array.isArray(existingBundles) && existingBundles.includes(SELF_PACKAGE)) {
        const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
        manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...new Set([...bundles, SELF_PACKAGE])] } }
      }
    }
    await writeJson(manifestPath, manifest)
    await repairProfilePnpmConfig(target)
    // DSH may currently be loading this profile. Dependency installation is
    // deliberately deferred until the user restarts DSH.
    installations.push({ profile: profile.name, deferred: true })
  }
  await trimLocalBackups(home)
  return { createdAt: snapshot.createdAt, plan, restoredSources, installations, applied: true, backup, installDeferred: true, restartRequired: true }
}

function decodeCommandOutput(chunks) {
  const output = Buffer.concat(chunks).toString('utf8')
  // cmd.exe writes localized diagnostics in the active Windows code page,
  // while Node and pnpm write UTF-8. Only fall back when UTF-8 is invalid.
  return process.platform === 'win32' && output.includes('\ufffd') ? new TextDecoder('gb18030').decode(Buffer.concat(chunks)) : output
}

function commandOutput(child, timeoutMs = 120_000) {
  return new Promise((resolvePromise, reject) => {
    const stdout = []; const stderr = []
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.stdout?.on('data', data => { stdout.push(Buffer.from(data)) })
    child.stderr?.on('data', data => { stderr.push(Buffer.from(data)) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); resolvePromise({ exitCode: timedOut ? 124 : code ?? 1, stdout: decodeCommandOutput(stdout).slice(-8000), stderr: `${decodeCommandOutput(stderr)}${timedOut ? '\npnpm timed out after two minutes' : ''}`.slice(-8000) }) })
  })
}

function validatePnpmArgument(value) {
  if (typeof value !== 'string' || value === '' || value.length > 4096 || /[\0\r\n"'`$&|<>^%!]/.test(value)) throw new Error('Unsafe pnpm argument rejected')
  return value
}

function pnpmCommand(dir, args) {
  const safeArgs = args.map(validatePnpmArgument)
  if (process.platform !== 'win32') return { command: 'pnpm', args: safeArgs }
  const executable = existsSync(join(dir, 'pnpm.cmd')) ? join(dir, 'pnpm.cmd') : 'pnpm.cmd'
  if (/[\r\n"%]/.test(executable)) throw new Error('Unsafe pnpm executable path rejected')
  // Passing the executable separately lets Node quote it for cmd.exe exactly
  // once. Embedding a quoted CALL command causes cmd to see literal quotes.
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/v:off', '/c', executable, ...safeArgs] }
}

async function runPnpm(dir, args) {
  const command = pnpmCommand(dir, args)
  return commandOutput(spawn(command.command, command.args, { cwd: dir, shell: false, windowsHide: true }))
}
function pnpmFailure(result) { return new Error(`pnpm exited ${result.exitCode}: ${result.stderr.slice(-1200) || result.stdout.slice(-1200)}`) }
function blockedBuilds(result) { return `${result.stdout}\n${result.stderr}`.includes('ERR_PNPM_IGNORED_BUILDS') }

function yamlNameValue(line) {
  const match = line.match(/^\s*name:\s*(?:['"]([^'"]+)['"]|([^\s#]+))\s*$/)
  return match?.[1] ?? match?.[2]
}

async function removeConfiguredPluginPatch(packageName, directory) {
  const path = join(directory, 'cordis.patch.yml')
  if (!existsSync(path)) return { changed: false, removed: 0 }
  const source = await readFile(path, 'utf8')
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const output = []
  let removed = 0

  // Remove only matching nested plugin items; unrelated loader entries stay intact.
  for (let index = 0; index < lines.length;) {
    if (!/^-\s+/.test(lines[index])) { output.push(lines[index]); index += 1; continue }
    const blockStart = index
    while (index < lines.length) {
      if (index !== blockStart && /^-\s+/.test(lines[index])) break
      index += 1
    }
    const block = lines.slice(blockStart, index)
    const filtered = [block[0]]
    let blockRemoved = 0
    for (let itemIndex = 1; itemIndex < block.length;) {
      const item = block[itemIndex].match(/^(\s+)-\s+(?:id|name):\s*/)
      if (item === null) { filtered.push(block[itemIndex]); itemIndex += 1; continue }
      const indent = item[1].length
      let itemEnd = itemIndex + 1
      while (itemEnd < block.length) {
        const next = block[itemEnd].match(/^(\s+)-\s+(?:id|name):\s*/)
        if (next !== null && next[1].length <= indent) break
        itemEnd += 1
      }
      const itemName = block.slice(itemIndex, itemEnd).map(yamlNameValue).find(Boolean)
      if (itemName === packageName) { blockRemoved += 1; itemIndex = itemEnd; continue }
      filtered.push(...block.slice(itemIndex, itemEnd))
      itemIndex = itemEnd
    }
    if (blockRemoved > 0 && /^-\s+insert:\s*$/.test(filtered[0]) && !filtered.slice(1).some(line => /^\s+-\s+/.test(line))) {
      removed += blockRemoved
      output.push(...filtered.slice(1))
      continue
    }
    removed += blockRemoved
    output.push(...filtered)
  }

  if (removed === 0) return { changed: false, removed: 0 }
  while (output.at(-1) === '') output.pop()
  const meaningful = output.some(line => line.trim() !== '' && !line.trim().startsWith('#') && line.trim() !== '[]')
  if (!meaningful) output.push('[]')
  await writeFile(path, `${output.join(newline).replace(/(?:\r?\n)+$/, '')}${newline}`, 'utf8')
  return { changed: true, removed }
}

async function packageBundle(name, dir) {
  try { const manifest = await readJson(join(dir, 'node_modules', ...name.split('/'), 'package.json')); return manifest?.dsh?.bundle?.patch !== undefined } catch { return false }
}

async function reconcileBundles(name, dir, mode) {
  const manifest = await readJson(join(dir, 'package.json'))
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const isBundle = await packageBundle(name, dir)
  const next = mode === 'enable' && isBundle ? [...new Set([...bundles, name])] : bundles.filter(item => item !== name)
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: next } }
  await writeJson(join(dir, 'package.json'), manifest)
  return { isBundle, bundles: next }
}

export async function installPlugin({ profile = 'web', spec, packageName, home = dshHome() }) {
  if (typeof spec !== 'string' || spec.trim() === '') throw new Error('A package spec is required')
  validatePnpmArgument(spec)
  const dir = profileDir(profile, home)
  await repairProfilePnpmConfig(dir)
  const before = await readJson(join(dir, 'package.json'))
  const result = await runPnpm(dir, ['add', spec])
  const manifest = await readJson(join(dir, 'package.json'))
  const names = Object.keys(manifest.dependencies ?? {})
  const added = names.filter(name => before.dependencies?.[name] === undefined)
  const match = packageName ?? (added.length === 1 ? added[0] : names.find(name => spec === name || spec.startsWith(`${name}@`) || spec.includes(name.replace('@', ''))))
  if (result.exitCode !== 0 && (!blockedBuilds(result) || match === undefined || !await packageIsPresent(dir, match))) throw pnpmFailure(result)
  const reconciliation = match === undefined ? undefined : await reconcileBundles(match, dir, 'enable')
  return { profile, spec, installedPackage: match ?? null, reconciliation, ...result, buildApprovalRequired: result.exitCode !== 0, restartRequired: true }
}

export async function updateSelf({ home = dshHome(), fetcher = fetch } = {}) {
  const update = await checkSelfUpdate({ home, fetcher })
  if (!update.available || update.release === undefined) return { ...update, updated: false }
  const archive = await downloadGithubSelfRelease(update.release, fetcher)
  if (hash(archive) !== update.release.sha256) throw new Error('Cloud Sync update checksum verification failed')
  const output = join(syncRoot(home), 'releases', basename(update.release.assetName))
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, archive)
  const pnpmShim = await ensureProfilePnpmShim({ profile: 'web', home })
  const install = await installPlugin({ profile: 'web', packageName: SELF_PACKAGE, spec: installDependencySpec(SELF_PACKAGE, `file:${output.replaceAll('\\', '/')}`), home })
  return { ...update, updated: true, archive: output, pnpmShim, install, restartRequired: true }
}

export async function uninstallPlugin({ profile = 'web', packageName, home = dshHome() }) {
  if (typeof packageName !== 'string' || !/^(?:@[-a-zA-Z0-9_.]+\/)?[-a-zA-Z0-9_.]+$/.test(packageName)) throw new Error('A valid package name is required')
  const dir = profileDir(profile, home)
  await repairProfilePnpmConfig(dir)
  const result = await runPnpm(dir, ['remove', packageName])
  if (result.exitCode !== 0) throw pnpmFailure(result)
  const reconciliation = await reconcileBundles(packageName, dir, 'disable')
  const patchCleanup = await removeConfiguredPluginPatch(packageName, dir)
  return { profile, packageName, reconciliation, patchCleanup, ...result, restartRequired: true }
}

export async function setPluginEnabled({ profile = 'web', packageName, enabled, home = dshHome() }) {
  const dir = profileDir(profile, home)
  const manifest = await readJson(join(dir, 'package.json'))
  if (manifest.dependencies?.[packageName] === undefined) throw new Error(`${packageName} is not installed in profile ${profile}`)
  return { profile, packageName, enabled: Boolean(enabled), ...(await reconcileBundles(packageName, dir, enabled ? 'enable' : 'disable')), restartRequired: true }
}

function isLocalSpec(spec) { return typeof spec === 'string' && /^(?:link:|file:|\.|[A-Za-z]:[\\/])/.test(spec) }

async function packageIsPresent(dir, name) { return existsSync(join(dir, 'node_modules', ...name.split('/'), 'package.json')) }

async function configuredPluginNames(directory) {
  const names = new Set()
  for (const filename of ['cordis.yml', 'cordis.patch.yml']) {
    const path = join(directory, filename)
    if (!existsSync(path)) continue
    const content = await readFile(path, 'utf8')
    for (const match of content.matchAll(/^\s*name:\s*(?:['"]([^'"]+)['"]|([^\s#]+))\s*$/gm)) {
      const name = match[1] ?? match[2]
      if (/^(?:@[-a-zA-Z0-9_.]+\/)?[-a-zA-Z0-9_.]+$/.test(name)) names.add(name)
    }
  }
  return names
}

export async function adoptConfiguredPlugin({ profile = 'web', packageName, home = dshHome() }) {
  if (typeof packageName !== 'string' || !/^(?:@[-a-zA-Z0-9_.]+\/)?[-a-zA-Z0-9_.]+$/.test(packageName)) throw new Error('A valid package name is required')
  const directory = profileDir(profile, home)
  if (!(await configuredPluginNames(directory)).has(packageName)) throw new Error(`${packageName} is not referenced by this profile configuration`)
  const packageDirectory = join(directory, 'node_modules', ...packageName.split('/'))
  if (!existsSync(join(packageDirectory, 'package.json'))) throw new Error(`${packageName} is not available in this profile's node_modules`)
  const manifestPath = join(directory, 'package.json')
  const manifest = await readJson(manifestPath)
  if (manifest.dependencies?.[packageName] !== undefined) return { profile, packageName, alreadyManaged: true }
  manifest.dependencies = { ...(manifest.dependencies ?? {}), [packageName]: `file:${packageDirectory.replaceAll('\\', '/')}` }
  await writeJson(manifestPath, manifest)
  const source = await backupLocalPlugin(packageDirectory, { home })
  return { profile, packageName, source, syncRequired: true }
}

export async function getSyncInventory({ profile = 'web', home = dshHome() } = {}) {
  const dir = profileDir(profile, home)
  const localManifest = await readJson(join(dir, 'package.json'))
  const localDependencies = localManifest.dependencies ?? {}
  const configuredNames = await configuredPluginNames(dir)
  let remote
  let remoteError
  try { remote = await loadRemoteSnapshot(home) } catch (error) { remoteError = error instanceof Error ? error.message : String(error) }
  const remoteProfile = remote?.profiles.find(item => item.name === profile)
  const remoteManifest = remoteProfile?.files?.['package.json'] === undefined ? {} : JSON.parse(decode(remoteProfile.files['package.json']).toString('utf8'))
  const remoteDependencies = remoteManifest.dependencies ?? {}
  const names = [...new Set([...Object.keys(remoteDependencies), ...Object.keys(localDependencies), ...configuredNames])].sort((left, right) => left.localeCompare(right))
  const bundles = Array.isArray(localManifest.dsh?.profile?.bundles) ? localManifest.dsh.profile.bundles : []
  const plugins = []
  for (const name of names) {
    const requested = remoteDependencies[name] ?? localDependencies[name]
    const localSource = isLocalSpec(requested)
    const configurationOnly = configuredNames.has(name) && localDependencies[name] === undefined
    const present = await packageIsPresent(dir, name)
    const bundle = present && await packageBundle(name, dir)
    plugins.push({
      name,
      requested,
      configuredInRemote: remoteDependencies[name] !== undefined || configurationOnly,
      // A present bundle outside dsh.profile.bundles is not usable yet. Show
      // it as installable so a retry reconciles the DSH layer list.
      installed: !configurationOnly && present && (!bundle || bundles.includes(name)),
      enabled: bundles.includes(name),
      localSource,
      configurationOnly,
      sourceArchived: !localSource || remote?.sources.some(source => source.name === name) === true,
    })
  }
  return {
    profile,
    remote: remote === undefined ? { available: false, error: remoteError } : { available: true, createdAt: remote.createdAt, sources: remote.sources.length },
    local: { dependencies: Object.keys(localDependencies).length, bundles: bundles.length },
    plugins,
  }
}

export function installDependencySpec(packageName, requested) {
  if (typeof packageName !== 'string' || packageName === '' || typeof requested !== 'string' || requested === '') throw new Error('A package name and dependency spec are required')
  return `${packageName}@${requested}`
}

function escapePattern(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function snapshotText(profile, name) { return typeof profile.files?.[name] === 'string' ? decode(profile.files[name]).toString('utf8') : '' }

export function lockedGitSpec(profile, packageName, requested) {
  if (!requested.startsWith('github:')) return requested
  const lock = snapshotText(profile, 'pnpm-lock.yaml')
  const expression = new RegExp(`^\\s*${escapePattern(packageName)}:\\s*\\r?\\n\\s*specifier:\\s*[^\\r\\n]+\\r?\\n\\s*version:\\s*([^\\r\\n]+)`, 'm')
  const resolved = lock.match(expression)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  return typeof resolved === 'string' && /^https:\/\//.test(resolved) ? resolved : requested
}

function approvedBuildKeys(profile) {
  const workspace = snapshotText(profile, 'pnpm-workspace.yaml')
  const lines = workspace.split(/\r?\n/)
  const start = lines.findIndex(line => /^allowBuilds:\s*$/.test(line))
  if (start === -1) return []
  const keys = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\S/.test(line)) break
    const match = line.match(/^\s+(.+?):\s*true\s*$/)
    if (match === null) continue
    const key = match[1].trim().replace(/^['"]|['"]$/g, '')
    if (key !== '' && !/[\r\n]/.test(key)) keys.push(key)
  }
  return keys
}

async function mergeApprovedBuilds(profile, directory) {
  const keys = approvedBuildKeys(profile)
  if (keys.length === 0) return []
  const workspacePath = join(directory, 'pnpm-workspace.yaml')
  const current = existsSync(workspacePath) ? await readFile(workspacePath, 'utf8') : ''
  const lines = current.split(/\r?\n/)
  let start = lines.findIndex(line => /^allowBuilds:\s*$/.test(line))
  if (start === -1) { lines.push('allowBuilds:'); start = lines.length - 1 }
  let end = start + 1
  while (end < lines.length && !/^\S/.test(lines[end])) end += 1
  const existing = new Set(lines.slice(start + 1, end).map(line => line.match(/^\s+(.+?):\s*(?:true|false)\s*$/)?.[1]?.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))
  const missing = keys.filter(key => !existing.has(key))
  if (missing.length === 0) return []
  lines.splice(end, 0, ...missing.map(key => `  ${JSON.stringify(key)}: true`))
  await writeFile(workspacePath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
  return missing
}

export async function installConfiguredPlugin({ profile = 'web', packageName, home = dshHome() }) {
  const directory = profileDir(profile, home)
  const localManifest = await readJson(join(directory, 'package.json'))
  if (localManifest.dependencies?.[packageName] === undefined && (await configuredPluginNames(directory)).has(packageName) && await packageIsPresent(directory, packageName)) {
    return { profile, packageName, adopted: true, ...(await adoptConfiguredPlugin({ profile, packageName, home })), restartRequired: false }
  }
  const remote = await loadRemoteSnapshot(home)
  const remoteProfile = remote.profiles.find(item => item.name === profile)
  if (remoteProfile?.files?.['package.json'] === undefined) throw new Error(`The remote snapshot has no ${profile} profile configuration`)
  const remoteManifest = JSON.parse(decode(remoteProfile.files['package.json']).toString('utf8'))
  let spec = remoteManifest.dependencies?.[packageName]
  if (typeof spec !== 'string') throw new Error(`${packageName} is not declared by the remote profile`)
  const pnpmShim = await ensureProfilePnpmShim({ profile, home })
  const approvedBuilds = await mergeApprovedBuilds(remoteProfile, directory)
  if (isLocalSpec(spec)) {
    if (!remote.sources.some(source => source.name === packageName)) throw new Error(`${packageName} is a local plugin, but its source archive was not uploaded. On the source device, update Cloud Sync and select Sync, then try again.`)
    const preview = await pullSnapshot({ home, apply: false })
    const restored = preview.restoredSources[packageName]
    if (restored === undefined) throw new Error(`${packageName} is a local plugin, but its source archive is not in the remote snapshot`)
    spec = `file:${restored.replaceAll('\\', '/')}`
  }
  else spec = lockedGitSpec(remoteProfile, packageName, spec)
  return { pnpmShim, approvedBuilds, ...(await installPlugin({ profile, packageName, spec: installDependencySpec(packageName, spec), home })) }
}

export async function status({ home = dshHome() } = {}) {
  const settings = await loadSettings(home)
  const profiles = await listProfiles(home)
  const catalog = await loadSourceCatalog(home)
  const plugins = []
  for (const name of profiles) { const manifest = await readJson(join(profileDir(name, home), 'package.json')); plugins.push({ profile: name, dependencies: Object.keys(manifest.dependencies ?? {}), bundles: manifest.dsh?.profile?.bundles ?? [] }) }
  return { version: await ownVersion(), home, provider: publicSettings(settings, home).provider, profiles: plugins, sourceBackups: Object.values(catalog.sources) }
}
