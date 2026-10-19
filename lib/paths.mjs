// lib/paths.mjs — 路径解析、设备识别与越界校验（零依赖）。
//
// 全部纯函数：解析同步根/工作树根、校验嵌套关系、把会话文件相对路径
// 安全地映射进工作树。任何把外部输入拼进路径的地方必须先经 assertRelPath
// 或 containment 检查（路径越界 = PATH_UNSAFE 响亮失败，绝不静默）。
//
// 设备路径一律动态识别（用户全局规则）：本文件是 DSH home / profile /
// 技能库 / 已知文件夹（文档目录）/ 原生绝对路径判定的**唯一入口**。
// 优先级统一为：显式配置 → 环境变量 → 组件自身安装位置反推 → 用户主目录兜底。
// 绝不写死个人路径、盘符、profile 名或本地化文件夹名。
//
// 不同设备的具体差异都在这里被吸收，调用方只消费结果：
//   - Windows：用户目录可能在任意盘符；`~` 由 os.homedir() 给出；“文档”会被
//     本地化为「文档 / Documents / My Documents …」；路径可能带 `%VAR%`。
//   - macOS：`~/Documents`；`/Users/<name>` 形态。
//   - Linux：`$XDG_DOCUMENTS_DIR`（user-dirs.dirs）优先于 `~/Documents`；
//     主目录可能是 `/home/<name>` 或 `/root`；路径可能带 `$VAR`。
//   - 无桌面的服务器/容器：已知文件夹不存在时逐级回退到主目录本身。

import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { FORK_NAME_RE, MIRROR_DIR } from './constants.mjs'
import { badConfig, pathUnsafe } from './errors.mjs'

// 路径分隔符边界上的变量写法：$VAR、${VAR}、%VAR% 三种都接受。
const ENV_TOKEN_RE = /(^|[/\\])(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%)/gu
const HOME_PREFIX_RE = /^~(?=$|[/\\])/u
// 安装位置反推：插件必然挂在 <home>/profiles/<profile>/node_modules/ 下。
// 大小写不敏感——Windows 上 `Profiles` / `Profiles` 混写很常见。
const INSTALL_PROFILE_RE = /(^|[/\\])profiles[/\\]([^/\\]+)[/\\]node_modules[/\\]/iu
// 旧备份里出现过的“设备主目录”形态（只在没有便携 token 的 legacy 文本上使用）。
const LEGACY_HOME_RE = /[A-Za-z]:[/\\]+(?:Users|Documents and Settings)[/\\]+[^/\\"'\x60\r\n]+|\/(?:Users|home)\/[^/"'\x60\s]+|\/root(?=$|[/"'\x60\s])/gu

/**
 * 本模块自身的文件路径（测试可注入）。
 * @param {string} [modulePath] - 显式路径。
 * @returns {string|undefined}
 */
function ownModulePath(modulePath) {
  if (typeof modulePath === 'string' && modulePath.length > 0) return modulePath
  try { return fileURLToPath(import.meta.url) } catch { return undefined }
}

/**
 * 宿主用户主目录（绝不写死具体用户名）。
 * os.homedir() 是权威来源；仅在它不可用时回退环境变量（测试/受控场景）。
 * @param {Record<string, string|undefined>} [env] - 环境。
 * @returns {string|undefined} 绝对路径，或 undefined。
 */
export function userHomeDir(env = process.env) {
  const home = os.homedir()
  if (typeof home === 'string' && home.length > 0) return home
  const fallback = typeof env.HOME === 'string' && env.HOME !== ''
    ? env.HOME
    : (typeof env.USERPROFILE === 'string' ? env.USERPROFILE : '')
  return fallback !== '' ? fallback : undefined
}

/**
 * 展开配置值里的设备相关写法：`~` / `~/x`、`$VAR` / `${VAR}` / `%VAR%`。
 * 只展开位于路径分隔符边界上的变量，避免误伤普通文件名里的 `$` 与 `%`。
 * 未知变量原样保留（绝不静默吞掉用户写的内容）。
 * @param {string} value - 待展开的配置值。
 * @param {Record<string, string|undefined>} [env] - 环境。
 * @returns {string} 展开后的值（未做 resolve，空串表示未配置）。
 */
