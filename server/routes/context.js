'use strict'

/**
 * 路由模块共享上下文。
 *
 * ## 为什么要抽这个
 *
 * `production.js` 原本是单文件 2283 行、95 个路由。拆分时每个子模块都需要
 * 同一批依赖（repo / auth / core / 各种 service / 限流器）。
 * 如果每个模块各自 `new` 一遍，会出现两个后果：
 *
 * 1. **同一份服务被实例化多次** —— 例如 `RechargeAmountService` 若在两处 new，
 *    尾数分配的随机源和配置就是两份，行为可能不一致
 * 2. **限流器的 redis key 分裂** —— 拆开的两组路由若各建一个同名限流器，
 *    额度就翻倍了，等于把限流关掉一半
 *
 * 所以依赖**只在这里构造一次**，各子模块只接收一个 `ctx`。
 *
 * ## 关键约束：限流器必须共用实例
 *
 * 下面这些限流器的命名空间是全局的（`login-ip`、`translate-ip`…），
 * 它们的作用就是「跨路由合计计数」。任何模块想加限流，必须在这里登记，
 * 不能在局部 `limit(...)` 现造一个 —— 那样额度会随拆分份数成倍放大。
 */

const { redisRateLimit } = require('../redis-security')
const { input } = require('../lib/http')
const { number } = require('../services/core-service')
const { AdminTotpService } = require('../services/admin-totp-service')
const { RechargeAmountService } = require('../services/recharge-amount-service')
const { RechargeEntitlement } = require('../services/recharge-entitlement')
const { RechargeExceptionService } = require('../services/recharge-exception-service')
const { PackageService } = require('../services/package-service')
const { SettingsService } = require('../services/settings-service')
const { DashboardStatsService } = require('../services/dashboard-stats-service')
const { CrashReportService } = require('../services/crash-report-service')
const { AdminAccountService } = require('../services/admin-account-service')
const { RechargeOrderService } = require('../services/recharge-order-service')

/**
 * 会话里可公开返回给前端的字段。
 *
 * 只挑白名单字段，不整个 `session.account` 丢出去 ——
 * session 对象里有 password_hash、totp_secret 这类绝不该出库的东西。
 */
function publicUser(session) {
  return {
    role: session.kind,
    username: session.account.username,
    nickname: session.account.nickname || session.account.username,
    email: session.account.email || session.parent.email || '',
    basename: session.parent.packageTitle || '',
    versionId: session.parent.packageId,
    charBalance: number(session.account.charBalance),
    enterprise: number(session.parent.enterprise)
  }
}

/**
 * 构造一次路由上下文。
 *
 * @param {object} context productionRouter 收到的原始 context
 * @returns {object} ctx
 */
