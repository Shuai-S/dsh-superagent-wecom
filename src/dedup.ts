/** Inbound message-ID dedup ring. WeCom re-pushes a callback when the 200
 *  answer is lost, so every accepted message id is remembered per route and
 *  duplicates are dropped before they ever reach the engine pipeline. State
 *  follows the wechat Source convention: ~/.local/state/<pkg>/, one
 *  'seen-<key>.json' per storeKey (the route's callbackPath), shape
 *  {version:1,ids:[]}, capped at SEEN_LIMIT ids with the oldest dropped
 *  (routine behaviour, not logged per drop). Reads never fatal: a corrupt
 *  file restarts empty and warns once per key; check-and-add runs serialized
 *  per storeKey and lands via tmp+rename so a crash never leaves a partial
 *  file. seenOrAdd never throws — dedup degrades open (message flows) on
 *  storage errors.
 *  入站消息 ID 去重环：企业微信在应答丢失时会重推同一回调，这里按路由
 *  （storeKey=callbackPath）持久化已见 ID（{version:1,ids:[]}，上限 1000 丢
 *  最旧），重复消息在进入引擎前丢弃。读损坏按空重来且每 key 只告警一次；
 *  同 key 读-判-写串行 + tmp+rename 原子写；任何存储错误都降级放行（不抛出）。 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 滚动上限：超限丢最旧（常态行为，不逐条刷日志）。 */
export const SEEN_LIMIT = 1000

export interface SeenFile { version: 1; ids: string[] }

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-wecom')
}

/** 文件名/目录段净化：只留安全字符，截 80 位（同 wechat 仓 util.ts 约定），
 *  防 callbackPath 携带路径分隔符越级。 */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown'
}

/** 去重环文件：seen-<key>.json（key 已净化）。 */
export function seenFile(storeKey: string, baseDir?: string): string {
  return join(stateBase(baseDir), 'seen-' + sanitizeSegment(storeKey) + '.json')
}

function dirnameSafe(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : '.'
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirnameSafe(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, path)
}

const warnedReads = new Set<string>()

/** 读环（不抛出）：文件缺失=首次使用静默按空；损坏/不可读=清空重来，每 key 只 log 一次。 */
async function readIds(path: string, storeKey: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SeenFile> | null
    const ids = parsed?.ids
    if (!Array.isArray(ids)) throw new Error('unexpected shape')
    return ids.filter((x): x is string => typeof x === 'string')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return []
    if (!warnedReads.has(storeKey)) {
      warnedReads.add(storeKey)
      console.error('[wecom] dedup: unreadable seen file for ' + storeKey + ', restarting empty (' + String(error).slice(0, 200) + ')')
    }
    return []
  }
}

// 同一文件的读-判-写必须串行：并发回调可能双双判「未见过」而重复派发。
const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev.then(task, task)
  queues.set(key, run.then(() => undefined, () => undefined))
  return run
}

/** 已见过返回 true；首见则记入环并持久化（写失败只 log，仍按首见放行）。
 *  空 id 恒 false 且不入环（无 MsgId 的事件直接放行、由下游过滤）。 */
export async function seenOrAdd(storeKey: string, id: string, baseDir?: string): Promise<boolean> {
  if (!id) return false
  const path = seenFile(storeKey, baseDir)
  return enqueue('seen:' + path, async () => {
    const ids = await readIds(path, storeKey)
    if (ids.includes(id)) return true
    ids.push(id)
    while (ids.length > SEEN_LIMIT) ids.shift()
    try {
      await writeAtomic(path, JSON.stringify({ version: 1, ids } satisfies SeenFile))
    } catch (error) {
      console.error('[wecom] dedup: write failed for ' + storeKey + ' (' + String(error).slice(0, 200) + ')')
    }
    return false
  })
}
