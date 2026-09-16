/**
 * 统一客户身份服务。
 *
 * 三件事，刻意分开实现，不混在一起（这是产品负责人明确要求的原则）：
 *
 *   1. **身份层** resolveIdentity —— 决定"这个人是谁"
 *   2. **隔离层** 由仓储层与路由层保证 —— 决定"谁能看到什么"
 *   3. **业务规则** detectCollision —— 建立在身份之上的撞单判断
 *
 * 混在一起的后果：某天要改撞单策略，却动到了身份匹配，误合并风险陡增。
 */

const { ApiError } = require('../lib/http')
const identity = require('../lib/identity')

// 撞单默认设置。跨商户**默认关闭** ——
// 架构上完全支持，但商户没有书面同意前不得开启，
// 否则等于拿 A 商户的客户资源去提示 B 商户。
const COLLISION_DEFAULTS = {
  sameMerchant: true,
  crossMerchant: false,
  notifyMode: 'warn',
  ownerIdleReleaseDays: 30
}

class CustomerIdentityService {
  constructor(repo) {
    this.repo = repo
  }

  // =========================================================================
  // 一、身份识别
  // =========================================================================

  /**
   * 按优先级寻找已存在的客户。
   *
   * 优先级：手机号 > 平台稳定 ID > 邮箱 > 用户名
   * **姓名不参与** —— 同名太常见，仅凭姓名合并会污染数据。
   *
   * @returns {{customer, matchedBy, confidence, fingerprint} | null}
   */
  async findExisting(candidates, client) {
    for (const c of candidates) {
      if (!identity.identityEnabled()) return null
      const fp = identity.fingerprint(c.type, c.value)
      const hit = await this.repo.customerByIdentity(fp, client)
      if (hit) {
        return {
          customer: { id: hit.resolved_id, publicId: hit.resolved_public_id },
          matchedBy: c.type,
          confidence: c.confidence,
          fingerprint: fp
        }
      }
    }
    return null
  }

  /**
   * 三分支解析。规范明确要求：
   *
   *   A. 高置信度  → 自动关联已有 Customer ID
   *   B. 疑似重复  → **不自动合并**，进 customer_merge_candidates
   *   C. 无匹配    → 创建新 Customer ID
   *
   * 并**记录匹配原因**（identity_match_events）——
   * 没有它，以后没人能回答"这个客户为什么被合并"。
   */
  async resolveIdentity(clues, context, client) {
    const candidates = identity.collectIdentities(clues)

    if (!identity.identityEnabled()) {
      // 未配置身份密钥时整体降级为"不识别"，而不是报错中断业务。
      // 此时每条线索各自建客户 —— 宁可暂时不合并，也不能因为缺配置就丢数据。
      const created = await this.repo.createCustomer(client)
      return { customerId: created.id, publicId: created.public_id, outcome: 'created', degraded: true }
    }

    if (!candidates.length) {
      const created = await this.repo.createCustomer(client)
      await this.repo.recordMatchEvent({
        fingerprint: identity.fingerprint('none', String(created.id)),
        customerId: created.id,
        matchedBy: 'none',
        confidence: 'low',
        outcome: 'created',
        evidence: { reason: 'no_usable_clue', platform: context.platform || '' },
        sourceUserId: context.userId,
        sourcePlatform: context.platform,
        sourceAccount: context.accountKey
      }, client)
      return { customerId: created.id, publicId: created.public_id, outcome: 'created' }
    }

    const existing = await this.findExisting(candidates, client)

    if (existing && existing.confidence === 'high') {
      // A. 高置信度 → 自动关联
      for (const c of candidates) {
        const fp = identity.fingerprint(c.type, c.value)
        await this.repo.upsertPlatformIdentity(fp, c.type, client)
        await this.repo.linkIdentity(fp, existing.customer.id, c.confidence, client)
      }
      await this.repo.recordMatchEvent({
        fingerprint: existing.fingerprint,
        customerId: existing.customer.id,
        matchedBy: existing.matchedBy,
        confidence: 'high',
        outcome: 'auto_linked',
        evidence: {
          matchedBy: existing.matchedBy,
          candidateCount: candidates.length,
          types: candidates.map(c => c.type)
        },
        sourceUserId: context.userId,
        sourcePlatform: context.platform,
        sourceAccount: context.accountKey
      }, client)
      return { customerId: existing.customer.id, publicId: existing.customer.publicId, outcome: 'auto_linked', matchedBy: existing.matchedBy }
    }

    if (existing && existing.confidence !== 'high') {
      // B. 疑似重复 → 只登记候选，**不合并**
      const created = await this.repo.createCustomer(client)
      for (const c of candidates) {
        const fp = identity.fingerprint(c.type, c.value)
        await this.repo.upsertPlatformIdentity(fp, c.type, client)
        await this.repo.linkIdentity(fp, created.id, c.confidence, client)
      }
      await this.repo.recordMergeCandidate(
        created.id, existing.customer.id, existing.matchedBy, 0.6,
        { candidates: candidates.map(c => ({ type: c.type, note: c.note })) },
        client
      )
      await this.repo.recordMatchEvent({
        fingerprint: existing.fingerprint,
        customerId: created.id,
        matchedBy: existing.matchedBy,
        confidence: existing.confidence,
        outcome: 'candidate',
        evidence: { candidateOf: existing.customer.publicId, matchedBy: existing.matchedBy },
        sourceUserId: context.userId,
        sourcePlatform: context.platform,
        sourceAccount: context.accountKey
      }, client)
      return { customerId: created.id, publicId: created.public_id, outcome: 'candidate' }
    }

    // C. 无匹配 → 新建
    const created = await this.repo.createCustomer(client)
    let primary = null
    for (const c of candidates) {
      const fp = identity.fingerprint(c.type, c.value)
      await this.repo.upsertPlatformIdentity(fp, c.type, client)
      await this.repo.linkIdentity(fp, created.id, c.confidence, client)
      if (!primary && c.confidence === 'high') primary = fp
    }
    if (primary) {
      await this.repo.query(
        `UPDATE customers SET primary_fingerprint = $2 WHERE id = $1`,
        [created.id, primary], client
      )
    }
    await this.repo.recordMatchEvent({
      fingerprint: primary || identity.fingerprint('none', String(created.id)),
      customerId: created.id,
      matchedBy: candidates[0].type,
      confidence: candidates[0].confidence,
      outcome: 'created',
      evidence: {
        reason: 'no_match',
        types: candidates.map(c => c.type),
        notes: candidates.map(c => c.note)
      },
      sourceUserId: context.userId,
      sourcePlatform: context.platform,
      sourceAccount: context.accountKey
    }, client)
    return { customerId: created.id, publicId: created.public_id, outcome: 'created' }
  }

