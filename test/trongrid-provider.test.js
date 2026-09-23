'use strict'

/**
 * TronGrid Provider 测试。
 *
 * 两件事：
 *   1. **格式隔离真的成立** —— 第三方字段名只在这里被消化，
 *      出来的必须是标准 Transfer。换 Provider 时业务层不该改。
 *   2. **故障能被正确分类** —— 429/5xx/超时可重试，401/403 不可重试。
 *      分不清会两头出错：把密钥失效当临时故障无限重试（永远好不了），
 *      或把限流当永久故障直接放弃（漏单）。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  ProviderError, classifyHttpStatus, classifyNetworkError, requestJson
} = require('../server/services/tron/tron-provider')
const { TronGridProvider } = require('../server/services/tron/trongrid-provider')
const { USDT_TRC20_CONTRACT } = require('../server/services/tron/transfer')

const TO = 'TEfCDDuYwYdjCn2WDa7TNWCU9bkBk9EXPX'
const FROM = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8'
const SOLID_TS = 1758600000000

/** TronGrid 的一条真实形状记录 */
function trongridRow(overrides) {
  return Object.assign({
    transaction_id: 'b'.repeat(64),
    token_info: { address: USDT_TRC20_CONTRACT, decimals: 6, symbol: 'USDT', name: 'Tether USD' },
    block_timestamp: SOLID_TS - 60000,
    from: FROM,
    to: TO,
    type: 'Transfer',
    value: '35427000'
  }, overrides || {})
}

function solidBlockBody() {
  return { block_header: { raw_data: { number: 60000000, timestamp: SOLID_TS } } }
}

/**
 * 造一个可控的 request。按 URL 分派，模拟 TronGrid 的两个端点。
 */
function mockRequest(handlers) {
  const calls = []
  const fn = async (url, options) => {
    calls.push({ url, options })
    if (/walletsolidity\/getnowblock/.test(url)) {
      if (handlers.solid) return handlers.solid()
      return solidBlockBody()
    }
    if (/gettransactioninfobyid/.test(url)) {
      return handlers.txInfo ? handlers.txInfo(url) : { blockNumber: 60000000 }
    }
    if (/transactions\/trc20/.test(url)) {
      const page = (() => {
        const m = /fingerprint=([^&]*)/.exec(url)
        return m ? decodeURIComponent(m[1]) : ''
      })()
      return handlers.list ? handlers.list(url, page) : { success: true, data: [trongridRow()], meta: {} }
    }
    throw new Error('未预期的 URL: ' + url)
  }
  fn.calls = calls
  return fn
}

function makeProvider(handlers, options) {
  const request = mockRequest(handlers || {})
  const provider = new TronGridProvider(Object.assign({ request, apiKey: 'test-key' }, options || {}))
  return { provider, request }
}

// --------------------------------------------------------------- 格式隔离

test('TronGrid 的下划线字段被翻译成标准 Transfer', async () => {
  const { provider } = makeProvider()
  const result = await provider.listIncomingTransfers({
    toAddress: TO, tokenContract: USDT_TRC20_CONTRACT,
    fromTimestamp: SOLID_TS - 3600000, toTimestamp: SOLID_TS
  })
  assert.equal(result.transfers.length, 1)
  const t = result.transfers[0]
  // 业务层只该看到这些字段，看不到 token_info / transaction_id / block_timestamp
  assert.equal(t.txId, 'b'.repeat(64))
  assert.equal(t.amountMilli, 35427n)
  assert.equal(t.tokenContract, USDT_TRC20_CONTRACT)
  assert.equal(t.fromAddress, FROM)
  assert.equal(t.toAddress, TO)
  assert.equal(t.blockTimestamp, SOLID_TS - 60000)
  assert.equal(t.amountExact, true)
  assert.equal(t.solidified, true)
  // 原始应答留档，但业务层不需要读它
  assert.ok(t.raw && t.raw.transaction_id)
})

