#!/usr/bin/env node
'use strict'

/**
 * 补发套餐权益 —— 一次性修复脚本。
 *
 * ## 修的是什么
 *
 * 0.1.10 之前，结算**只加字符、从不发套餐**：`creditOrder` 与
 * `/admin/recharges/status` 两处都只调 `adjustChars`，谁都没碰 `users`
 * 的 `package_id / expires_at / port_limit / sub_quota`。
 *
 * 后果是订单明明「已支付」、`package_id` 也钉着 1，但商户那边：
 *   · 首页「套餐」一栏空白
 *   · 通道权益为空，翻译会被拒
 *   · 子账号额度 0，一个子账号都开不出来
 *
 * 代码已经补上了（`RechargeEntitlement`），但**已经发生过的订单不会自己补**
 * —— 那些订单早就是 `status=1` 的终态，入账链路在状态跃迁处就短路了，
 * 再怎么重跑扫描或点「确认收款」都进不到发权益那一步。
 * 这个脚本就是给这批历史订单补课。
 *
 * ## 为什么只补权益、不补字符
 *
 * 字符这条链路本来就是好的，历史订单的字符**都已经到账**。
 * 这里再调一次 `adjustChars` 就是凭空多发一份钱。所以脚本只调
 * `grantFromOrder`，绝不碰余额。
 *
 * ## 怎么判断"这单发过了"
 *
 * 看 `audit_logs` 里有没有这条订单的「发放套餐权益」记录 ——
 * 那是 `grantFromOrder` 唯一的落库痕迹，两条入账链路（链上自动、
 * 超管手工确认）都会写，所以它是个可靠且**唯一**的幂等标记。
 *
 * 不拿「`users.package_id` 是否为空」判断：老客户买第二单时
 * `package_id` 本来就不为空，但新订单的权益照样可能没发 —— 那种会漏修。
 *
 * ## 用法
 *
 *   node scripts/backfill-package-entitlement.js                 # 预演，只报告不写库
 *   node scripts/backfill-package-entitlement.js --apply         # 补发全部待补订单
 *   node scripts/backfill-package-entitlement.js --apply --id=20 # 只补订单 20
 *
 * 默认预演。理由：这是在改生产上「谁拥有什么权益」的数据，
 * 写错一次就是把套餐白送给客户，或者把到期时间算错。必须先看清单再动手。
 *
 * `--id` 用来把范围收到单单一张订单上 —— 线上更常见的诉求是
 * "客户投诉了这一单，就补这一单"，而不是全库扫一遍。
 *
 * 退出码：0 全部成功；1 有失败（供 cron / 告警感知）。
 */

const config = require('../server/config')

/** 默认预演 —— 不加 --apply 就不动数据 */
const APPLY = process.argv.includes('--apply')

/**
 * `--id=<订单ID>`：只处理这一单；不填则扫描全库待补订单。
 *
 * 刻意只支持按**主键**收窄，不支持按订单号或用户名 —— 主键唯一，
 * 不会有"模糊匹配顺手改了第二张单"这种事。
 */
