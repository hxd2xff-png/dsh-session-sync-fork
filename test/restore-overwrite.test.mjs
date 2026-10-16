// 全量还原的新语义。真实 Git/文件系统；只在宿主日志检查和租约接口边界注入夹具。
// 真宿主解码/Windows 写租约另用安装中的实现做过集成验证；这里不模拟 overwriteApply 本身。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { overwriteApply } from '../lib/restore.mjs'

const exec = promisify(execFile)
const rel = (id) => 'project/' + id + '/session.v4.jsonl'
const log = (id, count, changed = false) => JSON.stringify({ type: 'session', version: 4, id, createdAt: 1 }) + '\n'
  + Array.from({ length: count }, (_, seq) => JSON.stringify({
    type: 'permission/preset', seq, time: seq + 2,
    data: { preset: changed && seq === 1 ? 'read-only' : 'workspace-write' },
  }) + '\n').join('')

// 宿主接口的夹具：核心只依赖“已校验头部与事件”，不依赖压缩编码的细节。
async function inspectLog(_rel, bytes) {
  const [meta, ...events] = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  for (const [seq, event] of events.entries()) assert.equal(event.seq, seq, 'seq gap')
  return { meta, events, inheritedEventCount: 0 }
}

async function fixture(t, backed, local = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sessionsync-overwrite-test-'))
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir())
    assert(path.basename(root).startsWith('sessionsync-overwrite-test-'))
    await fs.rm(root, { recursive: true, force: true })
  })
  const repo = path.join(root, 'repo'), sessionRoot = path.join(root, 'sessions')
  await fs.mkdir(repo, { recursive: true })
  await fs.mkdir(sessionRoot, { recursive: true })
  const git = async args => (await exec('git', args, { cwd: repo, encoding: 'buffer' })).stdout
  await git(['init', '-b', 'main'])
  await git(['config', 'user.name', 'test'])
  await git(['config', 'user.email', 'test@localhost'])
  for (const [file, bytes] of Object.entries(backed)) {
    const p = path.join(repo, 'sessions', file)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, bytes)
  }
  await git(['add', '-A'])
  await git(['commit', '-m', 'restore fixture'])
  const commit = (await git(['rev-parse', 'HEAD'])).toString('utf8').trim()
  for (const [file, bytes] of Object.entries(local)) {
    const p = path.join(sessionRoot, file)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, bytes)
  }
  const loaded = new Set(), held = new Set()
  let generation = 0
  const acquireWriteLease = async (_rel, meta) => {
    if (loaded.has(meta.id) || held.has(meta.id)) throw new Error('session already loaded or owned')
    held.add(meta.id)
    return { release: async () => { held.delete(meta.id) } }
  }
  const run = overrides => overwriteApply({
    git: {
      listFilesAtRev: async rev => (await git(['ls-tree', '-r', '--name-only', rev])).toString('utf8').trimEnd().split('\n'),
      readFileAtRev: async (rev, file) => git(['show', rev + ':' + file]),
    },
    commit, sessionRoot, snapshotDir: path.join(root, 'snapshots'),
    stagingDir: path.join(root, 'staging'), id: 'restore-' + (++generation),
    inspectLog, acquireWriteLease, ...overrides,
  })
  return { run, root, sessionRoot, loaded, held, acquireWriteLease,
    target: id => path.join(sessionRoot, rel(id)),
    read: id => fs.readFile(path.join(sessionRoot, rel(id)), 'utf8') }
}

test('全量还原保留本地追加事件、独有会话及日志 inode，第二轮仍能继续写', async t => {
  const f = await fixture(t, { [rel('a')]: log('a', 2) }, { [rel('a')]: log('a', 4), [rel('local-only')]: log('local-only', 1) })
  const inode = (await fs.stat(f.target('a'), { bigint: true })).ino
  f.loaded.add('a')
  for (let round = 0; round < 2; round++) {
    const r = await f.run()
    assert.equal(r.ok, true, r.error)
    assert.equal(r.replaced, 0)
    assert.equal(r.preserved, 1)
    const current = await inspectLog('', Buffer.from(await f.read('a')))
    const seq = current.events.length
    await fs.appendFile(f.target('a'), JSON.stringify({ type: 'permission/preset', seq, time: seq + 2, data: { preset: 'workspace-write' } }) + '\n')
  }
  assert.equal((await inspectLog('', Buffer.from(await f.read('a')))).events.length, 6)
  assert.equal(await f.read('local-only'), log('local-only', 1))
  assert.equal((await fs.stat(f.target('a'), { bigint: true })).ino, inode)
})

