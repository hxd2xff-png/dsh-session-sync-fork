// Read-only diagnostics: never print tokens or backup contents; never write remotely.
import { loadSettings, dshHome } from '../lib/cloud-core.mjs'
import { createHash } from 'node:crypto'
const settings = await loadSettings(dshHome())
if (settings.provider.type !== 'gist') throw new Error('Active provider is not Gist')
const { token, gistId } = settings.provider
const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-session-sync-diagnostics' }
const name = key => 'dsh-cloud-sync-v1-' + createHash('sha256').update(key).digest('hex').slice(0, 40) + '.b64'
const keys = ['snapshots/latest.json.gz', 'snapshots/history/index.json', 'skills/index.json']
for (let page = 1; page <= 5; page++) {
  const response = await fetch('https://api.github.com/gists?per_page=100&page=' + page, { headers, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error('GitHub Gist enumeration: HTTP ' + response.status)
  const gists = await response.json()
  if (!Array.isArray(gists)) throw new Error('Invalid GitHub response')
  for (const gist of gists) {
    const files = Object.keys(gist.files ?? {})
    if (gist.id === gistId || files.some(file => file.startsWith('dsh-cloud-sync'))) console.log(JSON.stringify({ id: gist.id, active: gist.id === gistId, fileCount: files.length, updatedAt: gist.updated_at, indices: Object.fromEntries(keys.map(key => [key, files.includes(name(key))])) }))
  }
  if (gists.length < 100) break
}
