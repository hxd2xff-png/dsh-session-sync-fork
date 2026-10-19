import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createSessionMapper, sessionHeader } from '../lib/session-portable.mjs'
import { previewRestore, mergeRestore, overwriteApply } from '../lib/restore.mjs'
import { mirrorSessionRoot } from '../lib/mirror.mjs'

const source = 'Z:/Users/source/Documents/project'
const meta = { type: 'session', version: 4, id: 'session-artifact', cwd: source, createdAt: 1, isSeeded: false, delegationDepth: 0 }
const rel = 'source/session-artifact/session.v4.jsonl.zstd'
const manual = 'session-artifact-20261016-143854.zstd'
const sidecar = 'notes/raw.bin'
function log(count = 1, cwd = source) {
  const events = Array.from({ length: count }, (_, seq) => ({ type: 'permission/preset', seq, time: seq + 2, data: { preset: 'workspace-write' } }))
  return Buffer.concat([zstdCompressSync(JSON.stringify({ ...meta, cwd }) + '\n'), zstdCompressSync(events.map(e => JSON.stringify(e)).join('\n') + '\n')])
}
async function inspect(file, bytes) {
  const h = sessionHeader(file, bytes), frames = []
  let rest = h.body
  while (rest.length) { const f = /** @type {any} */ (zstdDecompressSync(rest, { info: true })); frames.push(f.buffer); rest = rest.subarray(f.engine.bytesWritten) }
  const events = Buffer.concat(frames).toString('utf8').trim().split('\n').filter(Boolean).map((text) => JSON.parse(text))
  events.forEach((event, seq) => assert.equal(event.seq, seq))
  return { meta: h.header, events, inheritedEventCount: 0 }
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-artifact-'))
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('dsh-artifact-')); await fs.rm(root, { recursive: true, force: true }) })
  const sessionRoot = path.join(root, 'sessions'), project = path.join(root, '本机 项目'), artifactRoot = path.join(root, 'archives')
  await fs.mkdir(sessionRoot); await fs.mkdir(project)
  const files = new Map([[rel, log(2)], [manual, log(1)], [sidecar, Buffer.from([0, 255, 128, 1])]])
  const git = { listFilesAtRev: async () => [...files.keys()].map(r => 'sessions/' + r), readFileAtRev: async (_commit, file) => files.get(file.slice('sessions/'.length)) }
  const persistence = { locate: header => ({ path: path.join(sessionRoot, 'local', header.id, 'session.v4.jsonl.zstd') }) }
  const mapper = () => createSessionMapper({ sessionRoot, persistence, projectPaths: { [source]: project }, inspectLog: inspect })
  return { root, sessionRoot, project, artifactRoot, files, git, mapper, commit: 'backup-with-manual-snapshot', target: persistence.locate(meta).path }
}
async function archiveEquals(result, files) {
  assert.equal(result.auxiliaryCount, 2)
  for (const name of [manual, sidecar]) assert.deepEqual(await fs.readFile(path.join(result.artifactDir, 'files', name)), files.get(name))
  const manifest = JSON.parse(await fs.readFile(path.join(result.artifactDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.files.length, 2)
  for (const item of manifest.files) assert.equal(item.sha256, createHash('sha256').update(files.get(item.path)).digest('hex'))
}

test('包含时间戳副本的最新备份可预览：正式会话与附属文件分开统计且不写文件', async t => {
  const f = await fixture(t)
  const result = await previewRestore({ ...f, ...f.mapper() })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.totalFiles, 1); assert.equal(result.auxiliaryCount, 2)
  assert.deepEqual(result.auxiliaryFiles, [manual, sidecar])
  assert.equal(result.projects.length, 1)
  assert.deepEqual(await fs.readdir(f.sessionRoot), [])
  await assert.rejects(fs.access(f.artifactRoot), { code: 'ENOENT' })
})
test('安全合并连续两轮保留附属文件原字节，不注册重复会话或覆盖上轮归档', async t => {
  const f = await fixture(t), archives = []
  for (let round = 0; round < 2; round++) {
    const result = await mergeRestore({ ...f, ...f.mapper() })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.written, round === 0 ? 1 : 0)
    assert.equal(result.forks.length, 0)
    await archiveEquals(result, f.files); archives.push(result.artifactDir)
  }
  assert.notEqual(archives[0], archives[1])
  assert.deepEqual(await fs.readdir(f.sessionRoot), ['local'])
  assert.deepEqual(await fs.readFile(path.join(archives[0], 'files', manual)), f.files.get(manual))
})
test('全量还原只为正式会话取锁，手工副本另存且全部历史恢复', async t => {
  const f = await fixture(t), locked = [], released = []
  const result = await overwriteApply({ ...f, ...f.mapper(), snapshotDir: path.join(f.root, 'snapshots'), stagingDir: path.join(f.root, 'stage'), id: 'restore', inspectLog: inspect,
    acquireWriteLease: async (file, header) => { locked.push(file); assert.equal(header.id, meta.id); return { release: async () => released.push(file) } } })
  assert.equal(result.ok, true, result.error); assert.equal(result.replaced, 1)
  assert.equal(locked.length, 1); assert.deepEqual(locked, released)
  await archiveEquals(result, f.files)
  assert.equal((await inspect(rel, await fs.readFile(f.target))).events.length, 2)
  assert.deepEqual(await fs.readdir(f.sessionRoot), ['local'])
})
test('全量还原保留本地较新正式日志及inode，附属旧快照不会令历史回退', async t => {
  const f = await fixture(t), local = log(3, f.project)
  await fs.mkdir(path.dirname(f.target), { recursive: true }); await fs.writeFile(f.target, local)
  const inode = (await fs.stat(f.target)).ino
  const result = await overwriteApply({ ...f, ...f.mapper(), snapshotDir: path.join(f.root, 'snapshots'), stagingDir: path.join(f.root, 'stage'), id: 'restore', inspectLog: inspect,
    acquireWriteLease: async () => { throw new Error('preserved session must not request a write lease') } })
  assert.equal(result.ok, true, result.error); assert.equal(result.replaced, 0); assert.equal(result.preserved, 1)
  await archiveEquals(result, f.files)
  assert.deepEqual(await fs.readFile(f.target), local); assert.equal((await fs.stat(f.target)).ino, inode)
})
test('正式日志损坏仍拒绝，不能借附属文件分类绕过完整性校验', async t => {
  const f = await fixture(t); f.files.set(rel, Buffer.from('invalid zstd'))
  const result = await mergeRestore({ ...f, ...f.mapper() })
  assert.equal(result.ok, false)
  assert.deepEqual(await fs.readdir(f.sessionRoot), [])
  await assert.rejects(fs.access(f.artifactRoot), { code: 'ENOENT' })
})
test('附属目录缺失配置或位于live根内时拒绝，不静默丢副本', async t => {
  const f = await fixture(t)
  for (const artifactRoot of [undefined, path.join(f.sessionRoot, 'artifacts')]) {
    const result = await mergeRestore({ ...f, artifactRoot, ...f.mapper() })
    assert.equal(result.ok, false); assert.match(result.error, /附属备份|outside/u)
    assert.deepEqual(await fs.readdir(f.sessionRoot), [])
  }
})
test('只有非正式副本的备份仍完整保留并明确返回零正式会话', async t => {
  const f = await fixture(t); f.files.delete(rel)
  const preview = await previewRestore({ ...f, ...f.mapper() })
  assert.equal(preview.ok, true); assert.equal(preview.totalFiles, 0); assert.equal(preview.auxiliaryCount, 2)
  const result = await mergeRestore({ ...f, ...f.mapper() })
  assert.equal(result.ok, true, result.error); assert.equal(result.written, 0)
  await archiveEquals(result, f.files); assert.deepEqual(await fs.readdir(f.sessionRoot), [])
})
test('本地最新正式日志和手工副本全部镜像后，当前快照可直接还原，无需删除副本或重备', async t => {
  const f = await fixture(t), sourceRoot = path.join(f.root, 'source'), repoDir = path.join(f.root, 'repo')
  for (const [name, bytes] of f.files) { const dest = path.join(sourceRoot, name); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, bytes) }
  await mirrorSessionRoot({ sessionRoot: sourceRoot, repoDir, mirrorDir: 'sessions' })
  const git = { listFilesAtRev: async () => [...f.files.keys()].map(r => 'sessions/' + r), readFileAtRev: async (_c, file) => fs.readFile(path.join(repoDir, file)) }
  const result = await mergeRestore({ ...f, git, ...f.mapper() })
  assert.equal(result.ok, true, result.error); await archiveEquals(result, f.files)
  assert.equal((await inspect(rel, await fs.readFile(f.target))).events.length, 2)
  for (const [name, bytes] of f.files) assert.deepEqual(await fs.readFile(path.join(sourceRoot, name)), bytes)
})
