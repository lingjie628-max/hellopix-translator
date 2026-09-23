#!/usr/bin/env node
'use strict'

/**
 * ChainWatcher —— 链上收款扫描 worker。
 *
 * ## 职责边界（刻意画得很窄）
 *
 * 这个进程**只做三件事**：
 *   1. 从 Provider 拉取收款地址的转入
 *   2. 把标准化后的交易交给 RechargeSettlementService
 *   3. 在同一事务里推进扫描游标
 *
 * 它**不做**：改字符余额、改订单状态、判断该不该入账。
 * 那些全部在 `RechargeSettlementService` 里 —— 资金路径只有一条。
 *
 * ## 不丢单的两道保险
 *
 * **第一道：查询窗口的上界取「最终确认块的时间戳」。**
 * 不是取 `now`。这样返回的记录天然都是不可回滚的，
 * 未确认交易根本不会进入处理范围。
 *
 * **第二道：交易落库与游标推进在同一个事务里。**
 * 进程在 COMMIT 前挂掉，游标停在原处，下一轮重扫 ——
 * 重复由 `chain_transactions.tx_id` 唯一约束消解。
 * 宁可重复扫，也不能跳过未处理交易。
 *
 * 另外每次扫描还会从 `游标 - REWIND` 开始（见 scan-cursor.js），
 * 用一小段重复换掉边界风险。
 *
 * ## 用法
 *
 *   node scripts/recharge-watcher.js            # 扫描一轮后退出（cron 用）
 *   node scripts/recharge-watcher.js --dry      # 只报告将要做什么，不写任何数据
 *   node scripts/recharge-watcher.js --status   # 只打印游标与统计
 *
 * 退出码：0 正常；1 有失败（供 cron/告警感知）；2 配置缺失。
 */

const path = require('path')
const config = require('../server/config')

const DRY_RUN = process.argv.includes('--dry')
const STATUS_ONLY = process.argv.includes('--status')

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

async function main() {
  const { Pool } = require('pg')
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const { RechargeAmountService } = require('../server/services/recharge-amount-service')
  const { RechargeSettlementService } = require('../server/services/recharge-settlement-service')
  const { ScanCursorService } = require('../server/services/tron/scan-cursor')
  const { TronGridProvider } = require('../server/services/tron/trongrid-provider')
  const { USDT_TRC20_CONTRACT } = require('../server/services/tron/transfer')

  const pool = new Pool({
    connectionString: config.database.connectionString,
    ssl: config.database.ssl,
    max: 4,
    applicationName: 'hello-pix-recharge-watcher'
  })
  const repo = new ProductionRepository(pool)
  const cursor = new ScanCursorService()
  const settlement = new RechargeSettlementService(repo, {
    amountService: new RechargeAmountService(),
    autoSettlementEnabled: config.chain.autoSettlementEnabled,
    tokenContract: USDT_TRC20_CONTRACT
  })
  const provider = new TronGridProvider({
    apiKey: config.chain.trongridApiKey,
    baseUrl: config.chain.baseUrl || undefined,
    timeoutMs: config.chain.timeoutMs
  })

  log(`模式: ${settlement.mode.toUpperCase()}` +
    (settlement.autoSettlementEnabled ? '  ⚠ 自动结算已开启' : '  （只记录不执行，不会改动任何余额）'))

  // 收款地址来自后台配置 —— 不写死，管理员改了地址下一轮就跟着变
  const settings = await repo.settings()
  const channels = (Array.isArray(settings['payment.channels']) ? settings['payment.channels'] : [])
    .filter(c => c && Number(c.enabled) && c.address)
  if (!channels.length) {
    log('没有启用中的收款渠道，无需扫描')
    await pool.end()
    return 0
  }

  let failures = 0
  for (const channel of channels) {
    const address = String(channel.address)
    const tokenContract = USDT_TRC20_CONTRACT
    try {
      if (STATUS_ONLY) {
        const client = await pool.connect()
        try {
          const row = await cursor.get(client, { address, tokenContract })
          log(`地址 ${address}`)
          log(`  游标: ${row ? new Date(Number(row.last_scanned_timestamp)).toISOString() : '(尚未扫描)'}` +
            `  失败次数: ${row ? row.consecutive_failures : 0}` +
            (row && row.last_error ? `  最近错误: ${row.last_error}` : ''))
        } finally { client.release() }
        continue
      }
      const result = await scanOneAddress({ pool, cursor, settlement, provider, address, tokenContract })
      log(`地址 ${address}: 拉到 ${result.fetched} 条，处理 ${result.processed} 条，` +
        `结算 ${result.settled}，shadow 命中 ${result.shadowMatched}，异常 ${result.exceptions}，` +
        `重复 ${result.duplicates}，` +
        `游标推进到 ${new Date(result.advancedTo).toISOString()}`)
      if (result.skippedUnsolidified) {
        log(`  ⚠ 跳过 ${result.skippedUnsolidified} 条未最终确认的交易（游标未越过它们）`)
      }
    } catch (error) {
      failures += 1
      log(`地址 ${address} 扫描失败: ${(error && error.code) || ''} ${(error && error.message) || error}`)
      // 失败**不动游标** —— 这一段还没扫完，下次从原处重来
      const client = await pool.connect()
      try {
        await cursor.recordFailure(client, { address, tokenContract, error })
      } finally { client.release() }
    }
  }

  await pool.end()
  return failures > 0 ? 1 : 0
}

