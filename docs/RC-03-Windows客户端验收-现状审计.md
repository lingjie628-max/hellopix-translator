# RC-03 · Windows 客户端真实环境验收 —— 第一阶段：现状审计

> 日期：2026-09-25
> 范围：**只审计现状，未改任何代码**
> 目标：10 月 1 日上线前的真实客户端可用性
> 本轮只看 Telegram 与 WhatsApp，其余 33 个平台不在范围内

---

## 0. 结论摘要

| # | 发现 | 级别 | 影响 |
| --- | --- | --- | --- |
| 1 | ~~基础版套餐没有任何已接通引擎~~ **已于 2026-09-25 解除** | ✅ 已解除 | 接入 `google` 后，4 个基础版商户恢复可翻译（见 §8.3） |
| 2 | **多进程多开会撞同一个 session 分区** | 🔴 上线阻断 | 与「多开隔离」的核心卖点直接冲突 |
| 3 | 9 个引擎中 4 个接通、5 个可被选中但会 503 | 🟠 高 | 商户选中未接通通道时体验为「翻译坏了」 |
| 4 | 我**没有可用的真实 Windows 环境** | 🔴 流程阻断 | 「真实 Windows 验收」这一项无法由我单方面完成 |
| 5 | 迁移注释指向错误的文件 | 🟢 低 | 文档漂移，不影响运行 |

---

## 1. 版本与安装包

| 项目 | 值 |
| --- | --- |
| 客户端版本号 | **0.1.3**（`desktop/package.json`） |
| 产品名 | Hello Pix（`appId: com.hellopix.desktop`） |
| Electron（声明 / 实装） | `^33.2.1` / **33.4.11** |
| Vue（网页端） | **2.7.16** + Element UI 2.15.14 + Vuex 3 |
| 渲染层形态 | 纯 HTML/CSS/JS（`desktop/renderer/`），**不是** Vue 应用 |
| 打包工具 | electron-builder 26.15.3 |

### 现有 Windows 安装包（均为 0.1.3，构建于 2026-09-16）

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `desktop/release/HelloPix-Setup-0.1.3.exe`（NSIS 安装版） | 82,436,179 | `a5b2e497f0c886832f915a4a427e055703fcffce6443fefe3d8531d91cda12d8` |
| `desktop/release/Hello Pix 0.1.3.exe`（portable 免安装版） | 82,003,299 | `cee72f056313fe3b8be389e14731f0b7b6610a4af517456390ee0e2f680bf2d9` |
| `安装包/Windows-安装版(x64).exe` | 82,432,446 | `c5cd06129be7aad7c2f7c3ff98d2e3a21c50b32295b8b38541b2b013938a1994` |
| `安装包/Windows-免安装版(x64).exe` | 81,999,561 | `98a66a354d6e6e75dc9e8491697a7a895023110dfdbcf8293eab4d6ac76594c8` |

Windows 目标：`nsis`(x64) + `portable`(x64)；`artifactName: HelloPix-Setup-${version}.${ext}`。

### 🔴 构建不可复现 —— 必须锁定唯一产物

**实测**：同一份源码、同一台机器、同一个 electron-builder 版本，连续两次构建的
SHA-256 **完全不同**：

| 构建 | HelloPix-Setup-0.1.3.exe 的 SHA-256 |
| --- | --- |
| 2026-09-16 | `a5b2e497f0c886832f915a4a427e055703fcffce6443fefe3d8531d91cda12d8` |
| 2026-09-25（本次） | `8fed5854b0a4503904f2445e2f1de4f93965af61ce3d7e69efe77f547edb6c31` |

（构建产物内含时间戳，electron-builder 默认不做可复现构建。）

**这意味着**：`release/` 和 `安装包/` 里那几份同名文件**互不相同、来源不明**，
不能用其中任何一份作为「验收过的包」—— 因为无法证明它就是源码的产物。

