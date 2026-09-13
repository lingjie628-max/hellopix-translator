#!/usr/bin/env node
'use strict'

/**
 * 电报独立版端到端验收：把魔改 Telegram.exe 里 HelloPixTranslateProvider
 * 实际会发出的那一份 HTTP 请求，原样打到真后端上。
 *
 * 为什么需要这个脚本：
 *   补丁链路上有两段"静默失败"——
 *     1) 魔改电报的 Provider 按设计"失败就不写译文、不弹错、不崩电报"；
 *     2) 气泡不出译文和"编译没成功"从外面看完全一样。
 *   所以只要桥接文件里的 apiBase / cookies / engine 任何一项不对，都会表现为
 *   "编译了但没效果"，而没有任何报错可查。这个脚本把那条链路在本地跑通，
 *   把静默失败变成显式断言。
 *
 * 它做的事：
 *   1. 建一个临时账号，套餐取 pro（deepseek 只挂在 pro），并**故意**把
 *      active_engine_id 设成没接通的 youdao —— 复现真实库里 demo 账号的状态，
 *      用来验证启动器的三级兜底是不是真的能绕开死通道。
 *   2. 用 client 模式登录（和启动器同一个接口、同一条设备绑定路径），拿 cookie。
 *   3. 拉 /apis/translate/engines，按启动器 resolveEngine() 的同一套规则挑通道。
 *   4. 按 hello_pix_translate_provider.cpp 的 header/form 形状打 /apis/translate/run，
 *      分别验：死通道必须失败、已接通通道必须成功、同一条消息重复请求不重复扣费。
 *   5. 删掉临时账号和它产生的日志/预留。
 *
 * 用法：
 *   node scripts/verify-telegram-bridge-e2e.js
 *   BASE=http://127.0.0.1:3000 node scripts/verify-telegram-bridge-e2e.js
 *
 * 退出码 0 = 全绿；1 = 有断言没过（会打印失败原因）。
 * 注意：已接通通道那一项会真的调用厂商接口，产生极少量费用。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')

function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local')
  if (!fs.existsSync(file)) return
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/^\s*export\s+/, '').trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadEnvLocal()

const BASE = String(process.env.BASE || process.env.PIX_API || 'http://127.0.0.1:3000').replace(/\/+$/, '')

const results = []
function check(ok, label, detail) {
  results.push({ ok, label, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail ? `\n       ${detail}` : ''}`)
}

/** 极简 cookie jar：只需要 name=value。 */
function makeJar() {
  const jar = new Map()
  return {
    absorb(response) {
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = String(raw).split(';')
        const eq = pair.indexOf('=')
        if (eq < 1) continue
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        if (value === '') jar.delete(name)
        else jar.set(name, value)
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    get(name) {
      return jar.get(name) || ''
    },
    all() {
      return Object.fromEntries(jar)
    }
  }
}

/**
 * 和 standalone/telegram-win/main.js 的 resolveEngine() 保持同一套规则：
 * 只在 wired && enabled 的通道里挑，优先用户存的，其次后台 activeEngine，最后第一个。
 * 这个函数必须和启动器一起改，否则脚本会替一个假想的实现背书。
 */
function resolveEngine(engines, saved) {
  const rows = (engines.rows || []).filter(row => row && row.wired && row.enabled)
  if (!rows.length) return ''
  const active = String(engines.activeEngine || '')
  const keep = rows.find(row => String(row.id) === String(saved))
  const pick = keep || rows.find(row => String(row.id) === active) || rows[0]
  return String(pick.id)
}

/** 完全照抄 hello_pix_translate_provider.cpp 的请求形状。 */
async function providerRequest(jar, deviceId, options) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Pix-Device': deviceId,
    Cookie: jar.header(),
    'Idempotency-Key': options.idempotencyKey
  }
  const csrf = jar.get('pix_csrf') || jar.get('__Host-pix_csrf')
  if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf)
  const form = new URLSearchParams({
    text: options.text,
    from: 'auto',
    to: 'zh',
    engine: options.engine
  })
  const response = await fetch(`${BASE}/apis/translate/run`, {
    method: 'POST',
    headers,
    body: form.toString()
  })
  let body = null
  try {
    body = await response.json()
  } catch (_error) {}
  return { status: response.status, body }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('缺少 DATABASE_URL：请先准备好 .env.local，或在环境变量里显式给出。')
    process.exit(1)
  }

  console.log(`端到端验收：${BASE}\n`)

  const { pool } = require('../server/db/postgres')
  const { hashPassword } = require('../server/security')

  const health = await fetch(`${BASE}/health`).then(r => r.json()).catch(() => null)
  check(
    Boolean(health && health.ok),
    '后端可达',
    health ? `backend=${health.backend}` : `连不上 ${BASE}，先 ./scripts/dev-backend.sh`
  )
  if (!health || !health.ok) return finish(null)

  const suffix = `${process.pid}_${Date.now()}`
  const username = `e2e_tg_${suffix}`
  const password = 'E2e-Telegram-Pass9!'
  const deviceId = crypto.randomUUID()
  let userId = 0

  try {
    const created = await pool.query(
      `INSERT INTO users(username,password_hash,nickname,package_id,active_engine_id,
       char_balance,status,sub_quota)
       SELECT $1,$2,'E2E Telegram',id,'youdao',100000,1,2
       FROM packages WHERE code='pro' RETURNING id`,
      [username, hashPassword(password)]
    )
    userId = created.rows[0].id
    check(Boolean(userId), '临时账号已建（pro 套餐 + active_engine_id 故意设成未接通的 youdao）')

    const jar = makeJar()
    const loginResponse = await fetch(`${BASE}/apis/client/login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password, deviceId }).toString()
    })
    jar.absorb(loginResponse)
    const loginBody = await loginResponse.json().catch(() => null)
    check(
      loginResponse.status === 200 && loginBody && loginBody.success,
      'client 模式登录成功（与启动器同一接口/同一设备绑定路径）',
      `HTTP ${loginResponse.status}${loginBody && loginBody.msg ? ` ${loginBody.msg}` : ''}`
    )
    check(Boolean(jar.get('pix_csrf')), '拿到 CSRF cookie（Provider 靠它过 csrf 中间件）')
    if (loginResponse.status !== 200) return finish(userId)

    const enginesResponse = await fetch(`${BASE}/apis/translate/engines`, {
      headers: { Accept: 'application/json', Cookie: jar.header(), 'X-Pix-Device': deviceId }
    })
    const engines = await enginesResponse.json().catch(() => null)
    const wired = ((engines && engines.rows) || []).filter(row => row.wired && row.enabled).map(row => row.id)
    check(
      enginesResponse.status === 200 && Array.isArray(engines.rows),
      '取到通道列表 /apis/translate/engines',
      `已接通=[${wired.join(', ') || '无'}]  账号 activeEngine=${engines && engines.activeEngine}`
    )

    const resolved = resolveEngine(engines, '')
    check(
      resolved === 'deepseek' || wired.includes(resolved),
      '启动器 resolveEngine 绕开了死通道 youdao',
      resolved ? `挑中 ${resolved}` : '没挑到任何已接通通道（套餐里没有可用通道时属预期）'
    )
    if (!resolved) {
      console.log('\n  套餐里没有已接通通道，后面两项无法验证。')
      return finish(userId)
    }

    // 场景一：老版启动器硬编码的 youdao（未接通）——必须失败，且失败得干净
    const dead = await providerRequest(jar, deviceId, {
      text: 'Hello, this is a dead channel probe.',
      engine: 'youdao',
      idempotencyKey: `tg:1:1:${crypto.randomBytes(4).toString('hex')}`
    })
    check(
      Boolean(dead.body && dead.body.success === false),
      '死通道 youdao 被服务端挡下（这正是"气泡静默不出译文"的来源）',
      `HTTP ${dead.status} ${dead.body && (dead.body.code || dead.body.msg) || ''}`
    )

    // 场景二：启动器解析出来的已接通通道 —— 必须真的翻出东西
    const text = 'Good morning, the meeting starts at nine.'
    const key = `tg:777000:1001:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 8)}`
    const live = await providerRequest(jar, deviceId, { text, engine: resolved, idempotencyKey: key })
    const translated = String((live.body && live.body.translation) || '')
    check(
      live.status === 200 && live.body && live.body.success === true && translated && translated !== text,
      `已接通通道 ${resolved} 真的翻出了译文`,
      live.body && live.body.success
        ? `translation=${JSON.stringify(translated)}`
        : `HTTP ${live.status} ${(live.body && (live.body.code || live.body.msg)) || ''}`
    )
    check(
      Boolean(live.body && live.body.wired !== false),
      '服务端确认本次走的是已接通通道',
      live.body ? `wired=${live.body.wired} engine=${live.body.engine} chars=${live.body.chars}` : ''
    )

    // 场景三：同一条消息重复请求（重连/重渲染）—— 幂等键必须让它不重复扣费
    const before = await pool.query('SELECT char_balance FROM users WHERE id=$1', [userId])
    const again = await providerRequest(jar, deviceId, { text, engine: resolved, idempotencyKey: key })
    const after = await pool.query('SELECT char_balance FROM users WHERE id=$1', [userId])
    const balanceBefore = Number(before.rows[0].char_balance)
    const balanceAfter = Number(after.rows[0].char_balance)
    check(
      again.status === 200 && balanceAfter === balanceBefore,
      '重复请求同一条消息不重复扣费（幂等键生效）',
      `余额 ${balanceBefore} -> ${balanceAfter}，第二次 translation=${JSON.stringify(String((again.body && again.body.translation) || ''))}`
    )

    return finish(userId)
  } catch (error) {
    check(false, '脚本执行异常', error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n       ') : String(error))
    return finish(userId)
  }
}

async function finish(userId) {
  if (userId) {
    try {
      const { pool } = require('../server/db/postgres')
      await pool.query('DELETE FROM translate_logs WHERE user_id=$1', [userId])
      await pool.query('DELETE FROM translation_reservations WHERE user_id=$1', [userId])
      await pool.query('DELETE FROM login_logs WHERE user_id=$1', [userId])
      await pool.query('DELETE FROM users WHERE id=$1', [userId])
      console.log('\n  临时账号及其日志/预留已清理。')
    } catch (error) {
      console.log(`\n  ⚠️ 临时账号 ${userId} 清理失败：${error.message}（请手工删）`)
    }
  }
  const failed = results.filter(item => !item.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('未通过：')
    failed.forEach(item => console.log(`  - ${item.label}`))
  }
  process.exit(failed.length ? 1 : 0)
}

main()
