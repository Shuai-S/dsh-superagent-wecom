/** Local callback HTTP server: one node:http server for every configured
 *  account, routed at '/callback/<callbackPath>'. WeCom requires an answer
 *  within 5 seconds, so the handler verifies, decrypts and parses
 *  synchronously and answers 200 'success' immediately; the engine pipeline
 *  runs async afterwards and its failures are only logged. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { XMLParser } from 'fast-xml-parser'
import { decrypt, verifySignature } from './crypto.ts'

/** Structural subset of the configured account the callback needs. */
export interface CallbackAccount {
  name: string
  corpid: string
  agentid: string
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

export interface CallbackServerOptions {
  port: number
  bindAddress: string
  accounts: CallbackAccount[]
  onMessage: (message: IncomingWecomMessage) => void | Promise<void>
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

async function handle(req: IncomingMessage, res: ServerResponse, opts: CallbackServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://callback.local')
  const path = url.pathname.replace(/^\/+|\/+$/g, '')
  const account = opts.accounts.find((a) => path === 'callback/' + a.callbackPath.replace(/^\/+|\/+$/g, ''))
  if (!account) {
    respond(res, 404, 'not found')
    return
  }
  const msgSignature = url.searchParams.get('msg_signature') ?? ''
  const timestamp = url.searchParams.get('timestamp') ?? ''
  const nonce = url.searchParams.get('nonce') ?? ''

  if (req.method === 'GET') {
    // URL verification: check the signature over the encrypted echostr, then
    // return the decrypted random message as the plain-text body. The echostr
    // is always encrypted, so this needs the EncodingAESKey.
    const echostr = url.searchParams.get('echostr') ?? ''
    if (!verifySignature(account.token, timestamp, nonce, echostr, msgSignature)) {
      console.error('[wecom] GET verify: bad msg_signature for account ' + account.callbackPath)
      respond(res, 403, 'invalid signature')
      return
    }
    respond(res, 200, decrypt(account.encodingAESKey, echostr, account.corpid))
    return
  }

  if (req.method === 'POST') {
    const body = await readBody(req)
    // WeCom callbacks are always signed+encrypted (official 90930): the body
    // carries <Encrypt>; verify, then decrypt to the real message XML.
    const outer = parseWecomXml(body)
    const encrypt = outer.Encrypt ?? ''
    if (!encrypt) {
      respond(res, 400, 'missing Encrypt field')
      return
    }
    if (!verifySignature(account.token, timestamp, nonce, encrypt, msgSignature)) {
      console.error('[wecom] POST: bad msg_signature for account ' + account.callbackPath)
      respond(res, 403, 'invalid signature')
      return
    }
    const xml = decrypt(account.encodingAESKey, encrypt, account.corpid)
    const fields = parseWecomXml(xml)
    // 5s 铁律: answer before any engine work. Failures below are logged only.
    respond(res, 200, 'success')
    void Promise.resolve()
      .then(() => opts.onMessage({ account, fields, xml }))
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
