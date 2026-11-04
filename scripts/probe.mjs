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
 *   5. a live local server: GET URL verification (ok + 403) and signed
 *      encrypted POSTs (ok + 403) for both the app (XML) and the robot (JSON)
 *      routes
 *   6. smart-robot JSON mapping: group mention Trigger, per-bot admission row,
 *      no Trigger for events/single-chats/missing msgid (official 101045)
 *   7. image markers: PicUrl/MediaId/bot-mixed carry [wecom-image:KEY] from
 *      the original payload and images() extracts exactly those keys
 *   8. image download: bad PicUrl throws (stub fetch), the robot's encrypted
 *      media URL decrypts to the original bytes, MediaId goes via media/get
 *
 * Usage: node scripts/probe.mjs   (run `pnpm install` first)
 */
import process from 'node:process'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'

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
const { buildWecomTrigger, buildWecomBotTrigger, wecomKind, wecomImageKeys, WecomConfigSchema, channelConfig: kindChannelConfig } = kindMod

// Test fixture: 43-char EncodingAESKey, a corp id and the callback token.
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const CORP_ID = 'wwprobe01'
const TOKEN = 'probe-token'
const TS = '1700000000'
const NONCE = 'nonce123'

/** Mirror of the WeCom signing over [token, timestamp, nonce, encrypt]. */
const sign = (encrypted) => createHash('sha1').update([TOKEN, TS, NONCE, encrypted].sort().join('')).digest('hex')
const account = { name: 'probe', corpid: CORP_ID, agentid: '1000002', token: TOKEN, encodingAESKey: KEY, callbackPath: 'probe' }
const bot = { name: 'probe-bot', token: TOKEN, encodingAESKey: KEY, callbackPath: 'probe-bot' }
const BOT_PAYLOAD = {
  msgid: 'BOTS-1', aibotid: 'AIBOT1', chatid: 'CHAT1', chattype: 'group',
  from: { userid: 'zhangsan' },
  response_url: 'https://qyapi.test/response?code=1',
  msgtype: 'text', text: { content: '@RobotA 帮我查一下' }, create_time: 1700000003,
}

/** Binary mirror of encrypt(): same 16+4+msg+receiveid structure but with raw
 *  message bytes, matching the encrypted media downloads of official 101045. */
const encryptedBytes = (aesKey, msgBytes) => {
  const key = Buffer.from(aesKey + '=', 'base64')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(msgBytes.length, 0)
  const raw = Buffer.concat([randomBytes(16), len, msgBytes, Buffer.alloc(0)])
  const padLen = 32 - (raw.length % 32)
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padLen, padLen)])), cipher.final()])
}

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
  assert.equal(imageTrigger.text, '[wecom-image:https://example.test/pic.jpg]')
  assert.equal(imageTrigger.meta.picUrl, 'https://example.test/pic.jpg')
  assert.equal(imageTrigger.meta.mediaId, 'MEDIA_ID_1')
  ok('image XML maps with the PicUrl-keyed marker and meta')

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
  const receivedBots = []
  const server = await startCallbackServer({
    port: 0, bindAddress: '127.0.0.1',
    accounts: [account], bots: [bot],
    onMessage: (m) => { received.push(m) },
    onBotMessage: (m) => { receivedBots.push(m) },
  })
  const port = server.address().port
  const base = 'http://127.0.0.1:' + port + '/callback/probe'
  const botBase = 'http://127.0.0.1:' + port + '/callback/probe-bot'
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

    // Robot route GET verification: in-house robots decrypt with receiveid ''.
    const botEcho = encrypt(KEY, echoPlain, '')
    const botGetRes = await fetch(botBase + '?msg_signature=' + encodeURIComponent(sign(botEcho)) + '&timestamp=' + TS + '&nonce=' + NONCE + '&echostr=' + encodeURIComponent(botEcho))
    assert.equal(botGetRes.status, 200)
    assert.equal(await botGetRes.text(), echoPlain)

    // Robot route POST: JSON body {"encrypt": ...} signs over the encrypt field.
    const botEnc = encrypt(KEY, JSON.stringify(BOT_PAYLOAD), '')
    const botPostRes = await fetch(botBase + '?msg_signature=' + encodeURIComponent(sign(botEnc)) + '&timestamp=' + TS + '&nonce=' + NONCE, { method: 'POST', body: JSON.stringify({ encrypt: botEnc }) })
    assert.equal(botPostRes.status, 200)
    assert.equal(await botPostRes.text(), 'success')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(receivedBots.length, 1)
    assert.equal(receivedBots[0].payload.msgid, 'BOTS-1')
    assert.equal(receivedBots[0].payload.chattype, 'group')
    assert.equal(receivedBots[0].payload.text.content, '@RobotA 帮我查一下')
    const badBotPost = await fetch(botBase + '?msg_signature=' + '0'.repeat(40) + '&timestamp=' + TS + '&nonce=' + NONCE, { method: 'POST', body: JSON.stringify({ encrypt: botEnc }) })
    assert.equal(badBotPost.status, 403)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(receivedBots.length, 1)
    ok("robot JSON route: GET verify with receiveid '', POST decrypts into onBotMessage, 403 on bad signature")
  } finally {
    await closeServer(server)
  }

}