export function expandUserPath(value, env = process.env) {
  if (typeof value !== 'string') return ''
  let next = value.trim()
  if (next === '') return ''
  next = next.replace(ENV_TOKEN_RE, (match, lead, braced, plain, percent) => {
    const key = braced ?? plain ?? percent
    const resolved = env[key]
    return typeof resolved === 'string' && resolved !== '' ? lead + resolved : match
  })
  if (HOME_PREFIX_RE.test(next)) {
    const home = userHomeDir(env)
    if (home === undefined) return next
    const rest = next.slice(1).replace(/^[/\\]+/u, '')
    return rest === '' ? home : path.join(home, rest)
  }
  return next
}

/**
 * 从插件自身安装位置反推 DSH home 与 profile 名。
 * 安装形态覆盖：`<home>/profiles/<p>/node_modules/<pkg>` 以及 pnpm 的
 * `<home>/profiles/<p>/node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>`
 * （后者同样命中第一层 `profiles/<p>/node_modules/`）。
 * @param {string} [modulePath] - 本模块文件路径。
 * @returns {{home?: string, profile?: string}} 推导结果；不匹配时为空对象。
 */
export function detectInstallRoots(modulePath = undefined) {
  const own = ownModulePath(modulePath)
  if (typeof own !== 'string' || own.length === 0) return {}
  const matched = INSTALL_PROFILE_RE.exec(own)
  if (matched === null) return {}
  // matched[0] 含前导分隔符，matched.index + 分隔符长度 = `profiles` 段起点。
  const prefix = own.slice(0, matched.index + matched[1].length).replace(/[/\\]+$/u, '')
  const profile = matched[2]
  return {
    ...(prefix === '' ? {} : { home: path.resolve(prefix) }),
    ...(profile.length === 0 ? {} : { profile }),
  }
}

/**
 * 动态解析 DSH home（每台设备不同，绝不写死个人路径）。优先级：
 *  1. `$DSH_HOME`（支持 `~` 与 `%VAR%`/`$VAR` 展开，相对路径按 cwd 解析）；
 *  2. 本模块安装路径推导（Electron 桌面宿主不导出 DSH_HOME，这是它的主路径）；
 *  3. `~/.dsh`（兜底）。
 * @param {string} [modulePath] - 本模块的文件路径（测试注入；默认取自身 URL）。
 * @param {Record<string, string|undefined>} [env] - 环境（测试注入）。
 * @returns {string|undefined} DSH home 绝对路径；三者皆不可得时 undefined。
 */
export function detectDshHome(modulePath = undefined, env = process.env) {
  const configured = expandUserPath(typeof env.DSH_HOME === 'string' ? env.DSH_HOME : '', env)
  if (configured !== '') return configured
  const { home } = detectInstallRoots(modulePath)
  if (home !== undefined) return home
  const userHome = userHomeDir(env)
  return userHome === undefined ? undefined : path.join(userHome, '.dsh')
}

/**
 * 动态解析当前运行的 DSH profile 名。
 * 优先按安装位置反推（比读 `$DSH_PROFILE` 可靠：后者会被父进程/外部 shell
 * 环境污染，实测 diagcopy 上读到 desktop），其次环境变量，最后调用方给的默认值。
 * @param {string} [modulePath] - 本模块文件路径。
 * @param {Record<string, string|undefined>} [env] - 环境。
 * @param {string} [fallback] - 两者皆不可用时的默认 profile。
 * @returns {string|undefined} profile 名。
 */
export function detectDshProfile(modulePath = undefined, env = process.env, fallback = undefined) {
  const { profile } = detectInstallRoots(modulePath)
  if (profile !== undefined) return profile
  const configured = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
  return configured !== '' ? configured : fallback
}

/**
 * 解析技能库根：`$DSH_SKILLS_DIR` / `$AGENTS_SKILLS_DIR` → `<userHome>/.agents/skills`。
 * @param {object} [input] - {skillsRoot?, userHome?, env?}。
 * @returns {string|undefined} 绝对路径。
 */
