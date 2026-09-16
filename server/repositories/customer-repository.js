/**
 * 统一客户身份系统 —— 数据访问层。
 *
 * ## 隔离纪律（最重要）
 *
 * `conversations` / `messages` / `customer_owners` 属于**内容层**，
 * 每个方法都**强制要求 userId 参数**，且 SQL 里必定带 `user_id = $n`。
 *
 * 这不是形式主义：`test/customer-isolation.test.js` 会静态扫描本文件，
 * 发现任何一条内容查询的 SQL 里没有 `user_id` 就判定测试失败。
 * **靠人记住会漏，靠测试不会。**
 *
 * 身份层（platform_identities / customers / customer_identities）是平台级的，
 * 按设计可以跨商户查询 —— 但它们**不含任何聊天内容**。
 */

class CustomerRepository {
  constructor(db) {
    this.db = db
  }

  query(text, values, client) {
    return this.db.query(text, values, client)
  }

  transaction(work) {
    return this.db.transaction(work)
  }

  // =========================================================================
  // 身份层（平台级，无聊天内容）
  // =========================================================================

  /**
   * 登记一个指纹，返回它是否已存在。
   * `merchant_count` 只在首次由某商户触达时 +1（由调用方判断是否新商户）。
   */
  async upsertPlatformIdentity(fingerprint, identityType, client) {
    const r = await this.query(
      `INSERT INTO platform_identities (fingerprint, identity_type)
       VALUES ($1, $2)
       ON CONFLICT (fingerprint) DO UPDATE
         SET last_seen_at = now(), touch_count = platform_identities.touch_count + 1
       RETURNING fingerprint, identity_type, merchant_count, touch_count,
                 (xmax = 0) AS inserted`,
      [fingerprint, identityType], client
    )
    return r.rows[0]
  }

  /** 按指纹找客户。已合并的客户要顺着 merged_into 走到最终客户。 */
  async customerByIdentity(fingerprint, client) {
    const r = await this.query(
      `SELECT c.id, c.public_id, c.merged_into,
              COALESCE(final.id, c.id) AS resolved_id,
              COALESCE(final.public_id, c.public_id) AS resolved_public_id
       FROM customer_identities ci
       JOIN customers c ON c.id = ci.customer_id
       LEFT JOIN customers final ON final.id = c.merged_into
       WHERE ci.fingerprint = $1`,
      [fingerprint], client
    )
    return r.rows[0] || null
  }

  async createCustomer(client) {
    const r = await this.query(
      `INSERT INTO customers (public_id) VALUES ('C_' || nextval('customers_id_seq')::text)
       RETURNING id, public_id`,
      [], client
    )
    return r.rows[0]
  }

  async linkIdentity(fingerprint, customerId, confidence, client) {
    await this.query(
      `INSERT INTO customer_identities (fingerprint, customer_id, confidence)
       VALUES ($1, $2, $3)
       ON CONFLICT (fingerprint) DO NOTHING`,
      [fingerprint, customerId, confidence], client
    )
  }

  async linkCustomerToMerchant(customerId, userId, client) {
    await this.query(
      `INSERT INTO customer_merchant_links (customer_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (customer_id, user_id) DO UPDATE SET last_seen_at = now()`,
      [customerId, userId], client
    )
  }

  /** 该客户被几个商户接触过。只返回计数，**不返回是哪些商户**。 */
  async merchantCountOf(customerId, client) {
    const r = await this.query(
      `SELECT count(*)::int AS n FROM customer_merchant_links WHERE customer_id = $1`,
      [customerId], client
    )
    return r.rows[0].n
  }

  async bumpMerchantCount(customerId, client) {
    const r = await this.query(
      `UPDATE platform_identities pi
       SET merchant_count = (
         SELECT count(*)::int FROM customer_merchant_links WHERE customer_id = $1
       )
       WHERE pi.fingerprint IN (SELECT fingerprint FROM customer_identities WHERE customer_id = $1)
       RETURNING merchant_count`,
      [customerId], client
    )
    return r.rows[0] ? r.rows[0].merchant_count : 0
  }

