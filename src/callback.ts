/** Local callback HTTP server: one node:http server for every configured
 *  account and smart robot, routed at '/callback/<callbackPath>'. WeCom
 *  requires an answer within 5 seconds, so the handler verifies, decrypts and
 *  parses synchronously and answers 200 'success' immediately; the engine
 *  pipeline runs async afterwards and its failures are only logged. Apps push
 *  XML bodies ({@link parseWecomXml}); smart robots push JSON bodies carrying
 *  an encrypt field (official 101034, read 2026-11-04). Inbound MsgId/msgid
 *  are deduped per route before dispatch (WeCom re-pushes callbacks when the
 *  answer is lost) — see dedup.ts; empty ids skip the check.
 *  入站 MsgId/msgid 在派发前按路由去重（应答丢失时企业微信会重推）——见
 *  dedup.ts；空 id 跳过判重。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { XMLParser } from 'fast-xml-parser'
import { decrypt, verifySignature } from './crypto.ts'
import { seenOrAdd } from './dedup.ts'

/** Structural subset of the configured account the callback needs. */
export interface CallbackAccount {
  name: string
  corpid: string
  agentid: string
  token: string
  encodingAESKey: string
  callbackPath: string
}

/** Structural subset of one smart robot (智能机器人): same callback config
 *  shape as accounts (URL/Token/EncodingAESKey), no corp fields — in-house
 *  robots decrypt with receiveid '' (official 101034, read 2026-11-04). */
export interface CallbackBot {
  name: string
  token: string
  encodingAESKey: string
  callbackPath: string
}

/** One inbound WeCom POST after verify+decrypt: fields and raw XML. */
export interface IncomingWecomMessage {
  account: CallbackAccount
  fields: Record<string, string>
  xml: string
}

/** One inbound smart-robot POST after verify+decrypt: the decrypted JSON
 *  payload plus the raw plaintext (JSON protocol, official 101045). */
export interface IncomingBotMessage {
  bot: CallbackBot
  payload: Record<string, unknown>
  raw: string
}

export interface CallbackServerOptions {
  port: number
  bindAddress: string
  accounts: CallbackAccount[]
  bots: CallbackBot[]
  onMessage: (message: IncomingWecomMessage) => void | Promise<void>
  onBotMessage: (message: IncomingBotMessage) => void | Promise<void>
  /** Dedup state dir override (tests); default ~/.local/state/dsh-superagent-wecom.
   *  去重状态目录覆盖（测试注入）；缺省 ~/.local/state/dsh-superagent-wecom。 */
  seenBaseDir?: string
}

const MAX_BODY_BYTES = 1024 * 1024

// WeCom wraps nearly every field in <![CDATA[...]]>. With cdataPropName the
// parser surfaces it as { __cdata: '...' }; fieldText unwraps both forms.
// parseTagValue:false keeps MsgId (a 64-bit int) as its exact string.
const xmlParser = new XMLParser({ cdataPropName: '__cdata', trimValues: true, ignoreAttributes: true, parseTagValue: false, parseAttributeValue: false })

function fieldText(value: unknown): string | undefined {
  if (value == null) return undefined
  if (Array.isArray(value)) return fieldText(value[0])
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if ('__cdata' in obj) return fieldText(obj.__cdata)
    if ('#text' in obj) return fieldText(obj['#text'])
    return undefined
  }
  return String(value)
}

