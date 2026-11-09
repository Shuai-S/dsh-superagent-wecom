#!/usr/bin/env node
/**
 * Package sanity gate (zero-dependency, node:fs/promises only) — the last CI
 * step. Verifies that what tsdown built is exactly what package.json promises
 * to ship:
 *   1. every files[] entry exists on disk
 *   2. lib/index.js still contains the engine seam 'sources.register(' and
 *      the kind name — probed as UNQUOTED substrings on purpose, so a bundler
 *      or tsc quote-style change can never cause a false negative
 *   3. cordis.patch.yml mounts exactly this package name (- id:)
 *   4. locale/zh.json and locale/en.json both parse and share the same
 *      top-level key set
 *   5. icon.svg exists
 *   6. package.json declares dsh.compatibility
 * Failures are listed one per line and the script exits 1; success prints
 * "verify-package: OK".
 *
 * 打包一致性闸门（零依赖，仅 node:fs/promises）——CI 最后一步。校验构建产物
 * 与打包声明一致：files[] 全部存在；lib/index.js 含引擎注册 seam
 * 'sources.register(' 与 kind 名（探针用不带引号子串，防 tsc/打包器引号风格
 * 假阴性）；cordis.patch.yml 挂载包名一致；双语 locale 可解析且顶层键集合
 * 一致；icon.svg 存在；package.json 含 dsh.compatibility。失败逐条列明
 * exit 1，通过打印 verify-package: OK。
 */
import { access, readFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const rel = (p) => root + p

const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(name + (detail ? ' — ' + detail : ''))
}
const exists = async (p) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

let pkg
try {
  pkg = JSON.parse(await readFile(rel('package.json'), 'utf8'))
} catch (error) {
  console.error('verify-package: FAIL — package.json unreadable (' + String(error).slice(0, 200) + ')')
  process.exit(1)
}

// 1. files[] 全部存在
for (const entry of pkg.files ?? []) {
  check('files: ' + entry, await exists(rel(entry)), 'declared in package.json but missing on disk')
}

// 2. 构建产物探针（不带引号子串）
const KIND = 'wecom'
let lib = ''
try {
  lib = await readFile(rel('lib/index.js'), 'utf8')
} catch {
  failures.push('lib/index.js — not readable (build first: pnpm check)')
}
if (lib) {
  check("lib/index.js contains 'sources.register('", lib.includes('sources.register('), 'the orchestrator registration seam is missing from the build')
  check("lib/index.js contains kind name '" + KIND + "'", lib.includes(KIND), 'the kind name is missing from the build')
}

// 3. cordis.patch.yml 挂载包名一致
const patch = await readFile(rel('cordis.patch.yml'), 'utf8').catch(() => '')
const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((m) => String(m[1]).replace(/^['"]|['"]$/g, ''))
check('cordis.patch.yml - id matches package name', ids.includes(pkg.name), 'found: ' + JSON.stringify(ids))

// 4. 双语 locale 可解析且顶层 key 集合一致
const parseJson = async (p) => {
  try {
    return JSON.parse(await readFile(rel(p), 'utf8'))
  } catch {
    return undefined
  }
}
const zh = await parseJson('locale/zh.json')
const en = await parseJson('locale/en.json')
check('locale/zh.json parses', zh !== undefined)
check('locale/en.json parses', en !== undefined)
if (zh !== undefined && en !== undefined) {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  check('locale top-level key sets match', JSON.stringify(zhKeys) === JSON.stringify(enKeys), 'zh=' + JSON.stringify(zhKeys) + ' en=' + JSON.stringify(enKeys))
}

// 5. icon.svg 存在
check('icon.svg exists', await exists(rel('icon.svg')))

// 6. package.json 含 dsh.compatibility（语义=本地实测验证过的兼容声明，非硬闸门）
const compat = pkg.dsh?.compatibility
check(
  'package.json declares dsh.compatibility',
  !!compat && typeof compat === 'object' && typeof compat.dsh === 'string' && !!compat.dshReleases && typeof compat.dshReleases === 'object',
)

if (failures.length > 0) {
  console.error('verify-package: FAIL (' + failures.length + ')')
  for (const [i, failure] of failures.entries()) console.error('  ' + (i + 1) + '. ' + failure)
  process.exit(1)
}
console.log('verify-package: OK')
