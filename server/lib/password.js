'use strict'

const crypto = require('crypto')
const { promisify } = require('util')
const scrypt = promisify(crypto.scrypt)

async function hashPassword(value) {
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(String(value), salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

async function verifyPassword(encoded, value) {
  const parts = String(encoded || '').split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const actual = await scrypt(String(value), Buffer.from(parts[1], 'base64'), 64)
    const expected = Buffer.from(parts[2], 'base64')
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  } catch (_error) {
    return false
  }
}

function validPassword(value) {
  const password = String(value || '')
  return password.length >= 10 &&
    password.length <= 128 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password)
}

module.exports = { hashPassword, verifyPassword, validPassword }
