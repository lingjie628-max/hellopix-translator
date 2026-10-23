'use strict'

/**
 * 路由能力声明表 —— 授权模型的心脏。
 *
 * ## 为什么要重写授权
 *
 * 2026-10-23 入侵：攻击者注册一个普通商户账号，把 URL 改成 `/ADMIN/staff/save`
 * 就创建了后门超管。当时授权是这么判的：
 *
 *     auth-service.js 里一个 startsWith('/admin/')  +  一个 4 元素数组 superOnly
 *
 * 问题是 **授权规则和路由定义在两个地方**。`routes/admin/clients.js` 里加了
 * 一个新接口，授权那边不会自动知道它存在 —— 它默认落进 "GET 放行" 那一档。
 * 55 个 /admin 路由里，19 个对 operator 完全敞开，包括：
 *
 *   GET /admin/customers/:id   → 全站所有商户的客户名单、对话内容、跨商户共享关系
 *   GET /admin/logs            → 所有管理员的审计记录和 IP
 *   GET /admin/scripts         → 运维脚本清单
 *
 * ## 新的规则
 *
 * 1. **每个路由必须显式声明能力**，写在这里。没声明 = 拒绝（fail-closed）。
 * 2. 判定依据是 `METHOD path` 精确匹配，**不做前缀匹配** ——
 *    前缀匹配是上一个漏洞的根源（/admin/staff 和 /admin/staffx 被当成一回事）。
 * 3. superadmin 通过所有 admin.* 能力；operator 只拿到列表里明确给它的。
 *
 * ## 加新路由时
 *
 * 必须在 ROUTE_CAPS 里加一行。忘了加会直接 500 报错（不是静默放行），
 * 由 test/authz-capabilities.test.js 在测试阶段就抓住。
 */

/**
 * operator（普通运营）能有的能力。
 *
 * 判据只有一个：**泄露或改动的东西是不是"别人的"**。
 * - 看自己负责的客户？可以。
 * - 看全站客户名单？不行 —— 那是整个平台的商业资产。
 * - 看审计日志？不行 —— 里面是超管的 IP 和操作，是下次攻击的地图。
 */
const OPERATOR_CAPS = new Set([
  'admin.read.overview',      // 首页统计（不含客户明细）
  'admin.read.recharge',      // 充值单（运营要对账）
  'admin.read.translate',     // 翻译记录
  'admin.read.package',       // 套餐列表（只读）
  'admin.read.faq',           // FAQ、官网链接等内容配置的只读
  'admin.read.engine'         // 翻译通道状态（不含密钥，接口本身只回 hasKey）
])

/**
 * `METHOD path` → 能力。
 *
 * 能力命名：`admin.<动作>.<资源>`
 *   read  = 只读
 *   write = 改配置
 *   money = 动钱（充值审核、发放额度）
 *   admin = 动管理员账号本身
 *   secret = 能读到密钥/邮箱等敏感配置
 *
 * 标了 `HIGH_RISK_CAPS` 的能力除了角色校验，还要求**写操作当场重新认证**
 * （见 `requiresReauth`：GET/HEAD/OPTIONS 不要求 —— 打开页面看一眼不该要密码）。
 */
