# MAINT — Hello Pix / 皮克斯多开翻译软件

- 启动：
  - Web/API 开发：`npm start`
  - 本地 Mock 冒烟：`NODE_ENV=development PORT=3100 PIX_ENABLE_DEMO_DATA=1 node server/index.js`
  - Desktop：`cd desktop && npm start`
- 入口：
  - API：`server/index.js`
  - 路由：`server/routes/production.js`
  - Web：`src/main.js`、`src/router/index.js`
  - Desktop：`desktop/stability-boot.js` → `desktop/main.js`
- 测试：
  - `node scripts/run-tests.js`
  - 2026-11-18 1.3.11 发布基线：2873 tests / 2808 pass / 0 fail / 65 skip
  - 65 skip = 已删除 Telegram 产品线的可见 quarantine；数据库集成测试实际执行
  - 发布前仍应执行 `./scripts/test-env.sh up`，让 16 个数据库测试实际运行
- 发布：
  - Web：`NODE_ENV=production npm run build`，产物在 `dist/`
  - Desktop：`cd desktop && npm run pack:mac` / `npm run pack:win`
  - 当前 T9 是 exFAT，Electron asar 打包可能生成 `._*` 元数据并触发 asar 完整性错误；正式打包应在 APFS 或 CI 工作区执行
- 配置：
  - `.env.local` / `.env.example`
  - `DATABASE_URL`、`REDIS_URL`、更新签名与翻译通道密钥均由环境变量或远端配置提供
  - 超管 TOTP 默认强制；只有受控迁移窗口才显式设置 `PIX_REQUIRE_ADMIN_TOTP=0`
  - 图片翻译按主账号默认 500 次/天；可用 `PIX_IMAGE_DAILY_LIMIT` 调整（上限 10000）
  - 密码策略：10–128 位，且同时包含字母和数字
- 依赖方：
  - Nginx → `127.0.0.1:3000`
  - `hello-pix.service` → `server/index.js`
  - PostgreSQL 16 / Redis
  - 桌面端 → `/apis/*`
  - Nginx → Node `127.0.0.1:3000`
  - Node → PostgreSQL、Redis、翻译厂商
  - 桌面客户端 → `pixfanyi.com`
  - 管理后台 → `lindufyht.com`

