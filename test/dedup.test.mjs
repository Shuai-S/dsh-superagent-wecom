/** dedup.ts 闸门测试：环持久化、上限丢最旧、损坏恢复、空 id、隔离与净化。全部走临时目录。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEEN_LIMIT, sanitizeSegment, seenFile, seenOrAdd } from '../lib/index.js'

const tmp = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-dedup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('首见 false / 再见 true；持久化 {version:1,ids:[]}，文件名 seen-<key>.json', async (t) => {
  const dir = await tmp(t)
  assert.equal(await seenOrAdd('acc1', 'm1', dir), false)
  assert.equal(await seenOrAdd('acc1', 'm1', dir), true)
  assert.equal(await seenOrAdd('acc1', 'm2', dir), false)
  assert.equal(seenFile('acc1', dir), join(dir, 'seen-acc1.json'))
  const stored = JSON.parse(await readFile(seenFile('acc1', dir), 'utf8'))
  assert.equal(stored.version, 1)
  assert.deepEqual(stored.ids, ['m1', 'm2'])
})

test('上限 SEEN_LIMIT：挤入新 id 丢最旧，被丢者重新视为首见', async (t) => {
  const dir = await tmp(t)
  for (let i = 0; i < SEEN_LIMIT; i++) await seenOrAdd('k', 'id-' + i, dir)
  assert.equal(await seenOrAdd('k', 'id-0', dir), true) // 仍在环内
  await seenOrAdd('k', 'id-' + SEEN_LIMIT, dir)
  const stored = JSON.parse(await readFile(seenFile('k', dir), 'utf8'))
  assert.equal(stored.ids.length, SEEN_LIMIT)
  assert.equal(stored.ids[0], 'id-1')
  assert.equal(await seenOrAdd('k', 'id-0', dir), false)
})

test('读失败（损坏文件）：按空重来、重写为合法文件、判重恢复', async (t) => {
  const dir = await tmp(t)
  await mkdir(dir, { recursive: true })
  await writeFile(seenFile('bad', dir), '{not json', 'utf8')
  assert.equal(await seenOrAdd('bad', 'm1', dir), false)
  const stored = JSON.parse(await readFile(seenFile('bad', dir), 'utf8'))
  assert.equal(stored.version, 1)
  assert.deepEqual(stored.ids, ['m1'])
  assert.equal(await seenOrAdd('bad', 'm1', dir), true)
})

test('空 id：恒 false 且不入环、不建文件（事件类消息交给下游过滤）', async (t) => {
  const dir = await tmp(t)
  assert.equal(await seenOrAdd('e', '', dir), false)
  assert.equal(await seenOrAdd('e', '', dir), false)
  await assert.rejects(() => readFile(seenFile('e', dir), 'utf8'))
})

test('storeKey 隔离 + sanitizeSegment 防路径注入', async (t) => {
  const dir = await tmp(t)
  assert.equal(await seenOrAdd('x1', 'm1', dir), false)
  assert.equal(await seenOrAdd('x2', 'm1', dir), false) // 各自文件互不影响
  assert.notEqual(seenFile('x1', dir), seenFile('x2', dir))
  const evil = seenFile('../../etc/passwd', dir)
  assert.ok(evil.startsWith(join(dir, 'seen-')))
  assert.ok(!evil.includes('..'))
  assert.equal(sanitizeSegment('a b/c.d'), 'a_b_c_d')
})
