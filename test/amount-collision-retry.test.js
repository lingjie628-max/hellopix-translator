'use strict'

/**
 * 撞尾数 → 明确的可重试语义，而不是"数据已存在"。
 *
 * ## 真实场景
 *
 * 订单以金额为身份（`recharges_pending_amount_uq` 是 `payment_type + paid_amount`
 * 的全站唯一索引）。两个请求几乎同时 `allocate()` 时，无锁预检都能通过，
 * 后插入的那个撞唯一约束。
 *
 * 这**不是**"用户名已存在"那种用户做错了的语义 —— 用户什么都没做错，
 * 换一个尾数再来一次就成了。原实现把所有 23505 一律回成
 * `409 { code:'CONFLICT', msg:'数据已存在' }`，用户看到的是一句毫无
 * 信息量的话，然后对着同一个按钮反复点。
 *
 * 这里钉住三件事：
 *   1. 撞订单金额唯一键 → 专门错误码 + retryable
 *   2. 其它唯一键冲突 → 保持原语义（不能把用户名冲突也说成"请重试"）
 *   3. 前端确实会对 retryable 的冲突自动重发一次
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const HTTP_SRC = path.join(ROOT, 'server', 'lib', 'http.js')
const PAGE_SRC = path.join(ROOT, 'src', 'components', 'user', 'UserRechargePage.vue')

const { sendError } = require('../server/lib/http')

/** 造一个最小 res 替身，记录状态码与响应体。 */
function fakeRes() {
  const out = { status: null, body: null, headersSent: false }
  out.status = code => { out.statusCode = code; return out }
  out.json = body => { out.body = body; return out }
  return out
}

function pgUniqueViolation(constraint) {
  const err = new Error('duplicate key value violates unique constraint "' + constraint + '"')
  err.code = '23505'
  err.constraint = constraint
  return err
}

test('撞订单金额唯一键 → AMOUNT_COLLISION + retryable', () => {
  const res = fakeRes()
  let passedThrough = false
  sendError(pgUniqueViolation('recharges_pending_amount_uq'), {}, res, () => { passedThrough = true })

  assert.equal(passedThrough, false, '不该交给默认错误处理器')
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'AMOUNT_COLLISION')
  assert.equal(res.body.retryable, true, '前端靠这个字段决定能不能自动重试')
  assert.ok(/重试|再点/.test(res.body.msg), '文案要让用户知道"再点一次就行"')
})

test('其它唯一键冲突保持"数据已存在"语义', () => {
  // 用户名/邮箱冲突不能告诉用户"请重试" —— 重试多少次都还是冲突
  const res = fakeRes()
  sendError(pgUniqueViolation('users_username_lower_uidx'), {}, res, () => {})
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'CONFLICT')
  assert.equal(res.body.retryable, undefined)
})

test('没有 constraint 字段的 23505 也不能崩（老驱动可能不给）', () => {
  const res = fakeRes()
  const err = new Error('duplicate key')
  err.code = '23505'
  sendError(err, {}, res, () => {})
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'CONFLICT')
})

test('前端会对 AMOUNT_COLLISION 自动重发一次（且只重发一次）', () => {
  const src = fs.readFileSync(PAGE_SRC, 'utf8')
  assert.match(src, /AMOUNT_COLLISION/, '前端没识别这个错误码，服务端改了也白改')
  assert.match(src, /retryable/, '前端只看错误码不够，要同时认 retryable')
  // 重试必须有上限，否则真故障会变成无限循环
  assert.match(src, /attempt\s*<\s*\d+/, '自动重试没有次数上限')
})

test('http.js 里的约束名与迁移脚本一致', () => {
  // 写死字符串的唯一风险就是和迁移对不上 —— 对不上就等于这个分支永远不生效
  const migration = fs.readFileSync(path.join(ROOT, 'migrations', '020_recharge_amount_precision.js'), 'utf8')
  assert.match(migration, /recharges_pending_amount_uq/, '迁移里已经没有这个索引名了')
  const http = fs.readFileSync(HTTP_SRC, 'utf8')
  assert.match(http, /recharges_pending_amount_uq/, 'http.js 里的索引名与迁移不一致')
})
