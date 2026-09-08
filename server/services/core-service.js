'use strict'

const crypto = require('crypto')
const defaultTranslator = require('./translation-provider')
const platforms = require('../../desktop/platforms')
const { ApiError } = require('../lib/http')
const { mapRow, mapRows } = require('../repositories/production-repository')
const { RedisTranslationCache, RedisShareGrantStore } = require('../stores')
const catalog = require('../lib/client-catalog')

function number(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : (fallback || 0)
}

function setting(settings, key, fallback) {
  return settings[key] === undefined || settings[key] === null ? fallback : settings[key]
}

function json(value, fallback) {
  if (value && typeof value === 'object') return value
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch (_error) { return fallback }
  }
  return fallback
}

function requestDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

class CoreService {
  constructor(repository, redis, auth, options) {
    if (!redis || typeof redis.get !== 'function' || typeof redis.set !== 'function') {
      throw new TypeError('context.redis 必须是 ioredis 客户端')
    }
    this.repo = repository
    this.redis = redis
    this.auth = auth
    this.translator = options && options.translator || defaultTranslator
    this.translationCache = options && options.translationCache ||
      new RedisTranslationCache(redis)
    this.shareGrants = options && options.shareGrants ||
      new RedisShareGrantStore(redis)
    this.reservationTtlMs = Math.max(30_000, Number(options && options.reservationTtlMs) || 120_000)
    this.reconciliationTimer = null
    this.reconciliationRun = null
  }

  profile(session) {
    const account = session.account
    const parent = session.parent
    return {
      id: account.id,
      role: session.kind,
      username: account.username,
      nickname: account.nickname || account.username,
      email: account.email || parent.email || '',
      basename: parent.packageTitle || '',
      versionId: parent.packageId,
      packageId: parent.packageId,
      charBalance: number(account.charBalance),
      parentCharBalance: number(parent.charBalance),
      enterprise: parent.enterprise ? 1 : 0,
      bound: account.boundDevice ? 1 : 0,
      activeEngine: account.activeEngineId || parent.activeEngineId || 'youdao',
      expireTime: parent.expiresAt,
      port: number(parent.portLimit),
      userPorts: number(parent.portsInUse),
      standaloneClient: catalog.packageAllowsStandalone(json(parent.packageClients, {})) ? 1 : 0
    }
  }

  async dashboard(session) {
    const [subs, count, settings] = await Promise.all([
      this.repo.query(
        `SELECT id,parent_id,username,nickname,email,char_balance,char_used,auto_alloc,status,
         bound_device,active_engine_id,translate_count,created_at
         FROM sub_accounts WHERE parent_id=$1 ORDER BY id LIMIT 100`,
        [session.parent.id]
      ),
      this.repo.query('SELECT count(*)::int AS count FROM sub_accounts WHERE parent_id=$1', [session.parent.id]),
      this.repo.settings()
    ])
    return Object.assign(this.profile(session), {
      packageTitle: session.parent.packageTitle || '',
      subCount: count.rows[0].count,
      subQuota: number(session.parent.subQuota),
      autoAllocMaster: session.parent.autoAllocMaster ? 1 : 0,
      charUsed: number(session.account.charUsed),
      translateCount: number(session.account.translateCount),
      announcement: setting(settings, 'site.announcement', ''),
      telegram: setting(settings, 'support.telegram', ''),
      telegramUrl: setting(settings, 'support.telegram_url', ''),
      clientDownloadUrl: setting(settings, 'downloads.client_url', ''),
      subs: session.kind === 'main' ? mapRows(subs.rows) : []
    })
  }

  async quote(data) {
    const pack = await this.repo.package(data.baseid || data.id)
    if (!pack) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')
    const qty = Math.max(1, Math.floor(number(data.month || data.qty, 1)))
    const discounts = setting(await this.repo.settings(), 'billing.discounts', {})
    const rate = number(discounts[qty >= 50 ? '50' : (qty >= 10 ? '10' : '1')], qty >= 50 ? 0.75 : (qty >= 10 ? 0.8 : 0.9))
    const originalPrice = number(pack.price) * qty
    const paidAmount = Math.round(originalPrice * rate * 100) / 100
    return {
      qty, rate, originalPrice, paidAmount,
      discountAmount: Math.round((originalPrice - paidAmount) * 100) / 100,
      subQuotaAdded: qty,
      chars: number(pack.includedChars) * qty
    }
  }