## 健康检查

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/ready
systemctl is-active hello-pix.service
journalctl -u hello-pix.service -n 80 --no-pager
```

期望：服务 `active`，两个接口均返回 `ok:true`。

## 发布检查

```bash
node --check server/index.js
node --test test/tron-address.test.js test/translation-provider.test.js
npm run build
systemctl restart hello-pix.service
curl -fsS http://127.0.0.1:3000/ready
```

## 回滚

- 代码基线：Git 标签 `prod-20261117-security-fix`
- 前端上一版：`/opt/hello-pix/dist.prev-fix-20261117-211202`
- 数据库：`/var/backups/hello-pix/hello_pix-20261117-211203.dump`
- 最新迁移 054（原生计数工单）可回滚：

```bash
node scripts/migrate.js down 1
```

054 的 down 只删除 `count_tickets`、`count_ticket_accounts`、
`count_ticket_fans` 三张新增表，不影响客户、会话、消息、充值或翻译账本。

恢复前端：

```bash
mv /opt/hello-pix/dist /opt/hello-pix/dist.failed
mv /opt/hello-pix/dist.prev-fix-20261117-211202 /opt/hello-pix/dist
```

恢复代码：

```bash
git -C /opt/hello-pix switch prod/20261117-security-fix
systemctl restart hello-pix.service
```

## 备份

- 本机每日备份：`hello-pix-backup.timer`
- 异地每日备份：`hello-pix-offsite-backup.timer`
- 日志：
  - `/var/backups/hello-pix/backup.log`
  - `/var/log/hello-pix/backup-offsite.log`

```bash
systemctl list-timers --all | grep hello-pix
pg_restore --list /var/backups/hello-pix/<dump>
```

## 已知坑

- 服务器 `/opt/hello-pix` 没有 Git remote，`master` 只有两个提交，生产源码长期以未提交文件运行。
- 服务器工作区曾同时包含旧版源码、未提交工单功能和已构建 1.3.6 产物，不能直接把目录当权威源码回灌。
- 线上 Web 源码以 `dist/js/index.b62b54d0.js.map` 的 `sourcesContent` 为准；服务器 `src/` 存在历史漂移。
- 线上 Desktop 源码以 `HelloPix-Setup-1.3.6.exe` 内 `app.asar` 为准。
- T9 使用 exFAT，容易出现 `100644 → 100755` 权限噪声和 `._*` AppleDouble 文件；本仓库已设置 `core.filemode=false`。
- 根 `package.json` 版本仍为 1.2.3，Desktop 为 1.3.6；两者不是同一版本线，不能强行统一。
- 本地 `standalone/telegram*` 在同步前已被删除；相关测试现在按缺失源码显式 skip，恢复产品线后会自动重新启用。
- 压缩请求体已显式拒绝（415）；业务客户端不应发送 `Content-Encoding: gzip/br`。
- `/health` 只是 liveness；部署监控与发布验收必须使用带 DB/Redis/迁移检查的 `/ready`。

## 2026-11-18 1.3.11 发布

- 发布分支：`release/1.3.11`
- 版本：Desktop/Web `1.3.11`
- 数据库迁移：`054_count_tickets`
- 生产回滚点：`/root/hello-pix-release-20261118-210956`
- 官网当前：Windows x64、macOS x64、macOS arm64 均为 `1.3.11`
- macOS 产物为 ad-hoc 严格签名，未公证；Windows 未做 Authenticode
- 更新清单使用离线私钥签名并入库，生产服务不常驻 `UPDATE_SIGNING_KEY`
- 详细指纹、验收与回滚命令见 `docs/1.3.11-发布与回滚.md`

## 2026-11-15 修复记录

- 生产依赖升级：`body-parser@2.4.0`、`proxy-addr@2.0.8`、
  `follow-redirects@1.16.3`、`source-map-js@1.2.2`、
  `brace-expansion@5.0.13`；Desktop `undici@6.29.1`。
- 代理应用失败不再被吞掉：`setProxy()` rejection 会阻止页面加载并回滚设置。
- 用户工单创建/回复修正 Axios `response.data` 解包；管理端分页、时间字段和
  消息/状态事务已修复。
- 超管 TOTP 改为默认强制；密码策略收紧；macOS 更新改为暂存、校验、原子替换，
  副本清理改为移入废纸篓。
- 图片翻译增加服务端内容锁、10 分钟结果缓存和主账号日成本上限；本地缓存加入
  账号/引擎边界。
- Web 生产构建通过，hash `505d491d5fddb296`；Desktop renderer 冒烟
  `VERIFY_OK`；真实 Electron 代理机制 26 项全部通过（公网代理项按未配置跳过）。

## 本次同步回滚点

- 本地完整快照：
  `../_同步快照/皮克斯多开翻译软件-local-before-sync-20261115-123119`
- 线上源码快照（服务器）：
  `/root/hello-pix-source-before-local-sync-20261116-013207.tar.gz`
- 线上快照 SHA-256：
  `2dc44991ba6ad4c0349dd47fa2c9561e1c3ee41915034c488f866a0d421c1da6`
- Git 工作分支：`maint/20261115-sync-online`

## 2026-11-15 部署记录

- 发布前备份：
  - 源码：`/root/hello-pix-source-before-deploy-20261116-044740.tar.gz`
  - 数据库：`/root/hello-pix-db-before-deploy-20261116-044740.dump`
- 初始发布在重启阶段发现 `server/ migrations/ scripts/` 目录权限为 `700 root:root`，
  服务用户无法遍历目录，短暂出现 502；已现场修正为目录 `755` 并恢复服务。
  根因已修进 `deploy/remote-deploy.sh`，并新增目录权限回归测试。
- 当前线上版本：`server/index.js` 与本地 SHA-256 一致，
  `body-parser@2.4.0`、`proxy-addr@2.0.8`，`/ready` 返回
  `postgres:true / redis:true`，首页/超管页均 200，未登录超管 API 返回 401。
- 当前仍保留 `$APP/.bak` 与 `.node_modules-before-deploy-20261116-044740`
  作为短期回滚副本；确认稳定后再删除。

## 桌面 1.3.7 发布

- `desktop/package.json` 与 lockfile 已升到 `1.3.7`。
- 三平台安装包已在 APFS 临时目录完成构建并通过 asar 验收：
  - Windows x64：`HelloPix-Setup-1.3.7.exe`
  - macOS x64：`Hello Pix-1.3.7.dmg`
  - macOS arm64：`Hello Pix-1.3.7-arm64.dmg`
- 临时构建目录：`/tmp/hello-pix-desktop-1.3.7.JPorZ9/desktop/release`
- 本地归档：`/Users/dongni/Desktop/HelloPix-1.3.7-已发布-用户授权未签名`
- 用户于 2026-11-15 明确授权发布未签名版本；三份包已上传到
  `/opt/hello-pix/downloads/`，发布记录 #157–#159 已启用，旧桌面版本记录已禁用。
- 官网和自动更新现在三平台都指向 1.3.7；更新清单带 Ed25519 服务端签名，
  但安装包本身仍是：
  - macOS ad-hoc、无公证；
  - Windows 无 Authenticode 签名。
- 发布前数据库快照：
  `/root/hello-pix-db-before-1.3.7-release-20261116-051400.dump`

## 桌面 1.3.8 发布

- 新增「导入语音」：外部音频经虚拟麦克风走 WhatsApp 原生录音链路，发送为
  真正的 PTT，而不是普通音频文件。
- 真机使用 25.7535 秒 OGG/Opus 原文件验证，WhatsApp 测试聊天中显示波形与
  `0:25`；未向联系人发送测试消息。
- 全量测试 `2533` 通过、`0` 失败、`81` 跳过。
- 三平台产物：Windows 安装版/免安装版、macOS x64、macOS arm64；三个
  `app.asar` 均通过 `verify-preload-load` 20/20。
- 本地已发布归档：
  `/Users/dongni/Desktop/HelloPix-1.3.8-已发布-用户授权未签名`
- 临时构建目录：`/tmp/hello-pix-desktop-1.3.8.NaE2AM/desktop/release`
- Windows 仍未 Authenticode 签名；macOS 为 ad-hoc、无公证。继续沿用用户
  2026-11-15 的未签名发布授权。
- 四份文件已上传至 `/opt/hello-pix/downloads/`；Windows 安装版、macOS x64、
  macOS arm64 发布记录 #160–#162 已启用，1.3.7 三条旧记录已停用。
- `/apis/site/info` 已确认把三平台下载地址都指向 1.3.8；三份更新清单均用
  Ed25519 现签现发，并已用客户端内置公钥逐一验签通过。
- 发布前数据库快照：
  `/root/hello-pix-db-before-1.3.8-release-20261116-065737.dump`
  SHA-256：
  `5c6ae04125226b5c69614865a23e6be9490af0fd7782624cb24e09bc3fb39494`

## 2026-11-15 快速语音直发 PTT（开发分支，未发布）

- 分支：`maint/20261115-whatsapp-direct-ptt`
- 桌面版本：`1.3.9`（尚未发布）
- 回滚快照：`/tmp/hello-pix-direct-ptt-before-20261115/source`
- 工作区补丁快照：`/tmp/hello-pix-direct-ptt-before-20261115/worktree-before.patch`
- 回滚命令：`bash /tmp/hello-pix-direct-ptt-before-20261115/rollback.sh`
- 新增「快速语音」入口：外部音频 → OGG/Opus → 64 字节波形 → WhatsApp
  `WAWebPrepRawMedia.prepRawMedia({ isPtt: true })` → `prep.sendToChat`。
- 不依赖固定模块号：优先走当前 Meta `requireLazy`，同时保留旧 Webpack
  按能力发现路径；任一模块缺失都失败关闭。
- 真机验收（账号分区副本、只发给自己的聊天）：
  - 1 秒语音成功，客户侧原生语音气泡显示账号头像与 `0:01`；
  - 25.7535 秒语音成功，显示原生波形与 `0:25`；
  - 25.7535 秒 WASM Opus 编码约 0.2 秒，解码+编码+WhatsApp 确认约 2.08 秒。
- 自动化：
  - 定向测试 `voice-note-direct-ptt + voice-opus-encode`：11/11；
  - 真实 Electron 跨隔离桥验证：`WHATSAPP_DIRECT_PTT_VERIFY_OK`。
  - 全量回归：2631 tests / 2550 pass / 0 fail / 81 已知跳过。
  - 更新器专项：30/30；真实挂载 DMG 的 cleanup 验证通过。
- 本地三平台构建（未上传）：
  - macOS：`/tmp/hello-pix-mac-crashfix.n7kTbv`
    - x64 DMG SHA-256：
      `c2e45cfd98e165a69823e53b67e4943167c8a81de03b4ca6dceab1553df479ca`
    - arm64 DMG SHA-256：
      `dd597b1358f3e219e7c5afd84432216fc498c9fc52febe9251d5c4bc7fc29416`
  - Windows：`/tmp/hello-pix-win-crashfix.bRhgaf`
    - 安装版 SHA-256：
      `7a229e9f8728436ea35b52cdfd3ec0647d66ba0e0da87c6d1da03eec53a7d17b`
    - 免安装版 SHA-256：
      `9f669b8b9ef9cb8adde68b4744938774373954a9f42f69aed0da9b2477a0072d`
  - 三个平台 `app.asar` 均为：
    `d1fd58e82aaba2b2691fb63e20eda9ac41bd11a9f9d0f1ac40b873938f0ff978`
  - `verify-preload-load`：三平台均 20/20。
- 编码器使用 `opus-recorder@8.0.5`（MIT）内置的 libopus/speexDSP WASM，
  不再随安装包分发含 `--enable-gpl --enable-nonfree` 的原生 FFmpeg。

## 2026-11-15 macOS 更新崩溃修复

- 崩溃现象：从临时挂载卷启动 1.3.8，dyld 报
  `Library not loaded: ...Electron Framework`，底层 Framework 读取
  `Input/output error`。
- 根因链：
  1. 1.3.6 更新器先删除 `/Applications/Hello Pix.app`，再 `ditto` 新版；
  2. 复制失败后回退到 `shell.openPath(temp/HelloPix-*.dmg)`；
  3. 多开进程共用同一 temp 更新目录，下一次启动的 cleanup 删掉仍被挂载的
     DMG 底层文件；
  4. 用户从已损坏的挂载卷启动 App，Electron Framework 无法按需读取。
- 修复：
  - 自动替换先复制到同级暂存 `.app`，校验后才原子替换旧包；
  - 每个下载创建 PID 锁，其他存活实例和 cleanup 不得删除；
  - cleanup 调用 `hdiutil info`，仍在挂载的 DMG 一律保留；查询失败也保留；
  - 自动安装失败时，先把已验证 DMG 复制到 `Downloads` 并核对 sha256，
    再交给 Finder，绝不直接打开 temp 文件。
- 验证：
  - 更新器专项 30/30；
  - 真实挂载官方 DMG 后执行 cleanup，挂载中的文件保留、未挂载旧包删除；
  - 修复包已安装到 `/Applications/Hello Pix.app`，冷启动日志：
    `启动 Hello Pix v1.3.9 · darwin arm64 · electron 33.4.11`。

## 2026-11-15 桌面 1.3.9 语音入口与真实波形发布

- 分支：`maint/20261115-whatsapp-direct-ptt`
- 根因与修复：
  - `translate:pageScripts` 守卫把 IPC event 当成 WebContents，导致脚本 URL
    始终为 `null`；改为使用 `event.sender`；
  - `pix://` 特权 scheme 在 `app.whenReady()` 后才注册，`bypassCSP` 不生效；
    改为模块加载阶段、ready 之前注册；
  - 同一 partition 重复补挂协议改为幂等，协议日志缺少 logger 时 fail-safe；
  - 「导入语音」和音频拖入不再走会产生空白波形的虚拟麦克风链路，统一委托
    给直接 PTT：真实幅度生成 64 字节 waveform，再调用
    `prepRawMedia({ isPtt: true })` / `prep.sendToChat()`。
