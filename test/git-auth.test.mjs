import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGitAuth, gitAuthEnvironment } from '../lib/git-auth.mjs'
import { defaultUiConfig, normalizeUiConfigPatch, loadUiConfig } from '../lib/uiconfig.mjs'
import { uiConfigSchema } from '../lib/domain.mjs'
test('system mode leaves credential manager and agent untouched', () => { assert.deepEqual(gitAuthEnvironment(), {}) })
test('SSH paths are quoted and use batch mode', () => {
  const env = gitAuthEnvironment({ authMode: 'ssh-key', sshKeyPath: 'C:/Keys/My Key' })
  assert.ok(env.GIT_SSH_COMMAND.endsWith('-i "C:/Keys/My Key"'))
  assert.ok(env.GIT_SSH_COMMAND.includes('BatchMode=yes'))
})
test('reject shell metacharacters and missing paths', () => {
  for (const sshKeyPath of ['', 'relative', '/tmp/a"b', '/tmp/$HOME', '/tmp/a;command', '/tmp/a%PATH%']) assert.throws(() => normalizeGitAuth({ authMode: 'ssh-key', sshKeyPath }))
})
test('settings schema roundtrip preserves authentication and legacy records', async () => {
  const base = defaultUiConfig()
  const next = normalizeUiConfigPatch({ authMode: 'ssh-key', sshKeyPath: 'C:/Keys/key' }, base)
  const stored = uiConfigSchema.parse(next)
  const loaded = await loadUiConfig({ table: Promise.resolve({ get: async () => stored }) })
  assert.equal(loaded.authMode, 'ssh-key')
  assert.equal(loaded.sshKeyPath, 'C:/Keys/key')
  const legacy = uiConfigSchema.parse({ remote: '', branch: 'main', schedule: base.schedule })
  const old = await loadUiConfig({ table: Promise.resolve({ get: async () => legacy }) })
  assert.equal(old.authMode, 'system')
})
