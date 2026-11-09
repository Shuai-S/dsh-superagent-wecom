/** 主动投递（契约 docs/rpc-contract.md §2，P-B）：targets 读写/原子写/targetId
 *  校验/路由语义（400/404/409/受理）/deliver/test 发送桩 /health 快照 /
 *  sameOrigin 闸门。零外网：HTTP 走本机 loopback 自挂路由，fetch 打桩到本地
 *  Response。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  channelConfig, registerDeliverRoutes, readTargets, SEEN_LIMIT, targetsFile,
  touchTarget, validTargetId, WecomConfigSchema, writeTargets,
} from '../lib/index.js'

const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const ACCOUNT = { name: 'a', corpid: 'wwdlv01', secret: 'sec', agentid: '1000002', token: 'tok', encodingAESKey: KEY, callbackPath: 'acc' }
const API = '/dsh-wecom/api'
const TARGET = { id: 'ops', address: { touser: 'zhang' }, label: '值班', createdAt: '2026-11-09T10:00:00.000Z', lastUsedAt: '2026-11-09T10:00:00.000Z' }

/** 模拟引擎 webServer seam：register 收集 prefix 路由，挂到真实 loopback server。 */
async function mountRoutes(deps) {
  const routes = []
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const route = routes.find((r) => url.startsWith(r.path))
    if (!route) { res.writeHead(404); res.end('no route'); return }
    void route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const webServer = { port: server.address().port, register: (route) => { routes.push(route); return () => {} } }
  registerDeliverRoutes(webServer, deps)
  return { base: 'http://127.0.0.1:' + webServer.port, close: () => new Promise((resolve) => server.close(resolve)) }
}

const post = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' },
  body: JSON.stringify(body ?? {}),
})

/** gettoken + message/send 打桩（仅拦截 qyapi.weixin.qq.com，loopback 请求透传真实 fetch）；返回恢复函数。 */
const stubTokenFetch = (sendResponse) => {
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (!u.includes('qyapi.weixin.qq.com')) return real(url, init)
    if (u.includes('gettoken')) return new Response(JSON.stringify({ errcode: 0, access_token: 'T', expires_in: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } })
    return sendResponse()
  }
  return () => { globalThis.fetch = real }
}

test('targets: 读写回环、形状、原子写无 .tmp 遗留、损坏按空表容错', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-dlv-t-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeTargets([TARGET], dir)
  const list = await readTargets(dir)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'ops')
  assert.equal(list[0].address.touser, 'zhang')
  const raw = JSON.parse(await readFile(targetsFile(dir), 'utf8'))
  assert.equal(raw.version, 1)
  assert.ok(Array.isArray(raw.targets))
  const names = await readdir(dir)
  assert.ok(names.every((n) => !n.includes('.tmp')), 'no tmp left: ' + names.join(','))
  await writeFile(targetsFile(dir), 'not json at all', 'utf8')
  assert.deepEqual(await readTargets(dir), [])
})

test('targets: targetId 校验（1–128 字符 [A-Za-z0-9._@:-]）', () => {
  assert.equal(validTargetId('ops.main@corp:9-_'), true)
  assert.equal(validTargetId('a'.repeat(128)), true)
  assert.equal(validTargetId(''), false)
  assert.equal(validTargetId('a'.repeat(129)), false)
  assert.equal(validTargetId('bad id'), false)
  assert.equal(validTargetId('bad/slash'), false)
  assert.equal(validTargetId(42), false)
})

test('targets: touchTarget 更新 lastUsedAt；未知 id 静默不抛', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-dlv-t2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeTargets([TARGET], dir)
  await touchTarget('ops', dir)
  const list = await readTargets(dir)
  assert.notEqual(list[0].lastUsedAt, TARGET.lastUsedAt)
  await touchTarget('ghost', dir)
  assert.equal((await readTargets(dir)).length, 1)
})

test('deliver: 400 形状非法 / 404 unknown-target / 409 not-ready', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-dlv-r-'))
  t.after(() => { channelConfig.current = undefined; return rm(dir, { recursive: true, force: true }) })
  await writeTargets([TARGET], dir)
  let source
  const { base, close } = await mountRoutes({ source: () => source, baseDir: dir })
  t.after(close)
  let res = await post(base, API + '/deliver', { targetId: 'bad id', text: 'x' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'bad-request')
  res = await post(base, API + '/deliver', { targetId: 'ops', text: '  ' })
  assert.equal(res.status, 400)
  res = await post(base, API + '/deliver', { targetId: 'ops', text: 'x', kind: 'nope' })
  assert.equal(res.status, 400)
  res = await post(base, API + '/deliver', { targetId: 'ghost', text: 'x' })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'unknown-target')
  // 目标存在但 source/config 未就绪 → 409
  source = { receive: () => {} }
  res = await post(base, API + '/deliver', { targetId: 'ops', text: 'x' })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error, 'not-ready')
})

