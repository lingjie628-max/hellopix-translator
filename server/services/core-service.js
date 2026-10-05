'use strict'

const crypto = require('crypto')
const defaultTranslator = require('./translation-provider')
const platforms = require('../../desktop/platforms')
const { ApiError } = require('../lib/http')
const { toMilli, formatMilli } = require('../lib/money')
const { estimateUpstreamCost } = require('../lib/upstream-pricing')
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
    // 价目表查不到时的告警去重（按 "渠道:模型"）。
    // 不去重的话，一个未定价的通道在高峰期会把日志刷满，
    // 而把日志淹掉的恰恰是"该去补价格"这个信号本身。
    this.unverifiedCostReported = new Set()
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

  /**
   * 取该商户**有权使用**的通道列表。
   *
   * 关键在第二个参数：`packageCatalogVersion`。
   * 套餐权益按"购买时的版本快照"解析，而不是读此刻的活表 ——
   * 否则我们改一次套餐配置就会**回溯修改所有历史买家的权益**，
   * 加通道是白送、删通道就是违约，两种都不该由一次配置变更自动发生。
   * 版本为空（存量数据 / 单测 mock）时回落到活表，行为与改前一致。
   */
  packageChannels(session) {
    return this.repo.packageEngines(
      session.parent.packageId,
      session.parent.packageCatalogVersion
    )
  }

  /**
   * 解析实际使用的翻译通道 id。
   *
   * 顺序：**本次请求显式指定** → 账号设置 → 主账号设置 → 权益内第一个可用通道 → 空串
   *
   * ## 显式指定与历史设置是两种东西，处理方式必须不同
   *
   * 这是本版最重要的行为变更，起因是两条硬要求：
   * 「用户手动选择的渠道失败时，不要静默切换供应商」
   * 「前台展示的模型与真实调用保持一致，不得静默换成低价模型」
   *
   * 原实现把两者混为一谈：只要选中的通道"启用但未接通"，就**悄悄换成**
   * 权益内第一个可用通道。于是用户明明选了 A、界面也显示 A，
   * 实际调用的是 B 且账单走 B —— 用户永远发现不了。
   *
   * 现在：
   *   · **本次请求显式传了 engine** → 原样返回，一个都不替换。
   *     不可用就由 translate() 拿着明确原因报错（未上线 / 已下架 / 未包含）。
   *     这是用户刚刚做出的选择，替换它就是欺骗。
   *   · **账号里存的旧选择** → 不可用时跳过，回落到第一个可用通道。
   *     这不是一次"选择"，而是历史遗留的陈旧状态（旧版界面允许选中未接通通道，
   *     存量账号里可能存着它）。直接沿用会让这个商户**每次翻译都撞 503**。
   *     替换是合理的，而且**响应里会带上实际使用的通道**，不是偷偷换。
   *
   * 返回空串表示一个可用通道都没有，由调用方给出明确报错。
   */
  async resolveEngineId(session, explicit, packageRows) {
    const rows = packageRows || await this.packageChannels(session)
    // "可用" = 启用 + 已接通 + 未下架。三个条件缺一不可：
    // 下架的通道 enabled 已被置 false，但仍显式判一次，避免将来有人
    // 只改 retired_at 忘了改 enabled 时这里悄悄放行。
    const usable = rows.filter(row => row.enabled && row.wired && !row.retired)

    // 不允许切换时**忽略**客户端传来的 engine。
    // 必须是服务端强制：只把前端下拉藏起来的话，直接调接口就能绕过。
    const requested = this.canSwitchEngine(session) ? String(explicit || '').trim() : ''
    if (requested) {
      // 原样返回，由 translate() 判定到底哪里不行并给出对得上的文案。
      // 这里**不做任何替换** —— 见方法头部的说明。
      return requested
    }

    const stored = this.canSwitchEngine(session)
      ? String(session.account.activeEngineId || session.parent.activeEngineId || '').trim()
      : ''
    if (stored && usable.some(row => row.id === stored)) return stored
    return (usable[0] || {}).id || ''
  }

  async engines(session) {
    // 已下架的通道对商户**完全不可见**：不下发、不可选、也不会被解析到。
    // 但它们在库里、在历史日志里都还在（见 migration 031），只是前台不再展示 ——
    // 用户没必要看见一个自己用不了的通道，那只会增加困惑。
    const rows = (await this.packageChannels(session)).filter(row => !row.retired)
    // 默认通道优先取"已接通且启用"的：套餐里按 id 排在前面的通道很可能还没配
    // 凭据，若把它当默认，商户第一次翻译必然撞 503「通道尚未配置」，得手动去
    // 下拉里翻出可用通道。没有已接通的才退回原行为（首个通道）。
    const usable = rows.filter(row => row.wired && row.enabled)
    const fallbackId = (usable[0] || {}).id
    const canSwitch = this.canSwitchEngine(session)
    // 不允许切换时不能把账号里存的旧选择当成"当前通道"——
    // 那会与实际使用的通道不一致，界面等于在骗人。判定口径与 resolveEngineId 保持一致。
    const stored = canSwitch ? String(session.account.activeEngineId || session.parent.activeEngineId || '').trim() : ''
    // 存量账号可能存着一个"套餐里有、但没接通"的通道（它在旧版界面上是可以选中的），
    // 继续把它标成"当前"同样是在骗人：用户看到的是它，实际调用却会被跳过。
    const preferred = usable.some(row => row.id === stored) ? stored : ''
    const active = preferred || fallbackId
    const activeRow = rows.find(row => row.id === active)
    return {
      wired: rows.some(row => row.wired),
      // 前端据此隐藏/禁用下拉；服务端另有强制，两边都不能少
      canSwitch,
      packageTitle: session.parent.packageTitle || '',
      // 权益版本一并下发：排障时能一眼看出"这个商户的套餐组合是哪一版"，
      // 不用去库里对 packages.catalog_version 与 users.package_catalog_version。
      packageCatalogVersion: number(session.parent.packageCatalogVersion) || null,
      charBalance: number(session.account.charBalance),
      activeEngine: active,
      // 真实调用的模型随通道一起下发。前台必须能显示它 ——
      // 否则"展示的模型与真实调用一致"这条要求根本没有落脚点。
      activeModel: (activeRow && activeRow.model) || '',
      activeProvider: (activeRow && activeRow.provider) || '',
      // 「已登记但未接通」的通道一律不可选用：选中它必然 503，而 503 在客户端
      // 只表现为"没有译文"，用户只会来报"翻译坏了"。这里以 allowed=false 下发，
      // 已下发的客户端（含 0.1.5/0.1.6）都按 allowed !== false 过滤，无需升级即可生效。
      // comingSoon 供能显示列表的界面（Web 通道页）标记为「即将上线」。
      rows: rows.map(row => Object.assign(row, {
        allowed: Boolean(row.wired && row.enabled),
        comingSoon: !row.wired,
        active: row.id === active
      }))
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
    // 套餐通道表只查一次：resolveEngineId 需要它来判断"套餐里有但没接通"，下面
    // 的 engine 查找也需要它 —— 翻译是热路径，不能为了这层判断多打一次库。
    // 走 packageChannels（按权益版本解析）而不是 packageEngines（活表）：
    // 商户能用哪些通道，取决于他**购买时**的那一版，不是我们此刻的配置。
    const allowed = await this.packageChannels(session)
    const engineId = await this.resolveEngineId(session, data.engine, allowed)
    if (!engineId) {
      // 一个可用通道都没有：要么权益里全是"即将上线"的通道，要么套餐压根没配通道。
      // 不能回 403「当前套餐未包含此通道」—— 那会把人引向"升级套餐"，而升级也解决不了。
      throw new ApiError(503, '当前账号没有可用的翻译通道，请联系客服', 'ENGINE_NOT_CONFIGURED')
    }
    const engine = allowed.find(row => row.id === engineId)
    // 已下架：给独立错误码与文案。混在「套餐未包含」里会让人以为升级套餐就能用，
    // 而升级换不来一个已经下架的通道。
    if (engine && engine.retired) {
      throw new ApiError(503, `翻译通道「${engine.name}」已下架，请在通道列表里换一个`, 'ENGINE_RETIRED')
    }
    if (!engine || !engine.enabled) throw new ApiError(403, '当前套餐未包含此通道', 'ENGINE_NOT_ALLOWED')
    if (!engine.wired) {
      // 正常路径不该走到这里：engines() 已把未接通的通道以 allowed=false 下发，
      // resolveEngineId 也会跳过它们。走到这里说明客户端**显式指定**了一个未接通的
      // 通道（旧版客户端 / 手工调接口）。此时**不能**偷偷换成别的通道 ——
      // 用户选的是它、界面显示的也是它，换掉就是"静默切换供应商"。
      // 报错文案要说人话：用户看到的 503 只是"没有译文"，
      // 得让他知道是"这个通道还没上线"，而不是"翻译坏了"。
      throw new ApiError(503, `翻译通道「${engine.name}」尚未上线，请换一个通道`, 'ENGINE_NOT_CONFIGURED')
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
            // 请求体或**通道**变了。换通道重译是一次新的翻译（厂商侧是真花钱的），
            // 必须重新计费 —— 复用旧预留等于免费送一次。
            // 但绝不能默默扣：客户端要拿新 requestId 重发，并且**先告诉用户**
            // "换通道重译会再次扣字符"。所以这里用专门的错误码 + 明确文案，
            // 让客户端能把这条提示原样贴给用户，而不是笼统的"请求号冲突"。
            throw new ApiError(
              409,
              existing.engineId && existing.engineId !== engineId
                ? '该请求号已用于其他翻译通道。换通道重新翻译会再次扣除字符，请确认后重试'
                : 'Idempotency-Key 已用于其他请求',
              existing.engineId && existing.engineId !== engineId
                ? 'ENGINE_SWITCH_REQUIRES_NEW_REQUEST'
                : 'IDEMPOTENCY_KEY_REUSED'
            )
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
        // 真实调用的模型与厂商，随响应一起回给客户端。
        // 适配层可能因为参数不被接受而降级重试（比如某些模型不收 temperature），
        // 降级后的模型以适配层报上来的为准 —— 展示的必须**就是**这次真正调用的那个。
        const usedModel = String(result.model || engine.model || '')
        const response = {
          success: true,
          wired: Boolean(engine.wired),
          cached: Boolean(result.cached),
          skipped: refundable ? (result.skipped || 'unchanged') : undefined,
          translation: translated,
          chars: refundable ? 0 : chars,
          remain: number(balance.charBalance),
          from: from === 'auto' ? this.translator.detectLang(text) : from,
          engine: engineId,
          engineName: engine.name || '',
          provider: engine.provider || '',
          model: usedModel
        }
        let translateLogId = null
        if (!refundable) {
          const table = session.kind === 'sub' ? 'sub_accounts' : 'users'
          await this.repo.query(
            `UPDATE ${table} SET char_used=char_used+$2,translate_count=translate_count+1,updated_at=NOW() WHERE id=$1`,
            [session.account.id, chars], client
          )
          const logged = await this.repo.query(
            `INSERT INTO translate_logs(user_id,sub_account_id,engine_id,reservation_id,
             source_language,target_language,chars,cost_amount,sell_amount,source_hash,snippet,cached,duration_ms)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12) RETURNING id`,
            [session.parent.id, session.kind === 'sub' ? session.account.id : null, engineId, reservation.id,
              response.from, to, chars, number(engine.costPerMillion) * chars / 1000000, sourceHash,
              text.slice(0, 300), Boolean(result.cached), durationMs], client
          )
          translateLogId = logged.rows[0] && number(logged.rows[0].id) || null
        }
        // 上游真实消耗：**不管这次是否退款给客户都要记**。
        //
        // 为什么：退款是"这条译文没价值，不扣你的字符"，但厂商那边
        // **是真的消耗了 token 也真的会产生账单**。把退款就当没发生过，
        // 成本表上就凭空少了一块，月度对账必然对不上。
        // 所以只要真打了上游（非缓存命中）就落一条内部台账，
        // 与对客户的字符账本彻底分开、互不影响。
        if (!result.cached) {
          await this.recordUpstreamUsage(client, {
            reservation, engine, result, session, translateLogId,
            from: response.from, to, durationMs, refundable
          })
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

  /**
   * 记一条**上游真实消耗**（内部台账）。
   *
   * ## 为什么必须与客户字符账本分开
   *
   * `translate_logs.chars` 是"卖给客户多少字符"，`cost_amount` 是按通道成本表
   * 折算的**估算值**。而厂商按 token 计费，且"一字符 ≈ 多少 token"随语种、
   * 语言对、输出长度剧烈变化（中文一字≈1 token，英文一字符≈0.25 token）。
   * 只靠估算值永远算不出真实毛利，所以厂商给的真实 token 数必须单独落库。
   *
   * ## 两个刻意的设计
   *
   * 1. **退款给客户时照样记账**。退款语义是"这条译文没价值，不扣你的字符"，
   *    但厂商那边是**真的消耗了 token、真的会产生账单**。把退款当没发生过，
   *    成本表就凭空少一块，月度对账必然对不上。
   * 2. **缓存命中不记账**。缓存命中没有打上游，没有产生任何厂商费用
   *    —— 这正是缓存的价值所在，记 0 成本才是如实的。
   *
   * 整条记录不参与任何扣费逻辑，写失败也不该让翻译失败：它是对账用的旁路，
   * 不是主流程的一部分。所以这里吞掉异常并打日志。
   */
  async recordUpstreamUsage(client, { reservation, engine, result, session, translateLogId, from, to, durationMs }) {
    try {
      const usage = (result && result.usage) || {}
      const model = String((result && result.model) || (engine && engine.model) || '')
      const cost = estimateUpstreamCost({
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        // 按字符计价的通道（谷歌）没有 token 数，用实际送翻的字符数
        characters: (engine && engine.provider === 'Google') ? number(reservation && reservation.reservedChars) : 0
      })
      await this.repo.query(
        `INSERT INTO translation_usage(reservation_id,translate_log_id,user_id,sub_account_id,
         engine_id,provider,model,prompt_tokens,completion_tokens,reasoning_tokens,total_tokens,
         billed_units,billed_unit,upstream_cost,currency,retries,cached,from_language,to_language,duration_ms,
         cost_verified,cost_note,cost_source,cost_as_of)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                $21,$22,$23,$24)`,
        [
          reservation ? reservation.id : null,
          translateLogId,
          session.parent.id,
          session.kind === 'sub' ? session.account.id : null,
          engine.id,
          cost.provider || engine.provider || '',
          cost.model || model,
          number(usage.promptTokens),
          number(usage.completionTokens),
          number(usage.reasoningTokens),
          number(usage.totalTokens),
          cost.unit === 'character' ? number(reservation && reservation.reservedChars) : number(usage.totalTokens),
          cost.unit || '',
          cost.cost,
          cost.currency || '',
          number(result && result.retries),
          false,
          from || 'auto',
          to || '',
          number(durationMs),
          // 「未核实」必须落库：否则"价格没查到"的 0 与"真的没花钱"的 0
          // 在库里完全一样，对账时看不出少算了整条通道。
          Boolean(cost.verified),
          String(cost.note || ''),
          String(cost.source || ''),
          String(cost.asOf || '')
        ],
        client
      )
      // 落库之外再喊一声：库里的标记要人去查才看得到，日志是主动的。
      if (!cost.verified) this.reportUnverifiedCost(engine, model, cost)
    } catch (error) {
      // 台账是旁路：写失败要能在日志里看见，但不能把已经成功的翻译带崩
      console.error('Upstream usage ledger write failed:', error.message)
    }
  }

  /**
   * 价目表查不到价钱时喊一声。
   *
   * 为什么需要它：`estimateUpstreamCost` 查不到价会返回 cost=0，而 0 在成本表里
   * 与"这条真的没花钱"完全一样。此前这个信号只在函数返回值里，谁也不看 ——
   * 结果谷歌（官方价 $20/百万字符）被静默记成 0，对账时会以为那部分免费。
   * 现在一行落库标记 + 一次日志，两道都有。
   *
   * 按 "渠道:模型" 去重：同一个未定价的通道翻一万次也只报一次。
   * 被日志淹掉的告警等于没有告警。
   */
  reportUnverifiedCost(engine, model, cost) {
    const key = `${(engine && engine.id) || '?'}:${model || '(空 model)'}`
    if (this.unverifiedCostReported.has(key)) return
    this.unverifiedCostReported.add(key)
    console.warn(
      `[usage-cost] 渠道「${(engine && engine.id) || '?'}」的模型「${model || '(空)'}」` +
      `在价目表（server/lib/upstream-pricing.js）里查不到，本次成本按 0 记入 ` +
      `translation_usage 并已标记 cost_verified=false —— 0 不代表免费。` +
      `处置：补上官方单价，或把 model 改成价目表里已有的键。原因：${(cost && cost.note) || '未说明'}`
    )
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

    async siteInfo(options) {
      const wantArch = String((options || {}).arch || '').trim()
      const [settings, lines, clients] = await Promise.all([
        this.repo.settings(),
        this.repo.query('SELECT id,name,url,region,enabled FROM client_lines WHERE enabled=true ORDER BY sort_order,id'),
        this.repo.query('SELECT * FROM client_releases WHERE enabled=true ORDER BY created_at DESC,id DESC')
      ])
      const listed = this.publicReleases(clients.rows)
      // 按客户端上报的 process.arch 挑包。
      //
      // 之前固定取第一条，而排序是 created_at DESC,id DESC —— macOS 的 x64 记录
      // id 更大、排在前面，于是 **Apple 芯片用户点「苹果电脑版」拿到的是 x64 包**。
      // 这里改成：优先挑架构匹配的那条（架构留空 = 不限架构，archCompatible 会放行）。
      // 一条都不匹配时退回第一条，保持旧行为 —— 宁可给一个能跑的包，
      // 也不要返回空串把下载按钮藏掉（那会让用户以为根本没有 mac 版）。
      const { archCompatible } = require('../lib/release-arch')
      const download = group => {
        const rows = listed.filter(item => item.releaseGroup === group)
        if (!rows.length) return ''
        const row = (wantArch && rows.find(item => archCompatible(wantArch, item.arch))) || rows[0]
        return row.url
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
