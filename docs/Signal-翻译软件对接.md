# Signal Desktop 翻译软件对接

> **2026-11-21 架构调整：本文的“超管全局 Token + 全局计费商户”方案已废弃。**
>
> 正式产品改为 Signal 独立客户端：每个用户在自己的客户端里登录 Hello Pix
> 主账号或子账号，翻译扣自己的字符余额，设备绑定继续使用 `X-Pix-Device`。
> 旧接口仅为兼容存量代码保留，默认关闭；后台菜单与前端入口已移除。

## 接口

- `POST /apis/v1/translate`
  - `Authorization: Bearer $PIX_SIGNAL_API_TOKEN`
  - `Idempotency-Key` 必填
  - 响应遵循交接包中的 OpenAPI 翻译合同。
- `POST /apis/integrations/signal/workorder-events`
  - `Authorization: Bearer $PIX_SIGNAL_EVENT_TOKEN`
  - 只接受 `translation.completed` 脱敏事件。

两个 Token 都只在服务端环境变量中读取，不进入浏览器、响应或日志。

## 环境变量

推荐在超管后台「系统 → Signal 对接」里直接选择计费商户、翻译通道和工单策略，
并由系统生成/轮换两个 Token。数据库只存 Token 哈希，完整 Token 只显示一次。

环境变量仅作为应急回退：

```text
PIX_SIGNAL_API_TOKEN
PIX_SIGNAL_EVENT_TOKEN
PIX_SIGNAL_ACCOUNT_USERNAME
PIX_SIGNAL_TRANSLATE_ENGINE
PIX_SIGNAL_WORKORDER_MODE=failures
```

`PIX_SIGNAL_ACCOUNT_USERNAME` 映射到一个现有商户账号。该账号的套餐、
余额和当前翻译通道继续按原规则生效；对接接口不会绕过计费。

OpenAPI 允许请求体最长 12000 字符；当前文本翻译账本仍执行既有的单次
5000 字符上限。超过 5000 会返回稳定的 `text-too-long`，不会静默截断或扣费。

`PIX_SIGNAL_WORKORDER_MODE`：

- `failures`：默认，只有 `status=error` 的翻译事件自动建工单。
- `all`：每个唯一翻译事件都建工单。
- `ledger`：只记录事件，不建工单。

超管保存数据库配置后，以数据库配置为准；环境变量不再覆盖它。

## curl

```bash
curl -fsS https://pixfanyi.com/apis/v1/translate \
  -H "Authorization: Bearer $PIX_SIGNAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: signal-message-1" \
  -d '{
    "messageId": "signal-message-1",
    "sourceLanguage": "auto",
    "targetLanguage": "zh-CN",
    "text": "Please rotate the signing key before the next release."
  }'
```

```json
{
  "translation": "请在下次发布前轮换签名密钥。",
  "targetLanguage": "zh-CN",
  "detectedSourceLanguage": "en",
  "skipped": false,
  "providerRequestId": "signal-message-1",
  "model": "deepseek-chat"
}
```

事件 Webhook：

```bash
curl -fsS https://pixfanyi.com/apis/integrations/signal/workorder-events \
  -H "Authorization: Bearer $PIX_SIGNAL_EVENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d @workorder-event.json
```

## 工单映射

| 工单字段 | 来源 |
| --- | --- |
| 商户 | `PIX_SIGNAL_ACCOUNT_USERNAME` 映射账号 |
| 标题 | 失败时 `Signal 翻译失败 · <reason>` |
| 分类 | `translation` |
| 优先级 | 失败 `medium`，成功模式 `low` |
| 系统消息 | eventId / messageId / provider / model / status / reason / 长度 / 耗时 |
| 幂等键 | `eventId` |

原文、译文、联系人信息、电话号码、API Token 和 HMAC Key 不会写入工单。

## Signal 侧配置

```text
SIGNAL_TRANSLATION_ENABLED=1
SIGNAL_TRANSLATION_PROVIDER=translation-software
SIGNAL_TRANSLATION_ENDPOINT=https://pixfanyi.com/apis
SIGNAL_TRANSLATION_MODEL=server-managed
SIGNAL_TRANSLATION_API_KEY=$PIX_SIGNAL_API_TOKEN
SIGNAL_TRANSLATION_ALLOW_REMOTE=1
SIGNAL_TRANSLATION_EVENT_WEBHOOK=https://pixfanyi.com/apis/integrations/signal/workorder-events
SIGNAL_TRANSLATION_EVENT_TOKEN=$PIX_SIGNAL_EVENT_TOKEN
SIGNAL_TRANSLATION_EVENT_ALLOW_REMOTE=1
```

Signal 侧已增加 `TranslationSoftwareProvider`，provider 选择
`translation-software` 后会调用 `/apis/v1/translate`。不需要再改消息渲染、
Signal Protocol、libsignal 或数据库结构。

## 隐私边界

- 翻译请求必然会把解密后的单条消息正文发送到本服务及其配置的上游翻译通道。
- 事件 Webhook 不包含原文和译文。
- 生产日志只记录引擎、长度、耗时和结果，不记录正文。
- 本功能不能部署在把 `PIX_SIGNAL_API_TOKEN` 写进前端 bundle 的环境。
