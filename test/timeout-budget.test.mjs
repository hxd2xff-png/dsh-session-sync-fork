// test/timeout-budget.test.mjs — 命令超时必须容得下首次大推送。
// 实测依据（2026-10-15，本机）：36MB 会话数据首次推送耗时 264.0s（git push 手工计时），
// 同一命令无新数据时 2.0s。旧默认 120000ms 会让正常首次推送失败：
// "git push failed: git push timed out after 120000ms"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULTS, LIMITS } from '../lib/constants.mjs'

const MEASURED_FIRST_PUSH_MS = 264_000

test('默认命令超时容得下实测首次推送耗时并留有余量', () => {
  assert.ok(
    DEFAULTS.COMMAND_TIMEOUT_MS >= MEASURED_FIRST_PUSH_MS * 1.5,
    `COMMAND_TIMEOUT_MS=${DEFAULTS.COMMAND_TIMEOUT_MS} 对实测首次推送 ${MEASURED_FIRST_PUSH_MS}ms 余量不足`,
  )
})

test('默认命令超时不超过配置上限（可被 commandTimeoutMs 覆盖）', () => {
  assert.ok(DEFAULTS.COMMAND_TIMEOUT_MS <= LIMITS.MAX_COMMAND_TIMEOUT_MS)
  assert.ok(DEFAULTS.COMMAND_TIMEOUT_MS > LIMITS.MIN_COMMAND_TIMEOUT_MS)
})

// 回归：随包 patch 层一旦写下 commandTimeoutMs，就成了一条显式配置，永远压过
// DEFAULTS —— 2026-10-15 的真实事故：constants.mjs 已改到 600000，随包 patch 仍
// 钉着 120000，所有挂载该 bundle 的 profile 继续 "git push timed out after 120000ms"。
// 修 DEFAULTS 却漏了 patch 层 = 打错靶子。此断言锁死"该字段只能有一个事实源"。
test('随包 cordis.patch.yml 不得钉住 commandTimeoutMs（默认值只能来自 constants.mjs）', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const pinned = patch
    .split(/\r?\n/u)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /^\s*commandTimeoutMs\s*:/u.test(line))
  assert.deepEqual(
    pinned,
    [],
    pinned.length === 0
      ? ''
      : `cordis.patch.yml 第 ${pinned.map((p) => p.number).join(', ')} 行钉住了 commandTimeoutMs：` +
        `${pinned.map((p) => p.line.trim()).join(' | ')}。` +
        '显式配置会压过 DEFAULTS，请删掉该行，把值留在 lib/constants.mjs；' +
        '需要不同值的部署应改自己的 profile patch。',
  )
})

test('随包 cordis.patch.yml 仍然挂载 session-sync 行（删除字段不等于删掉插件）', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /^- insert:\s*$/mu, 'patch 必须仍以 insert 形式挂载插件行')
  assert.match(patch, /^\s+- id: session-sync\s*$/mu, 'patch 必须仍插入 id: session-sync 行')
  assert.match(patch, /^\s+name: dsh-session-sync\s*$/mu, 'patch 必须仍指向 dsh-session-sync 包')
})
