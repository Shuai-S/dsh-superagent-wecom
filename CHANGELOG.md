# Changelog

本项目所有显著改动记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- CI 工作流（`.github/workflows/ci.yml`）：push main 与 PR 触发，typecheck + build + test + 打包一致性校验全绿闸门，不发布任何产物。
- `scripts/verify-package.mjs`：零依赖打包一致性校验——files[] 全部存在、构建产物含 `sources.register(` 与 kind 名（不带引号子串探针）、cordis.patch.yml 挂载包名一致、双语 locale 顶层键集合一致、icon.svg 存在、`dsh.compatibility` 已声明。
- 出站文本分块（`src/chunk.ts`）：应用文本消息按官方上限 2048 字节（90236 实证）做 UTF-8 安全切分（优先段落空行 > 换行 > 空格 > 硬切，不劈代理对/组合字符），channel.send 逐块顺序发送；首块失败原样抛出交引擎干净重试，后续块失败记失败日志后按已送达收尾，防引擎整条重试造成重复投递。
- 入站消息去重（`src/dedup.ts`）：按 callbackPath 持久化已见消息 ID 环（`seen-<key>.json`，上限 1000 丢最旧），应答丢失重推不再重复进引擎；读损坏清空重来、每 key 只告警一次，同 key 串行 + tmp+rename 原子写。
- 发送失败留痕（`src/failure-log.ts`）：channel.send 传输失败追加 `send-failures.jsonl`（上限 200 行超限重写；条目仅含 {at, channelKey, kind, error≤300}，不含凭据与消息正文）；写日志失败不影响发送主流程。
- 健康上报计数：watch 健康上报 detail 追加紧凑内存计数（`in=/out=/fail=/last=<ISO>`，单行，进程重启清零）。
- 测试体系：`test/*.test.mjs`（node:test + node:assert，从构建产物导入，零网络，状态文件走临时目录）覆盖 crypto/callback/wecom-kind/chunk/dedup/failure-log 与回调去重、分块发送集成路径。
- `package.json` 声明 `dsh.compatibility`（dsh 0.2.2-rc.1 本地实测兼容）。

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