test('solidified 按「交易时间 <= 最终确认块时间」判定', async () => {
  // TRON 区块时间单调不减，所以这个比较是严谨的：
  // 交易时间早于最终确认块 ⇒ 它所在区块 <= 最终确认块 ⇒ 不可回滚
  const { provider } = makeProvider({
    list: () => ({
      success: true,
      data: [
        trongridRow({ transaction_id: 'c'.repeat(64), block_timestamp: SOLID_TS - 1 }),
        trongridRow({ transaction_id: 'd'.repeat(64), block_timestamp: SOLID_TS + 1 })
      ],
      meta: {}
    })
  })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS + 10000 })
  const byTx = Object.fromEntries(r.transfers.map(t => [t.txId[0], t.solidified]))
  assert.equal(byTx.c, true, '早于最终确认块 → 已确认')
  assert.equal(byTx.d, false, '晚于最终确认块 → 未确认，不能提前结算')
})

test('非 Transfer 类型被过滤（Approve 等与充值无关）', async () => {
  const { provider } = makeProvider({
    list: () => ({
      success: true,
      data: [trongridRow({ type: 'Approval' }), trongridRow({ transaction_id: 'e'.repeat(64) })],
      meta: {}
    })
  })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.equal(r.transfers.length, 1, '只应留下 Transfer')
})

test('形状不对的单条记录被跳过，不影响整轮扫描', async () => {
  const { provider } = makeProvider({
    list: () => ({
      success: true,
      data: [
        null,
        {},
        { transaction_id: 'short', token_info: {}, to: TO, value: '1', block_timestamp: SOLID_TS },
        trongridRow({ transaction_id: 'f'.repeat(64) })
      ],
      meta: {}
    })
  })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.equal(r.transfers.length, 1, '一条坏数据不该让整轮扫描失败')
})

test('结果按区块时间升序 —— 游标推进依赖顺序', async () => {
  const { provider } = makeProvider({
    list: () => ({
      success: true,
      data: [
        trongridRow({ transaction_id: '1'.repeat(64), block_timestamp: SOLID_TS - 1000 }),
        trongridRow({ transaction_id: '2'.repeat(64), block_timestamp: SOLID_TS - 5000 }),
        trongridRow({ transaction_id: '3'.repeat(64), block_timestamp: SOLID_TS - 3000 })
      ],
      meta: {}
    })
  })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  const times = r.transfers.map(t => t.blockTimestamp)
  assert.deepEqual(times, [...times].sort((a, b) => a - b))
})

// --------------------------------------------------------------- 分页

test('按 fingerprint 翻页，拉满为止', async () => {
  let page = 0
  const { provider } = makeProvider({
    list: (_url, fp) => {
      page += 1
      if (!fp) {
        return {
          success: true,
          data: [trongridRow({ transaction_id: '1'.repeat(64), block_timestamp: SOLID_TS - 3000 })],
          meta: { fingerprint: 'next-page' }
        }
      }
      return {
        success: true,
        data: [trongridRow({ transaction_id: '2'.repeat(64), block_timestamp: SOLID_TS - 2000 })],
        meta: {}
      }
    }
  }, { pageLimit: 1 })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.equal(page, 2, '应当翻了两次')
  assert.equal(r.transfers.length, 2)
  assert.equal(r.hasMore, false)
})

test('翻页达上限时返回 hasMore，游标稳步追而不是一次拉爆', async () => {
  const { provider } = makeProvider({
    list: () => ({
      success: true,
      data: [trongridRow()],
      meta: { fingerprint: 'always-more' }
    })
  }, { pageLimit: 1, maxPagesPerScan: 3 })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.equal(r.hasMore, true)
  assert.equal(r.transfers.length, 3)
})

test('翻页过程中上游报错 —— 异常抛出，不返回半截数据', async () => {
  let n = 0
  const { provider } = makeProvider({
    list: () => {
      n += 1
      if (n === 1) {
        return { success: true, data: [trongridRow()], meta: { fingerprint: 'more' } }
      }
      throw new ProviderError('上游 500', { code: 'UPSTREAM_ERROR', retryable: true, status: 500 })
    }
  }, { pageLimit: 1 })
  await assert.rejects(
    () => provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS }),
    err => {
      assert.equal(err.code, 'UPSTREAM_ERROR')
      assert.equal(err.retryable, true)
      return true
    }
  )
})

// --------------------------------------------------------------- 故障分类

