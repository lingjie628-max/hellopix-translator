'use strict'

/**
 * IP 归属地查询。
 *
 * 四个通道的响应格式差别很大（country_code vs countryCode、loc 是"纬,经"
 * 一个字符串 vs 单独的 lon/lat），这里的每一条断言都对应一个字段映射。
 * 上游一改格式，这里就该红 —— 而不是等用户说"归属地显示错了"。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createIpGeo, emptyGeo, parseIpApi, parseIpInfo, parseIpWhois, parseDbIp, CHANNELS
} = require('../desktop/src/proxy/ip-geo')

test('空 IP 直接返回空结果，不发请求', async () => {
  let called = 0
  const { lookupIpGeo } = createIpGeo({
    sessionGetText: async () => { called++ },
    getDefaultSession: () => ({}),
    parseJsonSafe: JSON.parse
  })
  const r = await lookupIpGeo('', 'dbip')
  assert.equal(r.ip, '')
  assert.equal(called, 0)
})

test('ip-api：status 必须是 success，否则算没查到', () => {
  assert.equal(parseIpApi({ status: 'fail', message: 'private range' }, '1.1.1.1').country, '')
  const r = parseIpApi({
    status: 'success', country: '美国', countryCode: 'US', regionName: '加州',
    city: '洛杉矶', lon: -118.2, lat: 34.0, timezone: 'America/Los_Angeles',
    zip: '90001', query: '8.8.8.8'
  }, '1.1.1.1')
  assert.equal(r.country, '美国(US)')
  assert.equal(r.region, '加州')
  assert.equal(r.loc, '-118.2/34', '必须是 经度/纬度')
  assert.equal(r.ip, '8.8.8.8', '以上游回报的 query 为准')
})

test('ip-api：缺经纬度时 loc 为空串，不产出 "undefined/undefined"', () => {
  const r = parseIpApi({ status: 'success', country: 'X' }, '1.1.1.1')
  assert.equal(r.loc, '')
})

test('ipinfo：loc 是"纬度,经度"一个字符串，要翻成"经度/纬度"', () => {
  const r = parseIpInfo({
    ip: '2.2.2.2', country: 'SG', region: 'Central', city: 'Singapore',
    loc: '1.2897,103.8501', timezone: 'Asia/Singapore', postal: '018989'
  }, '1.1.1.1')
  assert.equal(r.loc, '103.8501/1.2897', '顺序不能反')
  assert.equal(r.country, 'SG', 'ipinfo 只给代码，不加括号')
  assert.equal(r.zip, '018989', 'postal 要映射成 zip')
})

test('ipinfo：loc 不是两段时原样保留，不瞎拆', () => {
  assert.equal(parseIpInfo({ loc: 'weird' }, '1.1.1.1').loc, 'weird')
  assert.equal(parseIpInfo({}, '1.1.1.1').loc, '')
})

test('ipwho.is：success === false 算没查到', () => {
  assert.equal(parseIpWhois({ success: false, message: 'invalid' }, '1.1.1.1').country, '')
})

test('ipwho.is：timezone 是对象，要取 .id', () => {
  const r = parseIpWhois({
    ip: '3.3.3.3', country: '日本', country_code: 'JP', region: '东京', city: '东京',
    longitude: 139.69, latitude: 35.68, timezone: { id: 'Asia/Tokyo' }, postal: '100'
  }, '1.1.1.1')
  assert.equal(r.country, '日本(JP)', 'ipwho.is 要加括号')
  assert.equal(r.timezone, 'Asia/Tokyo', '不能把整个对象塞进去')
  assert.equal(r.loc, '139.69/35.68')
})

test('ipwho.is：timezone 缺失时是空串，不是 [object Object]', () => {
  assert.equal(parseIpWhois({}, '1.1.1.1').timezone, '')
})

test('db-ip：字段是 countryName / stateProv', () => {
  const r = parseDbIp({
    ipAddress: '4.4.4.4', countryName: '德国', countryCode: 'DE',
    stateProv: '拜仁', city: '慕尼黑'
  }, '1.1.1.1')
  assert.equal(r.country, '德国(DE)')
  assert.equal(r.region, '拜仁')
  assert.equal(r.loc, '')
  assert.equal(r.timezone, '')
})

test('认不出的 channel 回落到 db-ip', async () => {
  const seen = []
  const { lookupIpGeo } = createIpGeo({
    sessionGetText: async (_s, url) => { seen.push(url); return '{}' },
    getDefaultSession: () => ({}),
    parseJsonSafe: JSON.parse
  })
  await lookupIpGeo('1.1.1.1', 'unknown-channel')
  assert.match(seen[0], /db-ip\.com/, '未知通道必须有个兜底，不能什么都不查')
})

test('每个通道用各自的域名', async () => {
  const seen = []
  const { lookupIpGeo } = createIpGeo({
    sessionGetText: async (_s, url) => { seen.push(url); return '{}' },
    getDefaultSession: () => ({}),
    parseJsonSafe: JSON.parse
  })
  for (const ch of Object.keys(CHANNELS)) await lookupIpGeo('1.1.1.1', ch)
  assert.match(seen[0], /ip-api\.com/)
  assert.match(seen[1], /ipinfo\.io/)
  assert.match(seen[2], /ipwho\.is/)
  assert.match(seen[3], /db-ip\.com/)
})

test('★ IP 必须被 encodeURIComponent —— 不能让人把查询串拼进 URL', async () => {
  let seen = ''
  const { lookupIpGeo } = createIpGeo({
    sessionGetText: async (_s, url) => { seen = url; return '{}' },
    getDefaultSession: () => ({}),
    parseJsonSafe: JSON.parse
  })
  await lookupIpGeo('1.1.1.1&foo=bar', 'ipinfo')
  assert.ok(!seen.includes('&foo=bar'), 'IP 里的特殊字符必须被编码：' + seen)
})

test('★ 请求失败时返回空结果（不能让节点检测跟着失败），但要有线索', async () => {
  const errs = []
  const { lookupIpGeo } = createIpGeo({
    sessionGetText: async () => { throw new Error('ENOTFOUND') },
    getDefaultSession: () => ({}),
    parseJsonSafe: JSON.parse,
    onError: (ch, e) => errs.push([ch, e.message])
  })
  const r = await lookupIpGeo('1.1.1.1', 'ipinfo')
  assert.equal(r.country, '', '归属地是锦上添花，查不到不能连带失败')
  assert.equal(r.ip, '1.1.1.1', '至少保留查询的 IP')
  assert.deepEqual(errs, [['ipinfo', 'ENOTFOUND']], '必须留线索，否则又是静默失败')
})

test('响应不是 JSON 时返回空结果，不抛', async () => {
  const { lookupIpGeo } = createIpGeo({
    sessionGetText: async () => '<html>blocked</html>',
    getDefaultSession: () => ({}),
    parseJsonSafe: txt => { try { return JSON.parse(txt) } catch (e) { return null } }
  })
  const r = await lookupIpGeo('1.1.1.1', 'ipapi')
  assert.equal(r.country, '')
})

test('emptyGeo 结构稳定（上层会直接读这些字段）', () => {
  const e = emptyGeo('9.9.9.9')
  for (const k of ['ip', 'country', 'region', 'city', 'loc', 'timezone', 'zip']) {
    assert.ok(k in e, '缺字段：' + k)
  }
})
