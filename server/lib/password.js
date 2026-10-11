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

/**
 * 密码强度校验 —— **全站唯一真源**。
 *
 * 2026-10-11 放宽：原规则是「10-128 位且必须同时含字母和数字」，
 * 超管在商户后台想重置密码时，占位符明明写着「至少 8 位」却被拒，
 * 看起来就像"根本没有重置密码的功能"。现改为**最少 6 位**，不再限制字符类型
 * （允许纯数字，如 123456）。
 *
 * 注意这个函数被商户 / 子账号 / 员工 / 注册 / 找回密码**共用**，
 * 改这里等于改全站策略 —— 所以只此一处，不要在别处另写一套。
 *
 * 安全影响（有意接受）：允许了 6 位纯数字这类弱口令，
 * 对商户账号存在被撞库的风险。若要收紧，改这里一个地方即可。
 */
function validPassword(value) {
  const password = String(value || '')
  return password.length >= 6 &&
    password.length <= 128
}

module.exports = { hashPassword, verifyPassword, validPassword }
