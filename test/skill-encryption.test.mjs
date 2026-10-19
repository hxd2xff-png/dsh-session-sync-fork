// test/skill-encryption.test.mjs — 技能备份域（skills/）的加密契约门。
//
// 背景：EncryptedProvider 的 encryptedKey() 原先只覆盖 snapshots/ 与 sources/，
// 漏掉技能备份域 skills/ —— 开启客户端加密后，技能归档（SKILL.md 与附件）
// 仍以明文落到远端。本门端到端锁定三件事：
//   1. skills/ 归档落远端的是密文，且不含原始明文字节（不得明文上传）；
//   2. 写入后读回能还原为原始明文（round-trip）；
//   3. 开启加密前上传的旧明文归档仍可读回 —— decryptEnvelope 对 format
//      不匹配的正文原样透传，所以这个修复不会把历史数据变成损坏数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerFrom, unlockEncryption } from '../lib/cloud-core.mjs'

// 与 cloud-core 的 ENCRYPTED_FORMAT 同值（该常量未导出，故在此镜像；
// 若上游改名，本门会失败而不是静默放过）。
const ENCRYPTED_FORMAT = 'dsh-cloud-sync/encrypted/v1'
const PASSPHRASE = 'correct-horse-battery-staple'

function isEnvelope(buf) {
  try {
    return JSON.parse(buf.toString('utf8'))?.format === ENCRYPTED_FORMAT
  } catch {
    return false
  }
}

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-skill-enc-'))
  await mkdir(join(home, 'dsh-cloud-sync'), { recursive: true })
  await writeFile(
    join(home, 'dsh-cloud-sync', 'settings.json'),
    JSON.stringify({
      schema: 'dsh-cloud-sync/v1',
      provider: { type: 'gist', gistId: 'g1', token: 'tok' },
      encryption: { enabled: false, salt: '' },
    }),
  )
  return home
}

async function encryptedProviderFor(home) {
  const written = new Map()
  await unlockEncryption({ passphrase: PASSPHRASE, enable: true }, { home })
  /** @type {any} */
  const wrapped = providerFrom(
    { provider: { type: 'gist', gistId: 'g1', token: 'tok' }, encryption: { enabled: true, salt: '' } },
    home,
  )
  wrapped.provider = {
    async put(key, body) { written.set(key, Buffer.from(body)) },
    async getWithMeta(key) {
      const body = written.get(key)
      if (body === undefined) throw new Error('missing ' + key)
      return { body, etag: String.fromCharCode(34) + 'e1' + String.fromCharCode(34) }
    },
  }
  return { provider: wrapped, written }
}

async function withHome(fn) {
  const home = await makeHome()
  try { return await fn(home) } finally { await rm(home, { recursive: true, force: true }) }
}

test('skills/ 归档落远端为密文且不含明文字节', async () => {
  await withHome(async (home) => {
    const { provider, written } = await encryptedProviderFor(home)
    const payload = Buffer.from('SKILL.md contents that must never be plaintext')
    const key = 'skills/alpha-aaaa1234-p1of2.json.gz'
    await provider.put(key, payload)
    const stored = written.get(key)
    assert.ok(stored !== undefined, '必须写入远端')
    assert.equal(isEnvelope(stored), true, 'skills/ 落盘必须是加密信封，不能是明文')
    assert.equal(stored.includes(payload), false, '密文中不得包含原始明文字节')
  })
})

test('技能归档 round-trip：写入后读回还原为原始明文', async () => {
  await withHome(async (home) => {
    const { provider } = await encryptedProviderFor(home)
    const payload = Buffer.from('round-trip skill archive bytes')
    const key = 'skills/beta-bbbb5678.json.gz'
    await provider.put(key, payload)
    const back = await provider.get(key)
    assert.deepEqual(Buffer.from(back), payload, '读回应还原为原始明文')
  })
})

test('三个私有内容前缀都被加密，未知前缀保持明文', async () => {
  await withHome(async (home) => {
    const { provider, written } = await encryptedProviderFor(home)
    const cases = [
      ['snapshots/latest.json.gz', true],
      ['sources/plugin-a.tgz', true],
      ['skills/batch-ffff.json.gz', true],
      ['index/anything.json', false],
    ]
    for (const item of cases) {
      const key = item[0]
      const shouldEncrypt = item[1]
      const payload = Buffer.from('payload-for-' + String(key))
      await provider.put(key, payload)
      const stored = written.get(key)
      assert.equal(isEnvelope(stored), shouldEncrypt, key + ' 加密判定错误')
    }
  })
})

test('旧明文归档在加密模式下仍可读回（向后兼容）', async () => {
  await withHome(async (home) => {
    const { provider, written } = await encryptedProviderFor(home)
    const legacy = Buffer.from('legacy-plaintext-skill-archive')
    const key = 'skills/legacy.json.gz'
    // 模拟开启加密之前上传的明文归档：直接写进底层，绕开加密包装。
    written.set(key, legacy)
    const back = await provider.get(key)
    assert.deepEqual(Buffer.from(back), legacy, '旧明文归档必须原样读回')
  })
})
