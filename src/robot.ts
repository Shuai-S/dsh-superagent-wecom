/** WeCom OpenAPI helpers: access-token cache (per corpid+secret) and the
 *  self-built-app text message send.
 *  Contract: https://developer.work.weixin.qq.com/document/path/90236 */
import type { Localized } from './types.ts'

export interface WecomCredentials { corpid: string; secret: string; agentid: string }

interface TokenEntry { token: string; expiresAt: number }
const tokenCache = new Map<string, TokenEntry>()
const TOKEN_RENEW_MS = 60_000

/** gettoken with a 60s-early renewal cache, keyed by corpid+secret. */
export async function getToken(corpid: string, secret: string): Promise<string> {
  const cacheKey = corpid + '\u0000' + secret
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + TOKEN_RENEW_MS) return cached.token
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' + encodeURIComponent(corpid) + '&corpsecret=' + encodeURIComponent(secret)
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number }
  if (!res.ok || !body.access_token) {
    throw new Error('wecom gettoken failed: HTTP ' + res.status + ' errcode=' + body.errcode + ' ' + (body.errmsg ?? '').slice(0, 200))
  }
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000 })
  return body.access_token
}

/** Send one text message to a WeCom user (touser) from the self-built app.
 *  HTTP 200 with errcode != 0 is a failure; 60020 points at the trusted-IP list. */
export async function sendAppMessage(account: WecomCredentials, touser: string, text: string): Promise<void> {
  const token = await getToken(account.corpid, account.secret)
  const res = await fetch('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ touser, msgtype: 'text', agentid: Number(account.agentid), text: { content: text } }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
  if (!res.ok) throw new Error('wecom send failed: HTTP ' + res.status + ' ' + JSON.stringify(body).slice(0, 200))
  if (body.errcode !== 0 && body.errcode !== undefined) {
    let detail = 'errcode=' + body.errcode + ' errmsg=' + (body.errmsg ?? '')
    if (body.errcode === 60020) detail += '（检查应用可信IP配置：企业微信后台 → 应用管理 → 该自建应用 → 企业可信IP）'
    throw new Error('wecom send failed: ' + detail)
  }
}

export const emptyLink = (label: Localized) => ({ url: '', label })
