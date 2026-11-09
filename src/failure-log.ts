/** Send-failure trail for channel.send: every transport failure is appended
 *  to ~/.local/state/dsh-superagent-wecom/send-failures.jsonl as one JSONL
 *  object {at, channelKey, kind, error≤300} — never tokens, secrets or
 *  message bodies (channelKey is the admission row id, kind is the Outbox
 *  message kind). The file is capped at FAILURE_LOG_LIMIT lines; appending
 *  beyond the cap rewrites it keeping the newest. Writes are serialized
 *  (module-level queue) and atomic (tmp+rename); a failed append only logs
 *  to stderr — it never throws into the send path.
 *  发送失败留痕：channel.send 传输层失败逐条追加 JSONL（{at, channelKey,
 *  kind, error≤300}，绝不含凭据与消息正文）。上限 200 行，超限重写保留最新；
 *  模块级队列串行 + tmp+rename 原子写；写日志失败只打 stderr，不影响主流程。 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 单文件滚动上限：超限重写保留最新 FAILURE_LOG_LIMIT 行。 */
export const FAILURE_LOG_LIMIT = 200
/** 单条 error 字段截断长度。 */
export const FAILURE_ERROR_MAX = 300

export interface SendFailureEntry { at: string; channelKey: string; kind: string; error: string }

// 测试专用重定向：channel.send 的接线不传 baseDir，测试经此改道到临时目录。
let baseDirOverride: string | undefined

/** 测试专用：重定向状态目录；传 undefined 恢复默认。生产代码勿调用。 */
export function setFailureLogBaseDirForTests(dir: string | undefined): void {
  baseDirOverride = dir
}

function stateBase(baseDir?: string): string {
  return baseDir ?? baseDirOverride ?? join(homedir(), '.local', 'state', 'dsh-superagent-wecom')
}

export function failureLogFile(baseDir?: string): string {
  return join(stateBase(baseDir), 'send-failures.jsonl')
}

function dirnameSafe(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : '.'
}

async function appendLocked(entry: SendFailureEntry, path: string): Promise<void> {
  let lines: string[] = []
  try {
    lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim())
  } catch { /* 首条：文件尚不存在 */ }
  lines.push(JSON.stringify(entry))
  if (lines.length > FAILURE_LOG_LIMIT) lines = lines.slice(lines.length - FAILURE_LOG_LIMIT)
  await mkdir(dirnameSafe(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600 })
  await rename(tmp, path)
}

// 单文件追加串行化：并发 send 失败不互相踩同一 tmp 文件。
let tail: Promise<unknown> = Promise.resolve()

/** 追加一条发送失败（串行 + 原子重写；任何错误只打 stderr，绝不抛出）。 */
export async function appendSendFailure(entry: { channelKey: string; kind: string; error: string }, baseDir?: string): Promise<void> {
  const record: SendFailureEntry = {
    at: new Date().toISOString(),
    channelKey: String(entry.channelKey ?? ''),
    kind: String(entry.kind ?? ''),
    error: String(entry.error ?? '').slice(0, FAILURE_ERROR_MAX),
  }
  const path = failureLogFile(baseDir)
  const run = tail.then(() => appendLocked(record, path))
  tail = run.then(() => undefined, () => undefined)
  try {
    await run
  } catch (error) {
    console.error('[wecom] failure-log: append failed (' + String(error).slice(0, 200) + ')')
  }
}
