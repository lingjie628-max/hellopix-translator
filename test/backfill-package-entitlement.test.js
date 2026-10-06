'use strict'

/**
 * 补发套餐权益脚本（需要真实 PostgreSQL）。
 *
 * ## 为什么要有这个文件
 *
 * `scripts/backfill-package-entitlement.js` 是用来**修生产历史数据**的，
 * 它一次点击就会改动「谁拥有什么套餐、到期什么时候、能开几个子账号」。
 * 这类脚本最怕两件事，而且都只有真库跑一遍才看得出来：
 *
 *   1. **把没发的漏掉**：生产上那笔 35 USDT 的订单至今还卡在
 *      "已支付但 package_id 是 NULL"，补发脚本必须能把它捞出来。
 *   2. **把发过的再发一次**：再来一遍就是到期时间又延一个月、
 *      子账号额度被重置 —— 白送权益，且客户已经用上了没法收回。
 *
 * 所以这里跑的是**真脚本、真子进程、真库**：`--apply` 之后真的去查
 * `users` 那一行，而不是断言脚本"看起来调对了函数"。
 *
 * 到期时间那条断言是刻意设计的：订单的 `paid_at` 放在 3 天前，
 * 于是"从支付时刻起算"和"从现在起算"会差出整整 3 天 ——
 * 用 `now()` 起算的实现会被这条断言抓住（补发越晚，客户亏得越多）。
 *
 * 运行：PIX_TEST_DATABASE_URL=... node --test test/backfill-package-entitlement.test.js
 */

const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL
const rand = () => `${process.pid}${Date.now() % 1e6}${Math.floor(Math.random() * 1000)}`
const SCRIPT = path.join(__dirname, '..', 'scripts', 'backfill-package-entitlement.js')