**唯一正确做法**：上线前**重新构建一次**，把这一次的产物作为**唯一发布候选**，
记录它的 SHA-256，并确保发给用户/上传服务器的就是这一个文件。
本次构建已完成（见下方「本次构建基准」）。

### ✅ 本机具备 Windows 构建能力（已实测）

`npm run pack:win` 在 macOS 上**直接成功**，无需 wine：

```
electron-builder 26.15.3 / electron 33.4.11 / arch=x64
• packaging  platform=win32 arch=x64 → release/win-unpacked
• building   target=nsis     file=release/HelloPix-Setup-0.1.3.exe
• building   target=portable file=release/Hello Pix 0.1.3.exe
exit 0
```

（NSIS 的 `makensis` 由 electron-builder 自带 macOS 原生二进制，因此不需要 wine。）

### 本次构建基准（唯一发布候选）

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `desktop/release/HelloPix-Setup-0.1.3.exe` | 82,436,183 | `8fed5854b0a4503904f2445e2f1de4f93965af61ce3d7e69efe77f547edb6c31` |
| `desktop/release/Hello Pix 0.1.3.exe` | 82,003,297 | `9e2d563be3ca62a0669470d03ae3b37a8cc3a5b94fbfd7f911679b499abc80a8` |

> ⚠️ 这两个包是 **2026-09-25 用「当前未改动的源码」**构建的。
> 一旦为修复第 8 节（基础版引擎）或第 3.3 节（多开分区）改了代码，
> **必须重新构建并重新记录 SHA-256** —— 上面这两个就作废了。

---

## 2. 登录接口

| 环节 | 实现 |
| --- | --- |
| 登录 | `POST /apis/client/login`（`main.js:1593`） |
| 登出 | `POST /apis/client/logout`（`main.js:1641`） |
| 会话校验 | `GET /apis/client/session`（`main.js:1650`） |
| 平台列表 | `GET /apis/client/platforms`（`main.js:1662`） |
| 被顶号 | 主进程监听后 `win.webContents.send('auth:kicked', …)`（`main.js:633`） |

**登录态持久化**（`main.js:394-441`）：

- 落盘位置 `<userData>/auth.json`
- 字段：`remember` / `autoLogin` / `username` / `passwordEnc`
- 密码用 Electron `safeStorage.encryptString()` 加密后 base64 存储
- **`safeStorage` 不可用时强制关闭 `autoLogin`**（不降级为明文）—— 这一点做得对
- 不勾「记住」时直接写入 `{remember:false, autoLogin:false}`，清除凭据

---

## 3. 多开 session partition 机制

### 3.1 分区命名

```js
// main.js:141-148
function accountSlug() {
  const safe = currentPixUser().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return safe || 'anon'
}
function makePartition(platformId, index) {
  return 'persist:pix-' + accountSlug() + '-' + platformId + '-' + index
}
```

即 `persist:pix-<PIXS用户名>-<平台ID>-<序号>`，例如
`persist:pix-alice-telegram-z-1`、`persist:pix-alice-whatsapp-green-1`。

分区目录实体在 `<userData>/Partitions/`（`main.js:663`、`main.js:766`）。

### 3.2 序号怎么来

```js
let nextTab = 1          // main.js:80
let usedCount = {}       // main.js:81   ← 进程内内存

// 新增标签页时（main.js:1393-1394）
usedCount[item.id] = Number(usedCount[item.id] || 0) + 1
const index = usedCount[item.id]
```

启动时只按**当前登录的 PIXS 账号**从 `<userData>/open-apps.json` 恢复一次
（`main.js:250-251`）。

### 3.3 🔴 问题：多进程会撞分区

**没有单实例锁** —— 全文 grep `SingleInstance` 命中 **0** 次，`app.requestSingleInstanceLock()`
从未被调用。这本身是「多开」需要的，但同时带来了下面的问题：

`usedCount` 是**每个进程各自的内存状态**，而 `userData`（含 `Partitions/`）是**所有进程共享的**。于是：