export function detectSkillsRoot(input = {}) {
  const env = input.env ?? process.env
  const configured = expandUserPath(
    typeof input.skillsRoot === 'string' && input.skillsRoot !== ''
      ? input.skillsRoot
      : (env.DSH_SKILLS_DIR ?? env.AGENTS_SKILLS_DIR ?? ''),
    env,
  )
  if (configured !== '') return path.resolve(configured)
  const userHome = input.userHome ?? userHomeDir(env)
  return userHome === undefined ? undefined : path.join(userHome, '.agents', 'skills')
}

/** 目录存在性（失败一律 false，绝不因为权限/竞态抛错）。 */
function isDirectory(candidate) {
  try { return statSync(candidate).isDirectory() } catch { return false }
}

/**
 * 解析 Linux `user-dirs.dirs` 里的 `XDG_DOCUMENTS_DIR`（可能被本地化）。
 * @param {{env?: Record<string, string|undefined>, userHome?: string}} [input] - 输入。
 * @returns {string|undefined} 绝对路径；不可得时 undefined。
 */
export function detectXdgDocumentsDir(input = {}) {
  const env = input.env ?? process.env
  const userHome = input.userHome ?? userHomeDir(env)
  const configuredHome = expandUserPath(typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME : '', env)
  const configHome = configuredHome !== ''
    ? path.resolve(configuredHome)
    : (userHome === undefined ? undefined : path.join(userHome, '.config'))
  if (configHome === undefined) return undefined
  let text
  try { text = readFileSync(path.join(configHome, 'user-dirs.dirs'), 'utf8') } catch { return undefined }
  const matched = /^[ \t]*XDG_DOCUMENTS_DIR[ \t]*=[ \t]*"([^"]*)"/mu.exec(text)
  if (matched === null) return undefined
  const raw = matched[1].replace(/^\$HOME/u, userHome ?? '').replace(/^~/u, userHome ?? '')
  return raw === '' ? undefined : raw
}

/**
 * 解析“本机可用于落项目的回退目录”，供跨设备还原时给缺失的源目录挑一个目标。
 * 不同设备的条件差异全部在这里吸收：
 *  - 显式 `$DSH_RESTORE_FALLBACK_DIR` 最优先；
 *  - Linux 先读 `XDG_DOCUMENTS_DIR`（桌面可能是「文档」「Documentos」等本地化名）；
 *  - Windows/macOS 按常见本地化名逐个探测真实存在的目录（`文档`、`My Documents` …）；
 *  - 全部不存在（服务器/容器）时回退到用户主目录本身——保证一定是本机真实路径。
 * @param {object} [input] - {env?, platform?, userHome?, fallbackRoot?}。
 * @returns {string|undefined} 绝对路径。
 */
export function detectProjectFallbackRoot(input = {}) {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const userHome = input.userHome ?? userHomeDir(env)
  const configured = expandUserPath(
    typeof input.fallbackRoot === 'string' && input.fallbackRoot !== ''
      ? input.fallbackRoot
      : (env.DSH_RESTORE_FALLBACK_DIR ?? ''),
    env,
  )
  if (configured !== '') return path.resolve(configured)
  if (userHome === undefined) return undefined
  const candidates = []
  if (platform === 'linux') {
    const xdg = detectXdgDocumentsDir({ env, userHome })
    if (xdg !== undefined && path.isAbsolute(xdg)) candidates.push(xdg)
  }
  // 已知文件夹名的本地化形态：覆盖 Windows 主要语言与 macOS 常见形态。
  for (const name of ['Documents', '文档', 'My Documents', 'Мои документы', 'Documentos', 'Documenti', '書類', 'Dokumente']) {
    candidates.push(path.join(userHome, name))
  }
  candidates.push(userHome)
  for (const candidate of candidates) if (isDirectory(candidate)) return candidate
  return userHome
}

/**
 * 是否为本机“完全限定”绝对路径。
 * 与 workspace-manifest 的严格判据保持一致：拒绝 `C:x` 这类盘符相对形式、
 * 拒绝 POSIX 主机上的 Windows 路径、拒绝 Windows 上的 `/foo`。
 * @param {string} value - 待判定路径。
 * @param {NodeJS.Platform} [platform] - 平台（测试注入）。
 * @returns {boolean}
 */
export function isNativeAbsolute(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false
  if (platform === 'win32') return /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(value)
  return value.startsWith('/')
}

