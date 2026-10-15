// test/reclaim-orphans.test.mjs — 孤儿回收契约：只删无索引引用的本插件前缀对象。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { reclaimOrphanObjects } from '../lib/cloud-core.mjs'

const gistName = (key) => `dsh-cloud-sync-v1-${createHash('sha256').update(Buffer.from(key)).digest('hex').slice(0, 40)}.b64`

class GistLike {
  constructor(objects) { this.objects = new Map(Object.entries(objects)) } // name -> Buffer
  async getWithMeta(key) {
    const name = gistName(key)
    const body = this.objects.get(name)
    if (body === undefined) throw new Error(`GitHub Gist GET ${key} failed: HTTP 404`)
    return { body, etag: `"${body.length}"` }
  }
  async put(key, body) { this.objects.set(gistName(key), Buffer.from(body)) }
  async listObjects() { return [...this.objects.keys()] }
  async removeObjects(names) { for (const name of names) this.objects.delete(name) }
}

test('回收删孤儿、保留索引引用/系统文件/非本插件前缀', async () => {
  const snapshotKey = 'snapshots/history/2026-01-01-aaaa.json.gz'
  const skillKey = 'skills/dws-ffff-p1of6.json.gz'
  const provider = new GistLike({
    [gistName('snapshots/latest.json.gz')]: Buffer.from('latest'),
    [gistName('snapshots/history/index.json')]: Buffer.from(JSON.stringify({ schema: 'dsh-cloud-sync/v1', entries: [{ key: snapshotKey, createdAt: 'x', changes: [] }] })),
    [gistName('skills/index.json')]: Buffer.from(JSON.stringify({ schema: 'dsh-cloud-sync/v1', entries: [{ key: 'skills/batch-1', keys: [skillKey], skills: ['dws'], createdAt: 'x' }] })),
    'dsh-cloud-sync-v1.json': Buffer.from('marker'),
    [gistName(snapshotKey)]: Buffer.from('referenced-snapshot'),
    [gistName(skillKey)]: Buffer.from('referenced-skill'),
    [gistName('skills/orphan-aaaa-p1of2.json.gz')]: Buffer.from('orphan-skill'),
    'dsh-cloud-sync-v1-unlisted0000.b64': Buffer.from('orphan-unlisted'),
    'some-foreign-file.txt': Buffer.from('not-ours'),
  })
  const result = await reclaimOrphanObjects({ provider, sourceKeys: ['sources/x.tgz'] })
  assert.equal(result.supported, true)
  assert.deepEqual(result.removed.sort(), [gistName('skills/orphan-aaaa-p1of2.json.gz'), 'dsh-cloud-sync-v1-unlisted0000.b64'].sort())
  // 被引用的、latest、两个索引、marker、外来文件全部保留。
  assert.equal(provider.objects.has(gistName(snapshotKey)), true)
  assert.equal(provider.objects.has(gistName(skillKey)), true)
  assert.equal(provider.objects.has(gistName('snapshots/latest.json.gz')), true)
  assert.equal(provider.objects.has('dsh-cloud-sync-v1.json'), true)
  assert.equal(provider.objects.has('some-foreign-file.txt'), true)
  assert.equal(result.kept, 7)
})

test('提供方不支持列举时如实返回 supported:false，不动远端', async () => {
  class Plain {
    constructor() { this.touched = false }
    async getWithMeta() { throw new Error('HTTP 404') }
    async put() { this.touched = true }
  }
  const provider = new Plain()
  const result = await reclaimOrphanObjects({ provider, sourceKeys: ['x'] })
  assert.deepEqual(result, { supported: false, removed: [], kept: 0 })
  assert.equal(provider.touched, false)
})

test('包装层虽暴露 listObjects 但底层返回 undefined 时不崩溃', async () => {
  const provider = {
    async listObjects() { return undefined },
    async removeObjects() { throw new Error('不应调用') },
    async getWithMeta() { throw new Error('HTTP 404') },
  }
  const result = await reclaimOrphanObjects({ provider, sourceKeys: ['x'] })
  assert.deepEqual(result, { supported: false, removed: [], kept: 0 })
})
