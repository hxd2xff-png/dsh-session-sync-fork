// test/restore.test.mjs — 还原语义（真实临时 git 仓库 + 真实文件系统）。
//
// 覆盖：安全合并绝不覆盖本地字节、冲突留存 fork、完整覆盖的安全快照与
// 物化暂存、路径越界拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { previewRestore, mergeRestore, createSafetySnapshot, materializeCommit, insideRoot } from '../lib/restore.mjs'
import { GitBackend } from '../lib/git.mjs'
import { MIRROR_DIR } from '../lib/constants.mjs'

const run = promisify(execFile)

/** 跑一条 git 命令（测试夹具专用，绕过插件白名单）。 */
async function git(cwd, args) {
  const { stdout } = await run('git', args, { cwd })
  return stdout
}

/**
 * 建一个夹具：repoDir 内是 git 仓库，镜像目录含一个提交。
 * @param {object} files - 相对 MIRROR_DIR 的文件表（内容为字符串）。
 * @returns {Promise<{root: string, repoDir: string, sessionRoot: string, commit: string, backend: object}>}
 */
async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sessionsync-restore-test-'))
  const repoDir = path.join(root, 'repo')
  const sessionRoot = path.join(root, 'sessions')
  await fs.mkdir(repoDir, { recursive: true })
  await fs.mkdir(sessionRoot, { recursive: true })
  await git(repoDir, ['init', '-b', 'main'])
  await git(repoDir, ['config', 'user.name', 'test'])
  await git(repoDir, ['config', 'user.email', 'test@localhost'])
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(repoDir, MIRROR_DIR, ...rel.split('/'))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  await git(repoDir, ['add', '-A'])
  await git(repoDir, ['commit', '-m', 'dsh-session-sync: manual backup'])
  const commit = (await git(repoDir, ['rev-parse', 'HEAD'])).trim()
  const backend = new GitBackend({
    repoDir,
    remote: 'git@example.com:x/y.git',
    branch: 'main',
    commitName: 'test',
    commitEmail: 'test@localhost',
    timeoutMs: 30_000,
    run: async (args, opts) => {
      try {
        const { stdout, stderr } = await run('git', args, { cwd: opts.cwd, timeout: 30_000 })
        if (opts.binary === true) return { code: 0, stdout: Buffer.from(stdout, 'binary'), stderr }
        return { code: 0, stdout, stderr }
      } catch (error) {
        if (opts.binary === true) {
          return { code: error.code ?? 1, stdout: Buffer.from(error.stdout ?? '', 'binary'), stderr: error.stderr ?? '' }
        }
        return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
      }
    },
  })
  return { root, repoDir, sessionRoot, commit, backend }
}

test('insideRoot 拒绝 .. 逃逸', () => {
  assert.equal(insideRoot('/a/b', '/a/b/c'), true)
  assert.equal(insideRoot('/a/b', '/a/b'), true)
  assert.equal(insideRoot('/a/b', '/a/x'), false)
  assert.equal(insideRoot('/a/b', '/a/b/../x'), false)
})

test('安全合并：只写本地缺失的文件，不覆盖已有字节', async () => {
  const f = await fixture({
    'p/s1/session.jsonl': 'REMOTE-S1\n',
    'p/s2/session.jsonl': 'REMOTE-S2\n',
  })
  // 本地：s1 已存在且内容不同；s2 缺失。
  await fs.mkdir(path.join(f.sessionRoot, 'p', 's1'), { recursive: true })
  await fs.writeFile(path.join(f.sessionRoot, 'p', 's1', 'session.jsonl'), 'LOCAL-S1\n')

  const result = await mergeRestore({
    git: f.backend,
    sessionRoot: f.sessionRoot,
    commit: f.commit,
    deviceShort: 'abcd1234',
    tempRoot: os.tmpdir(),
  })

  assert.equal(result.ok, true, result.error)
  assert.equal(result.written, 1, '缺失的 s2 应被写入')
  // 本地 s1 字节未被覆盖 —— 这是安全合并的核心保证。
  assert.equal(await fs.readFile(path.join(f.sessionRoot, 'p', 's1', 'session.jsonl'), 'utf8'), 'LOCAL-S1\n')
  // 远端版本留存为 fork。
  assert.equal(result.forks.length, 1)
  const forkRel = result.forks[0]
  assert.match(forkRel, /remote-fork-\d{14}-abcd1234$/u)
  assert.equal(await fs.readFile(path.join(f.sessionRoot, ...forkRel.split('/')), 'utf8'), 'REMOTE-S1\n')
  await fs.rm(f.root, { recursive: true, force: true })
})

