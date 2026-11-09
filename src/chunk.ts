/** UTF-8-safe text chunking for WeCom sends. The app text-message content is
 *  capped at 2048 bytes by the official 发送应用消息 contract (doc 90236:
 *  "content 是 消息内容，最长不超过2048个字节，超过将截断（支持id转译）",
 *  read 2026-11-09), so long replies are split into ordered chunks before
 *  sendAppMessage. Cut-point preference: paragraph break (\n\n) > line break
 *  (\n) > space > hard cut; a cut never splits a surrogate pair or a
 *  combining mark (the byte-budget walk goes over grapheme clusters via
 *  Intl.Segmenter), and join(chunks) === text always holds. Degenerate input
 *  (one grapheme bigger than the budget, e.g. a huge zalgo run) falls back to
 *  whole code points and always makes progress.
 *  WeCom 应用文本消息上限 2048 字节（官方 90236 原文实证，2026-11-09 读取）。
 *  切点优先级：段落空行 > 换行 > 空格 > 硬切；字节预算按图簇（Intl.Segmenter）
 *  累计，切点永不劈代理对/组合字符；分块拼接恒等于原文。退化输入（单图簇超
 *  预算）退为按整 code point 切并保证恒有前进。 */
export const LIMIT = 2048

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })

/** One split decision: the code-unit index where rest may be cut. */
function cutIndex(rest: string, maxBytes: number): number {
  // 1) 图簇按字节预算走：图簇边界天然不劈代理对与「基字符+组合符号」。
  const boundaries = new Set<number>()
  let bytes = 0
  let hard = 0
  for (const seg of graphemes.segment(rest)) {
    const len = Buffer.byteLength(seg.segment, 'utf8')
    if (bytes + len > maxBytes) break
    bytes += len
    hard = seg.index + seg.segment.length
    boundaries.add(hard)
  }
  if (hard > 0) {
    // 2) 预算内优先段落 > 换行 > 空格；候选切点必须落在图簇边界上
    //    （分隔符后紧跟组合符号时弃用该候选），p>0 避免切出纯分隔符块。
    const head = rest.slice(0, hard)
    for (const sep of ['\n\n', '\n', ' '] as const) {
      const p = head.lastIndexOf(sep)
      const cut = p + sep.length
      if (p > 0 && boundaries.has(cut)) return cut
    }
    return hard
  }
  // 3) 退化：首个图簇就超预算（巨量组合符号或 maxBytes<4）。退为按整
  //    code point 切（仍不劈代理对），首个 code point 无条件收下保证前进。
  for (const ch of rest) {
    const len = Buffer.byteLength(ch, 'utf8')
    if (bytes + len > maxBytes && hard > 0) break
    bytes += len
    hard += ch.length
  }
  return hard
}

/** Split text into chunks of at most maxBytes UTF-8 bytes. Text that fits
 *  returns as a single block ('' → [''], keeping the current send-path
 *  behaviour for empty text). join(chunks) === text always.
 *  切分为 ≤maxBytes 字节的块；放得下返回单块（'' → ['']，空文本保持既有
 *  发送行为）；拼接恒等于原文。 */
export function chunkText(text: string, maxBytes: number = LIMIT): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('wecom chunk: maxBytes must be a positive integer')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text]
  const chunks: string[] = []
  let rest = text
  while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
    const cut = cutIndex(rest, maxBytes)
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}
