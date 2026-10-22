'use strict'

/**
 * 充值结算核心。**所有余额变化的唯一入口。**
 *
 * ## 铁律
 *
 * ```
 *   ChainWatcher  ──发现并标准化链上交易──▶  RechargeSettlementService
 *                                                    │
 *                                                    ▼
 *                                          锁订单 → 校验 TXID 唯一
 *                                          → pending→paid → 发放字符
 *                                          → 充值流水 → 字符流水
 *                                          → 审计 → COMMIT
 * ```
 *
 * ChainWatcher 自己**绝不**调 `adjustChars`、绝不改订单状态。
 * 它只回答"链上发生了什么"；"该不该动钱"由这里决定。
 * 把这两件事分开，是为了让资金路径只有一条、也只有一处需要审。
 *
 * ## 幂等锚点是 TXID，不是订单号，也不是扫描时间
 *
 * `chain_transactions.tx_id` 唯一。同一笔链上交易无论被看到多少次
 * （补扫、重启、并发），第二次开始直接短路 —— 不报错、不入账。
 *
 * ## Shadow / Dry-run
 *
 * `AUTO_SETTLEMENT_ENABLED=false` 时，本服务会把链路完整走一遍并**记录结论**，
 * 但绝不改余额、绝不改订单状态。记录里写清"如果开启自动结算本来会做什么"。
 * 先证明看得准，再允许动钱。
 *
 * ## 异常一律不入账
 *
 * 少付、多付、错代币、错地址、过期到账、无法匹配、重复付款、重复 TXID
 * —— 全部进 `recharge_exceptions` 等人工处理。
 * 宁可让钱躺在异常池里被人看见，也不能自动发字符出去：
 * 发错了再收回，用户那边已经是既成事实。
 */

const { ApiError } = require('../lib/http')
const { mapRow } = require('../repositories/production-repository')
const { RechargeAmountService } = require('./recharge-amount-service')
const { RechargeEntitlement } = require('./recharge-entitlement')
const { STATUS: RECHARGE_STATUS, statusText, assertTransition } = require('./recharge-state')
const { checkTransferEligibility } = require('./tron/transfer')
const { formatMilli, toMilli } = require('../lib/money')
const nearAmount = require('../lib/near-amount')
const { NETWORK, OUTCOME, MATCH_KIND, EXCEPTION_KIND } = require('./recharge-settlement-constants')
const verdicts = require('./recharge/settlement-verdicts')

/**
 * pg 的 numeric 列出来是字符串（"65.318"）。转成毫 USDT 的 BigInt。
 *
 * 用 `toMilli` 而不是 `parseMilli`：这里拿到的是**人类可读金额**，
 * 不是已经是毫的值。两者差 1000 倍，用错会让订单金额静默放大一千倍。
 *
 * 空值返回 null —— 「没有尾数」和「尾数是 0」在判断依据上是两件事：
 * 早期订单没有 surcharge_amount，不能拿 0 去参与笔误比对。
 */
function milliFromNumeric(value) {
  if (value === null || value === undefined || value === '') return null
  return toMilli(String(value)).toString()
}

class RechargeSettlementService {  constructor(repo, options) {
    const opts = options || {}
    this.repo = repo
    this.amountService = opts.amountService || new RechargeAmountService()
    /**
     * 套餐权益发放。字符与套餐是**两件事**：字符走 `adjustChars`，
     * 套餐（package_id / 到期时间 / 通道权益 / 子账号额度）走这里。
     * 早期只发字符不发套餐，导致"付了钱、订单已支付，但商户端没有套餐、
     * 也开不了子账号"。
     */
    this.entitlement = opts.entitlement || new RechargeEntitlement(repo)
    /**
     * 自动结算总闸。默认 **关闭**。
     * 关闭时走 Shadow：照常匹配、照常记录，但不动任何余额。
     * 只有显式配置 AUTO_SETTLEMENT_ENABLED=true 才会真正入账。
     */
    this.autoSettlementEnabled = opts.autoSettlementEnabled === true
    this.expectedTokenContract = opts.tokenContract || undefined
  }

  get mode() {
    return this.autoSettlementEnabled ? 'live' : 'shadow'
  }