  async teamInfo(session) {
    const [count, settings] = await Promise.all([
      this.repo.query('SELECT count(*)::int AS count FROM sub_accounts WHERE parent_id=$1', [session.parent.id]),
      this.repo.settings()
    ])
    return Object.assign(this.profile(session), {
      parentUsername: session.parent.username,
      subCount: count.rows[0].count,
      subQuota: number(session.parent.subQuota),
      autoAllocMaster: session.parent.autoAllocMaster ? 1 : 0,
      enterpriseMinPacks: number(setting(settings, 'billing.enterprise_min_packs', 2), 2),
      imUnlimited: 1
    })
  }

  async saveSub(session, data) {
    if (session.kind !== 'main') throw new ApiError(403, '仅主账号可管理子账号', 'MAIN_ACCOUNT_REQUIRED')
    if (data.id) {
      const fields = []
      const values = []
      for (const [inputName, column, transform] of [
        ['nickname', 'nickname', String],
        ['email', 'email', value => value ? String(value).toLowerCase() : null],
        ['status', 'status', value => number(value)],
        ['autoAlloc', 'auto_alloc', value => Boolean(number(value))]
      ]) {
        if (data[inputName] !== undefined) {
          values.push(transform(data[inputName]))
          fields.push(`${column}=$${values.length}`)
        }
      }
      if (data.password) {
        values.push(await this.auth.hash(data.password))
        fields.push(`password_hash=$${values.length}`)
      }
      if (!fields.length) return
      values.push(data.id, session.parent.id)
      const result = await this.repo.query(
        `UPDATE sub_accounts SET ${fields.join(',')},updated_at=NOW()
         WHERE id=$${values.length - 1} AND parent_id=$${values.length} RETURNING id,status`,
        values
      )
      if (!result.rows[0]) throw new ApiError(404, '子账号不存在', 'SUB_NOT_FOUND')
      if (data.password || number(result.rows[0].status) !== 1) await this.auth.revokeUser('sub', data.id)
      return
    }
    if (!data.username) throw new ApiError(400, '请填写登录账号', 'USERNAME_REQUIRED')
    const passwordHash = await this.auth.hash(data.password)
    await this.repo.transaction(async client => {
      const parent = await this.repo.query('SELECT sub_quota FROM users WHERE id=$1 FOR UPDATE', [session.parent.id], client)
      const count = await this.repo.query('SELECT count(*)::int AS count FROM sub_accounts WHERE parent_id=$1', [session.parent.id], client)
      if (!parent.rows[0] || count.rows[0].count >= number(parent.rows[0].sub_quota)) {
        throw new ApiError(409, '子账号名额已满', 'SUB_QUOTA_FULL')
      }
      await this.repo.query(
        `INSERT INTO sub_accounts(parent_id,username,password_hash,nickname,email,status,active_engine_id)
         VALUES($1,$2,$3,$4,$5,1,$6)`,
        [session.parent.id, String(data.username).trim(), passwordHash, data.nickname || data.username,
          data.email ? String(data.email).toLowerCase() : null, session.parent.activeEngineId || null],
        client
      )
    })
  }

  async transferChars(session, data) {
    if (session.kind !== 'main') throw new ApiError(403, '仅主账号可分配字符', 'MAIN_ACCOUNT_REQUIRED')
    const chars = Math.trunc(number(data.chars))
    if (!chars) throw new ApiError(400, '请填写分配字符数', 'CHARS_REQUIRED')
    return this.repo.transaction(async client => {
      await this.repo.lockAccount(client, 'main', session.parent.id)
      const sub = mapRow((await this.repo.query(
        'SELECT * FROM sub_accounts WHERE id=$1 AND parent_id=$2 FOR UPDATE',
        [data.id, session.parent.id], client
      )).rows[0])
      if (!sub) throw new ApiError(404, '子账号不存在', 'SUB_NOT_FOUND')
      if (chars > 0) {
        await this.repo.adjustChars(client, 'main', session.parent.id, -chars)
        await this.repo.adjustChars(client, 'sub', sub.id, chars)
      } else {
        await this.repo.adjustChars(client, 'sub', sub.id, chars)
        await this.repo.adjustChars(client, 'main', session.parent.id, -chars)
      }
      await this.repo.query(
        `INSERT INTO character_transfers(parent_id,sub_account_id,amount,operator_type,operator_id,idempotency_key)
         VALUES($1,$2,$3,'user',$1,$4)`,
        [session.parent.id, sub.id, chars, data.requestId || null], client
      )
      return { username: sub.username, chars }
    })
  }

