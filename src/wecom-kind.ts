/** The 'wecom' Source kind: WeCom (企业微信) self-built app messages arriving
 *  over the callback HTTP server (回调模式, XML bodies), plus smart robots
 *  (智能机器人) receiving group chats as JSON callbacks. Replies to accounts go
 *  through the WeCom OpenAPI; bot group replies need the one-shot response_url
 *  (M3). Shape mirrors the bundled github/feishu kinds (docs/008-cookbook.md);
 *  the engine duck-types it at runtime.
 *
 *  Smart-robot contract facts (official docs read 2026-11-04):
 *  - 接收消息 https://developer.work.weixin.qq.com/document/path/101045 —
 *    callbacks are JSON (not XML): msgid / aibotid / chatid (group only) /
 *    chattype single|group / from.userid / response_url / msgtype; group chats
 *    are mention-triggered only; image/voice/file/video arrive in single chats;
 *    mixed (图文混排) works in groups.
 *  - 回调和回复的加解密方案 https://developer.work.weixin.qq.com/document/path/101034 —
 *    same AES-256-CBC scheme as apps, but the body is {"encrypt": "..."} JSON
 *    and the receiveid is the empty string for in-house robots.
 *  - 主动回复消息 https://developer.work.weixin.qq.com/document/path/101138 —
 *    response_url is one-shot and valid for 1 hour.
 *
 *  Outbound app texts are chunked to the official 2048-byte cap (chunk.ts);
 *  transport send failures are trailed to a local JSONL (failure-log.ts);
 *  in-memory counters (wecomStats) ride along every health report.
 *  出站应用文本按官方 2048 字节上限分块（chunk.ts）；发送失败留痕本地
 *  JSONL（failure-log.ts）；内存计数（wecomStats）随健康上报输出。 */
import { z } from 'zod'
import type { Localized, OutboundMessageLike, SourceKindLike, TriggerLike } from './types.ts'
import type { AclPolicy } from './acl.ts'
import type { IncomingWecomMessage } from './callback.ts'
import { decryptBytes } from './crypto.ts'
import { emptyLink, getMediaImage, sendAppMessage } from './robot.ts'
import { chunkText, LIMIT } from './chunk.ts'
import { appendSendFailure } from './failure-log.ts'

export const HEALTH_ENTRY = 'wecomCallback'

export interface WecomAccount {
  name: string
  corpid: string
  secret: string
  agentid: string
  token: string
  /** 43-char key from the WeCom callback config page; WeCom callbacks are
   *  always signed+encrypted (official 90930), so it is mandatory. */
  encodingAESKey: string
  callbackPath: string
}
/** One smart robot (智能机器人): callback config is URL/Token/EncodingAESKey
 *  only — no corp fields (from.corpid is absent for in-house robots, official
 *  101046). Media URLs it posts are AES-encrypted with the same key. */
export interface WecomBot {
  name: string
  token: string
  encodingAESKey: string
  callbackPath: string
}
export interface WecomConfig {
  accounts: WecomAccount[]
  bots: WecomBot[]
  callbackPort: number
  bindAddress: string
  sendAck: boolean
  /** ACL 访问模式（契约 §3，vendored acl.ts）；不设 = 全放行（向后兼容）。 */
  policy?: AclPolicy
}

// channel.send reads config through this holder; watch() refreshes it every round.
export const channelConfig: { current?: WecomConfig } = {}

// —— 内存健康计数（watch() 把 statsDetail() 拼进每条 health detail；进程重启清零）——
// in=送达 receive() 的触发数；out=整条发送成功数；fail=发送失败数（首块/后续块失败均计）；
// deny=ACL 拒绝数（契约 §3：派发前拒绝，不进 in/out/fail，failure-log 不记）。
export const wecomStats = { in: 0, out: 0, fail: 0, deny: 0, last: '' }
export type StatKey = 'in' | 'out' | 'fail' | 'deny'
export function bumpStat(key: StatKey): void {
  wecomStats[key] += 1
  wecomStats.last = new Date().toISOString()
}
/** 紧凑单行计数：in=3 out=2 fail=0 deny=1 last=<ISO>（尚无事件时 last=-）。 */
export function statsDetail(): string {
  return 'in=' + wecomStats.in + ' out=' + wecomStats.out + ' fail=' + wecomStats.fail + ' deny=' + wecomStats.deny + ' last=' + (wecomStats.last || '-')
}

