import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveGitExecutable } from '../lib/git-executable.mjs'

test('uses host PATH first', async () => {
  assert.equal(await resolveGitExecutable({ resolveExecutable: async () => '/bin/git' }, 'git'), '/bin/git')
})
test('probes dynamic Windows installation root after PATH failure', async () => {
  const calls = []
  const host = { resolveExecutable: async value => { calls.push(value); if (value === 'git') throw new Error('missing'); return value } }
  const resolved = await resolveGitExecutable(host, 'git', undefined, { platform: 'win32', env: { ProgramFiles: 'Z:/Programs' }, accessible: async () => true })
  assert.equal(resolved.replaceAll(String.fromCharCode(92), '/'), 'Z:/Programs/Git/cmd/git.exe')
  assert.equal(calls.length, 2)
})
test('never replaces explicit executable', async () => {
  await assert.rejects(resolveGitExecutable({ resolveExecutable: async () => { throw new Error('missing') } }, 'custom-git', undefined, { platform: 'win32', accessible: async () => { throw new Error('must not probe') } }), /missing/)
})
test('preserves host failure when no installation found', async () => {
  await assert.rejects(resolveGitExecutable({ resolveExecutable: async () => { throw new Error('missing') } }, 'git', undefined, { platform: 'win32', env: {}, accessible: async () => false }), /missing/)
})
