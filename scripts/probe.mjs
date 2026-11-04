#!/usr/bin/env node
/**
 * Self-test probe for the WeCom Source — no real WeCom credentials needed.
 *
 * Imports the real src/crypto.ts, src/callback.ts and the Trigger mapping via
 * Node's built-in TypeScript type stripping (Node >= 22.18, covered by the
 * package engines field), then asserts the whole callback chain locally:
 *
 *   1. crypto round-trip: encrypt -> decrypt returns the plaintext
 *   2. tampered ciphertext / wrong corpid / bad key make decrypt throw
 *   3. verifySignature accepts the real signature and rejects forged ones
 *   4. a text, an image and an event XML (CDATA) parse and map correctly, and
 *      the schema rejects a non-43-char EncodingAESKey
 *   5. a live local server: GET URL verification (ok + 403) and a signed
 *      encrypted POST (ok + 403)
 *
 * Usage: node scripts/probe.mjs   (run `pnpm install` first)
 */
import process from 'node:process'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

const NODE_MIN = [22, 18]
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor < NODE_MIN[0] || (nodeMajor === NODE_MIN[0] && nodeMinor < NODE_MIN[1])) {
  console.error('probe: needs Node >= 22.18 (built-in TS type stripping); got ' + process.version)
  process.exit(1)
}

let cryptoMod, callbackMod, kindMod
try {
  cryptoMod = await import('../src/crypto.ts')
  callbackMod = await import('../src/callback.ts')
  kindMod = await import('../src/wecom-kind.ts')
} catch (error) {
  console.error('probe: cannot import the TypeScript sources (run pnpm install first):', error && error.message ? error.message : error)
  process.exit(1)
}
const { verifySignature, decrypt, encrypt, signatureOf } = cryptoMod
const { parseWecomXml, startCallbackServer } = callbackMod
const { buildWecomTrigger, WecomConfigSchema } = kindMod

// Test fixture: 43-char EncodingAESKey, a corp id and the callback token.
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const CORP_ID = 'wwprobe01'
const TOKEN = 'probe-token'
const TS = '1700000000'
const NONCE = 'nonce123'

/** Mirror of the WeCom signing over [token, timestamp, nonce, encrypt]. */
const sign = (encrypted) => createHash('sha1').update([TOKEN, TS, NONCE, encrypted].sort().join('')).digest('hex')
const account = { name: 'probe', corpid: CORP_ID, agentid: '1000002', token: TOKEN, encodingAESKey: KEY, callbackPath: 'probe' }

let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ' + name) }
const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()))

console.log('probe: 1. crypto round-trip')
{
  const plain = '你好，企业微信！Hello WeCom 123'
  const encrypted = encrypt(KEY, plain, CORP_ID)
  assert.equal(decrypt(KEY, encrypted, CORP_ID), plain)
  ok('encrypt -> decrypt returns the plaintext')
}

console.log('probe: 2. decrypt negative cases')
{
  const encrypted = encrypt(KEY, 'secret text', CORP_ID)
  const buf = Buffer.from(encrypted, 'base64')
  buf[buf.length - 1] = 0x7f // corrupt the PKCS7 padding byte
  assert.throws(() => decrypt(KEY, buf.toString('base64'), CORP_ID))
  assert.throws(() => decrypt(KEY, encrypted, 'other-corp'), /receiveid/)
  assert.throws(() => decrypt('too-short-key', encrypted, CORP_ID))
  ok('tampered ciphertext / wrong corpid / bad key all throw')
}

console.log('probe: 3. signature check')
{
  const encrypted = encrypt(KEY, 'x', CORP_ID)
  assert.equal(signatureOf(TOKEN, TS, NONCE, encrypted), sign(encrypted))
  assert.equal(verifySignature(TOKEN, TS, NONCE, encrypted, sign(encrypted)), true)
  assert.equal(verifySignature(TOKEN, TS, NONCE, encrypted, 'f'.repeat(40)), false)
  assert.equal(verifySignature(TOKEN, TS, NONCE, encrypted, 'short'), false)
  ok('real signature accepted, forged ones rejected')
}

const TEXT_XML = [
  '<xml>',
  '<ToUserName><![CDATA[wwcorp]]></ToUserName>',
  '<FromUserName><![CDATA[zhangsan]]></FromUserName>',
  '<CreateTime>1700000000</CreateTime>',
  '<MsgType><![CDATA[text]]></MsgType>',
  '<Content><![CDATA[帮我查一下服务状态]]></Content>',
  '<MsgId>7000000000000001</MsgId>',
  '<AgentID>1000002</AgentID>',
  '</xml>',
].join('\n')
const IMAGE_XML = [
  '<xml>',
  '<ToUserName><![CDATA[wwcorp]]></ToUserName>',
  '<FromUserName><![CDATA[zhangsan]]></FromUserName>',
  '<CreateTime>1700000001</CreateTime>',
  '<MsgType><![CDATA[image]]></MsgType>',
  '<PicUrl><![CDATA[https://example.test/pic.jpg]]></PicUrl>',
  '<MediaId><![CDATA[MEDIA_ID_1]]></MediaId>',
  '<MsgId>7000000000000002</MsgId>',
  '<AgentID>1000002</AgentID>',
  '</xml>',
].join('\n')
const EVENT_XML = [
  '<xml>',
  '<ToUserName><![CDATA[wwcorp]]></ToUserName>',
  '<FromUserName><![CDATA[zhangsan]]></FromUserName>',
  '<CreateTime>1700000002</CreateTime>',
  '<MsgType><![CDATA[event]]></MsgType>',
  '<Event><![CDATA[subscribe]]></Event>',
  '<AgentID>1000002</AgentID>',
  '</xml>',
].join('\n')

