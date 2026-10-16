import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { portableFile, portableText, localText } from '../lib/portable.mjs'
import { createSessionMapper, sessionHeader } from '../lib/session-portable.mjs'
import { previewRestore, mergeRestore, overwriteApply } from '../lib/restore.mjs'
import { backupLocalPlugin, createSnapshot, pullSnapshot, pushSkillBackup, restoreSkills, syncRoot } from '../lib/cloud-core.mjs'

class Provider {
  objects = new Map()
  async put(key, bytes) { this.objects.set(key, Buffer.from(bytes)) }
  async get(key) { if (!this.objects.has(key)) throw new Error('HTTP 404'); return this.objects.get(key) }
  async getWithMeta(key) { return { body: await this.get(key), etag: 'fixture' } }
  async remove(key) { this.objects.delete(key) }
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-portable-'))
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('dsh-portable-')); await fs.rm(root, { recursive: true, force: true }) })
  const project = path.join(root, '目标 项目'), sessionRoot = path.join(root, 'sessions')
  await fs.mkdir(project); await fs.mkdir(sessionRoot)
  return { root, project, sessionRoot }
}
const foreign = 'Z:\\Users\\source-device\\Documents\\来源项目'
const header = { type: 'session', version: 4, id: 'session-portable', cwd: foreign, createdAt: 1, isSeeded: false, delegationDepth: 0 }
const body = Buffer.from(JSON.stringify({ type: 'permission/preset', seq: 0, time: 2, data: { preset: 'workspace-write', note: foreign } }) + '\n')
const log = compressed => compressed ? Buffer.concat([zstdCompressSync(JSON.stringify(header) + '\n'), zstdCompressSync(body)]) : Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), body])
const rel = 'source-project/' + header.id + '/session.v4.jsonl.zstd'
function persistence(sessionRoot) {
  return { locate(meta) { return { path: path.join(sessionRoot, encodeURIComponent(meta.cwd ?? '_no-cwd'), meta.id, 'session.v4.jsonl.zstd') } } }
}
async function inspect(_rel, bytes) {
  const parsed = sessionHeader(_rel, bytes)
  const lines = (parsed.compressed ? zstdDecompressSync(parsed.body) : parsed.body).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  lines.forEach((event, seq) => assert.equal(event.seq, seq))
  return { meta: parsed.header, events: lines, inheritedEventCount: 0 }
}
function backend(bytes) { return { listFilesAtRev: async () => ['sessions/' + rel], readFileAtRev: async () => bytes } }

// Distinct device roots are intentional; no path is taken from a specific developer machine.
test('便携路径以来源根为边界，按目标设备独立解析，二进制和普通文字不变', () => {
  const source = { userHome: 'C:/Users/source', dshHome: 'D:/dsh', skillsRoot: 'E:/skills', sourceRoot: 'F:/plugin' }
  const target = { userHome: '/home/target', dshHome: '/srv/dsh', skillsRoot: '/opt/skills', sourceRoot: '/opt/plugin' }
  const input = { cache: 'D:/dsh/cache', script: 'F:/plugin/scripts/run.mjs', skill: 'E:/skills/alpha/SKILL.md', other: 'C:/Users/source-other/keep' }
  const packed = portableFile('config.json', Buffer.from(JSON.stringify(input)), source)
  assert(!packed.toString().includes('D:/dsh'))
  const output = JSON.parse(portableFile('config.json', packed, target, true))
  assert.deepEqual(output, { cache: '/srv/dsh/cache', script: '/opt/plugin/scripts/run.mjs', skill: '/opt/skills/alpha/SKILL.md', other: input.other })
  const binary = Buffer.from([0, 255, 128, 1])
  assert.equal(portableFile('image.png', binary, target, true), binary)
  assert.equal(portableText('ordinary words ./relative user~name', source), 'ordinary words ./relative user~name')
})

test('旧备份Windows JSON转义路径映射到目标home，JSON仍有效', () => {
  const bytes = Buffer.from(JSON.stringify({ root: 'C:\\Users\\old-device\\.dsh\\profiles\\desktop', skill: 'C:\\Users\\old-device\\.agents\\skills\\alpha' }))
  const result = JSON.parse(portableFile('config.json', bytes, { userHome: '/home/new', dshHome: '/srv/dsh', skillsRoot: '/srv/skills' }, true))
  assert.equal(result.root, '/srv/dsh/profiles/desktop')
  assert.equal(result.skill, '/srv/skills/alpha')
  assert.equal(localText('~/a', { userHome: '/home/new' }), '/home/new/a')
})

test('压缩日志只改头部cwd，全部消息事件压缩帧原字节保留', async t => {
  const f = await fixture(t)
  const mapper = createSessionMapper({ ...f, persistence: persistence(f.sessionRoot), projectPaths: { [foreign]: f.project }, inspectLog: inspect })
  const original = log(true), entry = await mapper.mapEntry(rel, original)
  assert.equal(sessionHeader(entry.rel, entry.blob).header.cwd, f.project)
  assert(sessionHeader(entry.rel, entry.blob).body.equals(sessionHeader(rel, original).body))
  assert(entry.rel.includes(encodeURIComponent(f.project)))
  assert.equal((await inspect(entry.rel, entry.blob)).events[0].data.note, foreign)
})