/** 以真实子进程跑脚本，环境里钉死 DATABASE_URL（config 只认 process.env） */
function runScript(args) {
  const result = spawnSync(process.execPath, [SCRIPT].concat(args), {
    env: Object.assign({}, process.env, { DATABASE_URL: databaseUrl, NODE_ENV: 'test' }),
    encoding: 'utf8'
  })
  if (result.error) throw result.error
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` }
}

// ---------------------------------------------------------------- 纯逻辑

test('--id 参数校验：写错必须报错，绝不能退回"扫全库"', () => {
  const { parseOnlyId } = require('../scripts/backfill-package-entitlement')
  assert.equal(parseOnlyId([]), null, '不传 --id 表示全库')
  assert.equal(parseOnlyId(['--apply', '--id=20']), 20)

  // 这两种如果被当成 null 放过去，就会从"补一单"变成"改全库"——方向刚好相反
  assert.throws(() => parseOnlyId(['--id=abc']), /正整数/)
  assert.throws(() => parseOnlyId(['--id=0']), /正整数/)
  assert.throws(() => parseOnlyId(['--id=-3']), /正整数/)
  // 空格写法必须报错：静默忽略就等于"以为补一单、实际改了全库"
  assert.throws(() => parseOnlyId(['--apply', '--id', '20']), /等号/)
})

// ---------------------------------------------------------------- 真库

test('补发套餐权益：捞出漏发的单、只补一次、按支付时刻起算', { skip: !databaseUrl }, async t => {
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: databaseUrl })

  const createdPackages = []
  const createdUsers = []
  const createdOrders = []

  t.after(async () => {
    try {
      if (createdOrders.length) {
        // 审计留痕先删：里面带着订单号，不删会让下次跑测试时
        // 幂等标记误命中，把"待补发"判成"已补发"
        await pool.query(
          "DELETE FROM audit_logs WHERE action='发放套餐权益' AND resource_type='user' AND resource_id = ANY($1::text[])",
          [createdUsers.map(String)]
        )
        await pool.query('DELETE FROM recharges WHERE id = ANY($1::bigint[])', [createdOrders])
      }
      if (createdUsers.length) {
        await pool.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [createdUsers])
      }
      if (createdPackages.length) {
        await pool.query('DELETE FROM packages WHERE id = ANY($1::bigint[])', [createdPackages])
      }
    } catch (e) {
      console.error('  测试清理出错:', e.message)
    }
    await pool.end()
  })

  const orderNumber = `ENTBF${rand()}`
  const tag = rand()

  // 套餐：子账号额度 7（与根目录那三档不同，便于确认取的是套餐值）
  const pack = (await pool.query(
    `INSERT INTO packages(code,title,subtitle,port_limit,port_unlimited,included_chars,price,
       clients,features,sort_order,sub_quota,catalog_version,active)
     VALUES($1,$2,'',0,false,2000,65,'{}'::jsonb,'{}'::jsonb,99,7,11,true) RETURNING id`,
    [`entbf${tag}`, `补发探针套餐${tag}`])).rows[0]
  createdPackages.push(pack.id)

  // 商户：注册后从没买过套餐 —— 正是生产上「商户端不显示套餐」的那一行
  const user = (await pool.query(
    `INSERT INTO users(username,password_hash,nickname,email,email_verified,status,
       char_balance,char_used,translate_count,sub_quota,auto_alloc_master,auto_reply,
       enterprise,port_limit,ports_in_use,remarks)
     VALUES($1,'scrypt$s$h',$1,$2,false,1,2000,0,0,0,false,false,false,0,0,'')
     RETURNING id`,
    [`entbf_${tag}`, `entbf_${tag}@example.test`])).rows[0]
  createdUsers.push(user.id)

  // 历史遗留订单：status=1 已支付、字符也记了，但权益从没发过。
  // paid_at 钉在 3 天前 —— 用来区分"按支付时刻"还是"按现在"起算到期日。
  const paidAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  const order = (await pool.query(
    `INSERT INTO recharges(user_id,package_id,order_number,kind,payment_type,quantity,chars,
       original_amount,discount_amount,surcharge_amount,paid_amount,status,paid_at,
       terminal_at,terminal_reason,idempotency_key,package_catalog_version)
     VALUES($1,$2,$3,'package','USDT-TRC20',1,2000,
            45.000,10.000,0.123,35.123,1,$4::timestamptz,$4::timestamptz,'settled',$5,11)
     RETURNING id`,
    [user.id, pack.id, orderNumber, paidAt.toISOString(), `entbf:${orderNumber}`])).rows[0]
  createdOrders.push(order.id)

  const userRow = async () => (await pool.query(
    `SELECT package_id, package_catalog_version, sub_quota, port_limit, expires_at
       FROM users WHERE id=$1`, [user.id])).rows[0]

  const orderArg = `--id=${order.id}`

  const before = await userRow()
  assert.equal(before.package_id, null, '夹具本身就是"漏发"状态，否则测不出东西')

  // ---- ① 预演：必须报告出这一单，但一个字节都不许改 ----
  const dry = runScript([orderArg])
  assert.equal(dry.code, 0, `预演应当成功退出：\n${dry.out}`)
  assert.match(dry.out, new RegExp(orderNumber),
    `预演没认出这笔漏发订单 ${orderNumber}：\n${dry.out}`)
  assert.match(dry.out, /DRY-RUN/, '预演模式必须在输出里标明，避免误当成已写入')
  assert.equal((await userRow()).package_id, null,
    '预演把所有写入都回滚了，不该留下任何痕迹')

  // ---- ② 真补发：套餐、权益版本、子账号额度、到期时间一起落地 ----
  const applied = runScript(['--apply', orderArg])
  assert.equal(applied.code, 0, `补发应当成功退出：\n${applied.out}`)

  const after = await userRow()
  assert.equal(String(after.package_id), String(pack.id), 'package_id 必须落地 —— 这是"商户端显示套餐"的根')
  assert.equal(Number(after.package_catalog_version), 11, '权益版本要取订单上钉的版本')
  assert.equal(Number(after.sub_quota), 7, '子账号额度必须随套餐发放 —— 这是"能开子账号"的根')

  // 到期时间：应以**支付时刻**起算。用 SQL 算，避开 JS 与 PG 的月份加法差异。
  const expected = (await pool.query(
    "SELECT ($1::timestamptz + interval '1 month') AS ts", [paidAt.toISOString()])).rows[0].ts
  const drift = Math.abs(new Date(after.expires_at).getTime() - new Date(expected).getTime())
  assert.ok(drift < 60_000,
    `到期时间应为支付时刻 + 1 个月（${new Date(expected).toISOString()}），`
    + `实际 ${new Date(after.expires_at).toISOString()}`)

  // 反向断言：如果实现用了 now() 起算，到期日就会正好等于 now()+1月，
  // 比正确值（支付时刻+1月）晚整整 3 天。这条专门抓那个 bug。
  const nowPlusMonth = (await pool.query(
    "SELECT (now() + interval '1 month') AS ts")).rows[0].ts
  const twoDays = 2 * 24 * 60 * 60 * 1000
  assert.ok(new Date(after.expires_at).getTime() < new Date(nowPlusMonth).getTime() - twoDays,
    '到期时间被按"现在"起算了 —— 补发越晚客户亏越多，必须按支付时刻起算')

  // ---- ③ 幂等：再跑一次不许又延一个月 ----
  const again = runScript(['--apply', orderArg])
  assert.equal(again.code, 0, `重复补发不该报错：\n${again.out}`)
  assert.match(again.out, /不需要补发/,
    '已有「发放套餐权益」审计的单必须被判为已补发，否则会重复送权益')

  const final = await userRow()
  assert.equal(new Date(final.expires_at).getTime(), new Date(after.expires_at).getTime(),
    '重复补发把到期时间又延了一个月 —— 幂等被破坏了，等于白送一个月')
  assert.equal(Number(final.sub_quota), 7, '重复补发不该改动子账号额度')

  // ---- ④ 全库扫描模式：至少不能崩（真实写入会跨到别的测试数据，所以只预演） ----
  const sweep = runScript([])
  assert.equal(sweep.code, 0, `全库预演应当成功退出：\n${sweep.out}`)
})
