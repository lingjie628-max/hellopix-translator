'use strict'

const crypto = require('crypto')
const defaultTranslator = require('./translation-provider')
const platforms = require('../../desktop/shared/platforms')
const { ApiError } = require('../lib/http')
const { toMilli, formatMilli } = require('../lib/money')
const { estimateUpstreamCost } = require('../lib/upstream-pricing')
const { mapRow, mapRows } = require('../repositories/production-repository')
// Redis 键前缀的唯一来源：与 stores/redis-client 共用 `REDIS_KEY_PREFIX`。
const { PREFIX: redisPrefix } = require('../stores/redis-client')
const { RedisTranslationCache } = require('../stores')
const catalog = require('../lib/client-catalog')
const translationRouter = require('./translation-router')
// 与服务端共用同一份实现，客户端缓存兜底也用它 —— 见 desktop/shared/trailing-dot.js
const { trimTrailingDot } = require('../../desktop/shared/trailing-dot')

function number(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : (fallback || 0)
}

/** 开关的"开"与"关"两种写法。都做大小写折叠后再比。 */
const ACTIVE = ['1', 'true', 'yes', 'on']
const INACTIVE = ['0', 'false', 'no', 'off']

/**
 * 翻译调用来源的白名单，落库到 `translate_logs.trigger`。
 *
 * 计费用：出异常字符消耗时要能回答"这次是用户点的，还是客户端扫描时自动翻的"。
 * 客户端可控，所以只认这几个值，其余一律记成 `''`（未声明）。
 * 与迁移 042 里的 CHECK 约束必须保持一致。
 */
const TRIGGER_VALUES = ['manual_click', 'auto_receive', 'manual_send', 'retranslate']

/**
 * 通道凭据的缓存时长。
 *
 * 短到让"后台改了 Key"一分钟内自动生效，长到把那趟
 * 「SELECT engines + AES 解密」从绝大部分翻译请求的关键路径上挪走。
 * 想立刻生效：保存 Key 的后台接口调 `invalidateCredentials()`。
 */
const CREDENTIAL_TTL_MS = 60 * 1000

/**
 * 三态布尔解析 —— 专治表单提交的开关。
 *
 * ## 为什么不能写成 `Boolean(number(value))`
 *
 * 浏览器的请求体是 `application/x-www-form-urlencoded`，`encodeForm` 对 JS
 * 布尔做的是 `encodeURIComponent(true)` → 字符串 **`"true"`**；而
 * `Number("true")` 是 `NaN`，于是 `Boolean(NaN)` = **false**。
 * 结果是一个"打开"的开关到了服务端变成"关闭"，且**不报任何错**。
 *
 * 生产上的实际后果：超管在「编辑商户」里看到企业账号开关显示为「关」
 * （那是前端绑定问题），点一下变「开」后保存 —— 只要那次请求带的是字符串
 * `"true"`，商户的企业权益就被静默撤销，不限量子账号当场失效。
 *
 * ## 三种返回
 *
 *   `true`  —— 明确表示开
 *   `false` —— 明确表示关
 *   `null`  —— 没传 / 空串 / 认不出来的值，调用方应**保持原值**（配合 COALESCE）
 *
 * 认不出来一律返回 `null` 而不是猜一个：猜错就是静默改掉别人的开关，
 * 比"不动"危险得多。
 */