test('HTTP 状态码分类：429/5xx 可重试，401/403 不可重试', () => {
  assert.deepEqual(
    { code: classifyHttpStatus(429).code, retryable: classifyHttpStatus(429).retryable },
    { code: 'RATE_LIMITED', retryable: true })
  assert.equal(classifyHttpStatus(500).retryable, true)
  assert.equal(classifyHttpStatus(503).retryable, true)
  assert.equal(classifyHttpStatus(401).retryable, false)
  assert.equal(classifyHttpStatus(403).retryable, false)
  assert.equal(classifyHttpStatus(400).retryable, false)
})

test('429 带 Retry-After 时解析出退避时间', () => {
  assert.equal(classifyHttpStatus(429, '30').retryAfterMs, 30000)
  assert.equal(classifyHttpStatus(429).retryAfterMs, null)
})

test('网络错误分类：超时可重试，其余网络错误也可重试', () => {
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  const a = classifyNetworkError(abort)
  assert.equal(a.code, 'TIMEOUT')
  assert.equal(a.retryable, true)

  const reset = new Error('socket hang up')
  reset.code = 'ECONNRESET'
  const b = classifyNetworkError(reset)
  assert.equal(b.code, 'NETWORK')
  assert.equal(b.retryable, true)
})

test('requestJson 把 429 翻译成可重试的 RATE_LIMITED', async () => {
  const original = global.fetch
  global.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: name => (name === 'retry-after' ? '12' : null) },
    text: async () => 'rate limited'
  })
  try {
    await assert.rejects(() => requestJson('https://example.test/x', { timeoutMs: 1000 }), err => {
      assert.equal(err.code, 'RATE_LIMITED')
      assert.equal(err.retryable, true)
      assert.equal(err.retryAfterMs, 12000)
      return true
    })
  } finally { global.fetch = original }
})

test('requestJson 把 401 翻译成不可重试的 UNAUTHORIZED', async () => {
  const original = global.fetch
  global.fetch = async () => ({
    ok: false, status: 401,
    headers: { get: () => null },
    text: async () => 'bad key'
  })
  try {
    await assert.rejects(() => requestJson('https://example.test/x', { timeoutMs: 1000 }), err => {
      assert.equal(err.code, 'UNAUTHORIZED')
      assert.equal(err.retryable, false, '密钥失效重试一万次也没用，必须让告警接手')
      return true
    })
  } finally { global.fetch = original }
})

test('requestJson 超时被识别为可重试', async () => {
  const original = global.fetch
  global.fetch = async (_url, opts) => new Promise((_resolve, reject) => {
    // 模拟 fetch 在 abort 时的行为
    opts.signal.addEventListener('abort', () => {
      const e = new Error('aborted')
      e.name = 'AbortError'
      reject(e)
    })
  })
  try {
    await assert.rejects(() => requestJson('https://example.test/x', { timeoutMs: 30 }), err => {
      assert.equal(err.code, 'TIMEOUT')
      assert.equal(err.retryable, true)
      return true
    })
  } finally { global.fetch = original }
})

test('上游 success=false 视为可重试的上游错误', async () => {
  const { provider } = makeProvider({ list: () => ({ success: false, data: [] }) })
  await assert.rejects(
    () => provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS }),
    err => {
      assert.equal(err.code, 'UPSTREAM_ERROR')
      assert.equal(err.retryable, true)
      return true
    }
  )
})

test('区块结构不认识时报可重试错误，而不是拿 undefined 往下走', async () => {
  const { provider } = makeProvider({ solid: () => ({ unexpected: true }) })
  await assert.rejects(() => provider.latestSolidBlock(), err => {
    assert.equal(err.code, 'BAD_RESPONSE')
    return true
  })
})

// --------------------------------------------------------------- 其它

test('缺少收款地址直接拒绝（不浪费一次请求）', async () => {
  const { provider, request } = makeProvider()
  await assert.rejects(
    () => provider.listIncomingTransfers({ toAddress: '', fromTimestamp: 0, toTimestamp: SOLID_TS }),
    err => {
      assert.equal(err.code, 'BAD_REQUEST')
      assert.equal(err.retryable, false)
      return true
    })
  assert.equal(request.calls.length, 0, '参数就错了，不该打上游')
})

