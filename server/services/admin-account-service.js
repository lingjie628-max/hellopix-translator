'use strict'

/**
 * 后台「商户管理」的写入逻辑（新建 / 编辑）。
 *
 * ## 为什么从路由里搬出来
 *
 * `/admin/users/save` 141 行，一个 handler 里塞了两条完全不同的路径：
 *
 *   1. **编辑** —— 十几个字段的 COALESCE 更新、权益版本钉定判断、密码重置后踢人
 *   2. **新建** —— 试用额度、子账号额度继承、默认通道挑选、试用充值单
 *
 * 两条路都动了资金/权益相关字段，但挤在一起读起来像考古。
 * 更要命的是：**这里的每一条规则背后都有一次线上事故**（见下），
 * 埋在 141 行的 handler 里，下一个人改的时候根本不知道会踩哪个。
 *
 * ## 每条规则对应的事故
 *
 * | 规则 | 不这么写会怎样 |
 * | --- | --- |
 * | 编辑时禁止改 `charBalance` | 绕过字符流水，余额与流水对不上账 |
 * | 只有换套餐才重钉 `catalogVersion` | 改个备注就换掉老客户已付钱的通道组合 |
 * | 到期时间三态（无限/日期/不动） | 传 null 只能保留原值，后台永远设不回"不过期"，只能填 2038 假日期 |
 * | 布尔开关一律走 `bool()` | 请求体是 `"true"`，`Number("true")` 是 NaN → 开关存成关闭，且无报错 |
 * | `autoReply` 编辑时也要写 | 原先漏了这一列，编辑态点了等于没点（新建时却会写） |
 * | 新建时 `$16` 必须绑定参数 | 曾写成 16 列 17 个值 → 新建商户整条路径 500 |
 * | 新商户子额度继承套餐 | 不继承则恒为 0，一进来就开不了子账号 |
 * | 默认通道按「已接通且启用」挑 | 写死 `youdao`，该通道没接通时新商户从第一天就翻译失败 |
 */

const crypto = require('crypto')
const { ApiError } = require('../lib/http')
const { number, bool } = require('../services/core-service')

class AdminAccountService {
  constructor(repo, auth) {
    this.repo = repo
    this.auth = auth
  }