  /**
   * 处理一条链上转账。**调用方必须已开启事务**，且必须在同一事务里推进游标。
   *
   * @returns {Promise<{
   *   outcome: OUTCOME.SETTLED|'SHADOW_MATCHED'|'DUPLICATE'|'EXCEPTION',
   *   matchKind: string,
   *   rechargeId: number|null,
   *   exceptionKind: string|null,
   *   detail: object
   * }>}
   */
  async handleTransfer(client, transfer, context) {
    const ctx = context || {}

    // ---- ⓪ 事件位置未知就直接跳过 ----
    //
    // 一笔交易可以有多个 Transfer 事件，(txId + eventIndex) 才是完整身份。
    // 位置拿不到时**绝不落库**：落成 eventIndex=0 会把"未知"伪装成"第一个事件"，
    // 后续真正的事件 0 到来时就会撞上它被静默丢掉。
    // 调用方看到这个结论必须跳过该条、且不推进游标越过它。
    if (transfer.eventIndex === null || transfer.eventIndex === undefined) {
      return verdicts.skipUnresolved(transfer, '事件位置未知（交易回执未取到）')
    }

    // ---- ① 先落库占住事件身份。这一步就是幂等锚点 ----
    const recorded = await this.recordTransaction(client, transfer, { mode: this.mode })
    if (!recorded.inserted) {
      // 这笔链上交易已经见过。**绝不产生任何余额变化**，也不报错。
      return verdicts.duplicateEvent(recorded)
    }

    // ---- ② 资格过滤：代币、地址、金额精度 ----
    const eligibility = checkTransferEligibility(transfer, {
      tokenContract: this.expectedTokenContract,
      toAddress: ctx.toAddress
    })
    if (!eligibility.ok) {
      return this.rejectWithException(client, transfer, recorded.id,
        verdicts.ineligible(this, transfer, eligibility, ctx))
    }

    // ---- ③ 匹配候选订单 ----
    const match = await this.matchCandidate(client, transfer)

    if (match.kind === MATCH_KIND.NO_MATCH) {
      // 先找「疑似归属」再下结论：金额精确匹配失败不等于这笔钱与平台无关，
      // 最常见的原因是商户抄错数字。疑似结果**只提示不裁决**。
      const suspicion = await this.suspectCandidates(client, transfer)
      return this.rejectWithException(client, transfer, recorded.id,
        verdicts.noMatch(this, transfer, suspicion))
    }

    if (match.kind === MATCH_KIND.LATE_PAYMENT) {
      return this.rejectWithException(client, transfer, recorded.id,
        verdicts.latePayment(transfer, match))
    }

    // ---- ③′ 同一 TXID 已结算过别的订单 → 进异常池，不自动发放 ----
    //
    // 一笔交易里可以有多个 Transfer 事件（合约中转、批量转账）。
    // 若其中两个都指向平台地址且金额各自匹配上了订单，
    // 钱其实只有一笔 —— 自动发放会把一次付款记成两次充值。
    //
    // 规则：**一个 TXID 最多结算一张订单**，其余全部进异常池等人工判断。
    const sameTx = await this.settledBySameTx(client, transfer, recorded.id)
    if (sameTx) {
      return this.rejectWithException(client, transfer, recorded.id,
        verdicts.duplicateTxid(transfer, match, sameTx))
    }

    // ---- ④ 精确匹配 ----
    if (!this.autoSettlementEnabled) {
      // Shadow：只记录"本来会做什么"，不动余额、不改订单状态
      const shadow = verdicts.shadowMatched(transfer, match.order)
      await this.finalizeTransaction(client, recorded.id, shadow.transactionPatch)
      return shadow.result
    }

    // ---- ⑤ 真实入账 ----
    const settled = await this.creditOrder(client, {
      transfer, order: match.order, reservation: match.reservation
    })
    const final = verdicts.settled(transfer, match.order, settled)
    await this.finalizeTransaction(client, recorded.id, final.transactionPatch)
    return final.result
  }

