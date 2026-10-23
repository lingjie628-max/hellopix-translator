const { Pool } = require('pg')
const config = require('/opt/hello-pix/server/config')

const pool = new Pool({
  connectionString: config.database.connectionString,
  ssl: config.database.ssl,
  max: 1
})

;(async () => {
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'app_settings' ORDER BY ordinal_position`
  )
  console.log('=== app_settings 列 ===')
  console.log(cols.rows.map(r => r.column_name + ':' + r.data_type).join(', '))

  const rows = await pool.query(
    `SELECT key, is_secret, length(value::text) AS vlen, updated_at
       FROM app_settings
      WHERE key LIKE 'mail.%' ORDER BY key`
  )
  console.log('\n=== mail.* 全部行（不过滤 is_secret）===')
  rows.rows.forEach(r => {
    console.log(`${r.key}  is_secret=${r.is_secret}  vlen=${r.vlen}  ${r.updated_at.toISOString()}`)
  })

  const visible = await pool.query(`SELECT key FROM app_settings WHERE is_secret=false AND key LIKE 'mail.%'`)
  console.log('\n=== settings() 能看到哪些 mail.* ===')
  console.log(visible.rows.length ? visible.rows.map(r => r.key).join(', ') : '(一个都看不到！)')

  const all = await pool.query(
    `SELECT key, is_secret FROM app_settings ORDER BY is_secret DESC, key`
  )
  const hidden = all.rows.filter(r => r.is_secret)
  console.log('\n=== 被 is_secret 藏起来的全部 key ===')
  console.log(hidden.length ? hidden.map(r => r.key).join(', ') : '(无)')

  await pool.end()
})().catch(e => { console.error('ERR ' + e.message); process.exit(1) })
