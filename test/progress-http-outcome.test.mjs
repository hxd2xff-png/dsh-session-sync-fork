import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { route } from '../lib/api.mjs'
import { ProgressRegistry } from '../lib/progress.mjs'

// 执行index真实包装表达式、真实HTTP路由及进度注册表；云端提供方全部隔离。
async function invoke({ body = '{}', method = 'POST', crossSite = false, businessError = false, businessFailure = false } = {}) {
  const source = await fs.readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('handler: async (request, response) => withCloudOperation')
  const end = source.indexOf('\n      }\n    })', start)
  assert(start >= 0 && end > start)
  const expression = source.slice(start + 'handler: '.length, end).trim().replace(/,$/, '')
  const item = { path: '/api/dsh-session-sync/cloud/snapshot/push' }
  let businessCalls = 0, sink
  const inner = route(item.path, 'GET', async () => {
    businessCalls++
    if (businessError) throw new Error('隔离业务错误')
    if (businessFailure) {
      sink({ error: '备份冲突需要选择' })
      return { ok: false, direction: 'needs-choice', error: '备份冲突需要选择' }
    }
    return { direction: 'uploaded' }
  }).handler
  const progress = new ProgressRegistry()
  const handler = new Function('withCloudOperation', 'label', 'item', 'route', 'progress', 'kind', 'action', 'inner', 'setCloudProgressSink', 'messageOf', `return (${expression})`)(
    async (_kind, operation) => operation(), '插件备份', item, route, progress, 'plugin', 'backup', inner, value => { sink = value }, error => error.message,
  )
  const request = { method, url: item.path, headers: { host: '127.0.0.1:8766', 'sec-fetch-site': crossSite ? 'cross-site' : 'same-origin' }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(body) } }
  const response = { statusCode: 200, writeHead(status) { this.statusCode = status }, end(bytes) { this.body = JSON.parse(bytes) } }
  await handler(request, response)
  return { response, businessCalls, entry: progress.snapshot().entries[0], sink }
}

for (const [status, options, calls] of [[400, { body: '{' }, 0], [403, { crossSite: true }, 0], [405, { method: 'PUT' }, 0], [500, { businessError: true }, 1]]) {
  test(`HTTP${status}拒绝不得登记为备份成功`, async () => {
    const result = await invoke(options)
    assert.equal(result.response.statusCode, status)
    assert.equal(result.businessCalls, calls)
    assert.equal(result.entry.state, 'finished')
    assert.equal(result.entry.ok, false)
    assert.match(result.entry.error, new RegExp(String(status)))
    assert.notEqual(result.entry.percent, 100)
    assert.equal(result.sink, null)
  })
}

test('HTTP200正常完成仍登记成功', async () => {
  const result = await invoke()
  assert.equal(result.response.statusCode, 200)
  assert.equal(result.businessCalls, 1)
  assert.equal(result.entry.ok, true)
  assert.equal(result.entry.percent, 100)
  assert.equal(result.sink, null)
})

test('HTTP200但业务冲突失败仍保留错误，不被HTTP成功覆盖', async () => {
  const result = await invoke({ businessFailure: true })
  assert.equal(result.response.statusCode, 200)
  assert.equal(result.entry.ok, false)
  assert.equal(result.entry.error, '备份冲突需要选择')
  assert.notEqual(result.entry.percent, 100)
  assert.equal(result.sink, null)
})