console.log('probe: 6. smart-robot JSON mapping (official 101045)')
{
  const botTrigger = buildWecomBotTrigger(bot, BOT_PAYLOAD)
  assert.equal(botTrigger.id, 'wecom:BOTS-1')
  assert.deepEqual(botTrigger.threads, [{ source: 'wecom', id: 'g:CHAT1' }])
  assert.deepEqual(botTrigger.actor, { source: 'wecom', id: 'zhangsan' })
  assert.equal(botTrigger.addressed, 'mention')
  assert.equal(botTrigger.text, '@RobotA 帮我查一下')
  assert.equal(botTrigger.at, new Date(1700000003 * 1000).toISOString())
  assert.equal(botTrigger.channel.thread, 'wecom:g:CHAT1')
  assert.equal(botTrigger.channel.address.bot, 'probe-bot')
  assert.equal(botTrigger.channel.address.chatid, 'CHAT1')
  assert.equal(botTrigger.channel.address.responseUrl, 'https://qyapi.test/response?code=1')
  assert.equal(botTrigger.meta.chatid, 'CHAT1')
  assert.equal(botTrigger.meta.chattype, 'group')
  ok('group JSON payload maps to a mention Trigger on the g: thread')

  // 群准入：scope row 用配置期可枚举的 bot 行 id——引擎 admission 表按精确 id
  // 查找（policy.ts admissionOf），chatid 运行期才存在，无法预生成活行。
  const config = WecomConfigSchema.parse({ accounts: [{ corpid: CORP_ID, secret: 's', agentid: '1', token: TOKEN, encodingAESKey: KEY, callbackPath: 'probe' }], bots: [bot] })
  assert.deepEqual(wecomKind.scope({ meta: botTrigger.meta }, config), { listened: true, observed: false, row: 'wecom-bot:probe-bot' })
  const rows = wecomKind.policy.rows(config)
  const botRow = rows.find((row) => row.id === 'wecom-bot:probe-bot')
  assert.deepEqual(botRow.cells, { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false })
  ok('scope/policy expose the per-bot group row (cells false/true/false)')

  // 事件与机器人单聊不建票（官方 101046/101045：群聊仅 @ 触发）。
  assert.equal(buildWecomBotTrigger(bot, { ...BOT_PAYLOAD, msgtype: 'event' }), undefined)
  assert.equal(buildWecomBotTrigger(bot, { ...BOT_PAYLOAD, chattype: 'single' }), undefined)
  assert.equal(buildWecomBotTrigger(bot, { ...BOT_PAYLOAD, msgid: '' }), undefined)
  ok('event / single-chat / missing msgid produce no Trigger')
}

