# Changelog

本项目所有显著改动记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- P-C'（契约 §1/§4）：「源设置」共享页壳接入——vendored shell + src/shell/tab.ts（健康卡/投递目标 CRUD/deliver 测试）+ src/client.ts 新 client bundle 入口（esbuild --bundle devDep 豁免；react 宿主 require）；targets CRUD 路由（GET/PUT /targets、DELETE /targets/<id）+ targets.ts 增 upsert/remove；投递 actor id 统一为 dsh-superagent-wecom（引擎配置前提同步：policy.sources.wecom.bots 改列该 id）

### Added
- CI 工作流（`.github/workflows/ci.yml`）：push main 与 PR 触发，typecheck + build + test + 打包一致性校验全绿闸门，不发布任何产物。
- `scripts/verify-package.mjs`：零依赖打包一致性校验——files[] 全部存在、构建产物含 `sources.register(` 与 kind 名（不带引号子串探针）、cordis.patch.yml 挂载包名一致、双语 locale 顶层键集合一致、icon.svg 存在、`dsh.compatibility` 已声明。
- 出站文本分块（`src/chunk.ts`）：应用文本消息按官方上限 2048 字节（90236 实证）做 UTF-8 安全切分（优先段落空行 > 换行 > 空格 > 硬切，不劈代理对/组合字符），channel.send 逐块顺序发送；首块失败原样抛出交引擎干净重试，后续块失败记失败日志后按已送达收尾，防引擎整条重试造成重复投递。
- 入站消息去重（`src/dedup.ts`）：按 callbackPath 持久化已见消息 ID 环（`seen-<key>.json`，上限 1000 丢最旧），应答丢失重推不再重复进引擎；读损坏清空重来、每 key 只告警一次，同 key 串行 + tmp+rename 原子写。
- 发送失败留痕（`src/failure-log.ts`）：channel.send 传输失败追加 `send-failures.jsonl`（上限 200 行超限重写；条目仅含 {at, channelKey, kind, error≤300}，不含凭据与消息正文）；写日志失败不影响发送主流程。
- 健康上报计数：watch 健康上报 detail 追加紧凑内存计数（`in=/out=/fail=/last=<ISO>`，单行，进程重启清零）。
- 测试体系：`test/*.test.mjs`（node:test + node:assert，从构建产物导入，零网络，状态文件走临时目录）覆盖 crypto/callback/wecom-kind/chunk/dedup/failure-log 与回调去重、分块发送集成路径。
- `package.json` 声明 `dsh.compatibility`（dsh 0.2.2-rc.1 本地实测兼容）。
- ACL 访问模式（契约 docs/rpc-contract.md §3）：配置增可选 `policy`（`{mode:'allowlist'|'open', allowUsers, groupOnly?, denyText?:{zh,en}}`；不设 = 全放行向后兼容，形状非法按 schema 拒绝不做静默降级）；vendored `tools/acl/acl.ts` → `src/acl.ts`（纯函数判定，零 npm 依赖）；判定在派发（source.receive）之前：应用账号消息（单聊）拒绝经 sendAppMessage 回执 denyText（凭据从 config holder 解析），智能机器人群消息无回执路径（response_url 属 M3）仅 deny 计数 + log 注明；回执失败只记 stderr 不入 failure-log（ACL 拒绝不是发送失败）；健康计数 detail 增 `deny=`。
- 主动投递（契约 §2，P-B）：inject 增 `webServer`（wecom 首次引入；seam 不在时 log 一次并跳过路由注册，不崩启动）；路由前缀 `/dsh-wecom/api`——`POST /deliver`（`{targetId,text,kind?}` 构造非人类 Trigger（`human:false`、`meta.deliver:true`、`addressed:'direct'`、actor=`deliver`）交 `source.receive()`；400/404/409/受理语义按契约）、`POST /deliver/test`（不经引擎直调 sendAppMessage 发双语测试文案，返回 `{ok,sent,detail}`；chatid 目标的群回复依赖一次性 response_url（官方 101138），M3 前明确返回不可测）、`GET /health`（状态 + in/out/fail/deny 计数 + 最近 20 条 failure-log + dedup 水位）；目标表 `~/.local/state/dsh-superagent-wecom/targets.json`（targetId 1–128 字符 `[A-Za-z0-9._@:-]`，tmp+rename 原子写；目标管理 UI 属 P-C'）。
- 主动投递引擎侧配置前提（实读引擎 src/policy.ts machineGate / src/sources/registry.ts，2026-11-09，引擎升级后需复核）：非人类 Trigger 过引擎 machineGate——settings 里 `policy.sources.wecom.bots` 需列出投递 actor（本包恒为 `{ "id": "deliver" }`）且 `eval.mode ≠ "off"`，否则以 `not_human` 被静默忽略（auto 模式下 inferred 候选才转工单）；本包 deliver trigger 恒带 `addressed:'direct'`（machineGate 的 addressed 门）且 meta 带齐 wecom kind `scope()` 判 listened 所需字段（accountId / botId+chatid）。
- 测试：`test/acl.test.mjs`（判定纯函数：缺省放行 / 命中 / 未命中 / 大小写敏感 / groupOnly 兜底 / 拒绝回执文案）与 `test/deliver.test.mjs`（targets 读写 / 原子写 / targetId 校验 / 400 / 404 / 409 / 受理 trigger 形状断言 / deliver:test 发送桩 / health 水位 / sameOrigin 403，零网络）。
- verify-package.mjs 增路由契约探针：lib/index.js 含 `/dsh-wecom/api` 前缀串与 `/deliver` 字面量（防路由名漂移）；client bundle 探针 N/A（本包无 client bundle，「源设置」页壳属 P-C'）。

## [0.1.1] - 2026-11-06

### Added
- 插件市场官方形式元数据：双语 title/description、hero 插画与 icon、`meta.detail` 详情页文档、files 白名单。
- 发布工作流（tag 触发 npm 发布 + GitHub Release tarball）与 prepare 脚本（pack/publish 产出 lib/）。

### Changed
- README 重写：移除里程碑术语与自测节，协议依据改为通用表述。

## [0.1.0] - 2026-11-04

### Added
- 企业微信 Source 首版：自建应用回调模式接收（签名校验 + AES-256-CBC 解密，5 秒内应答），回复经 OpenAPI 主动发送。
- 智能机器人群聊接收（JSON 回调，官方 101034/101045）与图片接线（PicUrl / MediaId / 机器人加密媒体 URL 解密）。
