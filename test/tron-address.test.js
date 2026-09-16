'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { validTronAddress, normalizeTronAddress } = require('../server/lib/tron-address')

// 收款地址校验是资金安全的关键一环：填错地址 = 资金永久丢失。
// 这些用例覆盖"必须拒绝"的手误场景，防止将来有人把校验改松。
test('合法 TRON 地址通过校验', () => {
  const good = [
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT 官方合约
    'TAUN6FwrnwwmaEqYcckffC7wYmbaS6cBiX', // Binance 热钱包
    'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax'
  ]
  for (const address of good) {
    assert.equal(validTronAddress(address), true, `${address} 应通过`)
  }
})

test('改动任意一个字符即被拒绝（校验和生效）', () => {
  const base = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let checked = 0
  let rejected = 0
  // 逐位替换成其它 Base58 字符，凡是恰好等于原地址的跳过
  for (let i = 1; i < base.length; i++) {
    for (const ch of alphabet) {
      if (ch === base[i]) continue
      const mutated = base.slice(0, i) + ch + base.slice(i + 1)
      checked++
      if (!validTronAddress(mutated)) rejected++
    }
  }
  assert.ok(checked > 1000, '应覆盖足够多的变异样本')
  // 校验和只有 4 字节，理论上极少数变异会碰巧通过，允许 1‰ 的容差
  const passRate = (checked - rejected) / checked
  assert.ok(passRate < 0.001, `变异后误放行比例应极低，实际 ${(passRate * 100).toFixed(3)}%`)
})

test('明显的错误格式被拒绝', () => {
  const bad = [
    '',
    null,
    undefined,
    'UR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // 不以 T 开头
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj', // 太短
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6tt', // 太长
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60', // 含 0（Base58 非法）
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6O', // 含 O（Base58 非法）
    '0x1234567890abcdef1234567890abcdef12345678', // ETH 格式
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' // BTC 格式
  ]
  for (const address of bad) {
    assert.equal(validTronAddress(address), false, `${address} 应被拒绝`)
  }
})

test('规范化只去空白，不改大小写', () => {
  // TRON 地址区分大小写，转小写会变成另一个（非法）地址
  const address = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  assert.equal(normalizeTronAddress(`  ${address}  `), address)
  assert.equal(normalizeTronAddress(address), address)
})