- 真机验收（macOS arm64，只发到自己的 Message yourself 聊天）：
  - 21:32「快速语音」、21:44「导入语音」均显示账号头像、原生波形和 `0:02`；
  - 未向客户或联系人发送测试语音；
  - 1.3.8 历史 0:25 语音若元数据为空，WhatsApp 不会追溯重绘，这是历史数据。
- 自动化：
  - 全量：2637 tests / 2556 pass / 0 fail / 81 skipped；
  - 81 skip 含 16 个缺 PostgreSQL/Redis 的集成测试和 65 个已删除 Telegram
    独立客户端 quarantine；
  - 三平台 `verify-preload-load`：均 20/20；
  - 三平台 `app.asar` 同哈希：
    `3d17806ff29f0ef9d5ff4fc90a17aefe5a4cc63e74c307724c30d32bc7dd5b97`。
- 最终构建目录：`/tmp/hello-pix-final-waveform-1.3.9.Jfnc8C`
- 本地发布归档：
  `/Users/dongni/Desktop/HelloPix-1.3.9-已发布-用户授权未签名`
- 产物 SHA-256：
  - macOS x64：
    `fc936554254e86b1c0ccac2811cfd04524439fce18e428fb16738bbdb350a02b`
  - macOS arm64：
    `118338f23fe3630d843271c9bf34cedf034f6907bd02bf60362ae3ec1850e311`
  - Windows 安装版：
    `eccc7ca3ff906cd015f484a122ffe585a4c22a05bcd70494e923a3a7934bc228`
  - Windows 免安装版：
    `50b0e1d9b5850f39d875019cbffb93f22dee66f738e7d69439600d9a07b7f030`