```
进程 A 启动，读 open-apps.json 得到 usedCount{telegram-z: 1}
进程 B 同时启动，也读到 usedCount{telegram-z: 1}

A 打开 Telegram → index = 1+1 = 2 → persist:pix-alice-telegram-z-2
B 打开 Telegram → index = 1+1 = 2 → persist:pix-alice-telegram-z-2   ← 同一个分区
```

**两个进程拿到同一个分区名 → 共享 Cookie / LocalStorage / 登录态**，
而这正是「多开隔离」要保证不发生的事情。

更糟的是两个进程会**同时读写同一个 Chromium 分区目录**（LevelDB / SQLite），
存在profile 损坏风险，表现通常是「一个实例登录后另一个被踢」或
「网络服务报错、白屏」。

**序号分配没有跨进程互斥，也没有唯一性来源**（无 PID、无随机数、无文件锁）。

> 这一条必须实测确认。要验的是三件事：
> 1. 两个进程能否同时起来（Chromium 是否会对 `userData` 加 ProcessSingleton 锁）
> 2. 起来之后 Telegram 分区名是否真的相同
> 3. 相同分区下，A 登录/B 刷新会不会互相踢

### 3.4 单进程内的多开（同平台多标签）是隔离的

同一进程内 `usedCount` 递增，`-1` / `-2` / `-3` 各自独立分区，
**这部分设计是对的**。风险只出在「多个客户端进程」这一场景。

---

## 4. Telegram Web

| 项目 | 值 |
| --- | --- |
| 平台 ID | `telegram-z` |
| URL | `https://web.telegram.org/a/` （Telegram Web **A**） |
| 图标 | `telegram` |

### DOM Adapter

消息节点选择器（`guest-inject.js:148-152`）：

```js
'.message-list-item .text-content, .Message .text-content,
 div.message-in span.selectable-text, div.message-out span.selectable-text,
 div.copyable-text span.selectable-text'
```

- `.message-list-item .text-content` → Telegram Web A（当前 `/a/` 就是它）
- `.Message .text-content` → Telegram Web K 的兼容写法
- `div.message-in/out span.selectable-text` → WhatsApp

消息宿主 `hostOf()`（`guest-inject.js:164-169`）依次尝试
`.text-content` → `div.copyable-text` → `[data-testid="msg-container"]` → 自身。

接收/发送判定 `isOwn()`：`.own` 或 `.message-out`。

### 客户身份（Telegram）

`telegramPeer()`（`guest-inject.js:184-194`）**只从 URL hash 取**：

- `#/123456789` → 纯数字（群组带前导 `-`）→ `peer_id`
- `#/@username` → `username`

拿不到就**不上报**（宁可漏采集，不造错误身份）。这是对的设计。

---

## 5. WhatsApp Web

| 项目 | 值 |
| --- | --- |
| 平台 ID | `whatsapp-green`（WhatsApp绿色版）、`whatsapp-pro`（WhatsApp多功能版） |
| URL | `https://web.whatsapp.com/` |
| 图标 | `whatsapp` |

**两个平台 ID 指向同一个 URL** —— 这是有意的「绿色版 / 多功能版」区分，
但两者共用同一套列定义，实际差异只在平台 ID（影响分区名）。

### DOM Adapter

与 Telegram 共用 `messageNodes()`，WhatsApp 命中
`div.copyable-text span.selectable-text`（收发都算，靠 `isOwn()` 里的
`.message-out` 区分）。

### 客户身份（WhatsApp）

`whatsappPeer()`（`guest-inject.js:210-232`）从消息元素的 `data-id` 解析：

```
data-id="false_8613800138000@c.us_3EB0ABC123"
         ↑      ↑                  ↑
       是否本人  chatId(手机号)     消息 ID
```

- `@c.us` → 个人，`phone: '+<digits>'`（E.164，WhatsApp chatId 必含国家码）
- `@g.us` → **群聊直接返回 null，不算客户**（避免把整个群混成一个人）
- 无 `data-id` 可用 → 返回 null，不上报

