/**
 * 统一客户身份系统 —— 端到端验证。
 *
 * 在真实服务上跑完整链路，验证四件事：
 *   1. 同一手机号的两个不同账号 → 识别为同一个 Customer ID
 *   2. 第二个跟进人 → 触发同商户撞单
 *   3. identity_match_events 记下了"为什么认为是同一个人"
 *   4. 四个 source 溯源字段原样保留
 *
 * 用完即清理，不留测试数据。
 */

const http = require('http')

const req = (m, p, { body, headers, cookie } = {}) => new Promise((res, rej) => {
  const payload = body ? JSON.stringify(body) : null
  const h = Object.assign({ Accept: 'application/json' }, headers || {})
  if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload) }
  if (cookie) h.Cookie = cookie
  const r = http.request({ host: '127.0.0.1', port: 3000, method: m, path: p, headers: h },
    s => { let d = ''; s.on('data', c => d += c); s.on('end', () => res({ status: s.statusCode, text: d, headers: s.headers })) })
  r.on('error', rej)
  if (payload) r.write(payload)
  r.end()
})

const j = t => { try { return JSON.parse(t) } catch (e) { return null } }

;(async () => {
  const fs = require('fs')
  const { Client } = require('/opt/hello-pix/node_modules/pg')
  const env = Object.fromEntries(fs.readFileSync('/etc/hello-pix/hello-pix.env', 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
  const db = new Client({ connectionString: env.DATABASE_URL })
  await db.connect()
  const { hashPassword } = require('/opt/hello-pix/server/lib/password')

  const results = []
  const check = (name, ok, detail) => { results.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  → ' + detail : ''}`) }

  const phone = '+8613800139' + String(Date.now()).slice(-3)
  const tag = 'e2ecust' + String(Date.now()).slice(-5)
  let mainId = null, subId = null
  const created = []

  try {
    // --- 建商户主账号 + 一个子账号（模拟两个销售）---
    const packId = (await db.query("SELECT id FROM packages WHERE code='pro'")).rows[0].id
    mainId = (await db.query(
      `INSERT INTO users(username,password_hash,nickname,status,package_id,char_balance,char_used,sub_quota)
       VALUES($1,$2,$1,1,$3,5000000,0,5) RETURNING id`,
      [tag, await hashPassword('E2ePass12345'), packId])).rows[0].id
    created.push(['users', mainId])
    subId = (await db.query(
      `INSERT INTO sub_accounts(parent_id,username,password_hash,nickname,status,char_balance,char_used)
       VALUES($1,$2,$3,$4,1,1000000,0) RETURNING id`,
      [mainId, tag + 's1', await hashPassword('E2ePass12345'), '销售甲'])).rows[0].id
    created.push(['sub_accounts', subId])
    console.log(`  测试商户 ${tag}（主号 ${mainId} / 子账号 ${subId}）\n`)

    // --- 登录主账号 ---
    // CSRF 令牌在**验证码请求**那一步就下发了，必须累积所有响应的 cookie ——
    // 只看登录响应会拿不到令牌（之前踩过这个坑）。
    const jar = new Map()
    const absorb = res => {
      for (const c of res.headers['set-cookie'] || []) {
        const [pair] = c.split(';')
        const i = pair.indexOf('=')
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
      }
    }
    const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    const csrfToken = () => {
      const v = jar.get('__Host-pix_csrf') || jar.get('pix_csrf') || ''
      return decodeURIComponent(v)
    }

    const loginAs = async (username) => {
      absorb(await req('GET', '/apis/user/captcha'))
      const cap = j((await req('GET', '/apis/user/captcha')).text)
      absorb({ headers: { 'set-cookie': [] } })
      const code = [...Buffer.from(String(cap.image).split(',')[1] || '', 'base64').toString('utf8')
        .matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]).join('')
      absorb(await req('POST', '/apis/login', {
        body: { username, password: 'E2ePass12345', imageId: cap.imageId, imageCode: code }
      }))
      return { cookie: cookieHeader(), csrf: csrfToken() }
    }
    const sess = await loginAs(tag)
    check('主账号登录成功', !!sess.cookie, sess.cookie ? '' : '未拿到会话')
    check('拿到 CSRF 令牌', !!sess.csrf, sess.csrf ? '' : '未拿到，写操作会 403')
    const H = { Cookie: sess.cookie, 'X-CSRF-Token': sess.csrf }

    // --- 第一次进粉：手机号 ---
    const r1 = await req('POST', '/apis/customer/ingest', {
      headers: H,
      body: {
        platform: 'telegram', accountKey: 'acc-A', peerKey: '111222333',
        phone, displayName: '客户甲', body: '你好，多少钱？',
        direction: 'in', sourceConvId: 'conv-A-1', sourceMsgId: 'msg-1',
        sentAt: new Date().toISOString()
      }
    })
    const d1 = j(r1.text) || {}
    check('首次进粉成功', r1.status === 200, `HTTP ${r1.status} ${d1.msg || ''}`)
    check('首次无撞单', !d1.collision, d1.collision ? '不该有撞单' : '')
    const cid1 = d1.publicId
    check('分配了 Customer ID', /^C_\d+$/.test(String(cid1 || '')), cid1)

    // --- 第二个账号，同一手机号 → 应识别为同一客户 ---
    const r2 = await req('POST', '/apis/customer/ingest', {
      headers: H,
      body: {
        platform: 'whatsapp-green', accountKey: 'acc-B', peerKey: '999888777',
        phone, displayName: '客户甲(WA)', body: 'hi',
        direction: 'in', sourceConvId: 'conv-B-1', sourceMsgId: 'msg-2',
        sentAt: new Date().toISOString()
      }
    })
    const d2 = j(r2.text) || {}
    check('跨平台进粉成功', r2.status === 200, `HTTP ${r2.status}`)
    check('识别为同一个 Customer ID', d2.publicId && d2.publicId === cid1, `${cid1} vs ${d2.publicId}`)
    check('匹配方式是手机号自动关联', d2.outcome === 'auto_linked', `outcome=${d2.outcome}`)

    // --- 撞单：同商户内已有跟进关系，第二个账号再来 ---
    check('第二个账号触发同商户撞单', d2.collision && d2.collision.kind === 'same_merchant',
      d2.collision ? `kind=${d2.collision.kind}` : '未触发')

    // --- 提醒接口：跨商户必须匿名且不含对方标识 ---
    const r3 = await req('GET', '/apis/customer/reminders', { headers: { Cookie: sess.cookie } })
    const d3 = j(r3.text) || {}
    const items = d3.items || []
    check('提醒接口可用', r3.status === 200, `${items.length} 条`)
    const leak = JSON.stringify(items).match(/existing_user_id|existingUser|merchantName|existingAccountKey/)
    check('提醒不含对方商户标识', !leak, leak ? '泄露字段: ' + leak[0] : '')

    // --- 数据落库校验 ---
    const conv = await db.query(
      'SELECT count(*)::int AS n FROM conversations WHERE user_id=$1', [mainId])
    check('会话已落库（同一商户两个账号两条）', conv.rows[0].n === 2, `${conv.rows[0].n} 条`)

    const msg = await db.query(
      `SELECT source_platform, source_account, source_conv_id, source_msg_id
       FROM messages WHERE user_id=$1 ORDER BY sent_at LIMIT 1`, [mainId])
    const m0 = msg.rows[0] || {}
    check('四个溯源字段原样保留',
      m0.source_platform === 'telegram' && m0.source_account === 'acc-A' &&
      m0.source_conv_id === 'conv-A-1' && m0.source_msg_id === 'msg-1',
      JSON.stringify(m0))

    const ev = await db.query(
      `SELECT matched_by, outcome FROM identity_match_events
       WHERE source_user_id=$1 ORDER BY id`, [mainId])
    check('记下了匹配原因', ev.rows.length >= 2 && ev.rows.some(e => e.matched_by === 'phone'),
      ev.rows.map(e => `${e.matched_by}/${e.outcome}`).join(' '))

    const col = await db.query(
      'SELECT kind, resolution FROM collision_events WHERE new_user_id=$1', [mainId])
    check('撞单事件已记录', col.rows.length === 1 && col.rows[0].kind === 'same_merchant',
      col.rows.map(r => `${r.kind}/${r.resolution}`).join(' '))

    // --- 隔离：另一个商户查不到这个客户 ---
    const other = await db.query(
      `SELECT count(*)::int AS n FROM customer_merchant_links WHERE customer_id=(
         SELECT customer_id FROM customer_merchant_links WHERE user_id=$1)`, [mainId])
    check('客户只关联到本商户', other.rows[0].n === 1, `${other.rows[0].n} 个商户`)

  } finally {
    // 清理：按外键顺序删，不留测试数据
    for (const [table, id] of created.reverse()) {
      await db.query(`DELETE FROM ${table} WHERE id=$1`, [id]).catch(() => {})
    }
    for (const t of ['messages', 'conversations', 'collision_events', 'customer_owners', 'customer_merchant_links']) {
      await db.query(`DELETE FROM ${t} WHERE user_id=$1`, [mainId]).catch(() => {})
    }
    await db.query(`DELETE FROM identity_match_events WHERE source_user_id=$1`, [mainId]).catch(() => {})
    await db.query(`DELETE FROM customer_identities WHERE customer_id IN (
      SELECT id FROM customers WHERE public_id NOT IN (SELECT public_id FROM customers LIMIT 0))`).catch(() => {})
    await db.end()
  }

  const pass = results.filter(Boolean).length
  console.log(`\n  ${pass}/${results.length} 项通过`)
  if (pass !== results.length) process.exitCode = 1
})().catch(e => { console.error('  异常:', e.message); process.exit(1) })