  /**
   * 异常闸门的统一出口：写异常池 → 落终态 → 返回结论。
   *
   * 拆 `handleTransfer` 的真正理由就在这里 —— 这四步以前在五个闸门里
   * 各抄一遍，每条分支的 `finalizeTransaction` 参数还不完全一样。
   * 漏改一处就等于"钱进了异常池但链上记录还是 seen"，对账时看起来
   * 像"还在处理中"，实际上永远不会再被处理。
   */
  async rejectWithException(client, transfer, transactionId, verdict) {
    await this.recordException(client, transfer, verdict.exception)
    await this.finalizeTransaction(client, transactionId, verdict.transactionPatch)
    return verdict.result
  }

  // ---------------------------------------------------------------- 落库

  /**
   * 记录链上交易。`tx_id` 唯一 —— 插入 0 行即代表"已经见过"。
   *
   * 这是**重复扫描不重复入账**的底座：补扫、重启、并发都会撞在这里，
   * 撞上就短路，不报错也不入账。
   */
  async recordTransaction(client, transfer, info) {
    // 身份是**事件级**的：(链, 代币合约, 交易哈希, 事件下标)。
    // 只用 tx_id 会让"同一交易的第二个 Transfer 事件"被静默吞掉。
    const { rows } = await client.query(
      `INSERT INTO chain_transactions
         (network, tx_id, event_index, token_contract, from_address, to_address, amount_milli,
          block_number, block_timestamp, confirmations, solidified, status, mode, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11,'seen',$12,$13::jsonb)
       ON CONFLICT (network, token_contract, tx_id, event_index)
         WHERE event_index IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        NETWORK,
        transfer.txId,
        transfer.eventIndex,
        transfer.tokenContract,
        transfer.fromAddress,
        transfer.toAddress,
        transfer.amountMilli.toString(),
        transfer.blockNumber,
        new Date(transfer.blockTimestamp).toISOString(),
        transfer.confirmations === undefined || transfer.confirmations === null ? 0 : transfer.confirmations,
        transfer.solidified,
        (info && info.mode) || this.mode,
        JSON.stringify(transfer.raw || {})
      ]
    )
    if (rows[0]) return { inserted: true, id: rows[0].id, existingRechargeId: null, existingMode: null }

    // 已存在：取出原记录，供上层判断"这个事件当初是以什么身份处理的"
    const existing = await client.query(
      `SELECT id, recharge_id, mode, status FROM chain_transactions
        WHERE network=$1 AND token_contract=$2 AND tx_id=$3 AND event_index=$4`,
      [NETWORK, transfer.tokenContract, transfer.txId, transfer.eventIndex]
    )
    const row = existing.rows[0] || {}
    return {
      inserted: false,
      id: row.id || null,
      existingRechargeId: row.recharge_id || null,
      existingMode: row.mode || null,
      existingStatus: row.status || null
    }
  }

  /**
   * 同一 TXID 是否已经结算过**另一张**订单。
   *
   * 规则：**一个 TXID 最多结算一张订单**。若同一交易里有多个都指向平台的
   * Transfer 事件，第一个正常入账，其余的进异常池等人工判断 ——
   * 自动发放的话，一笔钱可能被记成两次充值。
   */
  async settledBySameTx(client, transfer, selfId) {
    const { rows } = await client.query(
      `SELECT recharge_id, event_index
         FROM chain_transactions
        WHERE network=$1 AND tx_id=$2 AND recharge_id IS NOT NULL AND id <> $3
        ORDER BY event_index NULLS LAST
        LIMIT 1`,
      [NETWORK, transfer.txId, String(selfId || 0)]
    )
    return rows[0] || null
  }

  /** 链标识。将来接别的链时改成从 transfer 上取 */
  get network() { return NETWORK }

  async finalizeTransaction(client, id, patch) {
    if (!id) return
    await client.query(
      `UPDATE chain_transactions
          SET status=$2, match_kind=$3, recharge_id=$4, shadow_action=$5::jsonb,
              settled_at=$6
        WHERE id=$1`,
      [
        id,
        patch.status,
        patch.matchKind || null,
        patch.rechargeId === null || patch.rechargeId === undefined ? null : String(patch.rechargeId),
        patch.shadowAction ? JSON.stringify(patch.shadowAction) : null,
        patch.settledAt ? patch.settledAt.toISOString() : null
      ]
    )
  }

  // ---------------------------------------------------------------- 匹配

  /**
   * 找这笔金额归属哪张订单。
   *
   * 走金额预约表（含已 released 的历史行）—— 这正是迟到款能找回原订单的依据。
   * 只查 held 的话，保护期外的老订单就彻底查不到了。
   *
   * **有效期以「链上交易发生的时间」为准，不是「我们发现它的时间」。**
   * 用户在前 29 分钟转出、链上 31 分钟才确认，那是有效支付，不该判过期。
   */
  async matchCandidate(client, transfer) {
    const reservation = await this.amountService.lookupByAmount(client, {
      payAddress: transfer.toAddress,
      tokenContract: transfer.tokenContract,
      amountMilli: transfer.amountMilli
    })
    if (!reservation || !reservation.recharge_id) {
      return { kind: MATCH_KIND.NO_MATCH, reservation: null, order: null, reason: '金额无归属' }
    }

    const found = await client.query('SELECT * FROM recharges WHERE id=$1', [reservation.recharge_id])
    const order = mapRow(found.rows[0])
    if (!order) {
      return { kind: MATCH_KIND.NO_MATCH, reservation, order: null, reason: '预约指向的订单不存在' }
    }

    if (Number(order.status) !== RECHARGE_STATUS.PENDING) {
      return {
        kind: MATCH_KIND.LATE_PAYMENT, reservation, order,
        reason: `订单已是「${statusText(Number(order.status))}」`
      }
    }

    const txTime = new Date(transfer.blockTimestamp)
    if (order.expiresAt && txTime.getTime() >= new Date(order.expiresAt).getTime()) {
      return { kind: MATCH_KIND.LATE_PAYMENT, reservation, order, reason: '链上交易时间晚于订单有效期' }
    }

    return { kind: MATCH_KIND.MATCHED, reservation, order, reason: '精确匹配' }
  }

  // ---------------------------------------------------------------- 入账

  /**
   * 真正的入账。**只有 live 模式会走到这里。**
   *
   * 全程在一个事务里，订单行 `FOR UPDATE` 串行化并发：
   * 链监听与用户「我已付款」同时命中同一单时，后到的那个会看到 status 已变，
   * 直接短路返回，不会重复发字符。
   */
  async creditOrder(client, { transfer, order, reservation }) {
    const found = await client.query('SELECT * FROM recharges WHERE id=$1 FOR UPDATE', [order.id])
    const locked = mapRow(found.rows[0])
    if (!locked) throw new ApiError(404, '订单不存在', 'RECHARGE_NOT_FOUND')

    if (Number(locked.status) === RECHARGE_STATUS.PAID) {
      // 已入账：不重复发字符，也不报错（补扫会走到这里）
      return { alreadyPaid: true, orderNumber: locked.orderNumber, chars: 0 }
    }
    assertTransition(Number(locked.status), RECHARGE_STATUS.PAID)

    const chars = Number(locked.chars)
    // 余额变化 **只经过这里**
    const updated = await this.repo.adjustChars(client, 'main', locked.userId, chars)
    await client.query(
      `INSERT INTO char_ledger
         (user_id, delta, balance_after, reason, reference_type, reference_id, idempotency_key, note)
       VALUES ($1,$2,$3,'recharge','recharge',$4,$5,$6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        String(locked.userId), String(chars), String(updated.charBalance),
        String(locked.id), `recharge:${locked.id}`,
        `链上自动入账 ${locked.orderNumber} tx:${transfer.txId}`
      ]
    )
    await client.query(
      `UPDATE recharges
          SET status=$2::smallint, paid_at=now(),
              terminal_at=now(), terminal_reason='chain_settled',
              provider_transaction_id=$3,
              chain_tx_id=$3, chain_seen_at=now(),
              chain_confirmations=$4,
              chain_block_number=COALESCE($5::bigint, chain_block_number),
              chain_from_address=$6,
              updated_at=now()
        WHERE id=$1`,
      [
        String(locked.id), RECHARGE_STATUS.PAID, transfer.txId,
        transfer.confirmations === undefined || transfer.confirmations === null ? 0 : transfer.confirmations,
        transfer.blockNumber, transfer.fromAddress
      ]
    )
    // 订单进终态 → 金额进 24 小时保护期
    await this.amountService.extendProtection(
      client, reservation && reservation.id ? reservation.id : locked.amountReservationId, new Date())
    // 套餐权益落地。
    // 只发字符不发套餐的话，商户端首页「套餐」是空的、通道权益是空的、
    // 子账号额度是 0 —— 也就是"充了钱但什么都没生效"。
    // 非套餐订单（纯字符充值 / 手工补单）在这里是 no-op，不会误改商户套餐。
    const entitlement = await this.entitlement.grantFromOrder(client, locked, { at: new Date() })
    // 系统动作：admin_id 为 NULL，actor 记为 system
    await this.repo.audit(client, null, '链上自动入账',
      `${locked.orderNumber} +${chars} 字符 tx:${transfer.txId}`
      + (entitlement.granted ? `；套餐「${entitlement.packageTitle}」×${entitlement.months} 个月已发放` : ''),
      null,
      { type: 'user', id: locked.userId })

    return {
      alreadyPaid: false,
      orderNumber: locked.orderNumber,
      chars,
      balanceAfter: Number(updated.charBalance),
      entitlement
    }
  }