test('API Key 通过请求头传递，不出现在 URL 里', async () => {
  const { provider, request } = makeProvider({}, { apiKey: 'secret-key' })
  await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.ok(request.calls.every(c => !c.url.includes('secret-key')), 'key 不能进 URL（会进日志）')
  assert.ok(request.calls.every(c => c.options.headers['TRON-PRO-API-KEY'] === 'secret-key'))
})

test('health() 成功与失败都返回结构化结果，不抛异常', async () => {
  const { provider } = makeProvider()
  const ok = await provider.health()
  assert.equal(ok.ok, true)
  assert.equal(ok.provider, 'trongrid')
  assert.equal(ok.solidBlock, 60000000)

  const { provider: broken } = makeProvider({
    solid: () => { throw new ProviderError('挂了', { code: 'UPSTREAM_ERROR', retryable: true }) }
  })
  const bad = await broken.health()
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'UPSTREAM_ERROR')
})

test('getTransactionBlock 拿不到时返回 null，不让整轮扫描失败', async () => {
  const { provider } = makeProvider({ txInfo: () => { throw new Error('boom') } })
  assert.equal(await provider.getTransactionBlock('a'.repeat(64)), null)

  const { provider: good } = makeProvider()
  assert.equal(await good.getTransactionBlock('a'.repeat(64)), 60000000)
})

// ═══════════════════════════════════════════════ 分页游标与事件位置

test('nextCursor 是不透明的 meta.fingerprint，不是时间戳', async () => {
  const FP = 'TmGrm87rBdhJFGjasxCJbkDTbLVzQmXHq5zckQDZnT7Rsxy'
  const { provider } = makeProvider({
    list: () => ({
      success: true,
      data: [trongridRow()],
      meta: { fingerprint: FP, at: Date.now(), page_size: 1 }
    })
  }, { pageLimit: 1, maxPagesPerScan: 1 })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.equal(r.nextCursor, FP, 'nextCursor 应当原样透传上游游标')
  // 不能是时间戳 —— 一个时间点可能有多笔交易，用时间翻页会重复或漏
  assert.notEqual(r.nextCursor, String(SOLID_TS))
  assert.equal(typeof r.nextCursor, 'string')
})

test('没有下一页时 nextCursor 为 null', async () => {
  const { provider } = makeProvider({
    list: () => ({ success: true, data: [trongridRow()], meta: {} })
  })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.equal(r.nextCursor, null)
  assert.equal(r.hasMore, false)
})

test('cursor 原样回传给上游，不做任何解析', async () => {
  const FP = 'opaque-cursor-value-带中文也要能透传'
  const seen = []
  const { provider } = makeProvider({
    list: (url, fp) => {
      seen.push(fp)
      return { success: true, data: [trongridRow()], meta: {} }
    }
  })
  await provider.listIncomingTransfers({
    toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS, cursor: FP
  })
  assert.deepEqual(seen, [FP], '第一次请求就应带上传入的 cursor')
})

test('分页跨 fingerprint：第二页带上第一页给的游标', async () => {
  const FP1 = 'page-one-fingerprint'
  const seen = []
  const { provider } = makeProvider({
    list: (url, fp) => {
      seen.push(fp)
      if (!fp) {
        return { success: true, data: [trongridRow({ transaction_id: '1'.repeat(64) })], meta: { fingerprint: FP1 } }
      }
      return { success: true, data: [trongridRow({ transaction_id: '2'.repeat(64) })], meta: {} }
    }
  }, { pageLimit: 1 })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.deepEqual(seen, ['', FP1], '第二次请求必须带第一页的 fingerprint')
  assert.equal(r.transfers.length, 2)
})

test('同一时间戳的记录超过一页时不会丢 —— 靠 fingerprint 而不是时间戳', async () => {
  // 10 笔交易共用同一个 block_timestamp，分 3 页返回
  const sameTs = SOLID_TS - 5000
  const pages = [
    { ids: ['1', '2', '3', '4'], fp: 'fp-a' },
    { ids: ['5', '6', '7', '8'], fp: 'fp-b' },
    { ids: ['9', 'a'], fp: '' }
  ]
  let call = 0
  const { provider } = makeProvider({
    list: () => {
      const page = pages[call++] || { ids: [], fp: '' }
      return {
        success: true,
        data: page.ids.map(c => trongridRow({ transaction_id: c.repeat(64), block_timestamp: sameTs })),
        meta: page.fp ? { fingerprint: page.fp } : {}
      }
    }
  }, { pageLimit: 4, maxPagesPerScan: 10 })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.equal(r.transfers.length, 10, '同一时间戳的 10 笔必须全部拿到')
  const ids = new Set(r.transfers.map(t => t.txId))
  assert.equal(ids.size, 10, '不能有重复')
})

