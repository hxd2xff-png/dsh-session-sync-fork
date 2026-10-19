// lib/history.mjs — 备份历史（git 提交）查询与还原目标读取。
//
// 以真实 Git 提交为唯一事实来源：不做旁车账本，页面看到的就是仓库历史。
// 查询全部只读（log/ls-tree/cat-file/diff），不写工作树；
// 删除历史（deleteHistoryCommit）是唯一受控写路径：fetch 同步 →
// commit-tree 重建链（树对象原样复用）→ update-ref 移动本地 ref →
// --force-with-lease 强推（远端被他人推进时拒绝），绝不 reset/clean。

import { COMMIT_MESSAGE_PREFIX, FORK_NAME_RE, MIRROR_DIR } from './constants.mjs'
import { sanitizeRemote } from './sanitize.mjs'
import { badConfig } from './errors.mjs'

// 记录分隔符（git log 的 %x00/%x1f 格式；不用换行，提交信息可能含换行）。
const RECORD_SEP = '\u0000'
const FIELD_SEP = '\u001f'

/**
 * 解析 git log 输出为提交记录。
 * 期望格式（每条）：sha<US>iso<US>authorName<US>subject<US>body<RS>
 * @param {string} stdout - git log 原始输出。
 * @returns {Array<{sha: string, at: number, author: string, subject: string, body: string}>}
 */
export function parseLogRecords(stdout) {
  const out = []
  for (const raw of String(stdout).split(RECORD_SEP)) {
    const record = raw.replace(/^\r?\n/u, '')
    if (record.trim() === '') continue
    const [sha, iso, author, subject, body = ''] = record.split(FIELD_SEP)
    if (typeof sha !== 'string' || sha.trim() === '') continue
    const at = Date.parse(iso ?? '')
    out.push({
      sha: sha.trim(),
      at: Number.isFinite(at) ? at : 0,
      author: (author ?? '').trim(),
      subject: (subject ?? '').trim(),
      body: body.trim(),
    })
  }
  return out
}

/**
 * 提交来源：手动 / 自动 / 未知（旧版本或外部提交）。
 * 依据提交信息前缀判断，前缀缺失即未知——绝不臆测。
 * @param {string} subject - 提交标题。
 * @returns {'manual'|'automatic'|'unknown'}
 */
export function commitSource(subject) {
  const text = String(subject ?? '').toLowerCase()
  if (!text.startsWith(COMMIT_MESSAGE_PREFIX)) return 'unknown'
  if (text.includes('automatic')) return 'automatic'
  if (text.includes('manual')) return 'manual'
  // 旧版本的 "push snapshot" / "initial commit" / "local checkpoint" 等归为未知来源。
  return 'unknown'
}

/**
 * 列出备份历史（分页由调用方以 limit 控制；从最新往旧）。
 * @param {import('./git.mjs').GitBackend} git - git 后端。
 * @param {object} deps - {limit, branch, remote}。
 * @returns {Promise<{ok: boolean, remote: string, branch: string, commits: object[], error?: string}>}
 */
export async function listHistory(git, deps) {
  const base = {
    ok: false,
    remote: sanitizeRemote(deps.remote ?? ''),
    branch: deps.branch,
    commits: [],
    error: undefined,
  }
  try {
    const limit = Math.max(1, Math.floor(deps.limit ?? 50))
    const stdout = await git.logRecords(limit)
    const records = parseLogRecords(stdout)
    base.commits = records.map(record => ({
      sha: record.sha,
      shortSha: record.sha.slice(0, 8),
      at: record.at,
      author: record.author,
      subject: record.subject,
      source: commitSource(record.subject),
    }))
    base.ok = true
    return base
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error)
    return base
  }
}

/**
 * 某提交下镜像内的文件清单（相对 MIRROR_DIR 的会话载荷路径）。
 * @param {import('./git.mjs').GitBackend} git - git 后端。
 * @param {string} commit - 提交 sha。
 * @param {string} [mirrorDir] - 镜像目录名。
 * @returns {Promise<string[]>} 相对路径（POSIX，已剥离镜像前缀）。
 */
export async function mirrorFilesAtCommit(git, commit, mirrorDir = MIRROR_DIR) {
  const files = await git.listFilesAtRev(commit)
  const prefix = `${mirrorDir}/`
  return files
    .filter(file => file.startsWith(prefix))
    .map(file => file.slice(prefix.length))
    .filter(file => file.length > 0)
}

/**
 * 统计某提交下镜像里可同步的会话文件数（排除 fork 与宿主私有产物）。
 * @param {import('./git.mjs').GitBackend} git - git 后端。
 * @param {string} commit - 提交 sha。
 * @returns {Promise<number>} 文件数。
 */
export async function countMirrorFilesAtCommit(git, commit) {
  const files = await mirrorFilesAtCommit(git, commit)
  return files.filter(file => {
    const basename = file.split('/').at(-1) ?? ''
    return !FORK_NAME_RE.test(basename) && basename !== 'session.lock'
  }).length
}

