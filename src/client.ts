/** 浏览器 client bundle：在 superagent 引擎原生面板（127.0.0.1:3082）的「源设置」共享页壳
 *  里注册企业微信 tab（P-C'，契约 §1/§4）。react 从宿主模块表 require（零 npm 依赖）。
 *  页面 JS 有意不用模板字面量（与 bind-page 同纪律）。 */
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
}
const React = require('react') as ReactLike
// 「源设置」共享页壳（canonical vendored 副本）与企微 tab 内容
import { installSourcesSettingsPage } from './shell/shell.ts'
import { WecomSourcesTab } from './shell/tab.ts'

/** 本包版本（「关于」tab 更新检查用；发版时与 package.json 同步改）。 */
const LOCAL_VERSION = '0.1.1'

export const inject: string[] = ['slots', 'locale']

interface ShellCtx {
  effect(fn: () => (() => void) | void, label: string): void
  slots: {
    inject(key: string, factory: () => (() => void) | void): () => void
    register(spec: Record<string, unknown>, component: unknown): () => void
  }
}

export function apply(ctx: ShellCtx): void {
  ctx.effect(() => installSourcesSettingsPage(ctx, {
    kind: 'wecom',
    order: 30,
    label: '企微',
    apiBase: '/dsh-wecom/api',
    packageName: 'dsh-superagent-wecom',
    localVersion: LOCAL_VERSION,
    React,
    renderTab: () => React.createElement(WecomSourcesTab, null),
  }), 'dsh-superagent-wecom: sources settings shell')
}