- 线上：
  - 四份文件：`/opt/hello-pix/downloads/`；
  - 发布记录：Windows #166、macOS x64 #167、macOS arm64 #168；
  - 1.3.8 三条旧记录已停用；
  - `/apis/site/info` 与官网下载均指向 1.3.9；
  - 三平台更新清单已用 Ed25519 现签，并用客户端内置公钥逐一验签通过。
- 发布前数据库快照：
  `/root/hello-pix-db-before-1.3.9-waveform-20261116-105055.dump`
  文件 SHA-256：
  `2a1d909e0cafaef05a6e4730ee46b5299742dcaa93ea229d353384578f3fe3e3`
- 回滚：
  - 发布 SQL：`deploy/register-client-1.3.9.sql`
  - 将 1.3.9 三条记录置 `enabled=false`，把 1.3.8 #160–#162 置回
    `enabled=true`，恢复 1.3.8 公告；
  - 安装包 1.3.8 与 1.3.9 均保留，不需要删除文件。

## 2026-11-16 停用 jfbaibaox.com

- 现象：`jfbaibaox.com` / `www.jfbaibaox.com` 仍返回 Hello Pix 官网。
- 根因：Cloudflare 仍把域名流量送到源站，但 Nginx 没有该域名的虚拟主机，
  请求落入默认 server，因此暴露了同一套前端。
