'use strict'

/**
 * 套餐布尔开关的解析回归。
 *
 * `Boolean(Number(value))` 这个写法看起来"稳妥"，实际是在靠数值转换猜语义：
 *
 *   "1" / 1 / true   → true                （对）
 *   "0" / 0 / false  → false               （对）
 *   "no" / "off" / "disabled" / {}  → NaN → false
 *
 * 错的那几格很要命：「不限端口」被静默关掉，商户买完发现端口被卡死，
 * 而且没有任何报错。反向写法 `!Boolean(Number(x))` 则会把 "false" 变成 true。
 *
 * 结论：布尔字段一律走 `bool()`（白名单认定 true/false），不认识的值暴露出来，
 * 不要靠 Number 的数值转换来猜。
 */

const test = require('node:test')
const assert = require('node:assert')

const { PackageService } = require('../server/services/package-service')
const { bool } = require('../server/services/core-service')

function service() {
  const repo = {
    query: async () => ({ rows: [] }),
    transaction: async (fn) => fn({}),
    audit: async () => {}
  }
  return new PackageService(repo)
}

const BASE = {
  code: 'pro',
  title: '专业版',
  price: '99',
  chars: '1000000',
  subQuota: '3'
}

test('portUnlimited 的常见写法都按字面意思解析', async () => {
  const svc = service()
  const cases = [
    [undefined, true, '缺省是不限（存量套餐都是不限端口的）'],
    [true, true, '布尔 true'],
    [false, false, '布尔 false'],
    [1, true, '数字 1（旧前端）'],
    [0, false, '数字 0（旧前端）'],
    ['1', true, '字符串 "1"（表单序列化）'],
    ['0', false, '字符串 "0"'],
    ['true', true, '字符串 "true"'],
    ['false', false, '字符串 "false"'],
    ['yes', true, '字符串 "yes"'],
    ['no', false, '字符串 "no" —— 关键：Number("no") 是 NaN，旧写法会猜错'],
    ['off', false, '字符串 "off"'],
    ['on', true, '字符串 "on"']
  ]
  for (const [raw, want, why] of cases) {
    const data = Object.assign({}, BASE, raw === undefined ? {} : { portUnlimited: raw })
    const { fields } = await svc.normalize(data)
    assert.strictEqual(fields.portUnlimited, want, `${JSON.stringify(raw)} → ${JSON.stringify(want)}（${why}）`)
  }
})

test('bool() 对不认识的值返回 null，绝不会假装是 false', () => {
  assert.strictEqual(bool('maybe'), null, '不认识的值必须原样暴露，不能静默当成关闭')
  assert.strictEqual(bool(undefined), null)
  assert.strictEqual(bool(''), null)
  assert.strictEqual(bool('TRUE'), true, '大小写不敏感')
  assert.strictEqual(bool('False'), false)
  assert.strictEqual(bool(1), true)
  assert.strictEqual(bool(0), false)
})
