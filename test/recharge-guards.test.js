'use strict'

/**
 * RC-02 回归守卫。
 *
 * 两件事：
 *
 * 1. **证明旧的降级逻辑真的删掉了。**
 *    审计发现 `/userRecharge/create` 在重试 200 次后会静默把尾数置 0
 *    （等于用标准价下单），而这会让两张订单拿到同一金额且不报任何错。
 *    光删代码不够 —— 得有条测试盯着它别再回来。
 *
 * 2. **证明报价没有因为改成整数运算而变价。**
 *    RC-02 把 `quote` 从浮点改成了 milli 整数。改算法最怕悄悄改了价格，
 *    所以这里拿旧公式逐例对照 —— 结果必须一模一样。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const routeSource = fs.readFileSync(path.join(root, 'server/routes/production.js'), 'utf8')

// ---------------------------------------------------------------- 源码守卫

test('旧的降级尾数逻辑已彻底删除', () => {
  // 旧实现：2 位小数随机 + toFixed(2) 去重 + 重试失败后 suffix 保持 0
  assert.doesNotMatch(routeSource, /let suffix\s*=\s*0/, '「失败后退回 suffix=0」的降级逻辑又回来了')
  assert.doesNotMatch(routeSource, /crypto\.randomInt\(1,\s*100\)\s*\/\s*100/,
    '旧的 2 位小数尾数逻辑又回来了（应当是 1–999 的 3 位尾数）')
  assert.doesNotMatch(routeSource, /toFixed\(2\)/, '不该再用 toFixed(2) 做金额')
})

test('下单路径接入的是新的金额预约服务，而不是自己算尾数', () => {
  const create = routeSource.slice(
    routeSource.indexOf("router.post('/userRecharge/create'"),
    routeSource.indexOf("router.get('/team/info'")
  )
  assert.match(create, /rechargeAmount\.allocate\(/, '下单必须走 RechargeAmountService.allocate')
  assert.match(create, /attachToRecharge\(/, '预约要回填订单归属')
  // 金额一律经 milli helper，不得出现浮点运算
  assert.match(create, /parseMilli\(quote\.paidMilli\)/,
    'paidMilli 是「毫」，必须用 parseMilli；用 toMilli 会把金额放大 1000 倍')
  assert.doesNotMatch(create, /toMilli\(quote\.paidMilli\)/, '不得对 milli 字段再用 toMilli')
  assert.doesNotMatch(create, /parseFloat|Number\(.*\)\s*\*/, '下单路径不得出现浮点金额运算')
})

test('下单时快照收款地址与代币合约 —— 否则换地址后历史订单无法核对', () => {
  const create = routeSource.slice(
    routeSource.indexOf("router.post('/userRecharge/create'"),
    routeSource.indexOf("router.get('/team/info'")
  )
  assert.match(create, /pay_address/, '订单必须快照收款地址')
  assert.match(create, /pay_token_contract/, '订单必须快照代币合约')
  assert.match(create, /expires_at/, '订单必须有有效期')
})