/** Parse a WeCom message XML into plain string fields (CDATA unwrapped). */
export function parseWecomXml(xml: string): Record<string, string> {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>
  const root = (parsed.xml ?? parsed) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(root)) {
    const text = fieldText(value)
    if (text !== undefined) out[key] = text
  }
  return out
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('wecom callback: body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const respond = (res: ServerResponse, status: number, body: string): void => {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}

type CallbackRoute = { kind: 'account'; account: CallbackAccount } | { kind: 'bot'; bot: CallbackBot }

function resolveRoute(opts: CallbackServerOptions, path: string): CallbackRoute | undefined {
  const account = opts.accounts.find((a) => path === 'callback/' + a.callbackPath.replace(/^\/+|\/+$/g, ''))
  if (account) return { kind: 'account', account }
  const bot = opts.bots.find((b) => path === 'callback/' + b.callbackPath.replace(/^\/+|\/+$/g, ''))
  if (bot) return { kind: 'bot', bot }
  return undefined
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: CallbackServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://callback.local')
  const route = resolveRoute(opts, url.pathname.replace(/^\/+|\/+$/g, ''))
  if (!route) {
    respond(res, 404, 'not found')
    return
  }
  const msgSignature = url.searchParams.get('msg_signature') ?? ''
  const timestamp = url.searchParams.get('timestamp') ?? ''
  const nonce = url.searchParams.get('nonce') ?? ''

  if (req.method === 'GET') {
    // URL verification (same shape for accounts and robots, official
    // 90930/101034): check the signature over the encrypted echostr, then
    // return the decrypted random message as the plain-text body. Accounts
    // decrypt with the corpid as receiveid, robots with the empty string.
    const echostr = url.searchParams.get('echostr') ?? ''
    const token = route.kind === 'account' ? route.account.token : route.bot.token
    const routeName = route.kind === 'account' ? route.account.callbackPath : route.bot.callbackPath
    if (!verifySignature(token, timestamp, nonce, echostr, msgSignature)) {
      console.error('[wecom] GET verify: bad msg_signature for ' + route.kind + ' ' + routeName)
      respond(res, 403, 'invalid signature')
      return
    }
    const aesKey = route.kind === 'account' ? route.account.encodingAESKey : route.bot.encodingAESKey
    const receiveId = route.kind === 'account' ? route.account.corpid : ''
    respond(res, 200, decrypt(aesKey, echostr, receiveId))
    return
  }

  if (req.method === 'POST') {
    const body = await readBody(req)
    // Callbacks are always signed+encrypted: apps carry <Encrypt> in XML
    // (official 90930), robots carry {"encrypt": ...} in JSON (official
    // 101034). Verify, then decrypt to the real payload.
    let encrypt: string
    let plain: string
    if (route.kind === 'bot') {
      let envelope: { encrypt?: unknown }
      try {
        envelope = JSON.parse(body) as { encrypt?: unknown }
      } catch {
        respond(res, 400, 'invalid JSON body')
        return
      }
      encrypt = typeof envelope.encrypt === 'string' ? envelope.encrypt : ''
      if (!encrypt) {
        respond(res, 400, 'missing encrypt field')
        return
      }
      if (!verifySignature(route.bot.token, timestamp, nonce, encrypt, msgSignature)) {
        console.error('[wecom] POST: bad msg_signature for bot ' + route.bot.callbackPath)
        respond(res, 403, 'invalid signature')
        return
      }
      // In-house robots decrypt with receiveid '' (official 101034).
      plain = decrypt(route.bot.encodingAESKey, encrypt, '')
    } else {
      const outer = parseWecomXml(body)
      encrypt = outer.Encrypt ?? ''
      if (!encrypt) {
        respond(res, 400, 'missing Encrypt field')
        return
      }
      if (!verifySignature(route.account.token, timestamp, nonce, encrypt, msgSignature)) {
        console.error('[wecom] POST: bad msg_signature for account ' + route.account.callbackPath)
        respond(res, 403, 'invalid signature')
        return
      }
      plain = decrypt(route.account.encodingAESKey, encrypt, route.account.corpid)
    }
    // 5s 铁律: answer before any engine work. Failures below are logged only.
    respond(res, 200, 'success')
    if (route.kind === 'bot') {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(plain) as Record<string, unknown>
      } catch {
        console.error('[wecom] bot payload is not JSON: ' + plain.slice(0, 500))
        return
      }
      // msgid 去重：storeKey = callbackPath；空 id 跳过（无 msgid 的事件交给下游过滤）。
      const botMsgId = String(payload.msgid ?? '').trim()
      if (botMsgId && (await seenOrAdd(route.bot.callbackPath, botMsgId, opts.seenBaseDir))) {
        console.error('[wecom] bot duplicate msgid=' + botMsgId + ' dropped (bot=' + route.bot.callbackPath + ')')
        return
      }
      void Promise.resolve()
        .then(() => opts.onBotMessage({ bot: route.bot, payload, raw: plain }))
        .catch((error: unknown) => console.error('[wecom] onBotMessage failed:', String(error).slice(0, 300)))
      return
    }
    const fields = parseWecomXml(plain)
    // MsgId 去重：storeKey = callbackPath；空 id（无 MsgId 的事件）跳过。
    const msgId = String(fields.MsgId ?? '').trim()
    if (msgId && (await seenOrAdd(route.account.callbackPath, msgId, opts.seenBaseDir))) {
      console.error('[wecom] duplicate MsgId=' + msgId + ' dropped (account=' + route.account.callbackPath + ')')
      return
    }
    void Promise.resolve()
      .then(() => opts.onMessage({ account: route.account, fields, xml: plain }))
      .catch((error: unknown) => console.error('[wecom] onMessage failed:', String(error).slice(0, 300)))
    return
  }

  respond(res, 405, 'method not allowed')
}

/** Start the callback server; rejects on listen errors such as EADDRINUSE. */
export function startCallbackServer(opts: CallbackServerOptions): Promise<Server> {
  return new Promise((resolve, reject) => {
    let listening = false
    const server = createServer((req, res) => {
      handle(req, res, opts).catch((error: unknown) => {
        console.error('[wecom] callback error:', String(error).slice(0, 300))
        respond(res, 400, 'bad request')
      })
    })
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (!listening) reject(error)
    })
    server.listen(opts.port, opts.bindAddress || '0.0.0.0', () => {
      listening = true
      server.on('error', (error) => console.error('[wecom] callback server error:', String(error).slice(0, 200)))
      resolve(server)
    })
  })
}