function buildContext(context) {
  const { repository: repo, auth, core, customers, accounts, security } = context

  /**
   * 限流器工厂。**只在这里使用**，不要在子模块里另建。
   * 命名空间是全局共享的：同名即同一个计数器。
   */
  const limit = (namespace, max, windowMs, keyFn) => redisRateLimit({
    redis: core.redis,
    namespace,
    max,
    windowMs,
    key: keyFn
  })

  const limits = {
    // 登录按入口分桶。
    //
    // 曾经三个入口（商户 /login、客户端 /client/login、超管 /admin/login）
    // 共用同一个 `login-ip` 计数器，后果很实在：
    //   · 同一个出口 IP 下，攻击者往商户端刷 30 次失败登录，就把**超管后台**
    //     一起锁死了 —— 攻击者无法登录，运维也进不去救场；
    //   · 一批商户共用一个办公室 NAT，老板和员工的登录互相消耗额度。
    // 分桶之后每个入口各算各的，单入口仍然有兜底上限。
    loginIp: limit('login-ip', 30, 15 * 60_000),
    clientLoginIp: limit('client-login-ip', 60, 15 * 60_000),
    adminLoginIp: limit('admin-login-ip', 20, 15 * 60_000),
    loginAccount: limit('login-account', 10, 15 * 60_000, req =>
      String(input(req).username || '').trim().toLowerCase() || 'missing'
    ),
    captcha: limit('captcha-ip', 60, 10 * 60_000),
    // 发验证码：每 IP 每 10 分钟 10 次。比图形验证码更严 ——
    // 它背后是真金白银的发信配额，滥用还会拖累发件域名信誉。
    emailCode: limit('emailcode-ip', 10, 10 * 60_000),
    // 注册与找回密码：每 IP 每 10 分钟 20 次。
    // 验证码本身有 5 次尝试上限，这里只挡批量刷接口。
    register: limit('register-ip', 20, 10 * 60_000),
    translateIp: limit('translate-ip', 180, 60_000),
    translateAccount: limit('translate-account', 120, 60_000, req =>
      req.pixUser ? `${req.pixUser.kind}:${req.pixUser.account.id}` : 'missing'
    ),
    /**
     * 图片翻译的独立额度。
     *
     * ## 为什么不与文本共用 translateAccount
     *
     * 一次图片翻译的成本是纯文本的**几十到几百倍**：要传一张最高 1600px 的图
     * （prompt 动辄 1000+ token），还要生成"原文 + 译文"两份内容。
     * 而 token 单价是同一个模型、同一个价目表。
     *
     * 共用 120 次/分钟意味着：一个脚本每分钟刷 120 张图，账单是文本的几十倍，
     * 而限额毫不知情 —— 这就是"限额在但没起作用"。
     *
     * 20 次/分钟的依据：正常用户看一张图点一次翻译，一分钟翻 20 张已经远超
     * 实际使用（实测连续点 5 张大约 15~40 秒）。真需要更多的人，改这个数字即可，
     * 但必须是**独立**的数，而不是搭文本的便车。
     *
     * IP 维度也单独给：图片请求 body 大（几 MB），同一 IP 高频请求本身
     * 就是带宽/内存压力，不该和文本共享 180 次的门槛。
     */
    translateImageIp: limit('translate-image-ip', 40, 60_000),
    translateImageAccount: limit('translate-image-account', 20, 60_000, req =>
      req.pixUser ? `${req.pixUser.kind}:${req.pixUser.account.id}` : 'missing'
    ),
    // 崩溃日志上报：每 IP 每小时 20 次。
    // 客户端正常一年也传不了几次（只在异常退出后的下次启动传一次），
    // 这个额度只用于挡住刷接口，不会误伤真实用户。
    crashReport: limit('crash-report-ip', 20, 60 * 60_000),
    // 第二步的限流按来源 IP：票据本身还有尝试次数上限，两层叠加
    adminTotp: limit('admin-totp-ip', 20, 15 * 60_000),
    // 动态码/密钥相关操作只可能在已登录会话里发生，给个宽松上限防脚本刷
    adminTotpOp: limit('admin-totp-op', 60, 15 * 60_000, req =>
      req.pixAdmin ? `admin:${req.pixAdmin.id}` : 'missing'
    )
  }

  // 下单要复用**同一个** rechargeAmount 实例 —— 尾数池在实例内部，
  // new 第二份会让两边的分配互不可见，可能出现两张订单抢到同一个尾数。
  const rechargeAmount = new RechargeAmountService()
  // 同理：设置读取被后台与下单两处共用，必须同一个实例。
  const settings = new SettingsService(repo)

  const services = {
    // 超管两步验证
    adminTotp: new AdminTotpService(repo, core.redis),
    // 充值金额预约：随机尾数分配 + 24 小时复用保护（RC-02）
    rechargeAmount,
    // 套餐权益发放。手工确认与链上自动入账必须走**同一份**逻辑 ——
    // 否则会出现"自动入账发了套餐、手工确认没发"，同一张订单两种结果。
    rechargeEntitlement: new RechargeEntitlement(repo),
    // 异常池人工处置。023 建表时就定义了 resolved/ignored 与 resolved_by，
    // 但一直没有写入入口 —— 结果是异常只能永远 open，永远挂在列表里。
    rechargeException: new RechargeExceptionService(repo),
    // 套餐字段校验 + 事务写入。原本揉在一条 178 行的路由里，
    // 校验规则只有那一处，别处要用就得复制 —— 复制出去的第二份迟早走偏。
    packages: new PackageService(repo),
    // 超管总览的口径与 SQL。原本 83 行内联在路由里，
    // 想加一个指标就得改路由文件 —— 而这恰好是运营每天睁眼看的那一页。
    dashboardStats: new DashboardStatsService(repo),
    // 崩溃日志上报：白名单、截断、摘要计算都在里面。
    // 这条路由不要求登录（闪退常发生在登录前），所以过滤规则必须自己扛住 ——
    // 它和 desktop/src/stability/crash-report.js 的常量是**必须一致的两份拷贝**。
    crashReport: new CrashReportService(repo),
    // app_settings 的读写。被后台设置页和 /userRecharge/create **两个域**共用，
    // 所以不能挂在任一域的文件里 —— 拆 admin 时它跟着搬走，
    // 商户端下单那条路由就只剩一个悬空标识符，一调就 ReferenceError。
    settings,
    // 后台新建/编辑商户。141 行的 handler 拆成 update / create 两条路径，
    // 每条规则背后都有一次线上事故（改备注换掉已售权益、布尔开关存反、
    // 新建时占位符对不上导致整条路径 500 ……），埋在长 handler 里没人看得见。
    adminAccounts: new AdminAccountService(repo, auth),
    // 商户下单（资金主路径）。尾数分配、金额格式化、订单快照全在这里，
    // 路由只剩前端字段拼装。真跑测试见 test/recharge-order-service.test.js。
    rechargeOrder: new RechargeOrderService({ repo, core, rechargeAmount, settings })
  }

  return {
    repo,
    auth,
    core,
    customers,
    accounts,
    security,
    limits,
    services,
    publicUser
  }
}

module.exports = { buildContext, publicUser }
