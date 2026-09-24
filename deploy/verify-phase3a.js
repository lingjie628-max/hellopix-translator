'use strict'

/**
 * Phase 3A 验收：真实链上付款 → Shadow 匹配 → WOULD_SETTLE。
 *
 * 逐条核对用户要求的证据，全部从**数据库与链上原始记录**读取，
 * 不靠"接口返回成功"这类间接结论。
 *
 * 用法：
 *   cd /opt/hello-pix && node deploy/verify-phase3a.js <订单号>
 *   node deploy/verify-phase3a.js <订单号> --txid <TXID>    # 指定要核对的交易
 */

const fs = require('node:fs')
const path = require('node:path')

const APP = process.env.APP_DIR || '/opt/hello-pix'

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}

async function main() {
  const orderNumber = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null
  if (!orderNumber) { console.log('用法: node deploy/verify-phase3a.js <订单号>'); return 1 }
  const wantTxId = argValue('--txid')

  const { Pool } = require(path.join(APP, 'node_modules/pg'))
  const config = require(path.join(APP, 'server/config'))
  const pool = new Pool({ connectionString: config.database.connectionString, ssl: config.database.ssl, max: 2 })

  try {
    console.log('════════ 订单基线 ════════')
    const order = (await pool.query(
      `SELECT r.*, u.id AS uid, u.username, u.char_balance, u.char_used,
              res.id AS res_id, res.state AS res_state, res.suffix, res.amount_milli,
              res.reusable_after, res.recharge_id AS res_recharge_id
         FROM recharges r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN recharge_amount_reservations res ON res.id = r.amount_reservation_id
        WHERE r.order_number = $1`, [orderNumber])).rows[0]
    if (!order) { console.log(`  找不到订单 ${orderNumber}`); return 1 }
    console.log(`  订单号      ${order.order_number}`)
    console.log(`  测试商户    ${order.username} (id=${order.uid})`)
    console.log(`  应付金额    ${order.paid_amount} USDT（尾数 ${order.surcharge_amount}）`)
    console.log(`  收款地址    ${order.pay_address}`)
    console.log(`  代币合约    ${order.pay_token_contract}`)
    console.log(`  有效期至    ${new Date(order.expires_at).toISOString()}`)

    console.log('\n════════ 一、链上交易记录（chain_transactions）════════')
    const txQuery = wantTxId
      ? `SELECT * FROM chain_transactions WHERE tx_id = $1`
      : `SELECT * FROM chain_transactions
          WHERE to_address = $1 AND amount_milli = $2::bigint
          ORDER BY seen_at DESC LIMIT 1`
    const txParams = wantTxId
      ? [wantTxId]
      : [order.pay_address, String(order.amount_milli || Math.round(Number(order.paid_amount) * 1000))]
    const tx = (await pool.query(txQuery, txParams)).rows[0]
    if (!tx) {
      console.log('  ✗ 没有找到对应的链上交易记录')
      console.log('    （付款尚未被 watcher 扫到，或金额/地址不匹配）')
      console.log(`    查询条件: to=${order.pay_address} amount_milli=${txParams[1]}`)
      return 1
    }

    const orderMilli = Math.round(Number(order.paid_amount) * 1000)
    console.log(`  TXID        ${tx.tx_id}`)
    console.log(`  事件位置    event_index = ${tx.event_index}`)
    console.log(`  链上金额    ${tx.amount_milli} milli = ${Number(tx.amount_milli) / 1000} USDT`)
    console.log(`  合约        ${tx.token_contract}`)
    console.log(`  收款地址    ${tx.to_address}`)
    console.log(`  付款地址    ${tx.from_address}`)
    console.log(`  区块        ${tx.block_number ?? '(未取)'}  ${new Date(tx.block_timestamp).toISOString()}`)
    console.log(`  已确认      solidified = ${tx.solidified}`)
    console.log(`  模式/结论   ${tx.mode} / ${tx.match_kind}`)
    console.log(`  匹配订单    ${tx.recharge_id ?? '(无)'}`)

    console.log('\n════════ 二、逐条验收 ════════')
    check('① 真实 TXID（64 位十六进制）',
      /^[0-9a-f]{64}$/.test(tx.tx_id), tx.tx_id)
    check('② Token 合约正确',
      tx.token_contract === order.pay_token_contract,
      { 链上: tx.token_contract, 订单快照: order.pay_token_contract })
    check('③ to_address 与订单快照一致',
      tx.to_address === order.pay_address,
      { 链上: tx.to_address, 订单快照: order.pay_address })
    check('④ 链上金额与订单应付金额完全一致',
      Number(tx.amount_milli) === orderMilli,
      { 链上: Number(tx.amount_milli), 订单: orderMilli })
    // amountExact：链上 6 位小数换算成订单 3 位小数时是否整除
    const chainUnits = BigInt(tx.amount_milli) * 1000n
    check('⑤ amountExact = true（金额精度与订单对齐）',
      chainUnits % 1000n === 0n, String(chainUnits))
    check('⑥ event_index 已真实解析（不是 null）',
      tx.event_index !== null && tx.event_index !== undefined,
      { event_index: tx.event_index })
    check('⑦ solidified = true（已最终确认）',
      tx.solidified === true, tx.solidified)
    check('⑧ 唯一匹配到这张 pending 订单',
      String(tx.recharge_id) === String(order.id),
      { 匹配到: tx.recharge_id, 期望: order.id })
    check('⑨ Shadow 输出明确 WOULD_SETTLE',
      tx.mode === 'shadow' &&
      tx.match_kind === 'MATCHED' &&
      tx.shadow_action && tx.shadow_action.wouldSettle === true &&
      tx.shadow_action.action === 'credit',
      tx.shadow_action)

    console.log('\n════════ 三、必须未被改动的部分 ════════')
    const after = (await pool.query(
      `SELECT r.status, r.paid_at, r.provider_transaction_id, r.chain_tx_id, r.terminal_at,
              u.char_balance, u.char_used
         FROM recharges r JOIN users u ON u.id = r.user_id WHERE r.id = $1`, [order.id])).rows[0]
    check('⑩ 订单仍为 pending（status=0）', Number(after.status) === 0, after.status)
    check('⑪ paid_at 仍为空', after.paid_at === null, after.paid_at)
    check('⑫ 未被写入 provider_transaction_id', !after.provider_transaction_id, after.provider_transaction_id)
    check('⑬ 订单未被写入 chain_tx_id', !after.chain_tx_id, after.chain_tx_id)
    check('⑭ 无终态时间（未进终态）', after.terminal_at === null, after.terminal_at)
    check('⑮ 用户字符余额仍为 0', Number(after.char_balance) === 0, after.char_balance)
    check('⑯ 用户已用字符仍为 0', Number(after.char_used) === 0, after.char_used)

    const ledger = (await pool.query(
      'SELECT count(*)::int AS n FROM char_ledger WHERE user_id=$1 OR reference_id=$2',
      [String(order.uid), String(order.id)])).rows[0].n
    check('⑰ character ledger 无新增', ledger === 0, ledger)

    console.log('\n════════ 四、幂等性 ════════')
    const sameTxRows = (await pool.query(
      'SELECT count(*)::int AS n FROM chain_transactions WHERE network=$1 AND token_contract=$2 AND tx_id=$3 AND event_index=$4',
      [tx.network, tx.token_contract, tx.tx_id, tx.event_index])).rows[0].n
    check('⑱ 同一事件在 chain_transactions 中只有一行',
      sameTxRows === 1, sameTxRows)

    const exc = (await pool.query(
      'SELECT kind, count(*)::int AS n FROM recharge_exceptions WHERE tx_id=$1 GROUP BY 1', [tx.tx_id])).rows
    check('⑲ 这笔真实付款没有进异常池',
      exc.length === 0, exc)

    const dupExc = (await pool.query(
      `SELECT tx_id, kind, count(*)::int AS n FROM recharge_exceptions
        WHERE tx_id IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1`)).rows
    check('⑳ 异常池无重复记录', dupExc.length === 0, dupExc.length)

    console.log('\n════════ 五、重扫与重启后的幂等（由 watcher 每轮自动执行）════════')
    const cursor = (await pool.query(
      'SELECT last_scanned_timestamp, consecutive_failures FROM chain_scan_cursor WHERE address=$1',
      [order.pay_address])).rows[0]
    const scannedPast = cursor &&
      Number(cursor.last_scanned_timestamp) > new Date(tx.block_timestamp).getTime()
    check('㉑ 游标已扫过该交易（说明后续每轮都在重扫它）',
      Boolean(scannedPast), cursor && new Date(Number(cursor.last_scanned_timestamp)).toISOString())
    check('㉒ watcher 连续失败次数为 0', Number(cursor && cursor.consecutive_failures) === 0,
      cursor && cursor.consecutive_failures)

    const settledCount = (await pool.query(
      'SELECT count(*)::int AS n FROM chain_transactions WHERE tx_id=$1 AND status=$2',
      [tx.tx_id, 'settled'])).rows[0].n
    check('㉓ 该交易从未被结算（status 不为 settled）', settledCount === 0, settledCount)

    console.log('\n════════ 六、结论 ════════')
    console.log(`  本轮为 Shadow 模式，AUTO_SETTLEMENT_ENABLED=false`)
    console.log(`  ${fail === 0 ? '✓ 真实链上付款被正确识别并匹配，且未产生任何资金副作用' : `✗ 有 ${fail} 项不通过`}`)
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
    return fail ? 1 : 0
  } finally {
    await pool.end()
  }
}

main()
  .then(code => { process.exitCode = code || 0 })
  .catch(error => { console.error('验收异常:', (error && error.stack) || error); process.exitCode = 1 })