  async listOrders(userId, data, paging) {
    const values = [userId]
    const clauses = ['user_id=$1']
    if (data.serialNumber) { values.push(`%${data.serialNumber}%`); clauses.push(`serial_number ILIKE $${values.length}`) }
    if (data.title) { values.push(`%${data.title}%`); clauses.push(`title ILIKE $${values.length}`) }
    if (data.status !== undefined && data.status !== '') { values.push(number(data.status)); clauses.push(`status=$${values.length}`) }
    const result = await this.repo.list('orders', { where: clauses.join(' AND '), values, limit: paging.size, offset: paging.offset })
    result.rows = result.rows.map(row => Object.assign(row, {
      port: row.portLimit,
      totalUser: row.totalUsers,
      completeTarget: row.completedTarget,
      expirationTime: row.expiresAt,
      passwordExpirationTime: row.sharePasswordExpiresAt
    }))
    return result
  }

  async saveOrder(userId, data, operation) {
    if (operation === 'add' || !data.id) {
      await this.repo.query(
        `INSERT INTO orders(user_id,serial_number,title,type,port_limit,total_target,day_target,
          expires_at,distribution_mode,status,zero_time,remarks,assistant)
         VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz,NOW()+interval '30 days'),$9,1,$10,$11,$12)`,
        [userId, `HP${Date.now()}${crypto.randomInt(100, 999)}`, String(data.title || '新工单').slice(0, 200),
          data.type || 'whatsApp', Math.max(0, number(data.port, 1)), Math.max(0, number(data.totalTarget)),
          Math.max(0, number(data.dayTarget, 1)), data.expirationTime || null, number(data.distributionMode, 1),
          data.zeroTime || '00:00:00', String(data.remarks || '').slice(0, 1000), String(data.assistant || '').slice(0, 200)]
      )
      return
    }
    const result = await this.repo.query(
      `UPDATE orders SET title=COALESCE($3,title),type=COALESCE($4,type),
       port_limit=COALESCE($5,port_limit),total_target=COALESCE($6,total_target),
       day_target=COALESCE($7,day_target),expires_at=COALESCE($8::timestamptz,expires_at),
       zero_time=COALESCE($9::time,zero_time),remarks=COALESCE($10,remarks),
       assistant=COALESCE($11,assistant),updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING id`,
      [data.id, userId, data.title || null, data.type || null,
        data.port === undefined ? null : Math.max(0, number(data.port)),
        data.totalTarget === undefined ? null : Math.max(0, number(data.totalTarget)),
        data.dayTarget === undefined ? null : Math.max(0, number(data.dayTarget)),
        data.expirationTime || null, data.zeroTime || null,
        data.remarks === undefined ? null : String(data.remarks).slice(0, 1000), data.assistant || null]
    )
    if (!result.rows[0]) throw new ApiError(404, '工单不存在', 'ORDER_NOT_FOUND')
  }

  deleteOrders(userId, ids) {
    return this.repo.query('DELETE FROM orders WHERE user_id=$1 AND id=ANY($2::bigint[])', [userId, ids])
  }

  async sharePassword(data) {
    const order = mapRow((await this.repo.query('SELECT * FROM orders WHERE serial_number=$1', [data.serialNumber])).rows[0])
    if (!order || !order.sharePasswordHash || !(await this.auth.verify(order.sharePasswordHash, data.sharePassword))) {
      throw new ApiError(403, '分享密码错误', 'BAD_SHARE_PASSWORD')
    }
    if (!order.sharePasswordExpiresAt || new Date(order.sharePasswordExpiresAt).getTime() <= Date.now()) {
      throw new ApiError(410, '工单分享已过期', 'SHARE_EXPIRED')
    }
    const token = await this.shareGrants.issue(order.serialNumber)
    return { code: 200, msg: order.zeroTime, data: order.sharePasswordExpiresAt, token }
  }

  async assertShare(token, serial) {
    if (!await this.shareGrants.validate(token, serial)) {
      throw new ApiError(403, '分享凭证无效或已过期', 'INVALID_SHARE_GRANT')
    }
  }