// ---------------------------------------------------------- 事件位置解析

test('事件位置从交易回执的 log[] 下标补出，不是伪造的序号', async () => {
  const usdtHex = 'a614f803b6fd780986a42c78ec9c7f77e6ded13c'
  const toHex = '33707b5f44db4a0477c1f10cc6314a559acaaaad'
  const pad = h => '0'.repeat(64 - h.length) + h
  const { provider } = makeProvider({
    list: () => ({
      success: true,
      data: [trongridRow({ transaction_id: 'e'.repeat(64) })],
      meta: {}
    }),
    txInfo: () => ({
      blockNumber: 60000000,
      log: [
        // [0] 别的事件
        { address: usdtHex, topics: ['00'.repeat(32), pad('11'.repeat(20)), pad(toHex)] },
        // [1] 转给我们的 Transfer —— 真实位置是 1
        { address: usdtHex, topics: [
          'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          pad('22'.repeat(20)), pad(toHex)], data: '0x1' }
      ]
    })
  })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.equal(r.transfers.length, 1)
  assert.equal(r.transfers[0].eventIndex, 1, '必须取回执里的真实下标，而不是默认 0')
})

test('取不到回执时 eventIndex 为 null —— 绝不编一个序号顶上', async () => {
  const { provider } = makeProvider({
    list: () => ({ success: true, data: [trongridRow()], meta: {} }),
    txInfo: () => { throw new Error('回执接口挂了') }
  })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.equal(r.transfers.length, 1)
  assert.equal(r.transfers[0].eventIndex, null,
    '拿不到位置必须是 null，不能是 0 —— 否则真正的事件 0 会被它挡住')
})

test('同一笔交易在一页里出现多次 → 各自拿到不同的真实事件位置', async () => {
  const usdtHex = 'a614f803b6fd780986a42c78ec9c7f77e6ded13c'
  const toHex = '33707b5f44db4a0477c1f10cc6314a559acaaaad'
  const pad = h => '0'.repeat(64 - h.length) + h
  const sig = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  let receiptCalls = 0
  const { provider } = makeProvider({
    list: () => ({
      success: true,
      data: [
        trongridRow({ transaction_id: 'f'.repeat(64), value: '1000000' }),
        trongridRow({ transaction_id: 'f'.repeat(64), value: '2000000' })
      ],
      meta: {}
    }),
    txInfo: () => {
      receiptCalls += 1
      return {
        blockNumber: 60000000,
        log: [
          { address: usdtHex, topics: [sig, pad('aa'.repeat(20)), pad(toHex)], data: '0x1' },
          { address: usdtHex, topics: [sig, pad('bb'.repeat(20)), pad(toHex)], data: '0x2' }
        ]
      }
    }
  })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  assert.equal(r.transfers.length, 2, '同一 tx 的两个事件都要保留')
  const idx = r.transfers.map(t => t.eventIndex).sort((a, b) => a - b)
  assert.deepEqual(idx, [0, 1], '两个事件必须拿到不同的位置')
  assert.equal(receiptCalls, 1, '同一笔交易的回执只该查一次（1 rps 限流下很关键）')
})

test('回执查询次数有上限，超出的交易 eventIndex 为 null 而不是无限打上游', async () => {
  const ids = ['1', '2', '3', '4', '5'].map(c => c.repeat(64))
  const { provider } = makeProvider({
    list: () => ({ success: true, data: ids.map(id => trongridRow({ transaction_id: id })), meta: {} })
  }, { maxReceiptLookups: 2 })
  const r = await provider.listIncomingTransfers({ toAddress: TO, fromTimestamp: 0, toTimestamp: SOLID_TS })
  const resolved = r.transfers.filter(t => t.eventIndex !== null).length
  assert.ok(resolved <= 2, `最多只该解析 2 条，实际 ${resolved}`)
  assert.ok(r.transfers.some(t => t.eventIndex === null), '超出上限的应当为 null 而不是 0')
})