test('未压缩日志迁移后正文逐字节不变', async t => {
  const f = await fixture(t)
  const host = persistence(f.sessionRoot)
  host.locate = meta => ({ path: path.join(f.sessionRoot, encodeURIComponent(meta.cwd), meta.id, 'session.v4.jsonl') })
  const mapper = createSessionMapper({ ...f, persistence: host, projectPaths: { [foreign]: f.project }, inspectLog: inspect })
  const entry = await mapper.mapEntry(rel.slice(0, -5), log(false))
  assert.equal(sessionHeader(entry.rel, entry.blob).header.cwd, f.project)
  assert(sessionHeader(entry.rel, entry.blob).body.equals(body))
})

test('缺失项目预览给出待选择目录，执行拒绝且不创建空项目', async t => {
  const f = await fixture(t), git = backend(log(true))
  const options = { ...f, persistence: persistence(f.sessionRoot), inspectLog: inspect }
  const previewMap = createSessionMapper({ ...options, preview: true })
  const preview = await previewRestore({ git, commit: 'a', ...f, ...previewMap })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(preview.projects[0].requiresSelection, true)
  const mapper = createSessionMapper(options)
  const result = await mergeRestore({ git, commit: 'a', ...f, ...mapper })
  assert.equal(result.ok, false)
  assert.match(result.error, /请选择目标设备/u)
  assert.deepEqual(await fs.readdir(f.sessionRoot), [])
})

test('显式目标目录必须存在，跨设备合并第二轮不会复制出来源设备目录', async t => {
  const f = await fixture(t), git = backend(log(true))
  const options = { ...f, persistence: persistence(f.sessionRoot), inspectLog: inspect }
  const bad = createSessionMapper({ ...options, projectPaths: { [foreign]: path.join(f.root, 'missing') } })
  await assert.rejects(() => bad.mapEntry(rel, log(true)), /目标项目目录不存在/u)
  for (let round = 0; round < 2; round++) {
    const mapper = createSessionMapper({ ...options, projectPaths: { [foreign]: f.project } })
    const result = await mergeRestore({ git, commit: 'a', ...f, ...mapper })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.written, round === 0 ? 1 : 0)
    assert.equal(result.forks.length, 0)
  }
  assert.deepEqual(await fs.readdir(f.sessionRoot), [encodeURIComponent(f.project)])
})

test('不同来源文件映射同一会话日志时提前拒绝', async t => {
  const f = await fixture(t)
  const mapper = createSessionMapper({ ...f, persistence: persistence(f.sessionRoot), projectPaths: { [foreign]: f.project }, inspectLog: inspect })
  await mapper.mapEntry(rel, log(true))
  await assert.rejects(() => mapper.mapEntry('other-project/' + header.id + '/session.v4.jsonl.zstd', log(true)), /同一日志/u)
})

test('目标设备已有同ID其他目录会话时拒绝制造重复身份', async t => {
  const f = await fixture(t), host = persistence(f.sessionRoot)
  host.findLog = async () => ({ sourcePath: path.join(f.sessionRoot, 'other', header.id, 'session.v4.jsonl.zstd') })
  const mapper = createSessionMapper({ ...f, persistence: host, projectPaths: { [foreign]: f.project }, inspectLog: inspect })
  await assert.rejects(() => mapper.mapEntry(rel, log(true)), /同 ID/u)
})

