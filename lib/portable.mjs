// Portable archive references. Never apply these transformations to session events.
import { detectDshHome, detectSkillsRoot, legacySourceHomes, userHomeDir } from './paths.mjs'

const TOKENS = { sourceRoot: '__DSH_SOURCE_ROOT__', skillsRoot: '__DSH_SKILLS_ROOT__', dshHome: '__DSH_HOME__', userHome: '__DSH_USER_HOME__' }
const TEXT = /(?:^|\/)(?:[^/]+\.(?:json|ya?ml|toml|ini|txt|md|[cm]?js|[cm]?ts|py|sh|ps1|cmd|bat)|\.npmrc)$/iu
const slash = value => value.replaceAll('\\', '/')
const escape = value => value.replace(/[.*+?^$\{\}()|[\]\\]/gu, '\\$&')

/**
 * 目标设备的根集合。每一项都动态识别（每台设备的用户目录、DSH home、技能库
 * 位置都不同）：显式入参 → 环境变量 → 平台默认。绝不复用来源设备的路径。
 * @param {object} [input] - 覆盖项（userHome / dshHome / skillsRoot / env）。
 * @returns {{userHome?: string, dshHome?: string, skillsRoot?: string, [key: string]: any}} 目标根。
 */
export function targetRoots(input = {}) {
  const env = input.env ?? process.env
  const userHome = input.userHome ?? userHomeDir(env)
  return {
    ...input,
    userHome,
    dshHome: input.dshHome ?? detectDshHome(undefined, env),
    skillsRoot: input.skillsRoot ?? detectSkillsRoot({ userHome, env }),
  }
}

function substitute(text, from, to) {
  if (!from) return text
  const variants = new Set([from, slash(from), from.replaceAll('\\', '\\\\')])
  for (const root of [...variants].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(escape(root.replace(/[/\\]+$/u, '')) + '(?=$|[/\\\\]|["\x27\x60\\s<>),;])([/\\\\]+[^"\x27\x60\\r\\n<>]*)?', 'gu')
    text = text.replace(re, (_match, suffix = '') => slash(to) + suffix.replace(/\\+/gu, '/'))
  }
  return text
}

export function portableText(text, roots = targetRoots()) {
  for (const key of Object.keys(TOKENS)) text = substitute(text, roots[key], TOKENS[key])
  return text
}

/**
 * 把来源设备的绝对路径映射成本机路径。
 *
 * 三条来源通道，按优先级：
 *  1. 便携 token（`__DSH_USER_HOME__` 等）→ 解析到本机对应根；
 *  2. 显式 `input.sourceHome`（调用方已知来源主目录时直接给）；
 *  3. legacy 旧备份里扫出的来源主目录形态（Windows `C:\Users\x`、
 *     `C:\Documents and Settings\x`，POSIX `/Users/x`、`/home/x`、`/root`）。
 * 来源主目录一律先替换成 `<home>/.agents/skills`、`<home>/.dsh`，再替换裸 home，
 * 否则长前缀会被短前缀抢先吞掉。
 * @param {string} text - 原始文本。
 * @param {object} [input] - {userHome?, dshHome?, skillsRoot?, sourceHome?, legacy?, env?}。
 * @returns {string} 本机路径文本。
 */
export function localText(text, input = {}) {
  const roots = targetRoots(input)
  const legacy = input.legacy !== false && !Object.values(TOKENS).some(token => text.includes(token))
  for (const [key, token] of Object.entries(TOKENS)) {
    if (text.includes(token) && !roots[key]) throw new Error('Missing target path: ' + key)
    text = substitute(text, token, roots[key] ?? token)
  }
  const homes = legacy ? legacySourceHomes(text, { sourceHome: input.sourceHome }) : []
  for (const home of homes) {
    const sep = home.includes('\\\\') ? '\\\\' : home.includes('\\') ? '\\' : '/'
    text = substitute(text, home + sep + '.agents' + sep + 'skills', roots.skillsRoot)
    text = substitute(text, home + sep + '.dsh', roots.dshHome)
    text = substitute(text, home, roots.userHome)
  }
  text = text.replace(/~\//gu, slash(roots.userHome) + '/')
  return text
}

function mapJson(value, transform) {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map(item => mapJson(item, transform))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapJson(item, transform)]))
  return value
}

export function portableFile(name, bytes, roots, restore = false) {
  if (!TEXT.test(name)) return bytes
  const text = bytes.toString('utf8')
  if (text.includes('\uFFFD') || text.includes('\0')) return bytes
  const legacy = !Object.values(TOKENS).some(token => text.includes(token)) && !text.includes('__DSH_PLUGIN_SOURCE__')
  const transform = value => restore ? localText(value, { ...roots, legacy }) : portableText(value, roots)
  if (name.endsWith('.json')) {
    try {
      const parsed = JSON.parse(text)
      const mapped = mapJson(parsed, transform)
      if (!restore && /(?:^|\/)package\.json$/u.test(name)) {
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          for (const [key, spec] of Object.entries(mapped[field] ?? {})) {
            if (typeof spec === 'string' && /^(?:file:|link:|\.|[A-Za-z]:[\\/]|\/)/u.test(spec)) mapped[field][key] = 'file:__DSH_PLUGIN_SOURCE__/' + key
          }
        }
      }
      return JSON.stringify(mapped) === JSON.stringify(parsed) ? bytes : Buffer.from(JSON.stringify(mapped, null, 2) + '\n')
    }
    catch (error) { if (!(error instanceof SyntaxError)) throw error }
  }
  return Buffer.from(transform(text))
}

export function portableFiles(files, roots, restore = false) {
  return files.map(item => ({ ...item, data: portableFile(item.path, Buffer.from(item.data, 'base64'), roots, restore).toString('base64') }))
}
