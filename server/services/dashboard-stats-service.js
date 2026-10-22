'use strict'

/**
 * 超管总览（`GET /admin/stats`）的数据组装。
 *
 * ## 为什么从路由里搬出来
 *
 * 这段原本是 `admin.js` 里 83 行的内联 handler。它不长的部分不是代码，
 * 而是**统计口径**：哪些数字算"商户"、进粉数怎么数、毛利怎么算、
 * 币种符号从哪来。这些决定埋在路由的 SQL 里时，想加一个指标就得改路由文件，
 * 而这正是每天运营睁眼就要看的页面。
 *
 * 搬出来之后，路由只剩一行 `res.json(await stats.overview())`，
 * 口径集中在下面 —— 加指标改这一个文件，测试也只测这一个文件。
 *
 * ## 契约：字段名就是前端契约
 *
 * 返回对象的键名被 `AdminDashboard.vue` / `AdminTranslate.vue` / `AdminEngines.vue`
 * 直接读取（`s.grossProfit` / `s.rechargePendingStale` …）。
 * `mapRow` 会把 SQL 的 `user_count` 折成 `userCount`，所以**别改别名**，
 * 也别在这里补一层自己的命名转换 —— 两层转换叠起来就没人说得清谁对谁错。
 *
 * 加指标时只允许**新增**键，不许改已有键名（前端会静默变 `undefined`，
 * 卡片显示 0，看起来像"数据没了"而不是"代码错了"）。
 */

const { mapRow, mapRows } = require('../repositories/production-repository')
const { setting: settingOf } = require('../lib/mailer')

/** 币种 → 符号。与「系统设置 → 价格货币」保持一致，缺省按 USD 处理。 */
const CURRENCY_SYMBOLS = { USD: '$', CNY: '¥', HKD: 'HK$', JPY: '¥', EUR: '€' }

/** 最近记录列表的条数。多一屏没意义，少一条又看不出趋势。 */
const RECENT_LIMIT = 6

class DashboardStatsService {
  /**
   * @param {object} repo ProductionRepository
   */
  constructor(repo) {
    if (!repo || typeof repo.query !== 'function') {
      throw new TypeError('DashboardStatsService 需要 repo.query')
    }
    this.repo = repo
  }

  /**
   * 总览统计。
   *
   * @returns {Promise<object>} 前端直接消费的扁平对象（见文件头契约）
   */
  async overview() {
    const [counts, settings] = await Promise.all([
      this.repo.query(this.countsSql()),
      this.repo.settings()
    ])

    // 三张表 + 当前通道：彼此独立，并发取
    const [recentTranslates, recentAudits, engineRow] = await Promise.all([
      this.repo.query(
        `SELECT t.id, t.chars, ROUND(t.cost_amount,6) AS cost, ROUND(t.sell_amount,6) AS sell, t.snippet,
                t.engine_id AS engine, t.created_at AS create_time,
                (t.source_language||'→'||t.target_language) AS direction, u.username
           FROM translate_logs t JOIN users u ON u.id=t.user_id
          ORDER BY t.id DESC LIMIT $1`,
        [RECENT_LIMIT]
      ),
      this.repo.query(
        `SELECT id, actor AS admin, action, COALESCE(detail->>'message','') AS detail, created_at AS create_time
           FROM audit_logs ORDER BY id DESC LIMIT $1`,
        [RECENT_LIMIT]
      ),
      this.activeEngine(settings)
    ])

    const stats = mapRow(counts.rows[0])

    return Object.assign(stats, {
      grossProfit: this.grossProfit(stats),
      recentTranslates: mapRows(recentTranslates.rows),
      recentAudits: mapRows(recentAudits.rows),
      activeEngine: engineRow ? engineRow.name : '',
      engineCostPerMillion: engineRow ? engineRow.costPerMillion : null,
      packageBill: await this.packageBill(settings)
    })
  }

