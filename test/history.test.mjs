// test/history.test.mjs — 提交记录解析与来源标记（纯函数）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLogRecords, commitSource, deleteHistoryCommit } from '../lib/history.mjs'

const RS = '\u0000'
const US = '\u001f'

test('解析单条记录', () => {
  const stdout = `abc123${US}2026-10-14T10:00:00+08:00${US}Alice${US}dsh-session-sync: manual backup${US}${RS}`
  const records = parseLogRecords(stdout)
  assert.equal(records.length, 1)
  assert.equal(records[0].sha, 'abc123')
  assert.equal(records[0].author, 'Alice')
  assert.equal(records[0].subject, 'dsh-session-sync: manual backup')
  assert.ok(records[0].at > 0)
})

test('解析多条记录且保持顺序', () => {
  const stdout = [
    `aaa${US}2026-10-14T10:00:00+08:00${US}A${US}first${US}${RS}`,
    `bbb${US}2026-10-13T10:00:00+08:00${US}B${US}second${US}${RS}`,
  ].join('\n')
  const records = parseLogRecords(stdout)
  assert.equal(records.length, 2)
  assert.equal(records[0].sha, 'aaa')
  assert.equal(records[1].sha, 'bbb')
})

test('提交信息含换行不串行', () => {
  const stdout = `ccc${US}2026-10-14T10:00:00+08:00${US}A${US}subject line${US}body line 1\nbody line 2${RS}`
  const records = parseLogRecords(stdout)
  assert.equal(records.length, 1)
  assert.match(records[0].body, /body line 2/)
})

test('空输入安全返回空数组', () => {
  assert.deepEqual(parseLogRecords(''), [])
  assert.deepEqual(parseLogRecords('   '), [])
})

test('无提交的仓库（空串）不产生记录', () => {
  assert.equal(parseLogRecords('').length, 0)
})

test('来源标记：手动 / 自动 / 未知', () => {
  assert.equal(commitSource('dsh-session-sync: manual backup'), 'manual')
  assert.equal(commitSource('dsh-session-sync: automatic backup'), 'automatic')
  assert.equal(commitSource('dsh-session-sync: push snapshot'), 'unknown')
  assert.equal(commitSource('Merge branch main'), 'unknown')
  assert.equal(commitSource(''), 'unknown')
})

test('来源标记大小写不敏感', () => {
  assert.equal(commitSource('DSH-SESSION-SYNC: MANUAL BACKUP'), 'manual')
})

const SHA1 = '1111111111111111111111111111111111111111'
const SHA2 = '2222222222222222222222222222222222222222'
const SHA3 = '3333333333333333333333333333333333333333'

function historyEntry(sha, parents = []) {
  return {
    sha,
    tree: `tree-${sha[0]}`,
    parents,
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    authorIso: '2026-10-15T10:00:00+08:00',
    committerName: 'Alice',
    committerEmail: 'alice@example.com',
    committerIso: '2026-10-15T10:00:00+08:00',
    subject: `backup-${sha[0]}`,
    body: '',
  }
}

function fakeHistoryGit(overrides = {}) {
  const calls = []
  const chain = [
    historyEntry(SHA1),
    historyEntry(SHA2, [SHA1]),
    historyEntry(SHA3, [SHA2]),
  ]
  let rebuilt = 0
  const git = {
    async fetch() { calls.push(['fetch']) },
    async headSha() { return SHA3 },
    async remoteHeadSha() { return SHA3 },
    async countCommitsSafe() { return 0 },
    async historyChain(limit) { calls.push(['historyChain', limit]); return chain },
    async commitTree(tree, opts) {
      rebuilt += 1
      const sha = ['a', 'b', 'c'][rebuilt - 1].repeat(40)
      calls.push(['commitTree', tree, opts])
      return sha
    },
    async retargetBranch(sha, remoteSha) { calls.push(['retargetBranch', sha, remoteSha]) },
    async pushRewritten(leaseSha) { calls.push(['pushRewritten', leaseSha]) },
    async push() { calls.push(['push']) },
    ...overrides,
  }
  return { git, calls, chain }
}

test('删除中间历史：重放提交、移动本地 ref 并使用远端 lease 强推', async () => {
  const { git, calls } = fakeHistoryGit()
  const result = await deleteHistoryCommit(/** @type {any} */ (git), { commit: SHA2 })
  assert.deepEqual(result, { ok: true, deleted: SHA2, head: 'a'.repeat(40), remaining: 2 })
  const rebuilt = calls.filter(([name]) => name === 'commitTree')
  assert.equal(rebuilt.length, 1)
  assert.deepEqual(rebuilt[0][2].parents, [SHA1])
  assert.ok(calls.some(call => call[0] === 'retargetBranch' && call[1] === 'a'.repeat(40) && call[2] === SHA3))
  assert.ok(calls.some(call => call[0] === 'pushRewritten' && call[1] === SHA3))
  assert.deepEqual(calls.at(-1), ['retargetBranch', 'a'.repeat(40), 'a'.repeat(40)])
})

test('历史重写推送失败时回滚本地与 origin 跟踪 ref', async () => {
  const { git, calls } = fakeHistoryGit({
    async pushRewritten() { calls.push(['pushRewritten', SHA3]); throw new Error('lease rejected') },
  })
  await assert.rejects(() => deleteHistoryCommit(/** @type {any} */ (git), { commit: SHA2 }), /lease rejected/u)
  assert.deepEqual(calls.at(-1), ['retargetBranch', SHA3, SHA3])
})

test('远端存在本地没有的提交时拒绝重写', async () => {
  let chainRead = false
  const { git } = fakeHistoryGit({
    async countCommitsSafe() { return 1 },
    async historyChain() { chainRead = true; return [] },
  })
  await assert.rejects(() => deleteHistoryCommit(/** @type {any} */ (git), { commit: SHA2 }), /远端领先本地/u)
  assert.equal(chainRead, false)
})

test('合并提交作为删除目标时拒绝重写', async () => {
  const { git, chain } = fakeHistoryGit()
  chain[1] = historyEntry(SHA2, [SHA1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
  await assert.rejects(() => deleteHistoryCommit(/** @type {any} */ (git), { commit: SHA2 }), /合并提交不可删除/u)
})