/** ACL 访问模式（契约 docs/rpc-contract.md §3；判定实现在 vendored src/acl.ts）。
 *  不设 policy = 全放行（向后兼容）；形状非法按 schema 拒绝，不做静默降级。 */
export const AclPolicySchema = z.object({
  mode: z.enum(['allowlist', 'open']),
  allowUsers: z.array(z.string()),
  groupOnly: z.boolean().optional(),
  denyText: z.object({ zh: z.string().min(1), en: z.string().min(1) }).optional(),
}).strict()

export const WecomConfigSchema = z.object({
  accounts: z.array(z.object({
    name: z.string().default(''),
    corpid: z.string().min(1),
    secret: z.string().min(1),
    agentid: z.string().min(1),
    token: z.string().min(1),
    encodingAESKey: z.string().length(43),
    callbackPath: z.string().min(1),
  })).default([]),
  bots: z.array(z.object({
    name: z.string().default(''),
    token: z.string().min(1),
    encodingAESKey: z.string().length(43),
    callbackPath: z.string().min(1),
  })).default([]),
  callbackPort: z.number().int().min(1).max(65535).default(3090),
  bindAddress: z.string().default('0.0.0.0'),
  sendAck: z.boolean().default(true),
  policy: AclPolicySchema.optional(),
}).strict()
export type WecomConfigInput = z.input<typeof WecomConfigSchema>

/** Admission row id of an account: its callback path (unique per account). */
export const accountIdOf = (account: WecomAccount): string => account.callbackPath
/** Admission row id for one bot's group chats. Config-enumerable on purpose:
 *  the engine admission table resolves rows by exact id, and a group chatid
 *  only exists at runtime — so all groups of one bot share that bot's row. */
export const botGroupRowId = (bot: WecomBot): string => 'wecom-bot:' + bot.callbackPath

/** Image keys embedded by the trigger text marker; keys always come from the
 *  original payload, never from user prose (anti-injection). */
export const wecomImageKeys = (text: string): string[] =>
  [...new Set([...text.matchAll(/\[wecom-image:([^\]]+)\]/g)].map((m) => m[1] ?? ''))].filter(Boolean)

/** Text of one bot payload: text content, or a mixed body with text items and
 *  '[wecom-image:URL]' markers for image items. Unknown types stay silent. */
export function botPayloadText(payload: Record<string, unknown>): string {
  const msgType = String(payload.msgtype ?? '')
  if (msgType === 'text') return String((payload.text as Record<string, unknown> | undefined)?.content ?? '').trim()
  if (msgType === 'mixed') {
    const mixed = payload.mixed as { msg_item?: unknown[] } | undefined
    const items = Array.isArray(mixed?.msg_item) ? mixed.msg_item : []
    const parts: string[] = []
    for (const item of items) {
      const entry = item as Record<string, unknown>
      const kind = String(entry.msgtype ?? '')
      if (kind === 'text') parts.push(String((entry.text as Record<string, unknown> | undefined)?.content ?? '').trim())
      else if (kind === 'image') {
        const url = String((entry.image as Record<string, unknown> | undefined)?.url ?? '').trim()
        if (url) parts.push('[wecom-image:' + url + ']')
      }
    }
    return parts.filter(Boolean).join('\n').trim()
  }
  return ''
}

/** Quoted text of one bot payload (text quotes only; other quote types come
 *  with M3 media handling). */
export function botQuoteText(quote: Record<string, unknown>): string {
  if (String(quote.msgtype ?? '') === 'text') return String((quote.text as Record<string, unknown> | undefined)?.content ?? '').trim()
  return ''
}

/** The Trigger of one smart-robot callback message (JSON payload). v2 covers
 *  group chats only (chattype 'group', mention-triggered); robot single-chats
 *  and msgtype event/stream produce no Trigger. */
