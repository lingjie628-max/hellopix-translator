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

      // 展示字段现在是固定 3 位小数的字符串，比价时转成数值再比
      assert.equal(Number(got.originalPrice), want.originalPrice,
        `${price} × ${qty} 原价变了`)
      assert.equal(Number(got.paidAmount), want.paidAmount,
        `${price} × ${qty} 折后价变了（旧 ${want.paidAmount}，新 ${got.paidAmount}）`)
      assert.equal(Number(got.discountAmount), want.discountAmount,
        `${price} × ${qty} 折扣额变了`)
      // 同时确认展示格式统一为 3 位小数
      assert.match(got.paidAmount, /^\d+\.\d{3}$/, `${price} × ${qty} 展示格式不是 3 位小数`)
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

// ------------------------------- 迁移必须覆盖新代码引用的列（这次真的漏过）

test('所有 recharges 新增列都有对应 migration', () => {
  const migrationsDir = path.join(root, 'migrations')
  const allSql = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
    .join('\n')

  // RC-02 引入、且下单代码会写入的列。
  // 曾经漏掉 pay_address / pay_token_contract ——
  // schema 检查才发现，否则部署后下单会直接报"列不存在"。
  const required = [
    'surcharge_amount',
    'expires_at',
    'terminal_at',
    'terminal_reason',
    'amount_reservation_id',
    'pay_address',
    'pay_token_contract'
  ]
  for (const column of required) {
    assert.match(allSql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`),
      `没有任何 migration 创建 recharges.${column}`)
  }
})

test('下单代码写入的每一列都能在 migration 里找到', () => {
  const create = routeSource.slice(
    routeSource.indexOf("router.post('/userRecharge/create'"),
    routeSource.indexOf("router.get('/team/info'")
  )
  const insert = create.slice(create.indexOf('INSERT INTO recharges'), create.indexOf('RETURNING *'))
  const migrationsDir = path.join(root, 'migrations')
  const allSql = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
    .join('\n')
  const base = fs.readFileSync(path.join(migrationsDir, '001_initial_schema.js'), 'utf8')

  // 从 INSERT 的列清单里逐个提取
  const columnsPart = insert.slice(insert.indexOf('(') + 1, insert.indexOf(')'))
  const columns = columnsPart.split(',').map(c => c.trim()).filter(Boolean)
  assert.ok(columns.length > 10, '列清单没解析出来')
  for (const column of columns) {
    const inBase = new RegExp(`\\b${column}\\b`).test(base)
    const inNew = new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`).test(allSql)
    assert.ok(inBase || inNew,
      `下单写入的列 ${column} 既不在建表语句里，也没有 migration 添加`)
  }
})

// ------------------------------------------ 自动结算闸门（Phase 2 Shadow 模式）

const { execFileSync } = require('node:child_process')

/** 在干净的子进程里读 config，避免被本进程已有的 env 影响 */
function chainFlag(envValue) {
  const env = Object.assign({}, process.env, { DATABASE_URL: 'postgres://x@127.0.0.1:1/x' })
  if (envValue === null) delete env.AUTO_SETTLEMENT_ENABLED
  else env.AUTO_SETTLEMENT_ENABLED = envValue
  const out = execFileSync(process.execPath, ['-e',
    'process.stdout.write(String(require("./server/config").chain.autoSettlementEnabled))'
  ], { cwd: root, env, encoding: 'utf8' })
  return out.trim()
}

test('自动结算默认关闭 —— 不设环境变量时必须是 shadow 模式', () => {
  assert.equal(chainFlag(null), 'false', '默认必须是关闭的，绝不能默认动钱')
  assert.equal(chainFlag(''), 'false')
})

test('只有严格的 "true" 才开启自动结算', () => {
  assert.equal(chainFlag('true'), 'true')
  // 这些"看着像真"的写法绝不能意外打开资金路径
  for (const v of ['1', 'yes', 'on', 'TRUE', 'True', 'y', 'enabled']) {
    assert.equal(chainFlag(v), 'false', `AUTO_SETTLEMENT_ENABLED=${v} 不该开启自动结算`)
  }
})

