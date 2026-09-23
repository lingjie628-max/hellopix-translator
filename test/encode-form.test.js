'use strict'

/**
 * 表单序列化测试。
 *
 * 对应一次真实故障：收款方式页保存时后端返回「提交的数据不是合法 JSON」。
 * 根因是 `encodeForm` 对数组一律用 `join(',')`，而
 * `[{...},{...}].join(',')` 得到的是 `"[object Object],[object Object]"`。
 * 公告页 / 线路页 / 套餐页各自手动 JSON.stringify 绕过了，收款页漏了 ——
 * 于是只有它挂，而且报错信息完全指不到真正的原因。
 *
 * src/ 是 ESM 而这里跑在 CJS 下，所以**读真实源码、去掉 export 后求值**，
 * 测的是那个文件本身，不是抄一份逻辑过来。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const SOURCE_PATH = path.join(root, 'src/utils/encode-form.js')
const source = fs.readFileSync(SOURCE_PATH, 'utf8')
// 纯函数、无 import，去掉 export 就能在 CJS 里求值
const cjsSource = source
  .replace(/^export\s+default\s+.*$/gm, '')
  .replace(/^export\s+/gm, '')
const encodeForm = new Function(cjsSource + '\nreturn encodeForm')()

/** 把 x-www-form-urlencoded 解析回对象，模拟服务端 input(req) 的视角。 */
function parseForm(encoded) {
  const out = {}
  String(encoded || '').split('&').filter(Boolean).forEach(pair => {
    const i = pair.indexOf('=')
    const k = decodeURIComponent(pair.slice(0, i))
    out[k] = decodeURIComponent(pair.slice(i + 1))
  })
  return out
}

/** 服务端 production.js 里 safeParse 的等价物 */
function safeParse(value) {
  return JSON.parse(value)
}

// --------------------------------------------------------------- 收款方式页回归

const PAYMENT_CHANNELS = [
  { id: 'usdt-trc20', name: 'USDT', network: 'TRC20', address: 'TEfCDDuYwYdjCn2WDa7TNWCU9bkBk9EXPX', note: '', enabled: 1 }
]

test('对象数组序列化成 JSON —— 收款方式页保存失败的直接修复', () => {
  const encoded = encodeForm({ paymentChannels: PAYMENT_CHANNELS })
  const parsed = parseForm(encoded)
  const value = safeParse(parsed.paymentChannels)   // 服务端就是这么解的
  assert.ok(Array.isArray(value), '服务端拿到的必须是数组')
  assert.equal(value.length, 1)
  assert.equal(value[0].address, 'TEfCDDuYwYdjCn2WDa7TNWCU9bkBk9EXPX')
  assert.equal(value[0].enabled, 1)
})

test('老写法（join 逗号）在同样的数据上必然解析失败 —— 这就是当初的 bug', () => {
  const broken = PAYMENT_CHANNELS.join(',')
  assert.equal(broken, '[object Object]')
  assert.throws(() => safeParse(broken), '证明旧实现确实会把保存打成 BAD_JSON')
})

test('多行内联数组用 JSON 反序列化后仍保持顺序与字段', () => {
  const channels = [
    { id: 'a', address: 'T1', enabled: 1 },
    { id: 'b', address: 'T2', enabled: 0 }
  ]
  const value = safeParse(parseForm(encodeForm({ paymentChannels: channels })).paymentChannels)
  assert.deepEqual(value.map(c => c.id), ['a', 'b'])
  assert.deepEqual(value.map(c => c.enabled), [1, 0])
})

// ----------------------------------------------------------------- 既有行为不能变

test('原始类型数组仍然是逗号拼接 —— 历史行为，服务端按逗号切', () => {
  const parsed = parseForm(encodeForm({ goneNoticeIds: ['1', '2', '3'] }))
  assert.equal(parsed.goneNoticeIds, '1,2,3')
  assert.deepEqual(parsed.goneNoticeIds.split(','), ['1', '2', '3'])
})