const ROUTE_CAPS = {
  // ── 管理员账号本身 ───────────────────────────────────────
  // 这里的每一条都是"拿到就等于拿到超管"，必须是最高档
  'GET /admin/staff': 'admin.admin.list',
  'POST /admin/staff/save': 'admin.admin.write',

  // ── 两步验证：只管自己的账号，任何登录的管理员都能操作 ──
  // 中间件对 /admin/totp* 单独放行（见 auth-service.js），这里只做记录
  'GET /admin/totp': 'admin.totp.self',
  'POST /admin/totp/setup': 'admin.totp.self',
  'POST /admin/totp/enable': 'admin.totp.self',
  'POST /admin/totp/disable': 'admin.totp.self',
  'POST /admin/totp/recovery': 'admin.totp.self',

  // ── 全局设置 / 敏感配置 ──────────────────────────────────
  'GET /admin/settings': 'admin.write.settings',        // 返回全站配置原文
  'POST /admin/settings/save': 'admin.write.settings',
  // ★ 读写必须拆开 ★
  //
  // 原来 GET/POST 共用 `admin.secret.mail`，而它在 HIGH_RISK_CAPS 里，
  // 于是**只是打开邮件设置页**就要求带 X-Pix-Reauth（管理员密码）。
  // 前端从不带，接口回 428，表单全空白 —— 后台显示"邮件服务未配置 / 缺：未知"，
  // 而库里数据完好。运维看着这页会以为配置丢了，实际是权限判定错了对象。
  //
  // 读：返回的 pass 是 '********' 打码，alertTo 是打码地址，不泄露任何密钥。
  //     给它单独的只读能力，operator 不在 OPERATOR_CAPS 里，仍然拿不到。
  // 写：改 SMTP 配置等于能劫持全部验证邮件（收走注册验证码 = 接管账号），
  //     必须保持高危 + 二次认证。
  'GET /admin/mail': 'admin.read.mail',
  'POST /admin/mail': 'admin.secret.mail',
  'POST /admin/mail/test': 'admin.secret.mail',
  'GET /admin/verify': 'admin.write.settings',
  'POST /admin/verify/save': 'admin.write.settings',
  'GET /admin/scripts': 'admin.secret.ops',             // 运维脚本清单
  'GET /admin/collision-settings': 'admin.write.settings',
  'PUT /admin/collision-settings': 'admin.write.settings',

  // ── 商户账号管理 ─────────────────────────────────────────
  'GET /admin/users': 'admin.admin.list',
  'POST /admin/users/save': 'admin.admin.write',
  'POST /admin/users/delete': 'admin.admin.write',
  'POST /admin/users/resetPassword': 'admin.admin.write', // 重置密码 = 接管该商户
  'POST /admin/users/status': 'admin.admin.write',
  'POST /admin/users/expiry': 'admin.money.write',
  'POST /admin/users/enterprise': 'admin.money.write',
  'POST /admin/users/unbind': 'admin.admin.write',
  'POST /admin/users/reclaim': 'admin.admin.write',
  'GET /admin/subs': 'admin.admin.list',
  'POST /admin/translate/grant': 'admin.money.write',    // 白送额度

  // ── 客户数据：跨商户，是平台核心资产 ────────────────────
  // 这是上一版最大的口子：operator 能读全站客户名单和对话
  'GET /admin/customers': 'admin.data.customers',
  'GET /admin/customers/:id': 'admin.data.customers',
  'GET /admin/merge-candidates': 'admin.data.customers',
  'POST /admin/merge-candidates/:id/resolve': 'admin.data.customers',
  'GET /admin/collisions': 'admin.data.customers',
  'GET /admin/fans': 'admin.data.customers',

  // ── 审计与登录日志 ───────────────────────────────────────
  // 里面是超管的 IP 和操作序列，泄露出去等于给攻击者画地图
  'GET /admin/logs': 'admin.secret.audit',
  'GET /admin/accounts': 'admin.admin.list',

  // ── 充值 / 对账 ──────────────────────────────────────────
  'GET /admin/recharges': 'admin.read.recharge',
  'POST /admin/recharges/status': 'admin.money.write',
  'GET /admin/recharge-exceptions': 'admin.read.recharge',
  'POST /admin/recharge-exceptions/resolve': 'admin.money.write',

  // ── 翻译通道 ─────────────────────────────────────────────
  'GET /admin/engines': 'admin.read.engine',
  'POST /admin/engines/save': 'admin.write.engine',
  'POST /admin/engines/active': 'admin.write.engine',
  'GET /admin/translate/logs': 'admin.read.translate',

  // ── 站点内容 / 套餐 ──────────────────────────────────────
  'GET /admin/packages': 'admin.read.package',
  'POST /admin/packages/save': 'admin.money.write',      // 改价格
  'POST /admin/packages/retire': 'admin.money.write',    // 下架 = 影响可售商品
  'GET /admin/faqs': 'admin.read.faq',
  'POST /admin/faqs/save': 'admin.write.content',
  'GET /admin/links': 'admin.read.faq',
  'GET /admin/clients': 'admin.write.content',
  'POST /admin/clients/save': 'admin.write.content',

  // ── 仪表盘 ───────────────────────────────────────────────
  'GET /admin/stats': 'admin.read.overview'
}

