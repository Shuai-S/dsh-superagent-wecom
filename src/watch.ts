/** Watch loop: keeps one callback server per config version (config-hash
 *  restart, mirrors the dingtalk Stream client lifecycle), maps callback
 *  messages (app accounts: XML; smart robots: JSON) to Triggers and feeds
 *  receive(). Health reports the listening state and start failures such as
 *  EADDRINUSE. */
import type { Server } from 'node:http'
import type { SourceContextLike } from './types.ts'
import { startCallbackServer, type IncomingBotMessage, type IncomingWecomMessage } from './callback.ts'
import { buildWecomBotTrigger, buildWecomTrigger, channelConfig, HEALTH_ENTRY, type WecomAccount, type WecomBot, type WecomConfig } from './wecom-kind.ts'

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = () => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', stop, { once: true })
  })
}

/** Accounts with every required field filled: corpid/secret/agentid/token/
 *  callbackPath and the mandatory 43-char EncodingAESKey. */
export function validAccounts(config?: WecomConfig): WecomAccount[] {
  if (!config?.accounts) return []
  return config.accounts.filter((a) => a.corpid && a.secret && a.agentid && a.token && a.callbackPath && a.encodingAESKey)
}

/** Robots with every required field filled: token/callbackPath and the
 *  mandatory 43-char EncodingAESKey (official 101034; no corp fields). */
export function validBots(config?: WecomConfig): WecomBot[] {
  if (!config?.bots) return []
  return config.bots.filter((b) => b.token && b.encodingAESKey && b.callbackPath)
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

async function onCallbackMessage(source: SourceContextLike, seenSenders: Set<string>, message: IncomingWecomMessage): Promise<void> {
  const from = String(message.fields.FromUserName ?? '')
  // 首条消息打印 sender userid，供白名单（Policy → 允许派活的成员）抄写。
  if (from && !seenSenders.has(from)) {
    seenSenders.add(from)
    console.error('[wecom] new sender: FromUserName=' + from + ' account=' + message.account.callbackPath + '（加入 Policy 白名单后才能派活）')
  }
  const trigger = buildWecomTrigger(message)
  if (!trigger) {
    console.error('[wecom] skip: msgType=' + String(message.fields.MsgType ?? '') + ' (no MsgId or empty text)')
    return
  }
  console.error('[wecom] msg in: type=' + String(trigger.meta.msgType) + ' msgId=' + String(trigger.meta.messageId) + ' from=' + from + ' text="' + trigger.text.slice(0, 60) + '"')
  await source.receive(trigger)
}

async function onBotCallbackMessage(source: SourceContextLike, seenSenders: Set<string>, dumpedSkips: Set<string>, message: IncomingBotMessage): Promise<void> {
  const payload = message.payload
  const msgId = String(payload.msgid ?? '')
  const msgType = String(payload.msgtype ?? '')
  const chattype = String(payload.chattype ?? '')
  const from = String((payload.from as Record<string, unknown> | undefined)?.userid ?? '')
  // 首条发送者打印 userid，供白名单（Policy → 允许派活的成员）抄写。
  if (from && !seenSenders.has('bot:' + from)) {
    seenSenders.add('bot:' + from)
    console.error('[wecom] new bot sender: userid=' + from + ' bot=' + message.bot.callbackPath + '（加入 Policy 白名单后才能派活）')
  }
  const trigger = buildWecomBotTrigger(message.bot, payload)
  if (!trigger) {
    // 防御式：缺字段/单聊/事件类型显式 skip；同一原因只 dump 首条原始载荷（≤500 字符），防日志风暴。
    const reason = msgType === 'event' || msgType === 'stream' ? 'type=' + msgType
      : chattype !== 'group' ? 'chattype=' + (chattype || 'missing')
      : !msgId ? 'no-msgid' : !from ? 'no-from-userid' : 'no-text'
    if (!dumpedSkips.has(reason)) {
      dumpedSkips.add(reason)
      console.error('[wecom] bot skip (' + reason + ') payload=' + JSON.stringify(payload).slice(0, 500))
    } else {
      console.error('[wecom] bot skip (' + reason + ') msgId=' + msgId)
    }
    return
  }
  console.error('[wecom] bot msg in: type=' + String(trigger.meta.msgType) + ' msgId=' + String(trigger.meta.messageId) + ' chat=' + String(trigger.meta.chatid) + ' from=' + from + ' text="' + trigger.text.slice(0, 60) + '"')
  await source.receive(trigger)
}

export async function watch(source: SourceContextLike, signal: AbortSignal): Promise<void> {
  const state: { hash: string; server?: Server } = { hash: '' }
  const seenSenders = new Set<string>()
  const dumpedSkips = new Set<string>()
  let lastError = ''
  while (!signal.aborted) {
    try {
      const config = source.config<WecomConfig>('wecom')
      const accounts = validAccounts(config)
      const bots = validBots(config)
      if (config && (accounts.length > 0 || bots.length > 0)) {
        channelConfig.current = config
        const allPaths = [...accounts.map((a) => a.callbackPath), ...bots.map((b) => b.callbackPath)]
        if (allPaths.length !== new Set(allPaths).size) console.error('[wecom] duplicate callbackPath across accounts/bots; only the first per path receives messages')
        const hash = JSON.stringify([config.accounts, config.bots, config.callbackPort, config.bindAddress])
        if (state.hash !== hash || !state.server) {
          await closeServer(state.server)
          state.server = undefined
          state.hash = ''
          const server = await startCallbackServer({
            port: config.callbackPort,
            bindAddress: config.bindAddress,
            accounts: accounts.map((a) => ({ name: a.name, corpid: a.corpid, agentid: a.agentid, token: a.token, encodingAESKey: a.encodingAESKey, callbackPath: a.callbackPath })),
            bots: bots.map((b) => ({ name: b.name, token: b.token, encodingAESKey: b.encodingAESKey, callbackPath: b.callbackPath })),
            onMessage: (message) => onCallbackMessage(source, seenSenders, message),
            onBotMessage: (message) => onBotCallbackMessage(source, seenSenders, dumpedSkips, message),
          })
          state.server = server
          state.hash = hash
          lastError = ''
          source.report(HEALTH_ENTRY, { state: 'ready', detail: 'callback listening on :' + config.callbackPort + ' (' + accounts.length + ' accounts, ' + bots.length + ' bots)' })
        } else if (!state.server.listening) {
          source.report(HEALTH_ENTRY, { state: 'error', detail: 'callback server stopped listening' })
        }
      } else {
        if (state.server) {
          await closeServer(state.server)
          state.server = undefined
          state.hash = ''
        }
        channelConfig.current = undefined
        source.report(HEALTH_ENTRY, { state: 'paused', detail: 'waiting for callback accounts in settings' })
      }
    } catch (error) {
      const detail = String(error).slice(0, 300)
      // 端口被占（EADDRINUSE）等启动失败每轮重试；同因只报一次，端口释放后自动恢复。
      if (detail !== lastError) {
        lastError = detail
        source.report(HEALTH_ENTRY, { state: 'error', detail })
      }
    }
    await pause(5000, signal)
  }
  await closeServer(state.server)
}
