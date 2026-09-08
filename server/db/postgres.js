const { Pool } = require('pg')
const config = require('../config')

const pool = new Pool({
  connectionString: config.database.connectionString,
  ssl: config.database.ssl,
  max: config.database.max,
  idleTimeoutMillis: config.database.idleTimeoutMillis,
  connectionTimeoutMillis: config.database.connectionTimeoutMillis,
  statement_timeout: config.database.statementTimeout,
  application_name: config.database.applicationName
})

pool.on('error', error => {
  console.error('Unexpected PostgreSQL pool error:', error)
})

function query(text, values) {
  return pool.query(text, values)
}

async function transaction(work, options) {
  if (typeof work !== 'function') throw new TypeError('transaction work must be a function')

  const settings = options || {}
  const isolation = String(settings.isolationLevel || 'READ COMMITTED').toUpperCase()
  const validIsolationLevels = new Set([
    'READ COMMITTED',
    'REPEATABLE READ',
    'SERIALIZABLE'
  ])
  if (!validIsolationLevels.has(isolation)) {
    throw new Error(`Unsupported transaction isolation level: ${isolation}`)
  }

  const client = await pool.connect()
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}${settings.readOnly ? ' READ ONLY' : ''}`)
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackError) {
      error.rollbackError = rollbackError
    }
    throw error
  } finally {
    client.release()
  }
}

async function checkPostgres() {
  const result = await query('SELECT 1 AS ok')
  return result.rows[0].ok === 1
}

function closePostgres() {
  return pool.end()
}

module.exports = {
  pool,
  query,
  transaction,
  checkPostgres,
  closePostgres
}