test('全量还原使用目标设备映射并保留本地追加历史', async t => {
  const f = await fixture(t), host = persistence(f.sessionRoot), git = backend(log(true))
  const opts = { ...f, persistence: host, projectPaths: { [foreign]: f.project }, inspectLog: inspect }
  const mapped = await createSessionMapper(opts).mapEntry(rel, log(true))
  const target = path.join(f.sessionRoot, ...mapped.rel.split('/'))
  await fs.mkdir(path.dirname(target), { recursive: true })
  const extra = zstdCompressSync(JSON.stringify({ type: 'permission/preset', seq: 1, time: 3, data: { preset: 'read-only' } }) + '\n')
  const local = Buffer.concat([mapped.blob, extra])
  await fs.writeFile(target, local)
  // Interface-boundary decoder supports multiple append frames, as the real host does.
  const inspectAll = async (file, bytes) => {
    const h = sessionHeader(file, bytes), events = []
    let buffer = h.body
    while (buffer.length > 0) { const decoded = zstdDecompressSync(buffer, { info: true }); events.push(...decoded.buffer.toString('utf8').trim().split('\n').map(JSON.parse)); buffer = buffer.subarray(decoded.engine.bytesWritten) }
    events.forEach((event, seq) => assert.equal(event.seq, seq))
    return { meta: h.header, events, inheritedEventCount: 0 }
  }
  const mapper = createSessionMapper({ ...opts, inspectLog: inspectAll })
  const result = await overwriteApply({ ...f, git, commit: 'a', ...mapper, inspectLog: inspectAll, acquireWriteLease: async () => { throw new Error('preserved history must not be rewritten') }, stagingDir: path.join(f.root, 'staging'), snapshotDir: path.join(f.root, 'snapshots'), id: 'run' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.preserved, 1)
  assert((await fs.readFile(target)).equals(local))
})

test('技能备份还原在另一根目录展开技能内部引用并保持二进制不变', async t => {
  const f = await fixture(t), provider = new Provider(), source = path.join(f.root, 'source-skills'), target = path.join(f.root, 'target-skills')
  await fs.mkdir(path.join(source, 'alpha'), { recursive: true })
  await fs.writeFile(path.join(source, 'alpha', 'SKILL.md'), 'Run ' + path.join(source, 'alpha', 'run.mjs') + '\n')
  const binary = Buffer.from([0, 255, 42])
  await fs.writeFile(path.join(source, 'alpha', 'image.png'), binary)
  await pushSkillBackup({ home: path.join(f.root, 'source-home'), root: source, provider })
  const restored = await restoreSkills({ home: path.join(f.root, 'target-home'), root: target, provider })
  assert.deepEqual(restored.restored, ['alpha'])
  const text = await fs.readFile(path.join(target, 'alpha', 'SKILL.md'), 'utf8')
  assert(text.includes(path.join(target, 'alpha').replaceAll('\\', '/')))
  assert(!text.includes('source-skills'))
  assert((await fs.readFile(path.join(target, 'alpha', 'image.png'))).equals(binary))
})

test('插件快照在另一设备根恢复源码并重绑file依赖及配置路径', async t => {
  const f = await fixture(t), sourceHome = path.join(f.root, 'source-home'), targetHome = path.join(f.root, 'target-home'), source = path.join(f.root, 'plugin-source'), provider = new Provider()
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }))
  await fs.writeFile(path.join(source, 'config.json'), JSON.stringify({ cache: path.join(sourceHome, 'cache'), script: path.join(source, 'run.mjs') }))
  await fs.writeFile(path.join(source, 'run.mjs'), 'export default 1\n')
  const profile = path.join(sourceHome, 'profiles', 'desktop')
  await fs.mkdir(profile, { recursive: true })
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { 'demo-plugin': 'file:' + source } }))
  const entry = await backupLocalPlugin(source, { home: sourceHome })
  await provider.put(entry.objectKey, await fs.readFile(path.join(syncRoot(sourceHome), 'archives', entry.archive)))
  const snapshot = await createSnapshot({ home: sourceHome, profiles: ['desktop'] })
  await provider.put('snapshots/latest.json.gz', snapshot.encoded)
  const restored = await pullSnapshot({ home: targetHome, apply: true, provider })
  assert.equal(restored.applied, true)
  const directory = restored.restoredSources['demo-plugin']
  const manifest = JSON.parse(await fs.readFile(path.join(targetHome, 'profiles', 'desktop', 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['demo-plugin'], 'file:' + directory.replaceAll('\\', '/'))
  const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'))
  assert.equal(config.cache, path.join(targetHome, 'cache').replaceAll('\\', '/'))
  assert.equal(config.script, path.join(directory, 'run.mjs').replaceAll('\\', '/'))
  assert.equal(restored.restartRequired, true)
})

test('压缩和未压缩备份均按目标宿主编码落地，事件原始JSON字节不变', async t => {
  const f = await fixture(t)
  for (const compressed of [false, true]) {
    const host = persistence(f.sessionRoot)
    host.locate = meta => ({ path: path.join(f.sessionRoot, encodeURIComponent(meta.cwd), meta.id, 'session.v4.jsonl' + (compressed ? '.zstd' : '')) })
    const mapper = createSessionMapper({ ...f, persistence: host, projectPaths: { [foreign]: f.project }, inspectLog: inspect })
    const entry = await mapper.mapEntry(compressed ? rel.slice(0, -5) : rel, log(!compressed))
    const decoded = sessionHeader(entry.rel, entry.blob)
    assert.equal(decoded.compressed, compressed)
    assert((compressed ? zstdDecompressSync(decoded.body) : decoded.body).equals(body))
  }
})

test('缺少备份中的本地插件源码时，在写profile前拒绝虚报还原可用', async t => {
  const f = await fixture(t), sourceHome = path.join(f.root, 'source-home'), targetHome = path.join(f.root, 'target-home'), provider = new Provider()
  const profile = path.join(sourceHome, 'profiles', 'desktop')
  await fs.mkdir(profile, { recursive: true })
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { 'missing-plugin': 'file:Z:/missing-plugin' } }))
  const snapshot = await createSnapshot({ home: sourceHome, profiles: ['desktop'] })
  await provider.put('snapshots/latest.json.gz', snapshot.encoded)
  await assert.rejects(() => pullSnapshot({ home: targetHome, apply: true, provider }), /本地插件依赖未包含在备份中/u)
  await assert.rejects(() => fs.stat(path.join(targetHome, 'profiles', 'desktop', 'package.json')), { code: 'ENOENT' })
})