  /**
   * 计数 SQL。
   *
   * 单独抽成方法是为了让口径**可读**：每一行前面都写清"这个数字代表什么"，
   * 而不是让下一个人从 SQL 反推产品意图。
   *
   * 注意：所有 `count(*)` 都强转 `::int`。pg 的 count 是 bigint，
   * node-pg 会把它当字符串返回，前端 `(s.subCount || 0)` 拿到的就是 `"12"`，
   * 拼字符串时看着没问题，一做加减就变成 `"12"+1 === "121"`。
   * 金额类用 `::numeric` / `::bigint`，前端 `Number()` 转换是安全的。
   */
  countsSql() {
    return `SELECT
       (SELECT count(*) FROM users)::int AS user_count,
       (SELECT count(*) FROM users WHERE status=1)::int AS active_users,
       (SELECT count(*) FROM users WHERE enterprise)::int AS enterprise_users,
       (SELECT count(*) FROM sub_accounts WHERE deleted_at IS NULL)::int AS sub_count,

       -- 进粉的口径必须与「进粉统计」页（/admin/fans）完全一致：
       -- 那个页面的 total 就是 conversations JOIN users 的行数（新客户模型）。
       -- 早先这里数的是 order_fans —— 那是随工单一起下线的表，恒为 0，
       -- 结果就是"卡片显示 0、点进页面有数据"的经典错位。
       (SELECT count(*) FROM conversations c JOIN users u ON u.id=c.user_id)::int AS fan_count,

       (SELECT COALESCE(sum(hits),0) FROM short_links)::int AS short_link_hits,
       (SELECT COALESCE(sum(char_balance),0) FROM users)::bigint AS char_balance,
       (SELECT COALESCE(sum(chars),0) FROM translate_logs)::bigint AS char_used,
       (SELECT ROUND(COALESCE(sum(paid_amount),0),2) FROM recharges WHERE status=1)::numeric AS recharge_sum,
       (SELECT count(*) FROM recharges WHERE status=1)::int AS recharge_count,
       (SELECT ROUND(COALESCE(sum(cost_amount),0),4) FROM translate_logs)::numeric AS translate_cost,
       (SELECT ROUND(COALESCE(sum(sell_amount),0),4) FROM translate_logs)::numeric AS translate_sell,

       -- 有效待支付：还在有效期内、真的还能付款的单
       (SELECT count(*) FROM recharges r
         WHERE r.status=0 AND r.expires_at > now())::int AS recharge_pending,

       -- 惰性过期：库里仍写着 status=0，其实早就过期了。
       -- 这些必须从"待支付"里剔除，否则运营会去催一批根本付不了的单。
       (SELECT count(*) FROM recharges r
         WHERE r.status=0 AND r.expires_at <= now())::int AS recharge_pending_stale`
  }

  /**
   * 毛利估算 = 累计实收 − 累计通道成本。
   *
   * 两者现在都是美元（迁移 032 把 `cost_amount` 的单位统一成了美元），可以直接相减。
   * 它是**估算**不是会计结果：实收按订单口径、成本按字符口径，
   * 两者不是同一个时间切片。任何把它当财报用的改动都是错的 ——
   * 前端卡片文案里已注明"估算"。
   *
   * 用 `Math.round(x * 100) / 100` 而不是 `toFixed(2)`：
   * toFixed 返回字符串，前端再拿去相减就变成字符串拼接。
   */
  grossProfit(stats) {
    const received = Number(stats.rechargeSum || 0)
    const cost = Number(stats.translateCost || 0)
    return Math.round((received - cost) * 100) / 100
  }

  /**
   * 当前通道：先取「后台设置的默认通道」，没配就退回第一个已接通且启用的。
   *
   * `ORDER BY (id=$1) DESC` 让"恰好是配置的那个"排第一，
   * 这样一条 SQL 同时覆盖了"配了"和"没配"两种情况。
   * 返回的是整行（需要 name 和 costPerMillion），由调用方取字段。
   */
  async activeEngine(settings) {
    const configured = String(settingOf(settings, 'translation.active_engine', '') || '').trim()
    const result = await this.repo.query(
      `SELECT id, name, cost_per_million FROM engines
        WHERE ($1 <> '' AND id=$1) OR ($1 = '' AND wired AND enabled)
        ORDER BY (id=$1) DESC, id LIMIT 1`,
      [configured]
    )
    return result.rows[0] || null
  }

  /**
   * 套餐文案，例如 `基础版 $200/50万 · 专业版 $500/200万`。
   *
   * 币种符号必须跟「系统设置 → 价格货币」一致，
   * 否则会出现"套餐 ¥200"而全站别的金额都是 $ 的错位。
   */
  async packageBill(settings) {
    const currency = String(settingOf(settings, 'billing.currency', 'USD') || 'USD').toUpperCase()
    const symbol = CURRENCY_SYMBOLS[currency] || '$'
    const packages = (await this.repo.query(
      'SELECT title, price, included_chars FROM packages WHERE active ORDER BY sort_order, id'
    )).rows
    return packages
      .map(p => `${p.title} ${symbol}${p.price}/${Number(p.includedChars || 0) / 10000}万`)
      .join(' · ')
  }
}

module.exports = { DashboardStatsService, CURRENCY_SYMBOLS, RECENT_LIMIT }
