#!/usr/bin/env node
// Archive every locked registry dependency, including optional platform packages.
// Never copy the machine's node_modules: it may link to a complete DSH profile.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const lockBytes = await fs.readFile(path.join(root, 'package-lock.json'))
const lock = JSON.parse(lockBytes)
const directory = path.join(root, 'vendor', 'npm')
await fs.mkdir(directory, { recursive: true })
const artifacts = new Map()
const packages = []
for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
  if (packagePath === '') continue
  if (entry.link || !entry.resolved || !entry.integrity) throw new Error(`Not a pinned registry artifact: ${packagePath}`)
  const url = new URL(entry.resolved)
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password) {
    throw new Error(`Unsupported dependency source: ${packagePath}`)
  }
  const name = entry.name ?? packagePath.split('node_modules/').at(-1)
  const integrity = entry.integrity.split(/\s+/).find(value => value.startsWith('sha512-') || value.startsWith('sha256-'))
  if (!integrity) throw new Error(`Unsupported integrity: ${packagePath}`)
  const split = integrity.indexOf('-')
  const algorithm = integrity.slice(0, split)
  const expected = integrity.slice(split + 1)
  const id = createHash('sha256').update(entry.resolved + '\n' + entry.integrity).digest('hex').slice(0, 16)
  const file = `${name.replace(/[^A-Za-z0-9._-]/g, '_')}-${entry.version}-${id}.tgz`
  let artifact = artifacts.get(file)
  if (!artifact) {
    let bytes
    try {
      bytes = await fs.readFile(path.join(directory, file))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (bytes === undefined) {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (!response.ok) throw new Error(`Download failed (${response.status}): ${packagePath}`)
      bytes = Buffer.from(await response.arrayBuffer())
    }
    if (createHash(algorithm).update(bytes).digest('base64') !== expected) throw new Error(`Integrity mismatch: ${packagePath}`)
    if (bytes.length >= 100 * 1024 * 1024) throw new Error(`Artifact exceeds GitHub file limit: ${packagePath}`)
    await fs.writeFile(path.join(directory, file), bytes)
    artifact = { file: `npm/${file}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: entry.integrity, resolved: entry.resolved }
    artifacts.set(file, artifact)
  }
  packages.push({ packagePath, name, version: entry.version, dev: entry.dev === true, optional: entry.optional === true, ...artifact })
  console.log(`verified ${name}@${entry.version}`)
}
const manifest = {
  formatVersion: 1,
  packageName: lock.name,
  packageVersion: lock.version,
  lockfileCanonicalSha256: createHash('sha256').update(JSON.stringify(lock)).digest('hex'),
  packageCount: packages.length,
  artifactCount: artifacts.size,
  totalArtifactBytes: [...artifacts.values()].reduce((sum, value) => sum + value.size, 0),
  packages,
}
await fs.writeFile(path.join(root, 'vendor', 'dependencies.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`VENDORED packages=${manifest.packageCount} artifacts=${manifest.artifactCount} bytes=${manifest.totalArtifactBytes}`)
