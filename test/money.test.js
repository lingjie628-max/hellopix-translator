'use strict'

/**
 * 金额 helper 测试。
 *
 * 核心是 Rule 4：**业务层禁止用 JS 浮点数做金额运算**。
 * 所以这里既测「算得对」，也测「浮点进不来」——
 * 后者才是真正的防线，因为浮点误差不会报错，只会让金额悄悄错掉。
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  MILLI_PER_UNIT,
  toMilli,
  formatMilli,
  addMilli,
  subMilli,
  cmpMilli,
  eqMilli,
  isValidSuffixMilli,
  applySuffix
} = require('../server/lib/money')

// ------------------------------------------------------------------ 基本换算

test('毫单位是 1000 —— 1 USDT = 1000 milli', () => {
  assert.equal(MILLI_PER_UNIT, 1000n)
})

test('字符串金额转 milli：支持 0–3 位小数', () => {
  assert.equal(toMilli('35'), 35000n)
  assert.equal(toMilli('35.4'), 35400n)
  assert.equal(toMilli('35.42'), 35420n)
  assert.equal(toMilli('35.427'), 35427n)
  assert.equal(toMilli('0.001'), 1n)
  assert.equal(toMilli('0'), 0n)
  assert.equal(toMilli('125.000'), 125000n)
})

test('整数 Number 可以，小数 Number 一律拒绝 —— 这是规则本身', () => {
  assert.equal(toMilli(35), 35000n)
  // 关键断言：39.99 这种"看起来没问题"的浮点也必须被挡
  assert.throws(() => toMilli(35.427), /禁止使用 JS 浮点数/)
  assert.throws(() => toMilli(39.99), /禁止使用 JS 浮点数/)
  assert.throws(() => toMilli(0.1), /禁止使用 JS 浮点数/)
})

test('超过 3 位小数直接拒绝，不做静默四舍五入', () => {
  assert.throws(() => toMilli('35.4271'), /格式不合法/)
  assert.throws(() => toMilli('35.4275'), /格式不合法/)
})

test('非金额文本全部拒绝', () => {
  for (const bad of ['', '  ', 'abc', '35.', '.5', '3.5.7', '1e3', 'NaN', 'Infinity', null, undefined]) {
    assert.throws(() => toMilli(bad), /格式不合法/, `应当拒绝 ${JSON.stringify(bad)}`)
  }
})

test('bigint 直通（内部表示）', () => {
  assert.equal(toMilli(35427n), 35427n)
})

// ------------------------------------------------------------------ 格式化

test('milli 转字符串固定 3 位小数', () => {
  assert.equal(formatMilli(35427n), '35.427')
  assert.equal(formatMilli(35000n), '35.000')
  assert.equal(formatMilli(1n), '0.001')
  assert.equal(formatMilli(0n), '0.000')
  assert.equal(formatMilli(125999n), '125.999')
})

test('格式化与解析互为逆运算', () => {
  for (const text of ['0.001', '0.999', '35.000', '35.427', '125.000', '99999.999']) {
    assert.equal(formatMilli(toMilli(text)), text, `${text} 往返应当不变`)
  }
})

test('负数也能正确格式化（退款场景）', () => {
  assert.equal(formatMilli(-35427n), '-35.427')
  assert.equal(toMilli('-35.427'), -35427n)
})

// ------------------------------------------------------------------ 四则与比较

test('加减不丢精度', () => {
  assert.equal(addMilli(35000n, 427n), 35427n)
  assert.equal(subMilli(35427n, 427n), 35000n)
  assert.equal(formatMilli(addMilli(toMilli('0.1'), toMilli('0.2'))), '0.300')
})

test('比较与相等', () => {
  assert.equal(cmpMilli(35427n, 35427n), 0)
  assert.equal(cmpMilli(35426n, 35427n), -1)
  assert.equal(cmpMilli(35428n, 35427n), 1)
  assert.equal(eqMilli(toMilli('35.427'), 35427n), true)
  assert.equal(eqMilli(toMilli('35.428'), 35427n), false)
})

// ------------------------------------------------------------------ 尾数

test('尾数合法区间是 1–999（对应 0.001–0.999），000 不合法', () => {
  assert.equal(isValidSuffixMilli(1n), true)
  assert.equal(isValidSuffixMilli(999n), true)
  assert.equal(isValidSuffixMilli(0n), false, '000 必须被拒绝')
  assert.equal(isValidSuffixMilli(1000n), false)
  assert.equal(isValidSuffixMilli(-1n), false)
})

test('applySuffix 只做整数加法', () => {
  assert.equal(applySuffix(35000n, 427n), 35427n)
  assert.equal(formatMilli(applySuffix(toMilli('35'), 427n)), '35.427')
  assert.equal(formatMilli(applySuffix(toMilli('125'), 1n)), '125.001')
})

test('applySuffix 拒绝 0 尾数 —— 不允许回退到标准价', () => {
  assert.throws(() => applySuffix(35000n, 0n), /尾数必须在 1–999/)
  assert.throws(() => applySuffix(35000n, 1000n), /尾数必须在 1–999/)
})

// ------------------------------------------- 浮点陷阱本身（这组测试的意义所在）

test('浮点会算错，整数不会 —— 这就是禁止 Number 的原因', () => {
  // 注意：不是所有组合都会错。实测 8 个基数 × 999 个尾数 = 7992 个组合里，
  // **只有 8 个**出错，且全部集中在基数 29。正是这种 0.1% 的出错率最危险 ——
  // 随手一试往往是对的，问题只在大批量对账时才浮现。
  assert.equal(29 + 0.548, 29.548000000000002)
  assert.equal(29 + 0.577, 29.576999999999998)
  assert.notEqual(29 + 0.548, 29.548)

  // 同样的计算走整数：精确
  assert.equal(applySuffix(toMilli('29'), 548n), toMilli('29.548'))
  assert.equal(eqMilli(applySuffix(toMilli('29'), 548n), toMilli('29.548')), true)
})

test('穷举证明：999 个尾数在整数下全部精确，浮点有若干会错', () => {
  const bases = ['29', '35', '125', '350', '1250']
  let floatErrors = 0
  let milliErrors = 0

  for (const base of bases) {
    const baseMilli = toMilli(base)
    for (let suffix = 1; suffix <= 999; suffix++) {
      const text = `${base}.${String(suffix).padStart(3, '0')}`
      const expectedMilli = toMilli(text)

      // 整数路径：永远精确
      if (!eqMilli(applySuffix(baseMilli, BigInt(suffix)), expectedMilli)) milliErrors++

      // 浮点路径：会错
      if (Number(base) + suffix / 1000 !== Number(text)) floatErrors++
    }
  }

  assert.equal(milliErrors, 0, '整数路径必须 999×5 全部精确')
  assert.ok(floatErrors > 0,
    '浮点路径居然一次都没错 —— 如果真是这样，说明这个测试的构造有问题，需要复核')
})

test('链上金额比对的正确写法：两边都转 milli 再比', () => {
  // 链上返回的是最小单位整数（TRC20 USDT 是 6 位小数），换算后与订单应付比较。
  // 这里模拟「链上 35.427 USDT」→ 35427000（6 位）→ 我们的 milli 35427
  const onChainRaw = 35427000n            // 6 位小数
  const onChainMilli = onChainRaw / 1000n // 6 位 → 3 位
  const orderMilli = toMilli('35.427')
  assert.equal(eqMilli(onChainMilli, orderMilli), true)
})