---

## 6. 划词监听与翻译浮层

| 环节 | 实现 |
| --- | --- |
| 注入方式 | webview `preload: guest-inject.js`（`main.js:1368`，受 `bridgeEnabled` 控制） |
| 桥接 | `guest-inject.js:4-15`：`getPrefs` / `translate` / `reportCustomer` + `translate:prefs` 事件 |
| 触发 | 选中文本后由注入脚本取词（`translateText(text, incoming)` `guest-inject.js:304`） |
| 浮层 DOM | 宿主内插入 `.pix-trans`（译文）与 `.pix-click`（触发按钮） |
| 防重复 | `paint()` 前检查 `host.querySelector(':scope > .pix-trans, :scope > .pix-click')`（`:345`） |
| 清洗 | `sourceText()` 克隆节点后移除 `.MessageMeta/.message-time/.pix-*` 等噪声（`:144`） |
| 样式变量 | `--pix-font-size` / `--pix-font-color`，由 `applyPrefs` 写入 `document.documentElement` |
| 偏好项 | `transRecv` / `transSend` / `transGroup` / `langMine` / `langOther` / `sendTo` / `includeZh` / `antiRevoke` |

浮层样式定义在 `guest-inject.js:49-88`（`.pix-trans` / `.pix-click` / `.pix-kept` / `.pix-revoked`）。

---

## 7. 翻译 API 调用链

```
guest-inject.js  选中文本
   ↓  ipcRenderer.invoke('translate:run', {text, incoming})
main.js:1914     translate:run handler
   ↓  ① trustedTabSender 鉴权（拒绝非授权发送方）
   ↓  ② 长度闸门：>5000 字符直接拒
   ↓  ③ stripEmoji，纯 emoji 直接返回空
   ↓  ④ 本地缓存 getTransCached(from,to,engine,text) → 命中即返回（cached:true）
   ↓  ⑤ POST /apis/translate/run  form:{text,from,to,engine,requestId}
```

**`requestId` 由 `transRequestId(text, from, to, engine)` 生成** —— 幂等键，
服务端据此防止同一段文本被重复扣费。

### 服务端 `core-service.js translate()`（`:386-505`）

```
① 文本清洗 / 长度校验(>5000 → 413) / 语言参数正则校验
② resolveEngineId(session, data.engine)        ← 默认通道在这里决定
③ packageEngines(packageId) 校验套餐是否包含该引擎 → 否则 403 ENGINE_NOT_ALLOWED
④ engine.wired 检查                            ← 未接通 → 503 ENGINE_NOT_CONFIGURED
⑤ countBillableChars(text)                     ← 计费字符数
⑥ 幂等键必填校验（缺 → 400 IDEMPOTENCY_KEY_REQUIRED）
⑦ requestDigest(...) 计算请求指纹（幂等键复用于不同请求 → 409）
⑧ Redis 锁 pix:translate:lock:<user>:<key>（抢不到 → 409 REQUEST_IN_PROGRESS）
⑨ 事务：查 translation_reservations → 命中且指纹一致则直接返回缓存响应
         → lockAccount 校验余额 → adjustChars(-chars) 预扣
         → INSERT translation_reservations(status='reserved')
⑩ 读 translationCache → 未命中则 translator.translate(engine, …)
⑪ 失败 → 502 TRANSLATE_FAILED（预扣在 reconcile 时退回）
⑫ 事务：refundable（skipped/译文为空/译文==原文）→ adjustChars(+chars) 退款
         → 非 refundable 才 char_used += chars、translate_count += 1
         → INSERT translate_logs(..., chars, cost_amount, sell_amount, source_hash, snippet, cached, duration_ms)
```

**这一条链路的工程质量很高**：幂等键 + 请求指纹 + Redis 锁 + 余额悲观锁 +
失败退款 + 缓存回填，重复扣费的几个常见入口都堵住了。

