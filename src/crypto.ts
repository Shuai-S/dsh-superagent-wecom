/** WeCom callback crypto, self-implemented on node:crypto (the community
 *  wechat-crypto package is unmaintained). Implements the official 加解密协议:
 *  signature check, AES-256-CBC encrypt/decrypt with the EncodingAESKey,
 *  PKCS7 padding, and the 16+4+msg+receiveid plaintext structure.
 *  Contract: https://developer.work.weixin.qq.com/document/path/90968
 *  Smart-robot variant (official 101034, read 2026-11-04): same AES scheme,
 *  but the receiveid is the empty string, and media-download URLs (official
 *  101045) return bytes encrypted with the same key — see decryptBytes. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** sha1 over the sorted [token, timestamp, nonce, encrypt] concatenation. */
export function signatureOf(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash('sha1').update([token, timestamp, nonce, encrypt].sort().join('')).digest('hex')
}

/** Constant-time check of the msg_signature query parameter. */
export function verifySignature(token: string, timestamp: string, nonce: string, encrypt: string, msgSignature: string): boolean {
  const expected = Buffer.from(signatureOf(token, timestamp, nonce, encrypt), 'utf8')
  const given = Buffer.from(String(msgSignature ?? ''), 'utf8')
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}

/** EncodingAESKey (43 chars) -> 32-byte AES key. */
function aesKeyOf(encodingAESKey: string): Buffer {
  const key = Buffer.from(encodingAESKey + '=', 'base64')
  if (key.length !== 32) throw new Error('wecom crypto: EncodingAESKey must decode to 32 bytes, got ' + key.length + ' (the key should be 43 chars)')
  return key
}

/** Shared core: AES-256-CBC (IV = first 16 key bytes), strip PKCS7 (32-byte
 *  block), then plaintext = 16 random bytes + 4-byte BE msg_len + msg + receiveid. */
function decryptCore(encodingAESKey: string, cipher: Buffer, receiveId: string): Buffer {
  const key = aesKeyOf(encodingAESKey)
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(cipher), decipher.final()])
  } catch {
    throw new Error('wecom crypto: decrypt failed (ciphertext is not valid AES-256-CBC data)')
  }
  const pad = plain.length > 0 ? plain[plain.length - 1] : 0
  if (pad < 1 || pad > 32 || pad > plain.length) throw new Error('wecom crypto: invalid PKCS7 padding')
  const content = plain.subarray(0, plain.length - pad)
  if (content.length < 20) throw new Error('wecom crypto: plaintext shorter than the 16+4 byte header')
  const msgLen = content.readUInt32BE(16)
  if (20 + msgLen > content.length) throw new Error('wecom crypto: msg_len exceeds the decrypted plaintext')
  const msg = content.subarray(20, 20 + msgLen)
  const receiveid = content.subarray(20 + msgLen).toString('utf8')
  if (receiveid !== receiveId) throw new Error('wecom crypto: receiveid mismatch (expected ' + JSON.stringify(receiveId) + ', got ' + JSON.stringify(receiveid) + ')')
  return msg
}

/** Decrypt one callback payload to its UTF-8 message. Throws when the trailing
 *  receiveid does not match the expected id (accounts: corpid; smart robots: ''). */
export function decrypt(encodingAESKey: string, encryptB64: string, receiveId: string): string {
  return decryptCore(encodingAESKey, Buffer.from(encryptB64, 'base64'), receiveId).toString('utf8')
}

/** Binary variant for smart-robot media URLs (official 101045, read
 *  2026-11-04): the downloaded file is AES-encrypted with the same key
 *  (AES-256-CBC, PKCS#7 to 32 bytes, IV = first 16 key bytes), and the
 *  receiveid is the empty string for in-house robots. */
export function decryptBytes(encodingAESKey: string, cipher: Buffer, receiveId: string): Buffer {
  return decryptCore(encodingAESKey, cipher, receiveId)
}

/** Inverse of decrypt (self-test / probe helper; WeCom only ever sends the
 *  encrypted form). PKCS7-pads to the 32-byte block the official encoder uses. */
export function encrypt(encodingAESKey: string, plaintext: string, receiveId: string): string {
  const key = aesKeyOf(encodingAESKey)
  const msg = Buffer.from(plaintext, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(msg.length, 0)
  const raw = Buffer.concat([randomBytes(16), len, msg, Buffer.from(receiveId, 'utf8')])
  const padLen = 32 - (raw.length % 32)
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)])
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
}