function parseOnlyId(argv) {
  // 显式挡下 `--id 20` 这种写法。如果只是"没找到 --id= 就返回 null"，
  // 它会静默退化成全库扫描 —— 用户以为只补一单，实际改了全库。
  // 这种错一定要响，不能悄悄发生。
  if (argv.includes('--id')) {
    throw new Error('--id 必须写成 --id=<订单ID>（等号形式），不要用空格分隔')
  }
  const flag = argv.find(arg => arg.startsWith('--id='))
  if (!flag) return null
  const value = Number(flag.slice('--id='.length))
  if (!Number.isInteger(value) || value <= 0) {
    // 参数写错就抛错退出，**绝不能**退回 null 去跑全库 ——
    // 那会把"我只想补一单"变成"我改了全库"，方向刚好相反。
    throw new Error(`--id 必须是正整数订单 ID，收到: ${flag.slice('--id='.length)}`)
  }
  return value
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

/**
 * 找出「已支付、是套餐单、但权益从未发放」的订单。
 *
 * 幂等标记见文件头：拿 audit_logs 的「发放套餐权益」记录当"发过了"的凭据。
 * `LIKE '%' || order_number || '%'` 是安全的：订单号是
 * `HP` + 毫秒时间戳那种长串，彼此不会互为子串。
 *
 * `$1` 为 NULL 时不加主键限制（扫全库）；否则只看那一单。
 */
const FIND_SQL = `
  SELECT r.*
    FROM recharges r
   WHERE r.kind = 'package'
     AND r.status = 1
     AND r.package_id IS NOT NULL
     AND ($1::bigint IS NULL OR r.id = $1)
     AND NOT EXISTS (
       SELECT 1 FROM audit_logs a
        WHERE a.action = '发放套餐权益'
          AND a.detail->>'message' LIKE '%' || r.order_number || '%'
     )
   ORDER BY r.id`

async function main() {
  const onlyId = parseOnlyId(process.argv.slice(2))

  const { Pool } = require('pg')
  const { ProductionRepository, mapRow } = require('../server/repositories/production-repository')
  const { RechargeEntitlement } = require('../server/services/recharge-entitlement')

  const pool = new Pool({
    connectionString: config.database.connectionString,
    ssl: config.database.ssl,
    max: 2,
    applicationName: 'hello-pix-backfill-entitlement'
  })
  const repo = new ProductionRepository(pool)
  // 复用生产同一份发放逻辑 —— 补发出来的权益必须和今后自动入账**完全一致**，
  // 所以这里绝不允许有第二套实现。
  const entitlement = new RechargeEntitlement(repo)

  log(APPLY ? '模式: APPLY（会真正写入）' : '模式: DRY-RUN（只报告，不写任何数据）'
    + (onlyId ? `；范围: 仅订单 ${onlyId}` : '；范围: 全库待补订单'))

  let orders
  try {
    const found = await pool.query(FIND_SQL, [onlyId])
    orders = found.rows.map(mapRow)
  } catch (error) {
    await pool.end().catch(() => {})
    throw error
  }

  if (!orders.length) {
    log(onlyId
      ? `订单 ${onlyId} 不需要补发（不是已支付的套餐单，或权益已经发过了）`
      : '没有需要补发的套餐订单 —— 所有已支付的套餐单都已发放权益')
    await pool.end()
    return 0
  }

  log(`发现 ${orders.length} 笔待补发的套餐订单:`)
  for (const order of orders) {
    log(`  · 订单 ${order.orderNumber}（id=${order.id}）商户 ${order.userId} `
      + `套餐 ${order.packageId} ×${order.quantity || 1} 个月，支付于 ${order.paidAt || '(未知)'}`)
  }

  let granted = 0
  let failed = 0
  try {
    for (const order of orders) {
      // 一单一个事务：某单失败（比如套餐已被删）不能让其他单跟着回滚
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // 起算时刻取**支付时刻**而不是现在：客户是按那天付的钱，
        // 到期日就该从那天算。否则补发得越晚，客户亏得越多。
        const at = order.paidAt || new Date()
        const result = await entitlement.grantFromOrder(client, order, { at })
        if (APPLY) await client.query('COMMIT')
        else await client.query('ROLLBACK')
        granted += 1
        log(`  ✓ 订单 ${order.orderNumber} → 商户「${result.username}」 `
          + `套餐「${result.packageTitle}」×${result.months} 个月，`
          + `子账号额度 ${result.subQuota}，到期 ${new Date(result.expiresAt).toISOString()}`
          + (APPLY ? '' : '  [预演，已回滚]'))
      } catch (error) {
        failed += 1
        try { await client.query('ROLLBACK') } catch (_e) { /* 回滚失败交给上层 */ }
        log(`  ✗ 订单 ${order.orderNumber} 补发失败: ${(error && error.message) || error}`)
      } finally {
        client.release()
      }
    }
  } finally {
    await pool.end().catch(() => {})
  }

  log(APPLY
    ? `补发完成: 成功 ${granted} 笔，失败 ${failed} 笔`
    : `预演完成: 可补发 ${granted} 笔，失败 ${failed} 笔 —— 加 --apply 才会真正写入`)

  return failed ? 1 : 0
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code || 0 })
    .catch(error => {
      console.error('补发脚本异常:', (error && error.stack) || error)
      process.exitCode = 1
    })
}

module.exports = { main, FIND_SQL, parseOnlyId }
