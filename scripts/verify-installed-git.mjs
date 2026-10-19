// Read-only installed resolver smoke check. This is not a live-host acceptance test.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
const profile = process.env.DSH_PROFILE_DIR
if (!profile) throw new Error('DSH_PROFILE_DIR is required')
const { resolveGitExecutable } = await import(pathToFileURL(join(profile, 'node_modules', 'dsh-session-sync', 'lib', 'git-executable.mjs')).href)
let fallback = false
const runtime = { async resolveExecutable(command) {
  if (command === 'git') throw new Error('command git was not found on PATH')
  if (!isAbsolute(command)) throw new Error('Expected absolute Git fallback')
  await access(command)
  fallback = true
  return command
} }
const executable = await resolveGitExecutable(runtime, 'git')
const result = await promisify(execFile)(executable, ['--version'], { timeout: 15000, windowsHide: true })
if (!fallback) throw new Error('Installed Git fallback was not exercised')
console.log(JSON.stringify({ installedResolver: true, simulatedMissingPath: true, fallbackUsed: fallback, version: result.stdout.trim() }))