test('恢复较新备份与本地缺失会话，并保留修改前快照', async t => {
  const f = await fixture(t, { [rel('a')]: log('a', 4), [rel('b')]: log('b', 2) }, { [rel('a')]: log('a', 1) })
  const r = await f.run()
  assert.equal(r.ok, true, r.error)
  assert.equal(r.replaced, 2)
  assert.equal(await f.read('a'), log('a', 4))
  assert.equal(await f.read('b'), log('b', 2))
  assert.equal(await fs.readFile(path.join(r.snapshotDir, rel('a')), 'utf8'), log('a', 1))
  assert.equal(f.held.size, 0)
})

test('分叉拒绝发生在任何日志写入前', async t => {
  const f = await fixture(t, { [rel('a')]: log('a', 2), [rel('b')]: log('b', 3, true) }, { [rel('b')]: log('b', 3) })
  const r = await f.run()
  assert.equal(r.ok, false)
  assert.match(r.error, /分叉/u)
  assert.equal(await f.read('b'), log('b', 3))
  await assert.rejects(fs.access(f.target('a')), { code: 'ENOENT' })
})

test('已加载或占用的待恢复会话拒绝写入，已取得租约也必须释放', async t => {
  const f = await fixture(t, { [rel('a')]: log('a', 3), [rel('b')]: log('b', 3) }, { [rel('a')]: log('a', 1), [rel('b')]: log('b', 1) })
  f.loaded.add('b')
  const r = await f.run()
  assert.equal(r.ok, false)
  assert.match(r.error, /loaded or owned/u)
  assert.equal(await f.read('a'), log('a', 1))
  assert.equal(await f.read('b'), log('b', 1))
  assert.equal(f.held.size, 0)
})

test('预检后新增历史不得被还原覆盖', async t => {
  const f = await fixture(t, { [rel('a')]: log('a', 4) }, { [rel('a')]: log('a', 1) })
  const r = await f.run({ acquireWriteLease: async (...args) => {
    const lease = await f.acquireWriteLease(...args)
    await fs.writeFile(f.target('a'), log('a', 2))
    return lease
  } })
  assert.equal(r.ok, false)
  assert.match(r.error, /预检后发生变化/u)
  assert.equal(await f.read('a'), log('a', 2))
  assert.equal(f.held.size, 0)
})

test('后续文件发布失败只回滚本次写入，不删除外部新建目标', async t => {
  const f = await fixture(t, { [rel('a')]: log('a', 4), [rel('b')]: log('b', 2) }, { [rel('a')]: log('a', 1) })
  let injected = false
  const r = await f.run({ onProgress: patch => {
    if (!injected && patch.files.done === 2) {
      assert.equal(fsSync.readFileSync(f.target('a'), 'utf8'), log('a', 4))
      injected = true
      fsSync.mkdirSync(f.target('b'), { recursive: true })
    }
  } })
  assert.equal(injected, true)
  assert.equal(r.ok, false)
  assert.equal(r.rolledBack, true)
  assert.deepEqual(r.rollbackErrors, [])
  assert.equal(await f.read('a'), log('a', 1))
  assert.equal((await fs.stat(f.target('b'))).isDirectory(), true)
  assert.equal(f.held.size, 0)
})

test('宿主拒绝损坏日志时全量还原不得报告成功', async t => {
  const broken = log('a', 3).replace('"seq":1', '"seq":99')
  const f = await fixture(t, { [rel('a')]: log('a', 1) }, { [rel('a')]: broken })
  const r = await f.run()
  assert.equal(r.ok, false)
  assert.match(r.error, /seq gap/u)
  assert.equal(await f.read('a'), broken)
})
