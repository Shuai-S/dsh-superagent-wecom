/** chunk.ts 闸门测试：UTF-8 边界（代理对/组合字符）、限长、空串/单块、切点优先级。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, LIMIT } from '../lib/index.js'

test('LIMIT 常量 = 2048（官方 90236 实证：text 消息内容最长不超过 2048 字节）', () => {
  assert.equal(LIMIT, 2048)
})

test('单块与空串：放得下返回原串；空串返回 [\'\']（保持既有发送行为）', () => {
  assert.deepEqual(chunkText('hello', 100), ['hello'])
  assert.deepEqual(chunkText('你好', 100), ['你好'])
  assert.deepEqual(chunkText('', 100), [''])
})

test('maxBytes 非法入参抛确定错误', () => {
  for (const bad of [0, -1, 1.5, NaN]) {
    assert.throws(() => chunkText('x', bad), /maxBytes/)
  }
})

test('纯 ASCII 无分隔符：等宽切分且拼接恒等', () => {
  const text = 'a'.repeat(25)
  const chunks = chunkText(text, 10)
  assert.deepEqual(chunks, ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)])
  assert.equal(chunks.join(''), text)
})

test('中文 3 字节：预算 7 → 每块 2 字，不劈 UTF-8 序列', () => {
  const text = '啊'.repeat(7)
  const chunks = chunkText(text, 7)
  assert.deepEqual(chunks, ['啊啊', '啊啊', '啊啊', '啊'])
  assert.equal(chunks.join(''), text)
})

test('emoji 代理对：预算 7 → 每块 1 枚，不劈代理对、无替换字符', () => {
  const text = '😀'.repeat(5)
  const chunks = chunkText(text, 7)
  assert.deepEqual(chunks, ['😀', '😀', '😀', '😀', '😀'])
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c, 'utf8') <= 7)
    assert.equal(Buffer.from(c, 'utf8').toString('utf8'), c)
  }
  assert.equal(chunks.join(''), text)
})

test('组合字符（e + U+0301）：图簇整体切，无块以组合符号开头', () => {
  const text = 'e\u0301'.repeat(6) // 每图簇 3 字节，共 18 字节
  const chunks = chunkText(text, 7)
  assert.equal(chunks.join(''), text)
  assert.deepEqual(chunks, Array(3).fill('e\u0301'.repeat(2)))
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c, 'utf8') <= 7)
    assert.ok(!c.startsWith('\u0301'), '组合符号被从基字符上劈开')
  }
})

test('段落空行 \\n\\n 优先', () => {
  const text = 'A'.repeat(5) + '\n\n' + 'B'.repeat(5) // 12 字节
  const chunks = chunkText(text, 10)
  assert.deepEqual(chunks, ['A'.repeat(5) + '\n\n', 'B'.repeat(5)])
  assert.equal(chunks.join(''), text)
})

test('换行优先于空格', () => {
  const text = 'aa\n bbb ccc' // 11 字节
  const chunks = chunkText(text, 6)
  assert.deepEqual(chunks, ['aa\n', ' bbb ', 'ccc'])
  assert.equal(chunks.join(''), text)
})

test('空格优先（无换行可用时）', () => {
  const chunks = chunkText('one two three four', 8)
  assert.deepEqual(chunks, ['one two ', 'three ', 'four'])
  assert.equal(chunks.join(''), 'one two three four')
})

test('硬切仅在预算内无任何分隔符可用时', () => {
  const chunks = chunkText('aaaa\nbbbb', 4)
  assert.deepEqual(chunks, ['aaaa', '\nbbb', 'b'])
  assert.equal(chunks.join(''), 'aaaa\nbbbb')
})

test('混合文本上界属性：每块 ≤ 预算且拼接恒等', () => {
  const text = '第一段\n\nSecond 段落 with 😀 emoji and 中文 mixed.\n\n结尾'
  const chunks = chunkText(text, 64)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(''), text)
  for (const c of chunks) assert.ok(Buffer.byteLength(c, 'utf8') <= 64)
})

test('退化输入（单图簇超预算）不死循环、不劈代理对、拼接恒等', () => {
  const chunks = chunkText('😀'.repeat(3), 2) // 每枚 4 字节 > 2
  assert.deepEqual(chunks, ['😀', '😀', '😀'])
  assert.equal(chunks.join(''), '😀'.repeat(3))
  assert.deepEqual(chunkText('abc', 1), ['a', 'b', 'c'])
})
