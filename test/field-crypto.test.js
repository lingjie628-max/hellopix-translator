/**
 * 敏感字段加密与盲索引测试。
 *
 * 重点在三个容易出错的地方：
 *   · 二进制被 utf8 解码损坏（TOTP 密钥上真踩过）
 *   · 规范化不一致导致同一邮箱算出两个索引（唯一约束失效）
 *   · 解不开时抛错把页面搞崩（应降级返回）
 */

const test = require('node:test')
const assert = require('node:assert/strict')

process.env.PIX_CREDENTIAL_KEY = process.env.PIX_CREDENTIAL_KEY || 'b'.repeat(64)

const fc = require('../server/lib/field-crypto')

test('加密后能原样解回，且存的是纯文本（可入 text 列）', () => {
  const email = 'alice@example.com'
  const enc = fc.encryptField(email)
  assert.ok(enc.startsWith('enc:'), '必须带前缀，读取时据此判断格式')
  assert.doesNotMatch(enc, /alice/, '密文里不得残留明文')
  assert.match(enc, /^enc:[A-Za-z0-9+/=]+$/, '必须是纯 base64 —— 二进制直接拼字符串会被 utf8 解码损坏')
  assert.equal(fc.decryptField(enc), email)
})

test('相同明文两次加密结果不同（随机 IV）', () => {
  const a = fc.encryptField('alice@example.com')
  const b = fc.encryptField('alice@example.com')
  assert.notEqual(a, b, '否则能看出两条记录用的是同一个邮箱')
})

test('盲索引：大小写与空白必须先规范化', () => {
  const a = fc.blindIndex('Alice@Example.com')
  const b = fc.blindIndex('  alice@example.com  ')
  const c = fc.blindIndex('alice@example.com')
  assert.deepEqual(a, b, '前后空白没归一')
  assert.deepEqual(a, c, '大小写没归一 —— 会导致唯一约束失效、查询查不到')
})

test('盲索引不可反推 —— 用的是 HMAC 而不是裸 SHA256', () => {
  const crypto = require('crypto')
  const idx = fc.blindIndex('alice@example.com')
  const naive = crypto.createHash('sha256').update('alice@example.com').digest()
  assert.notDeepEqual(idx, naive, '邮箱空间小可枚举，裸 SHA256 能被彩虹表反推')
})

test('盲索引与加密用的是不同的密钥派生', () => {
  // 两者相同的话，知道盲索引就等于拿到密文，隔离失去意义
  const idx = fc.blindIndex('alice@example.com')
  assert.notEqual(idx.toString('base64'), fc.encryptField('alice@example.com').slice(4))
})

test('解不开时返回空串而不是抛错 —— 不能让页面崩掉', () => {
  assert.equal(fc.decryptField('enc:这不是合法密文'), '')
  assert.equal(fc.decryptField(''), '')
  assert.equal(fc.decryptField(null), '')
})

test('兼容存量明文：迁移未跑完时不能让人看不到自己的数据', () => {
  assert.equal(fc.decryptField('alice@example.com'), 'alice@example.com')
  assert.equal(fc.isEncrypted('alice@example.com'), false)
  assert.equal(fc.isEncrypted('enc:abc'), true)
})

test('未配置密钥时拒绝加密，而不是退回明文', () => {
  const saved = process.env.PIX_CREDENTIAL_KEY
  delete process.env.PIX_CREDENTIAL_KEY
  try {
    assert.equal(fc.fieldCryptoReady(), false)
    assert.throws(() => fc.encryptField('x@y.com'), /PIX_CREDENTIAL_KEY/)
    assert.equal(fc.blindIndex('x@y.com'), null, '没密钥时索引返回 null，由上层决定是否降级')
  } finally {
    process.env.PIX_CREDENTIAL_KEY = saved
  }
})

test('seal() 一次产出密文与索引，避免只更新一列', () => {
  const s = fc.seal(' bob@Example.com ')
  assert.equal(fc.decryptField(s.value), ' bob@Example.com ', '密文保留原样（含空白），只有索引做规范化')
  assert.deepEqual(s.bidx, fc.blindIndex('bob@example.com'))
})

test('空值与 null 不产生密文', () => {
  assert.equal(fc.encryptField(''), null)
  assert.equal(fc.encryptField(null), null)
  assert.equal(fc.blindIndex(''), null)
})
