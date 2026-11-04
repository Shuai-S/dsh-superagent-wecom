/** The 'wecom' Source kind: WeCom (企业微信) self-built app messages arriving
 *  over the callback HTTP server (回调模式), replies through the WeCom OpenAPI.
 *  Shape mirrors the bundled github/feishu kinds (docs/008-cookbook.md); the
 *  engine duck-types it at runtime. */
import { z } from 'zod'
import type { Localized, OutboundMessageLike, SourceKindLike, TriggerLike } from './types.ts'
import type { IncomingWecomMessage } from './callback.ts'
import { emptyLink, sendAppMessage } from './robot.ts'

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
export interface WecomConfig {
  accounts: WecomAccount[]
  callbackPort: number
  bindAddress: string
  sendAck: boolean
}

// channel.send reads config through this holder; watch() refreshes it every round.
export const channelConfig: { current?: WecomConfig } = {}

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
  callbackPort: z.number().int().min(1).max(65535).default(3090),
  bindAddress: z.string().default('0.0.0.0'),
  sendAck: z.boolean().default(true),
}).strict()
export type WecomConfigInput = z.input<typeof WecomConfigSchema>

/** Admission row id of an account: its callback path (unique per account). */
export const accountIdOf = (account: WecomAccount): string => account.callbackPath

/** The Trigger of one callback message; events without MsgId produce none
 *  (v1 handles message types only). */
export function buildWecomTrigger(message: IncomingWecomMessage): TriggerLike | undefined {
  const fields = message.fields
  const msgId = String(fields.MsgId ?? '').trim()
  const from = String(fields.FromUserName ?? '').trim()
  const msgType = String(fields.MsgType ?? '').trim()
  if (!msgId || !from) return undefined // 无 MsgId 的事件（subscribe 等）忽略
  const text = msgType === 'text' ? String(fields.Content ?? '').trim() : '[wecom-' + msgType + ']'
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

export const wecomKind = {
  kind: 'wecom',
  title: { zh: '企业微信', en: 'WeCom' },
  description: {
    zh: '企业微信自建应用回调模式：在应用单聊里发消息即可派活，回复经企业微信 OpenAPI 直接回企业微信。',
    en: 'WeCom self-built app in callback mode: message the bot in the app chat to dispatch; replies go straight back to WeCom.',
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
    { key: 'callbackPort', type: 'number', advanced: true, min: 1, max: 65535, label: { zh: '回调端口', en: 'Callback port' } },
    { key: 'bindAddress', type: 'text', advanced: true, label: { zh: '监听地址', en: 'Bind address' } },
    { key: 'sendAck', type: 'switch', label: { zh: '自动回「已收到」', en: 'Auto acknowledgement' }, hint: { zh: '收到消息先回「已收到」，终答随后送达', en: 'Acknowledge on receipt; the final answer follows' } },
  ],
  health: ['wecomCallback'],
  scope(input: { meta: Record<string, unknown> }, config: WecomConfig) {
    const accountId = String(input.meta.accountId ?? '')
    const row = config.accounts.find((a) => a.callbackPath === accountId || a.corpid === accountId)
    if (!row) return { listened: false, reason: 'wecom: account not configured: ' + accountId }
    return { listened: true, observed: false, row: accountIdOf(row) }
  },
  channel: {
    async send(_host: unknown, message: OutboundMessageLike): Promise<'sent' | 'gone'> {
      const config = (channelConfig as { current?: WecomConfig }).current
      if (!config) throw new Error('wecom: channel not ready (no config yet)')
      const address = message.channel.address as Record<string, string>
      const account = config.accounts.find((a) => a.callbackPath === address.account || a.corpid === address.account)
      if (!account) throw new Error('wecom: account not found: ' + String(address.account ?? ''))
      // 接单回执可关（sendAck=false 时跳过发送，仍记 sent，不留重试队列）。
      if (message.kind === 'acknowledgement' && config.sendAck === false) return 'sent'
      console.error('[wecom] outbound: kind=' + message.kind + ' to=' + String(address.touser ?? '') + ' text="' + message.text.slice(0, 40) + '"')
      await sendAppMessage(account, String(address.touser ?? ''), message.text)
      return 'sent'
    },
    link(address: Record<string, string>) {
      return emptyLink({ zh: '企业微信 ' + String(address.touser ?? '').slice(0, 12), en: 'WeCom ' + String(address.touser ?? '').slice(0, 12) })
    },
  },
  threadContext: {
    messageId(trigger: TriggerLike): string {
      return String(trigger.meta.messageId ?? '')
    },
    // v1: the assessment reads the trigger's own message; app-chat history
    // needs extra API permissions (planned M2+).
    async read(_commands: unknown, trigger: TriggerLike, part: 'thread' | 'root' | 'parent', _cursor: string | undefined, _config: WecomConfig) {
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
    explicit: { zh: '在应用单聊里给机器人发消息', en: 'Message the bot in the app chat' },
    rows(config: Record<string, unknown>) {
      const accounts = (Array.isArray(config.accounts) ? config.accounts : []) as WecomAccount[]
      return accounts.map((a) => ({
        id: accountIdOf(a),
        label: a.name || a.corpid,
        note: { zh: '应用单聊消息均为明确指派', en: 'App-chat messages are explicit assignments' },
        cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true },
      }))
    },
  },
} as unknown as SourceKindLike