/**
 * 高危能力：除了角色，还要求**当场重新认证**。
 *
 * 理由：这些能力一旦被滥用就是接管平台。会话被偷（XSS、共享电脑没退出）
 * 时，攻击者不该能直接用它建新超管、改商户密码。
 *
 * **只对写操作强制**（`requiresReauth` 里按方法区分）。早期版本对 GET 也强制，
 * 导致 11 个只读接口回 428、后台页面全空白 —— 详见 requiresReauth 的注释。
 */
const HIGH_RISK_CAPS = new Set([
  'admin.admin.write',
  'admin.admin.list',
  'admin.money.write',
  'admin.secret.mail',
  'admin.secret.ops',
  'admin.secret.audit',
  'admin.data.customers'
])

/**
 * 除能力校验之外，这次调用是否还需要**当场二次认证**（带密码重证）。
 *
 * ## 规则：只看写操作
 *
 * 高危能力的原始构想是防「会话被偷」—— 攻击者拿到一个还活着的 cookie，
 * 不该能建超管、改商户密码。这些动作有个共同点：**会改变系统状态**。
 *
 * 而 `GET /admin/mail`、`GET /admin/users`、`GET /admin/customers` 这类
 * 只是把数据读出来展示。它们确实敏感（所以能力本身仍然只有超管拿得到），
 * 但要求每次翻页都输密码并不现实 —— 2026-10-23 的后果是所有相关页面
 * 直接 428 空白，运维误以为数据丢了。
 *
 * 换句话说：
 *   · 角色校验  = 防「权限不够的人」（operator / 未登录）
 *   · 二次认证  = 防「有权限但会话被偷」（写操作才值得付出输密码的代价）
 *
 * @param {string} method HTTP 方法
 * @param {string} cap    该路由声明的能力
 * @returns {boolean}
 */
function requiresReauth (method, cap) {
  if (!HIGH_RISK_CAPS.has(cap)) return false
  const m = String(method || '').toUpperCase()
  // HEAD / OPTIONS 是探测，不是动作
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false
  return true
}

/**
 * 查一个路由需要什么能力。
 *
 * @param {string} method HTTP 方法（大写）
 * @param {string} path   路由模板，如 '/admin/users/:id'
 * @returns {string|null} 能力名；null 表示未声明
 */
function capabilityFor (method, path) {
  // 路由模板可能带挂载前缀（mock 里是 '/apis/admin/staff/save'），
  // 能力表统一按不带前缀的形式登记（'/admin/staff/save'）。
  // 生产 router 里 req.path 本来就不带前缀，这里剥一次也不影响。
  const normalized = String(path || '').replace(/^\/apis(?=\/)/, '')
  return ROUTE_CAPS[`${String(method).toUpperCase()} ${normalized}`] || null
}

/**
 * 校验一次调用是否被允许。
 *
 * @param {{role:string}} admin  已登录的管理员
 * @param {string} cap           需要的能力
 * @returns {{allowed:boolean, reason?:string}}
 */
function allows (admin, cap) {
  if (!admin || !admin.role) {
    return { allowed: false, reason: 'NO_IDENTITY' }
  }
  if (admin.role === 'superadmin') return { allowed: true }
  if (OPERATOR_CAPS.has(cap)) return { allowed: true }
  return { allowed: false, reason: 'OPERATOR_DENIED' }
}

module.exports = {
  ROUTE_CAPS,
  OPERATOR_CAPS,
  HIGH_RISK_CAPS,
  capabilityFor,
  requiresReauth,
  allows
}
