/** 集成闸门测试（零外网）：① callback 去重接线（同 MsgId 重推只派发一次、空 id 不判重、
 *  状态文件落盘）；② channel.send 分块发送与失败语义（首块失败抛出 / 后续块失败按已送达
 *  收尾 + 失败留痕 / sendAck 关闭跳过 / 机器人 M3 前抛出与 ack 静默丢弃）。
 *  fetch 全部打桩到本地 Response，无真实请求。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  channelConfig, encrypt, seenFile, setFailureLogBaseDirForTests, signatureOf,
  startCallbackServer, wecomKind, wecomStats, WecomConfigSchema,
} from '../lib/index.js'

const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

test('callback 去重接线：同 MsgId 重推只派发一次；空 id 事件不判重；环文件落盘', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-it-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const CORP = 'wwit01'
  const account = { name: 'it', corpid: CORP, agentid: '1', token: 'tok', encodingAESKey: KEY, callbackPath: 'acc' }
  const received = []
  const server = await startCallbackServer({
    port: 0, bindAddress: '127.0.0.1', accounts: [account], bots: [], seenBaseDir: dir,
    onMessage: (m) => { received.push(m) },
    onBotMessage: () => {},
  })
  t.after(() => { server.close() })
  const base = 'http://127.0.0.1:' + server.address().port + '/callback/acc'
  const post = async (innerXml) => {
    const enc = encrypt(KEY, innerXml, CORP)
    const outer = '<xml><Encrypt><![CDATA[' + enc + ']]></Encrypt><AgentID><![CDATA[1]]></AgentID></xml>'
    const res = await fetch(base + '?msg_signature=' + encodeURIComponent(signatureOf('tok', '1700000000', 'n1', enc)) + '&timestamp=1700000000&nonce=n1', { method: 'POST', body: outer })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'success')
  }
  const MSG = (id) => '<xml><FromUserName><![CDATA[zhang]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi]]></Content><MsgId>' + id + '</MsgId></xml>'
  const EVENT = '<xml><FromUserName><![CDATA[zhang]]></FromUserName><CreateTime>1700000001</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>'
  await post(MSG('9001'))
  await post(MSG('9001')) // 应答丢失后的重推
  await post(MSG('9002'))
  await post(EVENT) // 无 MsgId：空 id 跳过去重
  await post(EVENT)
  await new Promise((resolve) => setTimeout(resolve, 200))
  // 断言用计数论断而非到达序：空 id 事件不经磁盘去重、带 id 消息要过文件环，
  // 跨请求派发顺序允许交错；去重不变量是「9001×1、9002×1、event×2」。
  assert.deepEqual(received.map((m) => m.fields.MsgId ?? 'event').sort(), ['9001', '9002', 'event', 'event'])
  const stored = JSON.parse(await readFile(seenFile('acc', dir), 'utf8'))
  assert.deepEqual(stored.ids, ['9001', '9002'])
})

test('channel.send 分块：3600 字节中文按 2048 上限切两块、拼接还原、out 计数 +1', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-it2-'))
  const realFetch = globalThis.fetch
  t.after(() => {
    setFailureLogBaseDirForTests(undefined)
    channelConfig.current = undefined
    globalThis.fetch = realFetch
    return rm(dir, { recursive: true, force: true })
  })
  setFailureLogBaseDirForTests(dir)
  const config = WecomConfigSchema.parse({ accounts: [{ name: 'a', corpid: 'wwsend01', secret: 'sec', agentid: '1000002', token: 'tok', encodingAESKey: KEY, callbackPath: 'acc' }] })
  channelConfig.current = config
  const sent = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('gettoken')) return new Response(JSON.stringify({ errcode: 0, access_token: 'T', expires_in: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } })
    sent.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const before = { out: wecomStats.out, fail: wecomStats.fail }
  const message = (id, text, kind = 'reply') => ({ id, channel: { source: 'wecom', thread: 'wecom:u:zhang', address: { account: 'acc', touser: 'zhang' } }, text, kind })
  const longText = '啊'.repeat(1200) // 3600 字节
  assert.equal(await wecomKind.channel.send(undefined, message('m1', longText)), 'sent')
  assert.equal(sent.length, 2)
  assert.ok(sent.every((b) => Buffer.byteLength(b.text.content, 'utf8') <= 2048))
  assert.equal(sent.map((b) => b.text.content).join(''), longText)
  assert.equal(wecomStats.out - before.out, 1)
  assert.equal(wecomStats.fail - before.fail, 0)
})

test('channel.send 失败语义：首块失败抛出并留痕；后续块失败返回 sent 且留痕（防整条重发）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-it3-'))
  const realFetch = globalThis.fetch
  t.after(() => {
    setFailureLogBaseDirForTests(undefined)
    channelConfig.current = undefined
    globalThis.fetch = realFetch
    return rm(dir, { recursive: true, force: true })
  })
  setFailureLogBaseDirForTests(dir)
  const config = WecomConfigSchema.parse({ accounts: [{ name: 'a', corpid: 'wwsend02', secret: 'sec', agentid: '1000002', token: 'tok', encodingAESKey: KEY, callbackPath: 'acc' }] })
  channelConfig.current = config
  const token = () => new Response(JSON.stringify({ errcode: 0, access_token: 'T', expires_in: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } })
  const errRes = () => new Response(JSON.stringify({ errcode: 60020, errmsg: 'ip not trusted' }), { status: 200, headers: { 'content-type': 'application/json' } })
  const okRes = () => new Response(JSON.stringify({ errcode: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
  const message = (id, text, kind = 'reply') => ({ id, channel: { source: 'wecom', thread: 'wecom:u:zhang', address: { account: 'acc', touser: 'zhang' } }, text, kind })
  const readFailures = async () => (await readFile(join(dir, 'send-failures.jsonl'), 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))

  // 首块失败：抛出（引擎干净重试），失败留痕 1 条
  globalThis.fetch = async (url) => (String(url).includes('gettoken') ? token() : errRes())
  const failsBefore = wecomStats.fail
  await assert.rejects(() => wecomKind.channel.send(undefined, message('m2', 'hi')), /wecom send failed/)
  assert.equal(wecomStats.fail - failsBefore, 1)
  const logged1 = await readFailures()
  assert.equal(logged1.length, 1)
  assert.equal(logged1[0].channelKey, 'acc')
  assert.equal(logged1[0].kind, 'reply')
  assert.match(logged1[0].error, /60020/)

  // 后续块失败：返回 sent（防整条重发），两块都尝试过，失败留痕累计 2 条
  let sendCalls = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('gettoken')) return token()
    sendCalls += 1
    return sendCalls === 1 ? okRes() : errRes()
  }
  assert.equal(await wecomKind.channel.send(undefined, message('m3', 'a'.repeat(3000))), 'sent')
  assert.equal(sendCalls, 2)
  const logged2 = await readFailures()
  assert.equal(logged2.length, 2)
  assert.match(logged2[1].error, /60020/)
})

test('channel.send 其他分支：sendAck=false 静默跳过；机器人 ack 静默丢弃；机器人 reply M3 前抛出', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => {
    channelConfig.current = undefined
    globalThis.fetch = realFetch
  })
  let fetchCalls = 0
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('must not fetch') }
  const account = { name: 'a', corpid: 'wwsend03', secret: 'sec', agentid: '1', token: 'tok', encodingAESKey: KEY, callbackPath: 'acc' }
  channelConfig.current = WecomConfigSchema.parse({ accounts: [account], sendAck: false })
  const message = (kind, address) => ({ id: 'm', channel: { source: 'wecom', thread: 't', address }, text: 'x', kind })
  assert.equal(await wecomKind.channel.send(undefined, message('acknowledgement', { account: 'acc', touser: 'z' })), 'sent')
  assert.equal(fetchCalls, 0) // 未触发任何请求

  channelConfig.current = WecomConfigSchema.parse({ bots: [{ name: 'b', token: 't', encodingAESKey: KEY, callbackPath: 'bp' }] })
  assert.equal(await wecomKind.channel.send(undefined, message('acknowledgement', { bot: 'bp' })), 'sent')
  await assert.rejects(() => wecomKind.channel.send(undefined, message('reply', { bot: 'bp' })), /M3/)
  assert.equal(fetchCalls, 0)
})