console.log('probe: 7. image markers and extraction')
{
  const picTrigger = buildWecomTrigger({ account, fields: parseWecomXml(IMAGE_XML), xml: IMAGE_XML })
  assert.deepEqual(wecomImageKeys(picTrigger.text), ['https://example.test/pic.jpg'])
  const midXml = IMAGE_XML.replace(/<PicUrl><!\[CDATA\[[^\]]*\]\]><\/PicUrl>/, '')
  const midTrigger = buildWecomTrigger({ account, fields: parseWecomXml(midXml), xml: midXml })
  assert.equal(midTrigger.text, '[wecom-image:MEDIA_ID_1]')
  assert.deepEqual(wecomImageKeys(midTrigger.text), ['MEDIA_ID_1'])
  const mixedPayload = { ...BOT_PAYLOAD, msgid: 'BOTS-2', msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: '@RobotA 看这张图' } },
    { msgtype: 'image', image: { url: 'https://cos.test/enc1' } },
  ] } }
  const mixedTrigger = buildWecomBotTrigger(bot, mixedPayload)
  assert.equal(mixedTrigger.text, '@RobotA 看这张图\n[wecom-image:https://cos.test/enc1]')
  assert.deepEqual(wecomImageKeys(mixedTrigger.text), ['https://cos.test/enc1'])
  ok('PicUrl/MediaId/bot-mixed images carry [wecom-image:KEY] markers from the original payload')
}

console.log('probe: 8. image download paths (stub fetch)')
{
  const config = WecomConfigSchema.parse({
    accounts: [{ corpid: CORP_ID, secret: 's', agentid: '1', token: TOKEN, encodingAESKey: KEY, callbackPath: 'probe' }],
    bots: [bot],
  })
  kindChannelConfig.current = config
  const saved = []
  const agent = {
    ctx: { get: (n) => n === 'attachments'
      ? { saveImage: async (input) => { saved.push(input); return { id: 'saved' } }, imageLimits: { maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 20 * 1024 * 1024 } }
      : n === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['image'] }) } : undefined },
    options: { provider: 'probe', model: 'probe-model' },
  }
  const signal = new AbortController().signal
  const picTrigger = buildWecomTrigger({ account, fields: parseWecomXml(IMAGE_XML), xml: IMAGE_XML })
  const realFetch = globalThis.fetch
  try {
    // 8a. bad PicUrl: HTTP 500 -> image() throws, nothing saved.
    globalThis.fetch = async () => new Response('boom', { status: 500 })
    await assert.rejects(
      () => wecomKind.threadContext.image(agent, undefined, picTrigger, { id: 'm1', text: picTrigger.text }, 'https://example.test/pic.jpg', '/tmp', signal),
      /Image download failed/,
    )
    ok('bad PicUrl (HTTP 500) makes image() throw')
  } finally {
    globalThis.fetch = realFetch
  }

  // 8b. robot media URL: fetch returns AES-encrypted bytes -> decryptBytes -> saveImage.
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 2, 3, 4, 5, 6, 7, 8, 9])
  const encImage = encryptedBytes(KEY, PNG)
  const mixedPayload = { ...BOT_PAYLOAD, msgid: 'BOTS-3', msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: '@RobotA 图' } },
    { msgtype: 'image', image: { url: 'https://cos.test/enc1' } },
  ] } }
  const mixedTrigger = buildWecomBotTrigger(bot, mixedPayload)
  try {
    globalThis.fetch = async () => new Response(encImage, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    const result = await wecomKind.threadContext.image(agent, undefined, mixedTrigger, { id: 'm3', text: mixedTrigger.text }, 'https://cos.test/enc1', '/tmp', signal)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].mediaType, 'image/png')
    assert.ok(saved[0].data.equals(PNG))
    assert.equal(result.image_key, 'https://cos.test/enc1')
    ok('bot encrypted image URL decrypts into the original bytes')
  } finally {
    globalThis.fetch = realFetch
  }

  // 8c. MediaId path: media/get with an access token.
  try {
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.includes('gettoken')) return new Response(JSON.stringify({ access_token: 'TOKEN-X', expires_in: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (u.includes('media/get')) return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } })
      return new Response('unexpected', { status: 500 })
    }
    const midTrigger = buildWecomTrigger({ account, fields: parseWecomXml(IMAGE_XML.replace(/<PicUrl><!\[CDATA\[[^\]]*\]\]><\/PicUrl>/, '')), xml: IMAGE_XML })
    const result2 = await wecomKind.threadContext.image(agent, undefined, midTrigger, { id: 'm4', text: midTrigger.text }, 'MEDIA_ID_1', '/tmp', signal)
    assert.equal(saved.length, 2)
    assert.equal(saved[1].mediaType, 'image/jpeg')
    assert.equal(result2.image_key, 'MEDIA_ID_1')
    ok('MediaId path fetches media/get with a token and saves the bytes')
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('probe: all ' + passed + ' checks passed')
