// test/routes.test.mjs — 路由表契约（宿主 webServer 只按 path 做键）。
//
// 这是本轮 404 故障的回归门：宿主 WebServer.register() 的 exact 表以 path
// 为键，同一路径注册两次会抛 duplicate route 并中断后续注册——表现为页面
// 首屏请求全部 404。因此「路径唯一」是硬约束，必须由测试守住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRoutes, requireCommit, OperationGate, isLoopback } from '../lib/api.mjs'
import { API_PREFIX } from '../lib/constants.mjs'

/** 构造一组最小可用的依赖桩。 */
function stubDeps(overrides = {}) {
  const noop = async () => ({})
  return {
    gate: new OperationGate(),
    status: async () => ({ ok: true, branch: 'main', remote: '<unset>', dirty: [], ahead: 0, behind: 0 }),
    loadConfig: async () => ({ remote: '', branch: 'main', schedule: {} }),
    saveConfig: async patch => ({ remote: patch.remote ?? '', branch: patch.branch ?? 'main', schedule: patch.schedule ?? {} }),
    updateSchedule: async () => ({}),
    verifyRemote: noop,
    history: async () => ({ ok: true, commits: [] }),
    deleteHistory: async commit => ({ ok: true, deleted: commit }),
    backup: noop,
    previewRestore: noop,
    mergeRestore: noop,
    prepareOverwrite: noop,
    pendingRestores: async () => ({ pending: null }),
    cancelRestore: async () => ({ pending: null }),
    scheduleInfo: () => ({}),
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  }
}

test('路由路径必须唯一（宿主按 path 做键，重复即抛错）', () => {
  const routes = buildRoutes(stubDeps())
  const seen = new Map()
  for (const item of routes) {
    const key = `${item.kind}:${item.path}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1)
  assert.deepEqual(duplicates, [], `重复路由会导致 register 抛错并中断后续注册：${JSON.stringify(duplicates)}`)
})

test('全部路由均为 exact 且以统一前缀开头', () => {
  for (const item of buildRoutes(stubDeps())) {
    assert.equal(item.kind, 'exact', `${item.path} 应为 exact`)
    assert.ok(item.path.startsWith(`${API_PREFIX}/`), `${item.path} 前缀不正确`)
    assert.equal(typeof item.handler, 'function', `${item.path} 缺少 handler`)
  }
})

test('首屏必需的三条路由都已注册', () => {
  const paths = new Set(buildRoutes(stubDeps()).map(item => item.path))
  for (const need of ['/status', '/history', '/restore/pending']) {
    assert.ok(paths.has(`${API_PREFIX}${need}`), `缺少首屏路由 ${need}——会导致打开页面即 404`)
  }
})

test('删除历史路由已注册', () => {
  const paths = new Set(buildRoutes(stubDeps()).map(item => item.path))
  assert.ok(paths.has(`${API_PREFIX}/history/delete`))
})

test('settings 单条路由同时处理 GET 与 POST', async () => {
  const routes = buildRoutes(stubDeps())
  const settings = routes.filter(item => item.path === `${API_PREFIX}/settings`)
  assert.equal(settings.length, 1, 'settings 只能有一条路由')

  const call = (method) => {
    const res = { statusCode: 0, body: null, writeHead(code) { this.statusCode = code }, end(text) { this.body = JSON.parse(text) } }
    return { req: { method, url: `${API_PREFIX}/settings`, headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' } }, res }
  }

  // GET → 读配置
  const g = call('GET')
  await settings[0].handler(g.req, g.res)
  assert.equal(g.res.statusCode, 200)
  assert.equal(g.res.body.ok, true)
  assert.ok('config' in g.res.body.value, 'GET 应返回 config')

  // POST → 写配置（需要可读的请求体）
  const p = call('POST')
  p.req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify({ remote: 'git@example.com:a/b.git' })) }
  await settings[0].handler(p.req, p.res)
  assert.equal(p.res.statusCode, 200)
  assert.equal(p.res.body.ok, true)
})

test('非回环来源被拒绝（403）', async () => {
  const routes = buildRoutes(stubDeps())
  const status = routes.find(item => item.path === `${API_PREFIX}/status`)
  const res = { statusCode: 0, body: null, writeHead(code) { this.statusCode = code }, end(text) { this.body = JSON.parse(text) } }
  await status.handler({ method: 'GET', url: `${API_PREFIX}/status`, headers: {}, socket: { remoteAddress: '10.0.0.5' } }, res)
  assert.equal(res.statusCode, 403)
})

test('跨站来源被拒绝', async () => {
  const routes = buildRoutes(stubDeps())
  const status = routes.find(item => item.path === `${API_PREFIX}/status`)
  const res = { statusCode: 0, writeHead(code) { this.statusCode = code }, end() {} }
  const req = {
    method: 'GET',
    url: `${API_PREFIX}/status`,
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await status.handler(req, res)
  assert.equal(res.statusCode, 403)
})

test('方法不匹配返回 405', async () => {
  const routes = buildRoutes(stubDeps())
  const backupRun = routes.find(item => item.path === `${API_PREFIX}/backup/run`)
  const res = { statusCode: 0, writeHead(code) { this.statusCode = code }, end() {} }
  await backupRun.handler({ method: 'GET', url: `${API_PREFIX}/backup/run`, headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.statusCode, 405)
})

test('requireCommit 拒绝非法提交号', () => {
  assert.equal(requireCommit({ commit: 'abc1234' }), 'abc1234')
  assert.throws(() => requireCommit({}), /commit/)
  assert.throws(() => requireCommit({ commit: 'zzz' }), /hex/)
  assert.throws(() => requireCommit({ commit: '../etc' }), /hex/)
})

test('isLoopback 判定', () => {
  const base = { headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' } }
  assert.equal(isLoopback(base), true)
  assert.equal(isLoopback({ ...base, socket: { remoteAddress: '192.168.1.9' } }), false)
  assert.equal(isLoopback({ ...base, headers: { host: 'evil.com' } }), false)
})

test('OperationGate 互斥：忙碌时拒绝第二个操作', async () => {
  const gate = new OperationGate()
  let release
  const first = gate.run('backup', () => new Promise((resolve) => { release = resolve }))
  await assert.rejects(() => gate.run('merge', async () => ({ ok: true })), /already running/)
  release({ ok: true })
  await first
  assert.equal(gate.busy, false)
})
