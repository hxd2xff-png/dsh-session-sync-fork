// Read-only inspection of an explicitly selected existing Gist.
import { loadSettings, dshHome, providerFrom } from '../lib/cloud-core.mjs'
const id = process.argv[2]
if (!/^[a-f0-9]{20,64}$/i.test(id ?? '')) throw new Error('Supply an existing Gist ID')
const settings = await loadSettings(dshHome())
const provider = providerFrom({ ...settings, provider: { ...settings.provider, gistId: id } })
for (const key of ['snapshots/history/index.json', 'skills/index.json']) {
  const body = await provider.get(key)
  const index = JSON.parse(body.toString('utf8'))
  console.log(JSON.stringify({ gistId: id, key, entryCount: index.entries?.length, entries: index.entries?.map(entry => ({ createdAt: entry.createdAt, deviceName: entry.deviceName, skillCount: entry.skills?.length })) }))
}
