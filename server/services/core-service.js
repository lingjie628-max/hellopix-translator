'use strict'

const crypto = require('crypto')
const defaultTranslator = require('./translation-provider')
const platforms = require('../../desktop/platforms')
const { ApiError } = require('../lib/http')
const { toMilli, formatMilli } = require('../lib/money')
const { mapRow, mapRows } = require('../repositories/production-repository')
const { RedisTranslationCache } = require('../stores')
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
    this.reservationTtlMs = Math.max(30_000, Number(options && options.reservationTtlMs) || 120_000)
    // 公共翻译网络（如"谷歌翻译"的免费端点）默认关闭，只有显式配置才放行。
    // 关闭时相关通道直接 ok:false，不产生任何译文或计费。
    this.allowPublicNetwork = Boolean(options && options.allowPublicNetwork)
    this.reconciliationTimer = null
    this.reconciliationRun = null
  }

  /**
   * 取通道的厂商凭据（管理后台配置的，落盘加密）。
   * 取不到就返回空对象，由适配层回退到环境变量 ——
   * 绝不能因为"读密钥失败"就把翻译整个打断。
   */
  async engineCredentials(engineId) {
    if (!this.repo || typeof this.repo.engineCredentials !== 'function') return {}
    try {
      return await this.repo.engineCredentials(engineId)
    } catch (error) {
      console.error('Engine credential read failed:', error.message)
      return {}
    }
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
      // 同步方法查不了库，这里只回退成空串；具体用哪个通道由客户端
      // 从 /translate/engines 已经拿到的列表里选，不再写死通道名
      activeEngine: account.activeEngineId || parent.activeEngineId || '',
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

  /**
   * 报价。
   *
   * ## 为什么内部改成整数运算（RC-02）
   *
   * 原实现是 `Math.round(originalPrice * rate * 100) / 100` —— 全程 JS 浮点。
   * 金额上浮点误差不可接受：`pack.price` 从库里读出来是字符串，
   * `number()` 一转就进了浮点世界，之后的每一次乘除都可能带误差。
   * 而 RC-02 要拿报价去和链上金额做**相等比较**，差 1e-15 就匹配不上。
   *
   * 现在：价格与折扣都用 milli-USDT 整数算，**只有展示字段才转回 Number**。
   *
   * ## 两套字段并存是有意的
   *
   *   originalPrice / paidAmount / discountAmount   Number，仅供展示
   *   originalMilli / paidMilli / discountMilli     字符串，金额运算只能用这三个
   *
   * 前端已经在用 Number 那组渲染，贸然改类型会连带改一片页面；
   * 而把精确值单列出来，调用方想用错都难 —— 名字里带 Milli 的一眼就知道是整数毫。
   */
  async quote(data) {
    const pack = await this.repo.package(data.baseid || data.id)
    if (!pack) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')
    const qty = Math.max(1, Math.floor(number(data.month || data.qty, 1)))
    const discounts = setting(await this.repo.settings(), 'billing.discounts', {})
    const rate = number(discounts[qty >= 50 ? '50' : (qty >= 10 ? '10' : '1')], qty >= 50 ? 0.75 : (qty >= 10 ? 0.8 : 0.9))

    // pack.price 是 numeric(14,2)，pg 返回字符串 —— 直接进整数世界，不经过 Number
    const priceMilli = toMilli(pack.price)
    const originalMilli = priceMilli * BigInt(qty)
    // 折扣率来自后台配置，本身是浮点。在这里**一次性**转成百万分之一整数，
    // 之后全程整数乘除。rate 是配置而非逐单金额，这一次转换是可控且确定的。
    const rateMicro = BigInt(Math.round(rate * 1_000_000))
    const paidMilli = (originalMilli * rateMicro + 500_000n) / 1_000_000n  // 四舍五入
    const discountMilli = originalMilli - paidMilli

    return {
      qty, rate,
      // 展示用（固定 3 位小数的字符串，与订单接口同形）—— 不要拿这三个去做金额运算
      originalPrice: formatMilli(originalMilli),
      paidAmount: formatMilli(paidMilli),
      discountAmount: formatMilli(discountMilli),
      // 精确值（字符串形式的 milli 整数）—— 金额运算一律用这三个
      originalMilli: originalMilli.toString(),
      paidMilli: paidMilli.toString(),
      discountMilli: discountMilli.toString(),
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

  /**
   * 解析实际使用的翻译通道 id。
   *
   * 顺序：显式指定 → 账号设置 → 主账号设置 → 套餐内第一个"已接通且启用"的 → 空串
   *
   * 刻意**不硬编码兜底某个通道名**。历史上这里写死 'youdao'，
   * 一旦 youdao 没接通，翻译就以 403/503 静默失败，用户只看到"没有译文"
   * 却不知道原因（telegram-engines 测试里保留了这个案例）。
   * 返回空串表示没有可用通道，由调用方给出明确报错。
   */
  /**
   * 该套餐是否允许商户自己指定通道。
   * 基础版刻意关闭：客户不必做他们判断不了的选择，成本也锁死在便宜通道上。
   * 字段缺失时按"允许"处理，避免存量数据被误伤。
   */
  canSwitchEngine(session) {
    return session.parent.packageAllowEngineSwitch !== false
  }

  async resolveEngineId(session, explicit) {
    // 不允许切换时**忽略**客户端传来的 engine。
    // 必须是服务端强制：只把前端下拉藏起来的话，直接调接口就能绕过。
    const chosen = this.canSwitchEngine(session)
      ? String(explicit || session.account.activeEngineId || session.parent.activeEngineId || '').trim()
      : ''
    if (chosen) return chosen
    const rows = await this.repo.packageEngines(session.parent.packageId)
    const usable = rows.filter(row => row.enabled && row.wired)
    return (usable[0] || {}).id || ''
  }

  async engines(session) {
    const rows = await this.repo.packageEngines(session.parent.packageId)
    // 默认通道优先取"已接通且启用"的：套餐里按 id 排在前面的通道很可能还没配
    // 凭据，若把它当默认，商户第一次翻译必然撞 503「通道尚未配置」，得手动去
    // 下拉里翻出可用通道。没有已接通的才退回原行为（首个通道）。
    const usable = rows.filter(row => row.wired && row.enabled)
    const fallbackId = (usable[0] || rows[0] || {}).id
    const canSwitch = this.canSwitchEngine(session)
    // 不允许切换时不能把账号里存的旧选择当成"当前通道"——
    // 那会与实际使用的通道不一致，界面等于在骗人。判定口径与 resolveEngineId 保持一致。
    const preferred = canSwitch ? (session.account.activeEngineId || session.parent.activeEngineId) : ''
    const active = preferred || fallbackId
    return {
      wired: rows.some(row => row.wired),
      // 前端据此隐藏/禁用下拉；服务端另有强制，两边都不能少
      canSwitch,
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
    const engineId = await this.resolveEngineId(session, data.engine)
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
        }, {
          allowPublicNetwork: this.allowPublicNetwork,
          credentials: await this.engineCredentials(engine.id)
        })
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
      // 完整发布列表：官网要区分"主推版本"与"其他版本"（如 Apple 芯片 / Intel、
      // 安装版 / 免安装版）。只给 clientDownloads 的话每类只能拿到第一条，
      // 用户找不到自己架构的包。
      downloads: listed,
      // 官网"用户使用反馈"。刻意不做内置假数据：编造用户评价既是欺骗访客，
      // 也可能给你招来合规风险。后台配了才展示，没配官网就不出现这一节。
      testimonials: setting(settings, 'site.testimonials', []),
      // 货币单位：官网价格展示要用，由后台设置决定，页面不写死。
      // 本站**按字符计费**，没有计费周期，所以这里只有货币，没有 period。
      billing: {
        currency: setting(settings, 'billing.currency', 'USD')
      },
      // 收款渠道：只下发"已启用且填了地址"的，避免商户看到空地址去转账。
      // 收款地址本身不是秘密（就是要给人转账用的），放公开接口没有风险。
      paymentChannels: (Array.isArray(setting(settings, 'payment.channels', []))
        ? setting(settings, 'payment.channels', []) : [])
        .filter(item => item && Number(item.enabled) && String(item.address || '').trim())
        .map(item => ({
          id: String(item.id || ''),
          name: String(item.name || 'USDT'),
          network: String(item.network || 'TRC20'),
          address: String(item.address || '').trim(),
          note: String(item.note || '')
        })),
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

  /**
   * 客户端更新检查。
   *
   * ## 架构必须参与筛选，而不是加分
   *
   * 原实现用模糊文本打分挑记录：
   *
   *     if ((arch === 'x64' || arch === 'ia32') && /intel|64|32/i.test(String(row.arch)))
   *
   * `x64` 与 `ia32` 得分相同、正则又同时匹配 "64" 和 "32"，于是
   * **32 位客户端会被推送 64 位安装包** —— 它根本装不上，而用户是
   * 下载了 80MB、卸载了旧版、打开才发现打不开的。
   *
   * 现在架构是**筛选条件**：不匹配的记录直接出局，宁可这次不发更新。
   * 归一与匹配规则见 server/lib/release-arch.js。
   *
   * @returns 多了 `compatible` 与 `reason`，便于客户端与排障区分
   *          「没有新版本」和「有更新但架构不匹配」。
   */
  async findUpdate(data) {
    const os = String(data.os || '')
    const arch = String(data.arch || '')
    const app = String(data.app || '').trim()
    const { archCompatible } = require('../lib/release-arch')

    const listed = this.publicReleases(
      (await this.repo.query('SELECT * FROM client_releases WHERE enabled=true ORDER BY created_at DESC,id DESC')).rows
    ).filter(row => !app
      ? row.releaseGroup !== 'standalone' && row.releaseGroup !== 'counter'
      : row.app === app)

    const osMatches = row => {
      const text = [row.releaseGroup, row.os].join(' ')
      if (os === 'darwin') return /mac/i.test(text)
      if (os === 'win32') return /windows/i.test(text)
      if (os === 'linux') return /linux/i.test(text)
      return false
    }

    const forOs = listed.filter(osMatches)
    const usable = forOs.filter(row => archCompatible(arch, row.arch))

    const score = row => {
      let points = 0
      // 写明了架构且能匹配上的优先于"不限架构"的
      if (String(row.arch || '').trim() && archCompatible(arch, row.arch)) points += 4
      if (!row.app) points += 1
      return points
    }
    const row = usable.slice().sort((left, right) => score(right) - score(left))[0] || {}
    const settings = await this.repo.settings()

    // 有该系统的发布记录、却没有一条架构匹配 —— 明确告知，不推错包
    const archBlocked = !row.version && forOs.length > 0
    const reason = archBlocked
      ? `当前系统架构（${arch || '未知'}）暂无对应的安装包`
      : (row.version ? '' : '暂无可用版本')

    return {
      success: true,
      compatible: !archBlocked,
      reason,
      version: row.version || '',
      // 架构不匹配时**不给兜底下载地址** —— 那个地址指向的同样是不匹配的包。
      // 只有"这个系统压根没有发布记录"时才退回通用配置。
      url: row.url || (app || archBlocked ? '' : setting(settings, 'downloads.client_url', '')),
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
