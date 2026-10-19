// GistProvider.removeMany 契约测试：必须过滤掉远端不存在的键——
// 实测 GitHub 对删除不存在的文件返回 HTTP 422（2026-10-15 probe 输出）。
// 临时替换 globalThis.fetch 捕获 PATCH 请求体，测试结束恢复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { providerFrom } from '../lib/cloud-core.mjs'

// 与 cloud-core 的 gistObjectFileName 同构（GIST_FILE_PREFIX + sha256(key) 前 40 位）。
const gistName = (key) => `dsh-cloud-sync-v1-${createHash('sha256').update(Buffer.from(key)).digest('hex').slice(0, 40)}.b64`

function makeFetch(existingKeys, recorder) {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET'
    if (method === 'GET') {
      const files = {}
      for (const key of existingKeys) files[gistName(key)] = { content: 'x' }
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'etag' ? '"abc"' : null) },
        json: async () => ({ files }),
      }
    }
    const body = JSON.parse(init.body)
    recorder.push({ method, files: body.files })
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }
  }
}

test('removeMany 只提交远端存在的键（不存在键不触发 422 请求）', async () => {
  const original = globalThis.fetch
  const recorder = []
  const provider = providerFrom({ provider: { type: 'gist', gistId: 'g1', token: 't1' }, encryption: { enabled: false } })
  try {
    /** @type {any} */ (globalThis).fetch = makeFetch(['skills/keep.json.gz'], recorder)
    // 两个键都不在远端 → 过滤后为空 → 不发 PATCH。
    await /** @type {any} */ (provider).removeMany(['skills/a.json.gz', 'skills/b.json.gz'])
    assert.equal(recorder.filter(entry => entry.method === 'PATCH').length, 0, '全部不存在时不应发 PATCH')
    // 混合：一个存在一个不存在 → PATCH 只携带存在的那个。
    await /** @type {any} */ (provider).removeMany(['skills/keep.json.gz', 'skills/missing.json.gz'])
    const patches = recorder.filter(entry => entry.method === 'PATCH')
    assert.equal(patches.length, 1, `应恰好一次 PATCH，实际 ${patches.length}`)
    const names = Object.keys(patches[0].files)
    assert.deepEqual(names, [gistName('skills/keep.json.gz')])
    assert.equal(patches[0].files[names[0]], null)
  } finally {
    globalThis.fetch = original
  }
})
