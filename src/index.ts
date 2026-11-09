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
import { registerDeliverRoutes, type WebServerLike } from './deliver.ts'

export const name: string = 'dsh-superagent-wecom'
// webServer = 引擎面板 webserver（同源 /dsh-wecom/api 路由 seam，先例 wechat/dws 面板路由）。
export const inject: string[] = ['orchestrator', 'webServer']

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
  // 主动投递路由（契约 §2，P-B）：wecom 首次引入 webServer seam——seam 不在时
  // log 一次并跳过路由注册（不影响 Source 本体），注册异常同样吞掉不崩启动。
  const webServer = (ctx as unknown as { webServer?: WebServerLike }).webServer
  if (webServer) {
    try {
      ctx.effect(() => registerDeliverRoutes(webServer, { source: () => orchestrator.context(wecomKind) }), 'wecom: deliver routes')
    } catch (error) {
      console.error('[wecom] deliver routes unavailable (webServer seam failed): ' + String(error).slice(0, 200))
    }
  } else {
    console.error('[wecom] webServer seam absent; /dsh-wecom/api deliver routes skipped')
  }
}
export { wecomKind, WecomConfigSchema, buildWecomTrigger, buildWecomBotTrigger, wecomImageKeys, accountIdOf, botGroupRowId, channelConfig, bumpStat, statsDetail, wecomStats } from './wecom-kind.ts'
export { verifySignature, decrypt, encrypt, signatureOf } from './crypto.ts'
export { parseWecomXml, startCallbackServer } from './callback.ts'
export { chunkText, LIMIT } from './chunk.ts'
export { SEEN_LIMIT, sanitizeSegment, seenFile, seenOrAdd } from './dedup.ts'
export { FAILURE_ERROR_MAX, FAILURE_LOG_LIMIT, appendSendFailure, failureLogFile, setFailureLogBaseDirForTests } from './failure-log.ts'
export { validAccounts, validBots } from './watch.ts'
// ACL 访问模式（契约 §3，vendored tools/acl/acl.ts）与主动投递目标表/路由（契约 §2）
export { evaluateAcl, aclDenyNoticeText } from './acl.ts'
export type { AclDenyText, AclInput, AclPolicy, AclVerdict } from './acl.ts'
export { targetsFile, readTargets, writeTargets, findTarget, touchTarget, validTargetId, TARGET_ID_MAX, TARGET_ID_RE, TARGETS_VERSION, type TargetRecord, type TargetsFile } from './targets.ts'
export { ROUTE_PREFIX, buildDeliverTrigger, createDeliverHandler, deliverTestSend, registerDeliverRoutes, sameOrigin, type DeliverDeps, type WebServerLike } from './deliver.ts'