/**
 * 从 legacy 备份文本里提取来源设备的主目录候选。
 * 只在没有便携 token 的旧备份上调用；`sourceHome` 显式给出时以它为准。
 * @param {string} text - 待扫描文本。
 * @param {{sourceHome?: string}} [input] - 显式来源主目录。
 * @returns {string[]} 候选主目录（去重，长度降序——长前缀先替换）。
 */
export function legacySourceHomes(text, input = {}) {
  const found = new Set()
  if (typeof input.sourceHome === 'string' && input.sourceHome.trim() !== '') found.add(input.sourceHome.trim())
  if (typeof text === 'string' && text !== '') {
    for (const match of text.match(new RegExp(LEGACY_HOME_RE.source, 'gu')) ?? []) found.add(match)
  }
  return [...found].sort((a, b) => b.length - a.length)
}

/**
 * 解析会话存储根：配置为空时取 <dshHome>/sessions（dshHome 动态检测）。
 * 配置支持 `~` 与环境变量；目录是否真实存在由消费方（镜像/状态）处理。
 * @param {string} configured - Config.sessionRoot（'' = 默认）。
 * @param {string|undefined} [dshHome] - DSH home（测试注入）。
 * @returns {string} 绝对路径。
 */
export function resolveSessionRoot(configured, dshHome = detectDshHome()) {
  const explicit = expandUserPath(configured)
  if (explicit !== '') return path.resolve(explicit)
  if (typeof dshHome === 'string' && dshHome.length > 0) {
    return path.join(dshHome, 'sessions')
  }
  throw badConfig('sessionRoot is empty and DSH home could not be detected; set sessionRoot explicitly')
}

/**
 * 解析同步仓库工作树根：配置为空时取 <dshHome>/dsh-session-sync/repo。
 * 配置支持 `~` 与环境变量。
 * @param {string} configured - Config.repoDir（'' = 默认）。
 * @param {string|undefined} [dshHome] - DSH home（测试注入）。
 * @returns {string} 绝对路径。
 */
export function resolveRepoDir(configured, dshHome = detectDshHome()) {
  const explicit = expandUserPath(configured)
  if (explicit !== '') return path.resolve(explicit)
  if (typeof dshHome === 'string' && dshHome.length > 0) {
    return path.join(dshHome, 'dsh-session-sync', 'repo')
  }
  throw badConfig('repoDir is empty and DSH home could not be detected; set repoDir explicitly')
}

/**
 * 两目录不得互相包含：镜像会把 sessionRoot 复制进 repoDir（或反之时递归）。
 * @param {string} sessionRoot - 已解析的会话存储根。
 * @param {string} repoDir - 已解析的同步仓库根。
 * @returns {void} 违反时抛 BAD_CONFIG。
 */
export function assertNestingSafe(sessionRoot, repoDir) {
  const inside = (a, b) => {
    const rel = path.relative(a, b)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  if (inside(sessionRoot, repoDir)) {
    throw badConfig(`repoDir ${JSON.stringify(repoDir)} must not be inside sessionRoot ${JSON.stringify(sessionRoot)} (the mirror would copy itself)`)
  }
  if (inside(repoDir, sessionRoot)) {
    throw badConfig(`sessionRoot ${JSON.stringify(sessionRoot)} must not be inside repoDir ${JSON.stringify(repoDir)} (the mirror would copy itself)`)
  }
}

/**
 * 校验会话文件的相对路径：拒绝绝对路径、空段、`.`/`..`、反斜杠与越界。
 * 镜像与 fork 路径拼接的唯一入口。
 * @param {string} rel - 相对路径（POSIX 分隔）。
 * @returns {string} 规范化后的同一相对路径。
 */
export function assertRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw pathUnsafe('relative path must be a non-empty string')
  }
  if (rel.includes('\\') || rel.includes('\0')) {
    throw pathUnsafe(`relative path contains reserved characters: ${JSON.stringify(rel)}`)
  }
  const segments = rel.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw pathUnsafe(`relative path contains traversal segment: ${JSON.stringify(rel)}`)
    }
  }
  return rel
}

