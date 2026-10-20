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
      // 带上真实调用才会有的三样东西：模型（成本按它算）、重试次数、厂商用量。
      // 台账的三个字段分别来自它们，缺一个就对不上账。
      return {
        ok: true,
        text: `译:${request.text}`,
        model: 'deepseek-flash',
        retries: 0,
        usage: { promptTokens: 5, completionTokens: 7, reasoningTokens: 0, totalTokens: 12 }
      }
    }
  }

  try {
    const user = await pool.query(
      `INSERT INTO users(username,password_hash,nickname,package_id,active_engine_id,
       char_balance,status,sub_quota)
       SELECT $1,$2,'Integration User',id,'deepseek',1000,1,2
       FROM packages WHERE code='advanced' RETURNING id`,
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
    // 测试库每次重建后 users 自增 ID 会从头再来，同一个 Redis 里可能留着上一轮同 ID 的
    // 会话集合成员（SET 的成员键过期了，集合本身的引用还在）。下面要断言"撤销拿到 1 条
    // 会话"，就得先把残留清掉，否则数到的是上一轮的垃圾。
    await sessionStore.revokeSubject('user', `main:${userId}`)
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
    // 超管登录**要求图形验证码**（超管是全站最高价值目标，前置阻力不能比商户端弱）。
    // 这里先种一个验证码再登录 —— 少了这一步会一直 400 BAD_CAPTCHA。
    await new RedisVerificationStore(redis)
      .setCaptcha(`admin_captcha_${suffix}`, 'ABCD')
    const adminLogin = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        username: `admin_${suffix}`,
        password: 'Integration-Admin9!',
        imageId: `admin_captcha_${suffix}`,
        imageCode: 'ABCD'
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

    // --- 上游真实消耗台账（内部口径，与客户字符账本彻底分开）------------------
    //
    // 关键点：厂商按 token 计费、我们按字符卖给客户，两套口径必须**都**记下来。
    // 只算一次成功翻译，断言台账落了一条、且没有动过客户的字符余额。
    const usageRows = await pool.query(
      `SELECT u.engine_id,u.model,u.prompt_tokens,u.completion_tokens,u.upstream_cost,u.currency
       FROM translation_usage u WHERE u.user_id=$1`, [userId])
    assert.equal(usageRows.rowCount, 1, '一次真实上游调用应留下一条用量台账')
    assert.equal(usageRows.rows[0].engine_id, 'deepseek')
    assert.equal(usageRows.rows[0].model, 'deepseek-flash',
      'model 必须落库 —— 成本对账要按具体模型算，光有通道 id 算不出钱')
    assert.equal(Number(usageRows.rows[0].prompt_tokens), 5, '上游给的真实 token 数应原样记录')
    assert.ok(Number(usageRows.rows[0].upstream_cost) > 0, '要按官方单价折算出上游成本')

    const balanceAfterUsage = await pool.query('SELECT char_balance FROM users WHERE id=$1', [userId])
    // 1000 − 首次 5 字符 − 缓存命中那次 5 字符 = 990。
    // 注意缓存命中**照样扣客户字符**（客户确实得到了一次翻译），省下的是我们的上游成本，
    // 不是客户的额度 —— 这正是下面"缓存命中不记台账"的含义。
    assert.equal(Number(balanceAfterUsage.rows[0].char_balance), 990,
      '台账是旁路：写多少条都不该影响客户字符余额')
    // 缓存命中的那次不能再记一条：缓存命中没有打上游，记 0 成本才是如实的
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM translation_usage WHERE user_id=$1', [userId]
    )).rows[0].n, 1)

    // --- 对客流水不该有能力把成功的翻译打成 500 ------------------------------
    //
    // 线上真实故障（2026-10）：`translate_logs_check` 要求
    // `source_language <> target_language`，而请求带 `auto` 时流水写的是
    // **检测出来的语言**。原文本身就是目标语言（中文→中文）时两边相等，
    // INSERT 被约束拒绝 → 整个事务回滚 → 接口 500 → 客户端显示
    // `TRANSLATE_FAILED`，可译文其实早就拿到了、字符也早就扣了。
    const sameLanguage = await core.translate(session, {
      text: '你好，这是一条测试翻译消息。', from: 'auto', to: 'zh', engine: 'deepseek'
    }, `translate_same_lang_${suffix}`)
    assert.equal(sameLanguage.success, true, '原文语言等于目标语言时，翻译仍必须成功')
    const sameLangLog = await pool.query(
      `SELECT source_language,target_language,source_hash FROM translate_logs
       WHERE user_id=$1 AND target_language='zh' ORDER BY id DESC LIMIT 1`, [userId])
    assert.equal(sameLangLog.rowCount, 1, '流水仍要落库，只是语言不能违反约束')
    assert.notEqual(sameLangLog.rows[0].source_language, sameLangLog.rows[0].target_language)
    assert.match(sameLangLog.rows[0].source_hash, /^[0-9a-f]{64}$/)

    // 即使约束实在对不上（比如以后又加了新枚举，代码没同步），
    // 也只能丢流水，译文必须照常返回 —— 这是 SAVEPOINT 兜底的意义。
    const beforeLogCount = (await pool.query(
      'SELECT count(*)::int AS n FROM translate_logs WHERE user_id=$1', [userId])).rows[0].n
    const logged = await repo.transaction(client => core.logTranslateRow(client, {
      userId, subAccountId: null, engineId: 'deepseek', reservationId: null,
      sourceLanguage: 'zh', targetLanguage: 'zh', // 故意违反 CHECK
      chars: 1, costAmount: 0, sourceHash: null, snippet: 'x',
      cached: false, durationMs: 1, trigger: '', fallbackSource: 'x'
    }))
    assert.equal(logged, null, '约束冲突时流水应被丢弃并返回 null，而不是抛异常')
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM translate_logs WHERE user_id=$1', [userId])).rows[0].n,
    beforeLogCount, '丢弃流水不应留下半条脏数据')

    // --- 套餐权益版本化：同一个套餐，版本不同 → 通道组合不同 ------------------
    //
    // 这是"不擅自改变已售权益"的执行点：老客户钉在购买时的版本，
    // 我们之后往活表里加/删通道都不会回溯改到他头上。
    //
    // V1.0.x（迁移 039）把开放通道收窄到 {gpt, deepseek}，三档一律升到 v3。
    // 注意 core.engines 的列表只按 retired_at 过滤，与 wired/enabled 无关 ——
    // 所以这里不需要为了拿列表去动 wired。
    const channelsAt = async version => {
      await pool.query('UPDATE users SET package_catalog_version=$2 WHERE id=$1', [userId, version])
      const scoped = await repo.sessionAccount(`main:${userId}`)
      return (await core.engines(scoped)).rows.map(row => row.id).sort()
    }
    const v1 = await channelsAt(1)
    const v2 = await channelsAt(2)
    const v3 = await channelsAt(3)
    assert.deepEqual(v1, ['deepseek'],
      'v1 是改动前的快照：含 gemini / google / niutrans，但都已下架，对商户只剩 deepseek 可见')
    assert.deepEqual(v2, ['deepseek', 'gpt'],
      'v2 含 qwen / doubao 等新通道，但 039 已把它们全部下架，只剩 deepseek 与 gpt')
    assert.deepEqual(v3, ['deepseek', 'gpt'],
      'v3 就是 V1.0.x 的开放集合：仅 DeepSeek 与 GPT')
    assert.ok(!v2.includes('niutrans') && !v3.includes('qwen'),
      '已下架通道对商户不可见（但对账仍查得到）')

    // 下架的通道在库里、在历史套餐快照里都还在 —— 这是"当初卖过什么"的证据
    const retiredRow = await pool.query(
      "SELECT enabled,wired,retired_at IS NOT NULL AS retired FROM engines WHERE id='qwen'")
    assert.equal(retiredRow.rows[0].retired, true, '下架是软删除：行必须还在')
    assert.equal(retiredRow.rows[0].enabled, false)

    await pool.query("UPDATE users SET package_catalog_version=NULL WHERE id=$1", [userId])

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
      976, // 1000 − 5（首次）− 5（缓存命中）− 14（中文→中文那次）—— 余额守恒
    )

    // --- 自由切换 + 余额共享 + 套餐准入 ---------------------------------------
    //
    // V1.0.x 只开放 DeepSeek 与 GPT（迁移 039），三条一起验：
    //   1. 同一个商户可以在这两个通道之间自由切换；
    //   2. 扣费与通道**无关** —— 同一段原文走哪个通道都扣同样多字符，
    //      没有渠道倍率、也不因为某个通道上游更贵就多扣；
    //   3. 已下架的通道一律拒绝，而且**不会静默换一个**可用通道。
    await pool.query("UPDATE engines SET wired=true WHERE id='gpt'")
    const viaGpt = await core.translate(session, {
      text: 'switch', from: 'en', to: 'zh', engine: 'gpt'
    }, `switch_a_${suffix}`)
    const viaDeepseek = await core.translate(session, {
      text: 'switch', from: 'en', to: 'zh', engine: 'deepseek'
    }, `switch_b_${suffix}`)
    assert.equal(viaGpt.engine, 'gpt', '用哪个通道翻译，响应里就得是哪个通道')
    assert.equal(viaGpt.chars, viaDeepseek.chars,
      '100 原文 = 100 扣费，与通道无关；这里多一分钱都是渠道倍率漏进来了')
    assert.equal(viaDeepseek.remain, viaGpt.remain - viaGpt.chars,
      '两个通道共享同一份套餐余额，扣的是一本账')

    // kimi 不在 V1.0.x 的开放集合里（只有 DeepSeek / GPT）。显式点名它必须报
    // 「套餐未包含」，绝不能"顺手"换成一个可用通道 —— 那就是静默切换供应商。
    await assert.rejects(
      core.translate(session, {
        text: 'switch', from: 'en', to: 'zh', engine: 'kimi'
      }, `switch_c_${suffix}`),
      error => error.code === 'ENGINE_NOT_ALLOWED'
    )
    // 余额不能被这次失败动过：失败要释放预留，不能留下被啃掉一角的账。
    assert.equal(Number((await pool.query(
      'SELECT char_balance FROM users WHERE id=$1', [userId]
    )).rows[0].char_balance), viaDeepseek.remain,
    '被拒绝的请求不能扣客户一个字符')
    await pool.query("UPDATE engines SET wired=false WHERE id='gpt'")

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
      // translation_usage 与 users 是 ON DELETE RESTRICT：必须先清台账再删用户，
      // 否则清理会因外键失败，把测试环境留成一堆脏数据。
      await pool.query('DELETE FROM translation_usage WHERE user_id=$1', [userId])
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
