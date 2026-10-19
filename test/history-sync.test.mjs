import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GitBackend } from '../lib/git.mjs'
import { listHistory } from '../lib/history.mjs'

const exec = promisify(execFile)
test('history discovers remote snapshots without changing local HEAD or dirty files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-history-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const remote = path.join(root, 'remote.git')
  const writer = path.join(root, 'writer')
  const reader = path.join(root, 'reader')
  const git = (cwd, ...args) => exec('git', args, { cwd })
  await git(root, 'init', '--bare', remote)
  await git(root, 'init', '-b', 'main', writer)
  await git(writer, 'config', 'user.name', 'Test')
  await git(writer, 'config', 'user.email', 'test@example.com')
  await fs.writeFile(path.join(writer, 'snapshot'), 'first')
  await git(writer, 'add', '.')
  await git(writer, 'commit', '-m', 'first backup')
  await git(writer, 'remote', 'add', 'origin', remote)
  await git(writer, 'push', 'origin', 'main')
  await git(root, 'clone', '-b', 'main', remote, reader)
  const before = (await git(reader, 'rev-parse', 'HEAD')).stdout
  await fs.writeFile(path.join(reader, 'snapshot'), 'local unsaved data')
  await fs.writeFile(path.join(writer, 'snapshot'), 'new remote snapshot')
  await git(writer, 'commit', '-am', 'latest backup')
  await git(writer, 'push', 'origin', 'main')
  const latest = (await git(writer, 'rev-parse', 'HEAD')).stdout.trim()
  const backend = new GitBackend({ repoDir: reader, remote, branch: 'main', run: async (args, opts) => {
    try { const result = await exec('git', args, { cwd: opts.cwd }); return { code: 0, ...result } }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr } }
  } })
  const history = await listHistory(backend, { remote, branch: 'main' })
  assert.equal(history.ok, true)
  assert.ok(history.commits.some(item => item.sha === latest), 'remote backup must appear automatically')
  assert.equal((await git(reader, 'rev-parse', 'HEAD')).stdout, before)
  assert.equal(await fs.readFile(path.join(reader, 'snapshot'), 'utf8'), 'local unsaved data')
  assert.equal((await backend.readFileAtRev(latest, 'snapshot')).toString(), 'new remote snapshot')
})

test('history reports fetch failures instead of claiming stale history is current', async () => {
  const result = await listHistory({ schedule: fn => fn(), fetch: async () => { throw new Error('offline') }, logRecords: async () => '' }, { remote: 'https://example.com/repo.git', branch: 'main' })
  assert.equal(result.ok, false)
  assert.match(result.error, /offline/)
})
