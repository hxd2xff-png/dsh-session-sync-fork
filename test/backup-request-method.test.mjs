import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { route } from '../lib/api.mjs'
import { SyncError } from '../lib/errors.mjs'

// 执行真实页面按钮，网络全部替换；不访问用户云端。
async function mountTab(name) {
  let descriptor, Main, current
  const state = new Map(), requests = []
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const React = { createElement: h, useEffect() {}, useCallback: fn => fn,
    useRef: value => ({ current: value }),
    useState(initial) {
      const key = current.name + ':' + current.index++
      if (!state.has(key)) state.set(key, typeof initial === 'function' ? initial() : initial)
      return [state.get(key), value => state.set(key, typeof value === 'function' ? value(state.get(key)) : value)]
    },
  }
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options })
    const value = url.endsWith('/snapshot/push') ? { direction: 'uploaded' } : {}
    return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
  }
  const document = { head: { append() {} }, querySelector: () => null, createElement: () => ({ dataset: {} }) }
  vm.runInNewContext(await fs.readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { descriptor = value } }, confirm: () => false },
    document, navigator: { language: 'zh-CN' }, fetch,
  })
  descriptor.factory(() => React).apply({ slots: {
    inject(_name, callback) { callback() },
    register(meta, component) { if (meta.name === 'main') Main = component },
  } })
  function find(node) {
    if (Array.isArray(node)) return node.map(find).find(Boolean)
    if (!node || typeof node !== 'object') return
    if (node.type?.name === name) return node
    return find(node.props?.children)
  }
  current = { name: 'SessionSyncPage', index: 0 }
  const tab = find(Main({}))
  assert(tab, '页面应挂载目标页签')
  function render() {
    current = { name, index: 0 }
    const nodes = []
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit)
      if (!node || typeof node !== 'object') return
      nodes.push(node); visit(node.props?.children)
    }
    visit(tab.type(tab.props))
    return nodes
  }
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
  return { requests, clickBackup() {
    const button = render().find(node => node.type === 'button' && text(node) === '立即备份')
    assert(button); button.props.onClick()
  } }
}

for (const [name, endpoint] of [['PluginBackupTab', '/snapshot/push'], ['SkillBackupTab', '/skill/push']]) {
  test(`${name}真实备份按钮首请求使用POST空对象而非GET`, async () => {
    const app = await mountTab(name)
    app.clickBackup()
    await new Promise(resolve => setImmediate(resolve))
    const request = app.requests.find(item => item.url.endsWith(endpoint))
    assert(request)
    assert.equal(request.method, 'POST')
    assert.equal(request.body, '{}')
    assert.equal(request.headers['content-type'], 'application/json')
  })
}

test('忙碌错误保留原路由方法约定，不被POST required遮盖', async () => {
  const source = await fs.readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('handler: async (request, response) => withCloudOperation')
  const end = source.indexOf('\n      }\n    })', start)
  assert(start >= 0 && end > start)
  const expression = source.slice(start + 'handler: '.length, end).trim().replace(/,$/, '')
  const item = { path: '/api/dsh-session-sync/cloud/snapshot/push' }
  const handler = new Function('withCloudOperation', 'label', 'item', 'route', `return (${expression})`)(
    async () => { throw new SyncError('BAD_CONFIG', '已有云端操作正在执行') }, '插件备份', item, route,
  )
  for (const method of ['GET', 'POST']) {
    const request = { method, url: item.path, headers: { host: '127.0.0.1:8766' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() {} }
    const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
    await handler(request, response)
    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'BAD_CONFIG')
    assert.equal(response.body.error, '已有云端操作正在执行')
  }
})
