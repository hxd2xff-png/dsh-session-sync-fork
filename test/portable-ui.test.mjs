import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { buildRoutes, OperationGate } from '../lib/api.mjs'
import { API_PREFIX } from '../lib/constants.mjs'

async function mount({ auxiliary = false } = {}) {
  /** @type {any} */
let descriptor, Main, current
  const state = new Map(), refs = new Map(), requests = []
  const sha = 'a'.repeat(40), foreign = 'Z:/Users/old/project', local = 'D:/Projects/local'
  state.set('SessionSyncPage', [undefined, undefined, undefined, undefined, [{ sha, at: 1, subject: 'backup' }]])
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  const React = { createElement: h,
    useState(initial) {
      const owner = current.name, index = current.state++
      if (!state.has(owner)) state.set(owner, [])
      const slots = state.get(owner)
      if (slots[index] === undefined) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial) {
      const key = current.name + ':' + current.ref++
      if (!refs.has(key)) refs.set(key, { current: initial })
      return refs.get(key)
    },
    useCallback: fn => fn, useEffect() {},
  }
  const document = { head: { append() {} }, querySelector() { return null }, createElement() { return { dataset: {}, showModal() {} } } }
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {}
    requests.push({ url, body })
    const projects = auxiliary ? [{ source: local, target: local, requiresSelection: false }] : [{ source: foreign, target: body.projectPaths?.[foreign] ?? '', suggested: local, requiresSelection: !body.projectPaths }]
    const artifacts = auxiliary ? { auxiliaryCount: 1, auxiliaryFiles: ['session-artifact-20261016-143854.zstd'], artifactDir: 'D:/DSH/snapshots/restore-artifacts-test' } : {}
    const value = url.endsWith('/restore/preview') ? { preview: { ok: true, totalFiles: 1, missing: 1, projects, ...artifacts } } : { result: { ok: true, replaced: 1, preserved: 0, ...artifacts }, commits: [] }
    return { ok: true, json: async () => ({ ok: true, value }) }
  }
  vm.runInNewContext(await fs.readFile(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => { descriptor = value } } }, document, navigator: { language: 'zh-CN' }, fetch })
  const plugin = descriptor.factory(name => { assert.equal(name, 'react'); return React })
  plugin.apply({ slots: { inject(_name, fn) { fn() }, register(meta, component) { if (meta.name === 'main') Main = component; return null } } })
  function visit(node, nodes = []) {
    if (Array.isArray(node)) { for (const child of node) visit(child, nodes); return nodes }
    if (node === null || typeof node !== 'object') return nodes
    if (typeof node.type === 'function') { const previous = current; current = { name: node.type.name, state: 0, ref: 0 }; const child = node.type(node.props); current = previous; return visit(child, nodes) }
    nodes.push(node); visit(node.props?.children, nodes); return nodes
  }
  const render = () => visit(h(Main, {}))
  return { render, state, requests, foreign, local }
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

test('真实还原按钮先确认目标目录，再预览并将映射传给全量还原API', async () => {
  const app = await mount()
  let nodes = app.render()
  const button = nodes.find(node => node.type === 'button' && text(node) === '全量还原')
  assert(button)
  const pending = button.props.onClick()
  await nextTurn()
  nodes = app.render()
  const dialog = nodes.find(node => node.type === 'dialog' && node.props['aria-label'] === '确认目标设备项目目录')
  assert(dialog)
  const input = nodes.find(node => node.type === 'input' && node.props.id === 'ss-restore-path-0')
  assert.equal(input.props.required, true)
  const chosen = 'E:/Actual Project'
  input.props.onChange({ target: { value: chosen } })
  nodes = app.render()
  const form = nodes.find(node => node.type === 'form' && text(node).includes('核对目录并继续'))
  form.props.onSubmit({ preventDefault() {} })
  await nextTurn()
  nodes = app.render()
  const confirm = nodes.find(node => node.type === 'button' && text(node) === '确认')
  assert(confirm)
  confirm.props.onClick()
  await pending
  const apply = app.requests.find(item => item.url.endsWith('/restore/overwrite/apply'))
  assert.equal(apply.body.projectPaths[app.foreign], chosen)
  assert.equal(app.requests.filter(item => item.url.endsWith('/restore/preview')).length, 2)
})

test('目录选择取消时不提交任何会话还原写入', async () => {
  const app = await mount()
  const button = app.render().find(node => node.type === 'button' && text(node) === '全量还原')
  const pending = button.props.onClick()
  await nextTurn()
  const dialog = app.render().find(node => node.type === 'dialog' && node.props['aria-label'] === '确认目标设备项目目录')
  dialog.props.onCancel({ preventDefault() {} })
  await pending
  assert(!app.requests.some(item => item.url.endsWith('/restore/overwrite/apply')))
})

test('三条会话还原路由逐项透传项目目录映射，保持同源互斥约束', async () => {
  for (const [suffix, key] of [['/restore/preview', 'previewRestore'], ['/restore/merge', 'mergeRestore'], ['/restore/overwrite/apply', 'overwriteApply']]) {
    const seen = [], mapping = { 'C:/old/project': 'D:/local/project' }
    const route = buildRoutes({ gate: new OperationGate(), [key]: async (...args) => { seen.push(args); return { ok: true } } }).find(item => item.path === API_PREFIX + suffix)
    const request = { method: 'POST', url: route.path, headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ commit: 'a'.repeat(40), projectPaths: mapping })) } }
    const response = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
    await route.handler(request, response)
    assert.equal(response.status, 200)
    assert.deepEqual(seen[0], ['a'.repeat(40), mapping])
  }
})

for (const mode of ['安全合并', '全量还原']) test(mode + '真实页面确认列出附属副本，成功结果展示原样保留目录', async () => {
  const app = await mount({ auxiliary: true })
  const button = app.render().find(node => node.type === 'button' && text(node) === mode)
  assert(button)
  const pending = button.props.onClick()
  await nextTurn()
  let nodes = app.render()
  assert(nodes.some(node => text(node).includes('附属备份将原样另存，不作为正式会话打开：1')))
  assert(nodes.some(node => text(node).includes('session-artifact-20261016-143854.zstd')))
  assert(!app.requests.some(item => /restore\/(merge|overwrite\/apply)$/u.test(item.url)))
  const confirm = nodes.find(node => node.type === 'button' && text(node) === '确认')
  assert(confirm); confirm.props.onClick()
  await pending
  nodes = app.render()
  assert(nodes.some(node => text(node).includes('附属备份已保留：1 · D:/DSH/snapshots/restore-artifacts-test')))
  assert(app.requests.some(item => item.url.endsWith(mode === '安全合并' ? '/restore/merge' : '/restore/overwrite/apply')))
})