  async engines(session) {
    const rows = await this.repo.packageEngines(session.parent.packageId)
    const active = session.account.activeEngineId || session.parent.activeEngineId || (rows[0] && rows[0].id)
    return {
      wired: rows.some(row => row.wired),
      packageTitle: session.parent.packageTitle || '',
      charBalance: number(session.account.charBalance),
      activeEngine: active,
      rows: rows.map(row => Object.assign(row, { allowed: true, active: row.id === active }))
    }
  }

  async translate(session, data, idempotencyKey) {
    const raw = String(data.text || data.source || '').trim()
    if (!raw) throw new ApiError(400, '请输入要翻译的文本', 'TEXT_REQUIRED')
    if (raw.length > 5000) throw new ApiError(413, '单次翻译最多 5000 个字符', 'TEXT_TOO_LONG')
    const text = raw.replace(/\p{Extended_Pictographic}/gu, '').replace(/[\uFE0F\u200D\u20E3]/g, '').replace(/\s+/g, ' ').trim()
    if (!text) return { success: true, wired: true, skipped: 'emoji', translation: '', chars: 0, remain: number(session.account.charBalance) }
    const from = String(data.from || 'auto')
    const to = String(data.to || 'zh')
    if (!/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/i.test(from) || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(to)) {
      throw new ApiError(400, '语言参数无效', 'BAD_LANGUAGE')
    }
    const engineId = String(data.engine || session.account.activeEngineId || session.parent.activeEngineId || 'youdao')
    const allowed = await this.repo.packageEngines(session.parent.packageId)
    const engine = allowed.find(row => row.id === engineId && row.enabled)
    if (!engine) throw new ApiError(403, '当前套餐未包含此通道', 'ENGINE_NOT_ALLOWED')
    if (!engine.wired) {
      throw new ApiError(503, '真实翻译通道尚未配置', 'ENGINE_NOT_CONFIGURED')
    }
    const chars = this.translator.countBillableChars(text)
    const key = String(idempotencyKey || data.requestId || '').trim()
    if (!key || key.length > 160) throw new ApiError(400, '缺少有效的 Idempotency-Key', 'IDEMPOTENCY_KEY_REQUIRED')
    const sourceHash = crypto.createHash('sha256').update(text).digest('hex')
    const requestHash = requestDigest({ subAccountId: session.kind === 'sub' ? session.account.id : null, engineId, from, to, sourceHash })
    const lockKey = `pix:translate:lock:${session.parent.id}:${key}`
    const lockToken = crypto.randomBytes(16).toString('hex')
    if (!await this.redis.set(lockKey, lockToken, 'NX', 'PX', this.reservationTtlMs)) {
      throw new ApiError(409, '相同翻译请求正在处理', 'REQUEST_IN_PROGRESS')
    }
    let reservation
    const started = Date.now()
    try {
      reservation = await this.repo.transaction(async client => {
        const existing = mapRow((await this.repo.query(
          'SELECT * FROM translation_reservations WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE',
          [session.parent.id, key], client
        )).rows[0])
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ApiError(409, 'Idempotency-Key 已用于其他请求', 'IDEMPOTENCY_KEY_REUSED')
          }
          return existing
        }
        const account = await this.repo.lockAccount(client, session.kind, session.account.id)
        if (!account || number(account.charBalance) < chars) throw new ApiError(409, '字符余额不足', 'INSUFFICIENT_CHARS')
        await this.repo.adjustChars(client, session.kind, session.account.id, -chars)
        const inserted = await this.repo.query(
          `INSERT INTO translation_reservations(user_id,sub_account_id,engine_id,idempotency_key,
           status,reserved_chars,expires_at,source_language,target_language,source_hash,request_hash)
           VALUES($1,$2,$3,$4,'reserved',$5,NOW()+($6::text||' milliseconds')::interval,$7,$8,$9,$10)
           RETURNING *`,
          [session.parent.id, session.kind === 'sub' ? session.account.id : null, engineId, key,
            chars, this.reservationTtlMs, from, to, sourceHash, requestHash], client
        )
        return mapRow(inserted.rows[0])
      })
      if (reservation.responseJson) return reservation.responseJson
      if (reservation.status !== 'reserved') throw new ApiError(409, '该请求已结束，不能重试', 'REQUEST_FINALIZED')
      if (new Date(reservation.expiresAt).getTime() <= Date.now()) {
        await this.reconcileExpiredReservations(1, reservation.id)
        throw new ApiError(409, '翻译预留已超时并退款', 'RESERVATION_EXPIRED')
      }