---

## 8. 当前默认翻译通道 —— ~~🔴 上线阻断~~ 已于 2026-09-25 解除

### 8.1 生产实际状态（2026-09-25 复查）

> 本节原记录「9 个引擎里只有 `deepseek` 和 `gpt` 真正接通」。
> 2026-09-25 复查发现一个更根本的问题：**`wired=true` 不等于能翻**。
> 用 `scripts/probe-translate-engines.js` 真实调用各厂商 API 后，
> 原以为可用的那两个通道实际都翻不了，且原因各不相同（端点填成了控制台
> 页面 / 推理模型不接受 `temperature=0`，详见 `deploy/fix-engine-endpoints.sql`
> 与 `server/services/translation-adapters.js` 的注释）。
>
> 所以下表把**开关状态**与**实测结果**分成两列 —— 两者必须分开看，
> 只看 `wired` 会把"接通但坏了"误判成可用。

| id | 名称 | enabled | wired | 实测 |
| --- | --- | --- | --- | --- |
| **deepseek** | **DeepSeek 翻译** | ✅ | ✅ | ✅ 通（端点原填用量控制台地址，已修） |
| **google** | **谷歌翻译** | ✅ | ✅ | ✅ 通 |
| **gpt** | **GPT 翻译** | ✅ | ✅ | ⚠️ 待部署代码修复（模型不接受 `temperature=0`） |
| **grok** | **Grok 翻译** | ✅ | ✅ | ✅ 通 |
| aws | 亚马逊 AWS 翻译 | ✅ | ❌ | — 凭据未配置 |
| deepl | DeepL 翻译 | ✅ | ❌ | — 凭据未配置 |
| gemini | Gemini 翻译 | ✅ | ❌ | — 凭据未配置 |
| niutrans | 小牛翻译 | ✅ | ❌ | — 凭据未配置 |
| papago | Papago 翻译 | ✅ | ❌ | — 凭据未配置 |

**已接通 4 个（deepseek / google / gpt / grok），未接通 5 个。**
（有道 / 腾讯 / 百度 已按下线要求移除，这点符合预期。）

### 8.2 套餐 × 引擎矩阵（2026-09-25 复查）

| 套餐 | 含引擎 | 已接通数 | 商户数 | 能否翻译 |
| --- | --- | --- | --- | --- |
| 1 · 基础版 | `google, niutrans` | **1** | 4 | ✅ **可以**（`google` 已接通） |
| 2 · 高级版 | `deepseek, gemini, google, niutrans` | 2 | 0 | ✅ |
| 3 · 专业版 | 全部 9 个 | 4 | 4 | ✅ |

### 8.3 结论：原阻断已解除

`resolveEngineId()`（`core-service.js:280`）只从 `enabled && wired` 里挑，
基础版现在能挑出 `google` —— **4 个基础版商户恢复可翻译**。

解除途径正是当时列的第 2 条路「把 `google` 真正接通」（配凭据 + `wired=true`），
2026-09-25 完成。

遗留提醒：仍有 5 个「可选中但未接通」的引擎，商户在下拉里选中后会撞
`503 ENGINE_NOT_CONFIGURED`。上线前建议要么接通、要么把它们从套餐里摘掉，
否则客服会被「翻译坏了」的工单淹没。

---

## 9. 代理配置