export function buildWecomBotTrigger(bot: WecomBot, payload: Record<string, unknown>): TriggerLike | undefined {
  const msgType = String(payload.msgtype ?? '').trim()
  if (msgType === 'event' || msgType === 'stream') return undefined
  const chattype = String(payload.chattype ?? '').trim()
  if (chattype !== 'group') return undefined // v2: group chats only; robot single-chats arrive with M3
  const msgId = String(payload.msgid ?? '').trim()
  const chatid = String(payload.chatid ?? '').trim()
  const from = String((payload.from as Record<string, unknown> | undefined)?.userid ?? '').trim()
  if (!msgId || !chatid || !from) return undefined // 缺字段防御：调用方 dump 首条原始载荷
  const text = botPayloadText(payload)
  if (!text) return undefined
  const meta: Record<string, unknown> = {
    botId: bot.callbackPath,
    aibotid: String(payload.aibotid ?? ''),
    chatid,
    chattype,
    messageId: msgId,
    msgType,
  }
  const quote = payload.quote as Record<string, unknown> | undefined
  if (quote && typeof quote === 'object') {
    const quoteText = botQuoteText(quote)
    if (quoteText) meta.quoteText = quoteText
  }
  const createTime = Number(payload.create_time)
  return {
    id: 'wecom:' + msgId,
    source: 'wecom',
    threads: [{ source: 'wecom', id: 'g:' + chatid }],
    actor: { source: 'wecom', id: from },
    human: true,
    addressed: 'mention',
    at: Number.isFinite(createTime) && createTime > 0 ? new Date(createTime * 1000).toISOString() : new Date().toISOString(),
    text,
    channel: { source: 'wecom', thread: 'wecom:g:' + chatid,
      address: { bot: bot.callbackPath, chatid, touser: '', msgId, msgType, responseUrl: String(payload.response_url ?? '') } },
    meta,
  }
}

/** The Trigger of one app-account callback message (XML fields). Events
 *  without MsgId produce none (v1 handles message types only). */
export function buildWecomTrigger(message: IncomingWecomMessage): TriggerLike | undefined {
  const fields = message.fields
  const msgId = String(fields.MsgId ?? '').trim()
  const from = String(fields.FromUserName ?? '').trim()
  const msgType = String(fields.MsgType ?? '').trim()
  if (!msgId || !from) return undefined // 无 MsgId 的事件（subscribe 等）忽略
  let text: string
  if (msgType === 'text') text = String(fields.Content ?? '').trim()
  else if (msgType === 'image') {
    // 图片走 '[wecom-image:KEY]' 标记：KEY 来自原文（PicUrl 优先，MediaId 兜底），
    // threadContext.images()/image() 据此提取并下载。
    const picUrl = String(fields.PicUrl ?? '').trim()
    const mediaId = String(fields.MediaId ?? '').trim()
    const key = picUrl || mediaId
    if (!key) return undefined
    text = '[wecom-image:' + key + ']'
  } else text = '[wecom-' + msgType + ']'
  if (!text) return undefined
  const accountId = message.account.callbackPath || message.account.corpid
  const meta: Record<string, unknown> = { accountId, messageId: msgId, msgType }
  if (fields.PicUrl) meta.picUrl = String(fields.PicUrl)
  if (fields.MediaId) meta.mediaId = String(fields.MediaId)
  const at = Number(fields.CreateTime)
  return {
    id: 'wecom:' + msgId,
    source: 'wecom',
    threads: [{ source: 'wecom', id: 'u:' + from }],
    actor: { source: 'wecom', id: from },
    human: true,
    addressed: 'direct',
    at: Number.isFinite(at) && at > 0 ? new Date(at * 1000).toISOString() : new Date().toISOString(),
    text,
    channel: { source: 'wecom', thread: 'wecom:u:' + from,
      address: { account: accountId, touser: from, msgId, msgType } },
    meta,
  }
}

/** Magic-byte sniffing for images whose transport content-type is unusable
 *  (bot media arrives AES-encrypted, so response headers describe the cipher). */
export function sniffImageType(data: Buffer): string | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}