function bool(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (ACTIVE.includes(text)) return true
  if (INACTIVE.includes(text)) return false
  return null
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
    // ★ 每次翻译都查库 + 解密是纯浪费 ★
    //
    // 原来这里每次调用都走一趟 `SELECT ... FROM engines` 再做一次 AES 解密 ——
    // 一个每次翻译都会发生、结果几乎永不变更的操作，被放进了延迟关键路径。
    // 缓存 TTL 取得很短（60s），是为了让后台改 Key 之后 1 分钟内自然生效，
    // 用户不必重启服务。
    const now = Date.now()
    const cached = this._credentialCache && this._credentialCache.get(engineId)
    if (cached && now - cached.at < CREDENTIAL_TTL_MS) return cached.value
    try {
      const value = await this.repo.engineCredentials(engineId)
      if (!this._credentialCache) this._credentialCache = new Map()
      this._credentialCache.set(engineId, { at: now, value })
      return value
    } catch (error) {
      console.error('Engine credential read failed:', error.message)
      return {}
    }
  }

  /**
   * 后台改完 Key 之后主动失效 —— 不必等 TTL 过期。
   * 没调也不影响正确性，只是最多晚 60s 才用上新 Key。
   */
  invalidateCredentials(engineId) {
    if (!this._credentialCache) return
    if (engineId) this._credentialCache.delete(engineId)
    else this._credentialCache.clear()
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
         FROM sub_accounts WHERE parent_id=$1 AND deleted_at IS NULL ORDER BY id LIMIT 100`,
        [session.parent.id]
      ),
      this.repo.query('SELECT count(*)::int AS count FROM sub_accounts WHERE parent_id=$1 AND deleted_at IS NULL', [session.parent.id]),
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
      // 本套餐包含的子账号额度。
      //
      // 这里原来叫 `subQuotaAdded`，值是**购买月数** —— 旧设计是"每买一组加 1 个
      // 子账号名额"。那个规则从未在生产落地（`users.sub_quota` 恒为 0），
      // 也已改为"按套餐档位定额度"（见 `packages.sub_quota`）。名字里的
      // "Added" 现在只会误导人，所以正名成 `subQuota`。
      //
      // `subQuotaAdded` 保留为同值别名：字段已在 `/user/quote` 的响应契约里，
      // 直接删掉会让还在读它的老客户端拿到 undefined。等确认无调用方后再摘。
      subQuota: number(pack.subQuota),
      subQuotaAdded: number(pack.subQuota),
      chars: number(pack.includedChars) * qty,
      // 「不限字符」是**展示语义**：前端据此把 "500000000" 显示成「不限」，
      // 而不是让商户去数九个零。发放量仍然是 chars，扣费路径不受影响。
      charsUnlimited: Boolean(pack.charsUnlimited)
    }
  }

  async teamInfo(session) {
    const [count, settings] = await Promise.all([
      this.repo.query('SELECT count(*)::int AS count FROM sub_accounts WHERE parent_id=$1 AND deleted_at IS NULL', [session.parent.id]),
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
         WHERE id=$${values.length - 1} AND parent_id=$${values.length} AND deleted_at IS NULL RETURNING id,status`,
        values
      )
      if (!result.rows[0]) throw new ApiError(404, '子账号不存在', 'SUB_NOT_FOUND')
      if (data.password || number(result.rows[0].status) !== 1) await this.auth.revokeUser('sub', data.id)
      return
    }
    if (!data.username) throw new ApiError(400, '请填写登录账号', 'USERNAME_REQUIRED')
    const passwordHash = await this.auth.hash(data.password)
    // 先查重再进事务。
    //
    // 以前这里完全没有查重：名字被占时由 `sub_accounts_username_lower_alive_uidx`
    // （或触发器写 `merchant_identities` 时的唯一索引）抛 23505，
    // 一路冒到全局错误处理变成 500「服务器开小差」，商户完全不知道是重名。
    // 现在给出明确提示，并且把「自己删掉的名字」也视作可用 ——
    // 软删除行不参与部分唯一索引，`accountByUsername` 也排除了它。
    const taken = await this.repo.accountByUsername(String(data.username).trim())
    if (taken) throw new ApiError(409, '该登录账号已被占用，请换一个', 'USERNAME_TAKEN')
    await this.repo.transaction(async client => {
      const parent = await this.repo.query(
        'SELECT sub_quota, enterprise FROM users WHERE id=$1 FOR UPDATE', [session.parent.id], client)
      if (!parent.rows[0]) throw new ApiError(404, '商户不存在', 'USER_NOT_FOUND')
      const quota = number(parent.rows[0].sub_quota)
      /**
       * 企业账号不限子账号数。
       *
       * 后台界面一直写着「企业开子账号不限数量」，但这里原先只看 `sub_quota` ——
       * 而套餐单据上根本没有子账号额度这个概念（`users.sub_quota` 默认 0），
       * 于是**每个商户的名额都是 0，一个子账号都开不出来**，文案与代码完全不符。
       * 现在按企业标志真正放行。
       *
       * 额度判定放在锁住 `users` 行之后：名额是"行上的计数"，不加锁则并发
       * 双击「添加」能同时通过 `count >= quota` 检查，一次性开出两个。
       */
      if (!parent.rows[0].enterprise) {
        const count = await this.repo.query(
          'SELECT count(*)::int AS count FROM sub_accounts WHERE parent_id=$1 AND deleted_at IS NULL', [session.parent.id], client)
        if (count.rows[0].count >= quota) {
          throw new ApiError(409,
            quota > 0
              ? `子账号名额已满（本套餐 ${quota} 个）。购买更高档套餐或联系客服提升额度`
              : '当前套餐不含子账号额度，购买套餐后即可添加',
            'SUB_QUOTA_FULL')
        }
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
    // 幂等键必须**每次都带**。前端目前不传，而
    // `UNIQUE (parent_id, idempotency_key)` 在多行 NULL 时是"都允许通过"的
    // （PostgreSQL 里 NULL 互不相等），于是没有键 = 幂等**完全失效**：
    // 用户点两下、或网络超时后自动重试，同一笔分配就会执行两次 ——
    // 主账号被扣两遍，子账号被加两遍。这里补一个请求级键兜底，
    // 客户端**显式传了**才按它去重（那是真正跨请求的幂等）。
    const requestKey = data.requestId
      ? String(data.requestId).slice(0, 160)
      : `chars:${session.parent.id}:${data.id}:${chars}:${crypto.randomUUID()}`
    return this.repo.transaction(async client => {
      await this.repo.lockAccount(client, 'main', session.parent.id)
      const sub = mapRow((await this.repo.query(
        'SELECT * FROM sub_accounts WHERE id=$1 AND parent_id=$2 AND deleted_at IS NULL FOR UPDATE',
        [data.id, session.parent.id], client
      )).rows[0])
      if (!sub) throw new ApiError(404, '子账号不存在', 'SUB_NOT_FOUND')
      // 显式幂等：同一 requestId 已经处理过就直接返回原结果，不再动账
      if (data.requestId) {
        const done = await this.repo.query(
          'SELECT amount FROM character_transfers WHERE parent_id=$1 AND idempotency_key=$2',
          [session.parent.id, requestKey], client
        )
        if (done.rows[0]) return { username: sub.username, chars: number(done.rows[0].amount), replayed: true }
      }
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
        [session.parent.id, sub.id, chars, requestKey], client
      )
      return { username: sub.username, chars }
    })
  }

  /**
   * 删除子账号。**软删除**，不是物理删除。
   *
   * ## 为什么不 DELETE
   *
   * `translate_logs` / `translation_usage` / `translation_reservations` 的
   * `sub_account_id` 全是 `ON DELETE RESTRICT` —— 账本不许被删。线上已有
   * 近 3 万行子账号翻译记录，物理删等于把对账依据一起抹掉。
   * 所以只打 `deleted_at` 标记，行、账本、用量全部原样保留。
   *
   * ## 余额必须退回主账号
   *
   * 子账号余额是从主账号划过来的（`transferChars`）。删号时如果不退回，
   * 这部分字符就凭空消失在已删行上 —— 主账号少了一笔，却没有任何流水解释。
   * 这里做三件事：
   *   1. 把 `char_balance` 加回主账号（`adjustChars` 保证不会为负）；
   *   2. 写一条**负向** `character_transfers`，让流水上能看出"这个子账号退了 N"；
   *   3. 清掉子账号自己的余额。
   *
   * 全部在同一个事务里，任一步失败整体回滚。
   *
   * ## 删除后
   *
   * · `auth.revokeUser('sub', id)` 把这个子账号的所有会话清掉，立刻踢下线；
   * · 用户名/邮箱的唯一索引是部分索引（`WHERE deleted_at IS NULL`），
   *   所以删掉之后**可以再用同名重建**；
   * · 名额计数一律带 `deleted_at IS NULL`，删掉不占名额。
   */
  async deleteSub(session, data) {
    if (session.kind !== 'main') throw new ApiError(403, '仅主账号可管理子账号', 'MAIN_ACCOUNT_REQUIRED')
    const id = number(data.id)
    if (!Number.isInteger(id) || id < 1) throw new ApiError(400, '缺少子账号 ID', 'SUB_ID_REQUIRED')

    const result = await this.repo.transaction(async client => {
      // 锁住主账号行：余额退回要和并发的「分字符」串行，否则可能读到旧余额
      await this.repo.lockAccount(client, 'main', session.parent.id)
      const found = await this.repo.query(
        `SELECT * FROM sub_accounts
         WHERE id=$1 AND parent_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [id, session.parent.id], client
      )
      const sub = found.rows[0]
      if (!sub) throw new ApiError(404, '子账号不存在或已被删除', 'SUB_NOT_FOUND')

      const refund = number(sub.char_balance)

      // 先归零子账号，再给主账号回补 —— 顺序和 transferChars 的扣减方向相反，
      // 但同样要保证两边不会出现负数。
      if (refund > 0) {
        await this.repo.adjustChars(client, 'sub', id, -refund)
        await this.repo.adjustChars(client, 'main', session.parent.id, refund)
        await this.repo.query(
          `INSERT INTO character_transfers(parent_id,sub_account_id,amount,operator_type,operator_id,idempotency_key)
           VALUES($1,$2,$3,'user',$1,$4)`,
          [session.parent.id, id, -refund,
            `delete-sub:${id}:${crypto.randomUUID()}`], client
        )
      }

      await this.repo.query(
        `UPDATE sub_accounts
         SET status=0, deleted_at=NOW(), deleted_by=$3, updated_at=NOW()
         WHERE id=$1 AND parent_id=$2`,
        [id, session.parent.id, String(session.account.username || session.parent.username || '')], client
      )

      // 释放用户名/邮箱。
      //
      // `merchant_identities` 由触发器维护，只认 INSERT/UPDATE/DELETE —— 软删除
      // 不会碰它，于是这行会一直占着 `merchant_identities_username_lower_uidx`，
      // 商户想把账号删了重开同名会直接撞唯一键。这里显式删掉它：
      //   1. 登录时 `accountByUsername` 先查这张表，删掉 = 旧名字再也登不进来；
      //   2. 名字腾出来，同名可以重建。
      await this.repo.query(
        "DELETE FROM merchant_identities WHERE account_type='sub' AND account_id=$1", [id], client
      )

      return { id, username: sub.username, refund }
    })

    // 会话清理放事务外：Redis 不参与 PG 事务，失败也不该让删除回滚。
    // 这里失败只意味着"旧 token 最多还能撑到下次请求"，而每次请求都会校验
    // status（auth-service.resolve），停用后本来就进不来。
    try {
      await this.auth.revokeUser('sub', id)
    } catch (error) {
      console.error('deleteSub: revokeUser failed', error.message)
    }

    return {
      username: result.username,
      refund: result.refund,
      msg: result.refund > 0
        ? `已删除 ${result.username}，${result.refund} 字符已退回主账号`
        : `已删除 ${result.username}`
    }
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
   *
   * 当前三档套餐**全部放开**（migration 043）。原先只有基础版锁死，
   * 结果是商户买了含两个通道的套餐却一个都选不了，界面还只能显示账号里的旧值 ——
   * 而真实调用走的是权益内第一个可用通道，**界面与真实调用不一致**。
   * 成本控制交给"套餐包含哪些通道"，不靠锁死其中某一个。
   *
   * 判定看的是**商户套餐**（`session.parent`），主账号与子账号一视同仁 ——
   * 不存在"主账号能选、子账号只能固定一个"这种规则。
   *
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
   * 混合路由总开关。
   *
   * 默认**关闭**。理由：这是要上线的行为变更，改的是"用户选 A、实际用 B"，
   * 一旦哪里有遗漏（比如客户端不认 routed 字段、某个套餐没配快速通道），
   * 影响的是一次真实翻译。所以必须先开闸验证，再全量。
   *
   * 打开方式：环境变量 PIX_HYBRID_ROUTING=1。
   * 关闭时 routeTranslate 直接返回原通道，行为与改动前**逐字节一致**。
   */
  hybridRoutingEnabled() {
    if (this.hybridRouting !== undefined && this.hybridRouting !== null) return Boolean(this.hybridRouting)
    return String(process.env.PIX_HYBRID_ROUTING || '').trim() === '1'
  }

  /**
   * 允许被用作"快速通道"的通道 id，按优先级排列。
   *
   * 为什么是配置而不是硬编码：
   *   · 不同套餐接通的通道不一样，硬编码一个不存在的 id 等于功能静默失效；
   *   · 将来换供应商（Qwen-MT → 别家）不该改代码。
   *
   * 默认 `qwen`（通义千问 MT）优先 —— 理由是：
   *   · 它是**专用翻译模型**（qwen-mt-flash），不是通用对话模型，无推理开销；
   *   · 覆盖 100+ 语种，含马来语/印尼语/泰语/越南语这些聊天场景高频语种；
   *   · 与 LLM 通道共用同一套 OpenAI 兼容实现，已在本仓库有单测覆盖。
   *
   * 打开方式：PIX_FAST_ENGINES=qwen,google（逗号分隔，按优先级）。
   */
  fastEngineIds() {
    if (Array.isArray(this.fastEngines)) return this.fastEngines
    const raw = String(process.env.PIX_FAST_ENGINES || '').trim()
    if (raw) {
      return raw.split(',').map(s => s.trim()).filter(Boolean)
    }
    return ['qwen']
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
    // 已下架 / 已停用的通道对商户**完全不可见**：不下发、不可选、也不会被解析到。
    // 但它们在库里、在历史日志里都还在（见 migration 031），只是前台不再展示 ——
    // 用户没必要看见一个自己用不了的通道，那只会增加困惑。
    //
    // ★ 必须同时过滤 `enabled`，不能只看 `retired` ★
    //
    // 迁移 048 撤 qwen 时**刻意不设 retired_at**（它从没上线，谈不上下架），
    // 只把 `enabled` 置 false。而这里原先只过滤 retired，于是：
    //   下拉里照样列出 qwen → 用户一点 → `resolveTranslateEngine` 第 832 行
    //   判定 `!engine.enabled` → 403「当前套餐未包含此通道」。
    // 也就是说商户看到的是一个"看起来能选、实际一用就报错"的通道 ——
    // 正是 048 注释里说"要让客户端不再列出"的那个坑，当时没做到。
    const rows = (await this.packageChannels(session)).filter(row => !row.retired && row.enabled)
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

  /**
   * 翻译（全站最热的路径）。
   *
   * ## 这个函数只负责编排
   *
   * 它原本是 281 行的大函数，入参校验、通道解析、幂等锁、两次事务、结算
   * 全挤在一个函数体里。每一段都配了长注释解释"为什么这样写"——
   * 那恰恰说明它们是**五个独立的决定**，不该躺在同一个作用域里。
   *
   * 现在按阶段拆开，每个阶段一个方法。这里只保留**顺序**，而顺序本身
   * 就是最重要的业务规则：
   *
   *   ① 校验入参        ← 早失败，不碰库
   *   ② 解析通道        ← 必须在计费之前：不同通道成本不同
   *   ③ 混合路由        ← 必须在权益校验之后：快路也不能绕过套餐
   *   ④ 幂等锁          ← 必须在事务之外：锁是跨进程的
   *   ⑤ 预留（事务一）
   *   ⑥ 打上游（**事务外**）
   *   ⑦ 结算（事务二）
   *
   * ## 第 ⑥ 步为什么必须在两个事务中间
   *
   * 厂商调用是中位数 1.9 秒、P90 3.2 秒的网络请求。放在事务里等于
   * 把数据库连接按住 3 秒 —— 十几个并发就能把连接池打干。
   * 所以是"预留 → 事务提交 → 打上游 → 再开事务结算"。
   * 中途挂了靠 `reconcileExpiredReservations` 扫尾，不靠事务回滚。
   *
   * 改动这里时，**不要把 ⑥ 挪进任何事务**。
   */
  async translate(session, data, idempotencyKey) {
    // ① 校验
    const parsed = this.normalizeTranslateInput(session, data)

    // ② 解析通道（含三种拒绝理由：没通道 / 已下架 / 套餐未包含 / 未上线）
    const resolved = await this.resolveTranslateEngine(session, data, parsed)

    // ③ 混合路由：短文本换快路。必须在②之后，否则能绕开套餐校验。
    const route = translationRouter.routeTranslate({
      selected: resolved.engine,
      text: parsed.text,
      candidates: resolved.allowed,
      fastEngineIds: this.fastEngineIds(),
      enabled: this.hybridRoutingEnabled()
    })
    const usedEngine = route.engine

    const chars = this.translator.countBillableChars(parsed.text)
    const key = this.requireIdempotencyKey(idempotencyKey, data)
    const requestHash = requestDigest({
      subAccountId: session.kind === 'sub' ? session.account.id : null,
      engineId: resolved.engineId,
      from: parsed.from,
      to: parsed.to,
      sourceHash: parsed.sourceHash
    })

    // ④ 幂等锁：同一商户同一请求号不允许并发。
    //    锁在事务外，因为它管的是跨进程的并发，事务管不了。
    const lock = await this.acquireTranslateLock(session, key)
    const started = Date.now()
    let reservation

    try {
      // ⑤ 预留（事务一）
      reservation = await this.reserveTranslate({
        session, parsed, key, requestHash, chars,
        engineId: resolved.engineId
      })
      // 幂等重放：同一个请求号已经完成过，直接回上次的结果，不重新计费
      if (reservation.responseJson) return reservation.responseJson
      if (reservation.status !== 'reserved') throw new ApiError(409, '该请求已结束，不能重试', 'REQUEST_FINALIZED')
      if (new Date(reservation.expiresAt).getTime() <= Date.now()) {
        await this.reconcileExpiredReservations(1, reservation.id)
        throw new ApiError(409, '翻译预留已超时并退款', 'RESERVATION_EXPIRED')
      }

      // ⑥ 打上游（事务外 —— 见函数头）
      const result = await this.callUpstream({ session, parsed, engine: usedEngine })

      // ⑦ 结算（事务二）
      return await this.settleTranslate({
        session, parsed, key, chars, started, trigger: parsed.trigger,
        reservation, result, route, engine: resolved.engine,
        usedEngine: usedEngine || resolved.engine, engineId: resolved.engineId
      })
    } catch (error) {
      // 预留没走完就把钱还回去。这里只处理"已经预留出去但没结算"的情况。
      if (reservation && reservation.status === 'reserved') {
        await this.releaseReservation(reservation.id, error.code || 'TRANSLATE_FAILED')
      }
      throw error
    } finally {
      // 释放锁：用 token 比对，避免误删别人的锁（比如自己的锁已超时并被他人重取）
      await this.redis.eval(
        'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',
        1, lock.key, lock.token
      )
    }
  }

  /**
   * ① 入参校验与规范化。
   *
   * 纯函数式：只读 session/data，不碰库、不碰锁。所以能早失败，
   * 也能被单测直接调。
   *
   * 注意 `trigger` 是**客户端可控**的，必须白名单收口 ——
   * 它要进 translate_logs，列上有 CHECK 约束，但约束报错是 500，
   * 而这里能给出干净的 400/静默置空。
   */
  normalizeTranslateInput(session, data) {
    const raw = String(data.text || data.source || '').trim()
    if (!raw) throw new ApiError(400, '请输入要翻译的文本', 'TEXT_REQUIRED')
    if (raw.length > 5000) throw new ApiError(413, '单次翻译最多 5000 个字符', 'TEXT_TOO_LONG')

    // 去掉 emoji 再判断是否为空：纯表情消息不需要翻译，也不该计费。
    // 但返回的是"跳过"而不是错误 —— 客户端发个表情不算出错。
    const text = raw
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/[\uFE0F\u200D\u20E3]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    const from = String(data.from || 'auto')
    const to = String(data.to || 'zh')
    if (!/^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/i.test(from) ||
        !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(to)) {
      throw new ApiError(400, '语言参数无效', 'BAD_LANGUAGE')
    }

    const trigger = TRIGGER_VALUES.includes(String(data.trigger || '').trim())
      ? String(data.trigger).trim()
      : ''

    return {
      text,
      empty: !text,
      from,
      to,
      trigger,
      sourceHash: crypto.createHash('sha256').update(text).digest('hex')
    }
  }

  /**
   * ② 解析通道：套餐权益 → 选中的引擎 → 逐个排除不合法的理由。
   *
   * ## 四种拒绝必须分开，不能合并成一句"不可用"
   *
   * 用户看到不同文案会做不同的事：
   *   - 没有可用通道（503）→ 找客服。升级套餐也解决不了，不能说"升级"
   *   - 已下架（503）      → 换一个通道。升级也换不来一个下架的东西
   *   - 套餐未包含（403）   → 升级套餐。这是唯一"该引导升级"的情况
   *   - 未上线（503）      → 换一个通道。这是我们的问题，不是他的
   *
   * 合并文案的代价是用户按提示操作后仍然失败，而且不知道还能做什么。
   */
  async resolveTranslateEngine(session, data, input) {
    // 权益版本按**购买时**那一版解析（packageChannels），不是当前配置的活表。
    // 商户能用什么通道，是他买的时候定下的，我们后来改配置不该改变他的权益。
    const allowed = await this.packageChannels(session)
    const engineId = await this.resolveEngineId(session, data.engine, allowed)

    if (!engineId) {
      // 权益里一个可用通道都没有 —— 可能全是"即将上线"，也可能套餐压根没配。
      // 不能回 403「套餐未包含」：那会把人引向升级，而升级也解决不了。
      throw new ApiError(503, '当前账号没有可用的翻译通道，请联系客服', 'ENGINE_NOT_CONFIGURED')
    }

    const engine = allowed.find(row => row.id === engineId)

    if (engine && engine.retired) {
      throw new ApiError(503, `翻译通道「${engine.name}」已下架，请在通道列表里换一个`, 'ENGINE_RETIRED')
    }
    if (!engine || !engine.enabled) {
      throw new ApiError(403, '当前套餐未包含此通道', 'ENGINE_NOT_ALLOWED')
    }
    if (!engine.wired) {
      // 正常路径不该走到这里：engines() 已把未接通的通道以 allowed=false 下发，
      // resolveEngineId 也会跳过它们。能到这儿说明客户端**显式指定**了未接通的
      // 通道（旧版客户端 / 手工调接口）。
      //
      // 此时**绝不能**偷偷换成别的通道 —— 用户选的是它、界面显示的也是它，
      // 换掉就是"静默切换供应商"。宁可报错。
      throw new ApiError(503, `翻译通道「${engine.name}」尚未上线，请换一个通道`, 'ENGINE_NOT_CONFIGURED')
    }

    return { allowed, engineId, engine }
  }

  /**
   * 请求号校验。
   *
   * 长度上限 160：它要进 redis key 和数据库唯一索引，
   * 不设限等于让人用超长 key 撑爆内存。
   */
  requireIdempotencyKey(idempotencyKey, data) {
    const key = String(idempotencyKey || data.requestId || '').trim()
    if (!key || key.length > 160) {
      throw new ApiError(400, '缺少有效的 Idempotency-Key', 'IDEMPOTENCY_KEY_REQUIRED')
    }
    return key
  }

  /**
   * ④ 分布式幂等锁。
   *
   * 前缀统一由 redis-client 提供 —— 这里**不能**再自己拼 `pix:`。
   * 曾经两边各加一次，线上键实际是 `pix:pix:translate:lock:...`，
   * 清理脚本按单前缀扫的时候一个都扫不到。
   */
  async acquireTranslateLock(session, key) {
    const lockKey = `${redisPrefix}translate:lock:${session.parent.id}:${key}`
    const token = crypto.randomBytes(16).toString('hex')
    const ok = await this.redis.set(lockKey, token, 'NX', 'PX', this.reservationTtlMs)
    if (!ok) throw new ApiError(409, '相同翻译请求正在处理', 'REQUEST_IN_PROGRESS')
    return { key: lockKey, token }
  }

  /**
   * ⑤ 预留（事务一）。
   *
   * 幂等在这里实现，而不是靠应用层记状态：
   *   - `FOR UPDATE` 锁行，同一请求号并发只有一个能进
   *   - 已存在且 requestHash 一致 → 直接返回旧记录（重放）
   *   - 已存在但 hash 不一致 → 拒绝，并区分"换了通道"
   *
   * ## 换通道为什么要单独一个错误码
   *
   * 换通道重译在厂商侧是真花钱的，必须重新计费。但绝不能默默扣 ——
   * 客户端要拿新 requestId 重发，并且**先告诉用户**"会再扣一次"。
   * 所以用 `ENGINE_SWITCH_REQUIRES_NEW_REQUEST`，让客户端能把这条
   * 文案原样贴给用户，而不是笼统的"请求号冲突"。
   */
  async reserveTranslate({ session, parsed, key, requestHash, chars, engineId }) {
    return this.repo.transaction(async client => {
      const existing = mapRow((await this.repo.query(
        'SELECT * FROM translation_reservations WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [session.parent.id, key], client
      )).rows[0])

      if (existing) {
        if (existing.requestHash !== requestHash) {
          const switched = existing.engineId && existing.engineId !== engineId
          throw new ApiError(
            409,
            switched
              ? '该请求号已用于其他翻译通道。换通道重新翻译会再次扣除字符，请确认后重试'
              : 'Idempotency-Key 已用于其他请求',
            switched ? 'ENGINE_SWITCH_REQUIRES_NEW_REQUEST' : 'IDEMPOTENCY_KEY_REUSED'
          )
        }
        return existing
      }

      // ---- 预扣：校验余额 + 真扣 ----
      //
      // 这一段是**唯一的扣费起点**，`settleTranslate` 与 `releaseReservation`
      // 都建立在"钱已经扣过"的前提上：
      //   · 结算成功 → 不动余额（预扣的那笔就是这一单的账单）
      //   · 可退款（原文=译文）→ `+chars` 还回去
      //   · 上游失败 / 超时 → `releaseReservation` 里 `+reservedChars` 还回去
      //
      // 一旦少了这两行，后两处就变成**凭空发钱**：每失败一次余额涨一次。
      // 实测：1000 起始，跑一轮集成测试余额变成 1004，而 char_used 还是 0 ——
      // 账面看着像扣了（`char_used` 来自另一条链路），实际一分没扣。
      //
      // `lockAccount` 必须在 `adjustChars` 之前：并发两个请求同时读到 1000、
      // 各自通过 `>= chars` 检查，就会一起扣成负数。
      const account = await this.repo.lockAccount(client, session.kind, session.account.id)
      if (!account || number(account.charBalance) < chars) {
        throw new ApiError(409, '字符余额不足', 'INSUFFICIENT_CHARS')
      }
      await this.repo.adjustChars(client, session.kind, session.account.id, -chars)

      const inserted = await this.repo.query(
        `INSERT INTO translation_reservations
           (user_id, sub_account_id, engine_id, idempotency_key, status, reserved_chars,
            expires_at, source_language, target_language, source_hash, request_hash)
         VALUES ($1,$2,$3,$4,'reserved',$5,
                 NOW() + ($6::text || ' milliseconds')::interval, $7,$8,$9,$10)
         RETURNING *`,
        [session.parent.id, session.kind === 'sub' ? session.account.id : null, engineId, key,
          chars, this.reservationTtlMs, parsed.from, parsed.to, parsed.sourceHash, requestHash], client
      )
      return mapRow(inserted.rows[0])
    })
  }

  /**
   * ⑥ 读缓存 / 打上游。
   *
   * **整个过程在事务之外** —— 这是全函数最要紧的约束，见 translate 的头部注释。
   *
   * 缓存键用**实际执行的通道**（usedEngine），不是用户选的那个：
   * 同一句话走 LLM 和走专用 API 的译文可能不同，混用会导致
   * "换了路由却拿到旧译文"。
   *
   * 缓存读失败只记日志不抛：缓存是加速手段，挂了就该直连上游，
   * 不能因为 redis 抽风让翻译整体不可用。
   */
  async callUpstream({ session, parsed, engine, engineId }) {
    const cacheTenant = `${session.kind}:${session.account.id}`
    const cacheEngineId = engine && engine.id ? engine.id : engineId
    const cacheRequest = { engine: cacheEngineId, from: parsed.from, to: parsed.to, text: parsed.text }

    let cachedText = null
    try {
      cachedText = await this.translationCache.get(cacheTenant, cacheRequest)
    } catch (error) {
      console.error('Translation cache read failed:', error.message)
    }

    let result
    if (cachedText != null) {
      result = { ok: true, text: cachedText, cached: true }
    } else {
      // ★ 分段计时 ★ 翻译慢到底慢在哪，光看总时长猜不出来：
      // 可能是取凭据、可能是厂商本身、也可能是连接建立。
      // 打一行 TRANS_PERF 直接量出来。
      const tCred = Date.now()
      const credentials = await this.engineCredentials(engine.id)
      const credMs = Date.now() - tCred

      const tVendor = Date.now()
      result = await this.translator.translate(engine, {
        text: parsed.text, from: parsed.from, to: parsed.to,
        detected: this.translator.detectLang(parsed.text)
      }, {
        allowPublicNetwork: this.allowPublicNetwork,
        credentials
      })
      const vendorMs = Date.now() - tVendor

      try {
        console.log('TRANS_PERF engine=' + engine.id +
          ' cred=' + credMs + 'ms vendor=' + vendorMs + 'ms' +
          ' retries=' + (result && result.retries != null ? result.retries : '-') +
          ' len=' + String(parsed.text || '').length)
      } catch (e) { /* 日志失败不能影响翻译 */ }
    }

    if (!result || !result.ok) {
      throw new ApiError(502, (result && result.msg) || '翻译服务暂不可用', 'TRANSLATE_FAILED')
    }

    // 句末句点收口：模型爱给短句补句点（"在吗" → "Are you there."）。
    // 必须在**写缓存之前**处理 —— 否则缓存里存的还是带点的版本，
    // 后面每次命中都会把点再发出去，清一次等于没清。
    // 也必须在**退款判定之前**处理 —— 否则 "OK." vs 原文 "OK"
    // 会被判成"翻译有变化"而照常扣费。
    const translated = trimTrailingDot(parsed.text, String(result.text || '').trim())
    // 可退款 = 没翻出东西 / 翻出来跟原文一样（大小写不敏感）。
    // 这些情况下不该扣字符 —— 用户没拿到价值。
    // 注意 cached 命中时即使"一样"也不退：那是缓存里的历史结果，字符早就扣过了。
    const refundable = Boolean(
      result.skipped || !translated || translated.toLocaleLowerCase() === parsed.text.toLocaleLowerCase()
    )

    if (!refundable && !result.cached) {
      try {
        await this.translationCache.set(cacheTenant, cacheRequest, translated)
      } catch (error) {
        console.error('Translation cache write failed:', error.message)
      }
    }

    return { result, translated, refundable }
  }

  /**
   * ⑦ 结算（事务二）。
   *
   * 二次 `FOR UPDATE` 是必要的：第 ⑤ 步提交后到第 ⑦ 步之间，
   * 预留可能已被对账任务判超时并退给用户。再查一次能发现这种情况，
   * 避免"钱已经退了还继续结算"。
   *
   * ## 日志为什么用 SAVEPOINT 兜底
   *
   * 日志是账务旁路，不该有能力把一次**已经成功**的翻译打成 500。
   * 曾经因为 CHECK 约束对不上（source==target、hash 大小写、trigger 白名单）
   * 导致整个事务回滚，用户看到 TRANSLATE_FAILED 但厂商已经收了钱。
   */
  async settleTranslate({ session, parsed, chars, started, trigger, reservation, result, route, engine, usedEngine, engineId }) {
    const { result: upstream, translated, refundable } = result

    return this.repo.transaction(async client => {
      const current = mapRow((await this.repo.query(
        'SELECT * FROM translation_reservations WHERE id=$1 FOR UPDATE',
        [reservation.id], client
      )).rows[0])

      // 并发时后到的那个直接复用已有结果，不重复结算
      if (current && current.responseJson) return current.responseJson
      if (!current || current.status !== 'reserved') {
        throw new ApiError(409, '翻译预留已结束', 'RESERVATION_FINALIZED')
      }

      const durationMs = Date.now() - started

      // 余额已在 `reserveTranslate` 预扣过（那是唯一扣费起点）。
      // 这里**只处理退款**：翻译没产生价值时把预扣的还回去。
      //
      // 千万不要在这里再补一次 `-chars` —— 那是重复扣费（预扣 + 结算 = 扣两次）。
      // 也不能只写这一行而没有预扣 —— 那会变成凭空发钱。
      // 两者是配套的，改动前先看 `reserveTranslate` 里的注释。
      if (refundable) await this.repo.adjustChars(client, session.kind, session.account.id, chars)
      const balance = await this.repo.lockAccount(client, session.kind, session.account.id)

      // 真实调用的模型，以适配层报上来的为准：
      // 适配层可能因参数不被接受而**降级重试**（某些模型不收 temperature），
      // 展示的必须就是这次真正调用的那个，不是我们以为的那个。
      const usedModel = String((upstream && upstream.model) || (usedEngine && usedEngine.model) || '')
      const response = {
        success: true,
        wired: Boolean(usedEngine.wired),
        cached: Boolean(upstream && upstream.cached),
        skipped: refundable ? ((upstream && upstream.skipped) || 'unchanged') : undefined,
        translation: translated,
        chars: refundable ? 0 : chars,
        remain: number(balance.charBalance),
        from: parsed.from === 'auto' ? this.translator.detectLang(parsed.text) : parsed.from,
        engine: usedEngine.id || engineId,
        engineName: usedEngine.name || '',
        provider: usedEngine.provider || '',
        model: usedModel,
        // 路由透明化：只有真发生了通道切换才带这个字段。
        // 客户端据此在芯片上标注"快速通道"，用户随时能看到实际用了谁 ——
        // 这满足 resolveEngineId 头部"不得静默切换"的可见性要求。
        routed: route.routed
          ? { from: route.from, to: route.to, reason: route.reason }
          : undefined
      }

      let translateLogId = null
      if (!refundable) {
        // 扣字符与计数。submit 路径与这里必须口径一致，否则两边账单对不上。
        const table = session.kind === 'sub' ? 'sub_accounts' : 'users'
        await this.repo.query(
          `UPDATE ${table} SET char_used=char_used+$2,translate_count=translate_count+1,updated_at=NOW() WHERE id=$1`,
          [session.account.id, chars], client
        )

        // 日志字段要过表上的 CHECK 约束，逐条对齐后再落库。
        //
        // 踩过的坑（线上 500，客户端显示 TRANSLATE_FAILED，翻译其实**已经成功**）：
        //   1. `source_language <> target_language` —— 请求带 auto 时记检测语言，
        //      原文本身就是目标语言（中文→中文）时两边相等，整条 INSERT 被拒；
        //   2. `source_hash ~ '^[0-9a-f]{64}$'` —— 哈希来源不同则长度/大小写不符；
        //   3. `trigger = ANY(白名单)` —— 新增触发场景没同步迁移就会炸。
        //
        // 上面的字段对齐只是第一道；logTranslateRow 内部再用 SAVEPOINT 兜底 ——
        // 约束/列/枚举任何一处对不上，最多丢一条日志，绝不让用户的译文跟着回滚。
        const logLang = String(response.from || '').trim() || 'auto'
        const logTarget = String(parsed.to || '').trim() || 'auto'
        const logSourceLanguage = logLang === logTarget ? 'auto' : logLang
        const logSourceHash = /^[0-9a-fA-F]{64}$/.test(String(parsed.sourceHash || ''))
          ? String(parsed.sourceHash).toLowerCase()
          : null

        translateLogId = await this.logTranslateRow(client, {
          userId: session.parent.id,
          subAccountId: session.kind === 'sub' ? session.account.id : null,
          // 落库用**实际执行的通道**：成本按真实供应商结算，
          // 记成用户选的那条会让月度对账凭空多/少一块。
          engineId: usedEngine.id || engineId,
          reservationId: reservation.id,
          sourceLanguage: logSourceLanguage,
          targetLanguage: logTarget,
          chars,
          costAmount: number(usedEngine.costPerMillion) * chars / 1000000,
          sourceHash: logSourceHash,
          snippet: String(parsed.text || '').slice(0, 300),
          cached: Boolean(upstream && upstream.cached),
          durationMs,
          trigger,
          fallbackSource: String(parsed.text || '')
        })
      }

      // 上游真实消耗：**不管这次是否退款给客户都要记**。
      //
      // 退款是"这条译文没价值，不扣你的字符"，但厂商那边是真的消耗了
      // token 也真的会产生账单。把退款当成没发生过，成本表上就凭空少一块，
      // 月度对账必然对不上。所以只要真打了上游（非缓存命中）就落一条内部台账，
      // 与对客户的字符账本彻底分开。
      if (!(upstream && upstream.cached)) {
        await this.recordUpstreamUsage(client, {
          reservation, engine, result: upstream, session, translateLogId,
          from: response.from, to: parsed.to, durationMs, refundable
        })
      }

      // 结算预留：退款 → released；否则 → committed。
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
  /**
   * 写一条对客翻译流水。**绝不向外抛异常。**
   *
   * `translate_logs` 上一堆 CHECK 约束（语言不能相同、哈希 64 位小写十六进制、
   * trigger 白名单、chars > 0……）。约束本身是对的，但流水是旁路账：
   * 约束一旦因为新的输入组合没被满足，正确的结果是**丢一条流水并告警**，
   * 而不是把一次已经拿到译文、已经扣过字符的调用打成 500 再回滚
   * —— 用户看到的是"翻译失败"，实际上翻译早就成功了（线上真实故障）。
   *
   * 用 SAVEPOINT 而不是 try/catch：Postgres 里语句报错会让整个事务进入
   * aborted 状态，光 catch 住 JS 异常没用，后续语句仍然会全部失败。
   */
  async logTranslateRow(client, row) {
    try {
      await this.repo.query('SAVEPOINT translate_log', [], client)
      const logged = await this.repo.query(
        `INSERT INTO translate_logs(user_id,sub_account_id,engine_id,reservation_id,
         source_language,target_language,chars,cost_amount,sell_amount,source_hash,snippet,cached,duration_ms,trigger)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,COALESCE($9,encode(sha256(convert_to($14,'UTF8')),'hex')),$10,$11,$12,$13) RETURNING id`,
        [row.userId, row.subAccountId, row.engineId, row.reservationId,
          row.sourceLanguage, row.targetLanguage, row.chars, row.costAmount, row.sourceHash,
          row.snippet, row.cached, row.durationMs, row.trigger, row.fallbackSource], client
      )
      await this.repo.query('RELEASE SAVEPOINT translate_log', [], client)
      return logged.rows[0] && number(logged.rows[0].id) || null
    } catch (error) {
      try { await this.repo.query('ROLLBACK TO SAVEPOINT translate_log', [], client) } catch (_) { /* 事务已坏 */ }
      console.error(
        `translate_logs insert skipped (translation still served): ${error.message}`,
        JSON.stringify({
          reservationId: row.reservationId, engineId: row.engineId, from: row.sourceLanguage,
          to: row.targetLanguage, chars: row.chars, trigger: row.trigger, cached: row.cached
        })
      )
      return null
    }
  }

  async recordUpstreamUsage(client, { reservation, engine, result, session, translateLogId, from, to, durationMs }) {
    try {
      const usage = (result && result.usage) || {}
      const model = String((result && result.model) || (engine && engine.model) || '')
      const sentChars = number(reservation && reservation.reservedChars)

      /**
       * 厂商没回 `usage` 时**不能把成本记成 0**。
       *
       * 这是 2026-10-11 在生产上发现的真实缺陷：`deepseek` 通道 48 次调用
       * 全部是 `prompt_tokens=0 / completion_tokens=0 / upstream_cost=0`，
       * 而 `cost_verified=true`。原因两条：
       *   1. `normalizeUsage()` 在厂商未返回 usage 时返回 `null`；
       *   2. 这里拿不到 token 就直接按 0 记账。
       * 于是成本报表上整条通道显示"几乎零成本"，而 `cost_verified=true`
       * 还让人误以为"已核实"——它核的是**单价查到了**，不是**用量记到了**。
       * 金额现在还小（约 $0.005），但机制是坏的：DeepSeek 一旦成为主力通道，
       * 月度对账会凭空少一整块成本。
       *
       * 现在的处置：按通道成本表里的**字符单价**兜底估算（与
       * `translate_logs.cost_amount` 同一口径），并把 `cost_verified`
       * 如实置为 false —— 宁可标记成"估的"，也不要一个看起来干净的 0。
       */
      const hasUsage = Boolean(
        number(usage.promptTokens) || number(usage.completionTokens) || number(usage.totalTokens)
      )
      const cost = hasUsage
        ? estimateUpstreamCost({
          model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          // 按字符计价的通道（谷歌）没有 token 数，用实际送翻的字符数
          characters: (engine && engine.provider === 'Google') ? sentChars : 0
        })
        : this.estimateCostFromChars(engine, model, sentChars)
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
      // 两种"未核实"要分开喊 —— 处置完全不同：一个是去补价目表，
      // 另一个是去查厂商为什么没回 usage。
      if (!cost.verified) {
        if (cost.estimated) this.reportEstimatedUsage(engine, model, cost, sentChars)
        else this.reportUnverifiedCost(engine, model, cost)
      }
    } catch (error) {
      // 台账是旁路：写失败要能在日志里看见，但不能把已经成功的翻译带崩
      console.error('Upstream usage ledger write failed:', error.message)
    }
  }

  /**
   * 厂商没回 `usage` 时的兜底成本估算。
   *
   * 口径：`通道成本表单价 × 送翻字符数 ÷ 1e6` —— 与
   * `translate_logs.cost_amount` 的算法**完全一致**，所以两本账可以直接对照，
   * 不会出现"客户账本上一个数、内部台账上另一个数"。
   *
   * 它是**上界估算**（`cost_per_million` 本身是按保守 token/字符比折算的），
   * 因此一定标 `verified=false`。
   *
   * 拿不到 `cost_per_million`（未定价通道）时仍返回 0，但同样标未核实
   * —— 0 在这里的含义是"我们真的不知道"，不是"免费"。
   */
  estimateCostFromChars(engine, model, chars) {
    const perMillion = number(engine && engine.costPerMillion)
    const cost = perMillion * number(chars) / 1e6
    return {
      cost: Number(cost.toFixed(8)),
      currency: 'USD',
      unit: 'token',
      provider: (engine && engine.provider) || '',
      model: String(model || ''),
      verified: false,
      estimated: true,
      note: '厂商未返回 usage（拿不到 token 数），成本按通道成本表的字符单价估算；'
        + '与 translate_logs.cost_amount 同口径，属上界估算，需人工复核。',
      source: 'estimate:cost_per_million',
      asOf: ''
    }
  }

  /**
   * 厂商没回 usage 时喊一声（按"渠道:模型"去重）。
   *
   * 不合并进 `reportUnverifiedCost`：那条消息告诉人去补价目表，
   * 而这里的病在**适配器没拿到用量**，去补价目表是白费功夫。
   */
  reportEstimatedUsage(engine, model, cost, chars) {
    const key = `est:${(engine && engine.id) || '?'}:${model || '(空 model)'}`
    if (this.unverifiedCostReported.has(key)) return
    this.unverifiedCostReported.add(key)
    console.warn(
      `[usage-cost] 渠道「${(engine && engine.id) || '?'}」的模型「${model || '(空)'}」` +
      `本次**没有拿到厂商用量**（token 数未知），成本按字符单价估为 ${cost.cost}（USD，` +
      `${chars} 字符）并标记 cost_verified=false。` +
      '0 或估值都不代表真实账单 —— 处置：检查该渠道的响应里是否真的带 usage。'
    )
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

    // "主下载按钮"必须跟架构走。
    //
    // 老实现直接取 `downloads.client_url` 这个后台设置 —— 它是**不带架构**的一条
    // 静态地址。于是 `arch=x64` 的 Intel 用户点主按钮，下到的是 Apple 芯片包
    // （装上去直接闪退），而页面上"其他版本"里明明列着正确的 x64。
    //
    // 现在优先用按架构挑出来的 macOS 包；一条都没登记时才退回静态设置
    // （保留后台手填一个外链的可能性，不至于把按钮藏掉）。
    const macUrl = download('macos')
    const mainDownloadUrl = macUrl || setting(settings, 'downloads.client_url', '')
    return {
      siteName: setting(settings, 'site.name', 'Hello Pix'),
      announcement: setting(settings, 'site.announcement', ''),
      clientDownloadUrl: mainDownloadUrl,
      clientDownloads: {
        app: mainDownloadUrl,
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
    // 上架开关：缺省 = 缺省上架；给了值就按字面解析。
    // 别用 `Boolean(number(x))` —— `Number('true')`/`Number('no')` 是 NaN → false，
    // 表单里传字符串会把"上架"静默降级成"下架"，用户那边直接看不到新版本。
    const enabled = data.enabled === undefined || data.enabled === ''
      ? true
      : bool(data.enabled) === true
    if (data.enabled !== undefined && data.enabled !== '' && bool(data.enabled) === null) {
      throw new ApiError(400, 'enabled 必须是 true/false/1/0', 'BAD_BOOLEAN')
    }
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

module.exports = { CoreService, number, bool, setting, requestDigest, TRIGGER_VALUES }