test('USDT 合约是常量而不是后台可改配置 —— 防手滑改成仿盘合约', () => {
  assert.match(routeSource, /const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'/)
  // 不应从 app_settings 或请求体里读合约
  assert.doesNotMatch(routeSource, /tokenContract:\s*String\(data\./)
  assert.doesNotMatch(routeSource, /byKey\['payment\.contract'\]/)
})

test('订单有效期是 30 分钟', () => {
  assert.match(routeSource, /const RECHARGE_TTL_MINUTES = 30/)
  assert.match(routeSource, /RECHARGE_TTL_MINUTES \* 60 \* 1000/)
})

// ------------------------------------------------------- 报价改整数后没变价

const { CoreService } = require('../server/services/core-service')
const { formatMilli, toMilli, parseMilli } = require('../server/lib/money')

/**
 * 最小 redis stub。
 * CoreService 构造时会校验 redis 有 get/set（它要建翻译缓存与分享票据存储），
 * 而 quote() 根本不碰 redis —— 给个占位即可，不必起真 Redis。
 */
function fakeRedis() {
  return { get: async () => null, set: async () => 'OK' }
}

/** 造一个只提供 package / settings 的假仓储 */
function fakeRepo(priceText, includedChars) {
  return {
    async package() {
      return { id: 1, code: 'basic', title: '基础版', price: priceText, includedChars }
    },
    async settings() {
      return { 'billing.discounts': { 1: 0.9, 10: 0.8, 50: 0.75 } }
    }
  }
}

/** 旧实现的公式 —— 原文照抄，用来对照价格有没有变 */
function legacyQuote(priceText, qty) {
  const rate = qty >= 50 ? 0.75 : (qty >= 10 ? 0.8 : 0.9)
  const originalPrice = Number(priceText) * qty
  const paidAmount = Math.round(originalPrice * rate * 100) / 100
  return {
    originalPrice,
    paidAmount,
    discountAmount: Math.round((originalPrice - paidAmount) * 100) / 100
  }
}

test('报价改成整数运算后，价格与旧公式逐例一致', async () => {
  const prices = ['35.00', '125.00', '350.00', '1250.00', '29.00', '99.00', '199.00']
  const quantities = [1, 2, 5, 10, 20, 50, 100]

  for (const price of prices) {
    for (const qty of quantities) {
      const core = new CoreService(fakeRepo(price, 1500000), fakeRedis(), null, {})
      const got = await core.quote({ baseid: 1, qty })
      const want = legacyQuote(price, qty)

      assert.equal(got.originalPrice, want.originalPrice,
        `${price} × ${qty} 原价变了`)
      assert.equal(got.paidAmount, want.paidAmount,
        `${price} × ${qty} 折后价变了（旧 ${want.paidAmount}，新 ${got.paidAmount}）`)
      assert.equal(got.discountAmount, want.discountAmount,
        `${price} × ${qty} 折扣额变了`)
    }
  }
})

test('报价同时给出精确的 milli 字符串，供金额运算使用', async () => {
  const core = new CoreService(fakeRepo('35.00', 1500000), fakeRedis(), null, {})
  const got = await core.quote({ baseid: 1, qty: 1 })

  assert.equal(typeof got.paidMilli, 'string', 'paidMilli 必须是字符串，不能是 Number')
  assert.equal(typeof got.originalMilli, 'string')
  assert.equal(typeof got.discountMilli, 'string')
  assert.equal(got.originalMilli, '35000')
  assert.equal(got.paidMilli, '31500')       // 35 × 0.9
  assert.equal(got.discountMilli, '3500')
  // 三者满足恒等式，且都是精确整数
  assert.equal(
    BigInt(got.originalMilli) - BigInt(got.discountMilli),
    BigInt(got.paidMilli)
  )
})

test('milli 报价可以直接与尾数相加，且不丢精度', async () => {
  const core = new CoreService(fakeRepo('29.00', 1500000), fakeRedis(), null, {})
  const got = await core.quote({ baseid: 1, qty: 1 })
  const { applySuffix } = require('../server/lib/money')

  // 29 × 0.9 = 26.10 → 26100 milli
  assert.equal(got.paidMilli, '26100')
  // 加尾数 548 → 26.648。
  // 必须用 parseMilli：paidMilli 已经是「毫」，
  // 用 toMilli 会再乘 1000（订单金额放大一千倍）
  const paid = applySuffix(parseMilli(got.paidMilli), 548n)
  assert.equal(formatMilli(paid), '26.648')
  // 恒等式仍然成立：标准价 − 折扣 + 尾数 = 实付
  assert.equal(
    BigInt(got.originalMilli) - BigInt(got.discountMilli) + 548n,
    paid
  )
})

test('toMilli 与 parseMilli 语义不同，混用会造成 1000 倍金额错误', () => {
  // 同一段文本，两个函数的含义差 1000 倍
  assert.equal(toMilli('31500'), 31_500_000n, 'toMilli 把 "31500" 当 31500 USDT')
  assert.equal(parseMilli('31500'), 31_500n, 'parseMilli 把 "31500" 当 31500 毫')
  assert.equal(formatMilli(toMilli('31500')), '31500.000')
  assert.equal(formatMilli(parseMilli('31500')), '31.500')

  // parseMilli 拒绝非整数，避免把人类可读金额喂进来
  assert.throws(() => parseMilli('35.427'), /milli 必须是整数字符串/)
  assert.throws(() => parseMilli('abc'), /milli 必须是整数字符串/)
  assert.equal(parseMilli('0'), 0n)
  assert.equal(parseMilli(35427n), 35427n)
})

test('报价对非法价格文本会拒绝，而不是静默算出一个数', async () => {
  // numeric 列理论上不会给出这种值，但真出现了要立刻暴露
  const core = new CoreService(fakeRepo('not-a-price', 1500000), fakeRedis(), null, {})
  await assert.rejects(() => core.quote({ baseid: 1, qty: 1 }), /金额格式不合法/)
})

// ------------------------------------------ 前端不得自行计算应付金额（Phase 1 决策 2）

/**
 * 剥掉注释再检查。
 *
 * 否则解释性注释里写的"旧代码长这样"会把守卫自己触发 ——
 * 我第一版就踩了：注释里引用 `Number(pack.price) * qty` 导致测试误报。
 * 守卫要盯的是**实际执行的代码**，不是文档。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */
    .replace(/<!--[\s\S]*?-->/g, '')        // <!-- ... -->
    .replace(/(^|[^:])\/\/.*$/gm, '$1')     // // ...（避开 https://）
}

const rechargePageRaw = fs.readFileSync(
  path.join(root, 'src/components/user/UserRechargePage.vue'), 'utf8')
const rechargePage = stripComments(rechargePageRaw)

/**
 * 金额运算的特征：**除以 100 的舍入**。
 * 注意与「折扣百分比格式化」区分 —— 后者是 `Math.round(x * 100) / 10`（除以 10 得折数），
 * 属于展示，不涉及金额。所以这里必须连除数一起匹配。
 */
const MONEY_ROUNDING = /Math\.round\([^)]*\*\s*100\s*\)\s*\/\s*100/