  /**
   * 编辑已有商户。
   * @returns {Promise<'updated'>}
   */
  async update(data, actor, ip) {
    // 余额只能走字符调整接口 —— 那里有流水、幂等键、审计。
    // 从这里直接改等于绕开全部账务机制。
    if (data.charBalance !== undefined && data.charBalance !== '') {
      throw new ApiError(400, '余额只能通过字符调整接口变更', 'USE_CHARACTER_GRANT')
    }

    const pack = await this.repo.package(data.versionId || data.packageId)
    if (!pack) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')

    const passwordHash = data.password ? await this.auth.hash(data.password) : null

    // 先取当前套餐与已钉权益版本 —— 下面要判断"这次编辑有没有换套餐"。
    //
    // 为什么必须判断：`users.package_catalog_version` 是"这位商户当初买到的是
    // 哪一版通道组合"的凭据。如果每次编辑（哪怕只是改个备注、续个期）都顺手
    // 把它刷成当前版本，那这个字段就形同虚设 —— 一次无关的编辑就能把老客户
    // 已经付过钱的权益悄悄换掉，正是"擅自改变已售权益"。
    // 所以：只有**换套餐**才重新钉，不换就原样保留。
    const before = await this.repo.query(
      'SELECT package_id,package_catalog_version FROM users WHERE id=$1', [data.id])
    if (!before.rows[0]) throw new ApiError(404, '用户不存在', 'USER_NOT_FOUND')

    const packageChanged = String(before.rows[0].package_id || '') !== String(pack.id)
    const requestedVersion = data.catalogVersion === undefined || data.catalogVersion === ''
      ? null
      : number(data.catalogVersion)
    if (requestedVersion !== null && requestedVersion < 1) {
      throw new ApiError(400, '权益版本必须是正整数', 'BAD_CATALOG_VERSION')
    }
    // 显式指定优先；换套餐时钉到新套餐的当前版本；否则 NULL = 保持原值
    const catalogVersion = requestedVersion !== null
      ? requestedVersion
      : (packageChanged ? (Number(pack.catalogVersion) || null) : null)

    const result = await this.repo.query(
      `UPDATE users SET nickname=COALESCE($2,nickname),status=COALESCE($3,status),
       package_id=$4,port_limit=COALESCE($5,port_limit),
       -- 到期时间支持"清空成无限期"。
       -- 原来是 COALESCE($6::timestamptz,expires_at)：传 null 只会**保留原值**，
       -- 于是后台根本无法把一个已设到期时间的商户改回不过期 —— 想设"无限"
       -- 只能填 2038 这种假日期（jiufa 现在就停在 2038-10-10，正是这么来的）。
       -- 现在用显式开关 $14 区分三态：开 → NULL；给了日期 → 用日期；都没给 → 保持原值。
       expires_at=CASE WHEN $14::boolean THEN NULL
                       WHEN $6::timestamptz IS NOT NULL THEN $6::timestamptz
                       ELSE expires_at END,
       password_hash=COALESCE($7,password_hash),phone=COALESCE($8,phone),remarks=COALESCE($9,remarks),
       enterprise=COALESCE($10,enterprise),auto_reply=COALESCE($13,auto_reply),
       sub_quota=COALESCE($11,sub_quota),
       package_catalog_version=COALESCE($12,package_catalog_version),
       updated_at=NOW() WHERE id=$1 RETURNING username,status,package_catalog_version`,
      [data.id, data.nickname || null, data.status === undefined ? null : number(data.status),
        pack.id, data.port === undefined ? null : number(data.port),
        data.expireTime || null, passwordHash, data.phone === undefined ? null : (data.phone || null),
        data.remarks === undefined ? null : data.remarks,
        // 开关一律走 bool()，不能写 Boolean(number(...))：
        // 请求体里是字符串 "true"，Number("true") 是 NaN，会被判成 false ——
        // 于是"打开"的开关保存后反而被关掉，且毫无报错（线上踩过）
        bool(data.enterprise),
        data.subQuota === undefined || data.subQuota === '' ? null : number(data.subQuota),
        catalogVersion,
        // 自动回复原来**根本没写**：编辑态点了等于没点（新建时却会写）。
        // 补上这一列，让两边的行为一致。
        bool(data.autoReply),
        // $14：到期时间是否设为「无限期」。null（没传）时不动作。
        bool(data.expireUnlimited)]
    )
    if (!result.rows[0]) throw new ApiError(404, '用户不存在', 'USER_NOT_FOUND')

    // 改了密码、或把账号停用 → 立刻踢掉在线会话。
    // 否则"停用"只是让下次登录失败，已经登录的那条连接还能继续用。
    if (passwordHash || number(result.rows[0].status) !== 1) {
      await this.auth.revokeUser('main', data.id)
    }

    // 权益版本变了就把新旧版本写进审计：事后被问"谁把这家的通道换了"要有答案
    await this.repo.audit(null, actor, '编辑商户', result.rows[0].username, ip, {
      type: 'user',
      id: data.id,
      catalogVersion: Number(result.rows[0].packageCatalogVersion) || null
    })

    return 'updated'
  }