  /**
   * 找「这笔钱最可能是哪张订单」的候选，供人工核对。
   *
   * ## 为什么限定在「近期、已付款或待付款」的订单上
   *
   * 候选池大了没有意义 —— 一张半年前的订单和今天的到账金额接近，
   * 只是巧合。同时必须包含**已支付**的订单：真实的笔误事故里，
   * 超管往往先手工确认收款，订单状态已经是 paid，链上那笔却还挂在异常池。
   * 只查 pending 会让这类已经人工处理过的单永远找不到对应关系。
   *
   * ## 绝不返回超过一条
   *
   * 两条候选同时成立时，说明金额本身不足以定位 —— 那时候人工看图更快，
   * 给出两个模糊候选反而让人以为系统"知道"是哪张。
   * 取置信度最高、差额最小的那条。
   *
   * @returns {Promise<object|null>} 可直接 JSON 化的提示对象
   */
  async suspectCandidates(client, transfer) {
    // 只对打到「近期用过或正在用」的收款地址的钱做疑似分析。
    // 打到已弃用旧地址的钱，金额再像也不是当前订单体系的钱 —— 那属于对账，
    // 不该被提示成"疑似某张订单"。
    if (transfer.toAddress) {
      const { rows: known } = await client.query(
        `SELECT 1 FROM recharges
          WHERE pay_address = $1 AND created_at >= now() - ($2 || ' hours')::interval
         UNION ALL
         SELECT 1 FROM recharge_amount_reservations
          WHERE pay_address = $1 AND reserved_at >= now() - ($2 || ' hours')::interval
         LIMIT 1`,
        [transfer.toAddress, String(nearAmount.LOOKBACK_HOURS)]
      )
      if (!known.length) return null
    }

    // ★ 候选池必须限定在**同一个收款地址与合约**上 ★
    //
    // 原来这里的 WHERE 只有 status + created_at，抓的是**全平台**近 72 小时的
    // 订单。后果：钱打到商户 A 的地址，金额却恰好接近商户 B 的某张订单，
    // 系统就提示"疑似 B 的订单 XX" —— 人工只要照着点「确认收款」，
    // 就把 A 付的钱记到了 B 的账上。两家的钱串了，而且事后从流水里看不出来
    // （异常记录写的是"笔误匹配"，不是"跨商户"）。
    //
    // 上面那段 pay_address 检查只回答了"要不要做疑似分析"，不回答
    // "哪些订单能进候选池"。near-amount.js 的契约里写得很清楚：
    // 「调用方必须自己限定这些订单都是同一收款地址与合约」。
    //
    // 合约列名是 pay_token_contract（见 migrations/027），不是 chain。
    const { rows } = await client.query(
      `SELECT id, order_number, status,
              paid_amount, surcharge_amount,
              (paid_amount - surcharge_amount) AS base_amount
         FROM recharges
        WHERE status IN ($1, $2)
          AND created_at >= now() - ($3 || ' hours')::interval
          AND ($4::text IS NULL OR pay_address = $4)
          AND ($5::text IS NULL OR pay_token_contract IS NULL OR pay_token_contract = $5)
        ORDER BY created_at DESC
        LIMIT 50`,
      [
        RECHARGE_STATUS.PENDING, RECHARGE_STATUS.PAID,
        String(nearAmount.LOOKBACK_HOURS),
        transfer.toAddress || null,
        transfer.tokenContract || transfer.contractAddress || null
      ]
    )
    if (!rows.length) return null

    const candidates = rows.map(row => ({
      id: String(row.id),
      orderNumber: row.order_number,
      status: Number(row.status),
      statusText: statusText(Number(row.status)),
      paidAmountMilli: milliFromNumeric(row.paid_amount),
      surchargeMilli: milliFromNumeric(row.surcharge_amount),
      baseMilli: milliFromNumeric(row.base_amount)
    }))

    const found = nearAmount.findCandidate({
      amountMilli: transfer.amountMilli,
      candidates
    })
    if (!found) return null

    return {
      kind: found.kind,
      confidence: found.confidence,
      orderId: found.order.id,
      orderNumber: found.order.orderNumber,
      orderStatus: found.order.status,
      orderStatusText: found.order.statusText,
      expectedMilli: found.order.paidAmountMilli,
      deltaMilli: found.deltaMilli.toString(),
      deltaText: nearAmount.formatDelta(found.deltaMilli),
      reason: found.reason,
      // 明确写死：人工确认前绝不自动入账
      autoSettle: false
    }
  }

