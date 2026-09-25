'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const databaseUrl = process.env.PIX_TEST_DATABASE_URL
const redisUrl = process.env.PIX_TEST_REDIS_URL

test('PostgreSQL and Redis preserve billing under concurrency', {
  skip: !databaseUrl || !redisUrl
}, async () => {
  process.env.DATABASE_URL = databaseUrl
  process.env.REDIS_URL = redisUrl

  const { pool } = require('../server/db/postgres')
  const { getRedis, closeRedis } = require('../server/db/redis')
  const { ProductionRepository } = require('../server/repositories/production-repository')
  const { CoreService } = require('../server/services/core-service')
  const {
    RedisSessionStore,
    RedisVerificationStore,
    createRedisSecurity
  } = require('../server/redis-security')
  const registerProductionApi = require('../server/register-production-api')
  const { hashPassword } = require('../server/security')
  const express = require('express')

  const suffix = `${process.pid}_${Date.now()}`
  const username = `it_${suffix}`
  const subUsername = `its_${suffix}`
  const repo = new ProductionRepository(pool)
  const redis = getRedis()
  await redis.connect()
  let userId
  let adminId
  let apiServer
  let apiServices
  let providerCalls = 0

  const translator = {
    countBillableChars: value => String(value).length,
    detectLang: () => 'en',
    async translate(_engine, request) {
      providerCalls += 1
      await new Promise(resolve => setTimeout(resolve, 75))
      return { ok: true, text: `译:${request.text}` }
    }
  }

  try {
    const user = await pool.query(
      `INSERT INTO users(username,password_hash,nickname,package_id,active_engine_id,
       char_balance,status,sub_quota)
       SELECT $1,$2,'Integration User',id,'deepseek',1000,1,2
       FROM packages WHERE code='basic' RETURNING id`,
      [username, hashPassword('Integration-Pass9!')]
    )
    userId = user.rows[0].id
    await assert.rejects(
      pool.query(
        `INSERT INTO sub_accounts(parent_id,username,password_hash,nickname)
         VALUES($1,$2,$3,'Duplicate')`,
        [userId, username, hashPassword('Integration-Dupe9!')]
      ),
      error => error.code === '23505'
    )
    const sub = await pool.query(
      `INSERT INTO sub_accounts(parent_id,username,password_hash,nickname,status,
       active_engine_id,char_balance)
       VALUES($1,$2,$3,'Integration Sub',1,'deepseek',0) RETURNING id`,
      [userId, subUsername, hashPassword('Integration-Sub9!')]
    )
    const subId = sub.rows[0].id
    await pool.query("UPDATE engines SET wired=true WHERE id='deepseek'")

    const sessionStore = new RedisSessionStore(redis, { ttlMs: 30_000 })
    await sessionStore.set(`session_${suffix}`, {
      type: 'user',
      subjectId: `main:${userId}`,
      csrf: `csrf_${suffix}`
    })
    assert.equal(
      (await sessionStore.get(`session_${suffix}`, 'user')).subjectId,
      `main:${userId}`
    )
    assert.equal(await sessionStore.revokeSubject('user', `main:${userId}`), 1)
    assert.equal(await sessionStore.get(`session_${suffix}`, 'user'), null)

    const admin = await pool.query(
      `INSERT INTO admins(username,password_hash,nickname,role,status)
       VALUES($1,$2,'Integration Admin','superadmin',1) RETURNING id`,
      [`admin_${suffix}`, hashPassword('Integration-Admin9!')]
    )
    adminId = admin.rows[0].id
    const app = express()
    app.use(express.urlencoded({ extended: false }))
    app.use(express.json())
    const security = createRedisSecurity({ redis, production: false })
    apiServices = registerProductionApi(app, { pool, redis, security }, {
      translator,
      startReconciliation: false
    })
    app.use((error, _req, res, _next) => {
      res.status(500).json({ success: false, msg: error.message })
    })
    apiServer = await new Promise((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
      listener.once('error', reject)
    })
    const base = `http://127.0.0.1:${apiServer.address().port}/apis`
    const form = value => new URLSearchParams(value)
    const loginRequest = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        username,
        password: 'Integration-Pass9!',
        imageId: `captcha_${suffix}`,
        imageCode: 'ABCD'
      })
    })
    assert.equal(loginRequest.status, 400)
    await new RedisVerificationStore(redis)
      .setCaptcha(`captcha_${suffix}`, 'ABCD')
    const webLogin = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        username,
        password: 'Integration-Pass9!',
        imageId: `captcha_${suffix}`,
        imageCode: 'ABCD'
      })
    })
    assert.equal(webLogin.status, 200)
    const webCookie = webLogin.headers.getSetCookie()
      .map(value => value.split(';')[0]).join('; ')
    assert.equal((await fetch(`${base}/user/dashboard`, {
      headers: { cookie: webCookie }
    })).status, 200)
    assert.equal((await fetch(`${base}/team/subs`, {
      headers: { cookie: webCookie }
    })).status, 200)
    const clientLogin = await fetch(`${base}/client/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        username,
        password: 'Integration-Pass9!',
        deviceId: `device_${suffix}`
      })
    })
    assert.equal(clientLogin.status, 200)
    const adminLogin = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        username: `admin_${suffix}`,
        password: 'Integration-Admin9!'
      })
    })
    assert.equal(adminLogin.status, 200)
    const session = await repo.sessionAccount(`main:${userId}`)
    const core = new CoreService(repo, redis, {}, {
      translator,
      reservationTtlMs: 30_000
    })
    const translations = await Promise.allSettled([
      core.translate(session, {
        text: 'hello', from: 'en', to: 'zh', engine: 'deepseek'
      }, `translate_${suffix}`),
      core.translate(session, {
        text: 'hello', from: 'en', to: 'zh', engine: 'deepseek'
      }, `translate_${suffix}`)
    ])
    assert.equal(translations.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(translations.filter(item =>
      item.status === 'rejected' && item.reason.code === 'REQUEST_IN_PROGRESS'
    ).length, 1)
    const cached = await core.translate(session, {
      text: 'hello', from: 'en', to: 'zh', engine: 'deepseek'
    }, `translate_cached_${suffix}`)
    assert.equal(cached.cached, true)
    assert.equal(cached.chars, 5)
    assert.equal(providerCalls, 1)

    const failing = new CoreService(repo, redis, {}, {
      translator: Object.assign({}, translator, {
        async translate() { return { ok: false, msg: 'provider down' } }
      })
    })
    await assert.rejects(
      failing.translate(session, {
        text: 'fail', from: 'en', to: 'zh', engine: 'deepseek'
      }, `failure_${suffix}`),
      error => error.code === 'TRANSLATE_FAILED'
    )

    const transfers = await Promise.allSettled([
      core.transferChars(session, {
        id: subId, chars: 600, requestId: `transfer_a_${suffix}`
      }),
      core.transferChars(session, {
        id: subId, chars: 600, requestId: `transfer_b_${suffix}`
      })
    ])
    assert.equal(transfers.filter(item => item.status === 'fulfilled').length, 1)

    const balances = await pool.query(
      `SELECT
       (SELECT char_balance FROM users WHERE id=$1) AS parent_balance,
       (SELECT char_balance FROM sub_accounts WHERE id=$2) AS sub_balance`,
      [userId, subId]
    )
    assert.equal(
      Number(balances.rows[0].parent_balance) + Number(balances.rows[0].sub_balance),
      990
    )

    await repo.transaction(async client => {
      await repo.adjustChars(client, 'main', userId, -10)
      await repo.query(
        `INSERT INTO translation_reservations(user_id,engine_id,idempotency_key,status,
         reserved_chars,expires_at,created_at,source_language,target_language,
         source_hash,request_hash)
         VALUES($1,'deepseek',$2,'reserved',10,NOW()-interval '1 minute',
         NOW()-interval '2 minutes','en','zh',$3,$3)`,
        [userId, `expired_${suffix}`, 'a'.repeat(64)],
        client
      )
    })
    assert.equal(await core.reconcileExpiredReservations(10), 1)
  } finally {
    if (apiServer) {
      await new Promise((resolve, reject) =>
        apiServer.close(error => error ? reject(error) : resolve()))
    }
    if (apiServices) await apiServices.stop()
    await pool.query("UPDATE engines SET wired=false WHERE id='deepseek'")
    if (userId) {
      await pool.query('DELETE FROM translate_logs WHERE user_id=$1', [userId])
      await pool.query('DELETE FROM translation_reservations WHERE user_id=$1', [userId])
      await pool.query('DELETE FROM character_transfers WHERE parent_id=$1', [userId])
      await pool.query('DELETE FROM orders WHERE user_id=$1', [userId])
      await pool.query('DELETE FROM recharges WHERE user_id=$1', [userId])
      await pool.query('DELETE FROM sub_accounts WHERE parent_id=$1', [userId])
      await pool.query('DELETE FROM users WHERE id=$1', [userId])
    }
    if (adminId) await pool.query('DELETE FROM admins WHERE id=$1', [adminId])
    await closeRedis()
    await pool.end()
  }
})
