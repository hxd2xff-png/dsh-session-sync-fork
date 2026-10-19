// Resolve Git without assuming the desktop host inherited a freshly updated PATH.
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

export async function resolveGitExecutable(subprocess, gitBin, signal, { platform = process.platform, env = process.env, accessible = async candidate => { try { await access(candidate, constants.X_OK); return true } catch { return false } } } = {}) {
  try { return await subprocess.resolveExecutable(gitBin, undefined, signal) } catch (error) {
    // Never replace an explicitly selected executable or mask cancellation.
    if (signal?.aborted || platform !== 'win32' || !['git', 'git.exe'].includes(gitBin.toLowerCase())) throw error
    const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)
    const candidates = roots.map(root => path.win32.join(root, 'Git', 'cmd', 'git.exe'))
    if (env.LOCALAPPDATA) candidates.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'))
    for (const candidate of new Set(candidates)) {
      if (await accessible(candidate)) return await subprocess.resolveExecutable(candidate, undefined, signal)
    }
    throw error
  }
}
