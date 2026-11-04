# dsh-superagent-wecom

企业微信直连 Source 插件：自建应用「回调模式」实时接收应用单聊消息（验签/解密后立即应答），
智能机器人群聊 @ 机器人收群消息；走 superagent 引擎标准 准入→评估→Ticket→执行 链路，
应用回复经企业微信 OpenAPI 直接回企业微信。

## 安装（superagent profile）

```sh
pnpm install && pnpm check
dsh plugin --profile superagent add "link:$PWD"
scripts/dsh-superagent restart   # 在 dsh-superagent-prototype 内
```

## 前置：公网回调 URL

企业微信回调没有钉钉 Stream 那样的长连接等价物——企业微信服务器要主动 POST 到你的公网 URL。
本机/内网部署用 frp 隧道暴露（示例见下文），插件默认监听 `0.0.0.0:3090`。

## 注册步骤（企业微信后台）

1. 管理后台（work.weixin.qq.com）→ 应用管理 → 创建自建应用，记下 AgentId 与 Secret；「我的企业 → 企业信息」页记下企业 ID（corpid）
2. 应用详情 → 功能 → 接收消息 → 设置 API 接收：
   - URL：`https://<隧道域名>/callback/<callbackPath>`（回调路径与插件 accounts 里填的一致）
   - Token 与 EncodingAESKey：按页面生成并填进插件 accounts——企业微信回调恒为
     签名+密文（官方文档 90930），两者必填，EncodingAESKey 恒为 43 字符
3. 保存时企业微信会立即做 GET URL 验证——先完成安装并启用插件（回调 server 已监听），否则验证不通过
4. 成员在应用单聊里给机器人发第一条消息时，日志会打印 `FromUserName=...`，把它加进 Policy 白名单（允许派活的成员）才能派活

## 配置项（面板 Settings → 来源 → 企业微信）

- **accounts**（企业微信自建应用，逐列）：
  - `name`：仅用于面板显示
  - `corpid`：企业 ID（后台 → 我的企业 → 企业信息）
  - `secret`：应用 Secret（自建应用详情页）
  - `agentid`：AgentId（发消息必带）
  - `token`：接收消息服务器配置里设置的 Token，两边须一致
  - `encodingAESKey`：必填，恒为 43 字符（回调配置页生成）；回调消息恒为签名+密文
  - `callbackPath`：回调 URL 为 `https://<域名>/callback/<回调路径>`，多账号须互不相同
- **bots**（智能机器人，逐列）：
  - `name`：仅用于面板显示
  - `token`：智能机器人回调配置里设置的 Token，两边须一致
  - `encodingAESKey`：必填，恒为 43 字符（回调配置页生成）；机器人图片/文件 URL 下载后也用它解密
  - `callbackPath`：与 accounts 及其他 bots 互不相同
- **callbackPort**（advanced）：回调 server 监听端口，默认 3090
- **bindAddress**（advanced）：监听地址，默认 `0.0.0.0`
- **sendAck**：自动回「已收到」——收到消息先回一条接单回执，终答随后送达

## frp 隧道示例

frpc.ini（frps 侧有公网 IP，域名证书可用 frps 终结或前置 nginx）：

```ini
[wecom-callback]
type = https
local_ip = 127.0.0.1
local_port = 3090
custom_domains = wecom.example.com
```

无证书时可 `type = http` + `remote_port = 80`，或在前置层终结 TLS 后转发到 3090
（企业微信要求 80/443 端口且证书可信）。

## 回调协议与 5 秒铁律

- **GET URL 验证**：验签（msg_signature）后解密 `echostr` 并原样返回明文
- **POST 消息**：企业微信回调恒为签名+密文（官方 90930）：先验签再解密得消息 XML，不存在明文模式
- 收到 POST 立即回 `200 'success'`，引擎链路异步执行；业务失败只记日志，重试归引擎 Outbox
- accounts 与智能机器人共用一个 HTTP server，按路径 `/callback/<callbackPath>` 区分

## 智能机器人（群聊接收）

契约事实实读自官方文档（2026-11-04）：

- 接收消息：<https://developer.work.weixin.qq.com/document/path/101045>
- 接收事件：<https://developer.work.weixin.qq.com/document/path/101046>
- 回调和回复的加解密方案：<https://developer.work.weixin.qq.com/document/path/101034>
- 主动回复消息：<https://developer.work.weixin.qq.com/document/path/101138>

与自建应用回调的差异：

- **协议形态是 JSON 不是 XML**：POST body 为 `{"encrypt": "..."}`，解密 encrypt 字段得明文
  JSON（msgid / aibotid / chatid / chattype / from.userid / response_url / msgtype / text|image|mixed…）
- **解密 receiveid 传空字符串**（企业内部智能机器人，官方 101034），不是 corpid；AES 方案本身与
  自建应用相同（AES-256-CBC、PKCS#7 至 32 字节、IV=Key 前 16 字节）；GET URL 验证同构
- **群聊仅 @ 触发**：群里发 text/mixed（图文混排）/引用消息需 @ 机器人；图片/语音/文件/视频
  仅单聊推送（v2 只接群聊，机器人单聊 M3 处理）；msgtype 为 event/stream 的回调不建票
- **机器人图片 URL 下载后是 AES 加密的**（官方 101045）：image.url 五分钟内有效，下载字节用回调
  同款 EncodingAESKey 解密（decryptBytes）后才是图片
- **response_url 一次性且 1 小时有效**（官方 101138）：群聊主动回复走该 URL（M3 接线），重复调用
  会失败；引擎 ack 在 M3 前静默跳过，不入重试队列

## 风险与限制

- **可信 IP（errcode 60020）**：自建应用调用发消息 API 要求配置「企业可信IP」（应用详情 →
  开发者接口 → 企业可信IP）。家宽动态 IP 断续变化时需重新备案；未配置时发送失败，health
  会提示「检查应用可信IP配置」。
- **签名+密文协议**：企业微信回调不存在公众号那种明文/兼容/安全三模式——消息恒为 AES 加密
  XML + msg_signature 验签（官方 90930），解密时 receiveid 须等于 corpid；Token 与
  EncodingAESKey 任一缺失都无法保存配置。
- **MsgId 去重**：触发器 id = `wecom:<MsgId>`（应用与机器人共用 `wecom:` 前缀），企业微信重推同
  一条消息不会重复建票。
- **图片接线**：应用单聊图片以 `[wecom-image:PicUrl|MediaId]` 标记进触发文本——PicUrl 免鉴权直取，
  失败降级 MediaId（media/get + access_token）；机器人图片见上节。语音/文件/视频仍以
  `[wecom-<type>]` 占位（媒体落盘注入留 spike，真机形态待核对）。
- **凭据**：corpid/secret/Token/EncodingAESKey 明文存于引擎本地配置（sqlite，仅本机可读）。

## 自测

```sh
node scripts/probe.mjs
```

无需真实企业微信凭证：直接 import src 真实模块（Node >= 22.18 内建 TS type stripping），
本地起回调 server 验证 验签 → 解密 → XML/JSON 解析 → Trigger 映射 → GET/POST 全链路，
覆盖应用单聊（XML）与智能机器人群聊（JSON）双协议、图片标记/提取、坏 PicUrl 负例
（stub fetch）与机器人加密图片解密。