test('安全合并：内容相同则跳过，不产生 fork', async () => {
  const f = await fixture({ 'p/s1/session.jsonl': 'SAME\n' })
  await fs.mkdir(path.join(f.sessionRoot, 'p', 's1'), { recursive: true })
  await fs.writeFile(path.join(f.sessionRoot, 'p', 's1', 'session.jsonl'), 'SAME\n')
  const result = await mergeRestore({
    git: f.backend, sessionRoot: f.sessionRoot, commit: f.commit, deviceShort: 'abcd1234', tempRoot: os.tmpdir(),
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.written, 0)
  assert.equal(result.forks.length, 0)
  await fs.rm(f.root, { recursive: true, force: true })
})

test('安全合并：不删除本地多余文件', async () => {
  const f = await fixture({ 'p/s1/session.jsonl': 'A\n' })
  await fs.mkdir(path.join(f.sessionRoot, 'p', 'extra'), { recursive: true })
  await fs.writeFile(path.join(f.sessionRoot, 'p', 'extra', 'session.jsonl'), 'KEEP\n')
  await mergeRestore({
    git: f.backend, sessionRoot: f.sessionRoot, commit: f.commit, deviceShort: 'abcd1234', tempRoot: os.tmpdir(),
  })
  const still = await fs.readFile(path.join(f.sessionRoot, 'p', 'extra', 'session.jsonl'), 'utf8')
  assert.equal(still, 'KEEP\n', '本地独有文件必须保留')
  await fs.rm(f.root, { recursive: true, force: true })
})

test('预览：统计缺失/已存在/将 fork，且不写任何文件', async () => {
  const f = await fixture({
    'p/s1/session.jsonl': 'R1\n',
    'p/s2/session.jsonl': 'R2\n',
  })
  await fs.mkdir(path.join(f.sessionRoot, 'p', 's1'), { recursive: true })
  await fs.writeFile(path.join(f.sessionRoot, 'p', 's1', 'session.jsonl'), 'L1\n')
  const preview = await previewRestore({ git: f.backend, sessionRoot: f.sessionRoot, commit: f.commit, tempRoot: os.tmpdir() })
  assert.equal(preview.ok, true, preview.error)
  assert.equal(preview.missing, 1)
  assert.equal(preview.existing, 1)
  assert.equal(preview.willWriteCount, 1)
  assert.equal(preview.willForkCount, 1)
  // 预览不得改动本地内容。
  assert.equal(await fs.readFile(path.join(f.sessionRoot, 'p', 's1', 'session.jsonl'), 'utf8'), 'L1\n')
  await fs.rm(f.root, { recursive: true, force: true })
})

test('安全快照：完整复制当前会话库', async () => {
  const f = await fixture({ 'p/s1/session.jsonl': 'A\n' })
  await fs.mkdir(path.join(f.sessionRoot, 'p', 's1'), { recursive: true })
  await fs.writeFile(path.join(f.sessionRoot, 'p', 's1', 'session.jsonl'), 'CURRENT\n')
  const snapshotRoot = path.join(f.root, 'snapshots')
  const result = await createSafetySnapshot({ sessionRoot: f.sessionRoot, snapshotDir: snapshotRoot, id: 'task-1' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.files, 1)
  const copied = await fs.readFile(path.join(snapshotRoot, 'task-1', 'p', 's1', 'session.jsonl'), 'utf8')
  assert.equal(copied, 'CURRENT\n')
  await fs.rm(f.root, { recursive: true, force: true })
})

test('物化暂存：把提交内容写到独立目录，不触碰 sessionRoot', async () => {
  const f = await fixture({ 'p/s1/session.jsonl': 'FROM-COMMIT\n' })
  const staging = path.join(f.root, 'staging')
  const result = await materializeCommit({ git: f.backend, commit: f.commit, stagingDir: staging })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.files, 1)
  assert.equal(await fs.readFile(path.join(staging, 'p', 's1', 'session.jsonl'), 'utf8'), 'FROM-COMMIT\n')
  const sessionEntries = await fs.readdir(f.sessionRoot)
  assert.deepEqual(sessionEntries, [], 'sessionRoot 必须保持未受影响')
  await fs.rm(f.root, { recursive: true, force: true })
})

test('宿主私有产物与 fork 文件不是还原目标', async () => {
  const f = await fixture({
    'p/s1/session.jsonl': 'A\n',
    'p/s1/session.lock': 'LOCK\n',
    'p/s1/session.jsonl.remote-fork-20260101000000-deadbeef': 'FORK\n',
  })
  const result = await mergeRestore({
    git: f.backend, sessionRoot: f.sessionRoot, commit: f.commit, deviceShort: 'abcd1234', tempRoot: os.tmpdir(),
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.written, 1, '只有 session.jsonl 应被写入')
  await assert.rejects(fs.access(path.join(f.sessionRoot, 'p', 's1', 'session.lock')))
  await fs.rm(f.root, { recursive: true, force: true })
})