test('数字数组同样保持逗号拼接', () => {
  assert.equal(parseForm(encodeForm({ ids: [1, 2, 3] })).ids, '1,2,3')
})

test('空数组仍然是空字符串，不会变成 "[]"', () => {
  assert.equal(parseForm(encodeForm({ ids: [] })).ids, '')
})

test('普通对象序列化成 JSON', () => {
  const parsed = parseForm(encodeForm({ features: { a: 1, b: true } }))
  assert.deepEqual(JSON.parse(parsed.features), { a: 1, b: true })
})

test('已手动 JSON.stringify 的字段原样通过 —— 公告/线路/套餐三页不受影响', () => {
  const notices = [{ id: 'n1', title: '公告' }]
  const parsed = parseForm(encodeForm({ notices: JSON.stringify(notices) }))
  assert.deepEqual(JSON.parse(parsed.notices), notices)
})

test('字符串、数字、布尔、0 都要原样发出', () => {
  const parsed = parseForm(encodeForm({ name: 'USDT', port: 465, secure: true, enabled: 0 }))
  assert.equal(parsed.name, 'USDT')
  assert.equal(parsed.port, '465')
  assert.equal(parsed.secure, 'true')
  assert.equal(parsed.enabled, '0')
})

test('undefined 与 null 字段整个丢弃，不发 "key=undefined"', () => {
  const encoded = encodeForm({ a: 1, b: undefined, c: null })
  assert.equal(encoded, 'a=1')
  assert.equal(Object.prototype.hasOwnProperty.call(parseForm(encoded), 'b'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(parseForm(encoded), 'c'), false)
})

test('false 和 0 不能被当成空值丢掉', () => {
  const parsed = parseForm(encodeForm({ flag: false, count: 0, empty: '' }))
  assert.equal(parsed.flag, 'false')
  assert.equal(parsed.count, '0')
  assert.equal(parsed.empty, '')
})

test('特殊字符被正确编码，不会把 & 或 = 带进结构里', () => {
  const parsed = parseForm(encodeForm({ note: 'a&b=c d', url: 'https://x.test/?q=1&r=2' }))
  assert.equal(parsed.note, 'a&b=c d')
  assert.equal(parsed.url, 'https://x.test/?q=1&r=2')
})

test('中文与地址不会被编码坏', () => {
  const parsed = parseForm(encodeForm({ name: '请务必使用 TRC20 网络' }))
  assert.equal(parsed.name, '请务必使用 TRC20 网络')
})

test('空对象与 undefined 输入返回空串', () => {
  assert.equal(encodeForm({}), '')
  assert.equal(encodeForm(null), '')
  assert.equal(encodeForm(undefined), '')
})

test('嵌套对象数组（对象里有数组）也能完整还原', () => {
  const payload = { lines: [{ id: 1, tags: ['a', 'b'] }, { id: 2, tags: [] }] }
  const value = safeParse(parseForm(encodeForm(payload)).lines)
  assert.deepEqual(value, payload.lines)
})

// ------------------------------------------------------------------- 源码守卫

test('api.js 不再自带一份 encodeForm，改为引用共享实现', () => {
  const api = fs.readFileSync(path.join(root, 'src/utils/api.js'), 'utf8')
  assert.doesNotMatch(api, /function encodeForm\s*\(/, 'api.js 里不该再有第二份实现')
  assert.match(api, /import \{ encodeForm \} from '\.\/encode-form'/)
})

test('共享实现里不再对数组无脑 join —— 那是这次的根因', () => {
  assert.doesNotMatch(source, /Array\.isArray\(value\)\)\s*\{\s*parts\.push\([^)]*value\.join\(','\)\)/,
    '数组分支必须先判断是否含对象')
  assert.match(source, /hasObject/, '必须区分「原始类型数组」与「对象数组」')
})