test('ChainWatcher 只通过 SettlementService 动钱，自己不碰余额', () => {
  const watcher = fs.readFileSync(path.join(root, 'scripts/recharge-watcher.js'), 'utf8')
  assert.doesNotMatch(watcher, /adjustChars/, 'watcher 不得直接调 adjustChars')
  assert.doesNotMatch(watcher, /UPDATE\s+recharges\s+SET\s+status/i, 'watcher 不得直接改订单状态')
  assert.doesNotMatch(watcher, /UPDATE\s+users\s+SET\s+char_balance/i, 'watcher 不得直接改余额')
  assert.match(watcher, /settlement\.handleTransfer/, 'watcher 必须把交易交给结算服务')
})

test('SettlementService 是唯一写 char_balance 的地方（除已知的历史入口）', () => {
  const settlement = fs.readFileSync(
    path.join(root, 'server/services/recharge-settlement-service.js'), 'utf8')
  assert.match(settlement, /adjustChars/, '结算服务应当走 adjustChars')
  // 链上路径不得自己拼 UPDATE
  assert.doesNotMatch(settlement, /UPDATE\s+users\s+SET\s+char_balance/i)
})

// ------------------------------- app_settings 键必须满足数据库约束（这次真踩了）

test('代码里引用的 app_settings 键全部满足数据库约束', () => {
  // 约束：CHECK (key ~ '^[a-z][a-z0-9_.-]{1,119}$') —— **只允许小写**
  // 踩过的坑：`mail.alertTo` 含大写 T，这个键在库里根本不可能存在。
  // 后果不只是"告警收件人存不进去"，而是 /admin/mail 的保存会整个事务回滚 ——
  // 因为它同时写 mail.smtp 和 mail.alertTo。
  const KEY_PATTERN = /^[a-z][a-z0-9_.-]{1,119}$/
  const files = [
    'server/routes/production.js',
    'server/lib/mailer.js',
    'server/lib/ops-alert.js',
    'server/services/core-service.js'
  ]
  // 形如 'xxx.yyy' 的字符串字面量，且出现在 setting/objectSetting/settings 取值语境里
  const offenders = []
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8')
    const literals = text.match(/'[a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+'/g) || []
    for (const lit of literals) {
      const key = lit.slice(1, -1)
      // SQL 别名（s.username / o.title 之类）不是配置键，跳过
      if (/^(s|u|o|r|t|p|e|c)\./.test(key)) continue
      if (!KEY_PATTERN.test(key)) offenders.push(`${rel}: ${key}`)
    }
  }
  assert.deepEqual(offenders, [],
    'app_settings 键违反数据库小写约束（会导致整笔事务失败）：\n' + offenders.join('\n'))
})

test('mail 配置的读写键一致，不会一边写一边读另一个名字', () => {
  const mailer = fs.readFileSync(path.join(root, 'server/lib/mailer.js'), 'utf8')
  const route = fs.readFileSync(path.join(root, 'server/routes/production.js'), 'utf8')
  const alert = fs.readFileSync(path.join(root, 'server/lib/ops-alert.js'), 'utf8')
  // 三处必须用同一个键名
  assert.match(mailer, /'mail\.alert_to'/)
  assert.match(alert, /\['mail\.alert_to'\]/)
  assert.match(route, /\['mail\.alert_to',/)
  // 剥掉注释再查：注释里会引用旧键名来说明这次修的是什么，那是文档不是代码
  const stripComments = t => t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  for (const [name, text] of [['mailer', mailer], ['ops-alert', alert], ['production', route]]) {
    assert.doesNotMatch(stripComments(text), /mail\.alertTo/,
      `${name} 的**可执行代码**里还有旧键名 mail.alertTo`)
  }
})
