/** crypto.ts 闸门测试：加解密往返、签名稳定性、坏输入的确定性行为。零网络。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decrypt, encrypt, signatureOf, verifySignature } from '../lib/index.js'

const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' // 恒 43 字符
const CORP = 'wwtest01'

test('encrypt→decrypt 往返（ASCII / 中文 / emoji / 空串 / 长文）', () => {
  const cases = ['hello', '你好，企业微信', 'emoji 😀🎉 mix', '', 'x'.repeat(5000)]
  for (const plain of cases) {
    assert.equal(decrypt(KEY, encrypt(KEY, plain, CORP), CORP), plain)
  }
})

test('signatureOf 稳定：同输入同输出、参与项排序不敏感、不同输入不同、40 位 hex', () => {
  const a = signatureOf('token', '1700000000', 'nonce', 'enc-b64')
  assert.equal(a, signatureOf('token', '1700000000', 'nonce', 'enc-b64'))
  assert.equal(a, signatureOf('enc-b64', 'token', 'nonce', '1700000000')) // 内部排序后同值
  assert.notEqual(a, signatureOf('token', '1700000000', 'nonce', 'enc-b64x'))
  assert.match(a, /^[0-9a-f]{40}$/)
})

test('verifySignature：真签名通过，伪造与坏长度拒绝（不抛错）', () => {
  const sig = signatureOf('t', '1', 'n', 'e')
  assert.equal(verifySignature('t', '1', 'n', 'e', sig), true)
  assert.equal(verifySignature('t', '1', 'n', 'e', 'f'.repeat(40)), false)
  assert.equal(verifySignature('t', '1', 'n', 'e', ''), false)
  assert.equal(verifySignature('t', '1', 'n', 'e', 'zzzz'), false)
})

test('坏输入走确定的 Error 路径，无未定义行为', () => {
  const enc = encrypt(KEY, 'x', CORP)
  assert.throws(() => decrypt('short-key', enc, CORP), /EncodingAESKey/)
  assert.throws(() => decrypt('', enc, CORP), /EncodingAESKey/)
  assert.throws(() => encrypt('bad', 'x', CORP), /EncodingAESKey/)
  assert.throws(() => decrypt(KEY, '', CORP)) // 空密文
  assert.throws(() => decrypt(KEY, enc.slice(0, enc.length - 8), CORP)) // 截断：非 16 字节倍数
  assert.throws(() => decrypt(KEY, enc, 'other-corp'), /receiveid/)
  const buf = Buffer.from(enc, 'base64')
  buf[buf.length - 1] = 0x7f // 篡改末块 → PKCS7 校验必败（同 probe.mjs 手法）
  assert.throws(() => decrypt(KEY, buf.toString('base64'), CORP))
})