/**
 * 扫一个地址。
 *
 * 事务边界：**一批交易 + 游标推进 = 一个事务**。
 * 这是"不丢单"的核心 —— 两者要么一起成立，要么一起回滚。
 */
async function scanOneAddress({ pool, cursor, settlement, provider, address, tokenContract }) {
  const client = await pool.connect()
  const stats = {
    fetched: 0, processed: 0, settled: 0, shadowMatched: 0,
    exceptions: 0, duplicates: 0, skippedUnsolidified: 0, advancedTo: 0
  }
  try {
    // 最终确认块：查询窗口的上界取它的时间戳，而不是 now。
    // 这样未确认交易根本不会进入处理范围 —— 从源头杜绝"提前结算"。
    const solid = await provider.latestSolidBlock()
    const now = Date.now()

    await client.query('BEGIN')
    const window = await cursor.beginScan(client, {
      address, tokenContract, now, toTimestamp: solid.blockTimestamp
    })
    // 窗口不能越过最终确认块
    const effectiveTo = Math.min(window.toTimestamp, solid.blockTimestamp)
    if (effectiveTo <= window.fromTimestamp) {
      // 没有可扫的范围（游标已经追平）—— 提交空事务，保持游标不变
      await client.query('COMMIT')
      stats.advancedTo = window.fromTimestamp
      return stats
    }

    const listed = await provider.listIncomingTransfers({
      tokenContract, toAddress: address,
      fromTimestamp: window.fromTimestamp, toTimestamp: effectiveTo
    })
    const transfers = listed.transfers.slice(0, config.chain.maxTransfersPerScan)
    stats.fetched = transfers.length

    // 防御性再筛一次：即使 Provider 给了未确认交易，也不处理、不越过它
    const unsolidified = transfers.filter(t => !t.solidified)
    const processable = transfers.filter(t => t.solidified)
    stats.skippedUnsolidified = unsolidified.length

    for (const transfer of processable) {
      const result = await settlement.handleTransfer(client, transfer, { toAddress: address })
      stats.processed += 1
      if (result.outcome === 'SETTLED') stats.settled += 1
      else if (result.outcome === 'SHADOW_MATCHED') stats.shadowMatched += 1
      else if (result.outcome === 'EXCEPTION') stats.exceptions += 1
      else if (result.outcome === 'DUPLICATE') stats.duplicates += 1
    }

    // 游标推到哪：如果有被跳过的未确认交易，**绝不越过它**
    // （越过就等于把它漏掉，且下一轮不会再看到）
    let advanceTo = effectiveTo
    if (unsolidified.length) {
      const earliestSkipped = Math.min(...unsolidified.map(t => t.blockTimestamp))
      advanceTo = Math.min(advanceTo, earliestSkipped - 1)
    }
    stats.advancedTo = advanceTo

    if (DRY_RUN) {
      await client.query('ROLLBACK')
      log('  --dry：已回滚，未写入任何数据')
      return stats
    }

    // 交易落库与游标推进同事务提交
    await cursor.advance(client, {
      address, tokenContract, toTimestamp: advanceTo,
      solidBlockNumber: solid.blockNumber,
      scannedCount: stats.processed
    })
    await client.query('COMMIT')
    return stats
  } catch (error) {
    try { await client.query('ROLLBACK') } catch (_e) { /* 回滚失败就交给上层 */ }
    throw error
  } finally {
    client.release()
  }
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code || 0 })
    .catch(error => {
      console.error('watcher 异常:', (error && error.stack) || error)
      process.exitCode = 1
    })
}

module.exports = { main, scanOneAddress }