  /** 记录"为什么系统认为这是同一个人"。没有这张表，误合并无法追责。 */
  async recordMatchEvent(payload, client) {
    const r = await this.query(
      `INSERT INTO identity_match_events
         (fingerprint, customer_id, matched_by, confidence, outcome, evidence,
          source_user_id, source_platform, source_account)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING id`,
      [
        payload.fingerprint, payload.customerId, payload.matchedBy, payload.confidence,
        payload.outcome, JSON.stringify(payload.evidence || {}),
        payload.sourceUserId || null, payload.sourcePlatform || '', payload.sourceAccount || ''
      ], client
    )
    return r.rows[0].id
  }

  /** 人工确认过的合并要留档，所以候选表按 (a,b) 唯一 */
  async recordMergeCandidate(customerA, customerB, reason, confidence, evidence, client) {
    const [a, b] = customerA < customerB ? [customerA, customerB] : [customerB, customerA]
    await this.query(
      `INSERT INTO customer_merge_candidates (customer_a, customer_b, reason, confidence, evidence)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (customer_a, customer_b) DO NOTHING`,
      [a, b, reason, confidence, JSON.stringify(evidence || {})], client
    )
  }

  // =========================================================================
  // 内容层（商户隔离 —— 每个方法都必须带 userId）
  // =========================================================================

  async upsertConversation(userId, payload, client) {
    const r = await this.query(
      `INSERT INTO conversations
         (user_id, customer_id, platform, account_key, peer_key, display_name, last_message_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, platform, account_key, peer_key) DO UPDATE
         SET customer_id = COALESCE(EXCLUDED.customer_id, conversations.customer_id),
             display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name
                                 ELSE conversations.display_name END,
             last_message_at = GREATEST(COALESCE(conversations.last_message_at, EXCLUDED.last_message_at),
                                        EXCLUDED.last_message_at),
             updated_at = now()
       RETURNING id`,
      [userId, payload.customerId || null, payload.platform, payload.accountKey,
       payload.peerKey, payload.displayName || '', payload.sentAt], client
    )
    return r.rows[0].id
  }

