// 只读诊断：枚举 Gist 全部文件 → 与两个索引（快照历史 + 技能历史）+ latest 比对 →
// 报告「被引用 / 孤儿」。不写远端。gistObjectFileName 与 cloud-core 同构。
import { createHash } from 'node:crypto'
import { loadSettings, providerFrom, listSnapshotHistory, listSkillBackups } from './lib/cloud-core.mjs'

const settings = await loadSettings()
const provider = providerFrom(settings)
const { gist } = await provider.getGist()
const gistName = (key) => `dsh-cloud-sync-v1-${createHash('sha256').update(Buffer.from(key)).digest('hex').slice(0, 40)}.b64`

const referenced = new Map() // gist 文件名 -> 被哪个 key 引用
const register = (key) => referenced.set(gistName(key), key)
register('snapshots/latest.json.gz')
register('snapshots/history/index.json')
register('skills/index.json')
for (const entry of await listSnapshotHistory({})) register(entry.key)
for (const entry of await listSkillBackups({})) { for (const key of entry.keys ?? []) register(key); register(entry.key) }
// Gist 标记文件
register('dsh-cloud-sync-v1.json')

const files = Object.entries(gist.files ?? {}).map(([name, file]) => ({ name, size: file.size ?? 0 }))
console.log('GIST_FILES', files.length, 'TOTAL_KB', Math.round(files.reduce((sum, file) => sum + file.size, 0) / 1024))
const orphans = files.filter(file => !referenced.has(file.name))
const referencedFiles = files.filter(file => referenced.has(file.name))
console.log('REFERENCED', referencedFiles.length, Math.round(referencedFiles.reduce((sum, file) => sum + file.size, 0) / 1024), 'KB')
for (const file of referencedFiles.slice(0, 12)) console.log('  ref:', file.name, Math.round(file.size / 1024), 'KB ←', referenced.get(file.name))
console.log('ORPHANS', orphans.length, Math.round(orphans.reduce((sum, file) => sum + file.size, 0) / 1024), 'KB')
for (const file of orphans.slice(0, 50)) console.log('  orphan:', file.name, Math.round(file.size / 1024), 'KB')
console.log('SNAP_ENTRIES', (await listSnapshotHistory({})).length, 'SKILL_ENTRIES', (await listSkillBackups({})).length)
