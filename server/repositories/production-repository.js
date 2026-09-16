'use strict'

const { ApiError } = require('../lib/http')
const { decryptSecret } = require('../lib/credentials')

const TABLES = Object.freeze({
  users: 'users',
  subs: 'sub_accounts',
  admins: 'admins',
  packages: 'packages',
  recharges: 'recharges',
  orders: 'orders',
  engines: 'engines',
  translateLogs: 'translate_logs',
  audits: 'audit_logs',
  logins: 'login_logs',
  clients: 'client_releases',
  lines: 'client_lines'
})

function camel(key) {
  return key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase())
}

function mapRow(row) {
  if (!row) return null
  return Object.keys(row).reduce((out, key) => {
    out[camel(key)] = row[key]
    return out
  }, {})
}

function mapRows(rows) {
  return (rows || []).map(mapRow)
}

class ProductionRepository {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('context.pool 必须是 pg Pool')
    }
    this.pool = pool
  }

  query(text, values, client) {
    return (client || this.pool).query(text, values || [])
  }

  async transaction(work) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch (rollbackError) { error.rollbackError = rollbackError }
      throw error
    } finally {
      client.release()
    }
  }

  async accountByUsername(username, client) {
    const identity = await this.query(
      'SELECT account_type,account_id FROM merchant_identities WHERE lower(username)=lower($1) LIMIT 1',
      [username], client
    )
    if (!identity.rows[0]) return null
    const kind = identity.rows[0].account_type === 'sub' ? 'sub' : 'main'
    const table = kind === 'sub' ? TABLES.subs : TABLES.users
    const result = await this.query(`SELECT * FROM ${table} WHERE id=$1`, [identity.rows[0].account_id], client)
    return result.rows[0] ? Object.assign(mapRow(result.rows[0]), { kind }) : null
  }

  async sessionAccount(subjectId, client) {
    const match = /^(main|sub):([1-9][0-9]*)$/.exec(String(subjectId))
    if (!match) return null
    const kind = match[1]
    const table = kind === 'sub' ? TABLES.subs : TABLES.users
    const result = await this.query(`SELECT * FROM ${table} WHERE id=$1`, [match[2]], client)
    const account = mapRow(result.rows[0])
    if (!account) return null
    const parentId = kind === 'sub' ? account.parentId : account.id
    const parent = await this.query(
      `SELECT u.*,p.title AS package_title,p.code AS package_code,p.included_chars,p.port_unlimited,
       p.clients AS package_clients,p.allow_engine_switch AS package_allow_engine_switch
       FROM users u LEFT JOIN packages p ON p.id=u.package_id WHERE u.id=$1`,
      [parentId], client
    )
    return { kind, account, parent: mapRow(parent.rows[0]) }
  }

  async adminByUsername(username) {
    const result = await this.query(
      'SELECT * FROM admins WHERE lower(username)=lower($1) AND status=1 LIMIT 1',
      [username]
    )
    return mapRow(result.rows[0])
  }

  async adminById(id) {
    return mapRow((await this.query('SELECT * FROM admins WHERE id=$1 AND status=1', [id])).rows[0])
  }

  /* ---------------------------------------------------------------- 超管两步验证 */

  /** 暂存待确认的密钥（此时 totp_enabled 仍为 false，未确认前不生效） */
  async setAdminTotpSecret(adminId, secret) {
    await this.query(
      'UPDATE admins SET totp_secret=$2,updated_at=NOW() WHERE id=$1',
      [adminId, secret]
    )
  }

  /**
   * 开启两步验证并写入恢复码，整体一个事务。
   * 必须同时成功：只写密钥不写恢复码会让管理员一旦丢手机就永久进不去。
   */
  async enableAdminTotp(adminId, secret, codeHashes) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE admins SET totp_secret=$2,totp_enabled=true,totp_confirmed_at=NOW(),updated_at=NOW()
         WHERE id=$1`,
        [adminId, secret]
      )
      await client.query('DELETE FROM admin_recovery_codes WHERE admin_id=$1', [adminId])
      for (const hash of codeHashes) {
        await client.query(
          'INSERT INTO admin_recovery_codes(admin_id,code_hash) VALUES($1,$2)',
          [adminId, hash]
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async regenerateAdminRecoveryCodes(adminId, codeHashes) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM admin_recovery_codes WHERE admin_id=$1', [adminId])
      for (const hash of codeHashes) {
        await client.query(
          'INSERT INTO admin_recovery_codes(admin_id,code_hash) VALUES($1,$2)',
          [adminId, hash]
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async disableAdminTotp(adminId) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE admins SET totp_enabled=false,totp_secret=NULL,totp_confirmed_at=NULL,updated_at=NOW()
         WHERE id=$1`,
        [adminId]
      )
      await client.query('DELETE FROM admin_recovery_codes WHERE admin_id=$1', [adminId])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async countAdminRecoveryCodes(adminId) {
    const result = await this.query(
      'SELECT count(*)::int AS n FROM admin_recovery_codes WHERE admin_id=$1 AND used_at IS NULL',
      [adminId]
    )
    return Number(result.rows[0] && result.rows[0].n) || 0
  }

  /**
   * 消费一个恢复码。用 UPDATE ... WHERE used_at IS NULL 做原子占位：
   * 并发的两次请求里只有一次能拿到行，杜绝同一个码被用两次。
   */
  async consumeAdminRecoveryCode(adminId, codeHash, ip) {
    const result = await this.query(
      `UPDATE admin_recovery_codes SET used_at=NOW(),used_ip=NULLIF($3,'')::inet
       WHERE admin_id=$1 AND code_hash=$2 AND used_at IS NULL
       RETURNING id`,
      [adminId, codeHash, ip || '']
    )
    return result.rowCount > 0
  }

  async recordAdminTotpEvent(adminId, event, detail, ip) {
    await this.query(
      `INSERT INTO admin_totp_events(admin_id,event,detail,ip)
       VALUES($1,$2,$3,NULLIF($4,'')::inet)`,
      [adminId, event, detail || null, ip || '']
    )
  }

  async package(id) {
    const value = id == null || id === '' ? null : String(id)
    const result = await this.query(
      `SELECT packages.*,port_limit AS port,included_chars AS chars FROM packages
       WHERE active=true AND ($1::text IS NULL OR id::text=$1 OR code=$1)
       ORDER BY sort_order,id LIMIT 1`,
      [value]
    )
    return mapRow(result.rows[0])
  }

  async packages() {
    return mapRows((await this.query(
      'SELECT packages.*,port_limit AS port,included_chars AS chars FROM packages WHERE active=true ORDER BY sort_order,id'
    )).rows)
  }

  // 面向客户端的通道列表：**绝不能**带 api_key_ciphertext / secret_ciphertext。
  // 原先是 SELECT e.*，而 /translate/engines 是客户端接口，
  // 结果把密钥密文（bytea -> Buffer -> JSON）一路发给了商户端。
  async packageEngines(packageId) {
    const result = await this.query(
      `SELECT e.id,e.name,e.provider,e.tier,e.enabled,e.wired,e.cost_per_million,
              e.model,e.note,e.updated_at
       FROM engines e JOIN package_engines pe ON pe.engine_id=e.id
       WHERE pe.package_id=$1 ORDER BY e.id`,
      [packageId]
    )
    return mapRows(result.rows)
  }

  /** 全部通道（管理端列表用），同样不带密钥本体，只带"是否已填"。 */
  async enginesForAdmin() {
    return mapRows((await this.query(
      `SELECT id,name,provider,tier,enabled,wired,cost_per_million,model,endpoint,note,updated_at,
              (api_key_ciphertext IS NOT NULL) AS has_key,
              (secret_ciphertext IS NOT NULL) AS has_secret
       FROM engines ORDER BY id`
    )).rows)
  }

  async engineById(id) {
    return mapRow((await this.query(
      `SELECT id,name,provider,tier,enabled,wired,cost_per_million,model,endpoint,note,
              (api_key_ciphertext IS NOT NULL) AS has_key,
              (secret_ciphertext IS NOT NULL) AS has_secret
       FROM engines WHERE id=$1`,
      [id]
    )).rows[0])
  }

  /**
   * 取某个通道的厂商凭据（已解密）。
   * 只给服务端内部调用：core-service 翻译前、管理端保存前做就绪校验。
   */
  async engineCredentials(id) {
    const row = (await this.query(
      'SELECT api_key_ciphertext,secret_ciphertext FROM engines WHERE id=$1',
      [id]
    )).rows[0]
    if (!row) return { apiKey: '', secret: '' }
    return {
      apiKey: decryptSecret(row.api_key_ciphertext),
      secret: decryptSecret(row.secret_ciphertext)
    }
  }

  async settings() {
    const result = await this.query('SELECT key,value FROM app_settings WHERE is_secret=false')
    return result.rows.reduce((out, row) => {
      out[row.key] = row.value
      return out
    }, {})
  }

  async list(tableKey, options) {
    const table = TABLES[tableKey]
    if (!table) throw new TypeError(`Unsupported table: ${tableKey}`)
    const opts = options || {}
    const where = opts.where || 'TRUE'
    const values = opts.values || []
    const order = opts.order || 'id DESC'
    const count = await this.query(`SELECT count(*)::bigint AS total FROM ${table} WHERE ${where}`, values)
    const rows = await this.query(
      `SELECT * FROM ${table} WHERE ${where} ORDER BY ${order}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      values.concat([opts.limit || 20, opts.offset || 0])
    )
    return { rows: mapRows(rows.rows), total: Number(count.rows[0].total) }
  }

  async audit(client, admin, action, detail, ip, resource) {
    const actor = admin && admin.username ? admin.username : String(admin || 'system')
    const adminId = admin && admin.id ? admin.id : null
    await this.query(
      `INSERT INTO audit_logs(admin_id,actor,action,resource_type,resource_id,detail,ip,request_id)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,NULLIF($7,'')::inet,$8)`,
      [adminId, actor, action, resource && resource.type || null, resource && String(resource.id) || null,
        JSON.stringify({ message: detail || '' }), ip || '', resource && resource.requestId || null], client
    )
  }

  async lockAccount(client, kind, id) {
    const table = kind === 'sub' ? TABLES.subs : TABLES.users
    return mapRow((await this.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id], client)).rows[0])
  }

  async adjustChars(client, kind, id, delta) {
    const table = kind === 'sub' ? TABLES.subs : TABLES.users
    const result = await this.query(
      `UPDATE ${table} SET char_balance=char_balance+$2,updated_at=NOW()
       WHERE id=$1 AND char_balance+$2>=0 RETURNING *`,
      [id, delta], client
    )
    if (!result.rows[0]) throw new ApiError(409, '字符余额不足', 'INSUFFICIENT_CHARS')
    return mapRow(result.rows[0])
  }
}

module.exports = { ProductionRepository, TABLES, mapRow, mapRows }