  /**
   * 新建商户。
   * @returns {Promise<{username:string, gift:number}>}
   */
  async create(data, actor, ip) {
    if (!data.username) throw new ApiError(400, '请填写账号', 'USERNAME_REQUIRED')

    const pack = await this.repo.package(data.versionId || data.packageId)
    if (!pack) throw new ApiError(404, '套餐不存在', 'PACKAGE_NOT_FOUND')

    const settings = await this.repo.settings()
    const gift = data.charBalance === undefined || data.charBalance === ''
      ? number(settings['registration.trial_chars'])
      : number(data.charBalance)

    // 子账号额度：没显式填就按套餐自带的给。
    // 不这么做的话新商户额度恒为 0（`sub_quota` 建表默认值），
    // 一进来就开不了子账号 —— 与套餐里带的额度直接矛盾。
    const subQuotaForNew = data.subQuota === undefined || data.subQuota === ''
      ? Math.max(0, Math.floor(Number(pack.subQuota) || 0))
      : number(data.subQuota)

    // 新商户的默认翻译通道：后台设置的默认值 → 套餐内第一个「已接通且启用」的 → 空。
    // 原先写死 'youdao'，一旦该通道没接通，该商户从第一天起翻译就必然失败。
    let defaultEngine = String(settings['translation.active_engine'] || '').trim()
    if (!defaultEngine) {
      const usable = await this.repo.packageEngines(pack.id)
      defaultEngine = (usable.find(row => row.enabled && row.wired) || {}).id || ''
    }

    const passwordHash = await this.auth.hash(data.password)
    const username = String(data.username).trim()

    await this.repo.transaction(async client => {
      // 新商户**在建号那一刻**钉住权益版本：他买到的就是当下这一版，
      // 日后我们调整套餐组合不会回溯改到他头上。
      // 管理员可以显式传 catalogVersion 指定（例如按老客户的旧合同开号）。
      const newVersion = data.catalogVersion === undefined || data.catalogVersion === ''
        ? (Number(pack.catalogVersion) || null)
        : number(data.catalogVersion)

      // 16 个列 ↔ 16 个值，必须严格对齐。
      // 这里曾经写成 `$7,$8,...,$16`（17 个值），而 `$16` 连绑定参数都没有 ——
      // 后果是**新建商户整条路径直接 500**（`INSERT has more expressions than
      // target columns`）。生产上 `新建商户` 审计只有 1 条、且是 2026-09-25
      // 那次改动之前的，正是这个多出来的占位符造成的。
      const created = await this.repo.query(
        `INSERT INTO users(username,password_hash,nickname,status,package_id,port_limit,expires_at,
         char_balance,auto_reply,phone,remarks,active_engine_id,enterprise,email,sub_quota,
         package_catalog_version)
         -- $16 勾了「无限期」就建一个不过期的号（NULL）；
         -- 否则维持原行为：给了日期用日期，没给就默认 30 天。
         VALUES($1,$2,$3,1,$4,$5,
          CASE WHEN $16::boolean THEN NULL
               ELSE COALESCE($6::timestamptz,NOW()+interval '30 days') END,
          $7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id,username`,
        [username, passwordHash, data.nickname || username,
          pack.id, number(data.port, number(pack.portLimit)), data.expireTime || null, gift,
          // 这三列都是 NOT NULL 的布尔列，bool() 可能返回 null（没传），
          // 所以必须 `=== true` 兜成布尔再进 SQL
          bool(data.autoReply) === true, data.phone || null, data.remarks || '',
          defaultEngine || null, bool(data.enterprise) === true,
          data.email ? String(data.email).toLowerCase() : null, subQuotaForNew,
          newVersion, bool(data.expireUnlimited)], client
      )

      if (gift) {
        // 试用赠送要落一张 kind='manual' 的充值单，否则字符余额有数但账上没有来源。
        await this.repo.query(
          `INSERT INTO recharges(user_id,package_id,order_number,kind,payment_type,quantity,chars,
           original_amount,discount_amount,paid_amount,status,idempotency_key,paid_at)
           VALUES($1,$2,$3,'manual','试用赠送',1,$4,0,0,0,1,$5,NOW())`,
          [created.rows[0].id, pack.id, `TRIAL${Date.now()}`, gift, `trial:${crypto.randomUUID()}`], client
        )
      }

      await this.repo.audit(client, actor, '新建商户', created.rows[0].username, ip,
        { type: 'user', id: created.rows[0].id })
    })

    return { username, gift }
  }
}

module.exports = { AdminAccountService }