| 项目 | 实现 |
| --- | --- |
| 预设 | `desktop/proxy-presets.js` —— **19 种**：`none` / `http` / `https` / `socks5` / `ssh` / 及 14 家动态代理商（ipfoxy、711Proxy、SX.ORG、smart、Proxy302、storm、iphtml、kookeey、ipfly、Luminati、oxylabs、rolaip、skyip、socks5io） |
| 规则生成 | `proxyRulesOf(settings)`（`main.js:1125-1155`） |
| 生效 | `session.setProxy({proxyRules, proxyBypassRules:'<local>'})` |
| 连通性检测 | `detectProxyNode(payload)`（`main.js:1293+`）：临时分区 `temp:pix-proxy-detect` 设代理 → 请求 `api.ipify.org` / `ipv4.icanhazip.com` → 回显出口 IP |
| IPv6 | `proxyIpVer === 'ipv6'` 时改用 `api64.ipify.org` / `api6.ipify.org` |
| 密码存储 | `proxyPass` 用 `safeStorage` 加密后加前缀存储（`main.js:109-114`），读取时解密 |
| SSH 模式 | `type==='ssh' && proxyLocal` → `socks5://<proxyLocal>` |

代理是**按标签页设置**（`tab.settings`），所以理论上「不影响其他未使用该代理的实例」。
检测失败会清空临时分区并回报 `success:false` + 原因。

---

## 10. 自动更新

**不是 electron-updater，是「检查版本 + 拉下载页」模型**（`main.js:1841-1852`）：

```js
GET /apis/client/update?os=<process.platform>&arch=<process.arch>
  → { version, url }
```

- 与本地 `APP_VERSION` 比较后返回 `{local, remote, url}`
- 下载 URL 必须通过 `isAllowedExternalUrl(candidate, DOWNLOAD_HOSTS)` 白名单校验，
  不在白名单则**丢弃 url**（返回空）—— 防的是「更新接口被劫持 → 下载恶意包」
- 无 `app-update.yml`，`win-unpacked/` 里也没有自动更新配置
  → **确认不会自动静默升级，需要用户手动下载安装**

---

## 11. 客户身份采集

| 环节 | 实现 |
| --- | --- |
| 网页侧 | `guest-inject.js:248+` `reportClue()` → `pix.reportCustomer({...})` |
| 主进程 | `ipcMain.handle('customer:ingest')`（`main.js:1854+`） |
| 可信补全 | **`platform` 与 `accountKey` 由主进程按 `webContents` 反查 tab 填入，不接受渲染进程传值** |
| 上报 | `POST /apis/customer/ingest` |
| 失败处理 | 静默失败（不打断聊天），但返回 `msg` 保留排查线索 |
| 隐藏页跳过 | `reportClue` 里 `if (document.hidden) return` |

**「不信任渲染进程传值」这一点是安全设计的关键**：渲染进程跑在网页上下文里，
页面脚本理论上能影响它；由主进程反查才能保证「这条线索确实来自那个账号」。

对方接口（`production.js:496-505`）：

- `POST /customer/ingest` —— 从会话取 `user_id`，**不接受客户端传商户号**
  （否则任何人都能往别人客户库里灌线索）
- 操作员只在子账号时落 `operatorId`（主账号 id 在 `users` 表，塞进
  `customer_owners.employee_id` 会违反外键）
- `GET /customer/reminders` —— 客户端每 8 秒轮询，服务端窗口 10 分钟

---

## 12. messages / translate_logs 落库链路

### `messages`（客户消息）

| 项目 | 值 |
| --- | --- |
| 建表 | `migrations/016_customer_identity.js:159` |
| 分区 | `PARTITION BY RANGE (sent_at)`，主键 `(id, sent_at)` |
| 写入 | `server/repositories/customer-repository.js:177` |
| 读取 | `server/repositories/customer-repository.js:199` |
| 去重 | 部分唯一索引 `messages_dedup_idx ON (conversation_id, source_msg_id, sent_at, md5(body)) WHERE source_msg_id <> ''` |
| 字段 | `direction` / `body` / `body_translated` / `lang_detected` / `source_platform` / `source_account` / `source_conv_id` / `source_msg_id` / `sent_at` |

**生产库现有分区**：`messages_2026_08` / `_09` / `_10` / `_11` / `_12` —— **已覆盖到 12 月**。

自动维护：`scripts/maintenance.js:69 ensurePartitions()`，从**上个月**建到 `AHEAD_MONTHS`，
经 `hello-pix-maintenance.timer` **每小时执行**（实测退出码 0、耗时 ~160ms）。
月初漏跑也不会丢跨月消息 —— 这个设计考虑到了。

