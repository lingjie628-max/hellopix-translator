'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const totpLib = require('../server/lib/totp')

// RFC 6238 附录 B 的官方种子：ASCII "12345678901234567890"
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii')

test('TOTP 通过 RFC 6238 附录 B 官方测试向量（SHA1/8位）', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
  ]
  for (const [seconds, expected] of vectors) {
    const actual = totpLib.totp(RFC_SECRET, seconds * 1000, { digits: 8 })
    assert.equal(actual, expected, `T=${seconds} 期望 ${expected}，实际 ${actual}`)
  }
})

test('默认参数是 6 位 / 30 秒（各验证器 App 的通行配置）', () => {
  assert.equal(totpLib.DEFAULT_DIGITS, 6)
  assert.equal(totpLib.DEFAULT_STEP, 30)
  const code = totpLib.totp(RFC_SECRET, 59 * 1000)
  assert.equal(code.length, 6)
  // 6 位即为 8 位值的后 6 位
  assert.equal(code, '287082')
})

test('base32 编解码可往返，且容忍用户带入的格式噪声', () => {
  const { raw, base32 } = totpLib.generateSecret()
  assert.equal(base32.length, 32) // 20 字节 → 32 个 base32 字符
  assert.deepEqual(totpLib.base32Decode(base32), raw)

  // 用户从验证器复制时常带空格/连字符/小写
  const messy = ` ${base32.toLowerCase().replace(/(.{4})/g, '$1-')} `
  assert.deepEqual(totpLib.base32Decode(messy), raw)
  assert.throws(() => totpLib.base32Decode('ABC!'), /非法字符/)
})

test('校验带时间容差：时钟偏移 ±1 步内仍可通过，超出则拒绝', () => {
  const { raw } = totpLib.generateSecret()
  const now = 1_700_000_000_000
  const current = totpLib.totp(raw, now)

  assert.equal(totpLib.verify(raw, current, { timeMs: now }).ok, true)
  // 服务器快 30 秒 → 用户手机上显示的仍是上一个步长的码
  assert.equal(totpLib.verify(raw, totpLib.totp(raw, now - 30_000), { timeMs: now }).ok, true)
  assert.equal(totpLib.verify(raw, totpLib.totp(raw, now + 30_000), { timeMs: now }).ok, true)
  // 偏 2 步（60 秒）超出容差
  assert.equal(totpLib.verify(raw, totpLib.totp(raw, now - 60_000), { timeMs: now }).ok, false)
})

test('校验拒绝空值、位数不对与非数字输入', () => {
  const { raw } = totpLib.generateSecret()
  assert.equal(totpLib.verify(raw, '').ok, false)
  assert.equal(totpLib.verify(raw, null).ok, false)
  assert.equal(totpLib.verify(raw, '12345').reason, 'length')
  assert.equal(totpLib.verify(raw, '1234567').reason, 'length')
  // 带空格与连字符的输入会被清洗
  const code = totpLib.totp(raw)
  assert.equal(totpLib.verify(raw, `${code.slice(0, 3)} ${code.slice(3)}`).ok, true)
})

test('counterAt 用于防重放：同一步长内计数相同，跨步长递增', () => {
  // 基准必须落在步长边界上（56666667 × 30000ms），否则 "+29 秒" 会跨到下一步，
  // 测的就不是"同步长"这件事了。
  const t = 56_666_667 * 30_000
  assert.equal(totpLib.counterAt(t), 56_666_667)
  assert.equal(totpLib.counterAt(t), totpLib.counterAt(t + 29_000))
  assert.equal(totpLib.counterAt(t + 30_000), totpLib.counterAt(t) + 1)
})

test('恢复码：格式、去重、哈希稳定且不因书写格式变化而失配', () => {
  const codes = totpLib.generateRecoveryCodes(10)
  assert.equal(codes.length, 10)
  assert.equal(new Set(codes).size, 10, '恢复码不应重复')
  for (const code of codes) assert.match(code, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/)

  const hash = totpLib.hashRecoveryCode(codes[0])
  // 用户可能小写输入或漏掉连字符，哈希必须一致
  assert.equal(totpLib.hashRecoveryCode(codes[0].toLowerCase()), hash)
  assert.equal(totpLib.hashRecoveryCode(codes[0].replace('-', '')), hash)
  assert.equal(totpLib.hashRecoveryCode(' ' + codes[0] + ' '), hash)
  assert.notEqual(totpLib.hashRecoveryCode(codes[1]), hash)
})

test('otpauth 链接符合 Key Uri 格式，验证器才能正确识别', () => {
  const url = totpLib.otpauthUrl({ secret: 'JBSWY3DPEHPK3PXP', account: 'pixadmin', issuer: 'Hello Pix' })
  assert.match(url, /^otpauth:\/\/totp\//)
  const parsed = new URL(url)
  assert.equal(parsed.hostname, 'totp')
  assert.equal(parsed.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP')
  assert.equal(parsed.searchParams.get('issuer'), 'Hello Pix')
  assert.equal(parsed.searchParams.get('digits'), '6')
  assert.equal(parsed.searchParams.get('period'), '30')
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1')
  // 标签里要同时含 issuer 与账号，否则 App 里只显示一串乱码
  assert.match(decodeURIComponent(parsed.pathname), /Hello Pix:pixadmin/)
})
