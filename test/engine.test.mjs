// test/engine.test.mjs — push 提交判据回归门。
// 复现 bug：status() 先镜像后，push() 时镜像零写入（mirrored=0、deviceWritten=false），
// 旧代码据此跳过 commitAll，脏工作树永不提交却报告成功（实测：reflog 只有 initial commit）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from '../lib/engine.mjs'

const noop = { debug() {}, info() {}, warn() {}, error() {} }

function fakeGit() {
  const calls = { commitAll: [], push: 0 }
  return {
    calls,
    schedule: async (fn) => fn(),
    bootstrap: async () => {},
    ensureRepo: async () => {},
    push: async () => { calls.push += 1 },
    headSha: async () => 'a'.repeat(40),
    commitAll: async (message) => { calls.commitAll.push(message); return 'a'.repeat(40) },
    statusPorcelain: async () => '',
  }
}

async function makeRoots() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-engine-'))
  const sessionRoot = join(base, 'sessions')
  const repoDir = join(base, 'repo')
  await mkdir(join(sessionRoot, 'proj', 'session-1'), { recursive: true })
  await writeFile(join(sessionRoot, 'proj', 'session-1', 'session.v4.jsonl'), '{"a":1}\n', 'utf8')
  return { base, sessionRoot, repoDir }
}

test('push 在镜像零写入时仍提交脏工作树（回归：备份成功但无还原点）', async () => {
  const { base, sessionRoot, repoDir } = await makeRoots()
  try {
    const git = fakeGit()
    const engine = new SyncEngine({
      git: /** @type {any} */ (git), sessionRoot, repoDir, remote: 'git@example.com:x/y.git', branch: 'main',
      deviceId: 'device-1', reportMeta() {}, reportError() {}, onForks() {}, logger: noop,
    })
    const first = await engine.push()
    assert.equal(first.ok, true)
    assert.equal(git.calls.commitAll.length, 1, '首次 push（镜像有写入）必须提交')
    // 第二次 push：会话文件未变 → 镜像 mirrored=0、deviceWritten=false。
    // 工作树里是上次镜像写入的未提交文件（fake git 从未真提交）→ 仍必须调 commitAll。
    const second = await engine.push()
    assert.equal(second.ok, true)
    assert.equal(git.calls.commitAll.length, 2, '镜像零写入时也必须尝试提交（脏工作树不能被静默遗留）')
    assert.ok(second.pushed === true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('push 报告成功时 head 必须是刚提交/已有的提交号', async () => {
  const { base, sessionRoot, repoDir } = await makeRoots()
  try {
    const git = fakeGit()
    const engine = new SyncEngine({
      git: /** @type {any} */ (git), sessionRoot, repoDir, remote: 'git@example.com:x/y.git', branch: 'main',
      deviceId: 'device-1', reportMeta() {}, reportError() {}, onForks() {}, logger: noop,
    })
    const result = await engine.push()
    assert.equal(result.ok, true)
    assert.equal(result.head, 'a'.repeat(40))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