/**
 * 删除一条备份历史（会话侧）：重写提交链并同步远端。
 *
 * 语义：目标提交从历史中消失；其**前后**的提交全部保留（树对象原样复用，
 * 数据零丢失——删的是一条历史条目，不是它那份快照之后仍存于后续提交的内容）。
 * 受控护栏：
 * - 先 fetch；远端领先本地（其它设备有未调和的新备份）→ 拒绝（防重写覆盖）；
 * - 合并提交（双亲）不可删（拒绝）；仅剩最后一条不可删（unborn 无意义）；
 * - 推送只走 --force-with-lease=<branch>:<刚 fetch 到的远端 sha>——
 *   推送瞬间远端被他人推进则 lease 失败，绝不静默覆盖；
 * - 本地分支 ref 与远端跟踪 ref 同步移动（防下次备份把删掉的版本重新推回）。
 *
 * @param {import('./git.mjs').GitBackend} git - git 后端。
 * @param {object} deps - {commit: string}。
 * @returns {Promise<{ok: true, deleted: string, head: string, remaining: number}>}
 */
export async function deleteHistoryCommit(git, deps) {
  const wanted = String(deps.commit ?? '').trim()
  if (!/^[0-9a-f]{7,64}$/u.test(wanted)) throw badConfig('commit must be a hex object id')
  // 进度上报（可选，纯增量）：只报真实计数（需重写的提交数 / 已重写数），
  // 不做百分比估算。回调抛错绝不影响删除结果。
  const report = (patch) => {
    if (typeof deps.onProgress !== 'function') return
    try { deps.onProgress(patch) } catch { /* 进度是附加信息，不打扰删除 */ }
  }
  await git.fetch()
  const localHead = await git.headSha()
  const remoteHead = await git.remoteHeadSha()
  if (localHead === undefined) throw badConfig('repository has no commits')
  if (remoteHead !== undefined && (await git.countCommitsSafe(localHead, remoteHead)) > 0) {
    throw badConfig('远端领先本地（其它设备有新备份未调和），请先执行一次备份/拉取后再删除')
  }
  const chain = await git.historyChain(2000)
  if (chain.length === 0) throw badConfig('history is empty')
  if (chain[0].parents.length > 0) throw badConfig('历史超过 2000 条，安全窗口不足，拒绝重写')
  if (chain.length === 1) throw badConfig('仅剩最后一条历史，无法删除（仓库必须保留至少一个提交）')
  const matches = chain.filter(entry => entry.sha.startsWith(wanted))
  if (matches.length === 0) throw badConfig('该提交不在可见历史中（可能已被删除），请刷新后重试')
  if (matches.length > 1) throw badConfig('提交前缀不唯一，请刷新后使用完整提交编号')
  const target = matches[0]
  if (target.parents.length > 1) throw badConfig('合并提交不可删除（会破坏双亲历史结构）')
  // 拓扑序（父先于子）重放：命中目标的提交被跳过，其子代直接挂到它已重放的父上。
  const mapped = new Map()
  let reachedTarget = false
  // 重写总数 = 目标之后的提交数（这些都要重建；目标之前的祖先保留原 SHA）。
  const rewriteTotal = chain.length - chain.indexOf(target) - 1
  let rewritten = 0
  report({ stage: 'delete', files: { done: 0, total: rewriteTotal } })
  for (const entry of chain) {
    if (entry.sha === target.sha) {
      reachedTarget = true
      // 占位映射：让「目标的孩子」继承目标的父（保持链连接）
      mapped.set(entry.sha, entry.parents.length === 0 ? undefined : mapped.get(entry.parents[0]))
      continue
    }
    if (!reachedTarget) {
      // 目标之前的祖先无需重写，保留原 SHA 与所有原始提交头字段。
      mapped.set(entry.sha, entry.sha)
      continue
    }
    const parents = [...new Set(entry.parents.map(parent => mapped.get(parent)).filter(sha => sha !== undefined))]
    const message = entry.body === '' ? entry.subject : `${entry.subject}\n\n${entry.body}`
    const sha = await git.commitTree(entry.tree, {
      parents,
      message,
      env: {
        GIT_AUTHOR_NAME: entry.authorName,
        GIT_AUTHOR_EMAIL: entry.authorEmail,
        GIT_AUTHOR_DATE: entry.authorIso,
        GIT_COMMITTER_NAME: entry.committerName,
        GIT_COMMITTER_EMAIL: entry.committerEmail,
        GIT_COMMITTER_DATE: entry.committerIso,
      },
    })
    mapped.set(entry.sha, sha)
    rewritten += 1
    report({ stage: 'delete', files: { done: rewritten, total: rewriteTotal } })
  }
  const head = mapped.get(chain[chain.length - 1].sha)
  if (typeof head !== 'string') throw badConfig('history rewrite produced no head')
  // pushRewritten 以 HEAD 为源，先移动本地 ref；推送失败必须把本地 ref/跟踪 ref 回滚。
  await git.retargetBranch(head, remoteHead)
  report({ stage: 'delete', files: { done: rewriteTotal, total: rewriteTotal } })
  try {
    if (remoteHead !== undefined) await git.pushRewritten(remoteHead)
    else await git.push()
  } catch (error) {
    await git.retargetBranch(localHead, remoteHead).catch(() => {})
    throw error
  }
  await git.retargetBranch(head, head)
  return { ok: true, deleted: target.sha, head, remaining: chain.length - 1 }
}
