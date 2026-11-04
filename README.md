# dsh-superagent-wecom

企业微信直连 Source 插件：自建应用「回调模式」实时接收应用单聊消息（验签/解密后立即应答），
走 superagent 引擎标准 准入→评估→Ticket→执行 链路，回复经企业微信 OpenAPI 直接回企业微信。

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
- 多账号共用一个 HTTP server，按路径 `/callback/<callbackPath>` 区分

## 风险与限制

- **可信 IP（errcode 60020）**：自建应用调用发消息 API 要求配置「企业可信IP」（应用详情 →
  开发者接口 → 企业可信IP）。家宽动态 IP 断续变化时需重新备案；未配置时发送失败，health
  会提示「检查应用可信IP配置」。
- **签名+密文协议**：企业微信回调不存在公众号那种明文/兼容/安全三模式——消息恒为 AES 加密
  XML + msg_signature 验签（官方 90930），解密时 receiveid 须等于 corpid；Token 与
  EncodingAESKey 任一缺失都无法保存配置。
- **MsgId 去重**：触发器 id = `wecom:<MsgId>`，企业微信重推同一条消息不会重复建票。
- **事件消息**：v1 忽略无 MsgId 的事件（subscribe 等），只处理消息类；图片/语音等非 text 消息以
  `[wecom-image]` 占位，PicUrl/MediaId 存于 trigger meta（M2 消化）。
- **凭据**：corpid/secret/Token/EncodingAESKey 明文存于引擎本地配置（sqlite，仅本机可读）。

## 自测

```sh
node scripts/probe.mjs
```

无需真实企业微信凭证：直接 import src 真实模块（Node >= 22.18 内建 TS type stripping），
本地起回调 server 验证 验签 → 解密 → XML 解析 → Trigger 映射 → GET/POST 全链路。
