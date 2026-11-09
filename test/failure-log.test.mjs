/** failure-log.ts 闸门测试：条目形状、error 截断、200 行上限重写、写失败不抛出。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, readFile, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAILURE_ERROR_MAX, FAILURE_LOG_LIMIT, appendSendFailure, failureLogFile, setFailureLogBaseDirForTests } from '../lib/index.js'

const tmp = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-flog-'))
  t.after(() => {
    setFailureLogBaseDirForTests(undefined)
    return rm(dir, { recursive: true, force: true })
  })
  setFailureLogBaseDirForTests(dir)
  return dir
}

test('追加 JSONL：条目恰为 {at, channelKey, kind, error}，at 为合法 ISO，error 截 300', async (t) => {
  const dir = await tmp(t)
  assert.equal(failureLogFile(), join(dir, 'send-failures.jsonl'))
  await appendSendFailure({ channelKey: 'acc', kind: 'reply', error: 'x'.repeat(1000) })
  await appendSendFailure({ channelKey: 'acc', kind: 'notice', error: 'boom' })
  const lines = (await readFile(failureLogFile(), 'utf8')).split('\n').filter((l) => l.trim())
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(first).sort(), ['at', 'channelKey', 'error', 'kind'])
  assert.equal(first.error.length, FAILURE_ERROR_MAX)
  assert.equal(first.kind, 'reply')
  assert.notEqual(new Date(first.at).toString(), 'Invalid Date')
  assert.equal(JSON.parse(lines[1]).error, 'boom')
})

test('上限 FAILURE_LOG_LIMIT：超限重写保留最新 200 行', async (t) => {
  const dir = await tmp(t)
  for (let i = 0; i < FAILURE_LOG_LIMIT + 5; i++) {
    await appendSendFailure({ channelKey: 'k' + i, kind: 'reply', error: 'e' })
  }
  const lines = (await readFile(failureLogFile(), 'utf8')).split('\n').filter((l) => l.trim())
  assert.equal(lines.length, FAILURE_LOG_LIMIT)
  assert.equal(JSON.parse(lines[0]).channelKey, 'k5')
  assert.equal(JSON.parse(lines[lines.length - 1]).channelKey, 'k' + (FAILURE_LOG_LIMIT + 4))
})

test('写失败（目录只读）不抛出、不影响主流程', async (t) => {
  const dir = await tmp(t)
  await chmod(dir, 0o500) // 禁止在目录内创建文件
  try {
    await assert.doesNotReject(() => appendSendFailure({ channelKey: 'acc', kind: 'reply', error: 'e' }))
  } finally {
    await chmod(dir, 0o700) // 恢复后才能清理
  }
})