/**
 * 段是否形如文件名（含扩展名；排除空段与 `.`/`..`）。
 * 用于区分旧扁平布局的 `<id>/<file>` 与新布局的 `<projectKey>/<sessionId>`。
 * @param {string} segment - 单个路径段。
 * @returns {boolean} 形如文件名为 true。
 */
function looksLikeFileSegment(segment) {
  return segment.length > 0 && segment !== '.' && segment !== '..' && segment.includes('.')
}

/**
 * 解码宿主 `encodeSegment` 的 `~XXXX` 转义（逆运算；宿主
 * session-persistence-jsonl/src/format.ts:198-213）。无转义时原样返回；
 * 宿主把 `~` 本身也转义成 `~007E`，故单遍替换即无损可逆。
 * @param {string} segment - 已编码的单个路径段。
 * @returns {string} 解码后的段。
 */
export function decodeSegment(segment) {
  return segment.replace(/~([0-9A-Fa-f]{4})/gu, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * fork 相对路径 → 会话 id。
 *
 * 主锚点 = fork 文件名本身（`forkFileName` 的命名规则，FORK_NAME_RE）：fork 文件
 * 永远与被 fork 的文件同目录，故会话 id 恒为其**父目录段**——与布局深度无关
 * （宿主 <mirrorDir>/<projectKey>/<sessionId>/<file> 与旧扁平
 * <mirrorDir>/<sessionId>/<file> 同解，深度不再是判据）。
 * 非 fork 路径保留既有宽松映射（≥4 段取第 2 段；3 段且末段形如文件名取第 1 段，
 * 人工批准项①），因为调用方也用它把普通镜像文件归到会话。
 * 其余形态（根级文件、目录、空段/`..`、非镜像前缀）→ undefined。
 * @param {string} forkPath - 镜像相对路径（POSIX 分隔）。
 * @param {string} [mirrorDir] - 镜像目录名（默认 MIRROR_DIR）。
 * @returns {string|undefined} 解码后的会话 id；无法映射时 undefined。
 */
export function sessionIdOfForkPath(forkPath, mirrorDir = MIRROR_DIR) {
  if (typeof forkPath !== 'string' || forkPath.length === 0) return undefined
  const parts = forkPath.split('/')
  if (parts[0] !== mirrorDir) return undefined
  for (let index = 1; index < parts.length; index += 1) {
    const segment = parts[index]
    if (segment.length === 0 || segment === '.' || segment === '..') return undefined
  }
  const anchor = parts[parts.length - 1]
  if (parts.length >= 3 && FORK_NAME_RE.test(anchor)) {
    return decodeSegment(parts[parts.length - 2])
  }
  if (parts.length >= 4) {
    return decodeSegment(parts[2])
  }
  if (parts.length === 3 && looksLikeFileSegment(parts[2])) {
    return decodeSegment(parts[1])
  }
  return undefined
}

/**
 * 相对路径 → 工作树镜像路径（<repoDir>/sessions/<rel>）。
 * @param {string} repoDir - 同步仓库根。
 * @param {string} mirrorDir - 镜像目录名（MIRROR_DIR）。
 * @param {string} rel - 已校验的相对路径。
 * @returns {string} 工作树内绝对路径。
 */
export function mirrorPathOf(repoDir, mirrorDir, rel) {
  return path.join(repoDir, mirrorDir, ...assertRelPath(rel).split('/'))
}

/**
 * fork 文件名：<basename>.remote-fork-<UTC 14 位时间戳>-<设备短 id>。
 * 同一目录内同一时刻的冲突靠设备 id 区分；绝不覆盖既有 fork 文件。
 * @param {string} basename - 原文件名。
 * @param {string} timestampUtc - UTC 时间戳（yyyyMMddHHmmss）。
 * @param {string} deviceShort - 设备短 id（≤ 8 位小写十六进制）。
 * @returns {string} fork 文件名。
 */
export function forkFileName(basename, timestampUtc, deviceShort) {
  const stamp = /^\d{14}$/u.test(timestampUtc) ? timestampUtc : '19700101000000'
  const device = /^[0-9a-z]{1,8}$/iu.test(deviceShort) ? deviceShort.toLowerCase() : 'unknown'
  return `${basename}.remote-fork-${stamp}-${device}`
}