- 修复：新增 `/etc/nginx/conf.d/00-jfbaibaox-deny.conf`，对裸域名和 `www`
  同时处理 HTTP/HTTPS，不代理应用，直接返回 `410 Gone` 与
  `Cache-Control: no-store`。
- 仓库配置：`deploy/nginx/deny-jfbaibaox.com.conf`
- 回归测试：`test/nginx-domain-shutdown.test.js`
- 上线验证：
  - `http://jfbaibaox.com/` → 410
  - `https://jfbaibaox.com/` → 410
  - `https://www.jfbaibaox.com/` → 410
  - `https://jfbaibaox.com/apis/site/info` → 410
  - `https://pixfanyi.com/` → 200
  - `https://pixfanyi.com/apis/site/info` → 200
  - `https://lindufyht.com/` → 200
- Nginx 配置检查：`nginx -t` 成功；热加载后 `nginx` 服务 active。
- 全量回归：2640 tests / 2559 pass / 0 fail / 81 skipped。
- 回滚快照：
  `/root/nginx-before-jfbaibaox-shutdown-20261116-214706.tar.gz`
  SHA-256：
  `449112c408dbc2b318da515e156bc6825c456e4502b1dc3fa3944254fcbcb396`
- 回滚命令：
  `rm /etc/nginx/conf.d/00-jfbaibaox-deny.conf && nginx -t && systemctl reload nginx`