  /**
   * NO_MATCH 的摘要文案。
   *
   * 有疑似归属时把线索写进摘要 —— 运维在列表页就能看到，
   * 不必点进 detail 才知道这笔钱可能属于谁。
   */
  noMatchSummary(transfer, suspicion) {
    const base = `金额 ${formatMilli(transfer.amountMilli)} USDT 不匹配任何订单`
    if (!suspicion) return base
    return `${base}；疑似订单 ${suspicion.orderNumber}（${suspicion.reason}，需人工确认）`
  }

  // ---------------------------------------------------------------- 异常池
  exceptionKindForEligibility(reason) {
    if (reason === 'WRONG_TOKEN') return EXCEPTION_KIND.WRONG_TOKEN
    if (reason === 'WRONG_ADDRESS') return EXCEPTION_KIND.WRONG_ADDRESS
    return EXCEPTION_KIND.NO_MATCH
  }

  eligibilitySummary(reason, transfer) {
    if (reason === 'WRONG_TOKEN') {
      return `代币合约不是指定 USDT：${transfer.tokenContract}`
    }
    if (reason === 'WRONG_ADDRESS') {
      return `收款地址不是平台地址：${transfer.toAddress}`
    }
    if (reason === 'AMOUNT_PRECISION_TOO_FINE') {
      return `金额精度比订单更细（余数 ${transfer.amountRemainder}），不可能精确匹配`
    }
    return `不符合入账条件：${reason}`
  }