test('充值页不再自行报价：删掉了本地浮点公式', () => {
  assert.doesNotMatch(rechargePage, /Number\(pack\.price/,
    '前端不该再读 pack.price 做运算')
  assert.doesNotMatch(rechargePage, MONEY_ROUNDING,
    '前端不该再做「乘 100 取整再除 100」这类金额运算')
  assert.doesNotMatch(rechargePage, /selectedPack/,
    'selectedPack 计算属性只是旧报价逻辑的附属，应一并删除')
  assert.doesNotMatch(rechargePage, /toFixed\(2\)/, '前端不该对金额做 toFixed(2)')
})

test('充值页改为向服务端要报价，服务端是唯一真源', () => {
  assert.match(rechargePage, /getRequest\('\/user\/quote'/, '必须调用服务端报价接口')
  assert.match(rechargePage, /quote:\s*\{\s*originalPrice:\s*null/, 'quote 应是展示用的数据字段')
})

test('前端只展示服务端返回的金额字段，不重新计算', () => {
  assert.match(rechargePage, /quote\.paidAmount/)
  assert.match(rechargePage, /quote\.discountAmount/)
  assert.doesNotMatch(rechargePage, /\+\s*suffix|suffix\s*\+/, '前端不得自行拼装尾数')
  assert.doesNotMatch(rechargePage, /parseFloat/, '前端不得使用 parseFloat')
})

test('报价请求做了防抖与过期响应丢弃', () => {
  assert.match(rechargePage, /quoteSeq/, '需要请求序号来丢弃过期响应')
  assert.match(rechargePage, /seq !== this\.quoteSeq/, '过期响应必须被丢弃')
  assert.match(rechargePage, /setTimeout\(/, '需要防抖，避免数量输入每敲一下打一个请求')
})

test('报价未就绪时不允许下单', () => {
  const onSubmit = rechargePage.slice(rechargePage.indexOf('onSubmit()'))
  assert.match(onSubmit, /quote\.paidAmount === null/, '报价没到手就不该让用户提交订单')
})

test('全前端不得出现浮点金额运算', () => {
  const dir = path.join(root, 'src')
  const offenders = []
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(vue|js)$/.test(entry.name)) continue
      const text = stripComments(fs.readFileSync(full, 'utf8'))
      const rel = path.relative(root, full)
      if (MONEY_ROUNDING.test(text)) offenders.push(`${rel} → Math.round(x * 100) / 100`)
      if (/parseFloat/.test(text)) offenders.push(`${rel} → parseFloat`)
    }
  }
  walk(dir)
  assert.deepEqual(offenders, [],
    '前端出现了浮点金额运算：\n' + offenders.join('\n'))
})

test('折扣百分比展示不算金额运算 —— 守卫要能区分这两者', () => {
  // 这是允许保留的：把 0.9 显示成「9折」，除数是 10 不是 100
  const fold = 'return (Math.round(Number(n || 0) * 100) / 10) + \'折\''
  assert.doesNotMatch(fold, MONEY_ROUNDING, '折扣展示不该被误判为金额运算')
  // 而真正的金额舍入必须被抓到
  assert.match('const paid = Math.round(originalPrice * rate * 100) / 100', MONEY_ROUNDING)
})
