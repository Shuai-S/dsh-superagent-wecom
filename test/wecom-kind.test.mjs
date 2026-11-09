/** wecom-kind.ts / watch.ts 纯函数闸门测试：schema 默认与拒绝、validAccounts/validBots、
 *  Trigger 映射与 skip 分支、scope 行解析。零网络零引擎。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WecomConfigSchema, buildWecomTrigger, buildWecomBotTrigger, wecomKind,
  validAccounts, validBots, accountIdOf, botGroupRowId,
} from '../lib/index.js'

const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const ACCOUNT = { name: 'acc', corpid: 'wwcorp01', secret: 'sec', agentid: '1000002', token: 'tok', encodingAESKey: KEY, callbackPath: 'acc-path' }
const BOT = { name: 'bot', token: 'btok', encodingAESKey: KEY, callbackPath: 'bot-path' }
const msg = (fields) => ({ account: ACCOUNT, fields, xml: '' })

test('WecomConfigSchema 默认值：空配置补齐 accounts/bots/port/bind/sendAck', () => {
  const parsed = WecomConfigSchema.parse({})
  assert.deepEqual(parsed.accounts, [])
  assert.deepEqual(parsed.bots, [])
  assert.equal(parsed.callbackPort, 3090)
  assert.equal(parsed.bindAddress, '0.0.0.0')
  assert.equal(parsed.sendAck, true)
})

test('WecomConfigSchema 拒绝非法项：strict 未知键、非 43 位 key、端口越界、类型错误', () => {
  assert.throws(() => WecomConfigSchema.parse({ unknownKey: 1 })) // strict()
  assert.throws(() => WecomConfigSchema.parse({ accounts: [{ ...ACCOUNT, encodingAESKey: 'too-short' }] }))
  assert.throws(() => WecomConfigSchema.parse({ accounts: [{ ...ACCOUNT, encodingAESKey: KEY + 'x' }] }))
  assert.throws(() => WecomConfigSchema.parse({ accounts: [{ ...ACCOUNT, corpid: '' }] }))
  assert.throws(() => WecomConfigSchema.parse({ callbackPort: 0 }))
  assert.throws(() => WecomConfigSchema.parse({ callbackPort: 70000 }))
  assert.throws(() => WecomConfigSchema.parse({ callbackPort: 1.5 }))
  assert.throws(() => WecomConfigSchema.parse({ sendAck: 'yes' }))
  WecomConfigSchema.parse({ accounts: [ACCOUNT], bots: [BOT] }) // 合法不抛
})

test('validAccounts/validBots：缺任一必填字段的行被过滤；undefined 配置返回空', () => {
  const config = { accounts: [ACCOUNT, { ...ACCOUNT, callbackPath: '' }, { ...ACCOUNT, corpid: '' }], bots: [BOT, { ...BOT, token: '' }, { ...BOT, encodingAESKey: '' }] }
  assert.deepEqual(validAccounts(config), [ACCOUNT])
  assert.deepEqual(validBots(config), [BOT])
  assert.deepEqual(validAccounts(undefined), [])
  assert.deepEqual(validBots(undefined), [])
})

test('buildWecomTrigger 文本映射：id/thread/actor/addressed/at/text/channel/meta', () => {
  const trigger = buildWecomTrigger(msg({ FromUserName: 'zhangsan', MsgType: 'text', Content: '派活', MsgId: '7001', CreateTime: '1700000000' }))
  assert.equal(trigger.id, 'wecom:7001')
  assert.equal(trigger.source, 'wecom')
  assert.deepEqual(trigger.threads, [{ source: 'wecom', id: 'u:zhangsan' }])
  assert.deepEqual(trigger.actor, { source: 'wecom', id: 'zhangsan' })
  assert.equal(trigger.human, true)
  assert.equal(trigger.addressed, 'direct')
  assert.equal(trigger.at, new Date(1700000000 * 1000).toISOString())
  assert.equal(trigger.text, '派活')
  assert.equal(trigger.channel.thread, 'wecom:u:zhangsan')
  assert.equal(trigger.channel.address.account, 'acc-path')
  assert.equal(trigger.channel.address.touser, 'zhangsan')
  assert.equal(trigger.meta.accountId, 'acc-path')
  assert.equal(trigger.meta.messageId, '7001')
  assert.equal(trigger.meta.msgType, 'text')
})

test('buildWecomTrigger 图片映射：PicUrl 优先、MediaId 兜底；account 兜底 corpid', () => {
  const pic = buildWecomTrigger(msg({ FromUserName: 'z', MsgType: 'image', PicUrl: 'https://x/pic.jpg', MediaId: 'M1', MsgId: '7002' }))
  assert.equal(pic.text, '[wecom-image:https://x/pic.jpg]')
  assert.equal(pic.meta.picUrl, 'https://x/pic.jpg')
  assert.equal(pic.meta.mediaId, 'M1')
  const mid = buildWecomTrigger(msg({ FromUserName: 'z', MsgType: 'image', MediaId: 'M2', MsgId: '7003' }))
  assert.equal(mid.text, '[wecom-image:M2]')
  const byCorp = buildWecomTrigger({ account: { ...ACCOUNT, callbackPath: '' }, fields: { FromUserName: 'z', MsgType: 'text', Content: 'hi', MsgId: '7004' }, xml: '' })
  assert.equal(byCorp.channel.address.account, 'wwcorp01')
})

test('buildWecomTrigger skip 分支：无 MsgId / 无发送人 / 空文本 / 图片无 key / 未知类型标记', () => {
  assert.equal(buildWecomTrigger(msg({ MsgType: 'event', Event: 'subscribe' })), undefined)
  assert.equal(buildWecomTrigger(msg({ MsgType: 'text', Content: 'hi', MsgId: '7005' })), undefined) // 无 FromUserName
  assert.equal(buildWecomTrigger(msg({ FromUserName: 'z', MsgType: 'text', Content: '  ', MsgId: '7006' })), undefined) // 空文本
  assert.equal(buildWecomTrigger(msg({ FromUserName: 'z', MsgType: 'image', MsgId: '7007' })), undefined) // 无 PicUrl/MediaId
  const other = buildWecomTrigger(msg({ FromUserName: 'z', MsgType: 'voice', MsgId: '7008' }))
  assert.equal(other.text, '[wecom-voice]')
  assert.equal(new Date(other.at).toString() !== 'Invalid Date', true) // CreateTime 缺失回退当前时间，仍为合法 ISO
})

const BOT_PAYLOAD = {
  msgid: 'BOTS-1', aibotid: 'AIBOT1', chatid: 'CHAT1', chattype: 'group',
  from: { userid: 'zhangsan' }, response_url: 'https://qyapi.test/response?code=1',
  msgtype: 'text', text: { content: '@RobotA 帮我查一下' }, create_time: 1700000003,
}

test('buildWecomBotTrigger 群聊映射：mention 触发、g: 线程、response_url 进 address、quote 进 meta', () => {
  const trigger = buildWecomBotTrigger(BOT, { ...BOT_PAYLOAD, quote: { msgtype: 'text', text: { content: '引用内容' } } })
  assert.equal(trigger.id, 'wecom:BOTS-1')
  assert.deepEqual(trigger.threads, [{ source: 'wecom', id: 'g:CHAT1' }])
  assert.deepEqual(trigger.actor, { source: 'wecom', id: 'zhangsan' })
  assert.equal(trigger.human, true)
  assert.equal(trigger.addressed, 'mention')
  assert.equal(trigger.at, new Date(1700000003 * 1000).toISOString())
  assert.equal(trigger.text, '@RobotA 帮我查一下')
  assert.equal(trigger.channel.thread, 'wecom:g:CHAT1')
  assert.equal(trigger.channel.address.bot, 'bot-path')
  assert.equal(trigger.channel.address.responseUrl, 'https://qyapi.test/response?code=1')
  assert.equal(trigger.meta.quoteText, '引用内容')
  assert.equal(trigger.meta.chatid, 'CHAT1')
})

test('buildWecomBotTrigger mixed 图文：text 项拼行、image 项转 [wecom-image:URL] 标记', () => {
  const mixed = buildWecomBotTrigger(BOT, { ...BOT_PAYLOAD, msgid: 'BOTS-2', msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: '@RobotA 看图' } },
    { msgtype: 'image', image: { url: 'https://cos.test/enc1' } },
  ] } })
  assert.equal(mixed.text, '@RobotA 看图\n[wecom-image:https://cos.test/enc1]')
})

test('buildWecomBotTrigger skip 分支：event/stream / 单聊 / 缺 msgid|chatid|from / 空文本', () => {
  assert.equal(buildWecomBotTrigger(BOT, { ...BOT_PAYLOAD, msgtype: 'event' }), undefined)
  assert.equal(buildWecomBotTrigger(BOT, { ...BOT_PAYLOAD, msgtype: 'stream' }), undefined)
  assert.equal(buildWecomBotTrigger(BOT, { ...BOT_PAYLOAD, chattype: 'single' }), undefined)
  assert.equal(buildWecomBotTrigger(BOT, { ...BOT_PAYLOAD, msgid: '' }), undefined)
  assert.equal(buildWecomBotTrigger(BOT, { ...BOT_PAYLOAD, chatid: '' }), undefined)
  assert.equal(buildWecomBotTrigger(BOT, { ...BOT_PAYLOAD, from: { userid: '' } }), undefined)
  assert.equal(buildWecomBotTrigger(BOT, { ...BOT_PAYLOAD, msgtype: 'text', text: { content: '  ' } }), undefined)
})

test('scope：bot 群行 wecom-bot:<path>；单聊/未知 bot/未知账号不放行；账号可按 corpid 匹配', () => {
  const config = WecomConfigSchema.parse({ accounts: [ACCOUNT], bots: [BOT] })
  assert.deepEqual(wecomKind.scope({ meta: { botId: 'bot-path', chatid: 'CHAT1' } }, config), { listened: true, observed: false, row: botGroupRowId(BOT) })
  assert.equal(wecomKind.scope({ meta: { botId: 'bot-path' } }, config).listened, false) // 无 chatid = 单聊（M3 前）
  assert.equal(wecomKind.scope({ meta: { botId: 'nope', chatid: 'c' } }, config).listened, false)
  assert.deepEqual(wecomKind.scope({ meta: { accountId: 'acc-path' } }, config), { listened: true, observed: false, row: accountIdOf(ACCOUNT) })
  assert.deepEqual(wecomKind.scope({ meta: { accountId: 'wwcorp01' } }, config), { listened: true, observed: false, row: 'acc-path' })
  assert.equal(wecomKind.scope({ meta: { accountId: 'ghost' } }, config).listened, false)
})