test('deliver: 受理构造非人类 Trigger（human:false、meta.deliver、address 路由）并更新 lastUsedAt', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-dlv-a-'))
  t.after(() => { channelConfig.current = undefined; return rm(dir, { recursive: true, force: true }) })
  await writeTargets([TARGET], dir)
  const received = []
  const source = { receive: (trigger) => { received.push(trigger) } }
  const { base, close } = await mountRoutes({ source: () => source, baseDir: dir })
  t.after(close)
  channelConfig.current = WecomConfigSchema.parse({ accounts: [ACCOUNT] })
  const res = await post(base, API + '/deliver', { targetId: 'ops', text: '发版完成', kind: 'reply' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.accepted, true)
  assert.match(body.triggerId, /^wecom:deliver:/)
  assert.equal(received.length, 1)
  const trig = received[0]
  assert.equal(trig.source, 'wecom')
  assert.equal(trig.human, false)
  assert.equal(trig.addressed, 'direct')
  assert.equal(trig.actor.id, 'dsh-superagent-wecom')
  assert.deepEqual(trig.threads, [{ source: 'wecom', id: 'u:zhang' }])
  assert.equal(trig.channel.address.account, 'acc')
  assert.equal(trig.channel.address.touser, 'zhang')
  assert.equal(trig.meta.deliver, true)
  assert.equal(trig.meta.kind, 'reply')
  // 引擎两道门（machineGate + kind scope()）所需字段断言：addressed:'direct' 过
  // machineGate；meta.accountId 供 wecom kind scope() 判 listened（实读引擎
  // src/policy.ts / src/sources/registry.ts，2026-11-09）。
  assert.equal(trig.addressed, 'direct')
  assert.equal(trig.meta.accountId, 'acc')
  assert.equal(trig.text, '发版完成')
  const list = await readTargets(dir)
  assert.notEqual(list[0].lastUsedAt, TARGET.lastUsedAt)
})

test('deliver/test: 直调 sendAppMessage（fetch 桩）成功与失败；chatid 目标 M3 前明确不可测', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-dlv-s-'))
  t.after(() => { channelConfig.current = undefined; return rm(dir, { recursive: true, force: true }) })
  await writeTargets([TARGET, { id: 'grp', address: { chatid: 'wrjj' }, label: '', createdAt: TARGET.createdAt, lastUsedAt: TARGET.createdAt }], dir)
  const source = { receive: () => {} }
  const { base, close } = await mountRoutes({ source: () => source, baseDir: dir })
  t.after(close)
  channelConfig.current = WecomConfigSchema.parse({ accounts: [ACCOUNT] })
  let restore = stubTokenFetch(() => new Response(JSON.stringify({ errcode: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }))
  try {
    const res = await post(base, API + '/deliver/test', { targetId: 'ops' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.sent, true)
    assert.match(body.detail, /acc/)
  } finally { restore() }
  restore = stubTokenFetch(() => new Response(JSON.stringify({ errcode: 60020, errmsg: 'ip not trusted' }), { status: 200, headers: { 'content-type': 'application/json' } }))
  try {
    const res = await post(base, API + '/deliver/test', { targetId: 'ops' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.sent, false)
    assert.match(body.detail, /60020/)
  } finally { restore() }
  const res3 = await post(base, API + '/deliver/test', { targetId: 'grp' })
  const body3 = await res3.json()
  assert.equal(body3.ok, false)
  assert.match(body3.detail, /M3/)
})

test('health: 状态+计数(deny)+failure-log 尾巴+dedup 水位；sameOrigin 缺头 403', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-dlv-h-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { base, close } = await mountRoutes({ source: () => undefined, baseDir: dir })
  t.after(close)
  const res = await fetch(base + API + '/health', { headers: { 'x-orchestrator-request': '1' } })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(['ready', 'paused'].includes(body.state), true)
  assert.equal(typeof body.counters.in, 'number')
  assert.equal(typeof body.counters.deny, 'number')
  assert.deepEqual(body.failures, [])
  // dedup 水位：seen-*.json（wecom 形状 {version,ids}）
  await writeFile(join(dir, 'seen-acc.json'), JSON.stringify({ version: 1, ids: ['a', 'b'] }), 'utf8')
  const res2 = await fetch(base + API + '/health', { headers: { 'x-orchestrator-request': '1' } })
  const body2 = await res2.json()
  assert.equal(body2.dedup.stores, 1)
  assert.equal(body2.dedup.ids, 2)
  assert.equal(body2.dedup.limit, SEEN_LIMIT)
  const denied = await fetch(base + API + '/health')
  assert.equal(denied.status, 403)
})
