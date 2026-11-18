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
 * 2026-11-15 收紧：原规则一度放宽到「最少 6 位、不限字符类型」，
 * 允许纯数字弱口令。超管和商户共用这一入口时，这会让暴力破解和撞库
 * 直接穿透第二因子。现在要求 10–128 位，且至少包含一个字母和一个数字；
 * 登录校验只验证现有哈希，不会让已有弱密码账号立刻失去登录能力，
 * 但新建、重置和修改密码必须满足新规则。
 *
 * 注意这个函数被商户 / 子账号 / 员工 / 注册 / 找回密码**共用**，
 * 改这里等于改全站策略 —— 所以只此一处，不要在别处另写一套。
 *
 * 安全影响：12 位以下仍可能被撞库；如果需要更高安全等级，可在部署策略中
 * 进一步提高长度，不要在路由里另写一套校验。
 */
function validPassword(value) {
  const password = String(value || '')
  return password.length >= 10 &&
    password.length <= 128 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password)
}

module.exports = { hashPassword, verifyPassword, validPassword }
