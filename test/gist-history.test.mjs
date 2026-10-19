import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { archiveHistory, providerFrom, unlockEncryption, lockEncryption } from '../lib/cloud-core.mjs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const name = key => 'dsh-cloud-sync-v1-' + createHash('sha256').update(key).digest('hex').slice(0, 40) + '.b64'
const indexKey = 'snapshots/history/index.json'
function setup({ fail = false, noHistory = false } = {}) {
  const files = {}
  const entries = noHistory ? [] : Array.from({length: 7}, (_, i) => ({ key: 'snapshots/history/old-' + i, createdAt: String(i) }))
  for (const entry of entries) files[name(entry.key)] = { content: Buffer.from('old').toString('base64') }
  files[name(indexKey)] = { content: Buffer.from(JSON.stringify({ entries })).toString('base64') }
  const others = 200 - Object.keys(files).length
  for (let i = 0; i < others; i++) files['foreign-' + i] = { content: 'keep' }
  const patches = []
  const fetcher = async (_url, init = {}) => {
    if (init.method === 'PATCH') {
      const patch = JSON.parse(init.body).files
      patches.push(patch)
      if (fail) return new Response(JSON.stringify({ message: 'rejected' }), { status: 422 })
      const next = { ...files }
      for (const [key, value] of Object.entries(patch)) { if (value === null) delete next[key]; else next[key] = value }
      assert.ok(Object.keys(next).length <= 200)
      for (const key of Object.keys(files)) delete files[key]
      Object.assign(files, next)
    }
    return new Response(JSON.stringify({ files }), { headers: { etag: '"test"' } })
  }
  return { files, entries, patches, fetcher }
}
async function execute(fixture) {
  const original = globalThis.fetch
  globalThis.fetch = fixture.fetcher
  try {
    const provider = providerFrom({ provider: { type: 'gist', token: 'test-token', gistId: 'test-gist' } })
    return await archiveHistory(provider, { createdAt: '2026-10-17T00:00:00.000Z' }, Buffer.from('snapshot'), { deviceId: 'device', deviceName: 'test', changes: [], limit: 30 })
  } finally { globalThis.fetch = original }
}
test('full Gist rolls history in one PATCH without touching other-domain files', async () => {
  const f = setup()
  const entry = await execute(f)
  assert.equal(f.patches.length, 1)
  const index = JSON.parse(Buffer.from(f.files[name(indexKey)].content, 'base64').toString('utf8'))
  assert.equal(index.entries[0].key, entry.key)
  assert.equal(index.entries.length, 6)
  assert.equal(Object.keys(f.files).length, 199)
  for (const [key, value] of Object.entries(f.patches[0])) if (value === null) assert.ok(f.entries.some(e => name(e.key) === key))
  assert.equal(f.files['foreign-0'].content, 'keep')
})
test('rejected PATCH preserves all prior archives and index', async () => {
  const f = setup({ fail: true })
  const before = JSON.stringify(f.files)
  await assert.rejects(execute(f), /HTTP 422/)
  assert.equal(JSON.stringify(f.files), before)
  assert.equal(f.patches.length, 1)
})
test('encrypted history atomic PATCH keeps archive and index encrypted and readable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-history-encryption-'))
  const original = globalThis.fetch
  try {
    await mkdir(join(home, 'dsh-cloud-sync'))
    const settings = { provider: { type: 'gist', gistId: 'test-gist', token: 'test-token' }, encryption: { enabled: false } }
    await writeFile(join(home, 'dsh-cloud-sync', 'settings.json'), JSON.stringify(settings))
    await unlockEncryption({ passphrase: 'history-test-passphrase', enable: true }, { home })
    const provider = providerFrom({ ...settings, encryption: { enabled: true } }, home)
    const f = setup()
    globalThis.fetch = f.fetcher
    const payload = Buffer.from('private snapshot test content')
    const entry = await archiveHistory(provider, { createdAt: '2026-10-17T00:00:00.000Z' }, payload, { deviceId: 'test', deviceName: 'test', changes: [], limit: 30 })
    assert.equal(f.patches.length, 1)
    for (const key of [entry.key, indexKey]) {
      const stored = Buffer.from(f.files[name(key)].content, 'base64')
      assert.equal(JSON.parse(stored.toString('utf8')).format, 'dsh-cloud-sync/encrypted/v1')
      assert.equal(stored.includes(payload), false)
    }
    assert.deepEqual(await provider.get(entry.key), payload)
    const index = JSON.parse((await provider.get(indexKey)).toString('utf8'))
    assert.equal(index.entries[0].key, entry.key)
  } finally {
    globalThis.fetch = original
    await lockEncryption({ home })
    await rm(home, { recursive: true, force: true })
  }
})

test('no budget fails before any mutation', async () => {
  const f = setup({ noHistory: true })
  await assert.rejects(execute(f), /no file budget/)
  assert.equal(f.patches.length, 0)
})