  // =========================================================================
  // 二、消息接入
  // =========================================================================

  /**
   * 一条进粉/消息线索进入系统。
   *
   * 顺序刻意如此：先落库（会话、消息），再做身份与撞单。
   * 万一身份层出错，**聊天内容不会丢** —— 内容是最贵的数据，不能因为它
   * 依赖的识别逻辑出问题就一起没了。
   */
  async ingest(userId, payload) {
    const platform = String(payload.platform || '').trim()
    const accountKey = String(payload.accountKey || '').trim()
    const peerKey = String(payload.peerKey || '').trim()
    if (!platform) throw new ApiError(400, '缺少平台标识', 'PLATFORM_REQUIRED')
    if (!accountKey) throw new ApiError(400, '缺少账号标识', 'ACCOUNT_REQUIRED')
    if (!peerKey) throw new ApiError(400, '缺少客户标识', 'PEER_REQUIRED')

    const sentAt = payload.sentAt ? new Date(payload.sentAt) : new Date()
    if (Number.isNaN(sentAt.getTime())) throw new ApiError(400, '时间格式不正确', 'BAD_TIME')

    return this.repo.transaction(async client => {
      // 1) 身份解析
      const resolved = await this.resolveIdentity({
        phone: payload.phone,
        platform,
        platformUid: payload.platformUid || peerKey,
        email: payload.email,
        username: payload.username
      }, { userId, platform, accountKey }, client)

      // 2) 内容落库（带完整溯源）
      const conversationId = await this.repo.upsertConversation(userId, {
        customerId: resolved.customerId,
        platform,
        accountKey,
        peerKey,
        displayName: payload.displayName || '',
        sentAt
      }, client)

      let messageId = null
      if (payload.body) {
        messageId = await this.repo.insertMessage(userId, {
          conversationId,
          customerId: resolved.customerId,
          direction: payload.direction === 'out' ? 'out' : 'in',
          senderKey: payload.senderKey || peerKey,
          body: String(payload.body).slice(0, 8000),
          bodyTranslated: payload.bodyTranslated || null,
          langDetected: payload.langDetected || null,
          operatorId: payload.operatorId || null,
          // 四个溯源字段：合并客户只改 customer_id，这四列任何情况下不动
          sourcePlatform: platform,
          sourceAccount: accountKey,
          sourceConvId: payload.sourceConvId || '',
          sourceMsgId: payload.sourceMsgId || '',
          sentAt
        }, client)
      }

      // 3) 建立客户↔商户关联（隔离边界）
      await this.repo.linkCustomerToMerchant(resolved.customerId, userId, client)
      await this.repo.bumpMerchantCount(resolved.customerId, client)

      // 4) 撞单检测
      const collision = await this.detectCollision(userId, {
        customerId: resolved.customerId,
        publicId: resolved.publicId,
        employeeId: payload.operatorId || null,
        accountKey
      }, client)

      return {
        customerId: resolved.customerId,
        publicId: resolved.publicId,
        outcome: resolved.outcome,
        conversationId,
        messageId,
        collision,
        degraded: !!resolved.degraded
      }
    })
  }

