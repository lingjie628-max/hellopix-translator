'use strict'

const { encryptField, decryptField, isEncrypted } = require('../server/lib/field-crypto')

exports.up = async pgm => {
  const result = await pgm.db.query("SELECT value FROM app_settings WHERE key='mail.smtp'")
  const row = result.rows[0]
  if (!row || !row.value || typeof row.value !== 'object') return
  const smtp = Object.assign({}, row.value)
  const stored = String(smtp.pass || '').trim()
  if (!stored || isEncrypted(stored)) return
  smtp.pass = encryptField(stored)
  await pgm.db.query(
    "UPDATE app_settings SET value=$1::jsonb,updated_at=NOW() WHERE key='mail.smtp'",
    [JSON.stringify(smtp)]
  )
}

exports.down = async pgm => {
  const result = await pgm.db.query("SELECT value FROM app_settings WHERE key='mail.smtp'")
  const row = result.rows[0]
  if (!row || !row.value || typeof row.value !== 'object') return
  const smtp = Object.assign({}, row.value)
  const stored = String(smtp.pass || '').trim()
  if (!isEncrypted(stored)) return
  smtp.pass = decryptField(stored)
  await pgm.db.query(
    "UPDATE app_settings SET value=$1::jsonb,updated_at=NOW() WHERE key='mail.smtp'",
    [JSON.stringify(smtp)]
  )
}

