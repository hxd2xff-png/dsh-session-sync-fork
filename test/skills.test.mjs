// test/skills.test.mjs — 技能备份域契约门（1A 独立键空间 / 2A 逐技能归档 / 3A 安全合并）。
//
// 全部用注入的 FakeProvider + 临时目录跑，绝不触碰远端真实数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupLocalSkill, deleteSkillBackup, listLocalSkills, listSkillBackups, pushSkillBackup, restoreSkills, skillsRoot } from '../lib/cloud-core.mjs'

const SCHEMA = 'dsh-cloud-sync/v1'

class FakeProvider {
  constructor() { this.objects = new Map(); this.calls = { put: 0, putMany: 0, get: 0, getMany: 0, remove: 0, removeMany: 0 } }
  async put(key, body) { this.calls.put += 1; this.objects.set(key, Buffer.from(body)) }
  async putMany(entries) { this.calls.putMany += 1; for (const entry of entries) this.objects.set(entry.key, Buffer.from(entry.body)) }
  async get(key) { this.calls.get += 1; const value = this.objects.get(key); if (value === undefined) throw new Error('HTTP 404'); return value }
  async getMany(keys) { this.calls.getMany += 1; const out = new Map(); for (const key of keys) { const value = this.objects.get(key); if (value === undefined) throw new Error(`HTTP 404 ${key}`); out.set(key, value) } return out }
  // getWithMeta 直读 objects，不经 get()：否则读索引会被误计成逐对象 get。
  async getWithMeta(key) { const value = this.objects.get(key); if (value === undefined) throw new Error('HTTP 404'); return { body: value, etag: `"${value.length}"` } }
  async remove(key) { this.calls.remove += 1; if (!this.objects.delete(key)) throw new Error(`HTTP 404 ${key}`) }
  // 与 GistProvider.removeMany 语义一致：只删存在的键，不存在的静默跳过
  // （实测 GitHub 对删除不存在文件返回 422，批量路径必须先过滤）。
  async removeMany(keys) { this.calls.removeMany += 1; for (const key of keys) this.objects.delete(key) }
}

