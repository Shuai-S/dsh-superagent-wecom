/**
 * dsh-superagent-wecom — WeCom (企业微信) Source for dsh-superagent.
 *
 * Registers the 'wecom' Source kind through the same extension seam the
 * bundled watchers use (inject 'orchestrator'), keeps a callback HTTP server
 * alive (回调模式; verifies, decrypts and answers within the 5s window), and
 * sends replies through the WeCom OpenAPI.
 *
 * @module dsh-superagent-wecom
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OrchestratorLike } from './types.ts'
import { wecomKind, HEALTH_ENTRY } from './wecom-kind.ts'
import { watch } from './watch.ts'

export const name: string = 'dsh-superagent-wecom'
export const inject: string[] = ['orchestrator']

export function apply(ctx: Context): void {
  const orchestrator = (ctx as unknown as { orchestrator: OrchestratorLike }).orchestrator
  ctx.effect(() => orchestrator.sources.register(wecomKind), 'wecom: source kind')
  ctx.effect(() => {
    const source = orchestrator.context(wecomKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error).slice(0, 300) })
    })
    return async () => { controller.abort(); await running }
  })
}
export { wecomKind, WecomConfigSchema, buildWecomTrigger } from './wecom-kind.ts'
export { verifySignature, decrypt, encrypt, signatureOf } from './crypto.ts'
export { parseWecomXml } from './callback.ts'
