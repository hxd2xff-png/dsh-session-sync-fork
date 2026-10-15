// test/personal-paths.test.mjs — 快照消毒/展开契约（设备路径一律动态识别的全局规则落地）。
// homedir() 不可注入，因此断言全部基于「与 homedir() 的关系」而不是具体值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { sanitizePersonalPaths, expandPersonalPaths } from '../lib/cloud-core.mjs'

const home = homedir()
const forward = home.replaceAll('\\', '/')

test('消毒：正斜杠个人路径 → ~/ 占位', () => {
  const input = `{"dsh-codex-connect": "file:${forward}/../dsh-codex-connect"}`
  const result = sanitizePersonalPaths(input)
  assert.equal(result.includes(home), false)
  assert.equal(result.includes(forward), false)
  assert.ok(result.includes('file:~/../dsh-codex-connect'), result)
})

test('消毒：反斜杠个人路径（JSON 转义 \\\\ 形态）也替换', () => {
  const jsonEscaped = `file:${home.replaceAll('/', '\\\\')}\\\\Documents\\\\x`
  const result = sanitizePersonalPaths(jsonEscaped)
  assert.equal(result.includes(home.replaceAll('/', '\\\\')), false, result)
  assert.ok(result.includes('~/'), result)
})

test('消毒不吞结尾引号：JSON 结构保持合法', () => {
  const input = `{"a":"file:${forward}/dsh-codex-connect"}`
  const result = sanitizePersonalPaths(input)
  const parsed = JSON.parse(result)
  assert.equal(parsed.a, `file:~/dsh-codex-connect`)
})

test('展开是消毒的逆操作：roundtrip 恢复本机路径', () => {
  const original = `file:${forward}/Documents/deepseek-harness/default-workspace/dsh-codex-connect`
  const sanitized = sanitizePersonalPaths(original)
  assert.equal(sanitized, `file:~/Documents/deepseek-harness/default-workspace/dsh-codex-connect`)
  assert.equal(expandPersonalPaths(sanitized), original)
})

test('展开只处理 ~/ 占位，不误伤普通波浪号或相对路径', () => {
  assert.equal(expandPersonalPaths('./relative/path'), './relative/path')
  assert.equal(expandPersonalPaths('~/a/b'), `${forward}/a/b`)
  assert.equal(expandPersonalPaths('user~name'), 'user~name')
})

test('消毒对不含个人路径的文本零改动（幂等）', () => {
  const clean = '{"dependencies":{"x":"^1.0.0"}}\n# comment /usr/local/bin\n'
  assert.equal(sanitizePersonalPaths(clean), clean)
})