export const wecomKind = {
  kind: 'wecom',
  title: { zh: '企业微信', en: 'WeCom' },
  description: {
    zh: '企业微信直连：自建应用单聊发消息即可派活，智能机器人群聊 @ 机器人收群消息；应用回复经企业微信 OpenAPI 直接回企业微信。',
    en: 'WeCom direct: message the app bot in a single chat to dispatch; smart robots receive group mentions; app replies go straight back to WeCom.',
  },
  schema: WecomConfigSchema,
  fields: [
    { key: 'accounts', type: 'rows', dialog: true, label: { zh: '企业微信自建应用', en: 'WeCom apps' }, columns: [
      { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true, hint: { zh: '仅用于面板显示', en: 'Display only' } },
      { key: 'corpid', type: 'text', label: { zh: '企业 ID（corpid）', en: 'Corp ID (corpid)' }, hint: { zh: '企业微信后台 → 我的企业 → 企业信息', en: 'WeCom admin → My Company → Corp info' } },
      { key: 'secret', type: 'text', label: { zh: '应用 Secret', en: 'App Secret' }, hint: { zh: '自建应用详情页获取；明文存于本机引擎配置', en: 'From the app detail page; stored in local engine config' } },
      { key: 'agentid', type: 'text', label: { zh: 'AgentId', en: 'AgentId' }, hint: { zh: '自建应用详情页获取，发消息必带', en: 'From the app detail page; required for sending' } },
      { key: 'token', type: 'text', label: { zh: '接收消息 Token', en: 'Callback token' }, hint: { zh: '接收消息服务器配置里设置的 Token，两边须一致', en: 'The token set in the receive-message server config; must match' } },
      { key: 'encodingAESKey', type: 'text', label: { zh: 'EncodingAESKey', en: 'EncodingAESKey' }, hint: { zh: '企业微信后台回调配置页生成，恒为 43 字符；回调消息恒为签名+密文，与 Token 一同必填', en: 'Generated on the WeCom callback config page, always 43 chars; callbacks are always signed+encrypted, required along with the token' } },
      { key: 'callbackPath', type: 'text', label: { zh: '回调路径', en: 'Callback path' }, hint: { zh: '回调 URL 为 https://<域名>/callback/<回调路径>，多账号须互不相同', en: 'Callback URL is https://<host>/callback/<path>; unique per account' } },
    ] },
    { key: 'bots', type: 'rows', dialog: true, label: { zh: '智能机器人（群聊）', en: 'Smart robots (group chats)' }, columns: [
      { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true, hint: { zh: '仅用于面板显示', en: 'Display only' } },
      { key: 'token', type: 'text', label: { zh: '接收消息 Token', en: 'Callback token' }, hint: { zh: '智能机器人回调配置里设置的 Token，两边须一致', en: 'The token from the robot callback config; must match' } },
      { key: 'encodingAESKey', type: 'text', label: { zh: 'EncodingAESKey', en: 'EncodingAESKey' }, hint: { zh: '回调配置页生成，恒为 43 字符；机器人图片/文件 URL 下载后也用它解密', en: 'From the callback config, always 43 chars; also decrypts the robot media URLs' } },
      { key: 'callbackPath', type: 'text', label: { zh: '回调路径', en: 'Callback path' }, hint: { zh: '回调 URL 为 https://<域名>/callback/<回调路径>，与 accounts 及其他 bots 互不相同', en: 'Callback URL is https://<host>/callback/<path>; unique across accounts and bots' } },
    ] },
    { key: 'callbackPort', type: 'number', advanced: true, min: 1, max: 65535, label: { zh: '回调端口', en: 'Callback port' } },
    { key: 'bindAddress', type: 'text', advanced: true, label: { zh: '监听地址', en: 'Bind address' } },
    { key: 'sendAck', type: 'switch', label: { zh: '自动回「已收到」', en: 'Auto acknowledgement' }, hint: { zh: '收到应用单聊消息先回「已收到」，终答随后送达', en: 'Acknowledge app-chat receipts; the final answer follows' } },
  ],
  health: ['wecomCallback'],
  scope(input: { meta: Record<string, unknown> }, config: WecomConfig) {
    const meta = input.meta
    const botId = String(meta.botId ?? '')
    if (botId) {
      const bot = config.bots.find((b) => b.callbackPath === botId)
      if (!bot) return { listened: false, reason: 'wecom: bot not configured: ' + botId }
      if (!meta.chatid) return { listened: false, reason: 'wecom: bot single-chat not received until M3' }
      return { listened: true, observed: false, row: botGroupRowId(bot) }
    }
    const accountId = String(meta.accountId ?? '')
    const row = config.accounts.find((a) => a.callbackPath === accountId || a.corpid === accountId)
    if (!row) return { listened: false, reason: 'wecom: account not configured: ' + accountId }
    return { listened: true, observed: false, row: accountIdOf(row) }
  },
  channel: {
    async send(_host: unknown, message: OutboundMessageLike): Promise<'sent' | 'gone'> {
      const config = (channelConfig as { current?: WecomConfig }).current
      if (!config) throw new Error('wecom: channel not ready (no config yet)')
      const address = message.channel.address as Record<string, string>
      const bot = config.bots.find((b) => b.callbackPath === address.bot)
      if (bot) {
        // Bot group replies go through the one-shot response_url (official
        // 101138; wired in M3). The acknowledgement has no channel yet — drop
        // it silently so it never enters the Outbox retry loop.
        if (message.kind === 'acknowledgement') return 'sent'
        throw new Error('wecom: bot group replies via response_url arrive in M3 (bot=' + address.bot + ')')
      }
      const account = config.accounts.find((a) => a.callbackPath === address.account || a.corpid === address.account)
      if (!account) throw new Error('wecom: account not found: ' + String(address.account ?? ''))
      // 接单回执可关（sendAck=false 时跳过发送，仍记 sent，不留重试队列）。
      if (message.kind === 'acknowledgement' && config.sendAck === false) return 'sent'
      console.error('[wecom] outbound: kind=' + message.kind + ' to=' + String(address.touser ?? '') + ' text="' + message.text.slice(0, 40) + '"')
      // 分块发送（应用文本上限 2048 字节，官方 90236，见 chunk.ts LIMIT）。失败语义设计决策：
      // - 第 1 块失败 → 原样抛出：尚无任何内容落地，引擎退避重试整条是干净的重发；
      // - 第 k>1 块失败 → 失败记入 send-failures.jsonl 后返回 'sent'：前序块已送达用户，
      //   引擎整条重试会重复投递已收到的内容，故按尽力而为收尾，补发凭失败日志对账。
      const channelKey = String(address.account ?? '')
      const chunks = chunkText(message.text, LIMIT)
      for (let i = 0; i < chunks.length; i++) {
        try {
          await sendAppMessage(account, String(address.touser ?? ''), chunks[i])
        } catch (error) {
          // appendSendFailure 内部吞错绝不抛出；这里 await 是为了保证「先落失败日志、
          // 再决定抛出/收尾」的确定性次序（任务书语义：记失败日志后返回 sent）。
          await appendSendFailure({ channelKey, kind: message.kind, error: String(error).slice(0, 300) })
          bumpStat('fail')
          if (i === 0) throw error
          console.error('[wecom] chunk ' + (i + 1) + '/' + chunks.length + ' failed; earlier chunks already delivered — returning sent to avoid a full resend (see send-failures.jsonl)')
          return 'sent'
        }
      }
      bumpStat('out')
      return 'sent'
    },
    link(address: Record<string, string>) {
      return emptyLink({ zh: '企业微信 ' + String(address.touser ?? address.chatid ?? '').slice(0, 12), en: 'WeCom ' + String(address.touser ?? address.chatid ?? '').slice(0, 12) })
    },
  },
  threadContext: {
    messageId(trigger: TriggerLike): string {
      return String(trigger.meta.messageId ?? '')
    },
    // 图片支持：images() 从触发文本提取 '[wecom-image:KEY]' 标记（keys 恒来自原文），
    // image() 下载后经 attachments.saveImage 注入会话（先例：dingtalk-kind / 引擎 feishu-image）。
    images(text: string): string[] {
      return wecomImageKeys(text)
    },
    async image(agent: unknown, _commands: unknown, trigger: TriggerLike, message: { id: string; text: string }, key: string, _stateDir: string, signal: AbortSignal) {
      if (!wecomImageKeys(message.text).includes(key)) throw new Error('Choose an image key from this source message')
      const config = (channelConfig as { current?: WecomConfig }).current
      if (!config) throw new Error('wecom: channel not ready (no config yet)')
      const host = agent as {
        ctx?: { get?: (name: string) => unknown }
        session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } }
        options?: { provider?: string; model?: string }
      }
      const attachments = host.ctx?.get?.('attachments') as {
        saveImage: (input: { data: Buffer; mediaType: string; name: string }) => Promise<unknown>
        imageLimits?: { maxImageBytes?: number; maxMessageImageBytes?: number }
      } | undefined
      if (!attachments?.saveImage) throw new Error('Image reading is unavailable: no attachment service is mounted')
      const route = host.session?.requestHeader?.()?.config
      const provider = route?.provider ?? host.options?.provider
      const model = route?.model ?? host.options?.model
      const llm = host.ctx?.get?.('llm') as { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<{ inputModalities?: string[] }> } | undefined
      if (!llm?.resolveModelInfo || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
      const info = await llm.resolveModelInfo(provider, model, signal)
      if (!info.inputModalities?.includes('image')) throw new Error('Model ' + model + ' does not support image input; the image has not been inspected')
      signal.throwIfAborted()
      const maxBytes = Math.min(attachments.imageLimits?.maxImageBytes ?? 20 * 1024 * 1024, attachments.imageLimits?.maxMessageImageBytes ?? 20 * 1024 * 1024)
      let data: Buffer
      let mediaType: string
      if (key.startsWith('http')) {
        // 路径 1：URL 直取（accounts PicUrl 明文；机器人 image.url 下载后是 AES 密文）。
        const res = await fetch(key, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
        if (!res.ok) throw new Error('Image download failed: HTTP ' + res.status + '（机器人图片 URL 5 分钟有效，过期请重新发送）')
        const raw = Buffer.from(await res.arrayBuffer())
        if (raw.length > maxBytes) throw new Error('The image exceeds the ' + maxBytes + ' byte limit')
        const bot = trigger.meta.botId ? config.bots.find((b) => b.callbackPath === String(trigger.meta.botId)) : undefined
        if (bot) {
          // 机器人媒体 URL 的字节恒为 AES 加密（官方 101045）：用回调同款 key 解密。
          data = decryptBytes(bot.encodingAESKey, raw, '')
          mediaType = sniffImageType(data) ?? ''
          if (!mediaType) throw new Error('Decrypted robot image is not a recognized image format')
        } else {
          data = raw
          mediaType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
          if (!mediaType.startsWith('image/')) mediaType = sniffImageType(data) ?? ''
          if (!mediaType.startsWith('image/')) throw new Error('PicUrl did not return an image (content-type ' + (mediaType || 'unknown') + ')')
        }
      } else {
        // 路径 2：MediaId -> media/get（access_token；临时素材 3 天有效）。
        const accountId = String(trigger.meta.accountId ?? '')
        const account = config.accounts.find((a) => a.callbackPath === accountId || a.corpid === accountId)
        if (!account) throw new Error('wecom: account not found for MediaId download: ' + accountId)
        const media = await getMediaImage(account, key, maxBytes, signal)
        data = media.data
        mediaType = media.mediaType.startsWith('image/') ? media.mediaType : (sniffImageType(data) ?? '')
        if (!mediaType) throw new Error('media/get returned an unrecognized image format')
      }
      signal.throwIfAborted()
      const name = 'wecom-' + (key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'image') + '.' + (mediaType.split('/')[1] || 'bin')
      const image = await attachments.saveImage({ data, mediaType, name })
      signal.throwIfAborted()
      return { source_message_id: message.id, image_key: key, image }
    },
    async read(_commands: unknown, trigger: TriggerLike, part: 'thread' | 'root' | 'parent', _cursor: string | undefined, _config: WecomConfig) {
      // v2: the assessment reads the trigger's own message; app-chat/group
      // history needs extra API permissions (planned M3+).
      const own = { id: String(trigger.meta.messageId ?? trigger.id), from: String(trigger.actor.id), at: trigger.at, text: trigger.text }
      return { messages: part === 'parent' ? [] : [own], body: {}, status: undefined }
    },
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '允许派活的成员', en: 'Allowed members' }, columns: [
        { key: 'id', type: 'text', label: { zh: 'userid', en: 'userid' } },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
      ] },
    ],
    explicit: { zh: '在应用单聊里给机器人发消息，或群里 @ 智能机器人', en: 'Message the app bot in its chat, or mention the smart robot in a group' },
    rows(config: Record<string, unknown>) {
      const accounts = (Array.isArray(config.accounts) ? config.accounts : []) as WecomAccount[]
      const bots = (Array.isArray(config.bots) ? config.bots : []) as WecomBot[]
      const accountRows = accounts.map((a) => ({
        id: accountIdOf(a),
        label: a.name || a.corpid,
        note: { zh: '应用单聊消息均为明确指派', en: 'App-chat messages are explicit assignments' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true },
      }))
      const botRows = bots.map((b) => ({
        id: botGroupRowId(b),
        label: (b.name || b.callbackPath) + ' 群聊',
        note: { zh: '群聊仅 @ 可指派', en: 'Mention to assign in group chats' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false },
      }))
      return [...accountRows, ...botRows]
    },
  },
} as unknown as SourceKindLike

// M3 spike: file/video media (robot file/video URLs share the encrypted-URL
// scheme, official 101045) could be saved to disk and referenced in the
// trigger text like the dingtalk Source does; the exact URL lifetime and the
// 100M cap behaviour need a real-robot pass first.
