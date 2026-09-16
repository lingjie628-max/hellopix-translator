'use strict'

/**
 * 验证「后台改价格 → 官网跟着变」这条链路真的通。
 *
 * 走的是后台真实接口（/admin/packages/save），不是直接改库 ——
 * 直接改库只能证明"读"通了，证明不了管理员在后台点保存之后官网会变。
 *
 * 测试用价 199.99，结束后无条件还原成原值。
 */
const http = require('http')

const BASE = { host: '127.0.0.1', port: 3000 }
const ADMIN_USER = process.env.ADMIN_USER
const ADMIN_PASS = process.env.ADMIN_PASS
const TARGET_CODE = process.env.TARGET_CODE || 'basic'
const TEST_PRICE = 199.99

function request(method, urlPath, { body, headers, jar } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null
    const req = http.request({
      ...BASE, method, path: urlPath,
      headers: Object.assign(
        { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar ? jar.header() : '' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        headers || {}
      )
    }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => {
        if (jar) jar.capture(res.headers['set-cookie'])
        let json = null
        try { json = JSON.parse(data) } catch (e) {}
        resolve({ status: res.statusCode, json, text: data })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function makeJar() {
  const store = new Map()
  return {
    capture(list) {
      for (const raw of list || []) {
        const [pair] = String(raw).split(';')
        const i = pair.indexOf('=')
        if (i > 0) store.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
      }
    },
    header() { return Array.from(store.entries()).map(([k, v]) => `${k}=${v}`).join('; ') },
    get(name) { return store.get(name) || '' },
    all() { return Object.fromEntries(store) }
  }
}

const solveCaptcha = svg => [...Buffer.from(String(svg).split(',')[1] || '', 'base64').toString('utf8')
  .matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]).join('')

const csrfOf = jar => {
  const c = jar.all()
  const k = Object.keys(c).find(n => /csrf/.test(n))
  return k ? c[k] : ''
}

async function publicPrice(code) {
  const res = await request('GET', '/apis/site/packages', { jar: makeJar() })
  const row = (res.json.rows || []).find(r => r.code === code)
  return row ? Number(row.price) : null
}

;(async () => {
  let original = null
  let pass = 0, fail = 0
  const check = (label, ok, extra) => {
    if (ok) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' → ' + JSON.stringify(extra) : ''}`) }
  }

  try {
    const jar = makeJar()
    original = await publicPrice(TARGET_CODE)
    console.log(`  改前官网显示价: ${original}`)

    // 登录（超管登录要过图形验证码）
    const cap = await request('GET', '/apis/user/captcha', { jar })
    const login = await request('POST', '/apis/admin/login', {
      jar,
      body: {
        username: ADMIN_USER, password: ADMIN_PASS,
        imageId: cap.json.imageId, imageCode: solveCaptcha(cap.json.image)
      }
    })
    check('管理员登录成功（未开两步验证时直接通过）', login.status === 200 && login.json.success === true, login.json)
    const csrf = csrfOf(jar)
    check('拿到 CSRF token', !!csrf)

    // 读出后台的套餐列表，取要改的那条。
    // /admin/packages 直接返回数组（不是 {rows}）。
    const list = await request('GET', '/apis/admin/packages', { jar })
    const rows = Array.isArray(list.json) ? list.json : ((list.json && list.json.rows) || [])
    const target = rows.find(r => r.code === TARGET_CODE)
    check(`后台能读到套餐 ${TARGET_CODE}`, !!target, { got: rows.length })
    if (!target) throw new Error('找不到目标套餐')

    // 保存新价格（其余字段原样回传，避免把别的字段改坏）。
    // 注意 features/engines/clients 必须传 JSON 字符串 —— 后台前端也是这么序列化的，
    // 传对象会被后端当成非法结构拒绝（第一次跑就是栽在这）。
    const save = await request('POST', '/apis/admin/packages/save', {
      jar,
      headers: { 'X-CSRF-Token': csrf },
      body: Object.assign({}, target, {
        price: TEST_PRICE,
        features: JSON.stringify(target.features || {}),
        engines: JSON.stringify(target.engines || []),
        clients: JSON.stringify(target.clients || {})
      })
    })
    check('后台保存成功', save.status === 200 && !!(save.json && save.json.success), save.json)

    const after = await publicPrice(TARGET_CODE)
    console.log(`  改后官网显示价: ${after}（期望 ${TEST_PRICE}）`)
    check('官网价格已跟随后台变化', after === TEST_PRICE, { after, expected: TEST_PRICE })
  } catch (error) {
    fail++
    console.log('  ✗ 异常: ' + error.message)
  } finally {
    // 无条件还原，避免把生产价格留在测试值上
    if (original !== null) {
      try {
        const jar = makeJar()
        const cap = await request('GET', '/apis/user/captcha', { jar })
        await request('POST', '/apis/admin/login', {
          jar, body: { username: ADMIN_USER, password: ADMIN_PASS, imageId: cap.json.imageId, imageCode: solveCaptcha(cap.json.image) }
        })
        const list = await request('GET', '/apis/admin/packages', { jar })
        const rows = Array.isArray(list.json) ? list.json : ((list.json && list.json.rows) || [])
        const target = rows.find(r => r.code === TARGET_CODE)
        if (target) {
          await request('POST', '/apis/admin/packages/save', {
            jar, headers: { 'X-CSRF-Token': csrfOf(jar) },
            body: Object.assign({}, target, {
              price: original,
              features: JSON.stringify(target.features || {}),
              engines: JSON.stringify(target.engines || []),
              clients: JSON.stringify(target.clients || {})
            })
          })
        }
        const restored = await publicPrice(TARGET_CODE)
        console.log(`  还原后官网显示价: ${restored}（原值 ${original}）`)
        if (restored !== original) { fail++; console.log('  ✗ 未能还原到原价，请手动检查！') }
        else { pass++; console.log('  ✓ 已还原到原价') }
      } catch (e) {
        fail++
        console.log('  ✗ 还原失败，请手动把价格改回 ' + original + '：' + e.message)
      }
    }
    console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
    if (fail) process.exitCode = 1
  }
})()