  /**
   * 写异常池。`(tx_id, kind)` 部分唯一 —— 补扫反复看到同一笔时只留一条，
   * 否则池子会被同一笔交易刷屏，真正要处理的异常被淹没。
   */
  async recordException(client, transfer, info) {
    const { rows } = await client.query(
      `INSERT INTO recharge_exceptions
         (kind, tx_id, event_index, to_address, from_address, token_contract, amount_milli,
          block_number, block_timestamp, confirmations, recharge_id, reservation_id,
          detail, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8,$9,$10,$11,$12,$13::jsonb,$14)
       ON CONFLICT (tx_id, kind) WHERE tx_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        info.kind,
        transfer.txId,
        transfer.eventIndex,
        transfer.toAddress,
        transfer.fromAddress,
        transfer.tokenContract,
        transfer.amountMilli.toString(),
        transfer.blockNumber,
        new Date(transfer.blockTimestamp).toISOString(),
        transfer.confirmations === undefined || transfer.confirmations === null ? 0 : transfer.confirmations,
        info.rechargeId ? String(info.rechargeId) : null,
        info.reservationId ? String(info.reservationId) : null,
        JSON.stringify(info.detail || {}),
        String(info.summary || '').slice(0, 300)
      ]
    )
    return rows[0] ? rows[0].id : null
  }
}

module.exports = {
  RechargeSettlementService,
  MATCH_KIND,
  EXCEPTION_KIND,
  OUTCOME,
  NETWORK
}