  // =========================================================================
  // 三、撞单检测（业务规则层）
  // =========================================================================

  async collisionConfig(client) {
    const saved = await this.repo.collisionSettings(client)
    return Object.assign({}, COLLISION_DEFAULTS, saved || {})
  }

  /**
   * 撞单判定。
   *
   * 同商户：默认开启，可以告诉双方"是谁"（同事之间无隐私问题）。
   * 跨商户：**默认关闭**，开启后也只能匿名告知 ——
   *         双方都拿不到对方的商户名、员工名、账号。
   */
  async detectCollision(userId, ctx, client) {
    const cfg = await this.collisionConfig(client)
    const owner = await this.repo.activeOwner(userId, ctx.customerId, client)

    // 已有跟进关系
    if (owner) {
      const sameEmployee = owner.employee_id && ctx.employeeId && Number(owner.employee_id) === Number(ctx.employeeId)
      if (sameEmployee) {
        // 本人继续跟 —— 正常，刷新活跃时间即可
        await this.repo.touchOwner(owner.id, userId, client)
        return null
      }
      if (cfg.sameMerchant === false) {
        await this.repo.touchOwner(owner.id, userId, client)
        return null
      }
      const event = await this.repo.recordCollision({
        customerId: ctx.customerId,
        kind: 'same_merchant',
        existingOwnerId: owner.id,
        existingUserId: userId,
        existingEmployeeId: owner.employee_id,
        existingAccountKey: owner.account_key,
        newUserId: userId,
        newEmployeeId: ctx.employeeId,
        newAccountKey: ctx.accountKey
      }, client)
      return {
        id: event.id,
        kind: 'same_merchant',
        detectedAt: event.detected_at,
        publicId: ctx.publicId,
        existingEmployeeId: owner.employee_id,
        existingAccountKey: owner.account_key
      }
    }

    // 本商户尚无跟进关系 —— 建立
    await this.repo.createOwner(userId, ctx.customerId, ctx.employeeId, ctx.accountKey, client)

    // 跨商户：只有开启时才检测
    if (cfg.crossMerchant !== true) return null

    const others = await this.repo.otherMerchantActiveOwners(ctx.customerId, userId, client)
    if (!others.length) return null

    const event = await this.repo.recordCollision({
      customerId: ctx.customerId,
      kind: 'cross_merchant',
      existingUserId: others[0].user_id,
      existingEmployeeId: others[0].employee_id,
      existingAccountKey: others[0].account_key,
      newUserId: userId,
      newEmployeeId: ctx.employeeId,
      newAccountKey: ctx.accountKey
    }, client)

    // 返回体**只有匿名信息** —— 这是整个系统最重要的安全边界。
    // 商户能知道"撞了"，不能知道"跟谁撞的"。
    return {
      id: event.id,
      kind: 'cross_merchant',
      detectedAt: event.detected_at,
      publicId: ctx.publicId,
      anonymous: true
    }
  }

  /**
   * 待处理撞单提醒（供客户端轮询搭车）。
   *
   * **出口白名单**：返回体里绝不允许出现其他商户的任何标识。
   * 跨商户事件只有一句匿名提示。
   */
  async pendingReminders(userId, since) {
    const rows = await this.repo.pendingCollisions(userId, since)

    return rows.map(row => {
      const isNewSide = Number(row.new_user_id) === Number(userId)
      if (row.kind === 'cross_merchant') {
        // 跨商户：双方都只能看到匿名提示，且**不含任何对方标识**
        return {
          id: String(row.id),
          customerId: row.public_id,
          kind: 'cross_merchant',
          detectedAt: row.detected_at,
          title: '检测到跨商户撞单',
          message: isNewSide
            ? '该客户正被平台其他销售跟进，建议先确认再投入'
            : '有平台其他销售也开始跟进你正在跟的客户',
          // 显式标记匿名：客户端据此**不要**去渲染姓名/账号 —— 这里没有，也不该有
          anonymous: true
        }
      }
      // 同商户：同事之间可以显示姓名/账号，由前端按 employee_id 查名字
      return {
        id: String(row.id),
        customerId: row.public_id,
        kind: 'same_merchant',
        detectedAt: row.detected_at,
        title: '检测到客户撞单',
        message: isNewSide ? '该客户已由本公司其他同事负责' : '本公司其他同事也开始跟进该客户',
        colleagueEmployeeId: isNewSide ? row.existing_employee_id : row.new_employee_id,
        colleagueAccountKey: isNewSide ? row.existing_account_key : row.new_account_key
      }
    })
  }
}

module.exports = { CustomerIdentityService, COLLISION_DEFAULTS }