      const cacheTenant = `${session.kind}:${session.account.id}`
      const cacheRequest = { engine: engineId, from, to, text }
      let cachedText = null
      try {
        cachedText = await this.translationCache.get(cacheTenant, cacheRequest)
      } catch (error) {
        console.error('Translation cache read failed:', error.message)
      }
      const result = cachedText == null
        ? await this.translator.translate(engine, {
          text, from, to, detected: this.translator.detectLang(text)
        }, { allowPublicNetwork: false })
        : { ok: true, text: cachedText, cached: true }
      if (!result || !result.ok) throw new ApiError(502, result && result.msg || '翻译服务暂不可用', 'TRANSLATE_FAILED')
      const translated = String(result.text || '').trim()
      const refundable = Boolean(result.skipped || !translated || translated.toLocaleLowerCase() === text.toLocaleLowerCase())
      if (!refundable && !result.cached) {
        try {
          await this.translationCache.set(cacheTenant, cacheRequest, translated)
        } catch (error) {
          console.error('Translation cache write failed:', error.message)
        }
      }
      return await this.repo.transaction(async client => {
        const current = mapRow((await this.repo.query(
          'SELECT * FROM translation_reservations WHERE id=$1 FOR UPDATE',
          [reservation.id], client
        )).rows[0])
        if (current.responseJson) return current.responseJson
        if (!current || current.status !== 'reserved') throw new ApiError(409, '翻译预留已结束', 'RESERVATION_FINALIZED')
        const durationMs = Date.now() - started
        if (refundable) await this.repo.adjustChars(client, session.kind, session.account.id, chars)
        const balance = await this.repo.lockAccount(client, session.kind, session.account.id)
        const response = {
          success: true,
          wired: Boolean(engine.wired),
          cached: Boolean(result.cached),
          skipped: refundable ? (result.skipped || 'unchanged') : undefined,
          translation: translated,
          chars: refundable ? 0 : chars,
          remain: number(balance.charBalance),
          from: from === 'auto' ? this.translator.detectLang(text) : from,
          engine: engineId
        }
        if (!refundable) {
          const table = session.kind === 'sub' ? 'sub_accounts' : 'users'
          await this.repo.query(
            `UPDATE ${table} SET char_used=char_used+$2,translate_count=translate_count+1,updated_at=NOW() WHERE id=$1`,
            [session.account.id, chars], client
          )
          await this.repo.query(
            `INSERT INTO translate_logs(user_id,sub_account_id,engine_id,reservation_id,
             source_language,target_language,chars,cost_amount,sell_amount,source_hash,snippet,cached,duration_ms)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12)`,
            [session.parent.id, session.kind === 'sub' ? session.account.id : null, engineId, reservation.id,
              response.from, to, chars, number(engine.costPerMillion) * chars / 1000000, sourceHash,
              text.slice(0, 300), Boolean(result.cached), durationMs], client
          )
        }
        const settlement = refundable
          ? `status='released',committed_chars=0,committed_at=NULL,released_at=NOW()`
          : `status='committed',committed_chars=$2,committed_at=NOW(),released_at=NULL`
        const values = refundable
          ? [reservation.id, JSON.stringify(response), durationMs]
          : [reservation.id, chars, JSON.stringify(response), durationMs]
        await this.repo.query(
          `UPDATE translation_reservations SET ${settlement},
           response_json=$${refundable ? 2 : 3}::jsonb,
           duration_ms=$${refundable ? 3 : 4},updated_at=NOW() WHERE id=$1`,
          values, client
        )
        return response
      })
    } catch (error) {
      if (reservation && reservation.status === 'reserved') {
        await this.releaseReservation(reservation.id, error.code || 'TRANSLATE_FAILED')
      }
      throw error
    } finally {
      await this.redis.eval(
        'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',
        1, lockKey, lockToken
      )
    }
  }

  async releaseReservation(id, errorCode) {
    return this.repo.transaction(async client => {
      const row = mapRow((await this.repo.query(
        'SELECT * FROM translation_reservations WHERE id=$1 FOR UPDATE',
        [id], client
      )).rows[0])
      if (!row || row.status !== 'reserved') return false
      await this.repo.adjustChars(client, row.subAccountId ? 'sub' : 'main', row.subAccountId || row.userId, number(row.reservedChars))
      await this.repo.query(
        `UPDATE translation_reservations SET status='released',released_at=NOW(),
         error_code=$2,updated_at=NOW() WHERE id=$1`,
        [id, String(errorCode || 'RELEASED').slice(0, 80)], client
      )
      return true
    })
  }

  async reconcileExpiredReservations(limit, onlyId) {
    return this.repo.transaction(async client => {
      const values = [Math.max(1, Math.min(Number(limit) || 100, 500))]
      let idClause = ''
      if (onlyId) {
        values.push(onlyId)
        idClause = 'AND id=$2'
      }
      const expired = await this.repo.query(
        `SELECT * FROM translation_reservations
         WHERE status='reserved' AND expires_at<=NOW() ${idClause}
         ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        values, client
      )
      for (const raw of expired.rows) {
        const row = mapRow(raw)
        await this.repo.adjustChars(client, row.subAccountId ? 'sub' : 'main', row.subAccountId || row.userId, number(row.reservedChars))
        await this.repo.query(
          `UPDATE translation_reservations SET status='expired',released_at=NOW(),
           error_code='RESERVATION_TIMEOUT',updated_at=NOW() WHERE id=$1`,
          [row.id], client
        )
      }
      return expired.rows.length
    })
  }

  startReservationReconciliation(options) {
    if (this.reconciliationTimer) return this.reconciliationTimer
    const intervalMs = Math.max(5_000, Number(options && options.intervalMs) || 30_000)
    const onError = options && options.onError || (error => console.error('Reservation reconciliation failed:', error))
    const run = () => {
      if (this.reconciliationRun) return this.reconciliationRun
      this.reconciliationRun = this.reconcileExpiredReservations()
        .catch(onError)
        .finally(() => { this.reconciliationRun = null })
      return this.reconciliationRun
    }
    run()
    this.reconciliationTimer = setInterval(() => {
      run()
    }, intervalMs)
    this.reconciliationTimer.unref()
    return this.reconciliationTimer
  }

  async stopReservationReconciliation() {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer)
    this.reconciliationTimer = null
    if (this.reconciliationRun) await this.reconciliationRun
  }

  publicReleases(rows) {
    return (rows || []).map(row => catalog.publicRelease(mapRow(row) || row)).filter(Boolean)
  }

  async siteInfo() {
    const [settings, lines, clients] = await Promise.all([
      this.repo.settings(),
      this.repo.query('SELECT id,name,url,region,enabled FROM client_lines WHERE enabled=true ORDER BY sort_order,id'),
      this.repo.query('SELECT * FROM client_releases WHERE enabled=true ORDER BY created_at DESC,id DESC')
    ])
    const listed = this.publicReleases(clients.rows)
    const download = group => {
      const row = listed.find(item => item.releaseGroup === group)
      return row ? row.url : ''
    }
    const standaloneApps = listed.filter(item => item.releaseGroup === 'standalone')
    const discounts = setting(settings, 'billing.discounts', {})
    return {
      siteName: setting(settings, 'site.name', 'Hello Pix'),
      announcement: setting(settings, 'site.announcement', ''),
      clientDownloadUrl: setting(settings, 'downloads.client_url', ''),
      clientDownloads: {
        app: setting(settings, 'downloads.client_url', ''),
        windows: download('windows'), macos: download('macos'), android: download('android'),
        ios: download('ios'),
        standalone: standaloneApps[0] ? standaloneApps[0].url : '',
        standaloneApps
      },
      officialUrl: setting(settings, 'links.official_url', ''),
      guideUrl: setting(settings, 'links.guide_url', ''),
      telegram: setting(settings, 'support.telegram', ''),
      telegramUrl: setting(settings, 'support.telegram_url', ''),
      supportBtnText: setting(settings, 'support.button_text', '联系客服'),
      supportShow: setting(settings, 'support.visible', true) ? 1 : 0,
      supportNote: setting(settings, 'support.note', ''),
      discount1: number(discounts['1'], 0.9),
      discount10: number(discounts['10'], 0.8),
      discount50: number(discounts['50'], 0.75),
      packageBill: '',
      imUnlimited: 1,
      lines: mapRows(lines.rows)
    }
  }

  platforms() {
    return platforms.filter(item => item.listed !== false)
  }

  async findUpdate(data) {
    const os = String(data.os || '')
    const arch = String(data.arch || '')
    const app = String(data.app || '').trim()
    const listed = this.publicReleases(
      (await this.repo.query('SELECT * FROM client_releases WHERE enabled=true ORDER BY created_at DESC,id DESC')).rows
    ).filter(row => !app
      ? row.releaseGroup !== 'standalone' && row.releaseGroup !== 'counter'
      : row.app === app)
    const score = row => {
      let points = 0
      if (os === 'darwin' && /mac/i.test([row.releaseGroup, row.os].join(' '))) points += 10
      if (os === 'win32' && /windows/i.test([row.releaseGroup, row.os].join(' '))) points += 10
      if (os === 'linux' && /linux/i.test([row.releaseGroup, row.os].join(' '))) points += 10
      if (arch === 'arm64' && /apple|arm/i.test(String(row.arch))) points += 4
      if ((arch === 'x64' || arch === 'ia32') && /intel|64|32/i.test(String(row.arch))) points += 2
      if (!row.app) points += 1
      return points
    }
    const row = listed.slice().sort((left, right) => score(right) - score(left))[0] || {}
    const settings = await this.repo.settings()
    return {
      success: true,
      version: row.version || '',
      url: row.url || (app ? '' : setting(settings, 'downloads.client_url', '')),
      title: row.title || '',
      os: row.os || '',
      app: row.app || app
    }
  }

  async listClientReleases(data, paging) {
    const values = []
    const clauses = []
    const group = catalog.groupId(data.group)
    if (group) {
      values.push(group)
      clauses.push(`release_group=$${values.length}`)
    }
    if (data.keyword) {
      values.push(`%${data.keyword}%`)
      clauses.push(`(title ILIKE $${values.length} OR app ILIKE $${values.length} OR os ILIKE $${values.length})`)
    }
    const where = clauses.length ? clauses.join(' AND ') : 'TRUE'
    const count = await this.repo.query(`SELECT count(*)::int AS total FROM client_releases WHERE ${where}`, values)
    const rows = await this.repo.query(
      `SELECT * FROM client_releases WHERE ${where} ORDER BY id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([paging.size, paging.offset])
    )
    return {
      rows: mapRows(rows.rows).map(catalog.adminRelease),
      total: count.rows[0].total,
      groups: catalog.RELEASE_GROUPS,
      standaloneApps: catalog.STANDALONE_APPS
    }
  }

  async saveClientRelease(data) {
    const releaseGroup = catalog.groupId(data.group || data.releaseGroup)
    if (!releaseGroup) throw new ApiError(400, '请选择有效的客户端分组', 'BAD_RELEASE_GROUP')
    const url = String(data.url || '').trim()
    const enabled = data.enabled === undefined ? true : Boolean(number(data.enabled))
    if (enabled && !catalog.hasPublicUrl(url)) {
      throw new ApiError(400, '上架版本必须填写 HTTPS 下载地址', 'DOWNLOAD_URL_REQUIRED')
    }
    if (url && !catalog.hasPublicUrl(url)) {
      throw new ApiError(400, '下载地址必须使用 HTTPS', 'BAD_DOWNLOAD_URL')
    }
    const app = String(data.app || '').trim()
    if (releaseGroup === 'standalone') {
      if (!catalog.isStandaloneApp(app)) {
        throw new ApiError(400, '独立应用必须对应平台应用 ID', 'BAD_STANDALONE_APP')
      }
    }
    const title = String(data.title || '').trim() || '新客户端'
    const os = String(data.os || '').trim() || (releaseGroup === 'standalone' ? '桌面' : releaseGroup)
    const arch = String(data.arch || '').trim()
    const version = String(data.version || '1.0.0').trim()
    const note = String(data.note || '').slice(0, 1000)
    if (data.id) {
      const result = await this.repo.query(
        `UPDATE client_releases SET release_group=$2,title=$3,os=$4,arch=$5,app=$6,version=$7,
         url=$8,enabled=$9,note=$10,updated_at=NOW() WHERE id=$1 RETURNING id`,
        [data.id, releaseGroup, title, os, arch, app, version, url, enabled, note]
      )
      if (!result.rows[0]) throw new ApiError(404, '版本不存在', 'CLIENT_NOT_FOUND')
      return { id: result.rows[0].id, updated: true }
    }
    const created = await this.repo.query(
      `INSERT INTO client_releases(release_group,title,os,arch,app,version,url,enabled,note)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [releaseGroup, title, os, arch, app, version, url, enabled, note]
    )
    return { id: created.rows[0].id, updated: false }
  }
}

module.exports = { CoreService, number, setting, requestDigest }