console.log('probe: 4. XML parse + Trigger mapping')
{
  const fields = parseWecomXml(TEXT_XML)
  assert.equal(fields.FromUserName, 'zhangsan')
  assert.equal(fields.MsgType, 'text')
  assert.equal(fields.Content, '帮我查一下服务状态')
  assert.equal(fields.MsgId, '7000000000000001')
  assert.equal(fields.AgentID, '1000002')
  const trigger = buildWecomTrigger({ account, fields, xml: TEXT_XML })
  assert.equal(trigger.id, 'wecom:7000000000000001')
  assert.equal(trigger.source, 'wecom')
  assert.deepEqual(trigger.threads, [{ source: 'wecom', id: 'u:zhangsan' }])
  assert.deepEqual(trigger.actor, { source: 'wecom', id: 'zhangsan' })
  assert.equal(trigger.human, true)
  assert.equal(trigger.addressed, 'direct')
  assert.equal(trigger.at, new Date(1700000000 * 1000).toISOString())
  assert.equal(trigger.text, '帮我查一下服务状态')
  assert.equal(trigger.channel.thread, 'wecom:u:zhangsan')
  assert.equal(trigger.channel.address.account, 'probe')
  assert.equal(trigger.channel.address.touser, 'zhangsan')
  assert.equal(trigger.channel.address.msgId, '7000000000000001')
  assert.equal(trigger.meta.messageId, '7000000000000001')
  assert.equal(trigger.meta.msgType, 'text')
  ok('text XML parses and maps to a direct Trigger')

  const imageFields = parseWecomXml(IMAGE_XML)
  const imageTrigger = buildWecomTrigger({ account, fields: imageFields, xml: IMAGE_XML })
  assert.equal(imageTrigger.text, '[wecom-image]')
  assert.equal(imageTrigger.meta.picUrl, 'https://example.test/pic.jpg')
  assert.equal(imageTrigger.meta.mediaId, 'MEDIA_ID_1')
  ok('image XML maps with PicUrl/MediaId in meta')

  const eventTrigger = buildWecomTrigger({ account, fields: parseWecomXml(EVENT_XML), xml: EVENT_XML })
  assert.equal(eventTrigger, undefined)
  ok('event XML without MsgId produces no Trigger')

  assert.throws(() => WecomConfigSchema.parse({ accounts: [{ corpid: 'ww1', secret: 's', agentid: '1', token: 't', callbackPath: 'p', encodingAESKey: 'too-short' }] }))
  assert.throws(() => WecomConfigSchema.parse({ accounts: [{ corpid: 'ww1', secret: 's', agentid: '1', token: 't', callbackPath: 'p', encodingAESKey: '' }] }))
  WecomConfigSchema.parse({ accounts: [{ corpid: 'ww1', secret: 's', agentid: '1', token: 't', callbackPath: 'p', encodingAESKey: KEY }] })
  ok('schema demands an exact 43-char EncodingAESKey')
}

console.log('probe: 5. live callback server')
{
  const received = []
  const server = await startCallbackServer({ port: 0, bindAddress: '127.0.0.1', accounts: [account], onMessage: (m) => { received.push(m) } })
  const port = server.address().port
  const base = 'http://127.0.0.1:' + port + '/callback/probe'
  try {
    // GET URL verification: signed echostr decrypts to the plain text.
    const echoPlain = 'random-echo-' + randomBytes(6).toString('hex')
    const echoEnc = encrypt(KEY, echoPlain, CORP_ID)
    const getUrl = base + '?msg_signature=' + encodeURIComponent(sign(echoEnc)) + '&timestamp=' + TS + '&nonce=' + NONCE + '&echostr=' + encodeURIComponent(echoEnc)
    const getRes = await fetch(getUrl)
    assert.equal(getRes.status, 200)
    assert.equal(await getRes.text(), echoPlain)
    const badGet = await fetch(base + '?msg_signature=' + '0'.repeat(40) + '&timestamp=' + TS + '&nonce=' + NONCE + '&echostr=' + encodeURIComponent(echoEnc))
    assert.equal(badGet.status, 403)
    ok('GET URL verification answers 200 plaintext, 403 on bad signature')

    // POST secure mode: outer XML carries <Encrypt>; body signs over it.
    const innerEnc = encrypt(KEY, TEXT_XML, CORP_ID)
    const outerXml = '<xml><Encrypt><![CDATA[' + innerEnc + ']]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>'
    const postRes = await fetch(base + '?msg_signature=' + encodeURIComponent(sign(innerEnc)) + '&timestamp=' + TS + '&nonce=' + NONCE, { method: 'POST', body: outerXml })
    assert.equal(postRes.status, 200)
    assert.equal(await postRes.text(), 'success')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(received.length, 1)
    assert.equal(received[0].fields.MsgType, 'text')
    assert.equal(received[0].fields.Content, '帮我查一下服务状态')
    const badPost = await fetch(base + '?msg_signature=' + '0'.repeat(40) + '&timestamp=' + TS + '&nonce=' + NONCE, { method: 'POST', body: outerXml })
    assert.equal(badPost.status, 403)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(received.length, 1)
    ok('POST secure mode answers success immediately, message reaches onMessage, 403 on bad signature')
  } finally {
    await closeServer(server)
  }

}

console.log('probe: all ' + passed + ' checks passed')