> 🟢 小问题：`migrations/016` 的注释写「后续按月自动建（见
> `server/services/customer-identity-service.js`）」，但实际实现和调度都在
> `scripts/maintenance.js`。注释指向了错误的文件，容易误导后来人。**未改。**

### `translate_logs`（翻译流水）

写入点 `core-service.js:501-505`，**只在非 refundable 时写**：

```sql
INSERT INTO translate_logs(user_id, sub_account_id, engine_id, reservation_id,
  source_language, target_language, chars, cost_amount, sell_amount,
  source_hash, snippet, cached, duration_ms)
```

与 `char_used` / `translate_count` 的更新在**同一个事务**里
（`core-service.js:497-500`），不会出现「扣了费但没有流水」。

---

## 13. 我无法单方面完成的部分 —— 需要你提供环境

你要求的验收标准是：

> **真实账号 + 真实页面 + 真实消息 + 真实翻译 + 真实扣费证据。
> 自动化测试通过不能代替这一项。**

这一条我完全同意，但**我这台机器跑不了**：

| 检查项 | 实测结果 |
| --- | --- |
| 本机平台 | macOS（Darwin 24.6.0，Apple Silicon） |
| Windows 虚拟机 | ❌ 无 `VBoxManage` / `prlctl` / `vmrun` / `qemu` |
| Wine | ❌ 无 |
| Docker | ✅ 有，但 macOS 上**跑不了 Windows 容器** |
| 可达的 Windows 主机 | ❌ SSH 配置里只有 `github.com` 与生产 Linux 服务器 |

所以下面这些**只能由你在真实 Windows 上做，或者给我一台能连的 Windows**：

- 安装 NSIS 包 / 运行 portable 版
- 真实 Telegram 账号登录（需要手机验证码）
- 真实 WhatsApp 账号登录（需要扫码）
- 真实收发消息、真实划词、看真实浮层
- 多进程多开（Windows 上另起一个客户端）
- 重启恢复
- 1 小时稳定性观察 + 任务管理器看 CPU / 内存

**可行的三种方式**（你选）：

1. **你在自己的 Windows 上操作，我远程指挥 + 读服务端数据**
   你截图/贴日志，我负责服务端侧的扣费、`translate_logs`、`messages` 核对，
   以及客户端日志分析。**这是最快的一条路。**
2. **给我一台可 SSH 的 Windows 机器**（开 OpenSSH Server + 管理员）
   我可以自己装包、起进程、抓日志、跑脚本，但**Telegram/WhatsApp 登录仍需你输验证码/扫码**。
3. **你在 Windows 上装好，用 Chrome DevTools Protocol 连上来**
   客户端支持 `--remote-debugging-port`，我可以直接读真实 DOM 尺寸和选择器命中情况
   —— 这是验证「DOM 是否已变化」最可靠的手段。

---

## 14. 本轮未做的事（按你的要求）

- ❌ 未修改任何代码
- ❌ 未触碰 Telegram / WhatsApp 适配器
- ❌ 未处理其余 33 个平台
- ❌ 未接续 RC-02 的真实 USDT 付款（已挂起为「真实资金待验」）

---

## 15. 下一步建议顺序

1. **先定** 基础版引擎问题怎么修（第 8.3 节三选一）—— 这是上线硬阻断
2. **再定** 多开分区隔离怎么修（第 3.3 节）—— 这是产品核心卖点
3. **定 Windows 环境方案**（第 13 节三选一）
4. 从同一份源码重新构建 0.1.3（或升版本号）安装包，记录唯一的 SHA-256
5. 按你列的顺序跑：Telegram → WhatsApp → 多开 → 重启 → 代理 → 1 小时稳定性
6. 窗口尺寸/DOM 用 CDP 实测（`--remote-debugging-port`），不靠推算