  /**
   * 写入消息。
   *
   * 四个 `source_*` 字段是**溯源凭据**：合并客户只影响 customer_id，
   * 它们在任何情况下都不改写 —— 否则合并之后就说不清一条消息的原始出处了。
   *
   * 平台原始消息 ID 多数为空（DOM 抓取拿不到稳定 ID），此时靠
   * `messages_dedup_idx` 的部分唯一索引（仅对 source_msg_id <> '' 生效）兜底。
   */
  async insertMessage(userId, payload, client) {
    const r = await this.query(
      `INSERT INTO messages
         (user_id, conversation_id, customer_id, direction, sender_key, body, body_translated,
          lang_detected, operator_id, source_platform, source_account,
          source_conv_id, source_msg_id, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        userId, payload.conversationId, payload.customerId || null, payload.direction,
        payload.senderKey || '', payload.body, payload.bodyTranslated || null,
        payload.langDetected || null, payload.operatorId || null,
        payload.sourcePlatform, payload.sourceAccount,
        payload.sourceConvId || '', payload.sourceMsgId || '', payload.sentAt
      ], client
    )
    return r.rows[0] ? r.rows[0].id : null
  }

  async conversationMessages(userId, conversationId, limit, client) {
    const r = await this.query(
      `SELECT id, direction, body, body_translated, sent_at,
              source_platform, source_account, source_conv_id, source_msg_id
       FROM messages
       WHERE user_id = $1 AND conversation_id = $2
       ORDER BY sent_at DESC
       LIMIT $3`,
      [userId, conversationId, limit], client
    )
    return r.rows
  }

  async conversationsOfCustomer(userId, customerId, client) {
    const r = await this.query(
      `SELECT id, platform, account_key, peer_key, display_name, last_message_at
       FROM conversations
       WHERE user_id = $1 AND customer_id = $2
       ORDER BY last_message_at DESC NULLS LAST`,
      [userId, customerId], client
    )
    return r.rows
  }

  // =========================================================================
  // 归属与撞单
  // =========================================================================

  /**
   * 查该商户下这个客户的有效跟进关系。
   * **只有 FOLLOWING 参与撞单检测** —— 已 COMPLETED 的客户别人再联系是正常复用。
   */
  async activeOwner(userId, customerId, client) {
    const r = await this.query(
      `SELECT id, employee_id, account_key, status, assigned_at, last_activity_at
       FROM customer_owners
       WHERE user_id = $1 AND customer_id = $2 AND status = 'FOLLOWING'`,
      [userId, customerId], client
    )
    return r.rows[0] || null
  }

  async touchOwner(ownerId, userId, client) {
    await this.query(
      `UPDATE customer_owners SET last_activity_at = now()
       WHERE id = $1 AND user_id = $2`,
      [ownerId, userId], client
    )
  }

  async createOwner(userId, customerId, employeeId, accountKey, client) {
    const r = await this.query(
      `INSERT INTO customer_owners (user_id, customer_id, employee_id, account_key, status)
       VALUES ($1, $2, $3, $4, 'FOLLOWING')
       ON CONFLICT (user_id, customer_id) WHERE status = 'FOLLOWING' DO UPDATE
         SET last_activity_at = now()
       RETURNING id`,
      [userId, customerId, employeeId || null, accountKey || ''], client
    )
    return r.rows[0].id
  }

  /**
   * 记录撞单事件。
   *
   * `existing_*` 是**原负责人**的信息、`new_*` 是新跟进人。
   * 跨商户场景下这些字段只进数据库供平台管理员查看，
   * **绝不出现在给商户的接口返回里**（出口白名单在服务层强制）。
   */
  async recordCollision(payload, client) {
    const r = await this.query(
      `INSERT INTO collision_events
         (customer_id, kind, existing_owner_id, existing_user_id, existing_employee_id,
          existing_account_key, new_user_id, new_employee_id, new_account_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, detected_at`,
      [
        payload.customerId, payload.kind, payload.existingOwnerId || null,
        payload.existingUserId, payload.existingEmployeeId || null,
        payload.existingAccountKey || '', payload.newUserId,
        payload.newEmployeeId || null, payload.newAccountKey || ''
      ], client
    )
    return r.rows[0]
  }

  /**
   * 该商户的待处理撞单提醒。
   *
   * 返回体**刻意只含本商户自己的信息**：同商户撞单可以显示同事姓名，
   * 跨商户撞单只有一句匿名提示（由服务层决定 kind 与措辞）。
   */
  async pendingCollisions(userId, since, client) {
    const r = await this.query(
      `SELECT ce.id, ce.customer_id, ce.kind, ce.detected_at,
              ce.new_employee_id, ce.new_account_key,
              ce.existing_employee_id, ce.existing_account_key,
              c.public_id
       FROM collision_events ce
       JOIN customers c ON c.id = ce.customer_id
       WHERE ce.resolution = 'pending'
         AND (ce.new_user_id = $1 OR ce.existing_user_id = $1)
         AND ce.detected_at > $2
       ORDER BY ce.detected_at DESC
       LIMIT 20`,
      [userId, since], client
    )
    return r.rows
  }

  /**
   * 跨商户检测：该客户是否**在其他商户**存在有效跟进关系。
   *
   * 返回的 `user_id` **仅供服务层判断"是否跨商户"**，
   * 绝不进入给商户的任何返回体。这是设计文档 §5.3 的核心约束。
   */
  async otherMerchantActiveOwners(customerId, excludeUserId, client) {
    const r = await this.query(
      `SELECT owner.user_id, owner.employee_id, owner.account_key, owner.assigned_at
       FROM customer_owners owner
       WHERE owner.customer_id = $1 AND owner.user_id <> $2 AND owner.status = 'FOLLOWING'
       LIMIT 5`,
      [customerId, excludeUserId], client
    )
    return r.rows
  }

  // =========================================================================
  // 管理端查询（超管视角）
  //
  // 这些方法刻意不做商户隔离 —— 调用方是超管后台，按设计可以看到全局。
  // 但它们**绝不暴露给商户端路由**，路由层按 /admin/ 前缀做了角色校验。
  // =========================================================================

  async listCustomers({ keyword, limit, offset }, client) {
    const kw = String(keyword || '').trim()
    const params = []
    let where = ''
    if (kw) {
      params.push('%' + kw + '%')
      // 按对外编号或昵称搜。**不按指纹搜** —— 指纹是 HMAC，搜不了也没意义。
      where = `WHERE c.public_id ILIKE $1 OR EXISTS (
        SELECT 1 FROM conversations cv
        WHERE cv.customer_id = c.id AND cv.display_name ILIKE $1)`
    }
    params.push(limit, offset)
    const r = await this.query(
      `SELECT c.id, c.public_id, c.created_at, c.merged_into,
              (SELECT count(*)::int FROM customer_merchant_links l WHERE l.customer_id = c.id) AS merchant_count,
              (SELECT count(*)::int FROM conversations cv WHERE cv.customer_id = c.id) AS conversation_count,
              (SELECT count(*)::int FROM customer_identities ci WHERE ci.customer_id = c.id) AS identity_count,
              (SELECT max(cv.display_name) FROM conversations cv
               WHERE cv.customer_id = c.id AND cv.display_name <> '') AS display_name
       FROM customers c
       ${where}
       ORDER BY c.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params, client
    )
    return r.rows
  }

  async countCustomers(keyword, client) {
    const kw = String(keyword || '').trim()
    if (!kw) {
      const r = await this.query('SELECT count(*)::int AS n FROM customers', [], client)
      return r.rows[0].n
    }
    const r = await this.query(
      `SELECT count(*)::int AS n FROM customers c
       WHERE c.public_id ILIKE $1 OR EXISTS (
         SELECT 1 FROM conversations cv WHERE cv.customer_id = c.id AND cv.display_name ILIKE $1)`,
      ['%' + kw + '%'], client
    )
    return r.rows[0].n
  }

  async customerDetail(customerId, client) {
    const head = await this.query(
      `SELECT id, public_id, created_at, merged_into, merged_at FROM customers WHERE id = $1`,
      [customerId], client
    )
    if (!head.rows[0]) return null
    // 已合并的客户要顺着 merged_into 走到最终客户，否则详情页会指向一个空壳
    const finalId = head.rows[0].merged_into || head.rows[0].id

    const [identities, conversations, owners, collisions, matches, merchants] = await Promise.all([
      this.query(
        `SELECT ci.fingerprint, ci.confidence, ci.linked_at, pi.identity_type,
                pi.first_seen_at, pi.merchant_count, pi.touch_count
         FROM customer_identities ci
         JOIN platform_identities pi ON pi.fingerprint = ci.fingerprint
         WHERE ci.customer_id = $1 ORDER BY ci.linked_at`, [finalId], client),
      this.query(
        `SELECT id, user_id, platform, account_key, peer_key, display_name, last_message_at
         FROM conversations WHERE customer_id = $1 ORDER BY last_message_at DESC NULLS LAST`,
        [finalId], client),
      this.query(
        `SELECT o.id, o.user_id, o.employee_id, o.account_key, o.status,
                o.assigned_at, o.last_activity_at, s.nickname AS employee_name
         FROM customer_owners o
         LEFT JOIN sub_accounts s ON s.id = o.employee_id
         WHERE o.customer_id = $1 ORDER BY o.assigned_at DESC`, [finalId], client),
      this.query(
        `SELECT id, kind, existing_user_id, new_user_id, existing_employee_id, new_employee_id,
                existing_account_key, new_account_key, detected_at, resolution
         FROM collision_events WHERE customer_id = $1 ORDER BY detected_at DESC LIMIT 50`,
        [finalId], client),
      this.query(
        `SELECT e.id, e.matched_by, e.confidence, e.outcome, e.evidence, e.created_at,
                e.source_user_id, e.source_platform, e.source_account
         FROM identity_match_events e WHERE e.customer_id = $1
         ORDER BY e.created_at DESC LIMIT 100`, [finalId], client),
      this.query(
        `SELECT l.user_id, u.username, l.first_seen_at, l.last_seen_at
         FROM customer_merchant_links l JOIN users u ON u.id = l.user_id
         WHERE l.customer_id = $1 ORDER BY l.first_seen_at`, [finalId], client)
    ])

    return {
      customer: Object.assign({}, head.rows[0], { id: finalId }),
      identities: identities.rows,
      conversations: conversations.rows,
      owners: owners.rows,
      collisions: collisions.rows,
      matches: matches.rows,
      merchants: merchants.rows
    }
  }

  async listMergeCandidates(status, limit, client) {
    const r = await this.query(
      `SELECT m.id, m.customer_a, m.customer_b, m.reason, m.confidence, m.evidence,
              m.status, m.created_at,
              a.public_id AS a_public, b.public_id AS b_public
       FROM customer_merge_candidates m
       JOIN customers a ON a.id = m.customer_a
       JOIN customers b ON b.id = m.customer_b
       WHERE m.status = $1
       ORDER BY m.confidence DESC, m.created_at DESC
       LIMIT $2`,
      [status || 'pending', limit || 100], client
    )
    return r.rows
  }

  async resolveMergeCandidate(id, status, adminId, client) {
    const r = await this.query(
      `UPDATE customer_merge_candidates
       SET status = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING id, customer_a, customer_b`,
      [id, status, adminId], client
    )
    return r.rows[0] || null
  }

  /**
   * 合并两个客户。
   *
   * **只改归属，不改溯源**：messages 的 source_* 四列一个字都不动，
   * conversations / customer_owners 的 customer_id 指向合并后的客户。
   * `merged_into` 保留指向，所以合并可回滚。
   */
  async mergeCustomers(fromId, intoId, client) {
    await this.query(
      `UPDATE customer_identities SET customer_id = $2 WHERE customer_id = $1`, [fromId, intoId], client)
    await this.query(
      `UPDATE conversations SET customer_id = $2 WHERE customer_id = $1`, [fromId, intoId], client)
    await this.query(
      `UPDATE messages SET customer_id = $2 WHERE customer_id = $1`, [fromId, intoId], client)
    // customer_owners 有 (user_id, customer_id) 的 FOLLOWING 唯一索引，
    // 两边同属一个商户时会撞索引 —— 冲突的那条直接释放，保留目标方的跟进关系。
    await this.query(
      `UPDATE customer_owners o SET status = 'LOST', released_at = now()
       WHERE o.customer_id = $1 AND o.status = 'FOLLOWING' AND EXISTS (
         SELECT 1 FROM customer_owners t
         WHERE t.customer_id = $2 AND t.user_id = o.user_id AND t.status = 'FOLLOWING')`,
      [fromId, intoId], client)
    await this.query(
      `UPDATE customer_owners SET customer_id = $2 WHERE customer_id = $1`, [fromId, intoId], client)
    await this.query(
      `UPDATE collision_events SET customer_id = $2 WHERE customer_id = $1`, [fromId, intoId], client)
    await this.query(
      `UPDATE customer_merchant_links l SET customer_id = $2
       WHERE l.customer_id = $1
         AND NOT EXISTS (SELECT 1 FROM customer_merchant_links t
                         WHERE t.customer_id = $2 AND t.user_id = l.user_id)`,
      [fromId, intoId], client)
    await this.query(`DELETE FROM customer_merchant_links WHERE customer_id = $1`, [fromId], client)
    await this.query(
      `UPDATE customers SET merged_into = $2, merged_at = now() WHERE id = $1`, [fromId, intoId], client)
  }

  async collisionSettingsSave(value, client) {
    await this.query(
      `INSERT INTO app_settings (key, value) VALUES ('customer.collision', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(value)], client
    )
  }

  async collisionHistory(limit, client) {
    const r = await this.query(
      `SELECT ce.id, ce.kind, ce.detected_at, ce.resolution, c.public_id,
              ce.existing_user_id, ce.new_user_id
       FROM collision_events ce JOIN customers c ON c.id = ce.customer_id
       ORDER BY ce.detected_at DESC LIMIT $1`,
      [limit || 100], client
    )
    return r.rows
  }

  async collisionSettings(client) {
    const r = await this.query(
      `SELECT value FROM app_settings WHERE key = 'customer.collision'`,
      [], client
    )
    return (r.rows[0] && r.rows[0].value) || {}
  }
}

module.exports = { CustomerRepository }
