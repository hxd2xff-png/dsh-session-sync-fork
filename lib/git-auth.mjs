import path from 'node:path'
import os from 'node:os'

export function normalizeGitAuth(value = {}) {
  const authMode = value.authMode ?? 'system'
  if (!['system', 'ssh-key'].includes(authMode)) throw new Error('Unsupported Git authentication mode')
  const sshKeyPath = value.sshKeyPath ?? ''
  const forbidden = [34, 39, 36, 96, 37, 33, 38, 124, 60, 62, 94, 59]
  if (typeof sshKeyPath !== 'string' || sshKeyPath.length > 4096 || [...sshKeyPath].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || forbidden.includes(c.charCodeAt(0)))) throw new Error('SSH key path contains unsupported characters')
  const trimmed = sshKeyPath.trim()
  if (trimmed && !path.isAbsolute(trimmed) && !path.win32.isAbsolute(trimmed) && !trimmed.startsWith('~/')) throw new Error('SSH key path must be absolute or start with ~/')
  if (authMode === 'ssh-key' && !trimmed) throw new Error('SSH key path is required')
  return { authMode, sshKeyPath: trimmed }
}

export function gitAuthEnvironment(value = {}) {
  const auth = normalizeGitAuth(value)
  if (auth.authMode === 'system') return {}
  const key = (auth.sshKeyPath.startsWith('~/') ? path.join(os.homedir(), auth.sshKeyPath.slice(2)) : auth.sshKeyPath).replaceAll(String.fromCharCode(92), '/')
  return { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "' + key + '"' }
}
