/** callback.ts 的 parseWecomXml：正常 CDATA / 畸形 / 空体。零网络零引擎。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWecomXml } from '../lib/index.js'

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

test('正常 XML：CDATA 解包、字段全为字符串、64 位 MsgId 保持字符串', () => {
  const fields = parseWecomXml(TEXT_XML)
  assert.equal(fields.FromUserName, 'zhangsan')
  assert.equal(fields.MsgType, 'text')
  assert.equal(fields.Content, '帮我查一下服务状态')
  assert.equal(fields.MsgId, '7000000000000001')
  assert.equal(typeof fields.MsgId, 'string')
  assert.equal(typeof fields.CreateTime, 'string')
})

test('畸形 XML：不抛错，返回对象（尽力解析，回调路径不崩）', () => {
  for (const bad of ['not xml at all', '<xml><unclosed>', '<<<>>>', '<xml></xml><xml>x</xml>']) {
    let fields
    assert.doesNotThrow(() => { fields = parseWecomXml(bad) })
    assert.equal(typeof fields, 'object')
    assert.ok(fields !== null)
  }
})

test('空体：返回空对象', () => {
  assert.deepEqual(parseWecomXml(''), {})
})