- 边界：域名 DNS 仍存在于 Cloudflare；当前是在源站将其彻底关闭为 410。
  若要从 DNS 层删除，需要 Cloudflare/域名注册商账户权限。

## 2026-11-16 WhatsApp 进粉计数内嵌（开发分支，未上线）

- 分支：`maint/20261115-whatsapp-direct-ptt`
- 桌面版本：仍为 `1.3.9`，本次构建只用于本地验收，尚未上传或发布。
- 产品口径：不进旧计数 EXE、不使用邀请码；复用 Hello Pix 登录 / 设备绑定 /
  WhatsApp 多开实例。全局重粉限定在同一 Hello Pix 主账号，跨设备、跨子账号。
- 数据库：新增 `053_counter_integration.js`，包含计数账号、进粉事实、进粉工单、
  工单时间线四张表，`down` 可删除。
- 事件链：WhatsApp 页面世界观察 `WAWebMsgCollection.MsgCollection` →
  客页固定通道 → 主进程本地 outbox → `/counter/inbound`。
- 实时口径：新粉 / 重粉同事务创建唯一自动工单；主进程成功后推送
  `counter:updated`，进粉中心立即刷新 KPI 与流水。
- 断网口径：事件先写入 `counter-outbox.json`，同消息 ID 指数退避重放；
  关闭实例会排队归档，待传事件成功后才归档，避免旧事件重新激活账号。
- 历史口径：关闭或删除最后一个计数实例后，当前汇总归零；历史流水和工单保留，
  进粉中心可用“包含已归档账号”查看。
- 原生界面：新增“进粉中心”，含实时总览、进粉流水、重粉库、自动工单、
  计数账号开关；旧的隐藏 `127.0.0.1:8080` 平台入口已移除。
- 验证：
  - 全量 `2674 tests / 2593 pass / 0 fail / 81 skip`；
  - 81 skip 含 16 个缺 PostgreSQL/Redis、65 个已删除 Telegram quarantine；
  - 定向进粉 / IPC / renderer 回归 `102/102`；
  - Web 生产构建通过；
  - Mac arm64、Mac x64、Windows x64 安装包均构建成功；
  - 三平台 `app.asar` 同哈希：
    `f1589ed32526b2dbd21ecef7ec9ce75ea5cebcaaaa10c753b8d6952b5f8ca8f5`；
  - 三平台 `verify-preload-load` 均 `20/20`；
  - 真实 Electron 渲染截图：
    `/tmp/hello-pix-counter-dark.png`、
    `/tmp/hello-pix-counter-light.png`、
    `/tmp/hello-pix-counter-narrow.png`。
- 本地构建：
  - Mac arm64：`/tmp/hello-pix-counter-release-mac-20261116-100805`
  - Mac x64：`/tmp/hello-pix-counter-release-mac-x64-20261116-101130`
  - Windows x64：`/tmp/hello-pix-counter-release-win-20261116-101055`
- 本次集成补丁快照：
  `/tmp/hello-pix-counter-integration-after-20261116-101312.tar.gz`
  SHA-256：
  `ad5273c9332931a3f83481e316d8ea56a9f2d6846e579975d13d499f356bc8b7`
- 上线前阻塞：
  - 工单与语音改动必须先在隔离 PostgreSQL/Redis 环境跑完整回归；
  - 当前 macOS 为 ad-hoc / 无公证，Windows 未 Authenticode 签名。
- 构建坑：T9/exFAT 上直接写 `desktop/release` 会触发 asar 头解析异常；
  本次改为 `--config.directories.output=/tmp/...` 后成功。正式构建继续使用
  APFS 或 CI 工作区。