async function setupLibrary() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-'))
  await mkdir(join(root, 'alpha', 'references'), { recursive: true })
  await writeFile(join(root, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8')
  await writeFile(join(root, 'alpha', 'references', 'guide.md'), 'guide\n', 'utf8')
  await mkdir(join(root, 'beta'), { recursive: true })
  await writeFile(join(root, 'beta', 'SKILL.md'), '# beta\n', 'utf8')
  return root
}

test('skillsRoot 默认指向全局技能库', () => {
  const resolved = skillsRoot()
  assert.ok(resolved.endsWith('skills'), resolved)
})

test('listLocalSkills 列出技能目录（按名称排序）', async () => {
  const root = await setupLibrary()
  try {
    assert.deepEqual(await listLocalSkills({ root }), [{ name: 'alpha' }, { name: 'beta' }])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('backupLocalSkill 打包整个目录为压缩分片', async () => {
  const root = await setupLibrary()
  try {
    const archive = await backupLocalSkill('alpha', { root })
    assert.equal(archive.name, 'alpha')
    assert.equal(archive.sha256.length, 64)
    assert.equal(archive.sourceBytes, '# alpha\n'.length + 'guide\n'.length)
    assert.ok(archive.byteLength > 0)
    assert.equal(archive.parts.length, 1)
    // backupLocalSkill 是 async：拒绝必须用 rejects 断言，throws 只捕同步抛错。
    await assert.rejects(() => backupLocalSkill('missing', { root }), /has no SKILL\.md/)
    await assert.rejects(() => backupLocalSkill('../escape', { root }), /Invalid skill name/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('backupLocalSkill 超大技能动态分片，每个分片都不超过 Gist 单对象上限', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-big-'))
  try {
    // 造一个远超 700KiB 上限的技能（128 个 16KB 文件 ≈ 2MB，压缩后仍超限）。
    const filler = 'x'.repeat(16 * 1024)
    for (let i = 0; i < 128; i += 1) {
      const dir = join(root, 'huge', `group${String(Math.floor(i / 16)).padStart(2, '0')}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `f${String(i).padStart(3, '0')}.txt`), filler, 'utf8')
    }
    await writeFile(join(root, 'huge', 'SKILL.md'), '# huge\n', 'utf8')
    const archive = await backupLocalSkill('huge', { root })
    assert.ok(archive.parts.length > 1, `应拆成多片，实际 ${archive.parts.length} 片`)
    assert.equal(archive.sourceBytes, '# huge\n'.length + filler.length * 128)
    for (const part of archive.parts) {
      assert.ok(part.byteLength <= 700 * 1024, `分片 ${part.part} 超限：${part.byteLength} bytes`)
      assert.equal(part.parts, archive.parts.length)
      assert.equal(part.sha256.length, 64)
    }
    assert.deepEqual(archive.parts.map(p => p.part), archive.parts.map((_, i) => i + 1))
    const paths = archive.parts.flatMap(p => p.files.map(f => f.path))
    assert.equal(new Set(paths).size, 129)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('单文件本身就超过上限时响亮失败，不静默产出坏归档', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-onebig-'))
  try {
    // 必须用加密级随机：等差数列等伪随机可被 gzip 大幅压缩，压不到 700KiB 以上。
    const { randomBytes } = await import('node:crypto')
    await mkdir(join(root, 'onebig'), { recursive: true })
    await writeFile(join(root, 'onebig', 'SKILL.md'), '# onebig\n', 'utf8')
    await writeFile(join(root, 'onebig', 'blob.bin'), randomBytes(800 * 1024))
    await assert.rejects(() => backupLocalSkill('onebig', { root }), /cannot fit a Gist object/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pushSkillBackup 每技能一个或多个分片 + 独立 skills/ 索引', async () => {
  const root = await setupLibrary()
  const provider = new FakeProvider()
  try {
    const result = await pushSkillBackup({ provider, root, limit: 30 })
    assert.equal(result.total, 2)
    assert.deepEqual(result.skills, ['alpha', 'beta'])
    // 1A：键空间隔离——技能归档全部落在 skills/ 前缀，索引是 skills/index.json。
    const archiveKeys = [...provider.objects.keys()].filter(key => key !== 'skills/index.json')
    assert.equal(archiveKeys.length, 2)
    assert.ok(archiveKeys.every(key => key.startsWith('skills/') && key.endsWith('.json.gz')))
    assert.ok(provider.objects.has('skills/index.json'))
    assert.ok(![...provider.objects.keys()].some(key => key.startsWith('snapshots/')))
    // 2A：每个对象都远小于 Gist 700KB 单对象上限。
    assert.ok(archiveKeys.every(key => provider.objects.get(key).length < 700 * 1024))
    // 一次备份只落一条历史，条目里聚合全部技能与分片键。
    const entries = await listSkillBackups({ provider })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].total, 2)
    assert.deepEqual(entries[0].skills, ['alpha', 'beta'])
    assert.equal(entries[0].parts, 2)
    assert.equal(entries[0].keys.length, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pushSkillBackup 把旧格式条目按 createdAt 折叠成一条历史', async () => {
  const root = await setupLibrary()
  const provider = new FakeProvider()
  try {
    // 造旧格式索引：3 个技能条目，同一次旧备份（createdAt 相同）。
    const at = '2026-10-15T07:40:27.816Z'
    const legacyKeys = ['skills/alpha-a.json.gz', 'skills/beta-b.json.gz', 'skills/gamma-c.json.gz']
    for (const key of legacyKeys) provider.objects.set(key, Buffer.from('archive'))
    provider.objects.set('skills/index.json', Buffer.from(JSON.stringify({
      schema: SCHEMA,
      entries: legacyKeys.map(key => ({ key, name: key.split('/')[1].split('-')[0], parts: 1, sourceBytes: 10, createdAt: at })),
    })))
    const result = await pushSkillBackup({ provider, root, limit: 30 })
    assert.equal(result.migrated, 1, '旧条目应折叠成 1 条')
    const entries = await listSkillBackups({ provider })
    assert.equal(entries.length, 2, '新备份 1 条 + 折叠后的旧备份 1 条')
    const migrated = entries.find(entry => entry.migrated === true)
    assert.equal(migrated.total, 3)
    assert.deepEqual(migrated.skills, ['alpha', 'beta', 'gamma'])
    assert.equal(migrated.keys.length, 3)
    // 折叠后旧分片对象仍被引用，不被当孤儿删掉。
    for (const key of legacyKeys) assert.equal(provider.objects.has(key), true, `折叠丢了分片 ${key}`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('批量路径门：备份/删除/还原必须走批量 API，不得逐对象往返', async () => {
  const root = await setupLibrary()
  const provider = new FakeProvider()
  try {
    const pushed = await pushSkillBackup({ provider, root, limit: 30 })
    assert.equal(pushed.total, 2)
    // 备份：分片必须走 putMany。索引本身是单对象，允许 1 次普通 put。
    assert.ok(provider.calls.put <= 1, `逐对象 put 过多: ${provider.calls.put}`)
    assert.equal(provider.calls.putMany, Math.ceil(pushed.parts / 12), `putMany 批次应等于 ceil(parts/12)，实际 ${provider.calls.putMany}/${pushed.parts} 片`)
    const entries = await listSkillBackups({ provider })
    // 还原：必须走 getMany 取分片，且不得退化到逐个 get。
    // 取样用增量：读索引本身会走一次 get，不能算进还原。
    const beforeGet = provider.calls.get
    await restoreSkills({ provider, root: await mkdtemp(join(tmpdir(), 'dsh-skills-perf-')), skillKeys: [entries[0].key] })
    assert.equal(provider.calls.get - beforeGet, 0, `还原不应逐对象 get，实际 ${provider.calls.get - beforeGet} 次`)
    assert.equal(provider.calls.getMany, 1, `还原应一次批量取回，实际 ${provider.calls.getMany} 次`)
    // 删除：必须走 removeMany，且不得退化到逐个 remove。
    const beforeRemove = provider.calls.remove
    await deleteSkillBackup({ provider, skillKey: entries[0].key })
    assert.equal(provider.calls.remove - beforeRemove, 0, `删除不应逐对象 remove，实际 ${provider.calls.remove - beforeRemove} 次`)
    assert.equal(provider.calls.removeMany, 1, `删除应一次批量删，实际 ${provider.calls.removeMany} 次`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pushSkillBackup 两次备份落两条历史，每次一条', async () => {
  const root = await setupLibrary()
  const provider = new FakeProvider()
  try {
    await pushSkillBackup({ provider, root, limit: 30 })
    await writeFile(join(root, 'beta', 'SKILL.md'), '# beta v2\n', 'utf8')
    await pushSkillBackup({ provider, root, limit: 30 })
    const entries = await listSkillBackups({ provider })
    assert.equal(entries.length, 2, '两次备份应是两条历史，不是每技能一条')
    for (const entry of entries) {
      assert.equal(entry.total, 2)
      assert.equal(entry.skills.length, 2)
      assert.ok(entry.keys.length >= 2)
    }
    // 第二次备份的 beta 分片是新 key；第一次的 beta 分片应被清理（不在任何条目里）。
    const live = new Set(entries.flatMap(entry => entry.keys))
    for (const key of provider.objects.keys()) {
      if (key === 'skills/index.json') continue
      assert.ok(live.has(key), `孤立归档未清理: ${key}`)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pushSkillBackup 超大技能拆多片上传，每片一个对象且都不超限', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-big-'))
  const provider = new FakeProvider()
  try {
    const filler = 'y'.repeat(16 * 1024)
    for (let i = 0; i < 128; i += 1) {
      const dir = join(root, 'huge', `group${String(Math.floor(i / 16)).padStart(2, '0')}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `f${String(i).padStart(3, '0')}.txt`), filler, 'utf8')
    }
    await writeFile(join(root, 'huge', 'SKILL.md'), '# huge\n', 'utf8')
    await pushSkillBackup({ provider, root, limit: 30 })
    const archiveKeys = [...provider.objects.keys()].filter(key => key !== 'skills/index.json')
    const entries = await listSkillBackups({ provider })
    // 一次备份仍是一条历史，但该条目内聚合了多片。
    assert.equal(entries.length, 1)
    assert.equal(entries[0].total, 1)
    assert.ok(entries[0].parts > 1, `应有多片，实际 ${entries[0].parts}`)
    assert.equal(archiveKeys.length, entries[0].parts)
    assert.ok(archiveKeys.every(key => provider.objects.get(key).length <= 700 * 1024))
    assert.ok(entries[0].keys.every(key => archiveKeys.includes(key)))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('pushSkillBackup 按 limit 裁剪旧备份并真正删除本体', async () => {
  const root = await setupLibrary()
  const provider = new FakeProvider()
  try {
    await pushSkillBackup({ provider, root, limit: 2 })
    assert.equal([...provider.objects.keys()].filter(key => key !== 'skills/index.json').length, 2)
    await writeFile(join(root, 'beta', 'SKILL.md'), '# beta v2\n', 'utf8')
    await pushSkillBackup({ provider, root, limit: 2 })
    // 两次备份 = 两条历史；alpha 分片未变化被两次条目共用，beta 旧分片被清理。
    const entries = await listSkillBackups({ provider })
    assert.equal(entries.length, 2)
    const live = new Set(entries.flatMap(entry => entry.keys))
    for (const key of provider.objects.keys()) {
      if (key === 'skills/index.json') continue
      assert.ok(live.has(key), `孤立归档未清理: ${key}`)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('deleteSkillBackup 删除整次备份：全部分片一起删，未命中索引即拒绝', async () => {
  const provider = new FakeProvider()
  const keys = ['skills/alpha-a1.json.gz', 'skills/alpha-a2.json.gz']
  provider.objects.set(keys[0], Buffer.from('p1'))
  provider.objects.set(keys[1], Buffer.from('p2'))
  provider.objects.set('skills/index.json', Buffer.from(JSON.stringify({ schema: SCHEMA, entries: [{ key: keys[0], keys, skills: ['alpha'], total: 1, parts: 2, sha256: '0'.repeat(64), createdAt: new Date().toISOString() }] })))
  const result = await deleteSkillBackup({ provider, skillKey: keys[0] })
  assert.deepEqual(result, { removed: keys[0], skills: ['alpha'], remaining: 0 })
  assert.equal(provider.objects.has(keys[0]), false)
  assert.equal(provider.objects.has(keys[1]), false)
  await assert.rejects(() => deleteSkillBackup({ provider, skillKey: 'skills/nope.json.gz' }), /not found/)
})

/** 把本地技能库按「一次备份」搬进 FakeProvider，返回聚合后的历史条目。 */
async function seedProvider(provider, root, names) {
  const skills = []
  const keys = []
  for (const name of names) {
    const archive = await backupLocalSkill(name, { root })
    const skillKeys = []
    for (const part of archive.parts) {
      const suffix = archive.parts.length === 1 ? '' : `-p${part.part}of${part.parts}`
      const key = `skills/${name}-${part.sha256.slice(0, 16)}${suffix}.json.gz`
      provider.objects.set(key, part.compressed)
      skillKeys.push(key)
      keys.push(key)
    }
    skills.push({ name, sha256: archive.sha256, sourceBytes: archive.sourceBytes, parts: archive.parts.length, keys: skillKeys })
  }
  const entry = {
    key: 'skills/batch-seeded',
    createdAt: new Date().toISOString(),
    skills: skills.map(skill => skill.name), total: skills.length,
    parts: skills.reduce((sum, skill) => sum + skill.parts, 0),
    sourceBytes: skills.reduce((sum, skill) => sum + skill.sourceBytes, 0),
    manifest: skills, keys,
  }
  provider.objects.set('skills/index.json', Buffer.from(JSON.stringify({ schema: SCHEMA, entries: [entry] })))
  return entry
}

test('restoreSkills 技能名互为前缀时校验不误伤（tabbit / tabbit-plus）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-prefix-'))
  const target = await mkdtemp(join(tmpdir(), 'dsh-skills-restore-'))
  try {
    // alpha 必须多分片，才会出现「短名条目把长名分片也拉进校验组」的旧缺陷。
    const filler = 'w'.repeat(16 * 1024)
    for (const name of ['alpha', 'alpha-plus']) {
      await mkdir(join(root, name, 'sub'), { recursive: true })
      await writeFile(join(root, name, 'SKILL.md'), `# ${name}\n`, 'utf8')
      for (let i = 0; i < 40; i += 1) {
        await writeFile(join(root, name, 'sub', `f${String(i).padStart(3, '0')}.txt`), `${name}-${i}-${filler}`, 'utf8')
      }
    }
    const provider = new FakeProvider()
    await seedProvider(provider, root, ['alpha', 'alpha-plus'])
    const result = await restoreSkills({ provider, root: target })
    assert.deepEqual(result.restored.sort(), ['alpha', 'alpha-plus'])
    assert.equal(await readFile(join(target, 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n')
    assert.equal(await readFile(join(target, 'alpha-plus', 'SKILL.md'), 'utf8'), '# alpha-plus\n')
    assert.equal((await readFile(join(target, 'alpha', 'sub', 'f000.txt'), 'utf8')).startsWith('alpha-0-'), true)
    assert.equal((await readFile(join(target, 'alpha-plus', 'sub', 'f000.txt'), 'utf8')).startsWith('alpha-plus-0-'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('restoreSkills 未指定 key 时还原最新一次备份的整库', async () => {
  const root = await setupLibrary()
  const target = await mkdtemp(join(tmpdir(), 'dsh-skills-restore-'))
  try {
    const provider = new FakeProvider()
    await seedProvider(provider, root, ['alpha', 'beta'])
    const result = await restoreSkills({ provider, root: target })
    assert.deepEqual(result.restored, ['alpha', 'beta'])
    assert.deepEqual(result.skipped, [])
    assert.equal(await readFile(join(target, 'alpha', 'references', 'guide.md'), 'utf8'), 'guide\n')
    assert.equal(await readFile(join(target, 'beta', 'SKILL.md'), 'utf8'), '# beta\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('restoreSkills 安全合并：本地已存在的技能一律跳过，不覆盖', async () => {
  const root = await setupLibrary()
  const target = await mkdtemp(join(tmpdir(), 'dsh-skills-restore-'))
  try {
    const provider = new FakeProvider()
    const entry = await seedProvider(provider, root, ['alpha', 'beta'])
    await mkdir(join(target, 'alpha'), { recursive: true })
    await writeFile(join(target, 'alpha', 'SKILL.md'), '# local modified\n', 'utf8')
    const result = await restoreSkills({ provider, root: target, skillKeys: [entry.key] })
    assert.deepEqual(result.restored, ['beta'])
    assert.deepEqual(result.skipped, ['alpha'])
    assert.equal(await readFile(join(target, 'alpha', 'SKILL.md'), 'utf8'), '# local modified\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('restoreSkills 缺失技能按归档内容完整落盘', async () => {
  const root = await setupLibrary()
  const target = await mkdtemp(join(tmpdir(), 'dsh-skills-restore-'))
  try {
    const provider = new FakeProvider()
    const entry = await seedProvider(provider, root, ['alpha'])
    const result = await restoreSkills({ provider, root: target, skillKeys: [entry.key] })
    assert.deepEqual(result.restored, ['alpha'])
    assert.deepEqual(result.skipped, [])
    assert.equal(await readFile(join(target, 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n')
    assert.equal(await readFile(join(target, 'alpha', 'references', 'guide.md'), 'utf8'), 'guide\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('restoreSkills 多分片技能合并后完整落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-big-'))
  const target = await mkdtemp(join(tmpdir(), 'dsh-skills-restore-'))
  try {
    const filler = 'z'.repeat(16 * 1024)
    for (let i = 0; i < 96; i += 1) {
      const dir = join(root, 'huge', `group${String(Math.floor(i / 16)).padStart(2, '0')}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `f${String(i).padStart(3, '0')}.txt`), filler, 'utf8')
    }
    await writeFile(join(root, 'huge', 'SKILL.md'), '# huge\n', 'utf8')
    const provider = new FakeProvider()
    const entry = await seedProvider(provider, root, ['huge'])
    assert.ok(entry.parts > 1, `应有多片，实际 ${entry.parts}`)
    const result = await restoreSkills({ provider, root: target, skillKeys: [entry.key] })
    assert.deepEqual(result.restored, ['huge'])
    assert.equal(await readFile(join(target, 'huge', 'SKILL.md'), 'utf8'), '# huge\n')
    // 逐个文件比对：合并后必须与源目录完全一致（含子目录结构）。
    for (let i = 0; i < 96; i += 1) {
      const rel = `group${String(Math.floor(i / 16)).padStart(2, '0')}/f${String(i).padStart(3, '0')}.txt`
      assert.equal(await readFile(join(target, 'huge', rel), 'utf8'), filler, rel)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('restoreSkills 校验 sha256，损坏归档拒绝写入', async () => {
  const target = await mkdtemp(join(tmpdir(), 'dsh-skills-restore-'))
  try {
    const provider = new FakeProvider()
    const key = 'skills/alpha-abcdefabcdef.json.gz'
    provider.objects.set(key, Buffer.from('corrupted'))
    provider.objects.set('skills/index.json', Buffer.from(JSON.stringify({ schema: SCHEMA, entries: [{ key, name: 'alpha', sha256: 'f'.repeat(64), createdAt: new Date().toISOString() }] })))
    await assert.rejects(() => restoreSkills({ provider, root: target, skillKeys: [key] }), /checksum mismatch/)
    assert.equal(existsSync(join(target, 'alpha', 'SKILL.md')), false)
  } finally { await rm(target, { recursive: true, force: true }) }
})
