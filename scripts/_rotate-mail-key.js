/**
 * 换 Resend SMTP Key。
 *
 * 走的是 /admin/mail 处理函数里的同一段写法（事务 + jsonb upsert + 审计），
 * 只是跳过 HTTP 层 —— 因为超管开了 TOTP，无密码无法登录拿 token。
 *
 * 只改 pass，其它字段原样保留：刻意不整对象覆盖，
 * 免得手滑把 host/port/secure 带到别的值上。
 */
const { Pool } = require('pg')
const config = require('/opt/hello-pix/server/config')
const { ProductionRepository } = require('/opt/hello-pix/server/repositories/production-repository')

const NEW_KEY = process.env.MAIL_KEY
if (!NEW_KEY || !/^re_[A-Za-z0-9_]+$/.test(NEW_KEY)) {
  console.error('MAIL_KEY 格式不对')
  process.exit(2)
}

const pool = new Pool({
  connectionString: config.database.connectionString,
  ssl: config.database.ssl,
  max: 1
})

;(async () => {
  const repo = new ProductionRepository(pool)

  const before = await repo.settings()
  const cur = before['mail.smtp'] || {}
  const next = Object.assign({}, cur, { pass: NEW_KEY })

  await repo.transaction(async (client) => {
    await repo.query(
      `INSERT INTO app_settings(key,value,description) VALUES($1,$2::jsonb,$3)
       ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, updated_at=NOW()`,
      ['mail.smtp', JSON.stringify(next), 'SMTP 服务器配置'], client
    )
    await repo.audit(client, { id: 1, username: 'pix', role: 'superadmin' },
      '修改邮件服务配置（更换 Resend API Key）',
      next.host + ' / ' + next.from, '127.0.0.1', { type: 'settings' })
  })

  const after = (await repo.settings())['mail.smtp']
  console.log('host  =', after.host)
  console.log('port  =', after.port, '| secure =', after.secure)
  console.log('user  =', after.user)
  console.log('from  =', after.from, '| fromName =', after.fromName)
  console.log('pass  =', after.pass.slice(0, 12) + '... (len ' + after.pass.length + ')')
  console.log('key 已替换 =', after.pass === NEW_KEY)

  const { checkMail } = require('/opt/hello-pix/scripts/alert')
  const res = await checkMail(pool, { force: true })
  console.log('实发探活: ok=' + res.ok + ' :: ' + res.detail)

  await pool.end()
})().catch(e => { console.error('ERR ' + e.message); process.exit(1) })
